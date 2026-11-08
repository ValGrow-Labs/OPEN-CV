// Print-scale check with a coin on the printed target, on rendered views (ideal cylinder coin). SIMULATED.
import { describe, expect, it } from "vitest";
import type { Intrinsics } from "../common";
import { intrinsicsFromHfov } from "../geometry/camera";
import { checkCoinScale, fitCircleAlgebraic, sdTwoDiscHull } from "./coinCheck";
import { detectMarkers } from "./detect";
import { estimateBoardPose } from "./pose";
import { handOccluders, orbitPose, renderBoardView, toBoardUnits, type RenderOptions } from "./render";

const K: Intrinsics = { ...intrinsicsFromHfov(1280, 720, 65), k1: -0.08, k2: 0.02 };
const COIN_D = 23; // the reference diameter is an INPUT of checkCoinScale; this is only the rendered coin
const STANDARD: RenderOptions = { blurSigmaPx: 0.8, noiseSigma: 3, light: { gradientX: 0.15, vignette: 0.2 } };

function scene(printScale: number, elevationDeg: number, extra: RenderOptions = {}) {
  const pose = orbitPose({ x: 124.5 * printScale, y: 105 * printScale, z: 0 }, 350, elevationDeg, 250);
  const img = renderBoardView(K, pose, { ...STANDARD, printScale, occluders: handOccluders(), coin: { diameterMm: COIN_D, thicknessMm: 1.5 }, seed: 31, ...extra });
  return { img, truth: toBoardUnits(pose, printScale) };
}

describe("geometry helpers", () => {
  it("the circle fit is exact on a circle; the two-disc hull distance is right in each region", () => {
    const pts = Array.from({ length: 30 }, (_, i) => ({ x: 3 + 7 * Math.cos(i * 0.21), y: -2 + 7 * Math.sin(i * 0.21) }));
    const c = fitCircleAlgebraic(pts)!;
    expect(c.x).toBeCloseTo(3, 9);
    expect(c.y).toBeCloseTo(-2, 9);
    expect(c.r).toBeCloseTo(7, 9);
    const a = { x: 0, y: 0 }, b = { x: 10, y: 0 };
    expect(sdTwoDiscHull({ x: -5, y: 0 }, a, 2, b, 3)).toBeCloseTo(3, 9); // beyond the small disc
    expect(sdTwoDiscHull({ x: 16, y: 0 }, a, 2, b, 3)).toBeCloseTo(3, 9); // beyond the large disc
    expect(sdTwoDiscHull({ x: 5, y: 0 }, a, 2, b, 3)).toBeLessThan(0); // inside
    expect(sdTwoDiscHull({ x: 5, y: 10 }, a, 2, b, 2)).toBeCloseTo(8, 9); // equal discs: a capsule
  });
});

describe("coin print-scale check (SIMULATED)", () => {
  it("printed at 100 %: the scale reads within 1.5 % from straight above, through the detected pose", () => {
    const { img } = scene(1, 90);
    const p = estimateBoardPose(K, detectMarkers(img).markers);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const r = checkCoinScale(img, K, p.pose, { referenceDiameterMm: COIN_D, coinThicknessMm: 1.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(r.printScale - 1)).toBeLessThan(0.015);
    expect(r.polarity).toBe("darker");
    expect(r.circleDiameterMm).toBeGreaterThan(r.diameterMm); // the raised face makes a plain circle read large
    expect(r.residualMm).toBeLessThan(0.2);
  });

  it("'fit to page' (94 %) is detected: the scale reads 0.94 within 1 %", () => {
    const { img, truth } = scene(0.94, 75);
    const r = checkCoinScale(img, K, truth, { referenceDiameterMm: COIN_D, coinThicknessMm: 1.5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.abs(r.printScale / 0.94 - 1)).toBeLessThan(0.01);
  });

  it("the reference diameter is an input: a different coin gives a proportionally different scale", () => {
    const { img, truth } = scene(1, 80);
    const a = checkCoinScale(img, K, truth, { referenceDiameterMm: COIN_D, coinThicknessMm: 1.5 });
    const b = checkCoinScale(img, K, truth, { referenceDiameterMm: 25, coinThicknessMm: 1.5 });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.printScale / a.printScale).toBeCloseTo(25 / COIN_D, 2);
  });

  it("refuses low views and a coin outside the image, with reasons", () => {
    const { img, truth } = scene(1, 25);
    expect(checkCoinScale(img, K, truth, { referenceDiameterMm: COIN_D })).toMatchObject({ ok: false, reason: "view_too_oblique" });
    const far = orbitPose({ x: 30, y: 105, z: 0 }, 250, 90, 250); // the coin is off the right of the image
    const img2 = renderBoardView(K, far, { coin: { diameterMm: COIN_D, thicknessMm: 1.5 }, seed: 2 });
    expect(checkCoinScale(img2, K, far, { referenceDiameterMm: COIN_D })).toMatchObject({ ok: false, reason: "outside_image" });
  });

  it("no coin (empty target, or only the printed outline) and a coin too close to the paper's grey are refused", () => {
    const pose = orbitPose({ x: 124.5, y: 105, z: 0 }, 350, 90, 250);
    const empty = renderBoardView(K, pose, { ...STANDARD, coinOutlineDiameterMm: 0, seed: 3 });
    expect(checkCoinScale(empty, K, pose, { referenceDiameterMm: COIN_D })).toMatchObject({ ok: false, reason: "not_a_disc" });
    const outlineOnly = renderBoardView(K, pose, { ...STANDARD, seed: 3 });
    expect(checkCoinScale(outlineOnly, K, pose, { referenceDiameterMm: COIN_D })).toMatchObject({ ok: false, reason: "not_a_disc" });
    const pale = renderBoardView(K, pose, { ...STANDARD, coin: { diameterMm: COIN_D, thicknessMm: 1.5, face: [205, 205, 208], wall: [170, 170, 175] }, seed: 3 });
    const r = checkCoinScale(pale, K, pose, { referenceDiameterMm: COIN_D, coinThicknessMm: 1.5 });
    // a pale coin whose rim matches the paper: refused, or (if accepted) still within 2 %
    if (r.ok) expect(Math.abs(r.printScale - 1)).toBeLessThan(0.02);
    else expect(["poor_fit", "low_contrast", "not_a_disc"]).toContain(r.reason);
  });
});
