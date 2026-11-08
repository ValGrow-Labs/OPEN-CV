// Reconstruction quality: how well does the mesh agree with the evidence it was built from, and is there enough
// evidence at all? These gates decide whether a surface area (or any mesh-wide figure) may be reported. They are
// consistency checks against the INPUT silhouettes; they cannot detect an error that every input shares (a wrong
// scale, a systematic pose error), and passing them is not accuracy.
import type { BinaryMask, CameraPose, Intrinsics, Mesh } from "../common";
import { BOUNDS_FACES, boundsContact, viewCoverage, type BoundsContact, type BoundsFace, type CarveView, type Occupancy, unconstrainedSurfaceFraction } from "./carving";
import { dot, normalize, projectPoint, symmetricEigen, type Vec3 } from "./linalg";
import { meshBounds, topologyReport, type TopologyReport } from "./meshing";

/** Distance in pixels from every pixel to the nearest silhouette boundary pixel (3-4 chamfer, ~ Euclidean). */
export function boundaryDistance(mask: BinaryMask): Float32Array {
  const { width: w, height: h, data } = mask;
  const INF = 1e9;
  const d = new Float32Array(w * h).fill(INF);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = data[i] > 0;
      const diff = (x > 0 && (data[i - 1] > 0) !== v) || (x < w - 1 && (data[i + 1] > 0) !== v) || (y > 0 && (data[i - w] > 0) !== v) || (y < h - 1 && (data[i + w] > 0) !== v);
      if (diff && v) d[i] = 0; // the hand pixels that touch background are the boundary
    }
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - w] + a);
        if (x > 0) v = Math.min(v, d[i - w - 1] + b);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + a);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + a);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
        if (x > 0) v = Math.min(v, d[i + w - 1] + b);
      }
      d[i] = v;
    }
  return d;
}

/** Per-vertex observation confidence in 0..1: how many views have a silhouette BOUNDARY within ``tolPx`` pixels of the
 *  vertex's projection (a surface point is directly observed where a silhouette contour passes through it). One such
 *  view gives 0.5, two or more give 1. Vertices that no contour touches are only implied by the other views.
 *  A view with a ``known`` mask does not count a contour that lies on, or within ``tolPx`` + 1 pixels of, an UNKNOWN
 *  pixel: a mask edge against an unknown region is not an observed silhouette contour. */
export function vertexConfidence(mesh: Mesh, views: readonly CarveView[], tolPx = 1.5): Float32Array {
  const nv = mesh.vertices.length / 3;
  const counts = new Uint8Array(nv);
  for (const view of views) {
    const dist = boundaryDistance(view.mask);
    const unknownDist = view.known ? boundaryDistance(invertMask(view.known)) : null;
    const { mask, intrinsics: K, pose } = view;
    const sx = mask.width / K.width, sy = mask.height / K.height;
    for (let i = 0; i < nv; i++) {
      const p = projectPoint([mesh.vertices[i * 3], mesh.vertices[i * 3 + 1], mesh.vertices[i * 3 + 2]], K, pose);
      if (!p) continue;
      const u = Math.floor(p.u * sx), v = Math.floor(p.v * sy);
      if (u < 0 || v < 0 || u >= mask.width || v >= mask.height) continue;
      const pix = v * mask.width + u;
      if (unknownDist && (view.known!.data[pix] === 0 || unknownDist[pix] <= tolPx + 1)) continue;
      if (dist[pix] <= tolPx) counts[i]++;
    }
  }
  const out = new Float32Array(nv);
  for (let i = 0; i < nv; i++) out[i] = Math.min(1, counts[i] / 2);
  return out;
}

/** 255 where the mask is 0 and the reverse (the unknown pixels of a ``known`` mask). */
function invertMask(m: BinaryMask): BinaryMask {
  const data = new Uint8Array(m.data.length);
  for (let i = 0; i < data.length; i++) data[i] = m.data[i] > 0 ? 0 : 255;
  return { width: m.width, height: m.height, data };
}

/** The share of the mesh surface area whose three vertices average at least ``threshold`` confidence. */
export function meshCompleteness(mesh: Mesh, confidence: Float32Array, threshold = 0.5): number {
  const V = mesh.vertices, I = mesh.indices;
  let total = 0, observed = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const wx = V[c] - V[a], wy = V[c + 1] - V[a + 1], wz = V[c + 2] - V[a + 2];
    const area = 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    total += area;
    if ((confidence[I[t]] + confidence[I[t + 1]] + confidence[I[t + 2]]) / 3 >= threshold) observed += area;
  }
  return total > 0 ? observed / total : 0;
}

/** The silhouette of the mesh as the camera would see it (triangle fill at pixel centres). */
export function rasterizeMeshSilhouette(mesh: Mesh, K: Intrinsics, pose: CameraPose, width = K.width, height = K.height): BinaryMask {
  const data = new Uint8Array(width * height);
  const nv = mesh.vertices.length / 3;
  const px = new Float32Array(nv), py = new Float32Array(nv);
  const ok = new Uint8Array(nv);
  const sx = width / K.width, sy = height / K.height;
  for (let i = 0; i < nv; i++) {
    const p = projectPoint([mesh.vertices[i * 3], mesh.vertices[i * 3 + 1], mesh.vertices[i * 3 + 2]], K, pose);
    if (p) {
      px[i] = p.u * sx;
      py[i] = p.v * sy;
      ok[i] = 1;
    }
  }
  const I = mesh.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    if (!ok[a] || !ok[b] || !ok[c]) continue;
    const x0 = px[a], y0 = py[a], x1 = px[b], y1 = py[b], x2 = px[c], y2 = py[c];
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2) - 0.5)), maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2) - 0.5));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2) - 0.5)), maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2) - 0.5));
    const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(den) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const cx = x + 0.5, cy = y + 0.5;
        const l0 = ((y1 - y2) * (cx - x2) + (x2 - x1) * (cy - y2)) / den;
        const l1 = ((y2 - y0) * (cx - x2) + (x0 - x2) * (cy - y2)) / den;
        const l2 = 1 - l0 - l1;
        if (l0 >= -1e-6 && l1 >= -1e-6 && l2 >= -1e-6) data[y * width + x] = 255;
      }
  }
  return { width, height, data };
}

/** Intersection over union of two same-size masks (1 when both are empty). With ``known`` (same size), pixels where it
 *  is 0 (unknown) are left out of both counts, and a view with fewer than ``minKnownPx`` known pixels of ``a`` (the
 *  input mask) cannot be checked: it returns 1 (it is not held against the reconstruction; callers should report it). */
export function silhouetteIoU(a: BinaryMask, b: BinaryMask, known?: BinaryMask, minKnownPx = 200): number {
  let inter = 0, uni = 0, knownA = 0;
  const kn = known ? known.data : null;
  for (let i = 0; i < a.data.length; i++) {
    if (kn && kn[i] === 0) continue;
    const p = a.data[i] > 0, q = b.data[i] > 0;
    if (p) knownA++;
    if (p && q) inter++;
    if (p || q) uni++;
  }
  if (kn && knownA < minKnownPx) return 1;
  return uni === 0 ? 1 : inter / uni;
}

export interface QualityThresholds {
  minViews: number;
  /** Largest allowed gap (deg, folded to a half circle) between neighbouring views around the hand axis (see
   *  viewCoverage). Two opposite views give 180; four views at 0, 45, 90, 135 give 45. */
  maxAzimuthGapDeg: number;
  minCompleteness: number;
  minMeanIoU: number;
  minMinIoU: number;
  maxUnconstrainedSurface: number;
  maxComponents: number;
  requireWatertight: boolean;
  /** Largest share of the hull surface allowed to lie on faces of the search box that are NOT declared cuts
   *  (QualityInput.cutFaces). More than this means a side of the hand was shaped by the box, not by any silhouette. */
  maxTruncatedSurface: number;
  /** The lowest view must look at the hand within this angle of the hand's plane (degrees). The thickness is bounded only
   *  by silhouettes seen from near that plane: with every camera higher than e, the cones leave a wedge of about
   *  (half-width x tan e) that no view can rule out (a wedge, not a cut, so the box test does not see it). */
  maxLowestElevationDeg: number;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  minViews: 3,
  maxAzimuthGapDeg: 100,
  minCompleteness: 0.5,
  minMeanIoU: 0.9,
  minMinIoU: 0.8,
  maxUnconstrainedSurface: 0.6,
  maxComponents: 1,
  requireWatertight: true,
  maxTruncatedSurface: 0.05,
  maxLowestElevationDeg: 20,
};

export type QualityReason = "too_few_views" | "views_do_not_surround_hand" | "surface_poorly_observed" | "surface_not_constrained" | "mesh_not_watertight" | "fragmented_mesh" | "reprojection_mismatch" | "hull_truncated_by_volume" | "sides_not_observed";

export interface ReconstructionQuality {
  accepted: boolean;
  reasons: QualityReason[];
  metrics: {
    views: number;
    coverageRadiusDeg: number;
    maxAzimuthGapDeg: number;
    completeness: number;
    unconstrainedSurface: number | null;
    meanIoU: number;
    minIoU: number;
    ious: number[];
    topology: TopologyReport;
    /** Share of the hull surface on each face of the search box (null without the occupancy). */
    boundsContact: BoundsContact | null;
    /** Sum of the shares on faces that are not declared cuts. */
    truncatedSurface: number | null;
    /** The smallest angle (degrees) between a view direction and the hand's plane. */
    lowestElevationDeg: number;
    /** The plane normal used: the declared one (the board's) or the mesh's thinnest principal axis. */
    planeNormal: Vec3;
  };
  thresholds: QualityThresholds;
}

export interface QualityInput {
  mesh: Mesh;
  views: readonly CarveView[];
  occupancy?: Occupancy;
  /** Per-vertex confidence if already computed (else it is computed here). */
  confidence?: Float32Array;
  /** Faces of the search box where a cut is EXPECTED and declared: the support plane the hand rests on (the board),
   *  the end of the volume where the forearm leaves it. Surface there is labelled, not hidden (see vertexSupport). */
  cutFaces?: readonly BoundsFace[];
  /** The hand's plane normal in world coordinates when known (the board's normal for a hand resting on it). Else the
   *  thinnest principal axis of the mesh. */
  planeNormal?: Vec3;
  /** The hand's long axis in world coordinates, for the azimuth-gap test (viewCoverage). Default [0, 1, 0] (the hand
   *  frame's +y); a hand on the board with the fingers toward board +x uses [1, 0, 0]. */
  handAxis?: Vec3;
}

/** Evaluate a reconstruction against its input views and decide whether it may be used for mesh-wide figures. */
export function reconstructionQuality(input: QualityInput, thresholds: Partial<QualityThresholds> = {}): ReconstructionQuality {
  const th = { ...DEFAULT_QUALITY_THRESHOLDS, ...thresholds };
  const { mesh, views } = input;
  const b = meshBounds(mesh);
  const center: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const cov = viewCoverage(views, center, input.handAxis);
  const conf = input.confidence ?? vertexConfidence(mesh, views);
  const completeness = meshCompleteness(mesh, conf);
  const ious = views.map((v) => silhouetteIoU(v.mask, rasterizeMeshSilhouette(mesh, v.intrinsics, v.pose, v.mask.width, v.mask.height), v.known));
  const meanIoU = ious.length ? ious.reduce((s, x) => s + x, 0) / ious.length : 0;
  const minIoU = ious.length ? Math.min(...ious) : 0;
  const topology = topologyReport(mesh);
  const unconstrained = input.occupancy ? unconstrainedSurfaceFraction(input.occupancy, views) : null;
  const contact = input.occupancy ? boundsContact(input.occupancy) : null;
  const cut = new Set(input.cutFaces ?? []);
  const truncated = contact ? BOUNDS_FACES.filter((f) => !cut.has(f)).reduce((s, f) => s + contact.share[f], 0) : null;
  const normal = input.planeNormal ? normalize(input.planeNormal) : thinnestAxis(mesh);
  const lowestElevationDeg = views.length
    ? Math.min(...cov.directions.map((d) => (Math.asin(Math.min(1, Math.abs(dot(d, normal)))) * 180) / Math.PI))
    : 90;
  const reasons: QualityReason[] = [];
  if (views.length < th.minViews) reasons.push("too_few_views");
  if (cov.maxAzimuthGapDeg > th.maxAzimuthGapDeg) reasons.push("views_do_not_surround_hand");
  if (completeness < th.minCompleteness) reasons.push("surface_poorly_observed");
  if (unconstrained !== null && unconstrained > th.maxUnconstrainedSurface) reasons.push("surface_not_constrained");
  if (th.requireWatertight && !topology.watertight) reasons.push("mesh_not_watertight");
  if (topology.components > th.maxComponents) reasons.push("fragmented_mesh");
  if (meanIoU < th.minMeanIoU || minIoU < th.minMinIoU) reasons.push("reprojection_mismatch");
  if (truncated !== null && truncated > th.maxTruncatedSurface) reasons.push("hull_truncated_by_volume");
  if (lowestElevationDeg > th.maxLowestElevationDeg) reasons.push("sides_not_observed");
  return {
    accepted: reasons.length === 0,
    reasons,
    metrics: { views: views.length, coverageRadiusDeg: cov.coverageRadiusDeg, maxAzimuthGapDeg: cov.maxAzimuthGapDeg, completeness, unconstrainedSurface: unconstrained, meanIoU, minIoU, ious, topology, boundsContact: contact, truncatedSurface: truncated, lowestElevationDeg, planeNormal: normal },
    thresholds: th,
  };
}

/** What shaped each vertex of a hull mesh, so a viewer and a report can say it per surface point:
 *    0 OBSERVED: a silhouette contour passes through it in at least one view (confidence > 0);
 *    1 IMPLIED: inside every silhouette but no contour touches it (the hull may over-fill here: concavities, gaps);
 *    2 SUPPORT: on the declared support plane (the board the hand rests on): bounded by the plane, not observed;
 *    3 CUT: on another declared cut face (the end of the volume at the wrist): truncated, not hand surface;
 *    4 TRUNCATED: on an undeclared face of the search box: shaped by the box, not by any view (a failure).
 *  A vertex counts as on a face when it lies within ``tolMm`` of that face's plane. */
export const VERTEX_SUPPORT_NAMES = ["observed", "implied", "support_plane", "volume_cut", "truncated"] as const;
export function vertexSupport(
  mesh: Mesh,
  confidence: Float32Array,
  bounds: { min: Vec3; max: Vec3 },
  opts: { supportFace?: BoundsFace | null; cutFaces?: readonly BoundsFace[]; tolMm: number },
): Uint8Array {
  const nv = mesh.vertices.length / 3;
  const out = new Uint8Array(nv);
  const cut = new Set(opts.cutFaces ?? []);
  const faceOf = (x: number, y: number, z: number): BoundsFace | null => {
    const t = opts.tolMm;
    if (z - bounds.min[2] <= t) return "-z";
    if (bounds.max[2] - z <= t) return "+z";
    if (y - bounds.min[1] <= t) return "-y";
    if (bounds.max[1] - y <= t) return "+y";
    if (x - bounds.min[0] <= t) return "-x";
    if (bounds.max[0] - x <= t) return "+x";
    return null;
  };
  for (let i = 0; i < nv; i++) {
    const f = faceOf(mesh.vertices[i * 3], mesh.vertices[i * 3 + 1], mesh.vertices[i * 3 + 2]);
    if (f && f === opts.supportFace) out[i] = 2;
    else if (f && cut.has(f)) out[i] = 3;
    else if (f) out[i] = 4;
    else out[i] = confidence[i] > 0 ? 0 : 1;
  }
  return out;
}

/** The mesh's thinnest principal axis (vertex covariance, smallest eigenvalue): for a hand, about the palm normal. */
function thinnestAxis(mesh: Mesh): Vec3 {
  const V = mesh.vertices;
  const n = V.length / 3;
  if (n < 3) return [0, 0, 1];
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) { mx += V[i * 3]; my += V[i * 3 + 1]; mz += V[i * 3 + 2]; }
  mx /= n; my /= n; mz /= n;
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const d = [V[i * 3] - mx, V[i * 3 + 1] - my, V[i * 3 + 2] - mz];
    for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) C[a * 3 + c] += d[a] * d[c];
  }
  const { values, vectors } = symmetricEigen(C, 3);
  let k = 0;
  for (let i = 1; i < 3; i++) if (values[i] < values[k]) k = i;
  return normalize(vectors[k] as unknown as Vec3);
}
