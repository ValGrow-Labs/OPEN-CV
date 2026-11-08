// SIMULATED evaluation helpers of the EXPERIMENTAL board-free chain (test support; Node only). Compares, on the same
// rendered hand: the full board-free chain, the same steps with the exact poses, the renderer's exact masks, and the
// board route (recon/chain.ts, imported unchanged). Every number produced here is SIMULATED.
import type { BinaryMask, CameraPose, Intrinsics } from "../common";
import type { CV } from "../../vision/opencv";
import { boardRig, makeBoardScene, projectLandmarks, renderView, SKIN_TONES } from "../multiview/scene";
import { reconstructFromImages, type ImageView } from "../recon/chain";
import type { HandMeasurements } from "../reconstruction/measure";
import { INR2_DIAMETER_MM, INR2_THICKNESS_ASSUMED_MM } from "../sfm/scene";
import { reconstructBoardFree, segmentAndCarve, type BoardFreeOptions, type BoardFreeResult } from "./chain";
import type { CarveResult } from "./carve";
import type { SimCapture, SkinName } from "./simulate";
import type { SegmentationMethod } from "./types";

export interface Row {
  route: string;
  accepted: boolean | null;
  reasons: string;
  errors: Record<"length" | "breadth" | "thickness" | "circumference", number | null>;
  minIoU: number | null;
  meanIoU: number | null;
  /** IoU per carving view (null = not checkable). */
  ious: (number | null)[];
  seconds: Record<string, number>;
}

export const SIM_COIN = { coinDiameterMm: INR2_DIAMETER_MM, coinThicknessMm: INR2_THICKNESS_ASSUMED_MM };

/** Halve the renderer's exact mask (2 x 2 majority), every pixel known. */
export function truthMaskProvider(cap: SimCapture) {
  return (i: number, w: number, h: number): { mask: BinaryMask; known: BinaryMask } => {
    const full = cap.truth.handMask(i);
    const W = cap.truth.cams[i].intrinsics.width;
    const f = W / w;
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let c = 0;
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) if (full[(y * f + dy) * W + x * f + dx]) c++;
        m[y * w + x] = 2 * c >= f * f ? 255 : 0;
      }
    return { mask: { width: w, height: h, data: m }, known: { width: w, height: h, data: new Uint8Array(w * h).fill(255) } };
  };
}

export function rowOf(route: string, rec: CarveResult | null, truth: SimCapture["truth"]["scene"]["hand"]["truth"], seconds: Record<string, number>, refused?: string | null): Row {
  const m: HandMeasurements | null = rec?.measurements ?? null;
  const e = (q: { value: number | null } | undefined, t: number) => (q && q.value !== null ? q.value - t : null);
  const ious = rec ? rec.views.map((v) => v.reprojectionIoU) : [];
  return {
    route,
    accepted: rec ? rec.accepted : null,
    reasons: refused ? `refused: ${refused}` : rec ? rec.reasons.join(", ") : "",
    errors: { length: e(m?.handLength, truth.handLength), breadth: e(m?.palmBreadth, truth.palmBreadth), thickness: e(m?.palmThickness, truth.palmThickness), circumference: e(m?.circumferenceKnuckle, truth.circumference) },
    minIoU: rec?.quality ? rec.quality.metrics.minIoU : null,
    meanIoU: rec?.quality ? rec.quality.metrics.meanIoU : null,
    ious,
    seconds,
  };
}

/** The full board-free chain on a simulated capture. */
export function runChain(cap: SimCapture, method: SegmentationMethod, cv: CV | undefined, extra: Partial<BoardFreeOptions> = {}): { result: BoardFreeResult; row: Row } {
  const result = reconstructBoardFree(cap.frames, { ...SIM_COIN, segmentation: method, cv, ...extra });
  const t = result.timingsMs;
  return {
    result,
    row: rowOf(`board-free chain, SfM poses, ${extra.maskProvider ? "EXACT masks" : `${method} segmentation`}`, result.reconstruction, cap.truth.scene.hand.truth, { sfm: t.sfm / 1000, segment: t.segment / 1000, carve: t.carve / 1000, total: t.total / 1000 }, result.refused ? `${result.refused} (${result.refusalDetail})` : null),
  };
}

/** The same segmentation and carving steps with the EXACT poses and intrinsics (the table frame = the truth frame). */
export function runExactPoses(cap: SimCapture, method: SegmentationMethod | "truth", cv: CV | undefined): Row {
  const t0 = performance.now();
  const poses: (CameraPose | null)[] = cap.truth.cams.map((c) => c.pose);
  const K: Intrinsics = cap.truth.cams[0].intrinsics;
  const idx = cap.frames.map((f, i) => (f.carve ? i : -1)).filter((i) => i >= 0);
  const r = segmentAndCarve(cap.frames, poses, K, idx, { ...SIM_COIN, segmentation: method === "truth" ? "plane" : method, cv, ...(method === "truth" ? { maskProvider: truthMaskProvider(cap) } : {}) });
  return rowOf(`exact poses and intrinsics, ${method === "truth" ? "EXACT masks" : `${method} segmentation`}`, r.reconstruction, cap.truth.scene.hand.truth, { segment: r.ms.segment / 1000, carve: r.ms.carve / 1000, total: (performance.now() - t0) / 1000 }, r.refused ? r.refused.reason : null);
}

/** The board route (recon/chain.ts reconstructFromImages, unchanged): the same hand on the printed board, the board
 *  capture's 17 stills, 1280 x 720, the same unknown-to-the-chain lens. */
export function runBoardRoute(skin: SkinName = "medium"): Row {
  const scene = makeBoardScene();
  const cams = boardRig(scene, { width: 1280, height: 720, hfovDeg: 64, k1: -0.06, k2: 0.02, lowCount: 16, highCount: 0 });
  const views: ImageView[] = cams.map((c, i) => ({
    id: c.id,
    image: renderView(scene, c.intrinsics, c.pose, { skin: SKIN_TONES[skin], seed: i + 1 }).image,
    landmarks: projectLandmarks(scene.landmarks, c.intrinsics, c.pose, { noisePx: 2, seed: 100 + i }),
  }));
  const r = reconstructFromImages(views, { reconstruct: { voxelMm: 1.5 } });
  const rec = r.reconstruction;
  const T = scene.truth;
  const m = rec?.measurements ?? null;
  const e = (q: { value: number | null } | undefined, t: number) => (q && q.value !== null ? q.value - t : null);
  const ious = rec ? rec.views.map((v) => v.reprojectionIoU) : [];
  return {
    route: "board route (recon/chain.ts: markers, self-calibration, board segmentation)",
    accepted: rec ? rec.accepted : null,
    reasons: r.refused ? `refused: ${r.refused}` : rec ? rec.reasons.join(", ") : "",
    errors: { length: e(m?.handLength, T.handLength), breadth: e(m?.palmBreadth, T.palmBreadth), thickness: e(m?.palmThickness, T.palmThickness), circumference: e(m?.circumferenceKnuckle, T.circumference) },
    minIoU: rec?.quality ? rec.quality.metrics.minIoU : null,
    meanIoU: rec?.quality ? rec.quality.metrics.meanIoU : null,
    ious,
    seconds: { detect: r.timingsMs.detect / 1000, calibrate: r.timingsMs.calibrate / 1000, reconstruct: r.timingsMs.reconstruct / 1000, total: r.timingsMs.total / 1000 },
  };
}

const f = (v: number | null, d = 1) => (v === null || !Number.isFinite(v) ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}`);
export const TABLE_HEADER =
  "| route | gates passed | length | breadth | thickness | knuckle circ. (upper bound) | min / mean IoU | time s |\n|---|---|---|---|---|---|---|---|";
export function tableRow(r: Row): string {
  const t = Object.entries(r.seconds).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ");
  return `| ${r.route} | ${r.accepted === null ? "n/a" : r.accepted ? "yes" : "no"} [${r.reasons}] | ${f(r.errors.length)} | ${f(r.errors.breadth)} | ${f(r.errors.thickness)} | ${f(r.errors.circumference)} | ${r.minIoU === null ? "n/a" : r.minIoU.toFixed(3)} / ${r.meanIoU === null ? "n/a" : r.meanIoU.toFixed(3)} | ${t} |`;
}
