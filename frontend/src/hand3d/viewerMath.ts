// The maths of the 3D landmark viewer (pure: no DOM, no three.js), so it is tested without WebGL.
//
// AXIS CONVENTION
//   Input:  MediaPipe HandLandmarker WORLD landmarks: metres, origin near the hand's own centre, x to the right
//           of the picture, y DOWN, z along the camera's viewing direction (smaller z = nearer the camera).
//   Output: scene units (three.js): x right, y UP, z toward the viewer, so that the default camera, which sits on
//           the +z axis looking at the origin, sees the hand as the camera did.
//             X =  x * S        (S = SCENE_PER_METRE)
//             Y = -y * S
//             Z = -z * S
//   `mirrored` (front camera: the picture the customer sees is a mirror image) flips X, so the 3D hand looks like
//   the picture on screen. The reported handedness never flips geometry.
//   The result is centred on the middle of the hand's x/y extent and the mean depth, so the hand sits at the
//   origin however far the world origin drifts.
//
//   Depth is MediaPipe's relative estimate: if any z is not a finite number the whole hand is treated as 2D only
//   and z is flattened to 0 (never invented).

import { JOINT_COUNT } from "./landmarkTopology";

export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

/** Scene units per metre: a 19 cm hand is about 1.9 units tall. */
export const SCENE_PER_METRE = 10;

/** True when ``points`` holds the 21 landmarks with finite x and y. */
export function isUsableHand(points: readonly WorldPoint[] | null | undefined): points is readonly WorldPoint[] {
  if (!points || points.length < JOINT_COUNT) return false;
  for (let i = 0; i < JOINT_COUNT; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  return true;
}

/** True when every one of the 21 landmarks has a finite depth. */
export function hasDepth(points: readonly WorldPoint[]): boolean {
  for (let i = 0; i < JOINT_COUNT; i++) if (!Number.isFinite(points[i].z)) return false;
  return true;
}

/** Fill ``out`` (63 numbers: x, y, z per joint) with the scene positions of ``points``. Returns whether depth was
 *  available (false: z is 0 for every joint). No allocation. */
export function toScene(points: readonly WorldPoint[], mirrored: boolean, out: Float32Array | number[]): boolean {
  const depth = hasDepth(points);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let sumZ = 0;
  for (let i = 0; i < JOINT_COUNT; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (depth) sumZ += p.z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = depth ? sumZ / JOINT_COUNT : 0;
  const sx = mirrored ? -SCENE_PER_METRE : SCENE_PER_METRE;
  for (let i = 0; i < JOINT_COUNT; i++) {
    const p = points[i];
    out[i * 3] = (p.x - cx) * sx;
    out[i * 3 + 1] = -(p.y - cy) * SCENE_PER_METRE;
    out[i * 3 + 2] = depth ? -(p.z - cz) * SCENE_PER_METRE : 0;
  }
  return depth;
}

/** Ease ``cur`` toward ``target`` in place by the share ``k`` (0..1); no allocation. */
export function smoothInto(cur: Float32Array | number[], target: Float32Array | number[], k: number): void {
  const a = Math.min(1, Math.max(0, k));
  for (let i = 0; i < cur.length; i++) cur[i] += (target[i] - cur[i]) * a;
}

/** The camera distance at which a sphere of ``radius`` fills the view of a camera with vertical field of view
 *  ``fovDeg`` and the given aspect (width / height), on both axes. */
export function fitDistance(radius: number, fovDeg: number, aspect: number): number {
  const v = (fovDeg * Math.PI) / 180 / 2;
  const h = Math.atan(Math.tan(v) * Math.max(0.1, aspect));
  return radius / Math.sin(Math.min(v, h));
}

/** The largest distance of any joint from the centre of the scene positions (a fit radius for the camera). */
export function sceneRadius(scene: Float32Array | number[]): number {
  let r2 = 0;
  for (let i = 0; i < JOINT_COUNT; i++) {
    const d = scene[i * 3] ** 2 + scene[i * 3 + 1] ** 2 + scene[i * 3 + 2] ** 2;
    if (d > r2) r2 = d;
  }
  return Math.sqrt(r2);
}

/** Which side of the hand faces the camera: true palm, false back of the hand, null when it cannot be told
 *  (no handedness, or the hand is edge-on). ``handedness`` is the ACTUAL hand ("Left" or "Right"; the caller turns
 *  MediaPipe's mirrored report into the actual one). A right palm shown to the camera, fingers up, has its index
 *  knuckle on the picture's right, which makes cross(p5 - p0, p17 - p0).z negative in x-right, y-down
 *  coordinates; a left palm gives the opposite sign. */
export function palmFacesCamera(points: readonly WorldPoint[], handedness: string | null, minAbs = 1e-5): boolean | null {
  if (handedness !== "Left" && handedness !== "Right") return null;
  const a = { x: points[5].x - points[0].x, y: points[5].y - points[0].y };
  const b = { x: points[17].x - points[0].x, y: points[17].y - points[0].y };
  const z = a.x * b.y - a.y * b.x;
  if (!(Math.abs(z) >= minAbs)) return null;
  return handedness === "Right" ? z < 0 : z > 0;
}

export const CAPTION = "Estimated 3D landmark view. Depth is MediaPipe's relative estimate, not a calibrated measurement.";
export const CAPTION_2D = "2D points only";

/** A short label for the hand chip. */
export function handLabel(handedness: string | null): string {
  return handedness === "Left" ? "Left hand" : handedness === "Right" ? "Right hand" : "Hand";
}
