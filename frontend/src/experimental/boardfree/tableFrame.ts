// The metric TABLE frame of the EXPERIMENTAL board-free chain, from the structure from motion alone:
//   z: the table plane fitted to the triangulated table points (RANSAC + least squares; sfm/frame.ts fitPlaneRansac),
//      +z toward the cameras, z = 0 on the table;
//   scale: millimetres per SfM unit from the coin fitted jointly in the bundle adjustment;
//   in-plane axes (x along the hand toward the fingers, origin at the wrist):
//     "landmarks" (stage 3): the wrist and middle-knuckle landmarks triangulated with the SfM poses;
//     "silhouette" (stage 4): the hand axis from ALL the triangulated landmarks of the hand's middle line (wrist, middle
//       finger base and joints, and the mean of the four finger bases), fitted by least squares and projected onto the
//       table; see README "the forearm cut" for why this matters and what else changed.
// The carving volume is then built in this frame from the triangulated landmarks (never from the truth).
import type { CameraPose, Intrinsics, Pt } from "../common";
import { triangulateLandmarks } from "../multiview/landmarks";
import type { Vec3 } from "../reconstruction/linalg";
import { camToIntrinsics, fitPlaneRansac, poseToTable, triangulatePixels, type Plane, type TableFrame } from "../sfm/frame";
import { centreOf } from "../sfm/geometry";
import { vcross, vdot, vscale, vsub, vunit, type V3 } from "../sfm/mat";
import type { SfmResult } from "../sfm/sfm";
import type { BoardFreeFrame, BoardFreeFrameDef, CarveInput } from "./types";

export interface FrameOptions {
  method?: "landmarks" | "silhouette";
  /** Where the wrist lands in the table frame (a naming convention; default (25, 122) like the board frame). */
  placeOrigin?: [number, number];
}

/** Fit the table plane (SfM units). Null when no plane is found. */
export function fitTablePlane(sfm: SfmResult): Plane | null {
  const P = sfm.points.map((p) => p.X);
  if (P.length < 50) return null;
  const C = sfm.poses.filter((p) => p).map((p) => centreOf(p!.R, p!.t));
  const med = median(C.map((c) => Math.hypot(...vsub(c, P[0]))));
  return fitPlaneRansac(P, 0.002 * med, 1);
}

/** Build the metric table frame. Null with the reason when a needed landmark could not be triangulated. */
export function buildTableFrame(sfm: SfmResult, plane: Plane, mmPerUnit: number, frames: readonly BoardFreeFrame[], o: FrameOptions = {}): { frame: TableFrame; def: BoardFreeFrameDef } | { frame: null; reason: string } {
  const method = o.method ?? "silhouette";
  const centres = sfm.poses.filter((p) => p).map((p) => centreOf(p!.R, p!.t));
  let n = plane.n, d = plane.d;
  if (centres.reduce((s, c) => s + (vdot(n, c) - d), 0) < 0) ((n = vscale(n, -1) as V3), (d = -d));
  const tri = (k: number) => triangulatePixels(sfm.cam, sfm.poses, frames.map((f) => (f.landmarks ? f.landmarks[k] ?? null : null)));
  const proj = (p: V3): V3 => vsub(p, vscale(n, vdot(n, p) - d));
  const wrist = tri(0);
  if (!wrist) return { frame: null, reason: "the wrist landmark could not be triangulated" };
  let x: V3;
  const notes: string[] = [];
  if (method === "landmarks") {
    const mcp = tri(9);
    if (!mcp) return { frame: null, reason: "the middle-knuckle landmark could not be triangulated" };
    x = vunit(vsub(proj(mcp), proj(wrist)));
    notes.push("in-plane x axis: wrist -> middle knuckle (two triangulated landmarks)");
  } else {
    // the hand's middle line: wrist, middle MCP / PIP / DIP and the mean of the four finger bases, a least-squares
    // direction through them on the table (more points, less landmark noise in the yaw)
    const ids = [0, 9, 10, 11];
    const P = ids.map(tri).filter((p): p is V3 => !!p).map(proj);
    const bases = [5, 9, 13, 17].map(tri).filter((p): p is V3 => !!p).map(proj);
    if (bases.length === 4) P.push(vscale(bases.reduce((s, b) => [s[0] + b[0], s[1] + b[1], s[2] + b[2]] as V3, [0, 0, 0] as V3), 0.25) as V3);
    if (P.length < 3) return { frame: null, reason: "too few landmarks of the hand's middle line could be triangulated" };
    x = principalDirection(P, vsub(P[1] ?? P[P.length - 1], P[0]));
    notes.push(`in-plane x axis: least-squares line through ${P.length} triangulated landmarks of the hand's middle line`);
  }
  const y = vcross(n, x);
  const o0 = proj(wrist);
  const place = o.placeOrigin ?? [25, 122];
  const frame: TableFrame = { Rf: [...x, ...y, ...n], origin: o0, offset: [place[0], place[1], 0], mmPerUnit, plane: { ...plane, n, d } };
  const def: BoardFreeFrameDef = {
    method,
    Rf: [...x, ...y, ...n] as BoardFreeFrameDef["Rf"],
    origin: [...o0] as [number, number, number],
    offset: [place[0], place[1], 0],
    mmPerUnit,
    plane: { n: [...n] as [number, number, number], d, inliers: plane.inliers, rmsMm: plane.rms * mmPerUnit },
    cutXMm: NaN,
    notes,
  };
  return { frame, def };
}

function principalDirection(P: readonly V3[], hint: V3): V3 {
  const c: V3 = [0, 0, 0];
  for (const p of P) ((c[0] += p[0] / P.length), (c[1] += p[1] / P.length), (c[2] += p[2] / P.length));
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of P) {
    const q = vsub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i * 3 + j] += q[i] * q[j];
  }
  // power iteration for the largest eigenvector
  let v: V3 = vunit(hint);
  for (let k = 0; k < 100; k++) v = vunit([M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]]);
  return vdot(v, hint) < 0 ? (vscale(v, -1) as V3) : v;
}

/** The carving views: table-frame poses, the intrinsics and landmarks at the reconstruction size (`factor` halvings). */
export function carveInputs(sfm: SfmResult, frame: TableFrame, frames: readonly BoardFreeFrame[], indices: readonly number[], factor: number): CarveInput[] {
  const W = frames[0].image.width, H = frames[0].image.height;
  const K0 = camToIntrinsics(sfm.cam, W, H);
  const K: Intrinsics = { ...K0, fx: K0.fx / factor, fy: K0.fy / factor, cx: K0.cx / factor, cy: K0.cy / factor, width: W / factor, height: H / factor };
  return indices
    .filter((i) => sfm.poses[i])
    .map((i) => ({
      id: frames[i].id,
      frameIndex: i,
      intrinsics: K,
      pose: poseToTable(frame, sfm.poses[i]!) as CameraPose,
      landmarks: frames[i].landmarks ? frames[i].landmarks!.map((p) => (p ? ({ x: p.x / factor, y: p.y / factor } as Pt) : null)) : null,
    }));
}

/** The carving volume from the landmarks triangulated in the table frame (stage 3's rule: from 25 mm behind the wrist
 *  to 22 mm beyond the farthest landmark, 28 mm either side, table to 80 mm). Null when too few landmarks. */
export function volumeFromLandmarks(views: readonly CarveInput[], o: { behindWristMm?: number; beyondMm?: number; sideMm?: number; zMaxMm?: number } = {}): { min: Vec3; max: Vec3 } | null {
  const tri = triangulateLandmarks(views.map((v) => ({ id: v.id, intrinsics: v.intrinsics, pose: v.pose, landmarks: v.landmarks })));
  const pts = tri.points.filter((p): p is NonNullable<typeof p> => !!p);
  if (pts.length < 5 || !tri.points[0]) return null;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const wrist = tri.points[0]!;
  return {
    min: [wrist.x - (o.behindWristMm ?? 25), Math.min(...ys) - (o.sideMm ?? 28), 0],
    max: [Math.max(...xs) + (o.beyondMm ?? 22), Math.max(...ys) + (o.sideMm ?? 28), o.zMaxMm ?? 80],
  };
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
};

export type { TableFrame };
