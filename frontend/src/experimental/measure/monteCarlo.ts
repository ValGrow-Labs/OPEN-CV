// Monte Carlo propagation of the capture's input uncertainties THROUGH A WHOLE PIPELINE (EXPERIMENTAL).
//
// A perturbation draws, from the stated sigmas: one shared focal factor, one shared scale factor, an independent pose
// error per view (rotation vector and centre shift, isotropic Gaussian with the stated RMS), an independent outline
// offset per view (mask pixels), landmark pixel noise, and a random phase of the voxel grid. A runner (a closure that
// re-runs the pipeline with that perturbation: carving, meshing, gates, measurement) returns the values; the statistics
// are taken against the unperturbed run. Pipeline-agnostic: boardMc.ts gives the board-route runner; a board-free route
// can supply its own.
import type { Vec3 } from "../reconstruction/linalg";
import { gaussian, makeRng } from "../reconstruction/rng";
import type { CaptureUncertainty, FactorKey } from "./types";

export interface Perturbation {
  /** Multiply the focal length the pipeline is TOLD by this (1 + e, e ~ N(0, sigma_f)). */
  focalFactor: number;
  /** Multiply every output length by this (1 + e, e ~ N(0, sigma_s)); areas by its square. Exact: a hull of a scene
   *  scaled by s is the hull scaled by s (up to the voxel phase, perturbed separately). */
  scaleFactor: number;
  /** Per view: rotation angle (deg, about a random axis) and centre shift (mm, random direction), and the seed of the
   *  directions. Magnitudes are |N3| x sigma / sqrt 3, so their RMS is the stated sigma. */
  pose: { rotDeg: number; centreMm: number; seed: number }[];
  /** Per view: outline offset in mask pixels (positive = outward). */
  maskOffsetPx: number[];
  landmarkNoisePx: number;
  landmarkSeed: number;
  /** Shift of the voxel grid origin, mm, each in [0, voxel) (the support face stays on its plane). */
  voxelPhase: Vec3;
}

export const NO_PERTURBATION = (nViews: number): Perturbation => ({
  focalFactor: 1,
  scaleFactor: 1,
  pose: Array.from({ length: nViews }, () => ({ rotDeg: 0, centreMm: 0, seed: 1 })),
  maskOffsetPx: new Array(nViews).fill(0),
  landmarkNoisePx: 0,
  landmarkSeed: 1,
  voxelPhase: [0, 0, 0],
});

const norm3 = (rng: () => number) => Math.hypot(gaussian(rng), gaussian(rng), gaussian(rng));

/** Draw one perturbation; factors not in `factors` stay at their unperturbed value. */
export function drawPerturbation(cap: CaptureUncertainty, nViews: number, voxelMm: number, factors: ReadonlySet<FactorKey>, rng: () => number): Perturbation {
  const p = NO_PERTURBATION(nViews);
  if (factors.has("focal")) p.focalFactor = 1 + cap.focalRel.value * gaussian(rng);
  if (factors.has("scale")) p.scaleFactor = 1 + cap.scaleRel.value * gaussian(rng);
  if (factors.has("pose"))
    p.pose = p.pose.map(() => ({ rotDeg: (cap.poseRotDeg.value / Math.sqrt(3)) * norm3(rng), centreMm: (cap.poseCentreMm.value / Math.sqrt(3)) * norm3(rng), seed: Math.floor(rng() * 1e9) }));
  if (factors.has("boundary")) p.maskOffsetPx = p.maskOffsetPx.map(() => cap.maskBoundaryPx.value * gaussian(rng));
  if (factors.has("landmarks")) {
    p.landmarkNoisePx = cap.landmarkPx.value;
    p.landmarkSeed = Math.floor(rng() * 1e9);
  }
  if (factors.has("voxel")) p.voxelPhase = [rng() * voxelMm, rng() * voxelMm, 0];
  return p;
}

export interface McStats {
  key: string;
  nominal: number | null;
  /** Trials with a value. */
  n: number;
  /** Trials where the value was withheld (null). */
  nulls: number;
  mean: number;
  sd: number;
  /** mean - nominal: a bias of the pipeline under these errors (NOT corrected anywhere). */
  meanShift: number;
  /** Empirical 2.5 % and 97.5 % points of (value - nominal). */
  p025: number;
  p975: number;
  /** Root-mean-square of (value - nominal): sd and bias together. */
  rmsDev: number;
}

export interface McResult {
  factors: FactorKey[];
  trials: number;
  seed: number;
  stats: Record<string, McStats>;
  samples: Record<string, number | null>[];
  /** Share of trials whose reconstruction passed its gates (when the runner reports `__accepted`). */
  acceptedShare: number | null;
  ms: number;
}

const quantile = (s: number[], q: number) => {
  if (!s.length) return NaN;
  const x = (s.length - 1) * q;
  const lo = Math.floor(x), hi = Math.ceil(x);
  return s[lo] + (s[hi] - s[lo]) * (x - lo);
};

export function summarise(nominal: Record<string, number | null>, samples: readonly Record<string, number | null>[]): Record<string, McStats> {
  const out: Record<string, McStats> = {};
  for (const key of Object.keys(nominal)) {
    if (key.startsWith("__")) continue;
    const nom = nominal[key];
    const vals = samples.map((s) => s[key]).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
    const n = vals.length;
    const mean = n ? vals.reduce((a, b) => a + b, 0) / n : NaN;
    const sd = n > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
    const dev = nom === null ? [] : vals.map((v) => v - nom).sort((a, b) => a - b);
    out[key] = {
      key,
      nominal: nom,
      n,
      nulls: samples.length - n,
      mean,
      sd,
      meanShift: nom === null ? NaN : mean - nom,
      p025: quantile(dev, 0.025),
      p975: quantile(dev, 0.975),
      rmsDev: dev.length ? Math.sqrt(dev.reduce((a, b) => a + b * b, 0) / dev.length) : NaN,
    };
  }
  return out;
}

/** Run `trials` perturbed pipelines. `runner(NO_PERTURBATION)` should be supplied as `nominal` (computed once). */
export function runMonteCarlo(
  cap: CaptureUncertainty,
  nViews: number,
  voxelMm: number,
  nominal: Record<string, number | null>,
  runner: (p: Perturbation, trial: number) => Record<string, number | null>,
  opts: { trials: number; seed?: number; factors: readonly FactorKey[] },
): McResult {
  const t0 = performance.now();
  const rng = makeRng(opts.seed ?? 1);
  const set = new Set(opts.factors);
  const samples: Record<string, number | null>[] = [];
  for (let k = 0; k < opts.trials; k++) samples.push(runner(drawPerturbation(cap, nViews, voxelMm, set, rng), k));
  const acc = samples.map((s) => s.__accepted).filter((v): v is number => typeof v === "number");
  return {
    factors: [...opts.factors],
    trials: opts.trials,
    seed: opts.seed ?? 1,
    stats: summarise(nominal, samples),
    samples,
    acceptedShare: acc.length ? acc.reduce((a, b) => a + b, 0) / acc.length : null,
    ms: performance.now() - t0,
  };
}
