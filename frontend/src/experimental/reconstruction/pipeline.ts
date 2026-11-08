// The reconstruction pipeline from calibrated silhouettes to a measured mesh, in one call:
//   masks + camera poses -> visual hull (carving) -> optional parametric prior -> isosurface -> clean-up (smoothing,
//   small components) -> quality gates -> measurements.
// EXPERIMENTAL. It assumes the camera poses and intrinsics are known and correct: estimating them from real phone
// footage is a separate, unsolved-here problem (see README). Nothing here is validated against physical measurements.
import type { Mesh } from "../common";
import { carveVisualHull, voxelVolumeMm3, type BoundsFace, type CarveView, type Occupancy } from "./carving";
import type { Vec3 } from "./linalg";
import { extractMesh, occupancyToField, removeSmallComponents, taubinSmooth } from "./meshing";
import { measureHand, type FingerAxis, type HandFrame, type HandMeasurements } from "./measure";
import { reconstructionQuality, vertexConfidence, type QualityThresholds, type ReconstructionQuality } from "./quality";

export interface ReconstructOptions {
  voxelMm: number;
  /** Carving tolerance (silhouettes a voxel may fall outside of). Default 0. */
  tolerance?: number;
  /** Blur passes before surface extraction (sub-voxel surface). Default 2. */
  blurPasses?: number;
  /** Taubin smoothing iterations. Default 6. */
  smoothIterations?: number;
  /** Drop components smaller than this share of the biggest. Default 0.02. */
  minComponentFraction?: number;
  /** Applied to the hull before meshing: a parametric prior that trims volume the views cannot confirm (see prior.ts). */
  prior?: (hull: Occupancy) => Occupancy;
  frame?: HandFrame;
  fingers?: readonly FingerAxis[];
  qualityThresholds?: Partial<QualityThresholds>;
  /** Faces of the search box where a cut is expected (the board under the hand, the wrist end); see quality.ts. */
  cutFaces?: readonly BoundsFace[];
  /** The hand's plane normal in world coordinates when known (the board's normal); see QualityInput. */
  planeNormal?: Vec3;
  /** The hand's long axis in world coordinates for the azimuth-gap gate; default [0, 1, 0]. See QualityInput. */
  handAxis?: Vec3;
  /** How a voxel that projects outside a picture is treated; default "carve". See CarveOptions. */
  outsideImage?: "carve" | "ignore";
  /** Research only: report mesh-wide measurements even when the quality gates failed. */
  ignoreGate?: boolean;
}

export interface Reconstruction {
  ok: boolean;
  /** Why there is no mesh, when ok is false. */
  failure?: string;
  hull: Occupancy;
  mesh: Mesh | null;
  confidence: Float32Array | null;
  quality: ReconstructionQuality | null;
  measurements: HandMeasurements | null;
  hullVolumeMm3: number;
  timingsMs: { carve: number; mesh: number; quality: number; measure: number; total: number };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function reconstructHand(views: readonly CarveView[], bounds: { min: Vec3; max: Vec3 }, opts: ReconstructOptions): Reconstruction {
  const t0 = now();
  let hull = carveVisualHull(views, bounds, { voxelMm: opts.voxelMm, tolerance: opts.tolerance, outsideImage: opts.outsideImage });
  const t1 = now();
  if (opts.prior) hull = opts.prior(hull);
  const hullVolumeMm3 = voxelVolumeMm3(hull);
  const timings = { carve: t1 - t0, mesh: 0, quality: 0, measure: 0, total: 0 };
  if (hullVolumeMm3 <= 0) {
    timings.total = now() - t0;
    return { ok: false, failure: "the silhouettes have no common volume (cameras or masks inconsistent)", hull, mesh: null, confidence: null, quality: null, measurements: null, hullVolumeMm3, timingsMs: timings };
  }
  let mesh = extractMesh(occupancyToField(hull, opts.blurPasses ?? 2), 0.5);
  mesh = removeSmallComponents(mesh, opts.minComponentFraction ?? 0.02).mesh;
  if ((opts.smoothIterations ?? 6) > 0) mesh = taubinSmooth(mesh, { iterations: opts.smoothIterations ?? 6 });
  const t2 = now();
  timings.mesh = t2 - t1;
  if (mesh.indices.length === 0) {
    timings.total = now() - t0;
    return { ok: false, failure: "no surface could be extracted", hull, mesh: null, confidence: null, quality: null, measurements: null, hullVolumeMm3, timingsMs: timings };
  }
  const confidence = vertexConfidence(mesh, views);
  const quality = reconstructionQuality({ mesh, views, occupancy: hull, confidence, cutFaces: opts.cutFaces, planeNormal: opts.planeNormal, handAxis: opts.handAxis }, opts.qualityThresholds);
  const t3 = now();
  timings.quality = t3 - t2;
  const measurements = opts.frame ? measureHand(mesh, opts.frame, { fingers: opts.fingers, accepted: quality.accepted, ignoreGate: opts.ignoreGate }) : null;
  const t4 = now();
  timings.measure = t4 - t3;
  timings.total = t4 - t0;
  return { ok: true, hull, mesh, confidence, quality, measurements, hullVolumeMm3, timingsMs: timings };
}
