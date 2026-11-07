// Camera model and pose maths for the experimental multi-view hand reconstruction.
//
// Convention (see ../common.ts): world in millimetres; camera x right, y down, z forward (OpenCV);
//   Xc = R * X + t;  u = fx * x_d + cx,  v = fy * y_d + cy  with  x = Xc.x / Xc.z, y = Xc.y / Xc.z  and the radial model
//   x_d = x * (1 + k1 r^2 + k2 r^4),  r^2 = x^2 + y^2.
//
// WHAT AN ORDINARY PHONE BROWSER KNOWS: getUserMedia gives pixels and the track size, but no focal length, no
// principal point, no lens distortion and no EXIF. The app therefore ASSUMES a horizontal field of view (config
// `uncertainty.assumed_hfov_deg`, 55 to 80 degrees) and treats the principal point as the image centre. Every metric
// quantity that depends on the focal length inherits that assumption (see `focalLengthSensitivity`).
//
// EXPERIMENTAL and unvalidated: nothing here is used by the production coin pipeline or the sizing.

import type { CameraPose, Intrinsics, Pt, Pt3 } from "../common";
import { add, cross, dot, IDENTITY, inverse, mul, mulVec, normalize, scale, sub, transpose, type M3, type V3 } from "./linalg";

/** Mirrors config `uncertainty.assumed_hfov_deg` (the app's assumed field-of-view range). A test keeps it equal to the file. */
export const ASSUMED_HFOV_DEG: readonly [number, number] = [55, 80];

/** The video size the app asks for (src/camera/camera.ts): phones 1280 x 720, desktops 1920 x 1080. */
export const APP_VIDEO_SIZE = { mobile: { width: 1280, height: 720 }, desktop: { width: 1920, height: 1080 } } as const;

const DEG = Math.PI / 180;

/**
 * Intrinsics from an assumed field of view. `along` says which image side the field of view spans:
 * "long" (default) is the production convention (src/vision/liveChecks.ts applies it to the longer side);
 * "width" applies it to the image width. Square pixels, principal point at the centre, no distortion.
 */
export function intrinsicsFromHfov(width: number, height: number, hfovDeg: number, along: "long" | "width" = "long"): Intrinsics {
  if (!(width > 0 && height > 0)) throw new Error("image size must be positive");
  if (!(hfovDeg > 0 && hfovDeg < 180)) throw new Error("field of view must be in (0, 180) degrees");
  const side = along === "long" ? Math.max(width, height) : width;
  const f = side / 2 / Math.tan((hfovDeg * DEG) / 2);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2, width, height };
}

// ------------------------------------------------------------------------------------------------ distortion

export function distortNormalized(x: number, y: number, k1 = 0, k2 = 0): Pt {
  const r2 = x * x + y * y;
  const d = 1 + k1 * r2 + k2 * r2 * r2;
  return { x: x * d, y: y * d };
}

/** Invert the radial model by fixed-point iteration (converges for the small distortions of phone lenses). */
export function undistortNormalized(xd: number, yd: number, k1 = 0, k2 = 0): Pt {
  if (!k1 && !k2) return { x: xd, y: yd };
  let x = xd;
  let y = yd;
  for (let i = 0; i < 50; i++) {
    const r2 = x * x + y * y;
    const d = 1 + k1 * r2 + k2 * r2 * r2;
    const nx = xd / d;
    const ny = yd / d;
    const done = Math.abs(nx - x) + Math.abs(ny - y) < 1e-14;
    x = nx;
    y = ny;
    if (done) break;
  }
  return { x, y };
}

// ------------------------------------------------------------------------------------------------ projection

/** Project a camera-frame point; null when it is not in front of the camera. */
export function projectCamera(K: Intrinsics, Xc: V3): Pt | null {
  if (!(Xc[2] > 1e-9)) return null;
  const d = distortNormalized(Xc[0] / Xc[2], Xc[1] / Xc[2], K.k1, K.k2);
  return { x: K.fx * d.x + K.cx, y: K.fy * d.y + K.cy };
}

/** Project a world point with the pose `Xc = R X + t`. */
export function project(K: Intrinsics, pose: CameraPose, X: V3 | Pt3): Pt | null {
  const v: V3 = Array.isArray(X) ? (X as V3) : [(X as Pt3).x, (X as Pt3).y, (X as Pt3).z];
  return projectCamera(K, transformPoint(pose, v));
}

/** Undistorted normalised image coordinates (x/z, y/z) of a pixel. */
export function pixelToNormalized(K: Intrinsics, u: number, v: number): Pt {
  return undistortNormalized((u - K.cx) / K.fx, (v - K.cy) / K.fy, K.k1, K.k2);
}

/** Camera-frame point on the pixel's ray at a given depth Z (millimetres along the optical axis). */
export function unproject(K: Intrinsics, u: number, v: number, depthMm: number): V3 {
  const n = pixelToNormalized(K, u, v);
  return [n.x * depthMm, n.y * depthMm, depthMm];
}

// ------------------------------------------------------------------------------------------------ poses

export const identityPose = (): CameraPose => ({ R: IDENTITY, t: [0, 0, 0] });

export function transformPoint(pose: CameraPose, X: V3): V3 {
  return add(mulVec(pose.R as M3, X), pose.t);
}

/** The pose of "apply `b`, then `a`": X -> a(b(X)). */
export function composePoses(a: CameraPose, b: CameraPose): CameraPose {
  const R = mul(a.R as M3, b.R as M3);
  const t = add(mulVec(a.R as M3, b.t), a.t);
  return { R, t };
}

export function invertPose(p: CameraPose): CameraPose {
  const Rt = transpose(p.R as M3);
  const t = scale(mulVec(Rt, p.t), -1);
  return { R: Rt, t };
}

/** The camera centre in world coordinates: -R^T t. */
export function cameraCenter(p: CameraPose): V3 {
  return scale(mulVec(transpose(p.R as M3), p.t), -1);
}

/** Rodrigues: the rotation by `angleRad` about `axis`. */
export function rotationFromAxisAngle(axis: V3, angleRad: number): number[] {
  const k = normalize(axis);
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const C = 1 - c;
  const [x, y, z] = k;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ]; // fmt: skip
}

/** The axis (unit) and angle (radians, 0 to pi) of a rotation matrix. */
export function axisAngleFromRotation(R: M3): { axis: V3; angleRad: number } {
  const tr = R[0] + R[4] + R[8];
  const angleRad = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (angleRad < 1e-9) return { axis: [0, 0, 1], angleRad: 0 };
  if (Math.PI - angleRad < 1e-6) {
    // half-turn: the axis is the eigenvector of R for eigenvalue 1; take the largest diagonal term
    const xx = (R[0] + 1) / 2;
    const yy = (R[4] + 1) / 2;
    const zz = (R[8] + 1) / 2;
    if (xx >= yy && xx >= zz) {
      const x = Math.sqrt(Math.max(xx, 0));
      return { axis: normalize([x, (R[1] + R[3]) / (4 * x), (R[2] + R[6]) / (4 * x)]), angleRad };
    }
    if (yy >= zz) {
      const y = Math.sqrt(Math.max(yy, 0));
      return { axis: normalize([(R[1] + R[3]) / (4 * y), y, (R[5] + R[7]) / (4 * y)]), angleRad };
    }
    const z = Math.sqrt(Math.max(zz, 0));
    return { axis: normalize([(R[2] + R[6]) / (4 * z), (R[5] + R[7]) / (4 * z), z]), angleRad };
  }
  const s = 2 * Math.sin(angleRad);
  return { axis: normalize([(R[7] - R[5]) / s, (R[2] - R[6]) / s, (R[3] - R[1]) / s]), angleRad };
}

/** The angle in degrees of the rotation that takes R1 to R2 (0 to 180). */
export function rotationAngleBetween(R1: M3, R2: M3): number {
  return (axisAngleFromRotation(mul(transpose(R1), R2)).angleRad * 180) / Math.PI;
}

/**
 * The world-to-camera pose of a camera at `eye` looking at `target`, with the image's "down" as close as possible
 * to the opposite of `up` (world). Rows of R are the camera x (right), y (down) and z (forward) axes in world.
 */
export function lookAt(eye: V3, target: V3, up: V3 = [0, 0, 1]): CameraPose {
  const z = normalize(sub(target, eye));
  const y0 = scale(up, -1);
  const yRaw = sub(y0, scale(z, dot(y0, z)));
  if (Math.hypot(...yRaw) < 1e-9) throw new Error("look direction is parallel to the up vector");
  const y = normalize(yRaw);
  const x = cross(y, z);
  const R = [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]];
  return { R, t: scale(mulVec(R, eye), -1) };
}

export function rotationMatrixIsValid(R: M3, tol = 1e-9): boolean {
  const P = mul(R, transpose(R));
  const detR = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  return P.every((v, i) => Math.abs(v - IDENTITY[i]) < tol) && Math.abs(detR - 1) < tol;
}

// ------------------------------------------------------------------------------------------------ errors

/** Reprojection error of known 3D points against their observed pixels (a point behind the camera counts as Infinity). */
export function reprojectionError(
  K: Intrinsics,
  pose: CameraPose,
  world: readonly (V3 | Pt3)[],
  observed: readonly Pt[],
): { rmsPx: number; perPointPx: number[] } {
  if (world.length !== observed.length || world.length === 0) throw new Error("need matching, non-empty point lists");
  const perPointPx = world.map((X, i) => {
    const p = project(K, pose, X);
    return p ? Math.hypot(p.x - observed[i].x, p.y - observed[i].y) : Infinity;
  });
  const rmsPx = Math.sqrt(perPointPx.reduce((s, e) => s + e * e, 0) / perPointPx.length);
  return { rmsPx, perPointPx };
}

// ------------------------------------------------------------------------------------------------ sensitivity

export interface FocalSensitivity {
  /** The distance implied by the coin, Z = fx * D / major, is proportional to the assumed focal length. */
  distanceErrorMm: number;
  distanceErrorRel: number;
  /** Relative error of the scale carried to a plane `planeOffsetMm` behind the coin's plane (factor Z / (Z + dz)). */
  planeScaleErrorRel: number;
  /** The resulting error of a length of `lengthMm` measured in that plane, when that depth correction is applied. */
  lengthErrorMm: number;
}

/**
 * What a wrong focal length costs. The in-plane scale at the coin, mm/px = D / major_px, does not depend on the focal
 * length at all. The focal length enters through the DISTANCE (Z = fx D / major), and the distance is what turns
 * "the coin's plane" into "another plane" (the hand's thickness, the fingertips, a second view): the scale at a plane
 * dz farther away is mm/px * (Z + dz) / Z. A relative focal error e therefore makes the corrected scale wrong by
 *   F(Z (1 + e)) / F(Z) - 1  with  F(Z) = (Z + dz) / Z  (here written as the ratio of the two scale factors).
 * Example: e = +10 %, Z = 350 mm, dz = 15 mm, L = 190 mm gives -0.375 % of the scale, about 0.7 mm.
 */
export function focalLengthSensitivity(opts: { relFocalError: number; distanceMm: number; planeOffsetMm: number; lengthMm: number }): FocalSensitivity {
  const { relFocalError: e, distanceMm: Z, planeOffsetMm: dz, lengthMm: L } = opts;
  if (!(Z > 0)) throw new Error("distance must be positive");
  const factor = (z: number) => (z + dz) / z; // scale multiplier for a plane dz farther than the coin
  const wrong = factor(Z * (1 + e));
  const right = factor(Z);
  const planeScaleErrorRel = wrong / right - 1;
  return {
    distanceErrorMm: Z * e,
    distanceErrorRel: e,
    planeScaleErrorRel,
    lengthErrorMm: L * planeScaleErrorRel,
  };
}

export { inverse as invertMatrix3 };
