import { describe, expect, it } from "vitest";
import { calibrationParams as cal, captureParams as cap, goodFrame } from "../test/fixtures";
import { BASIC_LIVE_CODES, evaluateBasicFrame, evaluateFrame, LIVE_MESSAGES, liveMessage, type LiveCode } from "./liveChecks";

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

  it("needs the coin to have been found at all", () => {
    const f = goodFrame();
    f.coin = null;
    const r = evaluateBasicFrame(f, cap, side);
    expect(r.codes).toEqual(["coin_missing"]);
    expect(r.message).toBe("Rest the coin flat on the side of your hand");
  });

  it("only ever raises the basic codes", () => {
    const f = goodFrame();
    f.coin = null;
    f.brightness = 5;
    f.landmarks[12].y = -10;
    for (const code of evaluateBasicFrame(f, cap, side).codes) expect(BASIC_LIVE_CODES).toContain(code);
    expect([...BASIC_LIVE_CODES].sort()).toEqual(
      ["coin_missing", "coin_not_found", "hand_out_of_frame", "hand_too_small", "no_hand", "too_bright", "too_dark"].sort(),
    );
  });

  it("is driven by the view's used_for_size flag, which the side view has off and the others on", () => {
    expect(side.used_for_size).toBe(false);
    expect(palm.used_for_size && back.used_for_size).toBe(true);
  });
});
