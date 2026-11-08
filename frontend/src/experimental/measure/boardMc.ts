// The board-route runner for the Monte Carlo (EXPERIMENTAL; SIMULATED scenes only): re-runs multiview/reconstruct.ts
// reconstructFromBoardViews (landmark triangulation, carving in the board volume, meshing, gates, support labels,
// measurements, boardLimits) and the engine's value extraction (finger widths included) under one perturbation.
//
// Masks: the scene's EXACT hand masks with each view's outline offset by the drawn number of pixels (a threshold of the
// signed distance to the outline: pixel-quantised, the sub-pixel part of an offset changes which pixels flip only near
// diagonal edges). Segmentation itself is not re-run: its measured boundary error is the input sigma instead.
// Poses: the TRUE poses perturbed (what the pipeline is TOLD; the masks stay those of the true cameras). Independent
// rotation-about-the-centre and centre-shift errors are a pessimistic stand-in for marker PnP errors, which are
// correlated so that the board plane still reprojects well.
import type { BinaryMask, CameraPose, Intrinsics, Pt, Pt3 } from "../common";
import type { Vec3 } from "../reconstruction/linalg";
import { perturbPose, scaleFocal } from "../reconstruction/synthetic";
import { boardVolume, reconstructFromBoardViews, type BoardReconstruction, type BoardViewInput } from "../multiview/reconstruct";
import { projectLandmarks } from "../multiview/scene";
import { extractValues } from "./engine";
import type { Perturbation } from "./monteCarlo";

export interface BoardMcView {
  id: string;
  intrinsics: Intrinsics;
  pose: CameraPose;
  /** The exact hand mask of this view (SIMULATED). */
  mask: BinaryMask;
}

export interface BoardMcScene {
  views: BoardMcView[];
  /** The true 21 landmarks (board mm): re-projected with the drawn noise in every trial. */
  landmarks3d: readonly Pt3[];
}

/** Signed distance (px) to the outline: positive inside the hand (chamfer 1 / sqrt 2, pixel centres). */
export function signedDistance(mask: BinaryMask): Float32Array {
  const { width: w, height: h, data } = mask;
  const INF = 1e9;
  const dIn = new Float32Array(w * h), dOut = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    dIn[i] = data[i] ? INF : 0;
    dOut[i] = data[i] ? 0 : INF;
  }
  const chamfer = (d: Float32Array) => {
    const b = Math.SQRT2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 1);
        if (y > 0) {
          v = Math.min(v, d[i - w] + 1);
          if (x > 0) v = Math.min(v, d[i - w - 1] + b);
          if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
        }
        d[i] = v;
      }
    for (let y = h - 1; y >= 0; y--)
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let v = d[i];
        if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
        if (y < h - 1) {
          v = Math.min(v, d[i + w] + 1);
          if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
          if (x > 0) v = Math.min(v, d[i + w - 1] + b);
        }
        d[i] = v;
      }
  };
  chamfer(dIn);
  chamfer(dOut);
  const sd = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) sd[i] = data[i] ? dIn[i] - 0.5 : -(dOut[i] - 0.5);
  return sd;
}

/** The mask with its outline moved `offsetPx` outward (negative: inward). */
export function offsetMask(sd: Float32Array, width: number, height: number, offsetPx: number): BinaryMask {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = sd[i] + offsetPx > 0 ? 255 : 0;
  return { width, height, data: out };
}

/** Values of one board reconstruction keyed like the engine (finger widths included), times the scale factor. */
export function boardValues(rec: BoardReconstruction, scaleFactor = 1): Record<string, number | null> {
  const raw = extractValues({ mesh: rec.mesh, support: rec.support, supportLabels: rec.supportLabels, frame: rec.frame, fingers: rec.fingers, measurements: rec.measurements, supportBounded: true, up: [0, 0, 1] });
  const out: Record<string, number | null> = { __accepted: rec.accepted ? 1 : 0 };
  for (const r of raw) out[r.def.key] = r.q.value === null ? null : r.q.value * (r.def.unit === "mm2" ? scaleFactor * scaleFactor : scaleFactor);
  return out;
}

export interface BoardRunnerOptions {
  voxelMm: number;
  volume?: { min: Vec3; max: Vec3 };
}

/** A runner for runMonteCarlo: each call re-runs the board reconstruction under the perturbation. */
export function boardRouteRunner(scene: BoardMcScene, opts: BoardRunnerOptions): { runner: (p: Perturbation) => Record<string, number | null>; nViews: number; lastReconstruction: () => BoardReconstruction | null } {
  const sds = scene.views.map((v) => signedDistance(v.mask));
  const vol0 = opts.volume ?? boardVolume();
  let last: BoardReconstruction | null = null;
  const runner = (p: Perturbation): Record<string, number | null> => {
    const views: BoardViewInput[] = scene.views.map((v, i) => {
      const pp = p.pose[i];
      const pose = pp && (pp.rotDeg > 0 || pp.centreMm > 0) ? perturbPose(v.pose, pp.rotDeg, pp.centreMm, pp.seed) : v.pose;
      const lm: (Pt | null)[] = projectLandmarks(scene.landmarks3d, v.intrinsics, v.pose, { noisePx: p.landmarkNoisePx, seed: p.landmarkSeed + i });
      return {
        id: v.id,
        intrinsics: p.focalFactor === 1 ? v.intrinsics : scaleFocal(v.intrinsics, p.focalFactor),
        pose,
        mask: p.maskOffsetPx[i] ? offsetMask(sds[i], v.mask.width, v.mask.height, p.maskOffsetPx[i]) : v.mask,
        landmarks: lm,
      };
    });
    const volume = { min: [vol0.min[0] - p.voxelPhase[0], vol0.min[1] - p.voxelPhase[1], vol0.min[2]] as Vec3, max: vol0.max };
    last = reconstructFromBoardViews(views, { voxelMm: opts.voxelMm, volume, uncertainty: null });
    return boardValues(last, p.scaleFactor);
  };
  return { runner, nViews: scene.views.length, lastReconstruction: () => last };
}
