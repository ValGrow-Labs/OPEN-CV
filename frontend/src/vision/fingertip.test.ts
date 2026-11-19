import { describe, expect, it } from "vitest";
import { renderFinger } from "./fingerRender";
import { combineTipResults, measureTip, sharpness, type TipEstimate } from "./fingertip";
import { runTipJob } from "./tipJob";

const base = {
  size: 150,
  skin: [226, 170, 140] as [number, number, number],
  background: "white" as const,
  pxPerMm: 2.8,
  distalSkinMm: 24,
  insideMm: 4,
  widthMm: 17,
  angleDeg: 30,
  blurSigma: 0,
  noise: 0,
  seed: 3,
};

describe("measureTip on a rendered finger (SIMULATED)", () => {
  it("finds the skin tip a few mm beyond the landmark", () => {
    const r = renderFinger(base);
    const est = measureTip(r.image, r.dip, r.tip, 0.35);
    expect(est.ok).toBe(true);
    expect(Math.abs(est.extensionPx - r.trueExtensionPx) / 2.8).toBeLessThan(1.0);
    expect(est.ratio).toBeCloseTo(est.extensionPx / r.distalPx, 6);
    expect(est.rays).toBeGreaterThanOrEqual(3);
  });

  it("keeps the landmark tip on a skin-coloured background and says why", () => {
    const r = renderFinger({ ...base, background: "skin" });
    const est = measureTip(r.image, r.dip, r.tip, 0.35);
    expect(est.ok).toBe(false);
    expect(est.extensionPx).toBe(0);
    expect(est.reason).toBeDefined();
  });

  it("keeps the landmark tip when the extension would be beyond the cap", () => {
    const r = renderFinger({ ...base, insideMm: 9 }); // 9 mm inside: more than 0.35 of the distal segment
    expect(measureTip(r.image, r.dip, r.tip, 0.35).ok).toBe(false);
  });

  it("keeps the landmark tip when the landmark is already at the skin tip or outside it", () => {
    const r = renderFinger({ ...base, insideMm: -2 });
    expect(measureTip(r.image, r.dip, r.tip, 0.35).ok).toBe(false);
  });

  it("refuses a segment that is too short to measure", () => {
    const r = renderFinger(base);
    expect(measureTip(r.image, r.dip, { x: r.dip.x + 5, y: r.dip.y }, 0.35).reason).toBe("segment_too_short");
  });

  it("runs as a batch job (what the worker does)", () => {
    const r = renderFinger(base);
    const out = runTipJob({ fingers: [{ tipIndex: 8, image: r.image, dip: r.dip, tip: r.tip }], maxExtFrac: 0.35 });
    expect(out.fingers[0].tipIndex).toBe(8);
    expect(out.fingers[0].est.ok).toBe(true);
  });
});

describe("combining frames", () => {
  const ok = (ratio: number): TipEstimate => ({ ok: true, extensionPx: ratio * 50, ratio, reason: "ok", rays: 5 });
  const no = (reason: TipEstimate["reason"]): TipEstimate => ({ ok: false, extensionPx: 0, ratio: 0, reason, rays: 0 });

  it("takes the median of agreeing frames", () => {
    const r = combineTipResults([ok(0.2), ok(0.22), ok(0.19), no("no_boundary")]);
    expect(r.ok).toBe(true);
    expect(r.ratio).toBeCloseTo(0.2, 2);
    expect(r.found).toBe(3);
    expect(r.of).toBe(4);
  });

  it("falls back when fewer than two frames, or fewer than half, found a boundary", () => {
    expect(combineTipResults([ok(0.2), no("no_boundary"), no("no_boundary")]).ok).toBe(false);
    expect(combineTipResults([ok(0.2), ok(0.2), no("no_boundary"), no("no_boundary"), no("no_boundary")]).ok).toBe(false);
    expect(combineTipResults([no("skin_model_unclear"), no("skin_model_unclear")]).reason).toBe("skin_model_unclear");
  });

  it("falls back when the frames disagree", () => {
    expect(combineTipResults([ok(0.05), ok(0.3), ok(0.15)]).reason).toBe("frames_disagree");
  });
});

describe("sharpness", () => {
  it("is higher for a sharp edge than for a blurred one", () => {
    const sharp = renderFinger(base).image;
    const blur = renderFinger({ ...base, blurSigma: 4 }).image;
    expect(sharpness(sharp)).toBeGreaterThan(sharpness(blur));
  });
});
