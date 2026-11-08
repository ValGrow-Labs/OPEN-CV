// The whole EXPERIMENTAL board reconstruction from pictures alone: the integration of
//   board/  (marker detection, camera self-calibration, board pose)  and
//   multiview/ (known-board segmentation, landmark triangulation, carving, labelled mesh, measurements).
//
// Input: the captured pictures (RGBA, all the same size, from the same camera and zoom) and, optionally, MediaPipe's 2D
// landmarks for each picture. Nothing is TOLD to the chain: the focal length, distortion and every camera pose come from
// the printed markers. If the camera cannot be calibrated from the pictures (too few or too similar views) the chain
// refuses to produce millimetres: an assumed focal length is a shared scale error that no consistency check can see.
//
// Experimental and unvalidated. Not used by the customer app.
import type { CameraPose, Intrinsics, Pt } from "../common";
import { calibrateCamera, viewFromDetections, type CalibrationResult } from "../board/calibrate";
import { detectMarkers, type DetectResult, type MarkerDetection } from "../board/detect";
import { estimateHomography } from "../geometry/pnp";
import type { RgbaImage } from "../board/image";
import { estimateBoardPose, type BoardPoseResult } from "../board/pose";
import { BOARD, markerCorners, type BoardLayout } from "../board/spec";
import { reconstructFromBoardViews, type BoardReconstruction, type BoardReconstructOptions } from "../multiview/reconstruct";
import { boardRouteFromCalibration } from "../measure/inputs";

export interface ImageView {
  id: string;
  image: RgbaImage;
  /** MediaPipe's 21 landmarks in pixels of THIS picture (not mirrored); null entries or null = not found. */
  landmarks?: (Pt | null)[] | null;
}

export interface ChainOptions {
  layout?: BoardLayout;
  /** Fewest markers for a view's pose (default 3: one marker alone gives a weak pose). */
  minMarkersForPose?: number;
  /** Largest pose reprojection RMS (px) for a view to be used (default 1.5). */
  maxPoseRmsPx?: number;
  /** Largest camera self-calibration reprojection RMS (px) accepted (default 1.5): above it the markers disagree with
   *  one camera model and every millimetre is suspect. */
  maxCalibrationRmsPx?: number;
  /** Fewest views with a pose for a reconstruction (default 8). */
  minViews?: number;
  /** The reconstruction (segmentation, carving) runs on pictures halved until they are at most this wide (default 640).
   *  Markers are always detected at full size: their corners set the camera geometry. Halving with 2 x 2 averaging maps
   *  the continuous pixel coordinate u to u / 2 exactly, so the intrinsics are halved exactly (distortion unchanged). */
  reconstructMaxWidth?: number;
  /** Detection on a half-size picture first (faster; corners are still refined at full size). Default 1. */
  decimate?: 1 | 2;
  reconstruct: Omit<BoardReconstructOptions, "layout">;
  /** Told when each stage starts (and, while detecting, before each picture), e.g. for a progress line on a page. */
  onProgress?: (p: ChainProgress) => void;
}

export interface ChainProgress {
  stage: "detect" | "calibrate" | "pose" | "reconstruct";
  /** Pictures done so far and in all (detect stage only). */
  done?: number;
  total?: number;
}

export interface ViewCamera {
  id: string;
  markers: number;
  /** Markers left out because they disagree with the view's other markers (a misread id or a bad corner). */
  inconsistentMarkers: number[];
  detectMs: number;
  pose: CameraPose | null;
  poseRmsPx: number | null;
  elevationDeg: number | null;
  azimuthDeg: number | null;
  distanceMm: number | null;
  /** Why the view is not used (no pose, too few markers, residual too large). */
  rejected: string | null;
  /** Each consistent marker's RMS corner residual (px) against the view's pose with the CALIBRATED camera, as
   *  board/pose.ts estimateBoardPose gives it (`used` false = dropped from the pose as an outlier). Empty without a pose.
   *  The board-flatness check (boardFlatness.ts) reads these: a curled sheet is not the plane the pose assumes. */
  markerResiduals: { id: number; rmsPx: number; used: boolean }[];
}

export interface CameraEstimate {
  calibration: CalibrationResult;
  intrinsics: Intrinsics;
  views: ViewCamera[];
}

export type ChainRefusal = "too_few_views_with_pose" | "camera_not_calibrated" | "camera_calibration_poor" | "pictures_differ_in_size";

export interface ChainResult {
  cameras: CameraEstimate | null;
  /** Null when the chain refused before reconstructing. */
  reconstruction: BoardReconstruction | null;
  refused: ChainRefusal | null;
  refusalWords: string | null;
  timingsMs: { detect: number; calibrate: number; pose: number; reconstruct: number; total: number };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export const REFUSAL_WORDS: Record<ChainRefusal, string> = {
  too_few_views_with_pose: "Too few pictures show enough of the printed markers to place the camera.",
  camera_not_calibrated:
    "The camera's focal length could not be measured from these pictures (they need different tilts of the board). An assumed focal length would scale every millimetre wrongly, so nothing is measured.",
  camera_calibration_poor: "The printed markers do not agree with one camera model (large calibration residual), so the camera's focal length and the millimetres cannot be trusted.",
  pictures_differ_in_size: "The pictures are not all the same size, so they cannot share one camera calibration.",
};

/** Calibrate the camera from the markers in every picture, then place the camera of each picture on the board. */
export function estimateCameras(views: readonly ImageView[], opts: Omit<ChainOptions, "reconstruct"> = {}): { cameras: CameraEstimate; detections: DetectResult[]; detectMs: number; calibrateMs: number; poseMs: number } {
  const layout = opts.layout ?? BOARD;
  const t0 = now();
  const detections = views.map((v, i) => {
    opts.onProgress?.({ stage: "detect", done: i, total: views.length });
    return detectMarkers(v.image, { layout, decimate: opts.decimate ?? 1 });
  });
  const t1 = now();
  const { width, height } = views[0].image;
  const est = camerasFromMarkers(
    views.map((v, i) => ({ id: v.id, markers: detections[i].markers, detectMs: detections[i].timingsMs?.total ?? 0 })),
    width,
    height,
    opts,
  );
  return { cameras: est.cameras, detections, detectMs: t1 - t0 + est.consistentMs, calibrateMs: est.calibrateMs, poseMs: est.poseMs };
}

/** The markers' corners as the detector gives them (only the id and the four corners are read). */
export type MarkerCornersOnly = Pick<MarkerDetection, "id" | "corners">;

/** The calibration and pose part of `estimateCameras`, from markers already detected (detector pixel convention: pixel
 *  centres at whole numbers). The page's live flatness check (boardFlatness.ts) calls it with the markers the live
 *  analysis found on each captured frame. */
export function camerasFromMarkers(
  views: readonly { id: string; markers: readonly MarkerCornersOnly[]; detectMs?: number }[],
  width: number,
  height: number,
  opts: Omit<ChainOptions, "reconstruct"> = {},
): { cameras: CameraEstimate; consistentMs: number; calibrateMs: number; poseMs: number } {
  const layout = opts.layout ?? BOARD;
  const t0 = now();
  // Pixel convention: the detector puts pixel centres at whole numbers; everything downstream (the carving, the masks,
  // MediaPipe's normalised landmarks x width) treats pixel i as the span [i, i + 1), centre i + 0.5. Convert here, once,
  // so the self-calibrated principal point and every pose agree with the masks.
  // (Only `id` and `corners` are read downstream, so markers carrying just those are passed on as detections.)
  const shifted = views.map((v) => v.markers.map((m) => ({ ...m, corners: m.corners.map((q) => ({ x: q.x + 0.5, y: q.y + 0.5 })) as MarkerDetection["corners"] }) as MarkerDetection));
  const consistent = shifted.map((ms) => consistentMarkers(ms, layout));
  const t1 = now();
  opts.onProgress?.({ stage: "calibrate" });
  const planar = consistent.map((c) => viewFromDetections(c.kept, layout));
  const calibration = calibrateCamera(planar, width, height);
  const t2 = now();
  const K = calibration.intrinsics;
  opts.onProgress?.({ stage: "pose" });
  const minMarkers = opts.minMarkersForPose ?? 3;
  const maxRms = opts.maxPoseRmsPx ?? 1.5;
  const cams: ViewCamera[] = views.map((v, i) => {
    const kept = consistent[i].kept;
    const base = { id: v.id, markers: kept.length, inconsistentMarkers: consistent[i].dropped, detectMs: v.detectMs ?? 0 };
    const p: BoardPoseResult = estimateBoardPose(K, kept, { layout, minMarkers });
    if (!p.ok) return { ...base, pose: null, poseRmsPx: null, elevationDeg: null, azimuthDeg: null, distanceMm: null, markerResiduals: [], rejected: kept.length < minMarkers ? `only ${kept.length} consistent marker(s) (needs ${minMarkers})` : `no pose: ${p.reason}` };
    const rejected = p.reprojRmsPx > maxRms ? `pose residual ${p.reprojRmsPx.toFixed(2)} px (limit ${maxRms})` : null;
    const markerResiduals = p.residuals.map((r) => ({ id: r.id, rmsPx: r.rmsPx, used: r.used }));
    return { ...base, pose: p.pose, poseRmsPx: p.reprojRmsPx, elevationDeg: p.elevationDeg, azimuthDeg: p.azimuthDeg, distanceMm: p.distanceMm, markerResiduals, rejected };
  });
  const t3 = now();
  return { cameras: { calibration, intrinsics: K, views: cams }, consistentMs: t1 - t0, calibrateMs: t2 - t1, poseMs: t3 - t2 };
}

/** Pictures in, labelled metric mesh and measurements out (or a refusal with the reason). */
export function reconstructFromImages(views: readonly ImageView[], opts: ChainOptions): ChainResult {
  const t0 = now();
  const timings = { detect: 0, calibrate: 0, pose: 0, reconstruct: 0, total: 0 };
  const refuse = (refused: ChainRefusal, cameras: CameraEstimate | null): ChainResult => {
    timings.total = now() - t0;
    return { cameras, reconstruction: null, refused, refusalWords: REFUSAL_WORDS[refused], timingsMs: timings };
  };
  if (views.length === 0) return refuse("too_few_views_with_pose", null);
  const { width, height } = views[0].image;
  if (views.some((v) => v.image.width !== width || v.image.height !== height)) return refuse("pictures_differ_in_size", null);
  const est = estimateCameras(views, opts);
  timings.detect = est.detectMs;
  timings.calibrate = est.calibrateMs;
  timings.pose = est.poseMs;
  const { cameras } = est;
  if (cameras.calibration.assumed) return refuse("camera_not_calibrated", cameras);
  if (cameras.calibration.rmsPx > (opts.maxCalibrationRmsPx ?? 1.5)) return refuse("camera_calibration_poor", cameras);
  const usable = views.map((v, i) => ({ v, c: cameras.views[i] })).filter(({ c }) => c.pose && !c.rejected);
  if (usable.length < (opts.minViews ?? 8)) return refuse("too_few_views_with_pose", cameras);
  const t1 = now();
  opts.onProgress?.({ stage: "reconstruct" });
  let factor = 1;
  while (width / factor > (opts.reconstructMaxWidth ?? 640) && width % (factor * 2) === 0 && height % (factor * 2) === 0) factor *= 2;
  const Kr = scaleIntrinsics(cameras.intrinsics, factor);
  const reconstruction = reconstructFromBoardViews(
    usable.map(({ v, c }) => ({
      id: v.id,
      image: halveTimes(v.image, factor),
      intrinsics: Kr,
      pose: c.pose as CameraPose,
      landmarks: v.landmarks ? v.landmarks.map((p) => (p ? { x: p.x / factor, y: p.y / factor } : null)) : undefined,
    })),
    {
      ...opts.reconstruct,
      layout: opts.layout ?? BOARD,
      // Stage 5 measurement engine: the calibration's own focal covariance when it exceeds the SIMULATED floor (additive;
      // a caller's `uncertainty`, including null, wins).
      uncertainty: opts.reconstruct.uncertainty !== undefined ? opts.reconstruct.uncertainty : cameras.calibration.method === "zhang" ? boardRouteFromCalibration(cameras.calibration) : undefined,
    },
  );
  timings.reconstruct = now() - t1;
  timings.total = now() - t0;
  return { cameras, reconstruction, refused: null, refusalWords: null, timingsMs: timings };
}

/** The markers of one view that agree on a single board-to-image homography (all markers lie on one plane). A marker
 *  decoded as the wrong id lands far from where its id belongs and is dropped; lens distortion only bends the fit by a
 *  few pixels, hence the generous tolerance. Hypotheses: every pair of markers (8 corners); the best consensus is refit
 *  and re-checked. With fewer than 3 markers nothing can be checked: they are all kept and the pose step decides. */
export function consistentMarkers(markers: readonly MarkerDetection[], layout: BoardLayout = BOARD): { kept: MarkerDetection[]; dropped: number[] } {
  const usable = markers.filter((m) => layout.markers[m.id]);
  if (usable.length < 3) return { kept: usable, dropped: [] };
  const world = usable.map((m) => markerCorners(layout.markers[m.id], layout.markerMm).map((c) => ({ x: c.x, y: c.y })));
  const side = (m: MarkerDetection) => {
    const q = m.corners;
    return (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y) + Math.hypot(q[3].x - q[2].x, q[3].y - q[2].y) + Math.hypot(q[0].x - q[3].x, q[0].y - q[3].y)) / 4;
  };
  const tol = usable.map((m) => Math.max(8, 0.35 * side(m)));
  const errOf = (H: number[], i: number) => {
    let e = 0;
    for (let k = 0; k < 4; k++) {
      const w = world[i][k];
      const z = H[6] * w.x + H[7] * w.y + H[8];
      const u = (H[0] * w.x + H[1] * w.y + H[2]) / z;
      const v = (H[3] * w.x + H[4] * w.y + H[5]) / z;
      e = Math.max(e, Math.hypot(u - usable[i].corners[k].x, v - usable[i].corners[k].y));
    }
    return e;
  };
  const fit = (idx: number[]) => estimateHomography(idx.flatMap((i) => world[i]), idx.flatMap((i) => [...usable[i].corners]));
  let best: number[] = [];
  for (let a = 0; a < usable.length; a++)
    for (let b = a + 1; b < usable.length; b++) {
      const H = fit([a, b]);
      if (!H) continue;
      const inl = usable.map((_, i) => i).filter((i) => errOf(H, i) <= tol[i]);
      if (inl.length > best.length) best = inl;
    }
  if (best.length >= 3) {
    const H = fit(best);
    if (H) best = usable.map((_, i) => i).filter((i) => errOf(H, i) <= tol[i]);
  }
  if (best.length < 2) return { kept: [], dropped: usable.map((m) => m.id) };
  const keep = new Set(best);
  return { kept: usable.filter((_, i) => keep.has(i)), dropped: usable.filter((_, i) => !keep.has(i)).map((m) => m.id) };
}

/** Intrinsics of the same camera for a picture `factor` times smaller (pixel i spans [i, i + 1)). */
export function scaleIntrinsics(K: Intrinsics, factor: number): Intrinsics {
  if (factor === 1) return K;
  return { ...K, fx: K.fx / factor, fy: K.fy / factor, cx: K.cx / factor, cy: K.cy / factor, width: K.width / factor, height: K.height / factor };
}

/** Halve a picture `factor` (a power of two) times with 2 x 2 averaging. */
export function halveTimes(img: RgbaImage, factor: number): RgbaImage {
  let cur = img;
  for (let f = factor; f > 1; f /= 2) {
    const w = cur.width >> 1, h = cur.height >> 1;
    const out = new Uint8ClampedArray(w * h * 4);
    const src = cur.data, W = cur.width;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = ((2 * y) * W + 2 * x) * 4, b = a + 4, c = a + W * 4, d = c + 4, o = (y * w + x) * 4;
        for (let k = 0; k < 4; k++) out[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2) >> 2;
      }
    cur = { width: w, height: h, data: out };
  }
  return cur;
}
