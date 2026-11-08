// measureCoin on RENDERED coins (renderCoin.ts) with the production detector loaded in Node (the same OpenCV.js build
// the app serves). Mechanics and SIMULATED accuracy only: nothing here is accuracy on real coins or real phones.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import type { CoinDetectionParams } from "../../api/types";
import { initOpenCV, type CV } from "../../vision/opencv";
import { ASSUMED_HFOV_DEG } from "../geometry/camera";
import { coinReferenceFromConfig, measureCoin, thicknessCorrectedTiltDeg } from "./measureCoin";
import { cropIntrinsics, renderCoinScene } from "./renderCoin";
import { BASELINE, renderScenario, scenarioCamera, type CoinScenario } from "./sensitivity";

const cfg = JSON.parse(readFileSync(new URL("../../../../config/measurement.json", import.meta.url), "utf-8"));
const refsJson = JSON.parse(readFileSync(new URL("../../../../config/reference_objects.json", import.meta.url), "utf-8"));
const params = cfg.coin_detection as CoinDetectionParams;
const ref = coinReferenceFromConfig(refsJson, "inr_2_2019", cfg.calibration.custom_reference_thickness_mm);
const coin = { diameterMm: ref.diameterMm, thicknessMm: ref.thicknessMm };

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCV(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 60_000);

function run(over: Partial<CoinScenario>, opts: { withK?: boolean; seed?: number } = {}) {
  const sc = { ...BASELINE, ...over };
  const r = renderScenario(sc, coin, opts.seed ?? 1);
  const m = measureCoin(cv, r.image, { params, reference: ref, intrinsics: opts.withK === false ? undefined : r.K, frame: { x0: r.camera.K.cx - r.K.cx, y0: r.camera.K.cy - r.K.cy, width: sc.width, height: sc.height } });
  const sTop = r.camera.topCenter[2] / r.K.fx;
  const sSup = r.camera.baseDepthMm / r.K.fx;
  return { r, m, sTop, sSup };
}

describe("coin reference from the config", () => {
  it("reads the 2019 Rs 2 coin's diameter and allowance from config/reference_objects.json, and marks its thickness as assumed", () => {
    const entry = refsJson.objects.find((o: { id: string }) => o.id === "inr_2_2019");
    expect(ref.diameterMm).toBe(entry.diameter_mm);
    expect(ref.diameterAllowanceMm).toBe(entry.diameter_uncertainty_mm);
    expect(entry.thickness_mm).toBeNull(); // no primary source states it (README)
    expect(ref.thicknessSource).toBe("assumed");
    expect(ref.thicknessMm).toBe(cfg.calibration.custom_reference_thickness_mm);
    expect(ref.thicknessAllowanceMm).toBeGreaterThan(0.1);
    const lkr = coinReferenceFromConfig(refsJson, "lkr_5_2017", 1.5);
    expect(lkr.thicknessSource).toBe("config");
    expect(() => coinReferenceFromConfig(refsJson, "no_such_coin", 1.5)).toThrow();
  });
});

describe("measureCoin (SIMULATED renders)", () => {
  it("baseline: production detector found and accepted, refined scale within 0.5 % of the truth, budget and visibility filled", () => {
    const { m, sTop, sSup } = run({});
    expect(m.production.found && m.production.accepted).toBe(true);
    expect(m.source).toBe("production");
    expect(m.ok).toBe(true);
    expect(m.reasons).toEqual([]);
    expect(Math.abs(ref.diameterMm / m.ellipse!.major / sTop - 1)).toBeLessThan(0.005);
    expect(Math.abs(m.scale!.mmPerPxSupport / sSup - 1)).toBeLessThan(0.005);
    expect(m.visibility!.rimInsideImage).toBe(true);
    expect(m.visibility!.occludedShare).toBeLessThan(0.05);
    expect(m.visibility!.glareShare).toBe(0);
    expect(m.fit!.inliers).toBeGreaterThan(300);
    expect(m.edgePoints.length).toBe(m.fit!.inliers);
    const keys = m.scale!.components.map((c) => c.key);
    expect(keys).toEqual(["edge_fit", "edge_bias", "reference_diameter", "perspective", "lens_distortion", "thickness"]);
    // the reference allowance from the config: 0.1 / sqrt(3) / 23
    expect(m.scale!.components[2].rel).toBeCloseTo(ref.diameterAllowanceMm / Math.sqrt(3) / ref.diameterMm, 12);
    expect(m.scale!.relSigma).toBeGreaterThan(0.002);
    expect(m.scale!.relSigma).toBeLessThan(0.01);
    expect(m.confidence).toBeGreaterThan(0.6);
    expect(m.orientation!.tiltSign).toBe("ambiguous");
  });

  it("a THIN coin off-axis looks exactly circular and D / major is right; the 1.5 mm wall is what inflates the major axis near the corner", () => {
    const sc: CoinScenario = { ...BASELINE, position: [0.85, 0.85] };
    for (const h of [0.02, ref.thicknessMm]) {
      const cam = scenarioCamera(sc, h);
      const c = cam.topCenter;
      const u = cam.K.fx * (c[0] / c[2]) + cam.K.cx, v = cam.K.fy * (c[1] / c[2]) + cam.K.cy;
      const K = cropIntrinsics(cam.K, Math.round(u - 150), Math.round(v - 150), 300, 300);
      const img = renderCoinScene(K, cam.pose, { diameterMm: ref.diameterMm, thicknessMm: h, blurSigmaPx: 0.8, noiseSigma: 3 });
      const m = measureCoin(cv, img, { params, reference: { ...ref, thicknessMm: h }, intrinsics: K });
      const err = ref.diameterMm / m.ellipse!.major / (c[2] / K.fx) - 1;
      if (h < 0.1) {
        expect(Math.abs(err)).toBeLessThan(0.004);
        expect(m.orientation!.tiltDeg).toBeLessThan(8);
      } else {
        expect(err).toBeLessThan(-0.025); // the wall seen obliquely: major too long by about 4 %
        // the 3D outline fit (cylinder) removes most of it
        expect(Math.abs(m.scale!.mmPerPxCorrected / (c[2] / K.fx) - 1)).toBeLessThan(0.006);
      }
    }
  });

  it("lens distortion: with the lens model the edge points are undistorted; without it the raw ellipse is off near the corner", () => {
    const { m, sTop } = run({ position: [0.75, 0.75], k1: -0.08 });
    const raw = ref.diameterMm / m.ellipseImage!.major / sTop - 1;
    expect(raw).toBeGreaterThan(0.015); // barrel distortion shrinks the coin there
    expect(Math.abs(m.scale!.mmPerPxCorrected / sTop - 1)).toBeLessThan(0.006);
    expect(m.scale!.corrections.distortion).toBeLessThan(-0.03);
  });

  it("tilt: ratio tilt is biased low by the wall; the thickness-corrected and the 3D-fit tilts are within 1.5 degrees at 30 degrees", () => {
    const { m, r } = run({ tiltDeg: 30 });
    const ray = Math.hypot(...r.camera.topCenter);
    const truth = (Math.acos(Math.abs(r.camera.normal[1] * r.camera.topCenter[1] + r.camera.normal[2] * r.camera.topCenter[2]) / ray) * 180) / Math.PI;
    expect(truth - m.orientation!.tiltDeg).toBeGreaterThan(2);
    expect(Math.abs(m.orientation!.tiltDegThicknessCorrected! - truth)).toBeLessThan(1.5);
    const n = m.orientation!.outlineFit!.normal;
    const fitTilt = (Math.acos(Math.abs(n[0] * r.camera.topCenter[0] + n[1] * r.camera.topCenter[1] + n[2] * r.camera.topCenter[2]) / ray) * 180) / Math.PI;
    expect(Math.abs(fitTilt - truth)).toBeLessThan(1.5);
    expect(m.orientation!.poses!.length).toBe(2);
    expect(Math.abs(m.orientation!.imageAngleDeg - 0) < 5 || Math.abs(m.orientation!.imageAngleDeg - 180) < 5).toBe(true); // tilt about the image x axis
  });

  it("the first-order wall correction of the tilt refuses small tilts", () => {
    expect(thicknessCorrectedTiltDeg(100, 99.9, 23, 1.5)).toBeNull();
    const t = thicknessCorrectedTiltDeg(100, 100 * Math.cos(Math.PI / 6) + (1.5 * 100 * 0.5) / 23, 23, 1.5)!;
    expect(t).toBeCloseTo(30, 6);
  });

  it("without intrinsics: the distance range from the app's assumed field of view brackets the truth", () => {
    const { m, r } = run({}, { withK: false });
    expect(m.scale!.focal).toBe("assumed_fov");
    const [lo, hi] = m.distance!.rangeMm!;
    expect(lo).toBeLessThan(r.camera.topCenter[2]);
    expect(hi).toBeGreaterThan(r.camera.topCenter[2]);
    expect(ASSUMED_HFOV_DEG).toEqual(cfg.uncertainty.assumed_hfov_deg);
    expect(m.scale!.components.find((c) => c.key === "lens_distortion")!.rule).toMatch(/not included/);
  });

  it("gates: rim leaving the frame, a finger over 40 % of the rim, heavy blur", () => {
    expect(run({ position: [0.97, 0.97] }).m.reasons).toContain("rim_outside_image");
    const occ = run({ occlusion: 0.4 }).m;
    expect(occ.reasons).toContain("rim_occluded");
    expect(occ.ok).toBe(false);
    expect(run({ blurSigmaPx: 3.5 }).m.reasons).toContain("blurry");
  });

  it("glare on the face is measured, and a coin hidden in a blank image is not found", () => {
    const g = run({ glare: "face" }).m;
    expect(g.visibility!.glareShare).toBeGreaterThan(0.02);
    const blank = { width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(200) };
    const none = measureCoin(cv, blank, { params, reference: ref });
    expect(none.ok).toBe(false);
    expect(none.reasons).toEqual(["coin_not_found"]);
    expect(none.source).toBe("none");
  });
});
