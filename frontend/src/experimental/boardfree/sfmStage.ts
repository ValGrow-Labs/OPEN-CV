// Board-free camera geometry for the reconstruction chain (EXPERIMENTAL): the stage-3 structure from motion
// (sfm/sfm.ts runSfm, coin fitted jointly in the bundle adjustment) driven from the chain's frames, with the hand left
// out of the features by a region built from the landmark detector (never from a true mask), and the uncertainty
// figures stage 5 needs (reprojection residual statistics, conditional pose and intrinsics standard deviations, the coin
// fit's residuals and its relative scale uncertainty components).
//
// SIMULATED evaluation only; never run on a real capture.
import type { Pt } from "../common";
import { fitCoinCircle3D } from "../coin/sceneScale";
import type { BACamera } from "../sfm/bundle";
import { projectPx, undistort, type Cam } from "../sfm/geometry";
import { runSfm, type SfmOptions, type SfmResult, type SfmView } from "../sfm/sfm";
import type { BoardFreeFrame } from "./types";

/** Pixels where hand features must not be used: the landmarks' convex hull grown by a quarter of its diagonal, and a
 *  strip from the wrist away from the fingers (the forearm) to the picture border. Null without landmarks. */
export function handExclusionMask(width: number, height: number, landmarks: readonly (Pt | null)[] | null | undefined, grow = 0.25): Uint8Array | null {
  if (!landmarks) return null;
  const pts = landmarks.filter((p): p is Pt => !!p);
  if (pts.length < 5) return null;
  const hull = convexHull(pts);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) ((x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y)));
  const r = grow * Math.hypot(x1 - x0, y1 - y0) + 8;
  const out = new Uint8Array(width * height);
  const w0 = landmarks[0], m9 = landmarks[9];
  let fa: { a: Pt; b: Pt; r: number } | null = null;
  if (w0 && m9) {
    const dx = w0.x - m9.x, dy = w0.y - m9.y, l = Math.hypot(dx, dy) || 1;
    const L = 4 * (width + height);
    fa = { a: w0, b: { x: w0.x + (dx / l) * L, y: w0.y + (dy / l) * L }, r: Math.max(r * 0.8, 0.6 * l) };
  }
  const bx0 = Math.max(0, Math.floor(x0 - r)), bx1 = Math.min(width - 1, Math.ceil(x1 + r));
  const by0 = Math.max(0, Math.floor(y0 - r)), by1 = Math.min(height - 1, Math.ceil(y1 + r));
  for (let y = by0; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++) if (distToPolygon(hull, x + 0.5, y + 0.5) <= r) out[y * width + x] = 255;
  if (fa)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) if (!out[y * width + x] && distToSegment(fa.a, fa.b, x + 0.5, y + 0.5) <= fa.r) out[y * width + x] = 255;
  return out;
}

export function convexHull(pts: readonly Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Pt[] = [], up: Pt[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Distance from (x, y) to a convex polygon (0 inside). */
export function distToPolygon(poly: readonly Pt[], x: number, y: number): number {
  if (poly.length === 0) return Infinity;
  if (poly.length < 3) return Math.min(...poly.map((p, i) => distToSegment(p, poly[(i + 1) % poly.length], x, y)));
  let inside = true, d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) inside = false;
    d = Math.min(d, distToSegment(a, b, x, y));
  }
  return inside ? 0 : d;
}

export function distToSegment(a: Pt, b: Pt, x: number, y: number): number {
  const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / l2)) : 0;
  return Math.hypot(x - a.x - t * vx, y - a.y - t * vy);
}

export interface SfmStageOptions {
  coinDiameterMm: number;
  /** ASSUMED coin thickness (mm) for the cylinder outline model; the Rs 2 coin's thickness is UNVERIFIED. */
  coinThicknessMm: number;
  /** Allowances for the scale uncertainty components (mm): diameter (config +-0.1) and thickness (assumed +-0.5). */
  coinDiameterAllowanceMm?: number;
  coinThicknessAllowanceMm?: number;
  /** Sweep frames are matched when their guide directions are this close (degrees); default 16.5 (2.2 x 7.5). */
  pairWindowDeg?: number;
  sfm?: SfmOptions;
}

export interface SfmUncertainty {
  /** Feature reprojection residuals after the final bundle adjustment (pixels). */
  featureRmsPx: number;
  featureMedianPx: number;
  featureP95Px: number;
  observations: number;
  points: number;
  /** Per frame (null when not registered): RMS residual (px), observations, and the CONDITIONAL one-sigma rotation (deg)
   *  and centre (mm, using the coin scale) of the frame's pose with the points and intrinsics held fixed (a lower
   *  bound: it ignores the points' own uncertainty and the gauge). */
  perFrame: ({ rmsPx: number; observations: number; rotSigmaDeg: number; centreSigmaMm: number } | null)[];
  /** Conditional one-sigma of the focal length (relative) and k1 with the poses and points held fixed (lower bounds). */
  focalRelSigma: number;
  k1Sigma: number;
  /** Coin: joint fit residual RMS (px), frames that saw it whole, the post-hoc fit on the final poses (radius relative
   *  to the joint radius: a model-consistency indicator), and the relative scale standard uncertainty components
   *  (fit scatter, the reference diameter allowance, the ASSUMED thickness allowance) as coin/sceneScale.ts states them. */
  coin: {
    jointRmsPx: number;
    frames: number;
    postHocRadiusRelDiff: number | null;
    perFrameRmsPx: number[];
    scaleComponents: { key: string; rel: number; rule: string }[];
    scaleRelSigma: number | null;
  } | null;
}

export interface SfmStageResult {
  sfm: SfmResult;
  uncertainty: SfmUncertainty | null;
  /** Millimetres per SfM unit from the joint coin fit (null without it). */
  mmPerUnit: number | null;
  excludeShare: number[];
  ms: number;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function runSfmStage(frames: readonly BoardFreeFrame[], o: SfmStageOptions): SfmStageResult {
  const t0 = now();
  const { width: W, height: H } = frames[0].image;
  const excl = frames.map((f) => handExclusionMask(W, H, f.landmarks));
  const views: SfmView[] = frames.map((f, i) => ({
    id: f.id,
    image: f.image,
    exclude: excl[i],
    elevationDeg: f.elevationDeg,
    azimuthDeg: f.azimuthDeg ?? null,
    coinEdges: f.coinEdges ?? null,
  }));
  const sfm = runSfm(views, {
    coinDiameterMm: o.coinDiameterMm,
    coinThicknessMm: o.coinThicknessMm,
    pairWindowDeg: o.pairWindowDeg ?? 16.5,
    detect: { upright: true },
    ...(o.sfm ?? {}),
  });
  const excludeShare = excl.map((m) => (m ? m.reduce((s, v) => s + (v ? 1 : 0), 0) / m.length : 0));
  const mmPerUnit = sfm.ok && sfm.coinJoint ? o.coinDiameterMm / (2 * sfm.coinJoint.circle.radius) : null;
  const uncertainty = sfm.ok ? sfmUncertainty(sfm, frames, o, mmPerUnit) : null;
  return { sfm, uncertainty, mmPerUnit, excludeShare, ms: now() - t0 };
}

/** Residual statistics and conditional (lower-bound) standard deviations from the final SfM state. */
export function sfmUncertainty(sfm: SfmResult, frames: readonly BoardFreeFrame[], o: SfmStageOptions, mmPerUnit: number | null): SfmUncertainty {
  const cam = sfm.cam;
  const res: number[] = [];
  const perObs: { view: number; X: readonly number[]; u: number; v: number }[][] = sfm.poses.map(() => []);
  for (const p of sfm.points)
    for (const ob of p.obs) {
      const q = sfm.poses[ob.view];
      if (!q) continue;
      const r = projectPx(cam, q.R, q.t, p.X);
      if (!r) continue;
      res.push(Math.hypot(r[0] - ob.u, r[1] - ob.v));
      perObs[ob.view].push({ view: ob.view, X: p.X, u: ob.u, v: ob.v });
    }
  const sorted = [...res].sort((a, b) => a - b);
  const rms = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / Math.max(1, res.length));
  const sigma2 = rms * rms; // per-coordinate variance ~ rms^2 / 2 per axis; rms^2 is conservative
  const perFrame = sfm.poses.map((q, i) => (q ? framePoseSigma(cam, q, perObs[i], sigma2 / 2, mmPerUnit) : null));
  const intr = intrinsicsSigma(cam, sfm.poses, perObs, sigma2 / 2);
  let coin: SfmUncertainty["coin"] = null;
  if (sfm.coinJoint) {
    const cv = frames.map((f, i) => ({ i, pts: f.coinEdges })).filter((v) => v.pts && v.pts.length >= 12 && sfm.poses[v.i]);
    const und = (pts: readonly Pt[]) =>
      pts.map((p) => {
        const [x, y] = undistort(cam, p.x, p.y);
        return { x: cam.f * x + cam.cx, y: cam.f * y + cam.cy };
      });
    const fit = fitCoinCircle3D(
      cv.map((v) => ({ K: { fx: cam.f, fy: cam.f, cx: cam.cx, cy: cam.cy }, pose: { R: sfm.poses[v.i]!.R, t: sfm.poses[v.i]!.t }, points: und(v.pts!) })),
      { diameterMm: o.coinDiameterMm, diameterAllowanceMm: o.coinDiameterAllowanceMm ?? 0.1, thicknessMm: o.coinThicknessMm, thicknessAllowanceMm: o.coinThicknessAllowanceMm ?? 0.5, model: "cylinder" },
    );
    coin = {
      jointRmsPx: sfm.coinJoint.rmsPx,
      frames: sfm.coinJoint.views,
      postHocRadiusRelDiff: fit.ok && fit.circle ? fit.circle.radius / sfm.coinJoint.circle.radius - 1 : null,
      perFrameRmsPx: fit.circle?.perViewRmsPx ?? [],
      scaleComponents: fit.components ?? [],
      scaleRelSigma: fit.relSigma ?? null,
    };
  }
  return {
    featureRmsPx: rms,
    featureMedianPx: sorted.length ? sorted[sorted.length >> 1] : NaN,
    featureP95Px: sorted.length ? sorted[Math.floor(0.95 * (sorted.length - 1))] : NaN,
    observations: res.length,
    points: sfm.points.length,
    perFrame,
    focalRelSigma: intr.fRel,
    k1Sigma: intr.k1,
    coin,
  };
}

/** Conditional 6-dof pose covariance of one frame (points and intrinsics fixed) by a numeric Jacobian. */
function framePoseSigma(cam: Cam, q: BACamera, obs: readonly { X: readonly number[]; u: number; v: number }[], var1: number, mmPerUnit: number | null): { rmsPx: number; observations: number; rotSigmaDeg: number; centreSigmaMm: number } {
  let se = 0;
  const JtJ = new Array<number>(36).fill(0);
  const eps = 1e-6;
  // centre-parametrised pose: R(w) = exp([w]) R, C = C0 + dc; t = -R C
  const C0 = centre(q);
  const scaleC = Math.max(1e-9, Math.hypot(...C0)) * 1e-6;
  const proj = (dw: number[], dc: number[], X: readonly number[]) => {
    const R = mulExp(dw, q.R);
    const C = [C0[0] + dc[0], C0[1] + dc[1], C0[2] + dc[2]];
    const t = [-(R[0] * C[0] + R[1] * C[1] + R[2] * C[2]), -(R[3] * C[0] + R[4] * C[1] + R[5] * C[2]), -(R[6] * C[0] + R[7] * C[1] + R[8] * C[2])];
    return projectPx(cam, R, t, X);
  };
  for (const ob of obs) {
    const r0 = proj([0, 0, 0], [0, 0, 0], ob.X);
    if (!r0) continue;
    se += (r0[0] - ob.u) ** 2 + (r0[1] - ob.v) ** 2;
    const J: number[][] = [[], []];
    for (let k = 0; k < 6; k++) {
      const dw = [0, 0, 0], dc = [0, 0, 0];
      const h = k < 3 ? eps : scaleC;
      if (k < 3) dw[k] = h;
      else dc[k - 3] = h;
      const r1 = proj(dw, dc, ob.X);
      if (!r1) return { rmsPx: NaN, observations: obs.length, rotSigmaDeg: NaN, centreSigmaMm: NaN };
      J[0].push((r1[0] - r0[0]) / h);
      J[1].push((r1[1] - r0[1]) / h);
    }
    for (const row of J) for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) JtJ[a * 6 + b] += row[a] * row[b];
  }
  const cov = invert(JtJ, 6);
  const rmsPx = Math.sqrt(se / Math.max(1, 2 * obs.length)) * Math.SQRT2;
  if (!cov) return { rmsPx, observations: obs.length, rotSigmaDeg: NaN, centreSigmaMm: NaN };
  const rotSigmaDeg = (Math.sqrt(Math.max(0, (cov[0] + cov[7] + cov[14]) * var1)) * 180) / Math.PI;
  const cs = Math.sqrt(Math.max(0, (cov[21] + cov[28] + cov[35]) * var1));
  return { rmsPx, observations: obs.length, rotSigmaDeg, centreSigmaMm: mmPerUnit ? cs * mmPerUnit : NaN };
}

/** Conditional standard deviations of f (relative) and k1 with every pose and point fixed. */
function intrinsicsSigma(cam: Cam, poses: readonly (BACamera | null)[], perObs: readonly { X: readonly number[]; u: number; v: number }[][], var1: number): { fRel: number; k1: number } {
  const JtJ = [0, 0, 0, 0];
  const hf = cam.f * 1e-6, hk = 1e-6;
  poses.forEach((q, i) => {
    if (!q) return;
    for (const ob of perObs[i]) {
      const r0 = projectPx(cam, q.R, q.t, ob.X);
      const rf = projectPx({ ...cam, f: cam.f + hf }, q.R, q.t, ob.X);
      const rk = projectPx({ ...cam, k1: cam.k1 + hk }, q.R, q.t, ob.X);
      if (!r0 || !rf || !rk) continue;
      for (let a = 0; a < 2; a++) {
        const jf = (rf[a] - r0[a]) / hf, jk = (rk[a] - r0[a]) / hk;
        JtJ[0] += jf * jf;
        JtJ[1] += jf * jk;
        JtJ[2] += jf * jk;
        JtJ[3] += jk * jk;
      }
    }
  });
  const det = JtJ[0] * JtJ[3] - JtJ[1] * JtJ[2];
  if (!(det > 0)) return { fRel: NaN, k1: NaN };
  return { fRel: Math.sqrt((JtJ[3] / det) * var1) / cam.f, k1: Math.sqrt((JtJ[0] / det) * var1) };
}

function centre(q: BACamera): [number, number, number] {
  const { R, t } = q;
  return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
}

function mulExp(w: number[], R: readonly number[]): number[] {
  const th = Math.hypot(w[0], w[1], w[2]);
  const K = [0, -w[2], w[1], w[2], 0, -w[0], -w[1], w[0], 0];
  const a = th > 1e-12 ? Math.sin(th) / th : 1, b = th > 1e-12 ? (1 - Math.cos(th)) / (th * th) : 0.5;
  const E = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const K2 = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) K2[i * 3 + j] += K[i * 3 + k] * K[k * 3 + j];
  for (let i = 0; i < 9; i++) E[i] += a * K[i] + b * K2[i];
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += E[i * 3 + k] * R[k * 3 + j];
  return out;
}

/** Gauss-Jordan inverse of an n x n row-major matrix (null when singular). */
export function invert(A: readonly number[], n: number): number[] | null {
  const M = A.map((v) => v);
  const I = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i++) I[i * n + i] = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (Math.abs(M[p * n + c]) < 1e-300) return null;
    for (let k = 0; k < n; k++) {
      [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]];
      [I[c * n + k], I[p * n + k]] = [I[p * n + k], I[c * n + k]];
    }
    const d = M[c * n + c];
    for (let k = 0; k < n; k++) ((M[c * n + k] /= d), (I[c * n + k] /= d));
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r * n + c];
      if (!f) continue;
      for (let k = 0; k < n; k++) ((M[r * n + k] -= f * M[c * n + k]), (I[r * n + k] -= f * I[c * n + k]));
    }
  }
  return I;
}
