// Types of the EXPERIMENTAL measurement engine with numeric uncertainty (Stage 5).
//
// Every reported value carries: the value, its definition (what is measured, which datums), the method, the data source
// (views, mesh region, landmarks), the basis (direct / model / none) and a NUMERIC uncertainty propagated from stated input
// sigmas. Every input sigma carries its origin: SIMULATED (measured in one of our simulated tests, cited), ASSUMED (nobody
// measured it) or EXACT (zero by construction in a simulation, e.g. the printed board's size in a rendered scene).
//
// Nothing here is validated against a physical measurement. An uncertainty computed from SIMULATED or ASSUMED sigmas is a
// model statement about the stated inputs, NOT a real-world accuracy.
import type { Quantity } from "../common";

/** Where an input sigma comes from. */
export type SigmaOrigin = "SIMULATED" | "ASSUMED" | "EXACT" | "RUNTIME";

/** One input standard uncertainty with its provenance. `source` cites the test / document, or says why it is assumed. */
export interface StatedSigma {
  value: number;
  origin: SigmaOrigin;
  source: string;
}

/** What fixes the metric scale of the scene. */
export type ScaleReference = "board_print" | "coin" | "none";

/**
 * The capture's input uncertainties, INDEPENDENT of how they were obtained: the board route fills them from its
 * calibration and pose tests, a board-free route (structure from motion + coin scale) fills them from its own bundle
 * adjustment and coin fit. All are one-sigma standard uncertainties.
 */
export interface CaptureUncertainty {
  /** Free text naming the route ("board", "board-free (sfm + coin)", ...). */
  route: string;
  /** Relative standard uncertainty of the focal length, shared by every view (0.001 = 0.1 %). */
  focalRel: StatedSigma;
  /** RMS rotation-angle error of each view's pose, degrees (independent between views; random axis). */
  poseRotDeg: StatedSigma;
  /** RMS camera-centre error of each view's pose, millimetres (independent between views; random direction). */
  poseCentreMm: StatedSigma;
  /** Relative standard uncertainty of the scene scale (the printed board's true size, or the coin's 3D fit). */
  scaleRel: StatedSigma;
  scaleReference: ScaleReference;
  /** Standard uncertainty of the silhouette boundary position, in pixels OF THE MASKS USED FOR CARVING (modelled as an
   *  outward/inward offset of each view's whole outline, independent between views). */
  maskBoundaryPx: StatedSigma;
  /** Standard uncertainty of each 2D landmark, pixels of the landmark pictures (Monte Carlo input). */
  landmarkPx: StatedSigma;
  /** Standard uncertainty of each 3D landmark (triangulated or lifted) along any axis, mm (analytic input). */
  landmark3dMm: StatedSigma;
}

/** The camera geometry needed to turn pixels into millimetres at the hand. */
export interface CameraForScale {
  id: string;
  /** Focal length in pixels of the masks used for carving. */
  fxPx: number;
  /** Distance from the camera centre to the hand (mm), e.g. to the hand's centroid. */
  distanceMm: number;
}

export interface ResolutionSummary {
  /** Millimetres per mask pixel at the hand, per view: distance / fx. */
  perView: { id: string; mmPerPx: number }[];
  medianMmPerPx: number;
  minMmPerPx: number;
  maxMmPerPx: number;
  /** Median camera-to-hand depth, mm. */
  medianDepthMm: number;
  note: string;
}

/** Keys of the input factors (used by the analytic budget and the Monte Carlo). */
export type FactorKey = "focal" | "pose" | "scale" | "boundary" | "voxel" | "landmarks";
export const FACTOR_KEYS: readonly FactorKey[] = ["focal", "pose", "scale", "boundary", "voxel", "landmarks"];

export interface UncertaintyComponent {
  factor: FactorKey;
  /** Standard uncertainty contributed to the value (mm, or mm^2 for an area). */
  sigma: number;
  /** The sensitivity rule used (first-order coefficient and how it was obtained). */
  rule: string;
  /** Provenance of the input sigma(s) behind this component. */
  inputOrigin: SigmaOrigin;
  inputSource: string;
}

export interface ValueUncertainty {
  /** Combined standard uncertainty u_c (root-sum-square of the components), mm (mm^2 for an area). */
  standard: number;
  /** Expanded uncertainty U = k u_c with k = 2 (about 95 % for a normal distribution). */
  expanded95: number;
  coverageFactor: 2;
  /** value - U, value + U. */
  interval95: [number, number];
  method: "analytic first-order" | "monte carlo";
  components: UncertaintyComponent[];
  dominant: FactorKey;
  /** What the interval does NOT cover (stated every time). */
  excludes: string;
}

/** Where the value comes from. */
export interface DataSource {
  /** View ids whose silhouettes carved the mesh (all used views: a hull depends on every one). */
  views: string[];
  /** The mesh region read (e.g. "section 8 mm proximal to the knuckle line, observed + support_plane vertices"). */
  meshRegion: string;
  /** MediaPipe landmark indices that define the datums, empty if none. */
  landmarks: number[];
  /** How the landmarks were obtained: triangulated from several views, lifted from one view, or none. */
  landmarkSource: "triangulated" | "lifted_one_view" | "given" | "none";
}

export type MeasureKind = "length" | "extent" | "loop" | "area";

export interface MeasuredValue {
  key: string;
  label: string;
  unit: "mm" | "mm2";
  kind: MeasureKind;
  /** null when withheld (basis "none"). */
  value: number | null;
  basis: Quantity["basis"];
  /** Why the basis (the assumption it rests on), or why it is withheld. */
  basisNote: string;
  /** True when the value is an upper bound (visual hull; board-bounded loop). */
  upperBound: boolean;
  definition: string;
  method: string;
  dataSource: DataSource;
  /** null when the value is withheld or the uncertainty cannot be stated (the note says why). */
  uncertainty: ValueUncertainty | null;
  uncertaintyNote: string | null;
  /** Smallest defensible reporting increment (mm): the 1-2-5 step at or below u_c (see README, the 0.1 mm question). */
  reportingIncrementMm: number | null;
  /** The value rounded to that increment (what a page should print), null when withheld. */
  reported: number | null;
}

export interface MeasurementReport {
  /** Always shown with the values. */
  label: string;
  route: string;
  accepted: boolean;
  inputs: CaptureUncertainty;
  voxelMm: number;
  resolution: ResolutionSummary | null;
  values: MeasuredValue[];
  /** Per-key lookup of `values`. */
  byKey: Record<string, MeasuredValue>;
  notes: string[];
}
