// Board pose for the EXPERIMENTAL multi-view reconstruction: one camera pose per view from the detected markers.
//
// All detected markers' corners (3D from `markerCorners`, z = 0, BOARD millimetres) and their refined image corners go
// to geometry/pnp.ts (normalised DLT homography, plane-pose decomposition, Levenberg-Marquardt with the lens model).
// Markers whose corners disagree with the common pose (a misread id, a corner pulled by a finger) are dropped one at a
// time by residual. The camera's elevation above the board plane and its azimuth around a reference point are read from
// the pose, for coverage guidance ("go lower", "move round to the thumb side").
//
// The pose is in BOARD millimetres. If the sheet was printed at scale s (e.g. "fit to page"), board millimetres are s
// physical millimetres: angles are unaffected, every length (including t) is off by 1/s. coinCheck.ts detects that.
// EXPERIMENTAL; accuracy figures in README.md are SIMULATED.

import type { CameraPose, Intrinsics, Pt } from "../common";
import { cameraCenter, project } from "../geometry/camera";
import { poseFromPlanarPoints } from "../geometry/pnp";
import type { MarkerDetection } from "./detect";
import { BOARD, markerCorners, type BoardLayout } from "./spec";

export interface BoardPoseOptions {
  layout?: BoardLayout;
  /** A marker is an outlier when its RMS corner residual exceeds max(outlierPx, outlierFactor x median). Default 2 px. */
  outlierPx?: number;
  outlierFactor?: number;
  /** Fewest markers for a pose (default 1: one marker's four corners determine a pose, weakly). */
  minMarkers?: number;
  /** Reference point on the board for elevation and azimuth, board mm (default: the centre of the hand area). */
  reference?: { x: number; y: number };
}

export interface MarkerResidual {
  id: number;
  rmsPx: number;
  used: boolean;
}

export type BoardPoseResult =
  | {
      ok: true;
      /** World (board mm) to camera. */
      pose: CameraPose;
      reprojRmsPx: number;
      markersUsed: number;
      residuals: MarkerResidual[];
      droppedIds: number[];
      /** Camera centre in board mm. */
      cameraCenter: [number, number, number];
      /** Angle of the line from the reference point to the camera above the board plane, degrees (90 = straight above). */
      elevationDeg: number;
      /** Direction of the camera from the reference point in the board plane, degrees from +x toward +y (0 = right,
       *  fingertip side; 90 = top edge; 180 = left, open edge; 270 = bottom edge). */
      azimuthDeg: number;
      /** Distance from the reference point to the camera, board mm. */
      distanceMm: number;
      /** Angle between the board plane and the image plane, degrees (from pnp.ts). */
      planeTiltDeg: number;
      ambiguityWarning: string | null;
      /** Image extent of the used corners as a fraction of the image diagonal (small = weak geometry). */
      spreadFraction: number;
    }
  | { ok: false; reason: "too_few_markers" | "pose_failed"; markersUsed: number; detail?: string };

function handCentre(layout: BoardLayout): { x: number; y: number } {
  const h = layout.handArea;
  return { x: (h.minX + h.maxX) / 2, y: (h.minY + h.maxY) / 2 };
}

/** Elevation, azimuth and distance of a camera (board-mm pose) seen from a board point. */
export function viewAngles(pose: CameraPose, reference: { x: number; y: number }): { elevationDeg: number; azimuthDeg: number; distanceMm: number; center: [number, number, number] } {
  const c = cameraCenter(pose);
  const dx = c[0] - reference.x, dy = c[1] - reference.y;
  const horiz = Math.hypot(dx, dy);
  const az = (Math.atan2(dy, dx) * 180) / Math.PI;
  return {
    elevationDeg: (Math.atan2(c[2], horiz) * 180) / Math.PI,
    azimuthDeg: (az + 360) % 360,
    distanceMm: Math.hypot(dx, dy, c[2]),
    center: [c[0], c[1], c[2]],
  };
}

/** The camera pose from detected markers. */
export function estimateBoardPose(K: Intrinsics, markers: readonly MarkerDetection[], opts: BoardPoseOptions = {}): BoardPoseResult {
  const layout = opts.layout ?? BOARD;
  const minMarkers = Math.max(1, opts.minMarkers ?? 1);
  const byId = new Map(layout.markers.map((m) => [m.id, m]));
  let use = markers.filter((m) => byId.has(m.id));
  if (use.length < minMarkers) return { ok: false, reason: "too_few_markers", markersUsed: use.length };
  const dropped: number[] = [];
  const outlierPx = opts.outlierPx ?? 2;
  const factor = opts.outlierFactor ?? 4;

  const solve = (set: readonly MarkerDetection[]) => {
    const world: Pt[] = [];
    const image: Pt[] = [];
    for (const m of set) {
      const c3 = markerCorners(byId.get(m.id)!, layout.markerMm);
      for (let i = 0; i < 4; i++) {
        world.push({ x: c3[i].x, y: c3[i].y });
        image.push(m.corners[i]);
      }
    }
    return poseFromPlanarPoints(K, world, image);
  };
  const residualOf = (pose: CameraPose, m: MarkerDetection) => {
    const c3 = markerCorners(byId.get(m.id)!, layout.markerMm);
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const q = project(K, pose, c3[i]);
      s += q ? (q.x - m.corners[i].x) ** 2 + (q.y - m.corners[i].y) ** 2 : 1e12;
    }
    return Math.sqrt(s / 4);
  };

  let r = solve(use);
  if (!r.ok) {
    // a gross outlier can wreck the closed-form start: try leaving each marker out once
    let bestSet: MarkerDetection[] | null = null;
    let best: ReturnType<typeof solve> | null = null;
    for (let i = 0; i < use.length && use.length > minMarkers; i++) {
      const set = use.filter((_, j) => j !== i);
      const rr = solve(set);
      if (rr.ok && (!best || !best.ok || rr.reprojRmsPx < best.reprojRmsPx)) {
        best = rr;
        bestSet = set;
      }
    }
    if (!best || !best.ok || !bestSet) return { ok: false, reason: "pose_failed", markersUsed: use.length, detail: r.reason };
    dropped.push(...use.filter((m) => !bestSet!.includes(m)).map((m) => m.id));
    use = bestSet;
    r = best;
  }
  // drop the worst marker while it is an outlier
  for (;;) {
    if (!r.ok) break;
    const pose = r.pose;
    const res = use.map((m) => residualOf(pose, m));
    const sorted = [...res].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    let worst = 0;
    for (let i = 1; i < res.length; i++) if (res[i] > res[worst]) worst = i;
    if (use.length <= minMarkers || res[worst] <= Math.max(outlierPx, factor * med)) break;
    const next = use.filter((_, i) => i !== worst);
    const rr = solve(next);
    if (!rr.ok) break;
    dropped.push(use[worst].id);
    use = next;
    r = rr;
  }
  if (!r.ok) return { ok: false, reason: "pose_failed", markersUsed: use.length };
  const pose = r.pose;
  const usedIds = new Set(use.map((m) => m.id));
  const residuals: MarkerResidual[] = markers
    .filter((m) => byId.has(m.id))
    .map((m) => ({ id: m.id, rmsPx: residualOf(pose, m), used: usedIds.has(m.id) }));
  const xs = use.flatMap((m) => m.corners.map((p) => p.x));
  const ys = use.flatMap((m) => m.corners.map((p) => p.y));
  const spread = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / Math.hypot(K.width, K.height);
  const ang = viewAngles(pose, opts.reference ?? handCentre(layout));
  return {
    ok: true,
    pose,
    reprojRmsPx: r.reprojRmsPx,
    markersUsed: use.length,
    residuals,
    droppedIds: dropped,
    cameraCenter: ang.center,
    elevationDeg: ang.elevationDeg,
    azimuthDeg: ang.azimuthDeg,
    distanceMm: ang.distanceMm,
    planeTiltDeg: r.planeTiltDeg,
    ambiguityWarning: r.ambiguityWarning,
    spreadFraction: spread,
  };
}
