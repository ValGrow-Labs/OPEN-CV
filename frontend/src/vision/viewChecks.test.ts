import { describe, expect, it } from "vitest";
import { calibrationParams as cal, captureParams as cap, goodFrame, publicConfig } from "../test/fixtures";
import { handTurn } from "./geometry";
import { BASIC_LIVE_CODES, evaluateBasicFrame, evaluateFrame, implausibleScale, liveHandLengthMm, LIVE_MESSAGES, liveMessage, notSideOn, showsSameSide, withWrongSide, type LiveCode, type LiveResult, type ScaleContext } from "./liveChecks";

const [palm, back, side] = cap.views;

describe("live messages per capture view", () => {
  it("palm wording is the default, byte for byte", () => {
    for (const code of Object.keys(LIVE_MESSAGES) as LiveCode[]) expect(liveMessage(code, palm)).toBe(LIVE_MESSAGES[code]);
    expect(liveMessage("no_hand")).toBe(LIVE_MESSAGES.no_hand);
    expect(liveMessage("no_hand", null)).toBe(LIVE_MESSAGES.no_hand);
  });

  it("the back of the hand has its own wording where the palm's would be wrong", () => {
    expect(liveMessage("no_hand", back)).toBe("Show the back of your hand to the camera");
    expect(liveMessage("palm_not_flat", back)).toBe("Keep the back of your hand flat, facing the camera");
    expect(liveMessage("coin_not_on_palm", back)).toBe("Place the coin flat in the middle of the back of your hand");
    expect(liveMessage("coin_tilted", back)).toBe("Hold your phone level, parallel to the back of your hand");
  });

  it("falls back to the default wording for a code the view does not override", () => {
    expect(liveMessage("too_dark", back)).toBe(LIVE_MESSAGES.too_dark);
    expect(liveMessage("coin_glare", side)).toBe(LIVE_MESSAGES.coin_glare);
  });

  it("the side view names the side of the hand", () => {
    expect(liveMessage("no_hand", side)).toBe("Show the side of your hand to the camera");
    expect(liveMessage("coin_missing", side)).toBe("Rest the coin flat on the side of your hand");
    expect(liveMessage("coin_not_found", side)).toBe("Rest the coin flat on the side of your hand, facing the camera");
  });
});

describe("basic live checks (a view that is captured but not used for size)", () => {
  it("accepts a frame with a hand in view and a coin found, however poor the coin or the pose", () => {
    const f = goodFrame();
    f.coin!.accepted = false;
    f.coin!.reasons = ["coin_blurry", "coin_glare", "coin_irregular_boundary"];
    f.coin!.minor_axis_px = f.coin!.major_axis_px * 0.7; // a coin seen at an angle: 45 degrees "tilt"
    f.landmarks[12].x += 80; // a bent middle finger
    f.world_landmarks = null;
    // The palm checks refuse this frame ...
    expect(evaluateFrame(f, null, cap, cal).ok).toBe(false);
    // ... the basic ones do not.
    const r = evaluateBasicFrame(f, cap, side);
    expect(r.ok).toBe(true);
    expect(r.codes).toEqual([]);
  });

  it("does not hold the frame to jitter, distance or the coin lying on the palm", () => {
    const f = goodFrame();
    f.coin!.center_x = 5; // far off the palm polygon
    f.coin!.center_y = 5;
    expect(evaluateBasicFrame(f, cap, side).ok).toBe(true);
  });

  it("still needs a hand, inside the frame, big enough, in usable light", () => {
    expect(evaluateBasicFrame(null, cap, side).codes).toEqual(["no_hand"]);
    expect(evaluateBasicFrame(null, cap, side).message).toBe("Show the side of your hand to the camera");

    const out = goodFrame();
    out.landmarks[12].y = -10;
    expect(evaluateBasicFrame(out, cap, side).codes).toContain("hand_out_of_frame");

    const small = goodFrame();
    const c = small.landmarks[9];
    small.landmarks = small.landmarks.map((p) => ({ x: c.x + (p.x - c.x) * 0.3, y: c.y + (p.y - c.y) * 0.3, z: 0 }));
    expect(evaluateBasicFrame(small, cap, side).codes).toContain("hand_too_small");

    const dark = goodFrame();
    dark.brightness = 10;
    expect(evaluateBasicFrame(dark, cap, side).codes).toEqual(["too_dark"]);
    const bright = goodFrame();
    bright.brightness = 250;
    expect(evaluateBasicFrame(bright, cap, side).codes).toEqual(["too_bright"]);
  });

  it("does not need a coin: the view is only captured, and a coin seen edge-on must not block it", () => {
    const f = goodFrame();
    f.coin = null;
    const r = evaluateBasicFrame(f, cap, side);
    expect(r.ok).toBe(true);
    expect(r.codes).toEqual([]);
  });

  it("only ever raises the basic codes", () => {
    const f = goodFrame();
    f.coin = null;
    f.brightness = 5;
    f.landmarks[12].y = -10;
    for (const code of evaluateBasicFrame(f, cap, side).codes) expect(BASIC_LIVE_CODES).toContain(code);
    expect([...BASIC_LIVE_CODES].sort()).toEqual(
      ["hand_out_of_frame", "hand_too_small", "no_hand", "too_bright", "too_dark"].sort(),
    );
  });

  it("is driven by the view's used_for_size flag, which the side view has off and the others on", () => {
    expect(side.used_for_size).toBe(false);
    expect(palm.used_for_size && back.used_for_size).toBe(true);
  });
});

describe("coin tilt limit per view (the domed back of the hand tilts a coin whatever the phone does)", () => {
  const tilted = (deg: number) => {
    const f = goodFrame();
    f.coin!.minor_axis_px = f.coin!.major_axis_px * Math.cos((deg * Math.PI) / 180);
    return f;
  };
  const withLimit = (limit: number | null | undefined) => (limit == null ? cal : { ...cal, max_tilt_deg: limit });

  it("the config gives the back view a larger limit than the palm's", () => {
    expect(palm.max_coin_tilt_deg ?? null).toBeNull();
    expect(back.max_coin_tilt_deg).toBe(25);
    expect(cal.max_tilt_deg).toBe(12);
  });

  it("a coin tilted about 20 degrees is refused with the palm's limit and accepted with the back view's", () => {
    // From a phone recording of the back of the hand: the coin read about 20 degrees in most frames.
    expect(evaluateFrame(tilted(20), null, cap, withLimit(palm.max_coin_tilt_deg), undefined).codes).toContain("coin_tilted");
    const ok = evaluateFrame(tilted(20), null, cap, withLimit(back.max_coin_tilt_deg), undefined);
    expect(ok.codes).not.toContain("coin_tilted");
  });

  it("a coin tilted past the back view's limit is still refused", () => {
    expect(evaluateFrame(tilted(32), null, cap, withLimit(back.max_coin_tilt_deg), undefined).codes).toContain("coin_tilted");
  });
});

describe("a hand the wrong size for the selected coin is caught at once (before three views are wasted)", () => {
  // The phone recordings: a hand read about 134 mm instead of 173-182 mm, and a scan was refused at the
  // end with "outside the expected human range"; now the customer is told on the first frame.
  const ref = 24.26;
  const scale: ScaleContext = { referenceDiameterMm: ref, assumedHfovDeg: [55, 80], plausibleHandMm: [120, 240] };
  const withCoinScale = (factor: number) => {
    const f = goodFrame();
    f.coin!.major_axis_px *= factor; // a bigger coin in the picture = a smaller hand in mm
    f.coin!.minor_axis_px = f.coin!.major_axis_px;
    return f;
  };

  it("measures the hand with the coin as the ruler", () => {
    const f = goodFrame();
    expect(liveHandLengthMm(f, ref)).toBeGreaterThan(150);
    expect(liveHandLengthMm({ ...f, coin: null }, ref)).toBeNull();
  });

  it("is quiet for a normal hand", () => {
    expect(implausibleScale(goodFrame(), scale)).toBe(false);
    expect(evaluateFrame(goodFrame(), null, cap, cal, scale).codes).not.toContain("implausible_scale");
  });

  it("flags a hand far too small for the coin (a bigger coin than selected) and says it first", () => {
    const f = withCoinScale(2.0); // about 92 mm
    expect(implausibleScale(f, scale)).toBe(true);
    const r = evaluateFrame(f, null, cap, cal, scale);
    expect(r.codes[0]).toBe("implausible_scale");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/wrong size for the coin you selected/i);
  });

  it("flags a hand far too large for the coin (a smaller coin than selected)", () => {
    expect(implausibleScale(withCoinScale(0.5), scale)).toBe(true);
  });

  it("leaves the borderline to the server (which adds its own depth correction)", () => {
    const f = goodFrame();
    const mm = liveHandLengthMm(f, ref)!;
    const justBelow = withCoinScale(mm / 117); // about 117 mm: under 120 but within the 5% slack
    expect(implausibleScale(justBelow, scale)).toBe(false);
  });

  it("does nothing without the accepted range or without an accepted coin", () => {
    expect(implausibleScale(withCoinScale(2.0), { ...scale, plausibleHandMm: undefined })).toBe(false);
    const f = withCoinScale(2.0);
    f.coin!.accepted = false;
    expect(evaluateFrame(f, null, cap, cal, scale).codes).not.toContain("implausible_scale");
  });
});

describe("every hand is let through: small and large, with the range the server uses", () => {
  const [lo, hi] = publicConfig().hand_length_plausible_mm;
  const scale: ScaleContext = { referenceDiameterMm: 24.26, assumedHfovDeg: [55, 80], plausibleHandMm: [lo, hi] };
  /** The frame of a hand of `mm` (the test frame's hand rescaled against its coin). */
  const handOf = (mm: number) => {
    const f = goodFrame();
    const factor = liveHandLengthMm(f, 24.26)! / mm;
    f.coin!.major_axis_px *= factor;
    f.coin!.minor_axis_px = f.coin!.major_axis_px;
    return f;
  };

  it("the accepted range covers young children to very large adults (config, not code)", () => {
    expect(lo).toBeLessThanOrEqual(75);
    expect(hi).toBeGreaterThanOrEqual(270);
  });

  it.each([75, 90, 110, 134, 175, 230, 270])("a %i mm hand is not called the wrong size", (mm) => {
    expect(implausibleScale(handOf(mm), scale)).toBe(false);
  });

  it("only a gross scale error is flagged, from either side", () => {
    expect(implausibleScale(handOf(40), scale)).toBe(true);
    expect(implausibleScale(handOf(340), scale)).toBe(true);
  });
});

describe("each view must show its own side of the hand", () => {
  const minAbs = cap.hand_turn_min_abs;
  const palmFrame = goodFrame(); // the canonical hand: a turn of about -0.67
  const palmTurn = handTurn(palmFrame.landmarks);
  /** The same hand turned over (mirrored across the picture). */
  const turnedOver = () => {
    const f = goodFrame();
    f.landmarks = f.landmarks.map((p) => ({ ...p, x: f.image_width - p.x }));
    return f;
  };
  /** A hand seen edge-on: its knuckles squeezed together across the picture. */
  const edgeOn = () => {
    const f = goodFrame();
    const w = f.landmarks[0];
    f.landmarks = f.landmarks.map((p) => ({ ...p, x: w.x + (p.x - w.x) * 0.2 }));
    return f;
  };
  const failing: LiveResult = { ok: false, codes: ["coin_tilted", "too_dark"], message: "x" };

  it("is configured: the back is the opposite of the palm, the side is on its edge", () => {
    expect(palm.opposite_of ?? null).toBeNull();
    expect(back.opposite_of).toBe("palm");
    expect(side.opposite_of ?? null).toBeNull();
    expect(side.max_hand_turn_abs).toBe(0.45);
    expect(back.max_hand_turn_abs ?? null).toBeNull();
    expect(cap.hand_turn_min_abs).toBe(0.2);
    expect(back.messages.wrong_side).toMatch(/palm.*back of your hand/i);
    expect(side.messages.wrong_side).toBeTruthy();
  });

  it("the palm shown again for the back view is the same side", () => {
    expect(showsSameSide(palmFrame, palmTurn, minAbs)).toBe(true);
  });

  it("the hand turned over is not the same side", () => {
    expect(showsSameSide(turnedOver(), palmTurn, minAbs)).toBe(false);
  });

  it("claims nothing when the reference or the frame cannot be judged", () => {
    expect(showsSameSide(palmFrame, null, minAbs)).toBe(false);
    expect(showsSameSide(palmFrame, undefined, minAbs)).toBe(false);
    expect(showsSameSide(palmFrame, 0.05, minAbs)).toBe(false); // reference too small to judge
    expect(showsSameSide(null, palmTurn, minAbs)).toBe(false);
    expect(Math.abs(handTurn(edgeOn().landmarks))).toBeLessThan(minAbs);
    expect(showsSameSide(edgeOn(), palmTurn, minAbs)).toBe(false); // frame too small to judge
  });

  it("works whichever sign the palm had", () => {
    const flipped = turnedOver();
    const ref = handTurn(flipped.landmarks);
    expect(Math.sign(ref)).toBe(-Math.sign(palmTurn));
    expect(showsSameSide(flipped, ref, minAbs)).toBe(true);
    expect(showsSameSide(palmFrame, ref, minAbs)).toBe(false);
  });

  it("a face-on hand is not 'side on'; an edge-on one is; no limit or no frame means no complaint", () => {
    expect(notSideOn(palmFrame, side.max_hand_turn_abs)).toBe(true);
    expect(notSideOn(turnedOver(), side.max_hand_turn_abs)).toBe(true);
    expect(notSideOn(edgeOn(), side.max_hand_turn_abs)).toBe(false);
    expect(notSideOn(palmFrame, null)).toBe(false);
    expect(notSideOn(palmFrame, undefined)).toBe(false);
    expect(notSideOn(null, side.max_hand_turn_abs)).toBe(false);
  });

  it("puts the wrong-side code first, keeps the others and uses the view's own wording", () => {
    const r = withWrongSide(failing, back);
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["wrong_side", "coin_tilted", "too_dark"]);
    expect(r.message).toBe(back.messages.wrong_side);
    expect(withWrongSide(failing, side).message).toBe(side.messages.wrong_side);
    expect(withWrongSide({ ok: true, codes: [], message: "" }, back).codes).toEqual(["wrong_side"]);
    expect(withWrongSide({ ok: false, codes: ["wrong_side"], message: "" }, back).codes).toEqual(["wrong_side"]); // no duplicate
  });

  it("falls back to the default wording for a view without its own", () => {
    expect(withWrongSide(failing, palm).message).toBe(LIVE_MESSAGES.wrong_side);
    expect(withWrongSide(failing).message).toBe(LIVE_MESSAGES.wrong_side);
    expect(liveMessage("wrong_side")).toBe("Turn your hand over to show the other side");
  });
});
