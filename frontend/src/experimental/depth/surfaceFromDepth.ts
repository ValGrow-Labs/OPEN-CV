// A surface from a real METRIC depth map, or nothing. Never an invented one.
//
// Physical depth can only come from a depth sensor or a depth API (WebXR depth-sensing, a native ARCore/ARKit/LiDAR
// app) or from multi-view geometry with a known scale. A depth map that is merely RELATIVE (a monocular network, MediaPipe's
// z) must not be turned into millimetres: this function refuses it, and returns null with a reason when no depth is
// supplied. A single depth map also sees one side of the hand only, so the area it returns is the visible surface from that
// one viewpoint, not the surface of the hand.
import type { BinaryMask, Intrinsics, Mesh, Quantity } from "../common";
import { meshArea } from "../reconstruction/meshing";
import { backprojectDepth, triangulateDepthGrid, type DepthMap, type PointCloud } from "../reconstruction/pointcloud";

export type DepthSource = "webxr_depth" | "arcore_native" | "arkit_native" | "lidar" | "tof" | "multi_view_metric" | "synthetic_test" | "monocular_relative" | "mediapipe_world";

export interface MetricDepth {
  map: DepthMap;
  source: DepthSource;
  /** True only when the values are physical millimetres along the optical axis. */
  metric: boolean;
}

export interface SurfaceFromDepthOptions {
  /** Longest triangle edge kept, mm. Default 6. */
  maxEdgeMm?: number;
  minMm?: number;
  maxMm?: number;
  /** The share of hand-mask pixels that must have valid depth. Default 0.6. */
  minValidFraction?: number;
}

export type SurfaceFromDepth =
  | { ok: false; reason: string }
  | { ok: true; cloud: PointCloud; mesh: Mesh; visibleAreaMm2: Quantity; validFraction: number; notes: string[] };

export function surfaceFromDepth(depth: MetricDepth | null | undefined, mask: BinaryMask, K: Intrinsics, opts: SurfaceFromDepthOptions = {}): SurfaceFromDepth {
  if (!depth) return { ok: false, reason: "No depth map was supplied: this phone or browser gives no metric depth, so no 3D surface is estimated (RGB-only path)." };
  if (!depth.metric || depth.source === "monocular_relative" || depth.source === "mediapipe_world") {
    return { ok: false, reason: "The depth is relative (unknown scale), not physical millimetres: refusing to build a metric surface from it." };
  }
  const { map } = depth;
  if (map.data.length < map.width * map.height || map.width < 2 || map.height < 2) return { ok: false, reason: "The depth map is malformed." };
  let inside = 0;
  let valid = 0;
  for (let v = 0; v < map.height; v++)
    for (let u = 0; u < map.width; u++) {
      const mu = Math.min(mask.width - 1, Math.floor(((u + 0.5) * mask.width) / map.width));
      const mv = Math.min(mask.height - 1, Math.floor(((v + 0.5) * mask.height) / map.height));
      if (!mask.data[mv * mask.width + mu]) continue;
      inside++;
      const z = map.data[v * map.width + u];
      if (z > 0 && Number.isFinite(z)) valid++;
    }
  if (inside === 0) return { ok: false, reason: "The hand mask is empty." };
  const validFraction = valid / inside;
  if (validFraction < (opts.minValidFraction ?? 0.6)) {
    return { ok: false, reason: `Only ${(validFraction * 100).toFixed(0)} % of the hand has valid depth: not enough to build a surface (missing depth is never filled in).` };
  }
  const cloud = backprojectDepth(map, mask, K, { minMm: opts.minMm, maxMm: opts.maxMm });
  const mesh = triangulateDepthGrid(map, mask, K, opts.maxEdgeMm ?? 6);
  if (mesh.indices.length === 0) return { ok: false, reason: "The valid depth is too fragmented to triangulate." };
  return {
    ok: true,
    cloud,
    mesh,
    visibleAreaMm2: { value: meshArea(mesh), unit: "mm2", basis: "direct", note: `area of the surface visible from ONE viewpoint (depth source: ${depth.source}), not the whole hand; triangles across depth jumps are skipped` },
    validFraction,
    notes: [depth.source === "synthetic_test" ? "SYNTHETIC test depth: proves the maths only." : "Accuracy depends entirely on the depth source and has not been validated.", `${(validFraction * 100).toFixed(0)} % of the hand mask had valid depth.`],
  };
}
