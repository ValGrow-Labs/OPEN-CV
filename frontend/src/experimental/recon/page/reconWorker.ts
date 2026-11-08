// The EXPERIMENTAL board reconstruction off the main thread: the captured pictures (their pixel buffers are transferred
// here, and back at the end so the page can still export them) go through recon/chain.ts reconstructFromImages (marker
// detection, camera self-calibration, board poses, known-board segmentation, landmark triangulation, carving, labelled
// mesh, measurements); then the coin on the top view is measured in board millimetres with the CALIBRATED camera, to
// catch a board printed at the wrong scale.
import type { Pt } from "../../common";
import { checkCoinScale } from "../../board/coinCheck";
import { reconstructFromImages, type ChainProgress, type ImageView } from "../chain";
import type { CoinCheckSummary, ReconOutcome } from "./types";

export interface ReconViewInput {
  id: string;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  /** 21 landmarks in pixels of this picture, or null (MediaPipe found no hand). */
  landmarks: (Pt | null)[] | null;
}

export interface ReconRequest {
  views: ReconViewInput[];
  /** The top view's id (the coin check needs a view from 45 degrees or more above the board). */
  topViewId: string | null;
  coin: { referenceDiameterMm: number; thicknessMm: number | null } | null;
  voxelMm: number;
}

export type ReconReply =
  | { type: "progress"; progress: ChainProgress | { stage: "coin" } }
  | { type: "done"; outcome: ReconOutcome; buffers: ArrayBuffer[] }
  | { type: "error"; message: string; buffers: ArrayBuffer[] };

export function runReconstruction(req: ReconRequest, onProgress: (p: ChainProgress | { stage: "coin" }) => void = () => undefined): ReconOutcome {
  const t0 = performance.now();
  const views: ImageView[] = req.views.map((v) => ({ id: v.id, image: { width: v.width, height: v.height, data: new Uint8ClampedArray(v.buffer) }, landmarks: v.landmarks }));
  const chain = reconstructFromImages(views, { reconstruct: { voxelMm: req.voxelMm }, onProgress });
  const t1 = performance.now();
  let coin: CoinCheckSummary | null = null;
  if (req.coin) {
    onProgress({ stage: "coin" });
    coin = coinCheckOnTop(req, views, chain);
  }
  const t2 = performance.now();
  return { chain, coin, timingsMs: { chain: t1 - t0, coin: t2 - t1, total: t2 - t0 } };
}

function coinCheckOnTop(req: ReconRequest, views: ImageView[], chain: ReturnType<typeof reconstructFromImages>): CoinCheckSummary {
  const ref = req.coin!;
  const base = { referenceDiameterMm: ref.referenceDiameterMm, thicknessMm: ref.thicknessMm, viewId: req.topViewId };
  if (!chain.cameras || chain.cameras.calibration.assumed) return { ...base, ok: false, reason: "not_calibrated", detail: "The camera was not calibrated, so the coin cannot be measured in board millimetres." };
  const i = views.findIndex((v) => v.id === req.topViewId);
  const cam = i >= 0 ? chain.cameras.views[i] : null;
  if (!cam || !cam.pose) return { ...base, ok: false, reason: "no_top_pose", detail: "The top view has no board pose." };
  // The chain's poses use pixel centres at +0.5 (pixel i spans [i, i + 1)); the coin check samples with pixel centres on
  // whole numbers (as OpenCV): shift the principal point by half a pixel so both agree.
  const K = chain.cameras.intrinsics;
  const Kc = { ...K, cx: K.cx - 0.5, cy: K.cy - 0.5 };
  const r = checkCoinScale(views[i].image, Kc, cam.pose, { referenceDiameterMm: ref.referenceDiameterMm, ...(ref.thicknessMm ? { coinThicknessMm: ref.thicknessMm } : {}) });
  if (!r.ok) return { ...base, ok: false, reason: r.reason, detail: r.detail, elevationDeg: r.elevationDeg ?? null };
  return {
    ...base,
    ok: true,
    diameterMm: r.diameterMm,
    circleDiameterMm: r.circleDiameterMm,
    printScale: r.printScale,
    residualMm: r.residualMm,
    centerOffsetMm: r.centerOffsetMm,
    elevationDeg: r.elevationDeg,
  };
}

/** Every distinct ArrayBuffer of the outcome's large arrays (to transfer them instead of copying). */
export function outcomeBuffers(o: ReconOutcome): ArrayBuffer[] {
  const set = new Set<ArrayBuffer>();
  const rec = o.chain.reconstruction;
  const add = (a: { buffer: ArrayBufferLike } | null | undefined) => {
    if (a && a.buffer instanceof ArrayBuffer) set.add(a.buffer);
  };
  if (rec) {
    add(rec.mesh?.vertices);
    add(rec.mesh?.indices);
    add(rec.confidence);
    add(rec.support);
    add(rec.pointCloud?.points);
    add(rec.pointCloud?.labels);
  }
  return [...set];
}

const scope = globalThis as unknown as { WorkerGlobalScope?: unknown; postMessage: (m: ReconReply, t?: Transferable[]) => void; onmessage: unknown };
if (typeof scope.WorkerGlobalScope !== "undefined") {
  scope.onmessage = (e: MessageEvent<ReconRequest>) => {
    const req = e.data;
    const buffers = req.views.map((v) => v.buffer);
    try {
      const outcome = runReconstruction(req, (progress) => scope.postMessage({ type: "progress", progress }));
      scope.postMessage({ type: "done", outcome, buffers }, [...outcomeBuffers(outcome), ...buffers]);
    } catch (err) {
      scope.postMessage({ type: "error", message: String(err instanceof Error ? err.message : err), buffers }, buffers);
    }
  };
}
