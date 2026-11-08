// Multi-view geometry for the EXPERIMENTAL board-free structure from motion (sfm/), written here because the bundled
// OpenCV.js lacks findFundamentalMat, findEssentialMat, recoverPose and triangulatePoints:
//   * camera model (shared focal length, principal point at the picture centre, radial k1/k2 as everywhere in
//     experimental/: x_d = x (1 + k1 r^2 + k2 r^4) on normalised coordinates);
//   * normalised 8-point fundamental matrix + RANSAC (Sampson distance), Bougnoux's focal length from F;
//   * homography DLT + RANSAC, its decomposition into (R, t, n) (Ma, Soatto, Kosecka and Sastry, ch. 5.3), used when the
//     matched points lie on one plane (the table with the hand excluded): F is then not determined by the points;
//   * the essential matrix's four poses with the cheirality test; linear triangulation;
//   * P3P (Grunert's quartic) in RANSAC, then Gauss-Newton refinement of the pose (PnP).
import type { CameraPose } from "../common";
import { rigidAlign } from "../reconstruction/linalg";
import { expSO3, m3det, m3mul, m3T, m3tv, m3v, nearestRot, nullVector, polyRealRoots, svd3, vcross, vdot, vnorm, vscale, vsub, vunit, type M3, type V3 } from "./mat";

export interface Cam {
  f: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
}

/** Pixel -> undistorted normalised coordinates. */
export function undistort(cam: Cam, u: number, v: number): [number, number] {
  const xd = (u - cam.cx) / cam.f, yd = (v - cam.cy) / cam.f;
  if (!cam.k1 && !cam.k2) return [xd, yd];
  let x = xd, y = yd;
  for (let i = 0; i < 20; i++) {
    const r2 = x * x + y * y;
    const d = 1 + cam.k1 * r2 + cam.k2 * r2 * r2;
    const nx = xd / d, ny = yd / d;
    const done = Math.abs(nx - x) + Math.abs(ny - y) < 1e-12;
    x = nx;
    y = ny;
    if (done) break;
  }
  return [x, y];
}

/** World point -> pixel (null behind the camera). */
export function projectPx(cam: Cam, R: readonly number[], t: ArrayLike<number>, X: ArrayLike<number>): [number, number] | null {
  const xc = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
  const yc = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
  const zc = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
  if (zc <= 1e-9) return null;
  const x = xc / zc, y = yc / zc, r2 = x * x + y * y;
  const d = 1 + cam.k1 * r2 + cam.k2 * r2 * r2;
  return [cam.f * d * x + cam.cx, cam.f * d * y + cam.cy];
}

type P2 = [number, number];

function normalisation(pts: readonly P2[]): { T: M3; out: P2[] } {
  let mx = 0, my = 0;
  for (const p of pts) ((mx += p[0]), (my += p[1]));
  mx /= pts.length;
  my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
  const s = Math.SQRT2 / (d / pts.length || 1);
  return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1], out: pts.map((p) => [s * (p[0] - mx), s * (p[1] - my)] as P2) };
}

/** Normalised 8-point fundamental matrix (rank 2): x2^T F x1 = 0. */
export function fundamental8(a: readonly P2[], b: readonly P2[]): M3 | null {
  if (a.length < 8) return null;
  const na = normalisation(a), nb = normalisation(b);
  const A: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const [x1, y1] = na.out[i], [x2, y2] = nb.out[i];
    A.push(x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, 1);
  }
  const f = nullVector(A, a.length, 9);
  const { U, s, V } = svd3(f);
  const F0 = m3mul(m3mul(U, [s[0], 0, 0, 0, s[1], 0, 0, 0, 0]), m3T(V));
  const F = m3mul(m3mul(m3T(nb.T), F0), na.T);
  const n = Math.hypot(...F) || 1;
  return F.map((v) => v / n);
}

/** Squared Sampson distance of a correspondence to F. */
export function sampson2(F: readonly number[], p: P2, q: P2): number {
  const Fx = [F[0] * p[0] + F[1] * p[1] + F[2], F[3] * p[0] + F[4] * p[1] + F[5], F[6] * p[0] + F[7] * p[1] + F[8]];
  const Ftx = [F[0] * q[0] + F[3] * q[1] + F[6], F[1] * q[0] + F[4] * q[1] + F[7]];
  const e = q[0] * Fx[0] + q[1] * Fx[1] + Fx[2];
  const den = Fx[0] * Fx[0] + Fx[1] * Fx[1] + Ftx[0] * Ftx[0] + Ftx[1] * Ftx[1];
  return den > 0 ? (e * e) / den : Infinity;
}

/** Homography by normalised DLT: x2 ~ H x1. */
export function homographyDLT(a: readonly P2[], b: readonly P2[]): M3 | null {
  if (a.length < 4) return null;
  const na = normalisation(a), nb = normalisation(b);
  const A: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const [x, y] = na.out[i], [u, v] = nb.out[i];
    A.push(-x, -y, -1, 0, 0, 0, u * x, u * y, u);
    A.push(0, 0, 0, -x, -y, -1, v * x, v * y, v);
  }
  const h = nullVector(A, 2 * a.length, 9);
  // H = Tb^-1 h Ta
  const s = nb.T[0], tx = nb.T[2], ty = nb.T[5];
  const TbInv = [1 / s, 0, -tx / s, 0, 1 / s, -ty / s, 0, 0, 1];
  const H = m3mul(m3mul(TbInv, h), na.T);
  if (!H.every(Number.isFinite)) return null;
  return H;
}

export function homographyError2(H: readonly number[], p: P2, q: P2): number {
  const z = H[6] * p[0] + H[7] * p[1] + H[8];
  if (Math.abs(z) < 1e-12) return Infinity;
  const u = (H[0] * p[0] + H[1] * p[1] + H[2]) / z, v = (H[3] * p[0] + H[4] * p[1] + H[5]) / z;
  return (u - q[0]) ** 2 + (v - q[1]) ** 2;
}

function sample(n: number, k: number, rng: () => number): number[] {
  const s = new Set<number>();
  while (s.size < k) s.add(Math.floor(rng() * n));
  return [...s];
}

export interface RansacModel {
  M: M3;
  inliers: number[];
}

/** RANSAC for F (thresholdPx: Sampson distance in the units of the points). */
export function ransacFundamental(a: readonly P2[], b: readonly P2[], threshold: number, rng: () => number, iterations = 1500): RansacModel | null {
  if (a.length < 12) return null;
  let best: number[] = [];
  const t2 = threshold * threshold;
  for (let it = 0; it < iterations; it++) {
    const idx = sample(a.length, 8, rng);
    const F = fundamental8(idx.map((i) => a[i]), idx.map((i) => b[i]));
    if (!F) continue;
    const inl: number[] = [];
    for (let i = 0; i < a.length; i++) if (sampson2(F, a[i], b[i]) < t2) inl.push(i);
    if (inl.length > best.length) best = inl;
  }
  if (best.length < 8) return null;
  for (let r = 0; r < 2; r++) {
    const F = fundamental8(best.map((i) => a[i]), best.map((i) => b[i]));
    if (!F) break;
    const inl: number[] = [];
    for (let i = 0; i < a.length; i++) if (sampson2(F, a[i], b[i]) < t2) inl.push(i);
    if (inl.length < best.length) return { M: F, inliers: best };
    best = inl;
  }
  const F = fundamental8(best.map((i) => a[i]), best.map((i) => b[i]));
  return F ? { M: F, inliers: best } : null;
}

export function ransacHomography(a: readonly P2[], b: readonly P2[], threshold: number, rng: () => number, iterations = 1000): RansacModel | null {
  if (a.length < 8) return null;
  let best: number[] = [];
  const t2 = threshold * threshold;
  for (let it = 0; it < iterations; it++) {
    const idx = sample(a.length, 4, rng);
    const H = homographyDLT(idx.map((i) => a[i]), idx.map((i) => b[i]));
    if (!H) continue;
    const inl: number[] = [];
    for (let i = 0; i < a.length; i++) if (homographyError2(H, a[i], b[i]) < t2) inl.push(i);
    if (inl.length > best.length) best = inl;
  }
  if (best.length < 4) return null;
  for (let r = 0; r < 2; r++) {
    const H = homographyDLT(best.map((i) => a[i]), best.map((i) => b[i]));
    if (!H) break;
    const inl: number[] = [];
    for (let i = 0; i < a.length; i++) if (homographyError2(H, a[i], b[i]) < t2) inl.push(i);
    if (inl.length < best.length) break;
    best = inl;
  }
  const H = homographyDLT(best.map((i) => a[i]), best.map((i) => b[i]));
  return H ? { M: H, inliers: best } : null;
}

/** Bougnoux's focal length from a fundamental matrix in PIXEL coordinates with the principal point (cx, cy) of both
 *  views; null when f^2 comes out negative (it often does: the formula is unstable, and undefined for planar scenes). */
export function bougnouxFocal(F: readonly number[], cx: number, cy: number): number | null {
  // shift to the principal point: F' = T^T F T with T = translation by (cx, cy)
  const T = [1, 0, cx, 0, 1, cy, 0, 0, 1];
  const Fp = m3mul(m3mul(m3T(T), F), T);
  // epipoles: F' e1 = 0, F'^T e2 = 0
  const { U, V } = svd3(Fp);
  const e1: V3 = [V[2], V[5], V[8]], e2: V3 = [U[2], U[5], U[8]];
  const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 0];
  const p: V3 = [0, 0, 1];
  // f^2 = - (p2^T [e2]x I3 F p1)(p1^T F^T p2) / (p2^T [e2]x I3 F I3 F^T p2)
  const ex = (e: V3): M3 => [0, -e[2], e[1], e[2], 0, -e[0], -e[1], e[0], 0];
  const num = vdot(p, m3v(m3mul(m3mul(ex(e2), I3), Fp), p)) * vdot(p, m3tv(Fp, p));
  const den = vdot(p, m3v(m3mul(m3mul(m3mul(m3mul(ex(e2), I3), Fp), I3), m3T(Fp)), p));
  void e1;
  const f2 = -num / den;
  return f2 > 0 && Number.isFinite(f2) ? Math.sqrt(f2) : null;
}

/** Essential matrix nearest to E (singular values 1, 1, 0). */
export function projectEssential(E: readonly number[]): M3 {
  const { U, V } = svd3(E);
  return m3mul(m3mul(U, [1, 0, 0, 0, 1, 0, 0, 0, 0]), m3T(V));
}

/** Linear triangulation from several views (normalised coordinates, poses Xc = R X + t). */
export function triangulate(obs: readonly { R: readonly number[]; t: ArrayLike<number>; x: number; y: number }[]): V3 | null {
  if (obs.length < 2) return null;
  const A: number[] = [];
  for (const o of obs) {
    const R = o.R, t = o.t;
    // x (r3 X + t3) - (r1 X + t1) = 0 ; y (r3 X + t3) - (r2 X + t2) = 0
    A.push(o.x * R[6] - R[0], o.x * R[7] - R[1], o.x * R[8] - R[2], o.x * t[2] - t[0]);
    A.push(o.y * R[6] - R[3], o.y * R[7] - R[4], o.y * R[8] - R[5], o.y * t[2] - t[1]);
  }
  // scale rows for conditioning
  const v = nullVector(A, obs.length * 2, 4);
  if (Math.abs(v[3]) < 1e-12) return null;
  return [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
}

/** The largest angle (degrees) between the viewing rays of a point from the given camera centres. */
export function triangulationAngleDeg(X: ArrayLike<number>, centres: readonly V3[]): number {
  let best = 0;
  for (let i = 0; i < centres.length; i++)
    for (let j = i + 1; j < centres.length; j++) {
      const a = vunit(vsub(centres[i], X)), b = vunit(vsub(centres[j], X));
      best = Math.max(best, Math.acos(Math.max(-1, Math.min(1, vdot(a, b)))));
    }
  return (best * 180) / Math.PI;
}

export const centreOf = (R: readonly number[], t: ArrayLike<number>): V3 => vscale(m3tv(R, t), -1);

/** The pose of view 2 relative to view 1 (view 1 at identity) from an essential matrix: the one of four with the most
 *  points in front of both cameras. */
export function poseFromEssential(E: readonly number[], a: readonly P2[], b: readonly P2[]): { R: M3; t: V3; inFront: number } {
  const { U, V } = svd3(E);
  let Uu = U, Vv = V;
  if (m3det(Uu) < 0) Uu = Uu.map((x, i) => (i % 3 === 2 ? -x : x));
  if (m3det(Vv) < 0) Vv = Vv.map((x, i) => (i % 3 === 2 ? -x : x));
  const W = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const R1 = m3mul(m3mul(Uu, W), m3T(Vv)), R2 = m3mul(m3mul(Uu, m3T(W)), m3T(Vv));
  const u3: V3 = [Uu[2], Uu[5], Uu[8]];
  const cands: { R: M3; t: V3 }[] = [
    { R: R1, t: u3 },
    { R: R1, t: vscale(u3, -1) },
    { R: R2, t: u3 },
    { R: R2, t: vscale(u3, -1) },
  ];
  return bestByCheirality(cands, a, b);
}

function bestByCheirality(cands: readonly { R: M3; t: V3 }[], a: readonly P2[], b: readonly P2[]): { R: M3; t: V3; inFront: number } {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let best = { R: cands[0].R, t: cands[0].t, inFront: -1 };
  for (const c of cands) {
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      const X = triangulate([
        { R: I, t: [0, 0, 0], x: a[i][0], y: a[i][1] },
        { R: c.R, t: c.t, x: b[i][0], y: b[i][1] },
      ]);
      if (!X) continue;
      const z2 = c.R[6] * X[0] + c.R[7] * X[1] + c.R[8] * X[2] + c.t[2];
      if (X[2] > 0 && z2 > 0) n++;
    }
    if (n > best.inFront) best = { R: c.R, t: c.t, inFront: n };
  }
  return best;
}

/** Decompose a homography between NORMALISED coordinates (x2 ~ H x1, H = R + t n^T / d) into its physically possible
 *  solutions (points in front of both cameras), t in units of the plane distance d. Usually two remain. */
export function decomposeHomography(Hin: readonly number[], a: readonly P2[], b: readonly P2[]): { R: M3; t: V3; n: V3; inFront: number }[] {
  // normalise so the middle singular value is 1 and det > 0 orientation is consistent with x2^T H x1 > 0
  const sv = svd3(Hin);
  let H = Hin.map((v) => v / sv.s[1]);
  // sign: x2 . (H x1) must be positive for the points
  let pos = 0;
  for (let i = 0; i < a.length; i++) {
    const hx = m3v(H, [a[i][0], a[i][1], 1]);
    if (hx[0] * b[i][0] + hx[1] * b[i][1] + hx[2] > 0) pos++;
  }
  if (pos < a.length / 2) H = H.map((v) => -v);
  const HtH = m3mul(m3T(H), H);
  const { V, s } = svd3(HtH); // eigen: s = sigma^2
  const s1 = s[0], s3 = s[2];
  const v1: V3 = [V[0], V[3], V[6]], v2: V3 = [V[1], V[4], V[7]], v3: V3 = [V[2], V[5], V[8]];
  if (s1 - s3 < 1e-10) {
    // pure rotation (or no translation): R = H, t = 0
    const R = nearestRot(H);
    return [{ R, t: [0, 0, 0], n: [0, 0, 1], inFront: a.length }];
  }
  const k = 1 / Math.sqrt(s1 - s3);
  const a1 = Math.sqrt(Math.max(0, 1 - s3)), a3 = Math.sqrt(Math.max(0, s1 - 1));
  const u1: V3 = [(a1 * v1[0] + a3 * v3[0]) * k, (a1 * v1[1] + a3 * v3[1]) * k, (a1 * v1[2] + a3 * v3[2]) * k];
  const u2: V3 = [(a1 * v1[0] - a3 * v3[0]) * k, (a1 * v1[1] - a3 * v3[1]) * k, (a1 * v1[2] - a3 * v3[2]) * k];
  const sols: { R: M3; t: V3; n: V3 }[] = [];
  for (const u of [u1, u2]) {
    const U = colMat(v2, u, vcross(v2, u));
    const Hv2 = m3v(H, v2), Hu = m3v(H, u);
    const W = colMat(Hv2, Hu, vcross(Hv2, Hu));
    const R = m3mul(W, m3T(U));
    const n = vcross(v2, u);
    const t = m3v(H.map((x, i) => x - R[i]), n);
    sols.push({ R, t, n });
    sols.push({ R, t: vscale(t, -1), n: vscale(n, -1) });
  }
  // physically possible: the plane in front of camera 1 (n . x1 > 0 for the points, with d > 0)
  const out: { R: M3; t: V3; n: V3; inFront: number }[] = [];
  for (const sol of sols) {
    let n1 = 0;
    for (let i = 0; i < a.length; i++) if (sol.n[0] * a[i][0] + sol.n[1] * a[i][1] + sol.n[2] > 0) n1++;
    if (n1 < 0.9 * a.length) continue;
    // points in front of camera 2 too
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let n2 = 0;
    for (let i = 0; i < a.length; i += Math.max(1, Math.floor(a.length / 200))) {
      const X = triangulate([
        { R: I, t: [0, 0, 0], x: a[i][0], y: a[i][1] },
        { R: sol.R, t: sol.t, x: b[i][0], y: b[i][1] },
      ]);
      if (X && X[2] > 0 && sol.R[6] * X[0] + sol.R[7] * X[1] + sol.R[8] * X[2] + sol.t[2] > 0) n2++;
    }
    out.push({ ...sol, R: nearestRot(sol.R), inFront: n2 });
  }
  out.sort((p, q) => q.inFront - p.inFront);
  return out;
}

const colMat = (a: V3, b: V3, c: V3): M3 => [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];

// ---------------------------------------------------------------------------------------------------------------
// PnP

/** Grunert's P3P: up to four camera poses from three world points and their unit bearing vectors. */
export function p3p(P: readonly V3[], j: readonly V3[]): CameraPose[] {
  const a2 = sq(vsub(P[1], P[2])), b2 = sq(vsub(P[0], P[2])), c2 = sq(vsub(P[0], P[1]));
  if (a2 < 1e-18 || b2 < 1e-18 || c2 < 1e-18) return [];
  const ca = vdot(j[1], j[2]), cb = vdot(j[0], j[2]), cg = vdot(j[0], j[1]);
  const amc = (a2 - c2) / b2, apc = (a2 + c2) / b2, bmc = (b2 - c2) / b2, bma = (b2 - a2) / b2;
  const A4 = (amc - 1) ** 2 - (4 * c2 / b2) * ca * ca;
  const A3 = 4 * (amc * (1 - amc) * cb - (1 - apc) * ca * cg + 2 * (c2 / b2) * ca * ca * cb);
  const A2 = 2 * (amc * amc - 1 + 2 * amc * amc * cb * cb + 2 * bmc * ca * ca - 4 * apc * ca * cb * cg + 2 * bma * cg * cg);
  const A1 = 4 * (-amc * (1 + amc) * cb + 2 * (a2 / b2) * cg * cg * cb - (1 - apc) * ca * cg);
  const A0 = (1 + amc) ** 2 - (4 * a2 / b2) * cg * cg;
  const out: CameraPose[] = [];
  for (const v of polyRealRoots([A4, A3, A2, A1, A0])) {
    if (!(v > 0)) continue;
    const den = 2 * (cg - v * ca);
    if (Math.abs(den) < 1e-12) continue;
    const u = ((-1 + amc) * v * v - 2 * amc * cb * v + 1 + amc) / den;
    if (!(u > 0)) continue;
    const s1sq = c2 / (1 + u * u - 2 * u * cg);
    if (!(s1sq > 0)) continue;
    const s1 = Math.sqrt(s1sq), s2 = u * s1, s3 = v * s1;
    const Q = [vscale(j[0], s1), vscale(j[1], s2), vscale(j[2], s3)];
    const src = [...P[0], ...P[1], ...P[2]], dst = [...Q[0], ...Q[1], ...Q[2]];
    const al = rigidAlign(src, dst);
    if (!Number.isFinite(al.rms)) continue;
    out.push({ R: al.R, t: al.t });
  }
  return out;
}
const sq = (v: V3) => v[0] * v[0] + v[1] * v[1] + v[2] * v[2];

export interface PnpResult {
  R: M3;
  t: V3;
  inliers: number[];
  rmsNorm: number;
}

/** Robust pose from 3D points and their normalised image coordinates: P3P in RANSAC, then Gauss-Newton on the inliers.
 *  `threshold` in normalised units (pixels / f). */
export function pnpRansac(X: readonly V3[], x: readonly P2[], threshold: number, rng: () => number, iterations = 400): PnpResult | null {
  const n = X.length;
  if (n < 6) return null;
  const bear = x.map((p) => vunit([p[0], p[1], 1]));
  const t2 = threshold * threshold;
  const count = (R: readonly number[], t: ArrayLike<number>) => {
    const inl: number[] = [];
    for (let i = 0; i < n; i++) {
      const P = X[i];
      const z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2];
      if (z <= 0) continue;
      const u = (R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0]) / z - x[i][0];
      const v = (R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1]) / z - x[i][1];
      if (u * u + v * v < t2) inl.push(i);
    }
    return inl;
  };
  let best: { R: M3; t: V3; inl: number[] } | null = null;
  for (let it = 0; it < iterations; it++) {
    const idx = sample(n, 3, rng);
    for (const pose of p3p(idx.map((i) => X[i]), idx.map((i) => bear[i]))) {
      const inl = count(pose.R, pose.t);
      if (!best || inl.length > best.inl.length) best = { R: [...pose.R], t: [pose.t[0], pose.t[1], pose.t[2]], inl };
    }
    if (best && best.inl.length > 0.8 * n && it > 50) break;
  }
  if (!best || best.inl.length < 6) return null;
  let { R, t } = best;
  let inl = best.inl;
  for (let round = 0; round < 3; round++) {
    const r = refinePose(R, t, inl.map((i) => X[i]), inl.map((i) => x[i]));
    R = r.R;
    t = r.t;
    inl = count(R, t);
    if (inl.length < 6) return null;
  }
  const fin = refinePose(R, t, inl.map((i) => X[i]), inl.map((i) => x[i]));
  return { R: fin.R, t: fin.t, inliers: count(fin.R, fin.t), rmsNorm: fin.rms };
}

/** Gauss-Newton (with a little damping) on a pose: normalised reprojection residuals. */
export function refinePose(R0: readonly number[], t0: ArrayLike<number>, X: readonly V3[], x: readonly P2[], iterations = 10): { R: M3; t: V3; rms: number } {
  let R = [...R0], t: V3 = [t0[0], t0[1], t0[2]];
  let rms = Infinity;
  for (let it = 0; it < iterations; it++) {
    const JtJ = new Array<number>(36).fill(0), Jtr = new Array<number>(6).fill(0);
    let se = 0;
    for (let i = 0; i < X.length; i++) {
      const RX = m3v(R, X[i]);
      const Xc: V3 = [RX[0] + t[0], RX[1] + t[1], RX[2] + t[2]];
      if (Xc[2] <= 1e-9) continue;
      const iz = 1 / Xc[2];
      const u = Xc[0] * iz, v = Xc[1] * iz;
      const ru = u - x[i][0], rv = v - x[i][1];
      se += ru * ru + rv * rv;
      // d(u,v)/dXc
      const du = [iz, 0, -u * iz], dv = [0, iz, -v * iz];
      // dXc/dw = -[RX]x ; dXc/dt = I
      const S = [0, RX[2], -RX[1], -RX[2], 0, RX[0], RX[1], -RX[0], 0]; // -[RX]x
      const Ju = [du[0] * S[0] + du[1] * S[3] + du[2] * S[6], du[0] * S[1] + du[1] * S[4] + du[2] * S[7], du[0] * S[2] + du[1] * S[5] + du[2] * S[8], du[0], du[1], du[2]];
      const Jv = [dv[0] * S[0] + dv[1] * S[3] + dv[2] * S[6], dv[0] * S[1] + dv[1] * S[4] + dv[2] * S[7], dv[0] * S[2] + dv[1] * S[5] + dv[2] * S[8], dv[0], dv[1], dv[2]];
      for (let a = 0; a < 6; a++) {
        Jtr[a] += Ju[a] * ru + Jv[a] * rv;
        for (let b = 0; b < 6; b++) JtJ[a * 6 + b] += Ju[a] * Ju[b] + Jv[a] * Jv[b];
      }
    }
    rms = Math.sqrt(se / Math.max(1, X.length));
    for (let a = 0; a < 6; a++) JtJ[a * 7] *= 1.0001;
    const d = solveSmall(JtJ, Jtr.map((v) => -v), 6);
    if (!d) break;
    R = m3mul(expSO3([d[0], d[1], d[2]]), R);
    t = [t[0] + d[3], t[1] + d[4], t[2] + d[5]];
    if (Math.hypot(...d) < 1e-12) break;
  }
  return { R: nearestRot(R), t, rms };
}

/** Gaussian elimination with partial pivoting (small dense systems). */
export function solveSmall(A: readonly number[], b: readonly number[], n: number): number[] | null {
  const M = A.slice(), y = b.slice();
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (Math.abs(M[p * n + c]) < 1e-300) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]];
      [y[c], y[p]] = [y[p], y[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      y[r] -= f * y[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = y[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x.every(Number.isFinite) ? x : null;
}

export { vnorm };
