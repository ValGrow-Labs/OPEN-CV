// The coin choice and the scan's prerequisites (SYNTHETIC inputs; the thresholds are the shared config's, read through
// the test fixture of the public config, never set here).
import { describe, expect, it } from "vitest";
import type { Point, PublicConfig, ReferenceObject } from "../../../api/types";
import { publicConfig } from "../../../test/fixtures";
import { LIVE_MESSAGES } from "../../../vision/liveChecks";
import type { QualityChips } from "../../capture/metrics";
import type { CoinSnapshot } from "../../capture/types";
import { coinRecord, PREFERRED_COIN_ID, resolveCoin, selectableCoins, sizeCheckWording } from "./coin";
import { COIN_CODE_WORDS, liveGate, segmentationGroup, type GateInput } from "./gate";

const cfg = publicConfig() as PublicConfig;
const withCoins = (objects: Partial<ReferenceObject>[], def = "us_quarter"): PublicConfig => ({
  ...cfg,
  reference_objects: {
    default: def,
    objects: objects.map((o) => ({
      shape: "circle",
      thickness_mm: null,
      source: "test",
      enabled: true,
      availability: "all",
      size_check: false,
      customer_hint: null,
      notes: null,
      label: o.id!,
      diameter_mm: 24,
      diameter_uncertainty_mm: 0.1,
      ...o,
    })) as ReferenceObject[],
  },
});

describe("the experiment's coin choice", () => {
  const both = withCoins([{ id: "us_quarter", diameter_mm: 24.26 }, { id: PREFERRED_COIN_ID, diameter_mm: 23, size_check: true }, { id: "off", enabled: false }]);

  it("prefers the 2019 2-rupee coin when the served settings enable it", () => {
    expect(resolveCoin(both, null)).toEqual({ id: PREFERRED_COIN_ID, via: "preferred", note: null });
  });
  it("falls back to the settings' default when it is not enabled or not listed", () => {
    expect(resolveCoin(withCoins([{ id: "us_quarter" }, { id: PREFERRED_COIN_ID, enabled: false }]), null)).toEqual({ id: "us_quarter", via: "default", note: null });
    expect(resolveCoin(withCoins([{ id: "us_quarter" }]), "")).toEqual({ id: "us_quarter", via: "default", note: null });
  });
  it("takes ?coin= when it names an enabled coin", () => {
    expect(resolveCoin(both, "us_quarter")).toEqual({ id: "us_quarter", via: "url", note: null });
  });
  it("ignores an unknown or disabled ?coin= with a visible note", () => {
    const unknown = resolveCoin(both, "nope");
    expect(unknown.id).toBe(PREFERRED_COIN_ID);
    expect(unknown.note).toMatch(/"nope".*not in the served settings.*ignored/);
    expect(resolveCoin(both, "off").note).toMatch(/"off".*disabled/);
  });
  it("offers only enabled coins, and words the size check from the served label and diameter", () => {
    expect(selectableCoins(both).map((o) => o.id)).toEqual(["us_quarter", PREFERRED_COIN_ID]);
    expect(sizeCheckWording({ label: "Indian 2-rupee coin, 2019 series (silver)", diameter_mm: 23 })).toBe("My coin is the 23 mm one: Indian 2-rupee coin, 2019 series (silver)");
    expect(sizeCheckWording({ label: "X", diameter_mm: 24.26 })).toBe("My coin is the 24.26 mm one: X");
  });
  it("records the coin straight from the served entry", () => {
    const ref = both.reference_objects.objects[1];
    expect(coinRecord(ref, true)).toMatchObject({ id: PREFERRED_COIN_ID, diameter_mm: 23, size_check: true, size_check_confirmed: true });
    expect(coinRecord(both.reference_objects.objects[0], true).size_check_confirmed).toBe(false); // no size check to confirm
  });
});

// A synthetic hand: wrist (0) to middle fingertip (12) 500 px, well inside a 1280 x 720 frame.
function hand(): Point[] {
  const lm: Point[] = Array.from({ length: 21 }, (_, i) => ({ x: 640 + ((i % 5) - 2) * 40, y: 600 - Math.floor(i / 5) * 90, z: 0 }));
  lm[0] = { x: 640, y: 650, z: 0 };
  lm[12] = { x: 640, y: 150, z: 0 };
  return lm;
}
const okChips: QualityChips = {
  handFound: true,
  inFrame: true,
  coin: { required: true, found: true, accepted: true, reasons: [] },
  posture: { ok: true, verdict: "ok", message: "" },
  steady: { jitter: 0.004, steady: true },
  sharpness: { value: 0.006, sharp: true },
};
const coinOf = (majorPx: number, over: Partial<CoinSnapshot> = {}): CoinSnapshot =>
  ({ center_x: 640, center_y: 450, major_axis_px: majorPx, minor_axis_px: majorPx, angle_deg: 0, found: true, accepted: true, reasons: [], confidence: 0.9, ...over }) as CoinSnapshot;
const ref2: ReferenceObject = withCoins([{ id: PREFERRED_COIN_ID, diameter_mm: 23, size_check: true, label: "2-rupee" }]).reference_objects.objects[0];

function input(over: Partial<GateInput> = {}): GateInput {
  // 500 px hand, coin 23 mm at 65 px: 0.354 mm/px -> 177 mm, inside the config's plausible range
  return {
    camera: "running",
    landmarks: hand(),
    frameW: 1280,
    frameH: 720,
    chips: okChips,
    coin: coinOf(65),
    ref: ref2,
    sizeConfirmed: true,
    capture: cfg.capture,
    plausibleHandMm: cfg.hand_length_plausible_mm,
    assumedHfovDeg: cfg.assumed_hfov_deg,
    ...over,
  };
}

describe("the scan's prerequisites (gate)", () => {
  it("allows a scan only when everything passes", () => {
    const g = liveGate(input());
    expect(g.allowed).toBe(true);
    expect(g.blocking).toBeNull();
    expect([g.groups.hand.status, g.groups.coin.status, g.groups.calibration.status]).toEqual(["ok", "ok", "ok"]);
    expect(g.impliedHandMm!).toBeCloseTo((500 * 23) / 65, 1);
  });

  const blockers: [string, Partial<GateInput>, string, string][] = [
    ["camera off", { camera: "off" }, "hand", "camera_off"],
    ["no hand", { landmarks: null }, "hand", "no_hand"],
    ["hand out of the frame", { landmarks: hand().map((p, i) => (i === 12 ? { ...p, y: -5 } : p)) }, "hand", "hand_out_of_frame"],
    ["hand too small", { landmarks: hand().map((p) => ({ x: 640 + (p.x - 640) * 0.2, y: 400 + (p.y - 400) * 0.2, z: 0 })) }, "hand", "hand_too_small"],
    ["not steady", { chips: { ...okChips, steady: { jitter: 0.08, steady: false } } }, "hand", "hand_unsteady"],
    ["not sharp", { chips: { ...okChips, sharpness: { value: 0.0001, sharp: false } } }, "hand", "picture_blurred"],
    ["posture wrong", { chips: { ...okChips, posture: { ok: false, verdict: "wrong", message: "Show the palm" } } }, "hand", "posture"],
    ["coin not found", { coin: coinOf(0, { found: false, accepted: false, reasons: ["coin_not_found"] }) }, "coin", "coin_not_found"],
    ["coin rejected for glare", { coin: coinOf(65, { accepted: false, reasons: ["coin_glare"] }) }, "coin", "coin_glare"],
    ["size not confirmed", { sizeConfirmed: false }, "calibration", "size_not_confirmed"],
    ["implausible scale (coin far too small for the hand)", { coin: coinOf(10) }, "calibration", "implausible_scale"],
  ];
  for (const [name, over, group, code] of blockers) {
    it(`blocks when: ${name}`, () => {
      const g = liveGate(input(over));
      expect(g.allowed).toBe(false);
      const all = [...g.groups.hand.reasons, ...g.groups.coin.reasons, ...g.groups.calibration.reasons];
      expect(all.find((r) => r.code === code)?.group).toBe(group);
      expect(g.blocking).not.toBeNull();
    });
  }

  it("names the first blocking reason in the order hand, coin, calibration", () => {
    expect(liveGate(input({ chips: { ...okChips, steady: { jitter: 0.08, steady: false } }, sizeConfirmed: false })).blocking!.group).toBe("hand");
    expect(liveGate(input({ coin: coinOf(65, { accepted: false, reasons: ["coin_blurry"] }), sizeConfirmed: false })).blocking!.code).toBe("coin_blurry");
  });

  it("does not need a size confirmation for a coin without size_check", () => {
    expect(liveGate(input({ ref: { ...ref2, size_check: false }, sizeConfirmed: false })).allowed).toBe(true);
  });

  it("raises the coin-only indicator only when the hand passes and only the coin is missing", () => {
    expect(liveGate(input({ coin: null })).waitingForCoinOnly).toBe(true);
    expect(liveGate(input({ coin: coinOf(65, { accepted: false, reasons: ["coin_occluded"] }) })).waitingForCoinOnly).toBe(true);
    expect(liveGate(input({ coin: null, chips: { ...okChips, sharpness: { value: 0, sharp: false } } })).waitingForCoinOnly).toBe(false);
    expect(liveGate(input({ coin: null, sizeConfirmed: false })).waitingForCoinOnly).toBe(false);
    expect(liveGate(input()).waitingForCoinOnly).toBe(false);
  });
});

describe("reason codes in words", () => {
  it("maps every coin-engine code to words and production's instruction, in the coin group", () => {
    for (const code of Object.keys(COIN_CODE_WORDS)) {
      const g = liveGate(input({ coin: coinOf(65, { accepted: false, found: code !== "coin_not_found", reasons: [code] }) }));
      const reason = g.groups.coin.reasons.find((r) => r.code === code)!;
      expect(reason.group).toBe("coin");
      expect(reason.words).toContain(COIN_CODE_WORDS[code]);
      expect(reason.todo).toBe(LIVE_MESSAGES[code as keyof typeof LIVE_MESSAGES]);
    }
  });
  it("shows an unknown detector code as it is (never invents one)", () => {
    const g = liveGate(input({ coin: coinOf(65, { accepted: false, reasons: ["coin_new_reason"] }) }));
    expect(g.groups.coin.reasons[0].words).toContain("coin_new_reason");
  });
  it("maps segmentHand's reasons to words in the segmentation group", () => {
    for (const code of ["hand_incomplete", "hand_blurred", "hand_occluded", "fingers_merged", "mask_implausible", "segmentation_failed"]) {
      const s = segmentationGroup("rejected", { ok: false, reasons: [code] });
      expect(s.status).toBe("failed");
      expect(s.reasons[0].code).toBe(code);
      expect(s.reasons[0].words).not.toBe(code);
    }
    expect(segmentationGroup("waiting_hand", null).status).toBe("waiting");
    expect(segmentationGroup("done", { ok: true, reasons: [] }).status).toBe("ok");
  });
});
