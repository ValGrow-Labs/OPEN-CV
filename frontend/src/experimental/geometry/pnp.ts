// Plane-based camera pose: a homography from a known planar point set (z = 0, millimetres) to its image, decomposed with
// the known intrinsics, then refined by Levenberg-Marquardt on the reprojection error (distortion included).
//
// This is the maths a printed marker grid, a sheet of paper's corners or any known coplanar points would use.
// It is NOT something a single coin provides (see coinScale.ts LIMITS_OF_ONE_CIRCLE). Experimental and unvalidated.
//
// Method: Hartley and Zisserman, "Multiple View Geometry in Computer Vision" (2nd ed., 2003), the normalised DLT (4.4)
// and the plane-based pose decomposition; Zhang, "A flexible new technique for camera calibration", IEEE TPAMI 2000.
// Known weakness (Collins and Bartoli, "Infinitesimal plane-based pose estimation", IJCV 2014): when the plane is
// nearly parallel to the image plane two poses fit almost equally well, and noise can flip the answer;
// `ambiguityWarning` says so.

import type { CameraPose, Intrinsics, Pt } from "../common";
import { axisAngleFromRotation, pixelToNormalized, project, rotationFromAxisAngle } from "./camera";
import { cross, mul, nearestRotation, norm, solveLinear, type M3, type V3 } from "./linalg";

/** Hartley normalisation: translate to the centroid and scale so the mean distance is sqrt(2). */
function normalisation(pts: readonly Pt[]): { T: number[]; pts: Pt[] } {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p.x, 0) / n;
  const cy = pts.reduce((s, p) => s + p.y, 0) / n;
  const meanDist = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / n;
  const s = meanDist > 0 ? Math.SQRT2 / meanDist : 1;
  return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], pts: pts.map((p) => ({ x: s * (p.x - cx), y: s * (p.y - cy) })) };
}

/** Homography H (3x3, row-major, H[8] = 1 after the fit) with dst ~ H src, from 4 or more correspondences; null when degenerate. */
export function estimateHomography(src: readonly Pt[], dst: readonly Pt[]): number[] | null {
  if (src.length !== dst.length || src.length < 4) return null;
  const a = normalisation(src);
  const b = normalisation(dst);
  const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  const addRow = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < src.length; i++) {
    const { x, y } = a.pts[i];
    const { x: u, y: v } = b.pts[i];
    addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  if (!h) return null;
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const Tdst = b.T;
  // H = Tdst^-1 * Hn * Tsrc, with Tdst inverted in closed form (it is a similarity)
  const s = Tdst[0];
  const TdstInv = [1 / s, 0, -Tdst[2] / s, 0, 1 / s, -Tdst[5] / s, 0, 0, 1];
  const H = mul(TdstInv, mul(Hn, a.T));
  const last = H[8];
  return Math.abs(last) > 1e-300 ? H.map((v) => v / last) : null;
}

export type PlanarPoseResult =
  | {
      ok: true;
      pose: CameraPose;
      /** Reprojection error of the supplied points after refinement, in pixels. */
      reprojRmsPx: number;
      /** The angle between the plane and the image plane, degrees. */
      planeTiltDeg: number;
      ambiguityWarning: string | null;
    }
  | { ok: false; reason: "too_few_points" | "degenerate_points" | "behind_camera" };

function poseFromParams(p: readonly number[]): CameraPose {
  const w: V3 = [p[0], p[1], p[2]];
  const angle = norm(w);
  const R = angle < 1e-12 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : rotationFromAxisAngle(w, angle);
  return { R, t: [p[3], p[4], p[5]] };
}

function costOf(K: Intrinsics, params: readonly number[], world: readonly Pt[], image: readonly Pt[]): number {
  const pose = poseFromParams(params);
  let c = 0;
  for (let i = 0; i < world.length; i++) {
    const q = project(K, pose, [world[i].x, world[i].y, 0]);
    if (!q) return Infinity;
    c += (q.x - image[i].x) ** 2 + (q.y - image[i].y) ** 2;
  }
  return c;
}

function refine(K: Intrinsics, start: CameraPose, world: readonly Pt[], image: readonly Pt[]): CameraPose {
  const { axis, angleRad } = axisAngleFromRotation(start.R as M3);
  let p = [axis[0] * angleRad, axis[1] * angleRad, axis[2] * angleRad, start.t[0], start.t[1], start.t[2]];
  let cost = costOf(K, p, world, image);
  let lambda = 1e-3;
  for (let iter = 0; iter < 40 && Number.isFinite(cost) && cost > 1e-18; iter++) {
    // residuals and a central-difference Jacobian
    const resid = (params: readonly number[]): number[] => {
      const pose = poseFromParams(params);
      const out: number[] = [];
      for (let i = 0; i < world.length; i++) {
        const q = project(K, pose, [world[i].x, world[i].y, 0]);
        out.push(q ? q.x - image[i].x : 1e6, q ? q.y - image[i].y : 1e6);
      }
      return out;
    };
    const r0 = resid(p);
    const J: number[][] = r0.map(() => new Array<number>(6).fill(0));
    for (let k = 0; k < 6; k++) {
      const eps = k < 3 ? 1e-6 : 1e-4;
      const pp = [...p];
      const pm = [...p];
      pp[k] += eps;
      pm[k] -= eps;
      const rp = resid(pp);
      const rm = resid(pm);
      for (let i = 0; i < r0.length; i++) J[i][k] = (rp[i] - rm[i]) / (2 * eps);
    }
    const JtJ = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    const Jtr = new Array<number>(6).fill(0);
    for (let i = 0; i < r0.length; i++)
      for (let a = 0; a < 6; a++) {
        Jtr[a] += J[i][a] * r0[i];
        for (let b = 0; b < 6; b++) JtJ[a][b] += J[i][a] * J[i][b];
      }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const damped = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
      const step = solveLinear(damped, Jtr.map((v) => -v));
      if (!step) {
        lambda *= 10;
        continue;
      }
      const cand = p.map((v, k) => v + step[k]);
      const candCost = costOf(K, cand, world, image);
      if (candCost < cost) {
        const small = Math.abs(cost - candCost) < 1e-16 * (1 + cost);
        p = cand;
        cost = candCost;
        lambda = Math.max(lambda / 10, 1e-9);
        improved = true;
        if (small) return poseFromParams(p);
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return poseFromParams(p);
}

/**
 * The camera pose (world to camera, plane z = 0 in millimetres) from at least four coplanar points with known
 * positions `world` (X, Y in the plane) and their pixels `image`. Needs known intrinsics (assumed ones carry their error).
 */
export function poseFromPlanarPoints(K: Intrinsics, world: readonly Pt[], image: readonly Pt[], opts: { refine?: boolean } = {}): PlanarPoseResult {
  if (world.length !== image.length || world.length < 4) return { ok: false, reason: "too_few_points" };
  const normalised = image.map((p) => pixelToNormalized(K, p.x, p.y));
  const H = estimateHomography(world, normalised);
  if (!H) return { ok: false, reason: "degenerate_points" };
  const h1: V3 = [H[0], H[3], H[6]];
  const h2: V3 = [H[1], H[4], H[7]];
  const h3: V3 = [H[2], H[5], H[8]];
  const lambda = 2 / (norm(h1) + norm(h2));
  if (!Number.isFinite(lambda)) return { ok: false, reason: "degenerate_points" };
  let sign = 1;
  if (h3[2] * lambda < 0) sign = -1; // the plane must be in front of the camera
  const r1: V3 = [h1[0] * lambda * sign, h1[1] * lambda * sign, h1[2] * lambda * sign];
  const r2: V3 = [h2[0] * lambda * sign, h2[1] * lambda * sign, h2[2] * lambda * sign];
  const t: V3 = [h3[0] * lambda * sign, h3[1] * lambda * sign, h3[2] * lambda * sign];
  const r3 = cross(r1, r2);
  const R0 = nearestRotation([r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]]);
  let pose: CameraPose = { R: R0, t };
  if (!(t[2] > 0)) return { ok: false, reason: "behind_camera" };
  if (opts.refine !== false) pose = refine(K, pose, world, image);
  let sum = 0;
  for (let i = 0; i < world.length; i++) {
    const q = project(K, pose, [world[i].x, world[i].y, 0]);
    if (!q) return { ok: false, reason: "behind_camera" };
    sum += (q.x - image[i].x) ** 2 + (q.y - image[i].y) ** 2;
  }
  const nz = Math.abs(pose.R[8]); // the plane's normal in camera coordinates is the third column of R; its z is R[8]
  const planeTiltDeg = (Math.acos(Math.min(1, nz)) * 180) / Math.PI;
  return {
    ok: true,
    pose,
    reprojRmsPx: Math.sqrt(sum / world.length),
    planeTiltDeg,
    ambiguityWarning:
      planeTiltDeg < 10 ? "The plane is within 10 degrees of fronto-parallel: two poses fit almost equally well and noise can flip the tilt (Collins and Bartoli 2014)." : null,
  };
}
