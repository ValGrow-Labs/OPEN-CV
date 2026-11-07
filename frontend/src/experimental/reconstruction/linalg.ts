// Small linear algebra for the experimental reconstruction (no dependencies, plain arrays and typed arrays).
// Conventions (see ../common.ts): world in millimetres; camera OpenCV style (x right, y down, z forward);
// a world point X maps to the camera as Xc = R * X + t. Matrices are row-major 3x3 in a length-9 array.
import type { CameraPose, Intrinsics } from "../common";

export type Vec3 = [number, number, number];
export type Mat3 = number[];

export const add = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: ArrayLike<number>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: ArrayLike<number>): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: ArrayLike<number>): Vec3 => {
  const n = norm(a);
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
};

export const mat3Identity = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3Mul(a: readonly number[], b: readonly number[]): Mat3 {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return out;
}

export const mat3T = (a: readonly number[]): Mat3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];

export const mat3MulVec = (a: readonly number[], v: ArrayLike<number>): Vec3 => [
  a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
  a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
  a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
];

/** Rotation by ``angleRad`` about a unit ``axis`` (Rodrigues). */
export function rotationAxisAngle(axis: ArrayLike<number>, angleRad: number): Mat3 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/** The rotation angle (degrees) of a rotation matrix. */
export function rotationAngleDeg(R: readonly number[]): number {
  const tr = R[0] + R[4] + R[8];
  return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
}

/** A world-to-camera pose for a camera at ``eye`` looking at ``target``; ``up`` is the world direction that should
 *  appear as "up" in the picture (it must not be parallel to the viewing direction). */
export function lookAtPose(eye: ArrayLike<number>, target: ArrayLike<number>, up: ArrayLike<number>): CameraPose {
  const f = normalize(sub(target, eye)); // camera z (forward)
  const x = normalize(cross(f, up)); // camera x (right)
  const y = cross(f, x); // camera y (down)
  const R = [x[0], x[1], x[2], y[0], y[1], y[2], f[0], f[1], f[2]];
  const t = scale(mat3MulVec(R, eye), -1);
  return { R, t };
}

/** The camera centre in world coordinates: C = -R^T t. */
export function cameraCenter(pose: CameraPose): Vec3 {
  return scale(mat3MulVec(mat3T(pose.R), pose.t), -1);
}

/** Pinhole intrinsics from the picture size and the horizontal field of view. */
export function intrinsicsFor(width: number, height: number, hfovDeg: number): Intrinsics {
  const f = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2, width, height };
}

/** Project a world point; null when it is behind the camera. Radial distortion (k1, k2) is applied if given. */
export function projectPoint(X: ArrayLike<number>, K: Intrinsics, pose: CameraPose): { u: number; v: number; z: number } | null {
  const R = pose.R;
  const t = pose.t;
  const xc = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
  const yc = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
  const zc = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
  if (zc <= 1e-6) return null;
  let xn = xc / zc;
  let yn = yc / zc;
  if (K.k1 || K.k2) {
    const r2 = xn * xn + yn * yn;
    const d = 1 + (K.k1 ?? 0) * r2 + (K.k2 ?? 0) * r2 * r2;
    xn *= d;
    yn *= d;
  }
  return { u: K.fx * xn + K.cx, v: K.fy * yn + K.cy, z: zc };
}

/** The world-space ray direction through the centre of pixel (i, j) (the centre is at i + 0.5, j + 0.5). */
export function pixelRay(i: number, j: number, K: Intrinsics, pose: CameraPose): { origin: Vec3; dir: Vec3 } {
  const dc: Vec3 = [(i + 0.5 - K.cx) / K.fx, (j + 0.5 - K.cy) / K.fy, 1];
  const dir = normalize(mat3MulVec(mat3T(pose.R), dc));
  return { origin: cameraCenter(pose), dir };
}

/** Jacobi eigen-decomposition of a small symmetric matrix (n x n, row-major). Eigenvalues are returned descending,
 *  with matching unit eigenvectors as rows of ``vectors``. */
export function symmetricEigen(A: readonly number[], n: number): { values: number[]; vectors: number[][] } {
  const a = A.slice();
  const v = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i * n + j] * a[i * n + j];
    if (off < 1e-24) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j * n + j] - a[i * n + i]);
  return {
    values: order.map((i) => a[i * n + i]),
    vectors: order.map((i) => Array.from({ length: n }, (_, k) => v[k * n + i])),
  };
}

/** Best rigid transform (R, t) mapping ``src`` onto ``dst`` for known correspondences (Horn's quaternion method,
 *  the same optimum as Kabsch). Points are xyz triples in flat arrays; optional per-point weights. */
export function rigidAlign(src: ArrayLike<number>, dst: ArrayLike<number>, weights?: ArrayLike<number>): { R: Mat3; t: Vec3; rms: number } {
  const n = Math.floor(src.length / 3);
  if (n < 3 || dst.length < n * 3) return { R: mat3Identity(), t: [0, 0, 0], rms: NaN };
  let wsum = 0;
  const cs: Vec3 = [0, 0, 0];
  const cd: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    wsum += w;
    for (let k = 0; k < 3; k++) {
      cs[k] += w * src[i * 3 + k];
      cd[k] += w * dst[i * 3 + k];
    }
  }
  for (let k = 0; k < 3; k++) {
    cs[k] /= wsum;
    cd[k] /= wsum;
  }
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    const sx = src[i * 3] - cs[0], sy = src[i * 3 + 1] - cs[1], sz = src[i * 3 + 2] - cs[2];
    const dx = dst[i * 3] - cd[0], dy = dst[i * 3 + 1] - cd[1], dz = dst[i * 3 + 2] - cd[2];
    Sxx += w * sx * dx; Sxy += w * sx * dy; Sxz += w * sx * dz;
    Syx += w * sy * dx; Syy += w * sy * dy; Syz += w * sy * dz;
    Szx += w * sz * dx; Szy += w * sz * dy; Szz += w * sz * dz;
  } // fmt: skip
  const N = [
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ]; // fmt: skip
  const [q0, q1, q2, q3] = symmetricEigen(N, 4).vectors[0];
  const R: Mat3 = [
    q0 * q0 + q1 * q1 - q2 * q2 - q3 * q3, 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2),
    2 * (q2 * q1 + q0 * q3), q0 * q0 - q1 * q1 + q2 * q2 - q3 * q3, 2 * (q2 * q3 - q0 * q1),
    2 * (q3 * q1 - q0 * q2), 2 * (q3 * q2 + q0 * q1), q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3,
  ]; // fmt: skip
  const rc = mat3MulVec(R, cs);
  const t: Vec3 = [cd[0] - rc[0], cd[1] - rc[1], cd[2] - rc[2]];
  let se = 0;
  for (let i = 0; i < n; i++) {
    const p = mat3MulVec(R, [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]]);
    se += (p[0] + t[0] - dst[i * 3]) ** 2 + (p[1] + t[1] - dst[i * 3 + 1]) ** 2 + (p[2] + t[2] - dst[i * 3 + 2]) ** 2;
  }
  return { R, t, rms: Math.sqrt(se / n) };
}
