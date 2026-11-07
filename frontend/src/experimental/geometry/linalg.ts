// Small 3-vector / 3x3-matrix helpers for the camera-geometry toolbox (pure, no dependencies).
// Matrices are row-major arrays of 9 numbers. EXPERIMENTAL: see ../common.ts.

export type V3 = readonly [number, number, number];
export type M3 = readonly number[];

export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

export function normalize(a: V3): V3 {
  const n = norm(a);
  if (!(n > 0)) throw new Error("cannot normalise a zero vector");
  return [a[0] / n, a[1] / n, a[2] / n];
}

export const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulVec(M: M3, v: V3): V3 {
  return [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
}

export function mul(A: M3, B: M3): number[] {
  const C = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}

export const transpose = (M: M3): number[] => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];

export function det(M: M3): number {
  return M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
}

export function inverse(M: M3): number[] {
  const d = det(M);
  if (!(Math.abs(d) > 1e-300)) throw new Error("singular matrix");
  const [a, b, c, e, f, g, h, i, j] = M;
  return [
    (f * j - g * i) / d, (c * i - b * j) / d, (b * g - c * f) / d,
    (g * h - e * j) / d, (a * j - c * h) / d, (c * e - a * g) / d,
    (e * i - f * h) / d, (b * h - a * i) / d, (a * f - b * e) / d,
  ]; // fmt: skip
}

/** Largest deviation of M from orthonormal rows (0 for a rotation matrix). */
export function orthonormalError(M: M3): number {
  const P = mul(M, transpose(M));
  let worst = 0;
  for (let i = 0; i < 9; i++) worst = Math.max(worst, Math.abs(P[i] - IDENTITY[i]));
  return worst;
}

/** The rotation matrix nearest to M (polar decomposition by Newton iteration); the determinant is forced to +1. */
export function nearestRotation(M: M3): number[] {
  let X = [...M];
  if (det(X) < 0) X = X.map((v) => -v);
  for (let i = 0; i < 60; i++) {
    const Xit = transpose(inverse(X));
    const next = X.map((v, k) => 0.5 * (v + Xit[k]));
    let change = 0;
    for (let k = 0; k < 9; k++) change = Math.max(change, Math.abs(next[k] - X[k]));
    X = next;
    if (change < 1e-14) break;
  }
  return X;
}

/** Solve the square linear system A x = b by Gaussian elimination with partial pivoting; null if singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Deterministic pseudo-random numbers for synthetic tests (mulberry32); `gaussian` via Box-Muller. */
export function seededRandom(seed: number): { uniform: () => number; gaussian: () => number } {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gaussian = () => {
    const u = Math.max(uniform(), 1e-12);
    const v = uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { uniform, gaussian };
}
