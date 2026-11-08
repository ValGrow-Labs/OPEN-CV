// Types and provisional constants of the EXPERIMENTAL dense surface-point scan (densescan/core).
//
// A dense dot grid over a segmented hand in ONE RGB frame. It is a 2D image-plane sampling of the visible hand, NOT a 3D
// scan: a point has physical depth only when a real metric depth map was applied to it (`depth: "measured"`). Every
// threshold below is a provisional engineering choice, unvalidated against real hands or physical measurements.
import type { BinaryMask, Quantity } from "../../common";

export type Region = "thumb" | "index" | "middle" | "ring" | "little" | "palm" | "wrist" | "unknown";
export type DepthKind = "measured" | "estimated" | "none";
export type PointReject = "outside_mask" | "near_edge" | "blurred" | "overexposed" | "underexposed" | "isolated" | "duplicate";

export const POINT_REJECTS: readonly PointReject[] = ["outside_mask", "near_edge", "blurred", "overexposed", "underexposed", "isolated", "duplicate"];

/** How the dots are laid out. Every distance is in SOURCE (camera frame) pixels. */
export interface DotConfig {
  /** Lattice step in source pixels (floored at 1 px: a finer step only interpolates the same pixels). */
  spacingPx: number;
  /** Optional target step in millimetres, converted with the coin scale and clamped to >= 1 px (see resolveSpacing). */
  targetSpacingMm?: number | null;
  /** Seeded jitter of each lattice point, as a fraction of the step (0 = exact lattice, max 0.45). */
  jitter: number;
  seed: number;
  /** A point closer than this to the mask edge (source px) is rejected as `near_edge`. */
  edgeMarginPx: number;
}

/** About 2,500 points on a hand that fills a 640 px wide frame, about 10,000 on a 1280 px frame. */
export const DEFAULT_DOT_CONFIG: DotConfig = { spacingPx: 4, targetSpacingMm: null, jitter: 0, seed: 1, edgeMarginPx: 2 };

export interface SurfacePoint {
  /** Stable id: the order of generation (row by row, top to bottom). */
  id: number;
  /** Position in source (camera frame) pixels. */
  x: number;
  y: number;
  /** Lattice indices (column, row). */
  gx: number;
  gy: number;
  region: Region;
  /** Distance to the nearest non-hand pixel, source px (chamfer approximation). */
  edgeDistPx: number;
  /** 0..1, from edge distance, local sharpness and exposure (provisional). */
  quality: number;
  accepted: boolean;
  reject: PointReject | null;
  /** "measured": from a real metric depth map; "estimated": interpolated relative landmark depth; "none". */
  depth: DepthKind;
  /** mm when measured, MediaPipe's relative units when estimated, null otherwise. */
  z: number | null;
}

export interface ImageRGBA {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface ValidateOptions {
  edgeMarginPx: number;
  /** Half-size of the square window (source px) the sharpness and exposure are read in. */
  windowRadius: number;
  /** Blurred when the local sharpness is below this share of the hand's median sharpness ... */
  blurRel: number;
  /** ... or below this absolute floor (grey levels of mean |Laplacian|). */
  blurAbsMin: number;
  /** Over- / under-exposed when this share of the window is clipped. */
  clipShare: number;
  overLuma: number;
  underLuma: number;
}

export const DEFAULT_VALIDATE: ValidateOptions = {
  edgeMarginPx: DEFAULT_DOT_CONFIG.edgeMarginPx,
  windowRadius: 2,
  blurRel: 0.35,
  blurAbsMin: 1.0,
  clipShare: 0.5,
  overLuma: 250,
  underLuma: 8,
};

/** An accepted point with fewer accepted lattice neighbours (8-neighbourhood) than this is `isolated`. */
export const ISOLATED_MIN_NEIGHBOURS = 2;
/** Two points closer than this share of the step are duplicates (the later one is rejected). */
export const DUPLICATE_SHARE = 0.25;
/** Mesh components with fewer triangles than this are dropped as noise. */
export const MIN_COMPONENT_TRIANGLES = 8;
/** Fewer accepted points than this rejects a scan. */
export const MIN_ACCEPTED_POINTS = 300;

export interface PointSet {
  frameWidth: number;
  frameHeight: number;
  points: SurfacePoint[];
  config: DotConfig;
  mmPerPx: number | null;
  spacing: { px: number; mm: Quantity; limitedByResolution: boolean; note: string };
  counts: { generated: number; accepted: number; rejected: number; byReason: Record<PointReject, number> };
  /** The hand mask the points were generated from (working size) and source px per working px; kept so the lattice mesh
   *  can check that a cell does not span a gap between fingers. */
  mask: BinaryMask | null;
  scaleToSource: number;
}
