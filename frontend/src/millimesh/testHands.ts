// Synthetic hand frames for the MILLIMESH unit tests (not shipped: only the tests import it). The generic hand of
// hand3d/handModel.ts is placed in MediaPipe's world frame (x right, y down, z away from the camera) and turned
// by known angles, so the tests know exactly where the "phone" is.
import type { CoinObservation, FrameObservation, Point } from "../api/types";
import { genericHand } from "../hand3d/handModel";

export const HAND_LENGTH_M = 0.19;
export const PX_PER_M = 2600;
export const COIN_MM = 23;

/** Deterministic noise in -1..1. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const rad = (d: number) => (d * Math.PI) / 180;

/** The generic hand with a flat palm: the knuckle line lies in the wrist's plane, so the palm normal is exactly +z (the
 *  generic hand is slightly cupped, which would make "straight at the camera" read a few degrees off). */
export function flatHand() {
  return genericHand().map((p, i) => ({ ...p, z: [5, 9, 13, 17].includes(i) ? 0 : p.z }));
}

export interface Pose {
  /** Turn about the vertical axis: tilts the palm towards the thumb (+) or the little finger (-). */
  yaw?: number;
  /** Turn about the horizontal axis: tilts the palm towards the fingertips or the wrist. */
  pitch?: number;
  /** Extra turn about the vertical axis applied first (180: the back of the hand towards the camera). */
  flip?: number;
  /** Position noise per coordinate in metres. */
  noiseM?: number;
  seed?: number;
  coin?: boolean;
  coinAccepted?: boolean;
  hand?: "left" | "right";
}

const coinObs = (accepted: boolean): CoinObservation => ({
  center_x: 640 + 60,
  center_y: 360 + 120,
  major_axis_px: (COIN_MM / 1000) * PX_PER_M,
  minor_axis_px: (COIN_MM / 1000) * PX_PER_M,
  angle_deg: 0,
  edge_support: 0.95,
  max_angular_gap_deg: 10,
  fit_residual_px: 0.3,
  edge_width_px: 2.5,
  glare_fraction: 0,
  contrast: 0.1,
  n_edge_points: 120,
  confidence: 0.9,
  accepted,
  method: "test",
  reasons: [],
});

/** One frame of the generic (right) hand turned by `pose`, as the live scanner would hand it over. */
export function handFrame(pose: Pose = {}): FrameObservation {
  const noise = rng(pose.seed ?? 1);
  const n = pose.noiseM ?? 0;
  const mirror = pose.hand === "left" ? -1 : 1;
  const world: Point[] = flatHand().map((g) => {
    // model space (y up, z to the viewer) -> world (y down, z away), hand length 0.19 m
    let p = { x: mirror * g.x * HAND_LENGTH_M, y: -g.y * HAND_LENGTH_M, z: -g.z * HAND_LENGTH_M };
    // the wrist is the origin; turn about it (the middle of the hand would be nicer, but the angle is what matters)
    const f = rad(pose.flip ?? 0);
    p = { x: p.x * Math.cos(f) + p.z * Math.sin(f), y: p.y, z: -p.x * Math.sin(f) + p.z * Math.cos(f) };
    const yw = rad(pose.yaw ?? 0);
    p = { x: p.x * Math.cos(yw) + p.z * Math.sin(yw), y: p.y, z: -p.x * Math.sin(yw) + p.z * Math.cos(yw) };
    const pt = rad(pose.pitch ?? 0);
    p = { x: p.x, y: p.y * Math.cos(pt) - p.z * Math.sin(pt), z: p.y * Math.sin(pt) + p.z * Math.cos(pt) };
    return { x: p.x + n * noise(), y: p.y + n * noise(), z: p.z + n * noise() };
  });
  const landmarks: Point[] = world.map((p) => ({ x: 640 + p.x * PX_PER_M, y: 360 + 300 + p.y * PX_PER_M, z: p.z * PX_PER_M }));
  const wantCoin = pose.coin ?? true;
  return {
    timestamp_ms: 0,
    image_width: 1280,
    image_height: 720,
    landmarks,
    world_landmarks: world,
    // MediaPipe labels as if the picture were mirrored: an actual right hand is labelled "Left".
    handedness: pose.hand === "left" ? "Right" : "Left",
    handedness_score: 0.98,
    coin: wantCoin ? coinObs(pose.coinAccepted ?? true) : null,
    brightness: 120,
  };
}

/** A run of frames: the phone rests at each of the given tilts (degrees) for `hold` frames, then moves on to the next
 *  (a slow move), each frame with its own noise. */
export function sweep(count: number, tilts: { yaw?: number; pitch?: number }[], base: Pose = {}, hold = 8): FrameObservation[] {
  return Array.from({ length: count }, (_, i) => handFrame({ ...base, ...tilts[Math.floor(i / hold) % tilts.length], seed: (base.seed ?? 1) * 1000 + i }));
}
