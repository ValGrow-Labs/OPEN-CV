// Small dense linear algebra for the EXPERIMENTAL structure-from-motion study (sfm/). Row-major arrays.
import { symmetricEigen } from "../reconstruction/linalg";

export type M3 = number[];
export type V3 = [number, number, number];

export const m3mul = (a: readonly number[], b: readonly number[]): M3 => {
  const o = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
};
export const m3T = (a: readonly number[]): M3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
export const m3v = (a: readonly number[], v: ArrayLike<number>): V3 => [a[0] * v[0] + a[1] * v[1] + a[2] * v[2], a[3] * v[0] + a[4] * v[1] + a[5] * v[2], a[6] * v[0] + a[7] * v[1] + a[8] * v[2]];
export const m3tv = (a: readonly number[], v: ArrayLike<number>): V3 => [a[0] * v[0] + a[3] * v[1] + a[6] * v[2], a[1] * v[0] + a[4] * v[1] + a[7] * v[2], a[2] * v[0] + a[5] * v[1] + a[8] * v[2]];
export const vsub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vadd = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vscale = (a: ArrayLike<number>, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vnorm = (a: ArrayLike<number>): number => Math.hypot(a[0], a[1], a[2]);
export const vunit = (a: ArrayLike<number>): V3 => {
  const n = vnorm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
export const skew = (v: ArrayLike<number>): M3 => [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];
export const m3det = (m: readonly number[]): number => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/** Rotation from an axis-angle vector (Rodrigues). */
export function expSO3(w: ArrayLike<number>): M3 {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const x = w[0] / th, y = w[1] / th, z = w[2] / th;
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/** Rotation angle (degrees) of R_a R_b^T. */
export function rotDiffDeg(Ra: readonly number[], Rb: readonly number[]): number {
  const M = m3mul(Ra, m3T(Rb));
  const tr = M[0] + M[4] + M[8];
  return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
}

/** Eigen-decomposition of a symmetric n x n matrix, ASCENDING eigenvalues, eigenvectors as rows. */
export function eigSymAsc(A: readonly number[], n: number): { values: number[]; vectors: number[][] } {
  const e = symmetricEigen(A, n);
  return { values: [...e.values].reverse(), vectors: [...e.vectors].reverse() };
}

/** Unit vector minimising |A x| for A (rows x n, row-major): the eigenvector of A^T A with the smallest eigenvalue. */
export function nullVector(A: readonly number[], rows: number, n: number): number[] {
  const AtA = new Array<number>(n * n).fill(0);
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < n; i++) {
      const a = A[r * n + i];
      if (a === 0) continue;
      for (let j = i; j < n; j++) AtA[i * n + j] += a * A[r * n + j];
    }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) AtA[i * n + j] = AtA[j * n + i];
  return eigSymAsc(AtA, n).vectors[0];
}

/** SVD of a 3 x 3 matrix: M = U diag(s) V^T, s descending, U and V proper or improper orthogonal. */
export function svd3(M: readonly number[]): { U: M3; s: V3; V: M3 } {
  const MtM = m3mul(m3T(M), M);
  const e = symmetricEigen(MtM, 3); // descending
  const V: M3 = [e.vectors[0][0], e.vectors[1][0], e.vectors[2][0], e.vectors[0][1], e.vectors[1][1], e.vectors[2][1], e.vectors[0][2], e.vectors[1][2], e.vectors[2][2]];
  const s: V3 = [Math.sqrt(Math.max(0, e.values[0])), Math.sqrt(Math.max(0, e.values[1])), Math.sqrt(Math.max(0, e.values[2]))];
  const cols: V3[] = [];
  for (let k = 0; k < 3; k++) {
    const v: V3 = [V[k], V[3 + k], V[6 + k]];
    const u = m3v(M, v);
    cols.push(s[k] > 1e-12 * Math.max(1, s[0]) ? vscale(u, 1 / s[k]) : [0, 0, 0]);
  }
  // complete U when singular values vanish
  if (vnorm(cols[2]) < 0.5) cols[2] = vunit(vcross(cols[0], cols[1]));
  if (vnorm(cols[1]) < 0.5) {
    const a = Math.abs(cols[0][0]) < 0.9 ? ([1, 0, 0] as V3) : ([0, 1, 0] as V3);
    cols[1] = vunit(vcross(cols[0], a));
    cols[2] = vunit(vcross(cols[0], cols[1]));
  }
  const U: M3 = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
  return { U, s, V };
}

/** The rotation nearest to M (Frobenius). */
export function nearestRot(M: readonly number[]): M3 {
  const { U, V } = svd3(M);
  let R = m3mul(U, m3T(V));
  if (m3det(R) < 0) R = m3mul(m3mul(U, [1, 0, 0, 0, 1, 0, 0, 0, -1]), m3T(V));
  return R;
}

/** Solve the symmetric positive (semi)definite system A x = b in place-free fashion (Cholesky; null on failure). */
export function choleskySolve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

/** Inverse of a symmetric 3 x 3 (null if singular). */
export function inv3sym(a: ArrayLike<number>): number[] | null {
  const d = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (!(Math.abs(d) > 1e-300)) return null;
  return [
    (a[4] * a[8] - a[5] * a[7]) / d, (a[2] * a[7] - a[1] * a[8]) / d, (a[1] * a[5] - a[2] * a[4]) / d,
    (a[5] * a[6] - a[3] * a[8]) / d, (a[0] * a[8] - a[2] * a[6]) / d, (a[2] * a[3] - a[0] * a[5]) / d,
    (a[3] * a[7] - a[4] * a[6]) / d, (a[1] * a[6] - a[0] * a[7]) / d, (a[0] * a[4] - a[1] * a[3]) / d,
  ]; // fmt: skip
}

/** Real roots of a polynomial (coefficients highest power first) by Durand-Kerner, polished by Newton. */
export function polyRealRoots(coeffs: readonly number[]): number[] {
  let c = [...coeffs];
  while (c.length > 1 && Math.abs(c[0]) < 1e-14 * Math.max(...c.map(Math.abs))) c = c.slice(1);
  const n = c.length - 1;
  if (n < 1) return [];
  if (n === 1) return [-c[1] / c[0]];
  const a = c.map((x) => x / c[0]);
  const re = new Float64Array(n), im = new Float64Array(n);
  const R = 1 + Math.max(...a.slice(1).map(Math.abs));
  for (let k = 0; k < n; k++) {
    const ang = (2 * Math.PI * k) / n + 0.4;
    re[k] = R * 0.5 * Math.cos(ang);
    im[k] = R * 0.5 * Math.sin(ang);
  }
  for (let it = 0; it < 500; it++) {
    let delta = 0;
    for (let k = 0; k < n; k++) {
      // p(z)
      let pr = 1, pi = 0;
      for (let j = 1; j <= n; j++) {
        const nr = pr * re[k] - pi * im[k] + a[j];
        const ni = pr * im[k] + pi * re[k];
        pr = nr;
        pi = ni;
      }
      // prod (z - z_j)
      let qr = 1, qi = 0;
      for (let j = 0; j < n; j++) {
        if (j === k) continue;
        const dr = re[k] - re[j], di = im[k] - im[j];
        const nr = qr * dr - qi * di;
        const ni = qr * di + qi * dr;
        qr = nr;
        qi = ni;
      }
      const den = qr * qr + qi * qi || 1e-300;
      const wr = (pr * qr + pi * qi) / den, wi = (pi * qr - pr * qi) / den;
      re[k] -= wr;
      im[k] -= wi;
      delta = Math.max(delta, Math.abs(wr) + Math.abs(wi));
    }
    if (delta < 1e-14) break;
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    if (Math.abs(im[k]) > 1e-6 * Math.max(1, Math.abs(re[k]))) continue;
    let x = re[k];
    for (let it = 0; it < 5; it++) {
      let p = 0, dp = 0;
      for (let j = 0; j <= n; j++) {
        dp = dp * x + p;
        p = p * x + a[j];
      }
      if (Math.abs(dp) < 1e-300) break;
      x -= p / dp;
    }
    out.push(x);
  }
  return out;
}
