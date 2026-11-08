// The coin as the scale of a multi-view scene (sceneScale.ts), SIMULATED: analytic outlines for exactness and the
// Monte Carlo study (COIN_STUDY=full prints the README table), and one end-to-end run from rendered pixels through the
// production detector and measureCoin. Nothing here is real-world accuracy.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import type { CoinDetectionParams } from "../../api/types";
import { initOpenCV, type CV } from "../../vision/opencv";
import type { CameraPose } from "../common";
import { intrinsicsFromHfov, project } from "../geometry/camera";
import { coinReferenceFromConfig, measureCoin } from "./measureCoin";
import { cropIntrinsics, renderCoinScene } from "./renderCoin";
import { fitCoinCircle3D, type CoinView } from "./sceneScale";
import { orbitCamera, runSceneCase, SCENE_UNITS_PER_MM, sceneCases, sceneTable, silhouettePoints } from "./sceneScaleStudy";

const cfg = JSON.parse(readFileSync(new URL("../../../../config/measurement.json", import.meta.url), "utf-8"));
const refsJson = JSON.parse(readFileSync(new URL("../../../../config/reference_objects.json", import.meta.url), "utf-8"));
const params = cfg.coin_detection as CoinDetectionParams;
const ref = coinReferenceFromConfig(refsJson, "inr_2_2019", cfg.calibration.custom_reference_thickness_mm);
const coin = { diameterMm: ref.diameterMm, thicknessMm: ref.thicknessMm, diameterAllowanceMm: ref.diameterAllowanceMm, thicknessAllowanceMm: ref.thicknessAllowanceMm };
const FULL = process.env.COIN_STUDY === "full";
const K = intrinsicsFromHfov(1280, 720, 69.4);

const scaled = (p: CameraPose, s: number): CameraPose => ({ R: p.R, t: [p.t[0] * s, p.t[1] * s, p.t[2] * s] });

function exactViews(s: number, els: number[], azs: number[], h: number): CoinView[] {
  return els.map((el, i) => {
    const pose = orbitCamera(300, el, azs[i]);
    return { K, pose: scaled(pose, s), points: silhouettePoints(K, pose, ref.diameterMm, h, 120)!.pts };
  });
}

describe("coin circle in 3D from up-to-scale poses (analytic outlines)", () => {
  it("recovers the unknown scale exactly from noise-free outlines, whatever the scale", () => {
    for (const s of [SCENE_UNITS_PER_MM, 1, 7.5]) {
      const r = fitCoinCircle3D(exactViews(s, [60, 70, 55], [0, 40, 95], ref.thicknessMm), { diameterMm: ref.diameterMm, thicknessMm: ref.thicknessMm, model: "cylinder" });
      expect(r.ok).toBe(true);
      expect(Math.abs(r.mmPerUnit! * s - 1)).toBeLessThan(1e-4);
      // the normal is the table's (+z) and the centre the top face's (z = h), in scene units
      expect(r.circle!.normal[2]).toBeGreaterThan(0.99999);
      expect(r.circle!.center[2] / s).toBeCloseTo(ref.thicknessMm, 2);
    }
  });

  it("ignoring the coin's wall (model 'top') biases the scale by about 1 % at 60 degrees; 'auto' picks the cylinder", () => {
    const views = exactViews(1, [60, 60, 60, 60], [0, 30, 60, 90], ref.thicknessMm);
    const top = fitCoinCircle3D(views, { diameterMm: ref.diameterMm, model: "top" });
    const auto = fitCoinCircle3D(views, { diameterMm: ref.diameterMm, thicknessMm: ref.thicknessMm, model: "auto" });
    expect(top.mmPerUnit! - 1).toBeLessThan(-0.005);
    expect(auto.circle!.model).toBe("cylinder");
    expect(Math.abs(auto.mmPerUnit! - 1)).toBeLessThan(1e-4);
    expect(auto.alternativeRmsPx!).toBeGreaterThan(auto.circle!.rmsPx);
  });

  it("refuses one view with an up-to-scale pose (scale and distance trade off), and fits the pose of a metric single view", () => {
    const one = exactViews(1, [60], [0], ref.thicknessMm);
    expect(fitCoinCircle3D(one, { diameterMm: ref.diameterMm }).reason).toBe("too_few_views");
    const pose = orbitCamera(300, 60, 0);
    const metric = fitCoinCircle3D([{ K, pose, points: silhouettePoints(K, pose, ref.diameterMm, ref.thicknessMm, 120)!.pts }], {
      diameterMm: ref.diameterMm,
      thicknessMm: ref.thicknessMm,
      fixedRadiusMm: ref.diameterMm / 2,
      model: "cylinder",
    });
    expect(metric.ok).toBe(true);
    expect(Math.hypot(metric.circle!.center[0], metric.circle!.center[1], metric.circle!.center[2] - ref.thicknessMm)).toBeLessThan(0.01);
  });

  it("Monte Carlo: 0.3 px edge noise, 4 views: unbiased to 0.05 %, scatter 0.1 %; pose noise adds a bias the covariance does not claim", () => {
    const [base] = sceneCases();
    const r = runSceneCase(base, coin, 6);
    expect(r.failed).toBe(0);
    expect(Math.abs(r.meanErr)).toBeLessThan(0.05);
    expect(r.maxAbsErr).toBeLessThan(0.25);
    const noisy = runSceneCase({ ...base, poseRotDeg: 0.3, posePosMm: 1, name: "pose" }, coin, 6);
    expect(Math.abs(noisy.meanErr) + noisy.sdErr).toBeGreaterThan(3 * (Math.abs(r.meanErr) + r.sdErr));
  }, 120_000);

  it.runIf(FULL)(
    "full scene-scale study (prints the README table)",
    () => {
      const rows = sceneCases().map((c) => runSceneCase(c, coin, Number(process.env.COIN_TRIALS ?? 20)));
      console.log(sceneTable(rows));
    },
    1_800_000,
  );
});

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCV(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 60_000);

describe("end to end from rendered pixels (SIMULATED)", () => {
  it("4 rendered views of a coin on a wooden table: production detector + measureCoin + scene fit recover the unknown scale within 0.5 %", () => {
    const views: CoinView[] = [];
    const s = SCENE_UNITS_PER_MM;
    for (const [el, az] of [
      [65, 10],
      [55, 70],
      [75, 140],
      [60, 220],
    ]) {
      const pose = orbitCamera(300, el, az);
      const c = project(K, pose, [0, 0, ref.thicknessMm])!;
      const Kc = cropIntrinsics(K, Math.round(c.x - 150), Math.round(c.y - 150), 300, 300);
      const img = renderCoinScene(Kc, pose, { diameterMm: ref.diameterMm, thicknessMm: ref.thicknessMm, surface: "wood", blurSigmaPx: 0.8, noiseSigma: 3, seed: az });
      const m = measureCoin(cv, img, { params, reference: ref, intrinsics: Kc });
      expect(m.production.found).toBe(true);
      expect(m.edgePoints.length).toBeGreaterThan(200);
      views.push({ K: Kc, pose: scaled(pose, s), points: m.edgePoints });
    }
    const r = fitCoinCircle3D(views, { diameterMm: ref.diameterMm, diameterAllowanceMm: ref.diameterAllowanceMm, thicknessMm: ref.thicknessMm, thicknessAllowanceMm: ref.thicknessAllowanceMm, model: "auto" });
    expect(r.ok).toBe(true);
    const err = r.mmPerUnit! * s - 1;
    if (FULL) console.log("end-to-end", r.circle!.model, (100 * err).toFixed(3), "% claimed", (100 * r.relSigma!).toFixed(3), r.circle!.perViewRmsPx.map((x) => x.toFixed(3)).join(","));
    expect(Math.abs(err)).toBeLessThan(0.005);
    expect(r.relSigma!).toBeGreaterThan(0);
  }, 120_000);
});
