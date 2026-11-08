// From the up-to-scale structure from motion to a metric TABLE frame (EXPERIMENTAL, sfm/):
//   * the table plane: RANSAC plane through the triangulated points (the hand was excluded from the features, the coin
//     is 1.5 mm proud of the table: both negligible or absent), refined by least squares on the inliers;
//   * the metric scale from the coin: mm per scene unit = D / (2 r), r the coin's fitted 3D radius (coin/sceneScale.ts,
//     post-hoc on the SfM poses, or jointly inside the bundle adjustment: bundle.ts);
//   * the in-plane axes from the hand's landmarks triangulated with the SfM poses: origin at the wrist, +x toward the
//     middle-finger knuckle, so the frame matches the board frame's convention (multiview/scene.ts: wrist at (25, 122),
//     fingers toward +x, table z = 0, +z toward the cameras) and the carving of multiview/reconstruct.ts can take it.
// Also the evaluation helpers (similarity / rigid alignment to the truth, per-view errors). SIMULATED use only.
import type { CameraPose, Intrinsics, Pt } from "../common";
import { rigidAlign, symmetricEigen } from "../reconstruction/linalg";
import { makeRng } from "../reconstruction/rng";
import type { BACamera } from "./bundle";
import { centreOf, triangulate, undistort, type Cam } from "./geometry";
import { m3mul, m3T, m3v, rotDiffDeg, vcross, vdot, vnorm, vscale, vsub, vunit, type M3, type V3 } from "./mat";

export interface Plane {
  /** Unit normal and offset: n . X = d. */
  n: V3;
  d: number;
  inliers: number;
  rms: number;
}

/** RANSAC plane through points; `tol` in the points' units. */
export function fitPlaneRansac(P: readonly V3[], tol: number, seed = 1, iterations = 400): Plane | null {
  if (P.length < 3) return null;
  const rng = makeRng(seed);
  let best: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const a = P[Math.floor(rng() * P.length)], b = P[Math.floor(rng() * P.length)], c = P[Math.floor(rng() * P.length)];
    const n = vcross(vsub(b, a), vsub(c, a));
    if (vnorm(n) < 1e-12) continue;
    const u = vunit(n), d = vdot(u, a);
    const inl: number[] = [];
    for (let i = 0; i < P.length; i++) if (Math.abs(vdot(u, P[i]) - d) < tol) inl.push(i);
    if (inl.length > best.length) best = inl;
  }
  if (best.length < 3) return null;
  let pl = planeLsq(best.map((i) => P[i]));
  for (let r = 0; r < 2; r++) {
    const inl = P.filter((p) => Math.abs(vdot(pl.n, p) - pl.d) < tol);
    if (inl.length < 3) break;
    pl = planeLsq(inl);
  }
  return pl;
}

function planeLsq(P: readonly V3[]): Plane {
  const c: V3 = [0, 0, 0];
  for (const p of P) ((c[0] += p[0]), (c[1] += p[1]), (c[2] += p[2]));
  c[0] /= P.length; c[1] /= P.length; c[2] /= P.length; // fmt: skip
  const M = new Array<number>(9).fill(0);
  for (const p of P) {
    const q = vsub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i * 3 + j] += q[i] * q[j];
  }
  const e = symmetricEigen(M, 3);
  const n = vunit(e.vectors[2] as unknown as V3);
  const d = vdot(n, c);
  let se = 0;
  for (const p of P) se += (vdot(n, p) - d) ** 2;
  return { n, d, inliers: P.length, rms: Math.sqrt(se / P.length) };
}

/** Similarity X_true = s R X_est + t from point pairs (Umeyama via rigidAlign after scaling). */
export function similarityAlign(est: readonly V3[], truth: readonly V3[]): { s: number; R: M3; t: V3; rms: number } {
  const ce = mean(est), ct = mean(truth);
  let se = 0, st = 0;
  for (let i = 0; i < est.length; i++) {
    se += vnorm(vsub(est[i], ce)) ** 2;
    st += vnorm(vsub(truth[i], ct)) ** 2;
  }
  const s = Math.sqrt(st / se);
  const src = est.flatMap((p) => [p[0] * s, p[1] * s, p[2] * s]), dst = truth.flatMap((p) => [...p]);
  const al = rigidAlign(src, dst);
  return { s, R: [...al.R], t: [al.t[0], al.t[1], al.t[2]], rms: al.rms };
}

const mean = (P: readonly V3[]): V3 => {
  const c: V3 = [0, 0, 0];
  for (const p of P) ((c[0] += p[0]), (c[1] += p[1]), (c[2] += p[2]));
  return [c[0] / P.length, c[1] / P.length, c[2] / P.length];
};

/** Triangulate image points (distorted pixels, one per view or null) with the SfM poses; null if seen in < 2 views. */
export function triangulatePixels(cam: Cam, poses: readonly (BACamera | null)[], px: readonly (Pt | null)[]): V3 | null {
  const o: { R: readonly number[]; t: V3; x: number; y: number }[] = [];
  px.forEach((p, i) => {
    const q = poses[i];
    if (!p || !q) return;
    const [x, y] = undistort(cam, p.x, p.y);
    o.push({ R: q.R, t: q.t, x, y });
  });
  return o.length >= 2 ? triangulate(o) : null;
}

export interface TableFrame {
  /** Rows: table x, y, z axes in SfM coordinates. */
  Rf: M3;
  /** SfM-frame origin point and the table-frame offset added after scaling (mm). */
  origin: V3;
  offset: V3;
  /** Millimetres per SfM unit. */
  mmPerUnit: number;
  plane: Plane;
}

/** Build the metric table frame: plane normal (+z toward the cameras), coin scale, in-plane axes from two points on the
 *  hand (e.g. the wrist and middle-knuckle landmarks); `placeOrigin` is where the first point lands (default (25, 122)). */
export function makeTableFrame(plane: Plane, mmPerUnit: number, cameraCentres: readonly V3[], a: V3, b: V3, placeOrigin: [number, number] = [25, 122]): TableFrame {
  let n = plane.n;
  const above = cameraCentres.reduce((s, C) => s + (vdot(n, C) - plane.d), 0);
  let d = plane.d;
  if (above < 0) ((n = vscale(n, -1) as V3), (d = -d));
  const proj = (p: V3): V3 => vsub(p, vscale(n, vdot(n, p) - d));
  const o = proj(a);
  const x = vunit(vsub(proj(b), o));
  const y = vcross(n, x);
  return { Rf: [...x, ...y, ...n], origin: o, offset: [placeOrigin[0], placeOrigin[1], 0], mmPerUnit, plane: { ...plane, n, d } };
}

export function toTable(f: TableFrame, X: V3): V3 {
  const q = m3v(f.Rf, vsub(X, f.origin));
  return [q[0] * f.mmPerUnit + f.offset[0], q[1] * f.mmPerUnit + f.offset[1], q[2] * f.mmPerUnit + f.offset[2]];
}

/** An SfM pose expressed in the metric table frame (world-to-camera, millimetres). */
export function poseToTable(f: TableFrame, p: BACamera): CameraPose {
  const R = m3mul(p.R, m3T(f.Rf));
  const RO = m3v(p.R, f.origin);
  const Roff = m3v(R, f.offset);
  return { R, t: [f.mmPerUnit * (RO[0] + p.t[0]) - Roff[0], f.mmPerUnit * (RO[1] + p.t[1]) - Roff[1], f.mmPerUnit * (RO[2] + p.t[2]) - Roff[2]] };
}

/** Intrinsics in the experimental/ format from the SfM camera. */
export function camToIntrinsics(c: Cam, width: number, height: number): Intrinsics {
  return { fx: c.f, fy: c.f, cx: c.cx, cy: c.cy, width, height, k1: c.k1, k2: c.k2 };
}

export interface PoseErrors {
  rotDeg: number[];
  centreMm: number[];
  maxRotDeg: number;
  meanRotDeg: number;
  maxCentreMm: number;
  meanCentreMm: number;
}

/** Per-view errors of estimated poses against true ones after aligning the estimate with `align` (a similarity
 *  X_true = s R X_est + t). */
export function poseErrors(est: readonly (CameraPose | null)[], truth: readonly CameraPose[], align: { s: number; R: M3; t: V3 }): PoseErrors {
  const rot: number[] = [], cen: number[] = [];
  est.forEach((p, i) => {
    if (!p) return;
    const Ra = m3mul([...p.R], m3T(align.R));
    rot.push(rotDiffDeg(Ra, [...truth[i].R]));
    const C = centreOf(p.R, p.t);
    const Ca = m3v(align.R, vscale(C, align.s));
    const Ct = centreOf(truth[i].R, truth[i].t);
    cen.push(vnorm(vsub([Ca[0] + align.t[0], Ca[1] + align.t[1], Ca[2] + align.t[2]], Ct)));
  });
  const mx = (a: number[]) => (a.length ? Math.max(...a) : NaN), mn = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  return { rotDeg: rot, centreMm: cen, maxRotDeg: mx(rot), meanRotDeg: mn(rot), maxCentreMm: mx(cen), meanCentreMm: mn(cen) };
}

/** Rigid alignment (no scale) of estimated camera centres to the true ones. */
export function rigidOnly(est: readonly V3[], truth: readonly V3[]): { s: number; R: M3; t: V3; rms: number } {
  const al = rigidAlign(est.flatMap((p) => [...p]), truth.flatMap((p) => [...p]));
  return { s: 1, R: [...al.R], t: [al.t[0], al.t[1], al.t[2]], rms: al.rms };
}
