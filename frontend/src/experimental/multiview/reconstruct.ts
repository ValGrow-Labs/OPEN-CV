// Board-frame multi-view hand reconstruction (EXPERIMENTAL): pictures of a hand resting palm-down on the printed board,
// each with its camera intrinsics and board-to-camera pose, in; a labelled, measured hull mesh out.
//
//   per view: picture -> segmentBoardView (mask + known)      landmarks (21 px per view) -> triangulateLandmarks
//                         \                                     |   (hand-moved check names disagreeing views)
//                          -> reconstructHand in a board-frame volume (cut faces: the board "-z", the forearm end "-x")
//                             -> vertexSupport labels -> measurements in the landmark hand frame
//
// The camera intrinsics and poses are INPUTS (from the board's marker detection and calibration, built elsewhere).
// Nothing is filled in: the palm side is bounded by the board plane (labelled "support_plane"), the forearm end is cut
// (labelled "volume_cut"), surface no contour touched is "implied". Z comes only from the multi-view geometry.
import type { BinaryMask, CameraPose, Intrinsics, Mesh, Pt } from "../common";
import { BOARD, type BoardLayout } from "../board/spec";
import type { CarveView } from "../reconstruction/carving";
import type { Vec3 } from "../reconstruction/linalg";
import type { FingerAxis, HandFrame, HandMeasurements } from "../reconstruction/measure";
import { reconstructHand } from "../reconstruction/pipeline";
import { VERTEX_SUPPORT_NAMES, vertexSupport, type QualityThresholds, type ReconstructionQuality } from "../reconstruction/quality";
import type { RGBAImage } from "./image";
import { handFrameFromTriangulation, triangulateLandmarks, type TriangulationOptions, type TriangulationResult } from "./landmarks";
import { liftLandmarksFromOneView, type LiftResult } from "./liftLandmarks";
import { measureHand } from "../reconstruction/measure";
import { predictBoard, segmentBoardView, type SegmentOptions, type SegmentStats } from "./segment";
import { camerasForScale, measureWithUncertainty, meshCentroid } from "../measure/engine";
import { BOARD_ROUTE_SIMULATED, stated } from "../measure/inputs";
import type { CaptureUncertainty, MeasurementReport } from "../measure/types";

export interface BoardViewInput {
  id?: string;
  /** The picture (needed unless `mask` is given). Its size must equal the intrinsics' size. */
  image?: RGBAImage;
  intrinsics: Intrinsics;
  /** Board-to-camera pose: Xc = R X_board + t. */
  pose: CameraPose;
  /** MediaPipe's 21 landmarks in pixels of this picture (null entries = not detected). */
  landmarks?: readonly (Pt | null)[] | null;
  /** Masks from another segmenter (skips segmentBoardView for this view). `known` defaults to all known. */
  mask?: BinaryMask;
  known?: BinaryMask;
}

export interface BoardReconstructOptions {
  voxelMm: number;
  /** The carving volume (board mm); default boardVolume(layout). Its -z face must be the board plane z = 0. */
  volume?: { min: Vec3; max: Vec3 };
  layout?: BoardLayout;
  /** Carving tolerance (silhouettes a voxel may miss). Default 0. */
  tolerance?: number;
  segment?: Partial<SegmentOptions>;
  triangulation?: Partial<TriangulationOptions>;
  /** Leave the views named by the hand-moved check out of the carving too. Default true. Never more than
   *  ``maxRejectedShare`` of the views (default 0.25): when more disagree, the poses (calibration) or the whole capture
   *  are suspect, nothing is dropped and the reason "views_disagree_broadly" is reported. */
  rejectDisagreeingViews?: boolean;
  maxRejectedShare?: number;
  qualityThresholds?: Partial<QualityThresholds>;
  /** Research only: report mesh-wide measurements even when the gates failed. */
  ignoreGate?: boolean;
  blurPasses?: number;
  smoothIterations?: number;
  /** Input uncertainties for the Stage 5 measurement engine (measure/): every value then carries a numeric uncertainty
   *  with its definition, method and data source (`measurementReport`). Default BOARD_ROUTE_SIMULATED (SIMULATED test
   *  figures, labelled); null skips the report. */
  uncertainty?: CaptureUncertainty | null;
}

export interface ViewReport {
  id: string;
  used: boolean;
  /** Why it was left out of the carving. */
  rejected?: string;
  segmented: boolean;
  handPixels: number;
  knownFraction: number;
  /** Share of the pixels whose rays cross the volume that are unknown. */
  unknownInVolume: number | null;
  segmentation: SegmentStats | null;
  /** IoU of the mesh's silhouette with this view's mask over its known pixels (null if not used, or if fewer than 200
   *  known hand pixels make it uncheckable: a view along the forearm sees mostly the forearm). */
  reprojectionIoU: number | null;
  /** Hand pixels of the mask that are known (the evidence the reprojection check has in this view). */
  knownHandPixels: number;
  landmarks: number;
  landmarkMedianPx: number | null;
}

export interface BoardReconstruction {
  ok: boolean;
  failure?: string;
  volume: { min: Vec3; max: Vec3 };
  voxelMm: number;
  mesh: Mesh | null;
  /** Per vertex 0..1: silhouette contours through it (see vertexConfidence). */
  confidence: Float32Array | null;
  /** Per vertex: index into SUPPORT_LABELS. */
  support: Uint8Array | null;
  supportLabels: readonly string[];
  /** Share of vertices per support label. */
  supportShare: Record<string, number> | null;
  /** The mesh vertices as a point cloud (xyz, board mm) with the same labels. */
  pointCloud: { points: Float32Array; labels: Uint8Array } | null;
  quality: ReconstructionQuality | null;
  accepted: boolean;
  reasons: string[];
  measurements: HandMeasurements | null;
  /** How the measurements were obtained (always state it next to them). */
  measurementBasis: string;
  frame: HandFrame | null;
  fingers: FingerAxis[];
  /** Surface area (mm^2) of the mesh without the faces on the board plane and the forearm cut (the hand's own surface
   *  above the board, as far as a visual hull gives it: an upper bound). */
  freeSurfaceAreaMm2: number | null;
  hullVolumeMm3: number;
  views: ViewReport[];
  landmarks: TriangulationResult | null;
  /** The single-view fallback used for the hand frame when triangulation gave none (null otherwise). */
  liftedLandmarks: LiftResult | null;
  timingsMs: { segment: number; triangulate: number; carve: number; mesh: number; quality: number; measure: number; total: number };
  /** Stage 5 (EXPERIMENTAL, additive): the same measurements plus finger widths, each with definition, method, data
   *  source, basis and a numeric uncertainty propagated from stated input sigmas (measure/engine.ts). Absent when the
   *  option `uncertainty` is null; null when there is no mesh. The existing `measurements` are unchanged. */
  measurementReport?: MeasurementReport | null;
}

/** 3D landmark sigma used when the hand frame was LIFTED from one view instead of triangulated. */
export const LIFTED_LANDMARK_SIGMA = stated(
  3,
  "ASSUMED",
  "landmarks of one view lifted onto the mesh with each joint centre assumed at half the local hand height (multiview/liftLandmarks.ts); recon/chain.test.ts top-view-only run: length and breadth within 5 mm. 3 mm is a guess",
);

export const SUPPORT_LABELS = VERTEX_SUPPORT_NAMES;

/** The default carving volume on the board: the hand area from the open left edge (x = 0, where the forearm leaves) to
 *  just short of the coin, widened by ``marginYMm`` across the hand, from the board plane to ``zMaxMm``. */
export function boardVolume(layout: BoardLayout = BOARD, opts: { marginYMm?: number; zMaxMm?: number; coinClearanceMm?: number } = {}): { min: Vec3; max: Vec3 } {
  const a = layout.handArea;
  const coinLeft = layout.coinTarget.center.x - 23.25 / 2 - (opts.coinClearanceMm ?? 5);
  const m = opts.marginYMm ?? 15;
  return { min: [0, Math.max(0, a.minY - m), 0], max: [Math.min(a.maxX, coinLeft), Math.min(layout.paper.heightMm, a.maxY + m), opts.zMaxMm ?? 80] };
}

/** Beyond the open left edge, where the forearm lies: excluded from background colour samples. */
export function forearmBox(volume: { min: Vec3; max: Vec3 }): { min: Vec3; max: Vec3 } {
  return { min: [volume.min[0] - 500, volume.min[1], 0], max: [volume.min[0], volume.max[1], volume.max[2]] };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function reconstructFromBoardViews(views: readonly BoardViewInput[], options: BoardReconstructOptions): BoardReconstruction {
  const t0 = now();
  const layout = options.layout ?? BOARD;
  const volume = options.volume ?? boardVolume(layout);
  const voxelMm = options.voxelMm;
  const ids = views.map((v, i) => v.id ?? `view-${i}`);
  const timings = { segment: 0, triangulate: 0, carve: 0, mesh: 0, quality: 0, measure: 0, total: 0 };

  // 1. masks. Hand pixels whose rays cross the forearm box (beyond the open edge, outside the volume) may show the
  // forearm, which the volume cannot contain: they are marked unknown so they neither count as observed contours nor
  // in the reprojection check. For the carving this changes nothing (a hand pixel never carves).
  const fBox = forearmBox(volume);
  const masks: { mask: BinaryMask; known?: BinaryMask; stats: SegmentStats | null }[] = views.map((v) => {
    let mask: BinaryMask, known: BinaryMask | undefined, stats: SegmentStats | null = null, inForearm: Uint8Array;
    if (v.mask) {
      mask = v.mask;
      known = v.known;
      inForearm = predictBoard(v.intrinsics, v.pose, { layout, volume, forearmBox: fBox, coin: null }).inForearm;
    } else {
      if (!v.image) throw new Error("reconstructFromBoardViews: a view needs an image or a mask");
      const s = segmentBoardView(v.image, v.intrinsics, v.pose, { layout, volume, forearmBox: fBox, ...(options.segment ?? {}) });
      mask = s.mask;
      known = s.known;
      stats = s.stats;
      inForearm = s.inForearm;
    }
    const k = new Uint8Array(mask.data.length);
    for (let p = 0; p < k.length; p++) k[p] = (known ? known.data[p] : 255) && !(mask.data[p] && inForearm[p]) ? 255 : 0;
    return { mask, known: { width: mask.width, height: mask.height, data: k }, stats };
  });
  const t1 = now();
  timings.segment = t1 - t0;

  // 2. landmarks and the hand-moved check
  const withLm = views.some((v) => v.landmarks && v.landmarks.some((p) => p));
  const tri = withLm ? triangulateLandmarks(views.map((v, i) => ({ id: ids[i], intrinsics: v.intrinsics, pose: v.pose, landmarks: v.landmarks ?? null })), options.triangulation) : null;
  const t2 = now();
  timings.triangulate = t2 - t1;
  const broad = !!tri && tri.disagreeingViews.length > (options.maxRejectedShare ?? 0.25) * views.length;
  const rejected = new Set(options.rejectDisagreeingViews === false || !tri || broad ? [] : tri.disagreeingViews);
  const hf = tri ? handFrameFromTriangulation(tri.points) : { frame: null, fingers: [] as FingerAxis[], missing: [] as number[] };

  // 3. carving and the rest of the chain
  const usedIdx = views.map((_, i) => i).filter((i) => !rejected.has(ids[i]));
  const carveViews: CarveView[] = usedIdx.map((i) => ({ mask: masks[i].mask, intrinsics: views[i].intrinsics, pose: views[i].pose, ...(masks[i].known ? { known: masks[i].known } : {}) }));
  const cutFaces = ["-z", "-x"] as const;
  const rec = reconstructHand(carveViews, volume, {
    voxelMm,
    tolerance: options.tolerance,
    blurPasses: options.blurPasses,
    smoothIterations: options.smoothIterations,
    frame: hf.frame ?? undefined,
    fingers: hf.fingers,
    qualityThresholds: options.qualityThresholds,
    cutFaces,
    planeNormal: [0, 0, 1],
    handAxis: hf.frame ? hf.frame.axisY : [1, 0, 0],
    outsideImage: "ignore",
    ignoreGate: options.ignoreGate,
  });
  timings.carve = rec.timingsMs.carve;
  timings.mesh = rec.timingsMs.mesh;
  timings.quality = rec.timingsMs.quality;
  timings.measure = rec.timingsMs.measure;

  const viewReports: ViewReport[] = views.map((v, i) => {
    const st = masks[i].stats;
    const usedPos = usedIdx.indexOf(i);
    const lmCount = v.landmarks ? v.landmarks.filter((p) => p).length : 0;
    let handPixels = 0, knownHandPixels = 0;
    for (let p = 0; p < masks[i].mask.data.length; p++)
      if (masks[i].mask.data[p]) {
        handPixels++;
        if (!masks[i].known || masks[i].known!.data[p]) knownHandPixels++;
      }
    let knownFraction = 1;
    if (masks[i].known) {
      let k = 0;
      for (let p = 0; p < masks[i].known!.data.length; p++) if (masks[i].known!.data[p]) k++;
      knownFraction = k / masks[i].known!.data.length;
    }
    return {
      id: ids[i],
      used: usedPos >= 0,
      ...(usedPos < 0 ? { rejected: "named by the hand-moved check (its landmarks disagree with the other views)" } : {}),
      segmented: !!st,
      handPixels,
      knownFraction,
      unknownInVolume: st ? st.unknownInVolume : null,
      segmentation: st,
      reprojectionIoU: usedPos >= 0 && rec.quality && knownHandPixels >= 200 ? rec.quality.metrics.ious[usedPos] : null,
      knownHandPixels,
      landmarks: lmCount,
      landmarkMedianPx: tri ? tri.views[i].medianPx : null,
    };
  });

  // Fallback when the landmarks could not be triangulated: lift one steep view's landmarks onto the metric mesh.
  let lifted: LiftResult | null = null;
  let frameUsed = hf;
  let measurements = rec.measurements;
  if (!hf.frame && rec.ok && rec.mesh) {
    lifted = liftLandmarksFromOneView(rec.mesh, views.map((v, i) => ({ id: ids[i], intrinsics: v.intrinsics, pose: v.pose, landmarks: v.landmarks ?? null })));
    if (lifted) {
      const lf = handFrameFromTriangulation(lifted.points);
      if (lf.frame) {
        frameUsed = lf;
        measurements = measureHand(rec.mesh, lf.frame, { fingers: lf.fingers, accepted: rec.quality?.accepted ?? false, ignoreGate: options.ignoreGate });
      }
    }
  }
  const basis = hf.frame
    ? "mesh: visual hull of the segmented silhouettes (an upper bound of the hand; concavities filled); hand frame and finger axes: landmarks triangulated from the views (model estimates); scale: the board and the camera calibration supplied as inputs"
    : frameUsed.frame && lifted
      ? `mesh: visual hull of the segmented silhouettes (an upper bound of the hand; concavities filled); hand frame and finger axes: the landmarks of ONE view (${lifted.viewId}, looking down at ${lifted.elevationDeg.toFixed(0)} degrees) lifted onto the mesh, joint centres assumed at half the local hand height above the board (model estimates; the landmarks could not be triangulated from several views); scale: the board and the camera calibration supplied as inputs`
      : "no hand frame: no (or too few) landmarks, in several views or in one view looking down, so no measurements; the mesh is still the visual hull";
  const base = { volume, voxelMm, supportLabels: SUPPORT_LABELS, frame: frameUsed.frame, fingers: frameUsed.fingers, hullVolumeMm3: rec.hullVolumeMm3, views: viewReports, landmarks: tri, liftedLandmarks: lifted, measurementBasis: basis };
  if (!rec.ok || !rec.mesh) {
    timings.total = now() - t0;
    return {
      ...base,
      ok: false,
      failure: rec.failure,
      mesh: null,
      confidence: null,
      support: null,
      supportShare: null,
      pointCloud: null,
      quality: null,
      accepted: false,
      reasons: [rec.failure ?? "no mesh"],
      measurements: null,
      freeSurfaceAreaMm2: null,
      timingsMs: timings,
      ...(options.uncertainty === null ? {} : { measurementReport: null }),
    };
  }
  const mesh = rec.mesh;
  const support = vertexSupport(mesh, rec.confidence!, volume, { supportFace: "-z", cutFaces, tolMm: voxelMm });
  const share: Record<string, number> = {};
  for (const name of SUPPORT_LABELS) share[name] = 0;
  for (let i = 0; i < support.length; i++) share[SUPPORT_LABELS[support[i]]] += 1 / support.length;
  let free = 0;
  const V = mesh.vertices, I = mesh.indices;
  for (let t = 0; t < I.length; t += 3) {
    if (support[I[t]] >= 2 || support[I[t + 1]] >= 2 || support[I[t + 2]] >= 2) continue;
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const wx = V[c] - V[a], wy = V[c + 1] - V[a + 1], wz = V[c + 2] - V[a + 2];
    free += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
  }
  const quality = rec.quality!;
  const reasons: string[] = [...quality.reasons];
  if (!frameUsed.frame) reasons.push("no_hand_frame");
  else if (!hf.frame) reasons.push("hand_frame_from_one_view");
  if (tri?.handMoved) reasons.push(broad ? "views_disagree_broadly" : "views_disagree");
  const limited = boardLimits(measurements);
  let measurementReport: MeasurementReport | null | undefined;
  if (options.uncertainty !== null) {
    const landmarkSource = hf.frame ? ("triangulated" as const) : frameUsed.frame && lifted ? ("lifted_one_view" as const) : ("none" as const);
    const cap0 = options.uncertainty ?? BOARD_ROUTE_SIMULATED;
    const capture = landmarkSource === "lifted_one_view" ? { ...cap0, landmark3dMm: LIFTED_LANDMARK_SIGMA } : cap0;
    measurementReport = measureWithUncertainty({
      mesh,
      support,
      supportLabels: SUPPORT_LABELS,
      frame: frameUsed.frame,
      fingers: frameUsed.fingers,
      measurements: limited,
      accepted: quality.accepted,
      reasons,
      supportBounded: true,
      up: [0, 0, 1],
      usedViews: usedIdx.map((i) => ids[i]),
      landmarkSource,
      cameras: camerasForScale(
        usedIdx.map((i) => ({ id: ids[i], intrinsics: views[i].intrinsics, pose: views[i].pose })),
        meshCentroid(mesh),
      ),
      voxelMm,
      capture,
    });
  }
  timings.total = now() - t0;
  return {
    ...base,
    ok: true,
    mesh,
    confidence: rec.confidence,
    support,
    supportShare: share,
    pointCloud: { points: mesh.vertices, labels: support },
    quality,
    accepted: quality.accepted,
    reasons,
    measurements: limited,
    freeSurfaceAreaMm2: free,
    timingsMs: timings,
    ...(measurementReport === undefined ? {} : { measurementReport }),
  };
}

/** What the board capture can and cannot measure, applied to the generic measurements (which do not know the hand rests
 *  on a board):
 *   * surface area: the palm side is the board plane, NOT observed, so the hand's surface area is not measurable here.
 *     Withheld; the back-and-sides hull area is reported separately (`freeSurfaceAreaMm2`, an upper bound).
 *   * knuckle circumference: the palm-side half of the loop runs along the board plane (not observed) and the rest is
 *     the hull (concavities filled): an UPPER BOUND, so basis "model" whatever the frame.
 *   * palm thickness: the height above the board the hand rests on; the board is a physical bound, the back is shaped by
 *     the low views (gate sides_not_observed). Basis unchanged; the note says so.
 *  Exported for tests. */
export function boardLimits(m: HandMeasurements | null): HandMeasurements | null {
  if (!m) return m;
  const surfaceArea = {
    value: null,
    unit: "mm2" as const,
    basis: "none" as const,
    note: "not available from a board capture: the palm side rests on the board and is not observed. The back-and-sides hull area (an upper bound) is reported separately.",
  };
  const c = m.circumferenceKnuckle;
  const circumferenceKnuckle =
    c.value === null
      ? c
      : {
          ...c,
          basis: "model" as const,
          note: `UPPER BOUND: the palm-side half of this loop is the board plane (not observed) and the rest is the visual hull (concavities filled). ${c.note}`,
        };
  const t = m.palmThickness;
  const palmThickness = t.value === null ? t : { ...t, note: `height above the board the hand rests on (the board bounds the palm side; the back is shaped by the low views). ${t.note}` };
  return { ...m, surfaceArea, circumferenceKnuckle, palmThickness, notes: [...m.notes, "Board capture: the palm side is bounded by the board, not observed; no hand surface area; the circumference is an upper bound."] };
}
