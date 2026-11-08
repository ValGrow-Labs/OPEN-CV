// Ellipse and conic maths for the EXPERIMENTAL coin study: ellipse <-> conic matrix, a robust geometric ellipse fit,
// the two 3D circle poses that explain one image ellipse (known intrinsics), and the image conic of a 3D circle.
//
// Conventions: pixels x right, y down. An ellipse is { cx, cy, major, minor, angleDeg } with FULL axis lengths and the
// major axis at `angleDeg` from +x toward +y (image coordinates, 0 to 180). A conic is a symmetric 3x3 matrix Q (row-major,
// 9 numbers) with x^T Q x = 0 for homogeneous points on the curve. Camera frame as ../common.ts (OpenCV: z forward).
//
// EXPERIMENTAL; pure maths, no image access.

import type { Intrinsics, Pt } from "../common";
import { cross, dot, inverse, normalize, type V3 } from "../geometry/linalg";

export interface Ellipse {
  cx: number;
  cy: number;
  major: number;
  minor: number;
  angleDeg: number;
}

export type Conic = number[];

const DEG = Math.PI / 180;
const mod180 = (a: number) => ((a % 180) + 180) % 180;

/** The conic of an ellipse, scaled so that Q(x) = ((x - c) along the axes / semi-axes)^2 summed - 1 (negative inside). */
export function ellipseToConic(e: Ellipse): Conic {
  const a = e.major / 2;
  const b = e.minor / 2;
  const c = Math.cos(e.angleDeg * DEG);
  const s = Math.sin(e.angleDeg * DEG);
  const A = (c * c) / (a * a) + (s * s) / (b * b);
  const B = c * s * (1 / (a * a) - 1 / (b * b));
  const C = (s * s) / (a * a) + (c * c) / (b * b);
  const D = -(A * e.cx + B * e.cy);
  const E = -(B * e.cx + C * e.cy);
  const F = A * e.cx * e.cx + 2 * B * e.cx * e.cy + C * e.cy * e.cy - 1;
  return [A, B, D, B, C, E, D, E, F];
}

/** The ellipse of a conic matrix, or null when the conic is not a real ellipse. */
export function conicToEllipse(Q: readonly number[]): Ellipse | null {
  const A = Q[0], B = 0.5 * (Q[1] + Q[3]), C = Q[4];
  const D = 0.5 * (Q[2] + Q[6]), E = 0.5 * (Q[5] + Q[7]), F = Q[8];
  const det2 = A * C - B * B;
  if (!(Math.abs(det2) > 1e-300)) return null;
  const cx = (B * E - C * D) / det2;
  const cy = (B * D - A * E) / det2;
  const f0 = F + D * cx + E * cy; // value at the centre
  if (!(Math.abs(f0) > 1e-300)) return null;
  const a2 = A / -f0, b2 = B / -f0, c2 = C / -f0;
  // eigenvalues of [[a2, b2], [b2, c2]]
  const m = 0.5 * (a2 + c2);
  const d = Math.sqrt(0.25 * (a2 - c2) ** 2 + b2 * b2);
  const lSmall = m - d, lBig = m + d;
  if (!(lSmall > 0)) return null;
  // eigenvector of the small eigenvalue: the major axis direction
  let vx: number, vy: number;
  if (Math.abs(b2) > 1e-300) {
    vx = lSmall - c2;
    vy = b2;
  } else {
    [vx, vy] = a2 <= c2 ? [1, 0] : [0, 1];
  }
  return { cx, cy, major: 2 / Math.sqrt(lSmall), minor: 2 / Math.sqrt(lBig), angleDeg: mod180((Math.atan2(vy, vx) * 180) / Math.PI) };
}

/** Q(x) and its gradient for the normalised conic of `e` (cheap; used by the fits). */
export function sampsonDistance(e: Ellipse, x: number, y: number): number {
  const a = e.major / 2, b = e.minor / 2;
  const c = Math.cos(e.angleDeg * DEG), s = Math.sin(e.angleDeg * DEG);
  const dx = x - e.cx, dy = y - e.cy;
  const u = (dx * c + dy * s) / a;
  const v = (-dx * s + dy * c) / b;
  const q = u * u + v * v - 1;
  // gradient of q in x, y: 2 u (c, s) / a + 2 v (-s, c) / b
  const gx = (2 * u * c) / a - (2 * v * s) / b;
  const gy = (2 * u * s) / a + (2 * v * c) / b;
  const g = Math.hypot(gx, gy);
  return g > 1e-300 ? q / g : 0;
}

/** The radius of the ellipse along the ray from its centre at image angle `phi` (radians). */
export function ellipseRadiusAt(e: Ellipse, phi: number): number {
  const a = e.major / 2, b = e.minor / 2;
  const t = phi - e.angleDeg * DEG;
  return (a * b) / Math.sqrt((b * Math.cos(t)) ** 2 + (a * Math.sin(t)) ** 2);
}

/** Points on the ellipse at parameter angles (for synthetic observations). */
export function sampleEllipse(e: Ellipse, n: number, phase = 0): Pt[] {
  const a = e.major / 2, b = e.minor / 2;
  const c = Math.cos(e.angleDeg * DEG), s = Math.sin(e.angleDeg * DEG);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = phase + (2 * Math.PI * i) / n;
    const u = a * Math.cos(t), v = b * Math.sin(t);
    out.push({ x: e.cx + u * c - v * s, y: e.cy + u * s + v * c });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ small solvers

/** Solve a small dense system (Gaussian elimination, partial pivoting); null when singular. */
export function solveDense(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-300)) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f !== 0) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Inverse of a small symmetric positive matrix (by column solves); null when singular. */
export function invertDense(A: number[][]): number[][] | null {
  const n = A.length;
  const cols: number[][] = [];
  for (let j = 0; j < n; j++) {
    const e = new Array<number>(n).fill(0);
    e[j] = 1;
    const x = solveDense(A, e);
    if (!x) return null;
    cols.push(x);
  }
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
}

export interface LeastSquaresResult {
  params: number[];
  residuals: number[];
  /** sigma^2 (J^T J)^-1 with sigma^2 = RSS / (n - k); null when singular. */
  covariance: number[][] | null;
  rms: number;
}

/**
 * Damped Gauss-Newton (Levenberg-Marquardt) on residuals r(p), numeric central-difference Jacobian. `stepScale[j]`
 * sets the finite-difference step of parameter j.
 */
export function levenbergMarquardt(p0: readonly number[], resid: (p: readonly number[]) => number[], opts: { iterations?: number; stepScale?: readonly number[] } = {}): LeastSquaresResult {
  const k = p0.length;
  let p = [...p0];
  let r = resid(p);
  let cost = r.reduce((s, x) => s + x * x, 0);
  let lambda = 1e-3;
  const jac = (q: number[]) => {
    const J: number[][] = [];
    for (let j = 0; j < k; j++) {
      const h = (opts.stepScale?.[j] ?? 1e-6) * Math.max(1, Math.abs(q[j]));
      const qp = [...q], qm = [...q];
      qp[j] += h;
      qm[j] -= h;
      const rp = resid(qp), rm = resid(qm);
      J.push(rp.map((x, i) => (x - rm[i]) / (2 * h)));
    }
    return J; // J[j][i] = d r_i / d p_j
  };
  let J = jac(p);
  for (let it = 0; it < (opts.iterations ?? 40); it++) {
    const JtJ = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => J[a].reduce((s, x, i) => s + x * J[b][i], 0)));
    const g = Array.from({ length: k }, (_, a) => -J[a].reduce((s, x, i) => s + x * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-15 : v)));
      const step = solveDense(A, g);
      if (!step) {
        lambda *= 10;
        continue;
      }
      const cand = p.map((x, j) => x + step[j]);
      const rc = resid(cand);
      const cc = rc.reduce((s, x) => s + x * x, 0);
      if (Number.isFinite(cc) && cc < cost) {
        const rel = (cost - cc) / Math.max(cost, 1e-300);
        p = cand;
        r = rc;
        cost = cc;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        if (rel < 1e-14) it = Infinity;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
    J = jac(p);
  }
  const n = r.length;
  const JtJ = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => J[a].reduce((s, x, i) => s + x * J[b][i], 0)));
  const inv = invertDense(JtJ);
  const s2 = n > k ? cost / (n - k) : NaN;
  return { params: p, residuals: r, covariance: inv ? inv.map((row) => row.map((v) => v * s2)) : null, rms: Math.sqrt(cost / Math.max(n, 1)) };
}

// ------------------------------------------------------------------------------------------------ ellipse fitting

/** Algebraic least-squares conic through points (smallest singular direction of the design matrix, via a 6x6 scatter
 *  matrix and inverse iteration), normalised to an ellipse. Good enough as a start for the geometric fit. */
export function fitEllipseAlgebraic(pts: readonly Pt[]): Ellipse | null {
  const n = pts.length;
  if (n < 6) return null;
  let mx = 0, my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sc = 0;
  for (const p of pts) sc += Math.hypot(p.x - mx, p.y - my);
  sc = sc / n || 1;
  const S = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  for (const p of pts) {
    const x = (p.x - mx) / sc, y = (p.y - my) / sc;
    const d = [x * x, x * y, y * y, x, y, 1];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) S[i][j] += d[i] * d[j];
  }
  // constraint 4ac - b^2 = 1 is what Fitzgibbon imposes; here a simpler, unbiased-enough approach: inverse iteration on S
  // (smallest eigenvector), then a check that the result is an ellipse.
  let v = [1, 0, 1, 0, 0, -1];
  const Sreg = S.map((row, i) => row.map((x, j) => (i === j ? x + 1e-12 : x)));
  for (let it = 0; it < 60; it++) {
    const w = solveDense(Sreg, v);
    if (!w) return null;
    const nn = Math.hypot(...w);
    v = w.map((x) => x / nn);
  }
  const [A, B, C, D, E, F] = v;
  const e = conicToEllipse([A, B / 2, D / 2, B / 2, C, E / 2, D / 2, E / 2, F]);
  if (!e) return null;
  return { cx: e.cx * sc + mx, cy: e.cy * sc + my, major: e.major * sc, minor: e.minor * sc, angleDeg: e.angleDeg };
}

export interface EllipseFit {
  ellipse: Ellipse;
  /** Indices of the points kept by the robust trimming. */
  inliers: number[];
  /** RMS geometric (Sampson) residual of the inliers, pixels. */
  rmsPx: number;
  /** One-sigma standard errors from the fit covariance (statistical only), pixels / degrees. */
  sigma: { cx: number; cy: number; major: number; minor: number; angleDeg: number };
}

/** Geometric ellipse fit (Levenberg-Marquardt on Sampson distances) with MAD trimming of outliers. */
export function fitEllipseRobust(pts: readonly Pt[], opts: { madK?: number; minInlierPx?: number; start?: Ellipse | null; rounds?: number } = {}): EllipseFit | null {
  const kMad = opts.madK ?? 3;
  const floor = opts.minInlierPx ?? 0.3;
  let e = opts.start ?? fitEllipseAlgebraic(pts);
  if (!e || pts.length < 6) return null;
  let idx = pts.map((_, i) => i);
  let last: LeastSquaresResult | null = null;
  for (let round = 0; round < (opts.rounds ?? 5); round++) {
    if (idx.length < 6) return null;
    const use = idx.map((i) => pts[i]);
    const p0 = [e.cx, e.cy, Math.log(e.major / 2), Math.log(e.minor / 2), e.angleDeg * DEG];
    const toE = (p: readonly number[]): Ellipse => ({ cx: p[0], cy: p[1], major: 2 * Math.exp(p[2]), minor: 2 * Math.exp(p[3]), angleDeg: p[4] / DEG });
    last = levenbergMarquardt(p0, (p) => {
      const q = toE(p);
      return use.map((pt) => sampsonDistance(q, pt.x, pt.y));
    }, { iterations: 30 });
    e = toE(last.params);
    const res = pts.map((pt) => Math.abs(sampsonDistance(e as Ellipse, pt.x, pt.y)));
    const r = idx.map((i) => res[i]).sort((a, b) => a - b);
    const med = r[r.length >> 1];
    const mad = [...r].map((x) => Math.abs(x - med)).sort((a, b) => a - b)[r.length >> 1];
    const lim = Math.max(floor, med + kMad * 1.4826 * mad);
    const next = pts.map((_, i) => i).filter((i) => res[i] <= lim);
    if (next.length === idx.length && next.every((v, i) => v === idx[i])) break;
    idx = next;
  }
  if (!last || idx.length < 6) return null;
  // normalise: major >= minor
  let { major, minor, angleDeg } = e;
  let swap = false;
  if (minor > major) {
    [major, minor] = [minor, major];
    angleDeg += 90;
    swap = true;
  }
  const ell: Ellipse = { cx: e.cx, cy: e.cy, major, minor, angleDeg: mod180(angleDeg) };
  const cov = last.covariance;
  const sd = (i: number) => (cov ? Math.sqrt(Math.max(cov[i][i], 0)) : NaN);
  const sMajor = 2 * Math.exp(last.params[swap ? 3 : 2]) * sd(swap ? 3 : 2);
  const sMinor = 2 * Math.exp(last.params[swap ? 2 : 3]) * sd(swap ? 2 : 3);
  const final = idx.map((i) => sampsonDistance(ell, pts[i].x, pts[i].y));
  return {
    ellipse: ell,
    inliers: idx,
    rmsPx: Math.sqrt(final.reduce((s, x) => s + x * x, 0) / final.length),
    sigma: { cx: sd(0), cy: sd(1), major: sMajor, minor: sMinor, angleDeg: sd(4) / DEG },
  };
}

// ------------------------------------------------------------------------------------------------ symmetric eigen

/** Eigen-decomposition of a symmetric 3x3 matrix (cyclic Jacobi). Columns of `vectors` (row-major 3x3) are eigenvectors. */
export function eigenSymmetric3(M: readonly number[]): { values: [number, number, number]; vectors: number[] } {
  const a = [
    [M[0], 0.5 * (M[1] + M[3]), 0.5 * (M[2] + M[6])],
    [0.5 * (M[1] + M[3]), M[4], 0.5 * (M[5] + M[7])],
    [0.5 * (M[2] + M[6]), 0.5 * (M[5] + M[7]), M[8]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 60; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    const scale = a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2 + 1e-300;
    if (off < 1e-30 * scale) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: [v[0][0], v[0][1], v[0][2], v[1][0], v[1][1], v[1][2], v[2][0], v[2][1], v[2][2]] };
}

// ------------------------------------------------------------------------------------------------ circle pose

export interface CirclePose {
  /** Centre of the circle, camera frame, in the units of the given radius. */
  center: V3;
  /** Unit normal of the circle's plane, camera frame, pointing toward the camera. */
  normal: V3;
  /** Angle between the normal and the viewing ray to the centre (0 = seen face-on), degrees. */
  tiltToRayDeg: number;
  /** Angle between the normal and the optical axis (0 = plane parallel to the image), degrees. */
  tiltToImageDeg: number;
}

/** The pixel conic expressed in normalised (undistorted) camera coordinates: Q_n = Km^T Q Km. */
export function normalizeConic(Q: readonly number[], K: Pick<Intrinsics, "fx" | "fy" | "cx" | "cy">): number[] {
  const Km = [K.fx, 0, K.cx, 0, K.fy, K.cy, 0, 0, 1];
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) s += Km[a * 3 + i] * Q[a * 3 + b] * Km[b * 3 + j];
      out[i * 3 + j] = s;
    }
  return out;
}

const col = (V: readonly number[], j: number): V3 => [V[j], V[3 + j], V[6 + j]];

/**
 * The two 3D circles of radius `radius` whose image is the conic `Q` (pixels; undistorted) for intrinsics `K`. The
 * classic two-fold ambiguity of one ellipse: the planes are the circular sections of the viewing cone (eigenvalues
 * l1 >= l2 > 0 > l3, normals proportional to (+-sqrt(l1 - l2), 0, sqrt(l2 - l3)) in the eigenbasis). Each centre is found
 * by intersecting the cone with the plane and scaling to the radius, and each candidate is checked to be a circle.
 */
export function circlePosesFromConic(Q: readonly number[], K: Pick<Intrinsics, "fx" | "fy" | "cx" | "cy">, radius: number): CirclePose[] {
  const Qn = normalizeConic(Q, K);
  const { values, vectors } = eigenSymmetric3(Qn);
  let lam = [...values];
  const pos = lam.filter((l) => l > 0).length;
  if (pos === 1) lam = lam.map((l) => -l);
  else if (pos !== 2) return [];
  const order = [0, 1, 2].sort((i, j) => lam[j] - lam[i]); // descending
  const [l1, l2, l3] = order.map((i) => lam[i]);
  if (!(l2 > 0 && l3 < 0)) return [];
  const e = order.map((i) => col(vectors, i)); // eigenbasis columns in camera frame
  const toCam = (y: V3): V3 => [
    e[0][0] * y[0] + e[1][0] * y[1] + e[2][0] * y[2],
    e[0][1] * y[0] + e[1][1] * y[1] + e[2][1] * y[2],
    e[0][2] * y[0] + e[1][2] * y[1] + e[2][2] * y[2],
  ];
  const L: V3 = [l1, l2, l3];
  const quad = (a: V3, b: V3) => a[0] * L[0] * b[0] + a[1] * L[1] * b[1] + a[2] * L[2] * b[2];
  const out: CirclePose[] = [];
  const g1 = Math.sqrt(Math.max(0, (l1 - l2) / (l1 - l3)));
  const g3 = Math.sqrt(Math.max(0, (l2 - l3) / (l1 - l3)));
  const signs = g1 < 1e-12 ? [1] : [1, -1];
  for (const sg of signs) {
    const n: V3 = [sg * g1, 0, g3];
    // plane n . y = 1, orthonormal basis (e1, e2) in it
    const helper: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const b1 = normalize(cross(n, helper));
    const b2 = cross(n, b1);
    const A11 = quad(b1, b1), A12 = quad(b1, b2), A22 = quad(b2, b2);
    const g1v = quad(b1, n), g2v = quad(b2, n), c0 = quad(n, n);
    const det = A11 * A22 - A12 * A12;
    if (!(Math.abs(det) > 1e-300)) continue;
    const s0 = -(A22 * g1v - A12 * g2v) / det;
    const t0 = -(A11 * g2v - A12 * g1v) / det;
    const alpha = 0.5 * (A11 + A22);
    const rho2 = (A11 * s0 * s0 + 2 * A12 * s0 * t0 + A22 * t0 * t0 - c0) / alpha;
    if (!(rho2 > 0)) continue;
    const rho = Math.sqrt(rho2);
    let cy: V3 = [n[0] + s0 * b1[0] + t0 * b2[0], n[1] + s0 * b1[1] + t0 * b2[1], n[2] + s0 * b1[2] + t0 * b2[2]];
    let center = toCam(cy);
    let normal = toCam(n);
    if (center[2] < 0) {
      cy = [-cy[0], -cy[1], -cy[2]];
      center = toCam(cy);
    }
    const k = radius / rho;
    center = [center[0] * k, center[1] * k, center[2] * k];
    if (dot(normal, center) > 0) normal = [-normal[0], -normal[1], -normal[2]];
    const ray = normalize(center);
    out.push({
      center,
      normal,
      tiltToRayDeg: (Math.acos(Math.min(1, Math.abs(dot(normal, ray)))) * 180) / Math.PI,
      tiltToImageDeg: (Math.acos(Math.min(1, Math.abs(normal[2]))) * 180) / Math.PI,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ projection of a circle

/** Two unit vectors spanning the plane perpendicular to `n`. */
export function planeBasis(n: V3): [V3, V3] {
  const helper: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(helper, n));
  const v = cross(n, u);
  return [u, v];
}

/** The image conic (undistorted pixels) of a 3D circle (world centre, unit normal, radius) seen by a camera
 *  Xc = R X + t with intrinsics K. Null when the circle's plane passes through the camera centre. */
export function projectCircleConic(center: V3, normal: V3, radius: number, R: readonly number[], t: readonly number[], K: Pick<Intrinsics, "fx" | "fy" | "cx" | "cy">): Conic | null {
  const [u, v] = planeBasis(normalize(normal));
  const Rv = (w: V3): V3 => [R[0] * w[0] + R[1] * w[1] + R[2] * w[2], R[3] * w[0] + R[4] * w[1] + R[5] * w[2], R[6] * w[0] + R[7] * w[1] + R[8] * w[2]];
  const ru = Rv(u), rv = Rv(v), rc = Rv(center);
  const c3: V3 = [rc[0] + t[0], rc[1] + t[1], rc[2] + t[2]];
  const Kc = (w: V3): V3 => [K.fx * w[0] + K.cx * w[2], K.fy * w[1] + K.cy * w[2], w[2]];
  const h1 = Kc(ru), h2 = Kc(rv), h3 = Kc(c3);
  const H = [h1[0], h2[0], h3[0], h1[1], h2[1], h3[1], h1[2], h2[2], h3[2]];
  let Hi: number[];
  try {
    Hi = inverse(H);
  } catch {
    return null;
  }
  const Cc = [1, 0, 0, 0, 1, 0, 0, 0, -radius * radius];
  // Q = Hi^T Cc Hi
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let a = 0; a < 3; a++) s += Hi[a * 3 + i] * Cc[a * 3 + a] * Hi[a * 3 + j];
      out[i * 3 + j] = s;
    }
  return out;
}
