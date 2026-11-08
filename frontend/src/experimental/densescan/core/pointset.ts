// Assembling a point set from one frozen frame, and the point cloud it can (honestly) give.
import type { BinaryMask, ImageScale, Pt, Pt3 } from "../../common";
import { dedupeAndFilter, generateSurfacePoints, resolveSpacing, validatePoints } from "./points";
import { estimateRelativeDepth, labelRegions } from "./regions";
import { DEFAULT_DOT_CONFIG, POINT_REJECTS, type DepthKind, type DotConfig, type ImageRGBA, type PointReject, type PointSet, type SurfacePoint, type ValidateOptions } from "./types";

export interface BuildPointSetInput {
  /** The hand mask (from segmentation/) at its working size. */
  mask: BinaryMask;
  /** Source (camera frame) pixels per working pixel of the mask. */
  scaleToSource: number;
  frameWidth: number;
  frameHeight: number;
  /** The frozen source frame. Without it the image checks (sharpness, exposure) are skipped and only the edge margin applies. */
  image?: ImageRGBA | null;
  /** The 21 landmarks in source px, for regions. */
  landmarks?: readonly Pt[] | null;
  /** Landmarks with MediaPipe's RELATIVE z, for the "estimated" depth label (never metric). */
  landmarks3d?: readonly Pt3[] | null;
  /** The coin scale of this frame, for the millimetre spacing (model) and measurements. */
  scale?: ImageScale | null;
  config?: Partial<DotConfig>;
  validate?: Partial<ValidateOptions>;
}

export function countPoints(points: SurfacePoint[]): PointSet["counts"] {
  const byReason = Object.fromEntries(POINT_REJECTS.map((r) => [r, 0])) as Record<PointReject, number>;
  let accepted = 0;
  for (const p of points) {
    if (p.accepted) accepted++;
    else if (p.reject) byReason[p.reject]++;
  }
  return { generated: points.length, accepted, rejected: points.length - accepted, byReason };
}

/** generate -> validate (image checks if the frame is given, else edge margin only) -> duplicates and isolated points ->
 *  regions (if landmarks) -> estimated relative depth (if 3D landmarks). Every count comes from the points themselves. */
export function buildPointSet(input: BuildPointSetInput): PointSet {
  const cfg: DotConfig = { ...DEFAULT_DOT_CONFIG, ...input.config };
  const scale = input.scale ?? null;
  const sp = resolveSpacing(cfg, scale);
  const used: DotConfig = { ...cfg, spacingPx: sp.spacingPx };
  let pts = generateSurfacePoints(input.mask, input.scaleToSource, used);
  if (input.image) {
    pts = validatePoints(pts, input.image, input.mask, input.scaleToSource, { edgeMarginPx: used.edgeMarginPx, ...input.validate });
  } else {
    pts = pts.map((p) => (p.edgeDistPx < used.edgeMarginPx ? { ...p, accepted: false, reject: "near_edge" as const, quality: 0 } : p));
  }
  pts = dedupeAndFilter(pts, used);
  if (input.landmarks) pts = labelRegions(pts, input.landmarks);
  if (input.landmarks3d) pts = estimateRelativeDepth(pts, input.landmarks3d);
  return {
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    points: pts,
    config: used,
    mmPerPx: scale && scale.mmPerPx > 0 ? scale.mmPerPx : null,
    spacing: { px: sp.spacingPx, mm: sp.spacingMm, limitedByResolution: sp.limitedByResolution, note: sp.note },
    counts: countPoints(pts),
    mask: input.mask,
    scaleToSource: input.scaleToSource,
  };
}

/** The accepted points as a point cloud. x, y are always the source-frame pixel positions (unchanged). z is chosen
 *  honestly: if any accepted point has MEASURED depth, only measured points are included and z is millimetres; else if
 *  any has an ESTIMATED depth, z is MediaPipe's relative units; else z is 0 and its unit null: a flat 2D grid, NOT a 3D
 *  scan. Units are reported, so a caller can never mistake one kind for another. */
export function buildPointCloud(set: PointSet): {
  positions: Float32Array;
  depth: DepthKind[];
  units: { xy: "px"; z: "mm" | "relative" | null };
  count: number;
} {
  const acc = set.points.filter((p) => p.accepted);
  const measured = acc.filter((p) => p.depth === "measured" && p.z !== null);
  const estimated = acc.filter((p) => p.depth === "estimated" && p.z !== null);
  const use = measured.length ? measured : estimated.length ? estimated : acc;
  const zUnit: "mm" | "relative" | null = measured.length ? "mm" : estimated.length ? "relative" : null;
  const positions = new Float32Array(use.length * 3);
  use.forEach((p, i) => {
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = zUnit === null ? 0 : (p.z as number);
  });
  return { positions, depth: use.map((p) => (zUnit === null ? "none" : p.depth)), units: { xy: "px", z: zUnit }, count: use.length };
}
