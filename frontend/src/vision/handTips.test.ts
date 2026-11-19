import { describe, expect, it } from "vitest";
import type { FingerTipResult } from "./fingertip";
import { planHandTips } from "./handTips";

const ok = (ratio: number): FingerTipResult => ({ ok: true, ratio, found: 4, of: 4, reason: "ok" });
const no = (reason: FingerTipResult["reason"] = "no_boundary"): FingerTipResult => ({ ok: false, ratio: 0, found: 0, of: 4, reason });
const TIPS = [4, 8, 12, 16, 20];

describe("one tip method for the whole hand", () => {
  it("uses each found finger's own extension and the hand's median for the others (estimated)", () => {
    const p = planHandTips({ 4: ok(0.21), 8: ok(0.27), 12: ok(0.25), 16: no(), 20: no("skin_model_unclear") }, TIPS, null, 0.3);
    expect(p.basis).toBe("measured");
    expect(p.measuredRatio).toBeCloseTo(0.25, 6);
    expect(p.tips[8]).toEqual({ source: "outline", ratio: 0.27 });
    expect(p.tips[16]).toMatchObject({ source: "estimated", ratio: 0.25, reason: "no_boundary" });
    expect(p.tips[20]).toMatchObject({ source: "estimated", reason: "skin_model_unclear" });
    expect(p.found).toBe(3);
  });

  it("never leaves a landmark tip next to an outline tip while any extension is available", () => {
    for (const found of [{}, { 8: ok(0.3) }, { 8: ok(0.3), 12: ok(0.28) }, { 4: ok(0.2), 8: ok(0.3), 12: ok(0.28), 16: ok(0.33), 20: ok(0.31) }]) {
      const p = planHandTips(found as never, TIPS, null, 0.27);
      expect(new Set(Object.values(p.tips).map((t) => t.source === "landmark")).size).toBe(1);
      expect(Object.values(p.tips).every((t) => t.source !== "landmark")).toBe(true);
    }
  });

  it("with fewer than two fingers found, takes the earlier view's extension, then the assumed prior", () => {
    expect(planHandTips({ 8: ok(0.3) }, TIPS, 0.22, 0.27)).toMatchObject({ basis: "earlier_view", measuredRatio: null });
    expect(planHandTips({}, TIPS, null, 0.27)).toMatchObject({ basis: "assumed_prior", measuredRatio: null });
  });

  it("without a prior, the whole scan falls back together: every tip is the landmark", () => {
    const p = planHandTips({ 8: ok(0.3) }, TIPS, null, null);
    expect(p.basis).toBe("none");
    expect(Object.values(p.tips).every((t) => t.source === "landmark")).toBe(true);
  });

  it("does not trust found fingers that disagree with each other, or one far from the hand's extension", () => {
    expect(planHandTips({ 8: ok(0.05), 12: ok(0.45), 16: ok(0.25) }, TIPS, null, null).basis).toBe("none");
    const p = planHandTips({ 4: ok(0.25), 8: ok(0.26), 12: ok(0.27), 16: ok(0.6), 20: ok(0.26) }, TIPS, null, null);
    expect(p.tips[16].source).toBe("estimated");
    expect(p.tips[16].reason).toBe("differs_from_hand");
  });
});
