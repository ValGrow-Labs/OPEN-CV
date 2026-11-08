// SIMULATED sensitivity study of the coin scale (EXPERIMENTAL). Rendered coins (renderCoin.ts) with a known camera; the
// production detector and the refinement of measureCoin.ts run on the pixels; the errors are against the exact truth of
// the render. NOTHING HERE IS REAL-WORLD ACCURACY: an ideal cylinder coin, procedural surfaces, no JPEG, no real lens.
//
// Truth. For a coin whose base centre is at depth Z (camera z), with the top face h nearer along the normal:
//   s_top     = Z_top / f   mm per (undistorted) px for a fronto-parallel length at the depth of the top face's centre;
//   s_support = Z / f       the same at the surface the coin lies on (palm or table) under its centre.
// A fronto-parallel plane maps to the image by a pure scaling f / Z, so these are well defined anywhere in the frame.
//
// Estimators compared (relative error of the scale, %):
//   production  D / major from detectCoin (unchanged production code) vs s_top;
//   refined     D / major of the refined ellipse in the image's pixels vs s_top;
//   undistorted D / major after undistorting the edge points with the known lens model vs s_top;
//   corrected   Z_top / f from the exact circle pose (known intrinsics) vs s_top; and with the app's ASSUMED field of view;
//   support     corrected, then moved to the surface with the thickness vs s_support.
//
// And the 3D consequence: the coin's scale used as ONE global pixels-per-millimetre ratio for points at other depths.

import type { CoinDetectionParams } from "../../api/types";
import type { CV } from "../../vision/opencv";
import type { CameraPose, Intrinsics } from "../common";
import { ASSUMED_HFOV_DEG, distortNormalized, intrinsicsFromHfov, undistortNormalized } from "../geometry/camera";
import { cross, type V3 } from "../geometry/linalg";
import { circlePosesFromConic, ellipseToConic, type Ellipse } from "./conic";
import { measureCoin, type CoinMeasurement, type CoinReference } from "./measureCoin";
import { cropIntrinsics, occludedRimShare, renderCoinScene, SURFACE_COLORS, type Capsule, type CoinSceneOptions, type SurfaceKind } from "./renderCoin";

const DEG = Math.PI / 180;

export interface CoinScenario {
  group: string;
  name: string;
  width: number;
  height: number;
  /** Field of view across the long side (default 69.4 degrees, a 26 mm-equivalent phone main camera). */
  hfovDeg?: number;
  /** Depth of the coin's base centre along the optical axis, mm. */
  distanceMm: number;
  /** Where the coin's centre appears: (0, 0) image centre, (1, 1) bottom-right corner (fractions of the half-sizes). */
  position: [number, number];
  /** Angle between the coin's plane and the image plane (rotation about the camera x axis), degrees. */
  tiltDeg: number;
  k1?: number;
  blurSigmaPx: number;
  noiseSigma: number;
  glare: "none" | "face" | "rim";
  /** Target share of the coin's rim hidden by a finger (0 = none). */
  occlusion: number;
  surface: SurfaceKind | "skinDark";
  /** Contact shadow around the coin (default true: 1 mm wide, 25 % darker at the rim). */
  shadow?: boolean;
}

export const BASELINE: CoinScenario = {
  group: "baseline",
  name: "1280x720, 300 mm, centre, flat, skin",
  width: 1280,
  height: 720,
  distanceMm: 300,
  position: [0, 0],
  tiltDeg: 0,
  blurSigmaPx: 0.8,
  noiseSigma: 3,
  glare: "none",
  occlusion: 0,
  surface: "skin",
};

/** The one-factor-at-a-time scenario list of the study (each varies one thing from BASELINE). */
export function studyScenarios(): CoinScenario[] {
  const s = (group: string, name: string, over: Partial<CoinScenario>): CoinScenario => ({ ...BASELINE, ...over, group, name });
  const out: CoinScenario[] = [s("baseline", BASELINE.name, {})];
  for (const k1 of [0, -0.08])
    for (const q of [0, 0.25, 0.5, 0.75, 0.85]) out.push(s("position", `pos ${q.toFixed(2)} to corner, k1 ${k1}`, { position: [q, q], k1 }));
  out.push(s("position", "pos 0.97 (rim leaves the frame)", { position: [0.97, 0.97] }));
  for (const t of [10, 20, 30, 40, 45]) out.push(s("tilt", `tilt ${t} deg`, { tiltDeg: t }));
  for (const d of [200, 400, 500]) out.push(s("distance", `${d} mm`, { distanceMm: d }));
  out.push(s("resolution", "1920x1080", { width: 1920, height: 1080 }));
  out.push(s("resolution", "4000x3000 (12 MP still)", { width: 4000, height: 3000 }));
  for (const b of [0, 2, 3.5]) out.push(s("blur", `blur sigma ${b} px`, { blurSigmaPx: b }));
  for (const n of [0, 8, 16]) out.push(s("noise", `noise sigma ${n}`, { noiseSigma: n }));
  out.push(s("glare", "glare on the face", { glare: "face" }));
  out.push(s("glare", "glare reaching the rim", { glare: "rim" }));
  for (const o of [0.1, 0.25, 0.4]) out.push(s("occlusion", `finger over ${Math.round(o * 100)} % of the rim`, { occlusion: o }));
  for (const surf of ["skinDark", "paper", "wood"] as const) out.push(s("surface", `${surf}, flat`, { surface: surf }));
  for (const surf of ["skin", "skinDark", "paper", "wood"] as const) out.push(s("surface", `${surf}, tilt 30`, { surface: surf, tiltDeg: 30 }));
  for (const surf of ["skin", "paper"] as const) out.push(s("shadow", `${surf}, no contact shadow`, { surface: surf, shadow: false }));
  out.push(s("shadow", "paper, no contact shadow, tilt 30", { surface: "paper", shadow: false, tiltDeg: 30 }));
  return out;
}

export interface ScenarioCamera {
  K: Intrinsics;
  pose: CameraPose;
  /** Coin top-face centre and normal in the camera frame (truth). */
  topCenter: V3;
  normal: V3;
  baseDepthMm: number;
}

/** Camera and coin placement of a scenario (world = coin frame, see renderCoin.ts). */
export function scenarioCamera(sc: CoinScenario, thicknessMm: number): ScenarioCamera {
  const K0 = intrinsicsFromHfov(sc.width, sc.height, sc.hfovDeg ?? 69.4);
  const K: Intrinsics = { ...K0, k1: sc.k1 || undefined };
  const u = K.cx + sc.position[0] * (sc.width / 2);
  const v = K.cy + sc.position[1] * (sc.height / 2);
  const n = undistortNormalized((u - K.cx) / K.fx, (v - K.cy) / K.fy, K.k1, K.k2);
  const Z = sc.distanceMm;
  const P: V3 = [n.x * Z, n.y * Z, Z];
  const t = sc.tiltDeg * DEG;
  const nc: V3 = [0, -Math.sin(t), -Math.cos(t)];
  const ex: V3 = [1, 0, 0];
  const ey = cross(nc, ex);
  const R = [ex[0], ey[0], nc[0], ex[1], ey[1], nc[1], ex[2], ey[2], nc[2]];
  return { K, pose: { R, t: P }, topCenter: [P[0] + thicknessMm * nc[0], P[1] + thicknessMm * nc[1], P[2] + thicknessMm * nc[2]], normal: nc, baseDepthMm: Z };
}

/** A finger (capsule, radius 9 mm) lying across the coin from +x, placed so that about `share` of the rim is hidden. */
export function fingerForShare(pose: CameraPose, coin: { diameterMm: number; thicknessMm: number }, share: number): Capsule[] {
  if (!(share > 0)) return [];
  const R = coin.diameterMm / 2;
  const make = (xTip: number): Capsule[] => [{ a: [xTip, 0, coin.thicknessMm + 9.2], b: [xTip + 90, 0, coin.thicknessMm + 9.2], radius: 9, color: SURFACE_COLORS.skin }];
  let lo = -R - 9, hi = R + 9;
  for (let it = 0; it < 30; it++) {
    const mid = 0.5 * (lo + hi);
    if (occludedRimShare(pose, { ...coin, occluders: make(mid) }) > share) lo = mid;
    else hi = mid;
  }
  return make(0.5 * (lo + hi));
}

export interface RenderedScenario {
  image: ReturnType<typeof renderCoinScene>;
  /** Intrinsics of the crop that was rendered. */
  K: Intrinsics;
  camera: ScenarioCamera;
  crop: { x0: number; y0: number; width: number; height: number };
  occludedShareTruth: number;
}

/** Render the crop of the full frame that holds the coin (about four coin diameters, at least 160 px). */
export function renderScenario(sc: CoinScenario, coin: { diameterMm: number; thicknessMm: number }, seed = 1): RenderedScenario {
  const cam = scenarioCamera(sc, coin.thicknessMm);
  const { K } = cam;
  const c = cam.topCenter;
  const d = distortNormalized(c[0] / c[2], c[1] / c[2], K.k1, K.k2);
  const u = K.fx * d.x + K.cx, v = K.fy * d.y + K.cy;
  const diamPx = (K.fx * coin.diameterMm) / c[2];
  const side = Math.max(160, Math.ceil(4 * diamPx));
  const x0 = Math.max(0, Math.min(sc.width - side, Math.round(u - side / 2)));
  const y0 = Math.max(0, Math.min(sc.height - side, Math.round(v - side / 2)));
  const w = Math.min(side, sc.width), h = Math.min(side, sc.height);
  const Kc = cropIntrinsics(K, x0, y0, w, h);
  const occluders = fingerForShare(cam.pose, coin, sc.occlusion);
  const R = coin.diameterMm / 2;
  const glare: CoinSceneOptions["glare"] =
    sc.glare === "face" ? { x: -0.2 * R, y: 0.2 * R, sigmaMm: 0.22 * R, strength: 170 } : sc.glare === "rim" ? { x: 0.72 * R, y: 0, sigmaMm: 0.25 * R, strength: 220 } : undefined;
  const surface: SurfaceKind = sc.surface === "skinDark" ? "skin" : sc.surface;
  const image = renderCoinScene(Kc, cam.pose, {
    diameterMm: coin.diameterMm,
    thicknessMm: coin.thicknessMm,
    surface,
    surfaceColor: sc.surface === "skinDark" ? SURFACE_COLORS.skinDark : undefined,
    occluders,
    glare,
    blurSigmaPx: sc.blurSigmaPx,
    noiseSigma: sc.noiseSigma,
    shadowMm: sc.shadow === false ? 0 : 1,
    seed,
  });
  return { image, K: Kc, camera: cam, crop: { x0, y0, width: sc.width, height: sc.height }, occludedShareTruth: occluders.length ? occludedRimShare(cam.pose, { ...coin, occluders }) : 0 };
}

/** Perspective-corrected scale Z / f (mean of the two circle poses) for an ellipse and intrinsics. */
export function correctedScale(e: Ellipse, diameterMm: number, K: Pick<Intrinsics, "fx" | "fy" | "cx" | "cy">): number | null {
  const sols = circlePosesFromConic(ellipseToConic(e), K, diameterMm / 2);
  if (!sols.length) return null;
  const f = 0.5 * (K.fx + K.fy);
  return sols.reduce((a, s) => a + s.center[2] / f, 0) / sols.length;
}

export interface SensitivityRow {
  group: string;
  name: string;
  seeds: number;
  coinPx: number;
  detFound: number;
  detAccepted: number;
  measuredOk: number;
  /** Mean signed relative errors (%) over the seeds; NaN when not available. */
  errProduction: number;
  errRefined: number;
  errUndistorted: number;
  errCorrectedKnown: number;
  /** The 3D outline fit (cylinder when the wall shows) with known intrinsics. */
  errFit3D: number;
  errCorrectedAssumedFov: number;
  errSupport: number;
  /** Largest |error| of the support scale over the seeds (%). */
  maxAbsErrSupport: number;
  /** Mean claimed relative standard uncertainty of the support scale (%). */
  claimedSigma: number;
  tiltTrueDeg: number;
  tiltRatioDeg: number;
  tiltThicknessDeg: number;
  /** Tilt to the viewing ray of the circle-pose solution nearer the truth (the other is the sign-ambiguous twin). */
  tiltPoseDeg: number;
  /** Tilt to the ray from the 3D outline fit. */
  tiltFitDeg: number;
  /** Tilt sign suggested by the outline fit: 1 = suggested and right, 0 = suggested and WRONG, 0.5 = none (mean over seeds). */
  signScore: number;
  occludedTruth: number;
  occludedMeasured: number;
  glareShare: number;
  reasons: string;
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);

/** Run one scenario for several seeds and summarise. */
export function runScenario(cv: CV, sc: CoinScenario, params: CoinDetectionParams, ref: CoinReference, seeds = 2): SensitivityRow {
  const coin = { diameterMm: ref.diameterMm, thicknessMm: ref.thicknessMm };
  const acc = { prod: [] as number[], ref: [] as number[], und: [] as number[], ck: [] as number[], ca: [] as number[], sup: [] as number[], sig: [] as number[], tr: [] as number[], tt: [] as number[], tp: [] as number[], fit3: [] as number[], signOk: [] as number[], tf: [] as number[], occ: [] as number[], gl: [] as number[] };
  let found = 0, accepted = 0, ok = 0;
  const reasons = new Set<string>();
  let tiltTrue = NaN, coinPx = NaN, occTruth = 0;
  for (let s = 1; s <= seeds; s++) {
    const r = renderScenario(sc, coin, s);
    const cam = r.camera;
    const f = r.K.fx;
    const sTop = cam.topCenter[2] / f;
    const sSup = cam.baseDepthMm / f;
    const ray = Math.hypot(...cam.topCenter);
    tiltTrue = Math.acos(Math.abs(cam.normal[0] * cam.topCenter[0] + cam.normal[1] * cam.topCenter[1] + cam.normal[2] * cam.topCenter[2]) / ray) / DEG;
    coinPx = (f * coin.diameterMm) / cam.topCenter[2];
    occTruth = r.occludedShareTruth;
    const m: CoinMeasurement = measureCoin(cv, r.image, { params, reference: ref, intrinsics: r.K });
    if (m.production.found) {
      found++;
      acc.prod.push(100 * (ref.diameterMm / m.production.major_axis_px / sTop - 1));
    }
    if (m.production.accepted) accepted++;
    if (m.ok) ok++;
    m.reasons.forEach((q) => reasons.add(q));
    if (m.ellipseImage && m.ellipse && m.scale && m.orientation && m.visibility) {
      acc.ref.push(100 * (ref.diameterMm / m.ellipseImage.major / sTop - 1));
      acc.und.push(100 * (ref.diameterMm / m.ellipse.major / sTop - 1));
      acc.ck.push(100 * (m.scale.mmPerPxCone / sTop - 1));
      acc.fit3.push(100 * (m.scale.mmPerPxCorrected / sTop - 1));
      if (m.orientation.outlineFit) {
        const of = m.orientation.outlineFit;
        acc.signOk.push(of.wallSuggestsSign ? (of.normal[1] * cam.normal[1] + of.normal[2] * cam.normal[2] > 0.995 ? 1 : 0) : 0.5);
        acc.tf.push(Math.acos(Math.abs(of.normal[0] * cam.topCenter[0] + of.normal[1] * cam.topCenter[1] + of.normal[2] * cam.topCenter[2]) / Math.hypot(...cam.topCenter)) / DEG);
      }
      // the same ellipse WITHOUT intrinsics: raw image ellipse, focal from the assumed field of view (mid-range), principal point at the frame centre
      const fovMid = 0.5 * (ASSUMED_HFOV_DEG[0] + ASSUMED_HFOV_DEG[1]);
      const Ka = intrinsicsFromHfov(sc.width, sc.height, fovMid);
      const x0 = cam.K.cx - r.K.cx, y0 = cam.K.cy - r.K.cy;
      const sa = correctedScale(m.ellipseImage, ref.diameterMm, { fx: Ka.fx, fy: Ka.fy, cx: Ka.cx - x0, cy: Ka.cy - y0 });
      if (sa !== null) acc.ca.push(100 * (sa / sTop - 1));
      acc.sup.push(100 * (m.scale.mmPerPxSupport / sSup - 1));
      acc.sig.push(100 * m.scale.relSigma);
      acc.tr.push(m.orientation.tiltDeg);
      if (m.orientation.tiltDegThicknessCorrected !== null) acc.tt.push(m.orientation.tiltDegThicknessCorrected);
      const poses = m.orientation.poses ?? [];
      if (poses.length) {
        const best = poses.reduce((a, b) => (Math.abs(b.normal[1] - cam.normal[1]) + Math.abs(b.normal[2] - cam.normal[2]) < Math.abs(a.normal[1] - cam.normal[1]) + Math.abs(a.normal[2] - cam.normal[2]) ? b : a));
        acc.tp.push(best.tiltToRayDeg);
      }
      acc.occ.push(m.visibility.occludedShare);
      acc.gl.push(m.visibility.glareShare);
    }
  }
  return {
    group: sc.group,
    name: sc.name,
    seeds,
    coinPx,
    detFound: found / seeds,
    detAccepted: accepted / seeds,
    measuredOk: ok / seeds,
    errProduction: mean(acc.prod),
    errRefined: mean(acc.ref),
    errUndistorted: mean(acc.und),
    errCorrectedKnown: mean(acc.ck),
    errFit3D: mean(acc.fit3),
    signScore: mean(acc.signOk),
    tiltFitDeg: mean(acc.tf),
    errCorrectedAssumedFov: mean(acc.ca),
    errSupport: mean(acc.sup),
    maxAbsErrSupport: acc.sup.length ? Math.max(...acc.sup.map(Math.abs)) : NaN,
    claimedSigma: mean(acc.sig),
    tiltTrueDeg: tiltTrue,
    tiltRatioDeg: mean(acc.tr),
    tiltThicknessDeg: mean(acc.tt),
    tiltPoseDeg: mean(acc.tp),
    occludedTruth: occTruth,
    occludedMeasured: mean(acc.occ),
    glareShare: mean(acc.gl),
    reasons: [...reasons].join(" "),
  };
}

export function runSensitivityStudy(cv: CV, params: CoinDetectionParams, ref: CoinReference, opts: { scenarios?: CoinScenario[]; seeds?: number } = {}): SensitivityRow[] {
  return (opts.scenarios ?? studyScenarios()).map((sc) => runScenario(cv, sc, params, ref, opts.seeds ?? 2));
}

const f2 = (x: number, d = 2) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");

/** The study as a markdown table (signed % errors; tilts in degrees). */
export function sensitivityTable(rows: readonly SensitivityRow[]): string {
  const head = "| Group | Scenario | coin px | det found / accepted | prod % | refined % | undist % | cone K % | cone fov % | 3D fit K % | support % | claimed sigma % | tilt true / ratio / thick / pose / 3D | sign | occl true / meas | reasons |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map((r) =>
    [
      r.group,
      r.name,
      r.coinPx.toFixed(0),
      `${r.detFound.toFixed(1)} / ${r.detAccepted.toFixed(1)}`,
      f2(r.errProduction),
      f2(r.errRefined),
      f2(r.errUndistorted),
      f2(r.errCorrectedKnown),
      f2(r.errCorrectedAssumedFov),
      f2(r.errFit3D),
      f2(r.errSupport),
      Number.isFinite(r.claimedSigma) ? r.claimedSigma.toFixed(2) : "n/a",
      `${r.tiltTrueDeg.toFixed(1)} / ${Number.isFinite(r.tiltRatioDeg) ? r.tiltRatioDeg.toFixed(1) : "n/a"} / ${Number.isFinite(r.tiltThicknessDeg) ? r.tiltThicknessDeg.toFixed(1) : "n/a"} / ${Number.isFinite(r.tiltPoseDeg) ? r.tiltPoseDeg.toFixed(1) : "n/a"} / ${Number.isFinite(r.tiltFitDeg) ? r.tiltFitDeg.toFixed(1) : "n/a"}`,
      Number.isFinite(r.signScore) ? r.signScore.toFixed(2) : "n/a",
      `${r.occludedTruth.toFixed(2)} / ${Number.isFinite(r.occludedMeasured) ? r.occludedMeasured.toFixed(2) : "n/a"}`,
      r.reasons || "-",
    ].join(" | "),
  );
  return [head, sep, ...body.map((b) => `| ${b} |`)].join("\n");
}

// ------------------------------------------------------------------------------------------------ 3D consequence

export interface GlobalScaleCell {
  distanceMm: number;
  heightMm: number;
  /** Relative error of a length measured at that height with the coin's ratio: Z_coin / Z_point - 1 (positive = too long). */
  rel: number;
  /** The same in mm for the given lengths. */
  mmFor: Record<string, number>;
}

/**
 * Camera looking straight down at a coin on a table at distance Z; a fronto-parallel length at height dz above the
 * table is magnified by f / (Z - dz) while the coin's ratio assumes f / Z. Exact for a pinhole camera.
 */
export function globalScaleErrorTable(distancesMm: readonly number[], heightsMm: readonly number[], lengthsMm: Record<string, number>): GlobalScaleCell[] {
  const out: GlobalScaleCell[] = [];
  for (const Z of distancesMm)
    for (const dz of heightsMm) {
      const rel = Z / (Z - dz) - 1;
      const mmFor: Record<string, number> = {};
      for (const [k, L] of Object.entries(lengthsMm)) mmFor[k] = L * rel;
      out.push({ distanceMm: Z, heightMm: dz, rel, mmFor });
    }
  return out;
}

export interface PlaneMapCell {
  x: number;
  y: number;
  heightMm: number;
  /** Z_coin / Z_point - 1 for a small fronto-parallel length at the point. */
  rel: number;
}

/**
 * A camera at `distanceMm` from the coin (at the table origin), looking at it from `elevationDeg` above the table
 * (90 = straight down), toward +y. For points of the table grid lifted by `heightMm`, the error of using the coin's
 * ratio: the depth varies across a tilted view even on the table itself.
 */
export function tiltedViewErrorMap(distanceMm: number, elevationDeg: number, grid: readonly number[], heightsMm: readonly number[]): PlaneMapCell[] {
  const e = elevationDeg * DEG;
  const eye: V3 = [0, -distanceMm * Math.cos(e), distanceMm * Math.sin(e)];
  const fwd: V3 = [-eye[0] / distanceMm, -eye[1] / distanceMm, -eye[2] / distanceMm];
  const depth = (p: V3) => (p[0] - eye[0]) * fwd[0] + (p[1] - eye[1]) * fwd[1] + (p[2] - eye[2]) * fwd[2];
  const zCoin = depth([0, 0, 0]);
  const out: PlaneMapCell[] = [];
  for (const dz of heightsMm) for (const y of grid) for (const x of grid) out.push({ x, y, heightMm: dz, rel: zCoin / depth([x, y, dz]) - 1 });
  return out;
}
