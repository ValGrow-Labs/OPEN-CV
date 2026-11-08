// SIMULATED study of the coin as the scale of a multi-view scene (sceneScale.ts). EXPERIMENTAL.
//
// A coin (diameter D, thickness h) lies on a table at the world origin; cameras on an orbit look at it. The poses given
// to the fit have their translations multiplied by an unknown factor s (structure from motion: scene = s * metric), and
// optionally perturbed (pose noise). Edge points are sampled on the TRUE silhouette (the union of the projected top and
// bottom rims of the cylinder: the wall shows in oblique views) with Gaussian noise along the outline's normal. The
// recovered mm-per-unit is compared with 1 / s. Analytic projection (no pixels) for the Monte Carlo tables; the
// end-to-end pixel version is in sceneScale.test.ts. NOTHING HERE IS REAL-WORLD ACCURACY.

import type { CameraPose, Intrinsics, Pt } from "../common";
import { intrinsicsFromHfov, lookAt, rotationFromAxisAngle } from "../geometry/camera";
import { mul, normalize, seededRandom, type V3 } from "../geometry/linalg";
import { conicToEllipse, projectCircleConic, sampleEllipse, sampsonDistance, type Ellipse } from "./conic";
import { fitCoinCircle3D, type CoinView, type OutlineModel } from "./sceneScale";

const DEG = Math.PI / 180;

export interface SceneCase {
  name: string;
  views: number;
  /** Camera elevations above the table (degrees); cycled over the views. */
  elevationsDeg: readonly number[];
  /** Total azimuth span covered by the views (degrees; 360 = all round). */
  azimuthSpanDeg: number;
  distanceMm?: number;
  edgeNoisePx: number;
  /** Pose noise: rotation (degrees, one sigma about a random axis) and camera-position noise (mm, one sigma per axis). */
  poseRotDeg?: number;
  posePosMm?: number;
  model: OutlineModel | "auto";
}

export interface SceneTrialSummary {
  name: string;
  trials: number;
  failed: number;
  /** Signed relative error of mm-per-unit vs truth, %: mean, standard deviation, worst |.|. */
  meanErr: number;
  sdErr: number;
  maxAbsErr: number;
  /** Mean claimed relative standard uncertainty, %. */
  claimedSigma: number;
  /** Its fit-covariance part only (edge noise, views, baseline), %: compare with sdErr. */
  claimedFitSigma: number;
  modelChosen: string;
}

export function orbitCamera(distanceMm: number, elevationDeg: number, azimuthDeg: number): CameraPose {
  const e = elevationDeg * DEG, a = azimuthDeg * DEG;
  const eye: V3 = [distanceMm * Math.cos(e) * Math.cos(a), distanceMm * Math.cos(e) * Math.sin(a), distanceMm * Math.sin(e)];
  const up: V3 = elevationDeg > 89 ? [-Math.cos(a), -Math.sin(a), 0] : [0, 0, 1];
  return lookAt(eye, [0, 0, 0], up);
}

/** Points on the silhouette of a cylinder coin (top rim at z = h, bottom at z = 0) seen by one camera. */
export function silhouettePoints(K: Pick<Intrinsics, "fx" | "fy" | "cx" | "cy">, pose: CameraPose, diameterMm: number, thicknessMm: number, n: number, phase = 0): { pts: Pt[]; top: Ellipse; bottom: Ellipse } | null {
  const r = diameterMm / 2;
  const qt = projectCircleConic([0, 0, thicknessMm], [0, 0, 1], r, pose.R, pose.t, K);
  const qb = projectCircleConic([0, 0, 0], [0, 0, 1], r, pose.R, pose.t, K);
  const top = qt ? conicToEllipse(qt) : null;
  const bottom = qb ? conicToEllipse(qb) : null;
  if (!top || !bottom) return null;
  const pts: Pt[] = [];
  for (const p of sampleEllipse(top, n, phase)) if (thicknessMm <= 0 || sampsonDistance(bottom, p.x, p.y) >= 0) pts.push(p);
  if (thicknessMm > 0) for (const p of sampleEllipse(bottom, n, phase)) if (sampsonDistance(top, p.x, p.y) > 0) pts.push(p);
  return { pts, top, bottom };
}

function noisyAlongNormal(pts: Pt[], ref: Ellipse, sigma: number, g: () => number): Pt[] {
  if (!(sigma > 0)) return pts;
  return pts.map((p) => {
    // outward direction from the ellipse centre (close to the normal for a near-circle)
    const dx = p.x - ref.cx, dy = p.y - ref.cy;
    const n = Math.hypot(dx, dy) || 1;
    const e = sigma * g();
    return { x: p.x + (e * dx) / n, y: p.y + (e * dy) / n };
  });
}

function perturbPose(pose: CameraPose, rotDeg: number, posMm: number, rnd: ReturnType<typeof seededRandom>): CameraPose {
  if (!(rotDeg > 0) && !(posMm > 0)) return pose;
  // camera centre C = -R^T t; perturb the rotation and the centre independently
  const R = pose.R;
  const C: V3 = [-(R[0] * pose.t[0] + R[3] * pose.t[1] + R[6] * pose.t[2]), -(R[1] * pose.t[0] + R[4] * pose.t[1] + R[7] * pose.t[2]), -(R[2] * pose.t[0] + R[5] * pose.t[1] + R[8] * pose.t[2])];
  const axis = normalize([rnd.gaussian(), rnd.gaussian(), rnd.gaussian()]);
  const dR = rotationFromAxisAngle(axis, rotDeg * DEG * rnd.gaussian());
  const R2 = mul(dR, R);
  const C2: V3 = [C[0] + posMm * rnd.gaussian(), C[1] + posMm * rnd.gaussian(), C[2] + posMm * rnd.gaussian()];
  const t: [number, number, number] = [-(R2[0] * C2[0] + R2[1] * C2[1] + R2[2] * C2[2]), -(R2[3] * C2[0] + R2[4] * C2[1] + R2[5] * C2[2]), -(R2[6] * C2[0] + R2[7] * C2[1] + R2[8] * C2[2])];
  return { R: R2, t };
}

export const SCENE_UNITS_PER_MM = 0.0371; // the "unknown" scale of the simulated structure from motion

export function runSceneCase(c: SceneCase, coin: { diameterMm: number; thicknessMm: number; diameterAllowanceMm: number; thicknessAllowanceMm: number }, trials = 20, seed0 = 1): SceneTrialSummary {
  const K = intrinsicsFromHfov(1280, 720, 69.4);
  const errs: number[] = [];
  const claimed: number[] = [];
  const claimedFit: number[] = [];
  const models: Record<string, number> = {};
  let failed = 0;
  const s = SCENE_UNITS_PER_MM;
  for (let tr = 0; tr < trials; tr++) {
    const rnd = seededRandom(seed0 + 1000 * tr);
    const views: CoinView[] = [];
    const az0 = 360 * rnd.uniform();
    for (let i = 0; i < c.views; i++) {
      const az = az0 + (c.views === 1 ? 0 : (c.azimuthSpanDeg * i) / (c.azimuthSpanDeg >= 360 ? c.views : c.views - 1));
      const el = c.elevationsDeg[i % c.elevationsDeg.length];
      const truePose = orbitCamera(c.distanceMm ?? 300, el, az);
      const sil = silhouettePoints(K, truePose, coin.diameterMm, coin.thicknessMm, 180, rnd.uniform());
      if (!sil) continue;
      const pts = noisyAlongNormal(sil.pts, sil.top, c.edgeNoisePx, rnd.gaussian);
      const given = perturbPose(truePose, c.poseRotDeg ?? 0, c.posePosMm ?? 0, rnd);
      views.push({ K, pose: { R: given.R, t: [given.t[0] * s, given.t[1] * s, given.t[2] * s] }, points: pts });
    }
    const r = fitCoinCircle3D(views, { diameterMm: coin.diameterMm, diameterAllowanceMm: coin.diameterAllowanceMm, thicknessMm: coin.thicknessMm, thicknessAllowanceMm: coin.thicknessAllowanceMm, model: c.model });
    if (!r.ok || !r.mmPerUnit) {
      failed++;
      continue;
    }
    errs.push(100 * (r.mmPerUnit * s - 1));
    claimed.push(100 * (r.relSigma ?? NaN));
    claimedFit.push(100 * (r.components?.find((q) => q.key === "fit")?.rel ?? NaN));
    const m = r.circle?.model ?? "?";
    models[m] = (models[m] ?? 0) + 1;
  }
  const mean = errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length);
  const sd = Math.sqrt(errs.reduce((a, e) => a + (e - mean) ** 2, 0) / Math.max(1, errs.length - 1));
  return {
    name: c.name,
    trials,
    failed,
    meanErr: errs.length ? mean : NaN,
    sdErr: errs.length > 1 ? sd : NaN,
    maxAbsErr: errs.length ? Math.max(...errs.map(Math.abs)) : NaN,
    claimedSigma: claimed.length ? claimed.reduce((a, b) => a + b, 0) / claimed.length : NaN,
    claimedFitSigma: claimedFit.length ? claimedFit.reduce((a, b) => a + b, 0) / claimedFit.length : NaN,
    modelChosen: Object.entries(models)
      .map(([k, v]) => `${k} ${v}`)
      .join(", "),
  };
}

/** The study's cases: views, viewing angles, baseline, edge noise, pose noise, outline model. */
export function sceneCases(): SceneCase[] {
  const base: SceneCase = { name: "", views: 4, elevationsDeg: [60], azimuthSpanDeg: 90, edgeNoisePx: 0.3, model: "auto" };
  const c = (name: string, over: Partial<SceneCase>): SceneCase => ({ ...base, ...over, name });
  return [
    c("baseline: 4 views, 60 deg up, 90 deg span, 0.3 px", {}),
    ...[2, 3, 6, 8].map((n) => c(`${n} views`, { views: n })),
    c("8 views all round (360 deg)", { views: 8, azimuthSpanDeg: 360 }),
    ...[10, 30, 180].map((a) => c(`azimuth span ${a} deg`, { azimuthSpanDeg: a })),
    c("elevation 85 deg (nearly overhead)", { elevationsDeg: [85] }),
    c("elevation 40 deg (low)", { elevationsDeg: [40] }),
    c("elevations 45 and 80 mixed", { elevationsDeg: [45, 80] }),
    ...[0.1, 0.5, 1.0].map((e) => c(`edge noise ${e} px`, { edgeNoisePx: e })),
    c("model top only (wall ignored)", { model: "top" }),
    c("model cylinder", { model: "cylinder" }),
    c("pose noise 0.1 deg / 0.5 mm", { poseRotDeg: 0.1, posePosMm: 0.5 }),
    c("pose noise 0.3 deg / 1 mm", { poseRotDeg: 0.3, posePosMm: 1 }),
    c("pose noise 0.3 deg / 1 mm, 8 views 360", { poseRotDeg: 0.3, posePosMm: 1, views: 8, azimuthSpanDeg: 360 }),
  ];
}

export function sceneTable(rows: readonly SceneTrialSummary[]): string {
  const f = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(3) : "n/a");
  return [
    "| Case | trials (failed) | mean err % | sd % | worst abs % | claimed fit sigma % | claimed total sigma % | model chosen |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.name} | ${r.trials} (${r.failed}) | ${f(r.meanErr)} | ${f(r.sdErr)} | ${f(r.maxAbsErr)} | ${Number.isFinite(r.claimedFitSigma) ? r.claimedFitSigma.toFixed(3) : "n/a"} | ${Number.isFinite(r.claimedSigma) ? r.claimedSigma.toFixed(3) : "n/a"} | ${r.modelChosen} |`,
    ),
  ].join("\n");
}

/** The ellipse of a view's top rim (for tests). */
export function topEllipse(K: Pick<Intrinsics, "fx" | "fy" | "cx" | "cy">, pose: CameraPose, diameterMm: number, thicknessMm: number): Ellipse | null {
  const q = projectCircleConic([0, 0, thicknessMm], [0, 0, 1], diameterMm / 2, pose.R, pose.t, K);
  return q ? conicToEllipse(q) : null;
}
