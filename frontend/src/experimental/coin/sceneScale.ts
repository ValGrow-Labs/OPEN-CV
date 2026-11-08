// EXPERIMENTAL: the coin as the metric scale of a multi-view reconstruction.
//
// Structure from motion without a printed board gives camera poses UP TO SCALE (stage 3 of MASTER_AUDIT.md). The coin's
// rim seen in several views fixes that one scalar: recover the coin's 3D circle (centre, normal, radius) in the scene's
// own units from its image outlines, then
//     metric scale (mm per scene unit) = D / (2 r)          (D from config/reference_objects.json).
// That is ONE number for the whole 3D scene, which is correct; a 2D pixels-per-mm ratio is not (sensitivity.ts).
//
// Method (cone fitting rather than rim triangulation: points on a featureless rim have no correspondences between views,
// an epipolar line meets the other ellipse twice, and only the two tangent points are matched):
//   1. Each view's ellipse gives two candidate circle poses for a UNIT radius (conic.ts circlePosesFromConic). In the
//      world frame the candidate normals of the true plane agree across views; the consistent choice is kept.
//   2. The centre direction of each view (camera centre + s * ray) is triangulated in least squares; s per view is then the
//      radius in scene units (the unit-radius solution scales linearly).
//   3. Levenberg-Marquardt on all edge points of all views: parameters centre (3), normal (2 angles), log radius;
//      residual = Sampson distance of each edge point to the projected circle's conic (model "top"), or to the union of
//      the projected top and bottom rims of a cylinder of the coin's thickness-to-diameter ratio (model "cylinder": the
//      silhouette of a coin seen obliquely includes its wall). "auto" keeps the model with the smaller residual.
//   4. Uncertainty: the fit covariance (edge noise, number of views, baseline) for the radius, the reference diameter's
//      allowance, and the thickness allowance (by refitting with the thickness changed). Pose errors are NOT in the
//      covariance (poses are taken as given); the study adds them explicitly.
//
// One view cannot give the scale: a circle of radius r at distance Z looks the same as one of radius k r at k Z. With a
// METRIC pose (fixedRadiusMm) the same fit gives the coin's 3D pose from one view, used by measureCoin.ts.
//
// EXPERIMENTAL; results in README.md are SIMULATED.

import type { CameraPose, Intrinsics, Pt } from "../common";
import { cameraCenter } from "../geometry/camera";
import { dot, normalize, transpose, mulVec, type V3 } from "../geometry/linalg";
import { circlePosesFromConic, conicToEllipse, ellipseToConic, fitEllipseRobust, levenbergMarquardt, planeBasis, projectCircleConic, sampsonDistance, type Ellipse } from "./conic";

export interface CoinView {
  /** Intrinsics in the coordinates of `points` (undistorted pixels). */
  K: Pick<Intrinsics, "fx" | "fy" | "cx" | "cy">;
  /** World-to-camera pose, possibly with the translation in arbitrary (scene) units. */
  pose: CameraPose;
  /** Edge points of the coin outline, undistorted pixels (preferred), or only the ellipse (then sampled). */
  points?: readonly Pt[];
  ellipse?: Ellipse;
}

export type OutlineModel = "top" | "cylinder";

export interface CoinCircle3D {
  center: V3;
  /** Unit normal of the coin's plane, pointing to the side the cameras are on. */
  normal: V3;
  /** Radius in scene units. */
  radius: number;
  model: OutlineModel;
  rmsPx: number;
  perViewRmsPx: number[];
  /** Relative standard error of the radius from the fit covariance (edge scatter, views, baseline). */
  radiusRelSigma: number;
}

export interface SceneScaleResult {
  ok: boolean;
  reason?: "too_few_views" | "no_consistent_plane" | "fit_failed";
  circle?: CoinCircle3D;
  /** Millimetres per scene unit: D / (2 r). Multiply scene coordinates by it. */
  mmPerUnit?: number;
  components?: { key: "fit" | "reference_diameter" | "thickness"; rel: number; rule: string }[];
  relSigma?: number;
  /** The other model's RMS, for "auto". */
  alternativeRmsPx?: number;
  /** Every fit tried (models x starts), best first: with one metric view the two starts are the two circle poses. */
  fits?: CoinCircle3D[];
}

const rotate = (R: readonly number[], v: V3): V3 => mulVec(R, v);

/** Points to fit for one view: its edge points, or 72 points sampled on its ellipse. */
function viewPoints(v: CoinView): Pt[] {
  if (v.points && v.points.length >= 6) return [...v.points];
  if (!v.ellipse) return [];
  const e = v.ellipse;
  const a = e.major / 2, b = e.minor / 2, c = Math.cos((e.angleDeg * Math.PI) / 180), s = Math.sin((e.angleDeg * Math.PI) / 180);
  return Array.from({ length: 72 }, (_, i) => {
    const t = (2 * Math.PI * i) / 72;
    return { x: e.cx + a * Math.cos(t) * c - b * Math.sin(t) * s, y: e.cy + a * Math.cos(t) * s + b * Math.sin(t) * c };
  });
}

/** Residuals of one view for a circle (and, for the cylinder model, its bottom rim `thick` scene units below). */
export function outlineResiduals(pts: readonly Pt[], v: CoinView, center: V3, normal: V3, radius: number, model: OutlineModel, thick: number): number[] {
  const qTop = projectCircleConic(center, normal, radius, v.pose.R, v.pose.t, v.K);
  const eTop = qTop ? conicToEllipse(qTop) : null;
  if (!eTop) return pts.map(() => 1e3);
  if (model === "top" || !(thick > 0)) return pts.map((p) => sampsonDistance(eTop, p.x, p.y));
  const bottom: V3 = [center[0] - thick * normal[0], center[1] - thick * normal[1], center[2] - thick * normal[2]];
  const qB = projectCircleConic(bottom, normal, radius, v.pose.R, v.pose.t, v.K);
  const eB = qB ? conicToEllipse(qB) : null;
  if (!eB) return pts.map((p) => sampsonDistance(eTop, p.x, p.y));
  return pts.map((p) => Math.min(sampsonDistance(eTop, p.x, p.y), sampsonDistance(eB, p.x, p.y)));
}

interface InitCircle {
  center: V3;
  normal: V3;
  radius: number;
}

/** Initial circle from the per-view unit-radius poses (consistent normals, triangulated centre). */
function initialCircle(views: readonly CoinView[], ells: Ellipse[]): InitCircle | null {
  const cand = views.map((v, i) =>
    circlePosesFromConic(ellipseToConic(ells[i]), v.K, 1).map((s) => {
      const Rt = transpose(v.pose.R);
      return { nW: normalize(rotate(Rt, s.normal)), dirW: rotate(Rt, s.center), C: cameraCenter(v.pose) };
    }),
  );
  if (cand.some((c) => c.length === 0)) return null;
  // choose one candidate per view so the world normals agree (exhaustive for few views, greedy beyond)
  let best: number[] | null = null;
  let bestCost = Infinity;
  const nV = views.length;
  const choices = cand.map((c) => c.length);
  const total = choices.reduce((a, b) => a * b, 1);
  const evalChoice = (pick: number[]) => {
    let cost = 0;
    for (let i = 0; i < nV; i++) for (let j = i + 1; j < nV; j++) cost += 1 - Math.abs(dot(cand[i][pick[i]].nW, cand[j][pick[j]].nW));
    return cost;
  };
  if (total <= 4096) {
    for (let code = 0; code < total; code++) {
      const pick: number[] = [];
      let c = code;
      for (let i = 0; i < nV; i++) {
        pick.push(c % choices[i]);
        c = Math.floor(c / choices[i]);
      }
      const cost = evalChoice(pick);
      if (cost < bestCost) {
        bestCost = cost;
        best = pick;
      }
    }
  } else {
    for (let first = 0; first < choices[0]; first++) {
      const pick = [first];
      for (let i = 1; i < nV; i++) {
        let bi = 0, bc = Infinity;
        for (let k = 0; k < choices[i]; k++) {
          const c = 1 - Math.abs(dot(cand[0][first].nW, cand[i][k].nW));
          if (c < bc) {
            bc = c;
            bi = k;
          }
        }
        pick.push(bi);
      }
      const cost = evalChoice(pick);
      if (cost < bestCost) {
        bestCost = cost;
        best = pick;
      }
    }
  }
  if (!best) return null;
  const sel = best.map((k, i) => cand[i][k]);
  // mean normal, oriented toward the cameras
  let n: V3 = [0, 0, 0];
  for (const s of sel) {
    const sg = dot(s.nW, sel[0].nW) >= 0 ? 1 : -1;
    n = [n[0] + sg * s.nW[0], n[1] + sg * s.nW[1], n[2] + sg * s.nW[2]];
  }
  n = normalize(n);
  // triangulate the centre: minimise sum |C_i + s_i d_i - X|^2
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];
  for (const s of sel) {
    const d = normalize(s.dirW);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        const m = (r === c ? 1 : 0) - d[r] * d[c];
        A[r][c] += m;
        b[r] += m * s.C[c];
      }
  }
  const det =
    A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  if (!(Math.abs(det) > 1e-18)) return null;
  const inv = (M: number[][]) => {
    const [[a, bb, c], [d, e, f], [g, h, i]] = M;
    return [
      [(e * i - f * h) / det, (c * h - bb * i) / det, (bb * f - c * e) / det],
      [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
      [(d * h - e * g) / det, (bb * g - a * h) / det, (a * e - bb * d) / det],
    ];
  };
  const Ai = inv(A);
  const X: V3 = [Ai[0][0] * b[0] + Ai[0][1] * b[1] + Ai[0][2] * b[2], Ai[1][0] * b[0] + Ai[1][1] * b[1] + Ai[1][2] * b[2], Ai[2][0] * b[0] + Ai[2][1] * b[1] + Ai[2][2] * b[2]];
  // radius per view: the unit-radius centre lies at distance |dir| from the camera; the true one at |X - C|
  const radii = sel.map((s) => Math.hypot(X[0] - s.C[0], X[1] - s.C[1], X[2] - s.C[2]) / Math.hypot(...s.dirW));
  radii.sort((p, q) => p - q);
  const cams = sel.map((s) => s.C);
  const toward = cams.reduce((acc, C) => acc + dot(n, [C[0] - X[0], C[1] - X[1], C[2] - X[2]]), 0);
  if (toward < 0) n = [-n[0], -n[1], -n[2]];
  return { center: X, normal: n, radius: radii[radii.length >> 1] };
}

export interface FitOptions {
  /** The coin's physical diameter, mm (config). */
  diameterMm: number;
  /** Bounded allowance (+-) on the diameter, mm (config diameter_uncertainty_mm). */
  diameterAllowanceMm?: number;
  /** The coin's thickness, mm, for the cylinder model (config, or a stated assumption). */
  thicknessMm?: number;
  thicknessAllowanceMm?: number;
  model?: OutlineModel | "auto";
  /** A METRIC single-view use: the radius is known (mm) and only the pose of the coin is fitted. */
  fixedRadiusMm?: number;
  /** A start (e.g. from a previous fit) instead of the per-view initialisation. */
  start?: InitCircle;
}

function fitModel(views: readonly CoinView[], pts: Pt[][], init: InitCircle, model: OutlineModel, o: FitOptions, thicknessMm: number): CoinCircle3D | null {
  const ratio = thicknessMm / o.diameterMm; // thickness per unit diameter (scene units follow the radius)
  // the normal as a tangent perturbation of the start normal (no singularity at the poles)
  const n0 = normalize(init.normal);
  const [bu, bv] = planeBasis(n0);
  const fixedR = o.fixedRadiusMm;
  const p0 = fixedR ? [...init.center, 0, 0] : [...init.center, 0, 0, Math.log(init.radius)];
  const unpack = (p: readonly number[]) => ({
    c: [p[0], p[1], p[2]] as V3,
    n: normalize([n0[0] + p[3] * bu[0] + p[4] * bv[0], n0[1] + p[3] * bu[1] + p[4] * bv[1], n0[2] + p[3] * bu[2] + p[4] * bv[2]]),
    r: fixedR ?? Math.exp(p[5]),
  });
  const scaleC = Math.max(1e-9, Math.hypot(...init.center), init.radius);
  const resid = (p: readonly number[]) => {
    const { c, n, r } = unpack(p);
    const out: number[] = [];
    views.forEach((v, i) => out.push(...outlineResiduals(pts[i], v, c, n, r, model, 2 * r * ratio)));
    return out;
  };
  const lm = levenbergMarquardt(p0, resid, { iterations: 60, stepScale: [1e-7 * scaleC, 1e-7 * scaleC, 1e-7 * scaleC, 1e-7, 1e-7, 1e-7] });
  if (!lm.params.every(Number.isFinite)) return null;
  const { c, n, r } = unpack(lm.params);
  let normal = n;
  const toward = views.reduce((acc, v) => {
    const C = cameraCenter(v.pose);
    return acc + dot(normal, [C[0] - c[0], C[1] - c[1], C[2] - c[2]]);
  }, 0);
  if (toward < 0 && model === "top") normal = [-normal[0], -normal[1], -normal[2]];
  let k = 0;
  const perViewRmsPx = pts.map((p) => {
    const seg = lm.residuals.slice(k, k + p.length);
    k += p.length;
    return Math.sqrt(seg.reduce((s, x) => s + x * x, 0) / Math.max(1, seg.length));
  });
  const radiusRelSigma = fixedR || !lm.covariance ? 0 : Math.sqrt(Math.max(0, lm.covariance[5][5])); // d(log r)
  return { center: c, normal, radius: r, model, rmsPx: lm.rms, perViewRmsPx, radiusRelSigma };
}

/** Recover the coin's 3D circle from its outlines in views with known (possibly up-to-scale) poses. */
export function fitCoinCircle3D(views: readonly CoinView[], o: FitOptions): SceneScaleResult {
  if (views.length < (o.fixedRadiusMm ? 1 : 2)) return { ok: false, reason: "too_few_views" };
  const pts = views.map(viewPoints);
  if (pts.some((p) => p.length < 6)) return { ok: false, reason: "too_few_views" };
  const ells = views.map((v, i) => v.ellipse ?? fitEllipseRobust(pts[i])?.ellipse ?? null);
  if (ells.some((e) => !e)) return { ok: false, reason: "fit_failed" };
  let inits: InitCircle[];
  if (o.start) inits = [o.start];
  else if (o.fixedRadiusMm) {
    // single metric view: both circle poses are starts (the cylinder model may tell them apart)
    const v = views[0];
    const Rt = transpose(v.pose.R);
    const C = cameraCenter(v.pose);
    inits = circlePosesFromConic(ellipseToConic(ells[0] as Ellipse), v.K, o.fixedRadiusMm).map((s) => {
      const cw = rotate(Rt, s.center);
      return { center: [cw[0] + C[0], cw[1] + C[1], cw[2] + C[2]] as V3, normal: rotate(Rt, s.normal), radius: o.fixedRadiusMm as number };
    });
  } else {
    const init = initialCircle(views, ells as Ellipse[]);
    if (!init) return { ok: false, reason: "no_consistent_plane" };
    inits = [init];
  }
  if (!inits.length) return { ok: false, reason: "no_consistent_plane" };
  const h = o.thicknessMm ?? 0;
  const models: OutlineModel[] = o.model === "auto" ? (h > 0 ? ["top", "cylinder"] : ["top"]) : [o.model ?? "top"];
  const fits: CoinCircle3D[] = [];
  for (const m of models)
    for (const init of inits) {
      const f = fitModel(views, pts, init, m, o, h);
      if (f) fits.push(f);
    }
  if (!fits.length) return { ok: false, reason: "fit_failed" };
  fits.sort((a, b) => a.rmsPx - b.rmsPx);
  const best = fits[0];
  const alt = fits.find((f) => f.model !== best.model);
  const D = o.diameterMm;
  const mmPerUnit = D / (2 * best.radius);
  const components: NonNullable<SceneScaleResult["components"]> = [
    { key: "fit", rel: best.radiusRelSigma, rule: "standard error of log(radius) from the fit covariance (edge scatter, views, baseline; poses taken as exact)" },
    { key: "reference_diameter", rel: (o.diameterAllowanceMm ?? 0) / Math.sqrt(3) / D, rule: "config diameter allowance +-u (uniform) / D" },
  ];
  if (best.model === "cylinder" && (o.thicknessAllowanceMm ?? 0) > 0 && !o.fixedRadiusMm) {
    const dh = o.thicknessAllowanceMm as number;
    const f2 = fitModel(views, pts, best, "cylinder", o, h + dh);
    const rel = f2 ? Math.abs(f2.radius / best.radius - 1) / Math.sqrt(3) : 0;
    components.push({ key: "thickness", rel, rule: `refit with the thickness +${dh} mm; the change taken as a uniform bound` });
  }
  const relSigma = Math.sqrt(components.reduce((s, c) => s + c.rel * c.rel, 0));
  return { ok: true, circle: best, mmPerUnit, components, relSigma, alternativeRmsPx: alt?.rmsPx, fits };
}
