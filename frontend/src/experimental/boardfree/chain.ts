// The EXPERIMENTAL board-free reconstruction chain (stage 4): pictures of a hand on a textured table with a coin, NO
// printed board, in; a labelled metric mesh, a metric point cloud with per-point confidence and source views, the
// quality gates and the measurements out, or a refusal with a named reason.
//
//   frames (a continuous sweep) --(hand left out by the landmark region)--> structure from motion, focal length and
//   distortion self-calibrated, coin fitted jointly in the bundle adjustment (sfmStage.ts)
//   --> table plane + coin scale + in-plane axes = metric TABLE frame (tableFrame.ts)
//   --> carving views (the guided stills of the sweep) at half size, the volume from the triangulated landmarks
//   --> board-free segmentation of each carving view with its neighbouring sweep frames (segment.ts)
//   --> visual hull with the table as the support plane and the forearm cut made consistent with the views (carve.ts)
//   --> labelled mesh, point cloud, the existing quality gates and measurements (reconstruction/).
//
// Nothing is told to the chain: not the focal length, not the distortion, not a pose. The coin's diameter comes from the
// caller (config/reference_objects.json `inr_2_2019`: 23.00 mm); its THICKNESS IS AN ASSUMPTION (1.5 mm in the
// simulations, UNVERIFIED) and moves the scale by about -1.5 / +1.9 % per -0.5 / +0.5 mm (sfm/README.md).
// Research only; not used by the customer app. Every result so far is SIMULATED.
import type { BinaryMask, CameraPose, Intrinsics, Pt } from "../common";
import type { CV } from "../../vision/opencv";
import { triangulateLandmarks } from "../multiview/landmarks";
import { projectPoint, type Vec3 } from "../reconstruction/linalg";
import { camToIntrinsics, poseToTable } from "../sfm/frame";
import { centreOf } from "../sfm/geometry";
import { carveBoardFree, type CarveResult, type CutPolicy } from "./carve";
import { halveImage, segmentView, type SegViewContext } from "./segment";
import { runSfmStage, type SfmStageResult, type SfmUncertainty } from "./sfmStage";
import { buildTableFrame, fitTablePlane, volumeFromLandmarks } from "./tableFrame";
import type { BoardFreeFrame, BoardFreeFrameDef, CarveInput, SegmentationMethod, ViewSegmentation } from "./types";

export interface BoardFreeOptions {
  /** The coin's diameter (mm), from the reference-object config. */
  coinDiameterMm: number;
  /** The coin's thickness the outline model ASSUMES (mm). Unverified for the Rs 2 coin. */
  coinThicknessMm: number;
  segmentation: SegmentationMethod;
  /** OpenCV.js, for the "grabcut" and "combined" segmentations. */
  cv?: CV;
  voxelMm?: number;
  frameMethod?: "landmarks" | "silhouette";
  cutPolicy?: CutPolicy;
  /** Fewest frames for a board-free capture (default 40: a sweep; the board capture's 13-25 stills never register). */
  minFrames?: number;
  /** Fewest frames showing the WHOLE coin (default 6). */
  minCoinFrames?: number;
  /** Largest joint coin outline residual RMS (px, default 1.0) and feature RMS (px, default 1.5). */
  maxCoinRmsPx?: number;
  maxSfmRmsPx?: number;
  /** Fewest carving views with a usable segmentation (default 12). */
  minCarveViews?: number;
  /** Pictures are halved this many times for the segmentation and carving (default 2: 1280 -> 640). */
  reconstructFactor?: 1 | 2 | 4;
  /** Research only: measurements even when the gates fail. */
  ignoreGate?: boolean;
  /** EVALUATION ONLY: masks supplied for the carving views instead of the segmentation (e.g. the renderer's exact masks,
   *  to separate segmentation error from geometry error in a SIMULATED comparison). Never used by the chain itself. */
  maskProvider?: (frameIndex: number, width: number, height: number) => { mask: BinaryMask; known: BinaryMask };
  onProgress?: (stage: string) => void;
}

export type BoardFreeRefusal =
  | "too_few_frames"
  | "pictures_differ_in_size"
  | "coin_missing"
  | "coin_partial"
  | "sfm_failed"
  | "sfm_partial_registration"
  | "camera_geometry_poor"
  | "coin_fit_poor"
  | "no_table_plane"
  | "no_hand_landmarks"
  | "too_few_carving_views"
  | "segmentation_failed";

export const BOARD_FREE_REFUSAL_WORDS: Record<BoardFreeRefusal, string> = {
  too_few_frames: "Too few pictures for a board-free capture: it needs a slow continuous video sweep round the hand (frames at most about 7.5 degrees apart), not a handful of stills.",
  pictures_differ_in_size: "The pictures are not all the same size, so they cannot share one camera calibration.",
  coin_missing: "The coin was not found in the pictures. Without it there is no scale, so nothing is measured.",
  coin_partial: "The coin was seen whole in too few pictures (it was hidden by the hand or cut by the picture edge). Without enough clean views of it the scale cannot be trusted.",
  sfm_failed: "The camera positions could not be recovered from the pictures (the surface under the hand needs a rich, non-repeating texture).",
  sfm_partial_registration: "Only part of the sweep could be placed: on the evidence so far a partial reconstruction is usually wrong, so nothing is measured.",
  camera_geometry_poor: "The pictures do not agree with one camera model well enough (large residual), so the camera geometry cannot be trusted.",
  coin_fit_poor: "The coin's outlines do not agree with one flat coin of the stated size, so the scale cannot be trusted.",
  no_table_plane: "No flat table surface was found under the hand.",
  no_hand_landmarks: "The hand's landmarks could not be placed in 3D, so the hand frame and the carving volume are unknown.",
  too_few_carving_views: "Too few of the guided pictures round the hand could be placed for the 3D reconstruction.",
  segmentation_failed: "The hand could not be separated from the table in enough pictures.",
};

/** What stage 5 (measurement uncertainty) needs, gathered in one place. All SIMULATED so far. */
export interface BoardFreeUncertaintyInputs {
  sfm: SfmUncertainty | null;
  /** Self-calibrated camera (full-size pixels). */
  intrinsics: Intrinsics | null;
  scale: {
    mmPerUnit: number | null;
    /** Relative one-sigma components of the scale (coin fit scatter, the reference diameter allowance, the ASSUMED
     *  thickness allowance) and their root-sum-square, from coin/sceneScale.ts on the final poses. */
    components: { key: string; rel: number; rule: string }[];
    relSigma: number | null;
    coinThicknessAssumedMm: number;
    coinThicknessVerified: false;
  };
  /** Table plane fit: RANSAC inliers and RMS distance (mm). */
  plane: { inliers: number; rmsMm: number } | null;
  /** Per carving view: segmentation statistics and the mesh's reprojection IoU. */
  views: { id: string; tableAgreeShare: number | null; unknownShare: number; reprojectionIoU: number | null; rejected: string[] }[];
}

export interface BoardFreeResult {
  refused: BoardFreeRefusal | null;
  refusalWords: string | null;
  /** Numbers behind the refusal (e.g. "registered 8 of 57"). */
  refusalDetail: string | null;
  sfm: SfmStageResult | null;
  frame: BoardFreeFrameDef | null;
  intrinsics: Intrinsics | null;
  /** Every frame's camera pose in the metric table frame (null = not registered). */
  tablePoses: (CameraPose | null)[];
  /** The carving views: id, frame index and table-frame pose (full-size intrinsics in `intrinsics`). */
  carveViews: { id: string; frameIndex: number; pose: CameraPose }[];
  volume: { min: Vec3; max: Vec3 } | null;
  segmentation: ViewSegmentation[];
  reconstruction: CarveResult | null;
  /** Reconstructed, gates passed, measurements usable (still SIMULATED evidence only). */
  accepted: boolean;
  uncertainty: BoardFreeUncertaintyInputs;
  timingsMs: { sfm: number; frame: number; segment: number; carve: number; total: number };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function reconstructBoardFree(frames: readonly BoardFreeFrame[], o: BoardFreeOptions): BoardFreeResult {
  const t0 = now();
  const timings = { sfm: 0, frame: 0, segment: 0, carve: 0, total: 0 };
  const unc: BoardFreeUncertaintyInputs = { sfm: null, intrinsics: null, scale: { mmPerUnit: null, components: [], relSigma: null, coinThicknessAssumedMm: o.coinThicknessMm, coinThicknessVerified: false }, plane: null, views: [] };
  const out: BoardFreeResult = { refused: null, refusalWords: null, refusalDetail: null, sfm: null, frame: null, intrinsics: null, tablePoses: [], carveViews: [], volume: null, segmentation: [], reconstruction: null, accepted: false, uncertainty: unc, timingsMs: timings };
  const refuse = (r: BoardFreeRefusal, detail: string): BoardFreeResult => {
    timings.total = now() - t0;
    return { ...out, refused: r, refusalWords: BOARD_FREE_REFUSAL_WORDS[r], refusalDetail: detail };
  };

  // 0. cheap checks before any geometry
  const minFrames = o.minFrames ?? 40;
  if (frames.length < minFrames) return refuse("too_few_frames", `${frames.length} frames (needs ${minFrames})`);
  const { width: W, height: H } = frames[0].image;
  if (frames.some((f) => f.image.width !== W || f.image.height !== H)) return refuse("pictures_differ_in_size", "frames of different sizes");
  const coinFrames = frames.filter((f) => f.coinEdges && f.coinEdges.length >= 12).length;
  if (coinFrames === 0) return refuse("coin_missing", "no frame showed the whole coin");
  if (coinFrames < (o.minCoinFrames ?? 6)) return refuse("coin_partial", `the whole coin was found in ${coinFrames} frames (needs ${o.minCoinFrames ?? 6})`);

  // 1. camera geometry
  o.onProgress?.("sfm");
  const st = runSfmStage(frames, { coinDiameterMm: o.coinDiameterMm, coinThicknessMm: o.coinThicknessMm });
  timings.sfm = st.ms;
  out.sfm = st;
  const sfm = st.sfm;
  unc.sfm = st.uncertainty;
  if (!sfm.ok) return refuse("sfm_failed", sfm.failure ?? "no reconstruction");
  if (!sfm.accepted) return refuse("sfm_partial_registration", sfm.refusal ?? `registered ${sfm.registered} of ${frames.length}`);
  if (!(sfm.rmsPx <= (o.maxSfmRmsPx ?? 1.5))) return refuse("camera_geometry_poor", `feature RMS ${sfm.rmsPx.toFixed(2)} px`);
  if (!sfm.coinJoint || !st.mmPerUnit) return refuse("coin_fit_poor", "the coin could not be fitted");
  if (!(sfm.coinJoint.rmsPx <= (o.maxCoinRmsPx ?? 1.0))) return refuse("coin_fit_poor", `coin outline RMS ${sfm.coinJoint.rmsPx.toFixed(2)} px`);
  const K = camToIntrinsics(sfm.cam, W, H);
  out.intrinsics = K;
  unc.intrinsics = K;
  unc.scale.mmPerUnit = st.mmPerUnit;
  unc.scale.components = st.uncertainty?.coin?.scaleComponents ?? [];
  unc.scale.relSigma = st.uncertainty?.coin?.scaleRelSigma ?? null;

  // 2. table frame
  o.onProgress?.("frame");
  const tf = now();
  const plane = fitTablePlane(sfm);
  if (!plane) return refuse("no_table_plane", "no plane through the triangulated points");
  const fr = buildTableFrame(sfm, plane, st.mmPerUnit, frames, { method: o.frameMethod ?? "silhouette" });
  if (!fr.frame) return refuse("no_hand_landmarks", fr.reason);
  out.frame = fr.def;
  unc.plane = { inliers: plane.inliers, rmsMm: plane.rms * st.mmPerUnit };
  const tablePoses = sfm.poses.map((p) => (p ? poseToTable(fr.frame!, p) : null));
  out.tablePoses = tablePoses;
  let carveIdx = frames.map((f, i) => (f.carve ? i : -1)).filter((i) => i >= 0 && sfm.poses[i]);
  if (!frames.some((f) => f.carve)) carveIdx = autoCarveViews(tablePoses);
  timings.frame = now() - tf;
  const sc = segmentAndCarve(frames, tablePoses, K, carveIdx, o);
  out.carveViews = sc.carveViews;
  out.volume = sc.volume;
  if (sc.volume) fr.def.cutXMm = sc.volume.min[0];
  out.segmentation = sc.segmentation;
  out.reconstruction = sc.reconstruction;
  timings.segment = sc.ms.segment;
  timings.carve = sc.ms.carve;
  unc.views = sc.segmentation.map((s) => ({ id: s.id, tableAgreeShare: s.stats.tableAgreeShare, unknownShare: s.stats.unknownShare, reprojectionIoU: sc.reconstruction?.views.find((r) => r.id === s.id)?.reprojectionIoU ?? null, rejected: s.rejected }));
  if (sc.refused) return refuse(sc.refused.reason, sc.refused.detail);
  timings.total = now() - t0;
  return { ...out, accepted: !!sc.reconstruction?.accepted };
}

export interface SegmentAndCarveResult {
  refused: { reason: BoardFreeRefusal; detail: string } | null;
  carveViews: { id: string; frameIndex: number; pose: CameraPose }[];
  volume: { min: Vec3; max: Vec3 } | null;
  segmentation: ViewSegmentation[];
  reconstruction: CarveResult | null;
  ms: { segment: number; carve: number };
}

/** Steps 3 and 4 of the chain with given table-frame poses (one per frame, null = not placed) and full-size intrinsics:
 *  the carving views at the reconstruction size, the volume from the triangulated landmarks, the segmentation of each
 *  carving view with its neighbouring frames, and the carving. Exported so the evaluation can run the SAME steps with
 *  the exact poses (SIMULATED comparison). */
export function segmentAndCarve(frames: readonly BoardFreeFrame[], tablePoses: readonly (CameraPose | null)[], K: Intrinsics, carveIdx: readonly number[], o: BoardFreeOptions): SegmentAndCarveResult {
  const res: SegmentAndCarveResult = { refused: null, carveViews: [], volume: null, segmentation: [], reconstruction: null, ms: { segment: 0, carve: 0 } };
  const factor = o.reconstructFactor ?? 2;
  const Kr: Intrinsics = { ...K, fx: K.fx / factor, fy: K.fy / factor, cx: K.cx / factor, cy: K.cy / factor, width: K.width / factor, height: K.height / factor };
  const inputs: CarveInput[] = carveIdx
    .filter((i) => tablePoses[i])
    .map((i) => ({ id: frames[i].id, frameIndex: i, intrinsics: Kr, pose: tablePoses[i]!, landmarks: frames[i].landmarks ? frames[i].landmarks!.map((p) => (p ? { x: p.x / factor, y: p.y / factor } : null)) : null }));
  res.carveViews = inputs.map((v) => ({ id: v.id, frameIndex: v.frameIndex, pose: v.pose }));
  const minViews = o.minCarveViews ?? 12;
  if (inputs.length < minViews) return { ...res, refused: { reason: "too_few_carving_views", detail: `${inputs.length} carving views placed (needs ${minViews})` } };
  const volume = volumeFromLandmarks(inputs);
  if (!volume) return { ...res, refused: { reason: "no_hand_landmarks", detail: "too few landmarks triangulated in the carving views" } };
  res.volume = volume;

  // 3. segmentation of every carving view with its neighbouring frames
  o.onProgress?.("segment");
  const ts = now();
  const tri = triangulateLandmarks(inputs.map((v) => ({ id: v.id, intrinsics: v.intrinsics, pose: v.pose, landmarks: v.landmarks })));
  const halves = new Map<number, ReturnType<typeof halveImage>>();
  const half = (i: number) => {
    let h = halves.get(i);
    if (!h) halves.set(i, (h = halveImage(frames[i].image, factor)));
    return h;
  };
  const centre: Vec3 = [(volume.min[0] + volume.max[0]) / 2, (volume.min[1] + volume.max[1]) / 2, 10];
  const segs: ViewSegmentation[] = inputs.map((v) => {
    const nb = neighbourFrames(tablePoses, v.frameIndex, centre);
    const ctx: SegViewContext = {
      id: v.id,
      image: half(v.frameIndex),
      K: v.intrinsics,
      pose: v.pose,
      volume,
      landmarks: tri.points.map((p) => {
        if (!p) return null;
        const q = projectPoint([p.x, p.y, p.z], v.intrinsics, v.pose);
        return q ? ({ x: q.u, y: q.v } as Pt) : null;
      }),
      neighbours: nb.map((i) => ({ id: frames[i].id, image: half(i), pose: tablePoses[i]! })),
    };
    if (o.maskProvider) {
      const m = o.maskProvider(v.frameIndex, ctx.image.width, ctx.image.height);
      let hp = 0;
      for (const x of m.mask.data) if (x) hp++;
      return { id: v.id, method: o.segmentation, mask: m.mask, known: m.known, rejected: [], stats: { handPixels: hp, unknownShare: 0, tableAgreeShare: null, landmarksInside: null, neighbours: [], ms: 0 } };
    }
    return segmentView(ctx, { method: o.segmentation, cv: o.cv });
  });
  res.segmentation = segs;
  res.ms.segment = now() - ts;
  const ok = segs.map((s) => s.rejected.length === 0);
  const nOk = ok.filter(Boolean).length;
  if (nOk < minViews)
    return { ...res, refused: { reason: "segmentation_failed", detail: `${nOk} of ${inputs.length} views segmented (needs ${minViews}); reasons: ${[...new Set(segs.flatMap((s) => s.rejected.map((r) => r.split(" ")[0])))].join(", ")}` } };

  // 4. carving, labels, point cloud, gates, measurements
  o.onProgress?.("carve");
  const tc = now();
  res.reconstruction = carveBoardFree(
    inputs.map((v, k) => ({ ...v, mask: segs[k].mask, known: segs[k].known })).filter((_, k) => ok[k]),
    { voxelMm: o.voxelMm ?? 1.5, volume, cutPolicy: o.cutPolicy ?? "forearm", ignoreGate: o.ignoreGate },
  );
  res.ms.carve = now() - tc;
  return res;
}

/** Up to `max` registered frames looking at the hand from within `windowDeg` of this frame's direction (nearest
 *  first), from the SfM poses (no capture metadata needed). */
export function neighbourFrames(poses: readonly (CameraPose | null)[], i: number, centre: Vec3, windowDeg = 26, max = 4): number[] {
  const dir = (p: CameraPose) => {
    const c = centreOf(p.R as never, p.t as never);
    const d = [c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]], l = Math.hypot(d[0], d[1], d[2]);
    return [d[0] / l, d[1] / l, d[2] / l];
  };
  if (!poses[i]) return [];
  const d0 = dir(poses[i]!);
  const cosW = Math.cos((windowDeg * Math.PI) / 180);
  return poses
    .map((p, j) => ({ j, c: p && j !== i ? dir(p).reduce((s, v, k) => s + v * d0[k], 0) : -2 }))
    .filter((q) => q.c >= cosW && q.c < 1 - 1e-9)
    .sort((a, b) => b.c - a.c)
    .slice(0, max)
    .map((q) => q.j);
}

/** Without flagged stills: the steepest frame and low frames (below 20 degrees) at least 22.5 degrees apart, the
 *  directions taken from the centroid of the camera centres on the table (the sweep circles the hand). */
export function autoCarveViews(poses: readonly (CameraPose | null)[]): number[] {
  const C = poses.map((p) => (p ? centreOf(p.R as never, p.t as never) : null));
  const placed = C.filter((c): c is NonNullable<typeof c> => !!c);
  if (!placed.length) return [];
  const mx = placed.reduce((s, c) => s + c[0], 0) / placed.length, my = placed.reduce((s, c) => s + c[1], 0) / placed.length;
  const el = C.map((c) => (c ? { e: (Math.atan2(c[2], Math.hypot(c[0] - mx, c[1] - my)) * 180) / Math.PI, a: (Math.atan2(c[1] - my, c[0] - mx) * 180) / Math.PI } : null));
  const out: number[] = [];
  let top = -1;
  el.forEach((q, i) => {
    if (q && (top < 0 || q.e > el[top]!.e)) top = i;
  });
  if (top >= 0) out.push(top);
  const low = el.map((q, i) => ({ q, i })).filter(({ q }) => q && q.e < 20).sort((a, b) => a.q!.a - b.q!.a);
  let last = -Infinity;
  for (const { q, i } of low) if (q!.a - last >= 22.5 - 1e-6) ((out.push(i)), (last = q!.a));
  return out;
}
