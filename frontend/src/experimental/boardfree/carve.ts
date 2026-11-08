// Carving, labelled mesh, metric point cloud and measurements for the EXPERIMENTAL board-free chain.
//
// The same visual hull, quality gates, vertex labels and measurement code as the board route (reconstruction/pipeline.ts
// reconstructHand, reconstruction/quality.ts vertexSupport, reconstruction/measure.ts via multiview/landmarks.ts), in
// the metric TABLE frame built from the structure from motion (z = 0 the fitted table plane, +x along the hand toward the
// fingers, millimetres from the coin). Not imported from multiview/reconstruct.ts reconstructFromBoardViews because
// the forearm cut is defined differently here (see `CutPolicy`), and the point cloud carries per-point source views.
//
// Nothing is filled in: the palm side is bounded by the table plane (label "support_plane"), the forearm end is cut
// (label "volume_cut"), surface no contour touched is "implied". SIMULATED evaluation only.
import type { BinaryMask, Mesh } from "../common";
import { rayBox, rayGrid } from "../multiview/image";
import { handFrameFromTriangulation, triangulateLandmarks, type TriangulationResult } from "../multiview/landmarks";
import { liftLandmarksFromOneView, type LiftResult } from "../multiview/liftLandmarks";
import { boardLimits } from "../multiview/reconstruct";
import { carveVisualHull, type CarveView, type Occupancy } from "../reconstruction/carving";
import { projectPoint, type Vec3 } from "../reconstruction/linalg";
import { measureHand, type FingerAxis, type HandFrame, type HandMeasurements } from "../reconstruction/measure";
import { reconstructHand } from "../reconstruction/pipeline";
import { boundaryDistance, VERTEX_SUPPORT_NAMES, vertexSupport, type QualityThresholds, type ReconstructionQuality } from "../reconstruction/quality";
import type { CarveInput } from "./types";

/**
 * How the forearm end of the volume (its -x face, the cut) is made consistent with the pictures.
 *   "box" (the board route's rule, multiview/reconstruct.ts): a hand pixel whose ray crosses the box beyond the cut
 *     (x < cut, the volume's whole y range, table to the volume's top) is unknown. In a view looking along the forearm
 *     from behind, every ray to the hand crosses that box, so nearly the whole hand is unknown there and the view's
 *     reprojection check is decided by a few hundred pixels of fingertip plus the one-pixel overfill of the hull along
 *     the outline (the stage 3 gate failure: see README "the forearm cut").
 *   "beyond-cut": the same box, and also any pixel whose ray meets it before the volume is unknown (consistent, but the
 *     box is so large that the views along the arm lose background evidence above the forearm: thicker hull).
 *   "forearm" (stage 4, default): a first carving with the board rule finds the hull's cross-section at the cut; the
 *     region beyond the cut is that cross-section (+ a margin) prolonged backward, i.e. where the forearm actually
 *     continues as the views carved it. Hand pixels whose rays cross it, and any pixel whose ray meets it before the
 *     volume, are unknown. Fingers seen OVER the forearm stay known; the forearm's own outline does not.
 */
export type CutPolicy = "box" | "beyond-cut" | "forearm";

export interface CarveOptions {
  voxelMm: number;
  volume: { min: Vec3; max: Vec3 };
  cutPolicy?: CutPolicy;
  /** "forearm" policy: margin (mm) around the cut cross-section in y and z (default 3). */
  cutMarginMm?: number;
  tolerance?: number;
  qualityThresholds?: Partial<QualityThresholds>;
  ignoreGate?: boolean;
  /** Leave the views named by the hand-moved check out (default true, at most 25 % of the views). */
  rejectDisagreeingViews?: boolean;
}

export interface CarveViewInput extends CarveInput {
  mask: BinaryMask;
  known: BinaryMask;
}

/** One point of the metric point cloud (a mesh vertex), table frame, millimetres. */
export interface CloudPoint {
  x: number;
  y: number;
  z: number;
  /** "measured": a silhouette contour of at least one view passes through it (geometry observed in the pictures);
   *  "implied": inside every silhouette but no contour touches it (the hull may over-fill: concavities, gaps);
   *  "support_plane": on the table plane, bounded by it, not observed; "volume_cut": on the forearm cut;
   *  "truncated": on another face of the search box (a failure). */
  label: (typeof VERTEX_SUPPORT_NAMES)[number];
  /** 0..1, reconstruction/quality.ts vertexConfidence (one contour 0.5, two or more 1). */
  confidence: number;
  /** Carving views whose silhouette contour passes within 1.5 px of the point (the views that observed it). */
  sourceViews: string[];
  /** Carving views in which the point projects inside the picture onto a known pixel (the views that bounded it). */
  seenBy: number;
}

export interface CarveResult {
  ok: boolean;
  failure?: string;
  volume: { min: Vec3; max: Vec3 };
  voxelMm: number;
  mesh: Mesh | null;
  /** The carved voxel hull (occupancy, support counts). */
  hull: Occupancy | null;
  /** The carving views as carved (masks with the cut's unknown pixels applied). */
  carvedViews: CarveViewInput[];
  confidence: Float32Array | null;
  support: Uint8Array | null;
  supportShare: Record<string, number> | null;
  pointCloud: CloudPoint[] | null;
  quality: ReconstructionQuality | null;
  accepted: boolean;
  reasons: string[];
  measurements: HandMeasurements | null;
  measurementBasis: string;
  frame: HandFrame | null;
  fingers: FingerAxis[];
  landmarks: TriangulationResult | null;
  liftedLandmarks: LiftResult | null;
  views: { id: string; used: boolean; reprojectionIoU: number | null; knownHandPixels: number; rejected?: string }[];
  hullVolumeMm3: number;
  /** The cut policy used and the region beyond the cut (table mm) whose pixels were made unknown as described. */
  cut: { policy: CutPolicy; beyond: BeyondRegion | null };
  timingsMs: { carve: number; mesh: number; quality: number; measure: number; cloud: number; total: number };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** The region beyond the cut whose content the volume cannot hold: the board rule's box (the volume's whole y range,
 *  table to the top of the volume) or, for "forearm", the hull's own cross-section at the cut prolonged backward. */
export interface BeyondRegion {
  min: Vec3;
  max: Vec3;
}

export function boxBeyond(volume: { min: Vec3; max: Vec3 }): BeyondRegion {
  return { min: [volume.min[0] - 2000, volume.min[1], 0], max: [volume.min[0], volume.max[1], volume.max[2]] };
}

/** The hull's cross-section at the cut (occupied voxels of the first `slices` slices along x) grown by `marginMm`,
 *  prolonged 2 m backward: where the forearm continues if it keeps the shape the views carved at the cut. */
export function forearmBeyond(hull: Occupancy, volume: { min: Vec3; max: Vec3 }, marginMm: number, slices = 2): BeyondRegion | null {
  const [nx, ny, nz] = hull.dims;
  let y0 = Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < Math.min(slices, nx); i++)
        if (hull.occupancy[i + nx * (j + ny * k)]) {
          y0 = Math.min(y0, hull.origin[1] + j * hull.voxelMm);
          y1 = Math.max(y1, hull.origin[1] + (j + 1) * hull.voxelMm);
          z1 = Math.max(z1, hull.origin[2] + (k + 1) * hull.voxelMm);
        }
  if (!Number.isFinite(y0)) return null;
  return { min: [volume.min[0] - 2000, y0 - marginMm, 0], max: [volume.min[0], y1 + marginMm, Math.min(volume.max[2], z1 + marginMm)] };
}

/**
 * Unknown pixels added by the cut (1 = unknown): a HAND pixel whose ray crosses the region beyond the cut (it may show
 * the forearm, which the volume does not contain: the board rule), and with `firstHit`, any pixel whose ray meets that
 * region before the volume (its classification belongs to the forearm, not to the volume's content).
 */
export function cutUnknown(view: CarveViewInput, volume: { min: Vec3; max: Vec3 }, beyond: BeyondRegion, firstHit: boolean): Uint8Array {
  const { width: w, height: h } = view.mask;
  const out = new Uint8Array(w * h);
  const grid = rayGrid(view.intrinsics, view.pose, w, h);
  const O = grid.origin;
  const m = view.mask.data;
  for (let p = 0; p < w * h; p++) {
    const d = [grid.dirs[p * 3], grid.dirs[p * 3 + 1], grid.dirs[p * 3 + 2]];
    const hb = rayBox(O, d, beyond.min, beyond.max);
    if (!hb) continue;
    if (m[p]) {
      out[p] = 1;
      continue;
    }
    if (firstHit) {
      const hv = rayBox(O, d, volume.min, volume.max);
      if (!hv || hb[0] <= hv[0]) out[p] = 1;
    }
  }
  return out;
}

function withCut(views: readonly CarveViewInput[], volume: { min: Vec3; max: Vec3 }, beyond: BeyondRegion, firstHit: boolean): CarveViewInput[] {
  return views.map((v) => {
    const extra = cutUnknown(v, volume, beyond, firstHit);
    const k = new Uint8Array(v.known.data.length);
    for (let p = 0; p < k.length; p++) k[p] = v.known.data[p] && !extra[p] ? 255 : 0;
    return { ...v, known: { width: v.mask.width, height: v.mask.height, data: k } };
  });
}

export function carveBoardFree(inputs: readonly CarveViewInput[], o: CarveOptions): CarveResult {
  const t0 = now();
  const { volume, voxelMm } = o;
  const policy = o.cutPolicy ?? "forearm";
  let views = withCut(inputs, volume, boxBeyond(volume), policy === "beyond-cut");
  let beyond: BeyondRegion | null = boxBeyond(volume);
  let preCarveMs = 0;
  if (policy === "forearm") {
    // pass 1 with the board rule, only to find the forearm's cross-section at the cut; pass 2 with that region
    const tp = now();
    const hull = carveVisualHull(views.map((v) => ({ mask: v.mask, known: v.known, intrinsics: v.intrinsics, pose: v.pose })), volume, { voxelMm, tolerance: o.tolerance, outsideImage: "ignore" });
    beyond = forearmBeyond(hull, volume, o.cutMarginMm ?? 3);
    if (beyond) views = withCut(inputs, volume, beyond, true);
    preCarveMs = now() - tp;
  }

  const withLm = views.some((v) => v.landmarks && v.landmarks.some((p) => p));
  const tri = withLm ? triangulateLandmarks(views.map((v) => ({ id: v.id, intrinsics: v.intrinsics, pose: v.pose, landmarks: v.landmarks ?? null }))) : null;
  const broad = !!tri && tri.disagreeingViews.length > 0.25 * views.length;
  const rejected = new Set(o.rejectDisagreeingViews === false || !tri || broad ? [] : tri.disagreeingViews);
  const hf = tri ? handFrameFromTriangulation(tri.points) : { frame: null, fingers: [] as FingerAxis[], missing: [] as number[] };
  const used = views.filter((v) => !rejected.has(v.id));
  const carveViews: CarveView[] = used.map((v) => ({ mask: v.mask, known: v.known, intrinsics: v.intrinsics, pose: v.pose }));
  const cutFaces = ["-z", "-x"] as const;
  const rec = reconstructHand(carveViews, volume, {
    voxelMm,
    tolerance: o.tolerance,
    frame: hf.frame ?? undefined,
    fingers: hf.fingers,
    qualityThresholds: o.qualityThresholds,
    cutFaces,
    planeNormal: [0, 0, 1],
    handAxis: hf.frame ? hf.frame.axisY : [1, 0, 0],
    outsideImage: "ignore",
    ignoreGate: o.ignoreGate,
  });
  const timings = { carve: rec.timingsMs.carve + preCarveMs, mesh: rec.timingsMs.mesh, quality: rec.timingsMs.quality, measure: rec.timingsMs.measure, cloud: 0, total: 0 };
  const viewReports = views.map((v) => {
    const pos = used.indexOf(v);
    let knownHand = 0;
    for (let p = 0; p < v.mask.data.length; p++) if (v.mask.data[p] && v.known.data[p]) knownHand++;
    return {
      id: v.id,
      used: pos >= 0,
      reprojectionIoU: pos >= 0 && rec.quality && knownHand >= 200 ? rec.quality.metrics.ious[pos] : null,
      knownHandPixels: knownHand,
      ...(pos < 0 ? { rejected: "named by the hand-moved check (its landmarks disagree with the other views)" } : {}),
    };
  });

  let lifted: LiftResult | null = null;
  let frameUsed = hf;
  let measurements = rec.measurements;
  if (!hf.frame && rec.ok && rec.mesh) {
    lifted = liftLandmarksFromOneView(rec.mesh, views.map((v) => ({ id: v.id, intrinsics: v.intrinsics, pose: v.pose, landmarks: v.landmarks ?? null })));
    if (lifted) {
      const lf = handFrameFromTriangulation(lifted.points);
      if (lf.frame) {
        frameUsed = lf;
        measurements = measureHand(rec.mesh, lf.frame, { fingers: lf.fingers, accepted: rec.quality?.accepted ?? false, ignoreGate: o.ignoreGate });
      }
    }
  }
  const basis = hf.frame
    ? "mesh: visual hull of the segmented silhouettes (an upper bound of the hand; concavities filled); hand frame and finger axes: landmarks triangulated from the views (model estimates); poses, focal length and distortion: board-free structure from motion; scale: the coin fitted jointly in the bundle adjustment (its thickness ASSUMED, unverified)"
    : frameUsed.frame && lifted
      ? `mesh: visual hull of the segmented silhouettes (an upper bound); hand frame: the landmarks of ONE view (${lifted.viewId}) lifted onto the mesh, joint centres assumed at half the local hand height (model estimates); poses and scale: board-free structure from motion and the coin (thickness ASSUMED)`
      : "no hand frame: no (or too few) landmarks, so no measurements; the mesh is still the visual hull";
  const base = { volume, voxelMm, frame: frameUsed.frame, fingers: frameUsed.fingers, landmarks: tri, liftedLandmarks: lifted, views: viewReports, hullVolumeMm3: rec.hullVolumeMm3, measurementBasis: basis, cut: { policy, beyond }, hull: rec.hull, carvedViews: used };
  if (!rec.ok || !rec.mesh) {
    timings.total = now() - t0;
    return { ...base, ok: false, failure: rec.failure, mesh: null, confidence: null, support: null, supportShare: null, pointCloud: null, quality: null, accepted: false, reasons: [rec.failure ?? "no mesh"], measurements: null, timingsMs: timings };
  }
  const mesh = rec.mesh;
  const support = vertexSupport(mesh, rec.confidence!, volume, { supportFace: "-z", cutFaces, tolMm: voxelMm });
  const share: Record<string, number> = {};
  for (const name of VERTEX_SUPPORT_NAMES) share[name] = 0;
  for (let i = 0; i < support.length; i++) share[VERTEX_SUPPORT_NAMES[support[i]]] += 1 / support.length;
  const t1 = now();
  const pointCloud = buildPointCloud(mesh, rec.confidence!, support, used);
  timings.cloud = now() - t1;
  const quality = rec.quality!;
  const reasons: string[] = [...quality.reasons];
  if (!frameUsed.frame) reasons.push("no_hand_frame");
  else if (!hf.frame) reasons.push("hand_frame_from_one_view");
  if (tri?.handMoved) reasons.push(broad ? "views_disagree_broadly" : "views_disagree");
  timings.total = now() - t0;
  return {
    ...base,
    ok: true,
    mesh,
    confidence: rec.confidence,
    support,
    supportShare: share,
    pointCloud,
    quality,
    accepted: quality.accepted,
    reasons,
    measurements: tableLimits(measurements),
    timingsMs: timings,
  };
}

/** Per vertex: table-frame position, label, confidence and the views that observed / bounded it. */
export function buildPointCloud(mesh: Mesh, confidence: Float32Array, support: Uint8Array, views: readonly CarveViewInput[], tolPx = 1.5): CloudPoint[] {
  const nv = mesh.vertices.length / 3;
  const src: string[][] = Array.from({ length: nv }, () => []);
  const seen = new Uint16Array(nv);
  for (const v of views) {
    const dist = boundaryDistance(v.mask);
    const { width: w, height: h } = v.mask;
    const sx = w / v.intrinsics.width, sy = h / v.intrinsics.height;
    for (let i = 0; i < nv; i++) {
      const X: Vec3 = [mesh.vertices[i * 3], mesh.vertices[i * 3 + 1], mesh.vertices[i * 3 + 2]];
      const p = projectPoint(X, v.intrinsics, v.pose);
      if (!p) continue;
      const u = Math.floor(p.u * sx), q = Math.floor(p.v * sy);
      if (u < 0 || q < 0 || u >= w || q >= h) continue;
      const pix = q * w + u;
      if (!v.known.data[pix]) continue;
      seen[i]++;
      if (dist[pix] <= tolPx) src[i].push(v.id);
    }
  }
  const out: CloudPoint[] = new Array(nv);
  for (let i = 0; i < nv; i++)
    out[i] = { x: mesh.vertices[i * 3], y: mesh.vertices[i * 3 + 1], z: mesh.vertices[i * 3 + 2], label: VERTEX_SUPPORT_NAMES[support[i]], confidence: confidence[i], sourceViews: src[i], seenBy: seen[i] };
  return out;
}

/** The board route's limits (multiview/reconstruct.ts boardLimits) with the words changed from board to table: the palm
 *  side rests on the table (not observed), so no hand surface area; the circumference is an upper bound. */
export function tableLimits(m: HandMeasurements | null): HandMeasurements | null {
  const b = boardLimits(m);
  if (!b) return b;
  const fix = (s: string) => s.replace(/\bboard\b/g, "table");
  return {
    ...b,
    surfaceArea: { ...b.surfaceArea, note: fix(b.surfaceArea.note) },
    circumferenceKnuckle: { ...b.circumferenceKnuckle, note: fix(b.circumferenceKnuckle.note) },
    palmThickness: { ...b.palmThickness, note: fix(b.palmThickness.note) },
    notes: b.notes.map(fix),
  };
}
