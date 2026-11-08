// Fallback hand frame from ONE view (EXPERIMENTAL): when the 21 landmarks cannot be triangulated (MediaPipe usually finds
// a hand seen from above but not one seen edge-on from a low view), lift the landmarks of a steep view onto the
// reconstructed metric mesh.
//
// For each landmark: the camera ray through its pixel (distortion removed) is intersected with the mesh; the first hit is
// on the back of the hand (or finger). A landmark is a JOINT CENTRE inside the finger, not a surface point, so its height
// is taken as HALF the local height of the mesh above the board (the hand rests on the board, z = 0). That is a model
// assumption, stated in the measurement basis. Only views looking down at 60 degrees or more are used, so the ray is
// close to vertical and the half-height assumption moves the point mainly in z (which the lengths along the fingers
// barely depend on). A ray that misses the mesh (a finger gap, a landmark off the hand) leaves the landmark missing.
import type { CameraPose, Intrinsics, Mesh, Pt, Pt3 } from "../common";
import { pixelToNormalized } from "../geometry/camera";

export interface LiftView {
  id: string;
  intrinsics: Intrinsics;
  pose: CameraPose;
  landmarks?: readonly (Pt | null)[] | null;
}

export interface LiftResult {
  viewId: string;
  elevationDeg: number;
  points: (Pt3 | null)[];
  /** Landmarks whose ray missed the mesh. */
  missed: number[];
}

const NEEDED = [0, 5, 9, 13, 17];

/** The steepest view (>= minElevationDeg) that has the landmarks a hand frame needs, lifted onto the mesh; null if none. */
export function liftLandmarksFromOneView(mesh: Mesh, views: readonly LiftView[], minElevationDeg = 60): LiftResult | null {
  const candidates = views
    .map((v) => ({ v, elev: elevationDeg(v.pose) }))
    .filter(({ v, elev }) => elev >= minElevationDeg && v.landmarks && NEEDED.every((i) => v.landmarks![i]))
    .sort((a, b) => b.elev - a.elev);
  if (!candidates.length) return null;
  const { v, elev } = candidates[0];
  const C = centre(v.pose);
  const R = v.pose.R;
  const points: (Pt3 | null)[] = [];
  const missed: number[] = [];
  v.landmarks!.forEach((p, i) => {
    if (!p) {
      points.push(null);
      return;
    }
    const n = pixelToNormalized(v.intrinsics, p.x, p.y);
    // direction in board coordinates: R^T [x, y, 1]
    const dc = [n.x, n.y, 1];
    const d: [number, number, number] = [R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2], R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2], R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2]];
    const hit = firstHit(mesh, C, d);
    if (!hit) {
      points.push(null);
      missed.push(i);
      return;
    }
    points.push({ x: hit[0], y: hit[1], z: hit[2] / 2 });
  });
  return { viewId: v.id, elevationDeg: elev, points, missed };
}

function centre(p: CameraPose): [number, number, number] {
  const { R, t } = p;
  return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
}

/** Elevation of the camera's viewing direction below the board plane (90 = looking straight down). */
function elevationDeg(p: CameraPose): number {
  // optical axis in board coordinates = third row of R
  const z = p.R[8];
  return (Math.asin(Math.min(1, Math.abs(z))) * 180) / Math.PI * (z < 0 ? 1 : -1);
}

/** Nearest ray-triangle intersection (Moller-Trumbore), or null. */
function firstHit(mesh: Mesh, o: readonly number[], d: readonly number[]): [number, number, number] | null {
  const V = mesh.vertices, I = mesh.indices;
  let best = Infinity;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
    const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const sx = o[0] - V[a], sy = o[1] - V[a + 1], sz = o[2] - V[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const w = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (w < 0 || u + w > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist > 1e-6 && dist < best) best = dist;
  }
  return best === Infinity ? null : [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best];
}
