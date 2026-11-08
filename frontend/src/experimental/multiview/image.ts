// Small image and camera-ray helpers shared by the EXPERIMENTAL multi-view board reconstruction (multiview/).
// Conventions (see ../common.ts): board/world in millimetres; OpenCV camera; Xc = R X + t; pixel centres at +0.5;
// radial distortion k1, k2 applied to normalised coordinates (the same model as reconstruction/linalg.projectPoint).
import type { CameraPose, Intrinsics } from "../common";
import type { Vec3 } from "../reconstruction/linalg";

/** An 8-bit RGBA picture, row-major (the layout of the browser's ImageData). */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** sRGB byte -> linear [0, 1]. */
export const SRGB_TO_LINEAR: Float32Array = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();

const LIN_LUT_N = 8192;
const LIN_LUT: Float32Array = (() => {
  const t = new Float32Array(LIN_LUT_N + 2);
  for (let i = 0; i <= LIN_LUT_N + 1; i++) {
    const c = Math.min(1, i / LIN_LUT_N);
    t[i] = 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  }
  return t;
})();

/** Linear [0, 1] -> sRGB [0, 255] (not rounded; table with linear interpolation, error far below one grey level
 *  except in the steep toe below linear 0.0002). */
export function linearToSrgb255(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 255;
  if (x < 0.0031308) return 255 * 12.92 * x;
  const f = x * LIN_LUT_N;
  const i = f | 0;
  return LIN_LUT[i] + (LIN_LUT[i + 1] - LIN_LUT[i]) * (f - i);
}

/** The camera centre in world coordinates (C = -R^T t). */
export function cameraCentre(pose: CameraPose): Vec3 {
  const R = pose.R, t = pose.t;
  return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
}

/** Normalised (undistorted) camera coordinates of an image position (u, v in pixels, pixel centres at +0.5). */
export function pixelToNormalized(K: Intrinsics, u: number, v: number): [number, number] {
  const xd = (u - K.cx) / K.fx;
  const yd = (v - K.cy) / K.fy;
  if (!K.k1 && !K.k2) return [xd, yd];
  // invert the radial model by fixed-point iteration (as geometry/camera.undistortNormalized, with a looser stop)
  const k1 = K.k1 ?? 0, k2 = K.k2 ?? 0;
  let x = xd, y = yd;
  for (let i = 0; i < 30; i++) {
    const r2 = x * x + y * y;
    const d = 1 + k1 * r2 + k2 * r2 * r2;
    const nx = xd / d, ny = yd / d;
    const done = Math.abs(nx - x) + Math.abs(ny - y) < 1e-11;
    x = nx;
    y = ny;
    if (done) break;
  }
  return [x, y];
}

/** Precomputed world-space ray directions (unit, not normalised per call) for every pixel centre of a view. */
export interface RayGrid {
  width: number;
  height: number;
  origin: Vec3;
  /** dx, dy, dz per pixel (unit vectors). */
  dirs: Float32Array;
}

export function rayGrid(K: Intrinsics, pose: CameraPose, width = K.width, height = K.height): RayGrid {
  const R = pose.R;
  const sx = K.width / width, sy = K.height / height;
  const dirs = new Float32Array(width * height * 3);
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const [xn, yn] = pixelToNormalized(K, (i + 0.5) * sx, (j + 0.5) * sy);
      // R^T (xn, yn, 1)
      let dx = R[0] * xn + R[3] * yn + R[6];
      let dy = R[1] * xn + R[4] * yn + R[7];
      let dz = R[2] * xn + R[5] * yn + R[8];
      const n = Math.sqrt(dx * dx + dy * dy + dz * dz);
      dx /= n; dy /= n; dz /= n;
      const o = (j * width + i) * 3;
      dirs[o] = dx; dirs[o + 1] = dy; dirs[o + 2] = dz;
    } // fmt: skip
  return { width, height, origin: cameraCentre(pose), dirs };
}

/** Entry and exit distances of a ray through an axis-aligned box, or null when it misses (slab method). */
export function rayBox(o: ArrayLike<number>, d: ArrayLike<number>, min: ArrayLike<number>, max: ArrayLike<number>): [number, number] | null {
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < min[a] || o[a] > max[a]) return null;
      continue;
    }
    let ta = (min[a] - o[a]) / d[a];
    let tb = (max[a] - o[a]) / d[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/** Separable Gaussian blur of a float plane, in place (edges clamped). */
export function gaussianBlurPlane(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = acc;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      src[y * w + x] = acc;
    }
  return src;
}

/** Box mean of a float plane over a (2r+1)^2 window (integral image; edges use the part inside the picture). */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      out[y * w + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}
