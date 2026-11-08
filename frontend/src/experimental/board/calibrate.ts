// Camera self-calibration from several views of the printed board, for the EXPERIMENTAL multi-view reconstruction.
//
// A web page gets no focal length, principal point or lens distortion from getUserMedia; the production app assumes a
// horizontal field of view of 55 to 80 degrees. The board is a known plane, so the intrinsics can be estimated from
// several views of it (Zhang, "A flexible new technique for camera calibration", IEEE TPAMI 22(11), 2000):
//   1. one homography per view (board mm -> pixels, normalised DLT from geometry/pnp.ts);
//   2. closed form: each homography gives two linear constraints on the image of the absolute conic B = K^-T K^-1.
//      With zero skew, square pixels and the principal point at the image centre, B has one unknown (1 / f^2), solved
//      by least squares over all views (works from one tilted view). With three or more views the general 5-parameter
//      form (fx, fy, cx, cy, zero skew enforced) is also solved, as a diagnostic;
//   3. initial poses per view from the homographies and the closed-form K;
//   4. joint Levenberg-Marquardt over the intrinsics (f, or fx and fy; optional principal point; k1; k2 when the data
//      justify it) and every view's pose, minimising the reprojection error in pixels;
//   5. standard deviations from the Gauss-Newton covariance sigma^2 (J^T J)^-1, sigma^2 = SSR / (2 M - P);
//   6. degeneracy checks: too few views, all views nearly fronto-parallel, all views tilted alike.
// When calibration is impossible, `calibrateCamera` returns the ASSUMED intrinsics of a field-of-view prior, flagged
// `assumed: true` (never silently a measurement).
//
// EXPERIMENTAL. Calibration accuracy in README.md is SIMULATED (rendered views with known truth).

import type { CameraPose, Intrinsics, Pt } from "../common";
import { ASSUMED_HFOV_DEG, axisAngleFromRotation, intrinsicsFromHfov, project, rotationFromAxisAngle } from "../geometry/camera";
import { estimateHomography, poseFromPlanarPoints } from "../geometry/pnp";
import { norm, solveLinear, type M3, type V3 } from "../geometry/linalg";
import type { MarkerDetection } from "./detect";
import { BOARD, markerCorners, type BoardLayout } from "./spec";

/** One view: board points (z = 0, board mm) and their observed pixels. */
export interface PlanarView {
  world: Pt[];
  image: Pt[];
}

/** The correspondences of one view from its marker detections. */
export function viewFromDetections(markers: readonly MarkerDetection[], layout: BoardLayout = BOARD): PlanarView {
  const byId = new Map(layout.markers.map((m) => [m.id, m]));
  const world: Pt[] = [];
  const image: Pt[] = [];
  for (const d of markers) {
    const m = byId.get(d.id);
    if (!m) continue;
    const c3 = markerCorners(m, layout.markerMm);
    for (let i = 0; i < 4; i++) {
      world.push({ x: c3[i].x, y: c3[i].y });
      image.push(d.corners[i]);
    }
  }
  return { world, image };
}

export interface CalibrationOptions {
  /** "square": fx = fy (default). "free": fx and fy separately. */
  aspect?: "square" | "free";
  /** "center": fixed at the image centre (default). "estimate": refined jointly. */
  principalPoint?: "center" | "estimate";
  /** "auto" (default): k1, plus k2 when it improves the fit significantly; or a fixed model. */
  distortion?: "none" | "k1" | "k1k2" | "auto";
  /** Field of view of the fallback when calibration is impossible (default: middle of the app's assumed range). */
  fallbackHfovDeg?: number;
  maxIterations?: number;
}

export interface Degeneracy {
  degenerate: boolean;
  /** Angle between each view's board plane and its image plane, degrees. */
  tiltsDeg: number[];
  /** Largest angle between the board normals of two views (in camera coordinates), degrees. */
  normalSpreadDeg: number;
  reasons: string[];
}

export interface ZhangCalibration {
  ok: true;
  method: "zhang";
  assumed: false;
  intrinsics: Intrinsics;
  model: { aspect: "square" | "free"; principalPoint: "center" | "estimate"; distortion: "none" | "k1" | "k1k2" };
  rmsPx: number;
  perViewRmsPx: number[];
  poses: CameraPose[];
  /** One-sigma standard deviations from the Gauss-Newton covariance (null where the parameter was fixed). */
  std: { fx: number; fy: number | null; cx: number | null; cy: number | null; k1: number | null; k2: number | null };
  /** Closed-form focal length (principal point at the centre, square pixels), before refinement, pixels. */
  closedFormFocalPx: number | null;
  /** The general closed form (zero skew), when three or more views allow it; a diagnostic. */
  closedFormGeneral: { fx: number; fy: number; cx: number; cy: number } | null;
  degeneracy: Degeneracy;
  iterations: number;
  /** Plain-language warnings (e.g. a focal length whose relative standard deviation exceeds 2 %). */
  warnings: string[];
}

export interface AssumedCalibration {
  ok: true;
  method: "assumed_hfov";
  assumed: true;
  intrinsics: Intrinsics;
  hfovDeg: number;
  /** The focal lengths of the app's whole assumed field-of-view range, pixels (the true value can be anywhere here). */
  focalRangePx: [number, number];
  reason: string;
  closedFormFocalPx: number | null;
  degeneracy: Degeneracy | null;
}

export type CalibrationResult = ZhangCalibration | AssumedCalibration;

/** Intrinsics from a field-of-view prior, flagged as ASSUMED (the fallback when calibration is impossible). */
export function assumedIntrinsics(width: number, height: number, hfovDeg = (ASSUMED_HFOV_DEG[0] + ASSUMED_HFOV_DEG[1]) / 2, reason = "no calibration"): AssumedCalibration {
  const fA = intrinsicsFromHfov(width, height, ASSUMED_HFOV_DEG[1]).fx;
  const fB = intrinsicsFromHfov(width, height, ASSUMED_HFOV_DEG[0]).fx;
  return {
    ok: true,
    method: "assumed_hfov",
    assumed: true,
    intrinsics: intrinsicsFromHfov(width, height, hfovDeg),
    hfovDeg,
    focalRangePx: [fA, fB],
    reason,
    closedFormFocalPx: null,
    degeneracy: null,
  };
}

// ------------------------------------------------------------------------------------------------ closed form

/** The homography with the image coordinates normalised: x' = (x - cx) / s, y' = (y - cy) / s. */
function normalisedHomography(v: PlanarView, cx: number, cy: number, s: number): number[] | null {
  const img = v.image.map((p) => ({ x: (p.x - cx) / s, y: (p.y - cy) / s }));
  const H = estimateHomography(v.world, img);
  if (!H) return null;
  const n = Math.hypot(...H);
  return H.map((x) => x / n);
}

/** Least-squares 1 / f^2 (in normalised units) from the two conic constraints of every view; f in pixels or null. */
export function closedFormFocal(views: readonly PlanarView[], width: number, height: number): number | null {
  const s = Math.max(width, height);
  let saa = 0, sab = 0;
  for (const v of views) {
    const H = normalisedHomography(v, width / 2, height / 2, s);
    if (!H) continue;
    const [a1, a2, , b1, b2, , c1, c2] = H;
    // h1 = (a1, b1, c1), h2 = (a2, b2, c2): w (a1 a2 + b1 b2) + c1 c2 = 0;  w (a1^2 + b1^2 - a2^2 - b2^2) + c1^2 - c2^2 = 0
    const rows: [number, number][] = [
      [a1 * a2 + b1 * b2, c1 * c2],
      [a1 * a1 + b1 * b1 - a2 * a2 - b2 * b2, c1 * c1 - c2 * c2],
    ];
    for (const [A, B] of rows) {
      saa += A * A;
      sab += A * B;
    }
  }
  if (!(saa > 0)) return null;
  const w = -sab / saa;
  return w > 0 ? s / Math.sqrt(w) : null;
}

/** Eigen-decomposition of a symmetric matrix (cyclic Jacobi). Returns eigenvalues and column eigenvectors. */
function symmetricEigen(A: number[][]): { values: number[]; vectors: number[][] } {
  const n = A.length;
  const a = A.map((r) => [...r]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  return { values: a.map((r, i) => r[i]), vectors: v };
}

/** Zhang's general closed form with zero skew enforced (needs three or more views). */
export function closedFormGeneral(views: readonly PlanarView[], width: number, height: number): { fx: number; fy: number; cx: number; cy: number } | null {
  if (views.length < 3) return null;
  const s = Math.max(width, height);
  const cx0 = width / 2, cy0 = height / 2;
  const rows: number[][] = [];
  const vij = (H: number[], i: number, j: number) => {
    const h = (r: number, c: number) => H[r * 3 + c]; // column c = h_c, row r
    return [
      h(0, i) * h(0, j),
      h(0, i) * h(1, j) + h(1, i) * h(0, j),
      h(1, i) * h(1, j),
      h(2, i) * h(0, j) + h(0, i) * h(2, j),
      h(2, i) * h(1, j) + h(1, i) * h(2, j),
      h(2, i) * h(2, j),
    ];
  };
  for (const v of views) {
    const H = normalisedHomography(v, cx0, cy0, s);
    if (!H) continue;
    const v12 = vij(H, 0, 1);
    const v11 = vij(H, 0, 0);
    const v22 = vij(H, 1, 1);
    rows.push(v12, v11.map((x, k) => x - v22[k]));
  }
  rows.push([0, 10, 0, 0, 0, 0]); // zero skew: B12 = 0 (weighted)
  const AtA = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => rows.reduce((acc, r) => acc + r[i] * r[j], 0)));
  const { values, vectors } = symmetricEigen(AtA);
  let k = 0;
  for (let i = 1; i < 6; i++) if (values[i] < values[k]) k = i;
  let b = vectors.map((r) => r[k]);
  if (b[0] < 0) b = b.map((x) => -x);
  const [B11, B12, B22, B13, B23, B33] = b;
  const den = B11 * B22 - B12 * B12;
  if (!(den > 0) || !(B11 > 0)) return null;
  const v0 = (B12 * B13 - B11 * B23) / den;
  const lambda = B33 - (B13 * B13 + v0 * (B12 * B13 - B11 * B23)) / B11;
  if (!(lambda / B11 > 0)) return null;
  const alpha = Math.sqrt(lambda / B11);
  const beta = Math.sqrt((lambda * B11) / den);
  const gamma = (-B12 * alpha * alpha * beta) / lambda;
  const u0 = (gamma * v0) / beta - (B13 * alpha * alpha) / lambda;
  const out = { fx: alpha * s, fy: beta * s, cx: u0 * s + cx0, cy: v0 * s + cy0 };
  return Object.values(out).every(Number.isFinite) ? out : null;
}

// ------------------------------------------------------------------------------------------------ joint refinement

interface Layout {
  nI: number;
  idx: { fx: number; fy: number; cx: number; cy: number; k1: number; k2: number };
}

function paramLayout(aspect: "square" | "free", pp: "center" | "estimate", dist: "none" | "k1" | "k1k2"): Layout {
  let n = 0;
  const idx = { fx: n++, fy: -1, cx: -1, cy: -1, k1: -1, k2: -1 };
  if (aspect === "free") idx.fy = n++;
  if (pp === "estimate") {
    idx.cx = n++;
    idx.cy = n++;
  }
  if (dist !== "none") idx.k1 = n++;
  if (dist === "k1k2") idx.k2 = n++;
  return { nI: n, idx };
}

function intrinsicsOf(p: readonly number[], L: Layout, base: Intrinsics): Intrinsics {
  const { idx } = L;
  return {
    fx: p[idx.fx],
    fy: idx.fy >= 0 ? p[idx.fy] : p[idx.fx],
    cx: idx.cx >= 0 ? p[idx.cx] : base.cx,
    cy: idx.cy >= 0 ? p[idx.cy] : base.cy,
    width: base.width,
    height: base.height,
    k1: idx.k1 >= 0 ? p[idx.k1] : 0,
    k2: idx.k2 >= 0 ? p[idx.k2] : 0,
  };
}

function poseOf(p: readonly number[], o: number): CameraPose {
  const w: V3 = [p[o], p[o + 1], p[o + 2]];
  const a = norm(w);
  return { R: a < 1e-12 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : rotationFromAxisAngle(w, a), t: [p[o + 3], p[o + 4], p[o + 5]] };
}

function viewResiduals(K: Intrinsics, pose: CameraPose, v: PlanarView, out: number[]): void {
  out.length = 0;
  for (let i = 0; i < v.world.length; i++) {
    const q = project(K, pose, [v.world[i].x, v.world[i].y, 0]);
    out.push(q ? q.x - v.image[i].x : 1e4, q ? q.y - v.image[i].y : 1e4);
  }
}

interface LmResult {
  params: number[];
  ssr: number;
  perViewSsr: number[];
  JtJ: number[][];
  iterations: number;
}

function jointLm(views: readonly PlanarView[], L: Layout, base: Intrinsics, p0: number[], maxIter: number): LmResult {
  const nV = views.length;
  const P = L.nI + 6 * nV;
  let p = [...p0];
  const tmp: number[] = [];
  const evalSsr = (q: readonly number[]) => {
    const K = intrinsicsOf(q, L, base);
    const per: number[] = [];
    let s = 0;
    for (let v = 0; v < nV; v++) {
      viewResiduals(K, poseOf(q, L.nI + 6 * v), views[v], tmp);
      let sv = 0;
      for (const r of tmp) sv += r * r;
      per.push(sv);
      s += sv;
    }
    return { s, per };
  };
  const steps = (k: number, q: readonly number[]) => {
    if (k === L.idx.fx || k === L.idx.fy) return 1e-3 * Math.abs(q[k]);
    if (k === L.idx.cx || k === L.idx.cy) return 1e-2;
    if (k === L.idx.k1 || k === L.idx.k2) return 1e-6;
    const local = (k - L.nI) % 6;
    return local < 3 ? 1e-6 : 1e-4 * Math.max(1, Math.abs(q[k]));
  };
  const buildNormal = (q: readonly number[]) => {
    const JtJ = Array.from({ length: P }, () => new Array<number>(P).fill(0));
    const Jtr = new Array<number>(P).fill(0);
    const K0 = intrinsicsOf(q, L, base);
    for (let v = 0; v < nV; v++) {
      const o = L.nI + 6 * v;
      const r0: number[] = [];
      viewResiduals(K0, poseOf(q, o), views[v], r0);
      const cols: { k: number; d: number[] }[] = [];
      const rp: number[] = [], rm: number[] = [];
      for (let k = 0; k < L.nI; k++) {
        const e = steps(k, q);
        const qp = [...q], qm = [...q];
        qp[k] += e;
        qm[k] -= e;
        viewResiduals(intrinsicsOf(qp, L, base), poseOf(qp, o), views[v], rp);
        viewResiduals(intrinsicsOf(qm, L, base), poseOf(qm, o), views[v], rm);
        cols.push({ k, d: rp.map((x, i) => (x - rm[i]) / (2 * e)) });
      }
      for (let j = 0; j < 6; j++) {
        const k = o + j;
        const e = steps(k, q);
        const qp = [...q], qm = [...q];
        qp[k] += e;
        qm[k] -= e;
        viewResiduals(K0, poseOf(qp, o), views[v], rp);
        viewResiduals(K0, poseOf(qm, o), views[v], rm);
        cols.push({ k, d: rp.map((x, i) => (x - rm[i]) / (2 * e)) });
      }
      for (let a = 0; a < cols.length; a++) {
        const ca = cols[a];
        let g = 0;
        for (let i = 0; i < r0.length; i++) g += ca.d[i] * r0[i];
        Jtr[ca.k] += g;
        for (let b = a; b < cols.length; b++) {
          const cb = cols[b];
          let s = 0;
          for (let i = 0; i < r0.length; i++) s += ca.d[i] * cb.d[i];
          JtJ[ca.k][cb.k] += s;
          if (cb.k !== ca.k) JtJ[cb.k][ca.k] += s;
        }
      }
    }
    return { JtJ, Jtr };
  };
  let cur = evalSsr(p);
  let lambda = 1e-3;
  let it = 0;
  let done = false;
  let normal = buildNormal(p);
  for (; it < maxIter && !done; it++) {
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = normal.JtJ.map((row, a) => row.map((x, b) => (a === b ? x * (1 + lambda) + 1e-12 : x)));
      const step = solveLinear(A, normal.Jtr.map((x) => -x));
      if (!step) {
        lambda *= 10;
        continue;
      }
      const cand = p.map((x, k) => x + step[k]);
      const c = evalSsr(cand);
      if (c.s < cur.s) {
        const rel = (cur.s - c.s) / Math.max(cur.s, 1e-300);
        p = cand;
        cur = c;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        normal = buildNormal(p);
        if (rel < 1e-10) done = true; // converged
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { params: p, ssr: cur.s, perViewSsr: cur.per, JtJ: normal.JtJ, iterations: it };
}

function covarianceDiag(JtJ: number[][], indices: number[], sigma2: number): Map<number, number> {
  const P = JtJ.length;
  const out = new Map<number, number>();
  for (const k of indices) {
    if (k < 0) continue;
    const e = new Array<number>(P).fill(0);
    e[k] = 1;
    const x = solveLinear(JtJ.map((r) => [...r]), e);
    out.set(k, x ? Math.sqrt(Math.max(0, x[k] * sigma2)) : NaN);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ degeneracy

/** Degeneracy of a set of views. With square pixels and the principal point fixed, one tilted view already determines
 *  the focal length, so similar tilts only weaken it; estimating the principal point or a free aspect ratio needs the
 *  board normals to differ between views (Zhang 2000, section 3.3: parallel planes add no constraint). */
function degeneracyOf(poses: readonly CameraPose[], needsVariedTilts: boolean): Degeneracy {
  const normals = poses.map((p) => [p.R[2], p.R[5], p.R[8]] as V3); // board normal in camera coordinates
  const tiltsDeg = normals.map((n) => (Math.acos(Math.min(1, Math.abs(n[2]))) * 180) / Math.PI);
  let spread = 0;
  for (let i = 0; i < normals.length; i++)
    for (let j = i + 1; j < normals.length; j++) {
      const d = Math.abs(normals[i][0] * normals[j][0] + normals[i][1] * normals[j][1] + normals[i][2] * normals[j][2]);
      spread = Math.max(spread, (Math.acos(Math.min(1, d)) * 180) / Math.PI);
    }
  const reasons: string[] = [];
  if (poses.length < 3) reasons.push(`only ${poses.length} usable views (at least 3 are needed)`);
  if (Math.max(0, ...tiltsDeg) < 10) reasons.push("every view is within 10 degrees of fronto-parallel: the focal length is not observable");
  if (needsVariedTilts && poses.length >= 2 && spread < 8)
    reasons.push(`the views are tilted alike (board normals within ${spread.toFixed(1)} degrees): the principal point / aspect ratio cannot be separated; vary the phone's height and tilt`);
  return { degenerate: reasons.length > 0, tiltsDeg, normalSpreadDeg: spread, reasons };
}

// ------------------------------------------------------------------------------------------------ main

/**
 * Calibrate the camera from views of the board (board mm -> pixels). Returns a Zhang calibration, or, when that is
 * impossible (fewer than 3 usable views, degenerate tilts, failure), the ASSUMED field-of-view intrinsics flagged as such.
 */
export function calibrateCamera(viewsIn: readonly PlanarView[], width: number, height: number, opts: CalibrationOptions = {}): CalibrationResult {
  const fallbackHfov = opts.fallbackHfovDeg ?? (ASSUMED_HFOV_DEG[0] + ASSUMED_HFOV_DEG[1]) / 2;
  const views = viewsIn.filter((v) => v.world.length >= 8 && v.world.length === v.image.length);
  const f0 = closedFormFocal(views, width, height);
  const fallback = (reason: string, deg: Degeneracy | null): AssumedCalibration => ({
    ...assumedIntrinsics(width, height, fallbackHfov, reason),
    closedFormFocalPx: f0,
    degeneracy: deg,
  });
  if (views.length < 3) return fallback(`only ${views.length} usable views (each needs at least two markers); at least 3 are needed`, null);
  const base: Intrinsics = { ...intrinsicsFromHfov(width, height, fallbackHfov), fx: f0 ?? intrinsicsFromHfov(width, height, fallbackHfov).fx };
  base.fy = base.fx;
  // initial poses from the closed-form intrinsics
  const poses0: CameraPose[] = [];
  for (const v of views) {
    const r = poseFromPlanarPoints(base, v.world, v.image);
    if (!r.ok) return fallback(`a view's initial pose failed (${r.reason})`, null);
    poses0.push(r.pose);
  }
  const aspect = opts.aspect ?? "square";
  const pp = opts.principalPoint ?? "center";
  const deg0 = degeneracyOf(poses0, aspect === "free" || pp === "estimate");
  if (deg0.degenerate || !f0) return fallback(f0 ? deg0.reasons.join("; ") : "the closed-form focal length has no solution (views too fronto-parallel or inconsistent)", deg0);

  const maxIter = opts.maxIterations ?? 60;
  const totalPts = views.reduce((s, v) => s + v.world.length, 0);

  const fit = (dist: "none" | "k1" | "k1k2", start?: { p: number[]; L: Layout }) => {
    const L = paramLayout(aspect, pp, dist);
    const p0 = new Array<number>(L.nI + 6 * views.length).fill(0);
    p0[L.idx.fx] = start ? start.p[start.L.idx.fx] : base.fx;
    if (L.idx.fy >= 0) p0[L.idx.fy] = start && start.L.idx.fy >= 0 ? start.p[start.L.idx.fy] : p0[L.idx.fx];
    if (L.idx.cx >= 0) {
      p0[L.idx.cx] = start && start.L.idx.cx >= 0 ? start.p[start.L.idx.cx] : base.cx;
      p0[L.idx.cy] = start && start.L.idx.cy >= 0 ? start.p[start.L.idx.cy] : base.cy;
    }
    if (L.idx.k1 >= 0) p0[L.idx.k1] = start && start.L.idx.k1 >= 0 ? start.p[start.L.idx.k1] : 0;
    for (let v = 0; v < views.length; v++) {
      const o = L.nI + 6 * v;
      if (start) for (let j = 0; j < 6; j++) p0[o + j] = start.p[start.L.nI + 6 * v + j];
      else {
        const { axis, angleRad } = axisAngleFromRotation(poses0[v].R as M3);
        p0.splice(o, 6, axis[0] * angleRad, axis[1] * angleRad, axis[2] * angleRad, poses0[v].t[0], poses0[v].t[1], poses0[v].t[2]);
      }
    }
    const r = jointLm(views, L, base, p0, maxIter);
    const dof = Math.max(1, 2 * totalPts - (L.nI + 6 * views.length));
    return { ...r, L, dist, dof, sigma2: r.ssr / dof };
  };

  const want = opts.distortion ?? "auto";
  let best = fit(want === "auto" ? "k1" : want);
  if (want === "auto") {
    const k2fit = fit("k1k2", { p: best.params, L: best.L });
    const F = (best.ssr - k2fit.ssr) / Math.max(k2fit.sigma2, 1e-300); // one extra parameter
    const k2std = covarianceDiag(k2fit.JtJ, [k2fit.L.idx.k2], k2fit.sigma2).get(k2fit.L.idx.k2) ?? NaN;
    const k2 = k2fit.params[k2fit.L.idx.k2];
    if (F > 10 && Math.abs(k2) > 3 * k2std && k2fit.ssr < 0.98 * best.ssr) best = k2fit;
  }
  const { L } = best;
  const K = intrinsicsOf(best.params, L, base);
  const poses = views.map((_, v) => poseOf(best.params, L.nI + 6 * v));
  const cov = covarianceDiag(best.JtJ, [L.idx.fx, L.idx.fy, L.idx.cx, L.idx.cy, L.idx.k1, L.idx.k2], best.sigma2);
  const get = (k: number) => (k >= 0 ? (cov.get(k) ?? NaN) : null);
  const perViewRmsPx = best.perViewSsr.map((s, v) => Math.sqrt(s / views[v].world.length));
  const degeneracy = degeneracyOf(poses, aspect === "free" || pp === "estimate");
  const std = { fx: get(L.idx.fx) as number, fy: get(L.idx.fy), cx: get(L.idx.cx), cy: get(L.idx.cy), k1: get(L.idx.k1), k2: get(L.idx.k2) };
  const warnings: string[] = [];
  if (std.fx / K.fx > 0.02) warnings.push(`focal length uncertain: standard deviation ${((100 * std.fx) / K.fx).toFixed(1)} % (add views with stronger, varied tilts)`);
  const rmsPx = Math.sqrt(best.ssr / totalPts);
  if (degeneracy.normalSpreadDeg < 8)
    warnings.push(`all views are tilted alike (board normals within ${degeneracy.normalSpreadDeg.toFixed(1)} degrees): the focal length rests on the square-pixel, centred-principal-point assumptions`);
  if (rmsPx > 1) warnings.push(`reprojection RMS ${rmsPx.toFixed(2)} px is high (blur, a wrong marker, or a lens model too simple)`);
  return {
    ok: true,
    method: "zhang",
    assumed: false,
    intrinsics: K,
    model: { aspect, principalPoint: pp, distortion: best.dist },
    rmsPx,
    perViewRmsPx,
    poses,
    std,
    closedFormFocalPx: f0,
    closedFormGeneral: closedFormGeneral(views, width, height),
    degeneracy,
    iterations: best.iterations,
    warnings,
  };
}
