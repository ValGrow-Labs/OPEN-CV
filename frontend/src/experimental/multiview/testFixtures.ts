// SIMULATED capture sets for the multiview tests (rendered once per process and cached). Test support only.
import type { Pt } from "../common";
import type { Vec3 } from "../reconstruction/linalg";
import { perturbPose } from "../reconstruction/synthetic";
import type { BoardViewInput } from "./reconstruct";
import { boardRig, makeBoardScene, moveHand, projectLandmarks, renderView, SKIN_TONES, type BoardCamera, type BoardScene, type RenderedView, type RGB } from "./scene";

export interface CaptureSpec {
  skin?: keyof typeof SKIN_TONES;
  highCount?: number;
  lowCount?: number;
  width?: number;
  height?: number;
  k1?: number;
  /** Landmark pixel noise (sigma). */
  landmarkNoisePx?: number;
  table?: RGB;
}

export interface Capture {
  scene: BoardScene;
  cameras: BoardCamera[];
  renders: RenderedView[];
  landmarks: (Pt | null)[][];
}

const cache = new Map<string, Capture>();

export function capture(spec: CaptureSpec = {}): Capture {
  const key = JSON.stringify(spec);
  const hit = cache.get(key);
  if (hit) return hit;
  const scene = makeBoardScene();
  const cameras = boardRig(scene, { highCount: spec.highCount ?? 0, lowCount: spec.lowCount ?? 16, width: spec.width, height: spec.height, k1: spec.k1 ?? 0.02 });
  const renders = cameras.map((c, i) => renderView(scene, c.intrinsics, c.pose, { skin: SKIN_TONES[spec.skin ?? "medium"], seed: i + 1, ...(spec.table ? { table: spec.table } : {}) }));
  const landmarks = cameras.map((c, i) => projectLandmarks(scene.landmarks, c.intrinsics, c.pose, { noisePx: spec.landmarkNoisePx ?? 1.5, seed: 100 + i }));
  const out = { scene, cameras, renders, landmarks };
  cache.set(key, out);
  return out;
}

/** The board views of a capture, optionally with perturbed poses (what the reconstruction is TOLD; the pictures stay
 *  rendered from the true poses) and with one view re-rendered with the hand moved by ``moved.offset``. */
export function boardViews(c: Capture, opts: { poseRotDeg?: number; poseTransMm?: number; seed?: number; moved?: { index: number; offset: Vec3; skin?: keyof typeof SKIN_TONES } } = {}): BoardViewInput[] {
  return c.cameras.map((cam, i) => {
    let image = c.renders[i].image;
    let landmarks = c.landmarks[i];
    if (opts.moved && opts.moved.index === i) {
      const moved = moveHand(c.scene, opts.moved.offset);
      image = renderView(moved, cam.intrinsics, cam.pose, { skin: SKIN_TONES[opts.moved.skin ?? "medium"], seed: i + 1 }).image;
      landmarks = projectLandmarks(moved.landmarks, cam.intrinsics, cam.pose, { noisePx: 1.5, seed: 100 + i });
    }
    const pose = opts.poseRotDeg || opts.poseTransMm ? perturbPose(cam.pose, opts.poseRotDeg ?? 0, opts.poseTransMm ?? 0, (opts.seed ?? 1) * 1000 + i) : cam.pose;
    return { id: cam.id, image, intrinsics: cam.intrinsics, pose, landmarks };
  });
}
