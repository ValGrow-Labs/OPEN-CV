// segmentHand: the experimental hand segmentation pipeline. One entry point over three backends, then the same
// post-processing, hand analysis and quality gates for all of them.
//
//   frame (RGBA, any size) + the 21 landmarks in its pixels  ->  mask, contour, area, fingertips, wrist line,
//   finger gaps, quality numbers and, when the result is unusable, the named reasons.
//
// EXPERIMENTAL. Landmarks seed the segmentation (where the hand certainly is / is not); they are never the mask.
// Nothing here is used by the production scan, the coin pipeline or the sizing.
import type { InteractiveSegmenter } from "@mediapipe/tasks-vision";
import type { BinaryMask, Pt, RejectReason } from "../common";
import type { CV } from "../../vision/opencv";
import { runGrabCut } from "./backends/grabcut";
import { runInteractive } from "./backends/interactive";
import { runSkin } from "./backends/skin";
import { DEFAULT_WORKING_SIZE, GRABCUT_ITERATIONS, MAX_FILLED_HOLE_FRACTION } from "./constants";
import { analyseGaps, cutAtWrist, refineFingertips, tipsFound, type GapReport } from "./fingers";
import { scaleLandmarks } from "./geometry";
import { toGray, toWorking, type ImageLike } from "./imageops";
import { contourArea, maskToContour, simplifyPolygon } from "./metrics";
import { countOn, fillSmallHoles, keepMainComponent, majority3, open } from "./morph";
import { gateReasons, measureQuality, type QualityNumbers } from "./quality";
import { buildSeeds } from "./seeds";

export type SegBackend = "grabcut" | "interactive" | "skin";

export interface SegmentationOptions {
  /** Which segmentation to run (default "grabcut"). */
  backend?: SegBackend;
  /** Longest side of the working image in pixels (default 512). The result mask is at this size. */
  workingSize?: number;
  /** Clear a thin line along the valley between two spread fingers if the mask has merged them (default true). */
  carveGaps?: boolean;
  /** OpenCV.js, required for the "grabcut" backend (load it with loadOpenCV from src/vision/opencv). */
  cv?: CV;
  /** A created InteractiveSegmenter, required for the "interactive" backend (createInteractiveSegmenter). */
  interactiveSegmenter?: InteractiveSegmenter;
  grabCutIterations?: number;
}

export interface SegmentationResult {
  /** True when no quality gate fired. A false result must not be used for any measurement. */
  ok: boolean;
  reasons: RejectReason[];
  backend: SegBackend;
  /** Binary hand mask at the working size (wrist-cut, main component, gaps preserved), or null when none was made. */
  mask: BinaryMask | null;
  /** Source pixels per working pixel (multiply mask coordinates by this to get source coordinates). */
  scaleToSource: number;
  /** Outer contour in SOURCE pixels (simplified to ~0.7 working pixels). Empty when there is no mask. */
  contour: Pt[];
  /** Projected hand area in SOURCE pixels squared: mask pixel count divided by scale squared. 0 when no mask. */
  areaPx: number;
  /** The same area from the contour polygon (source pixels squared). */
  areaPolygonPx: number;
  /** Thumb, index, middle, ring, pinky tip in SOURCE pixels as found in the mask (null = not recovered). */
  fingertips: (Pt | null)[];
  /** Where the mask is cut at the wrist (two ends, SOURCE pixels), or null. */
  wristLine: [Pt, Pt] | null;
  /** Width of the cut across the wrist in SOURCE pixels. */
  wristWidthPx: number;
  /** For thumb-index, index-middle, middle-ring, ring-pinky: is the gap between them open in the mask. */
  gapsPreserved: boolean[];
  gaps: GapReport[];
  quality: QualityNumbers | null;
  /** Milliseconds per stage, in the browser that ran it. */
  timingMs: Record<string, number>;
  /** Set when a backend threw: the message (reasons then contain "segmentation_failed"). */
  error?: string;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function empty(backend: SegBackend, reasons: RejectReason[], timingMs: Record<string, number>, error?: string): SegmentationResult {
  return {
    ok: false,
    reasons,
    backend,
    mask: null,
    scaleToSource: 1,
    contour: [],
    areaPx: 0,
    areaPolygonPx: 0,
    fingertips: [null, null, null, null, null],
    wristLine: null,
    wristWidthPx: 0,
    gapsPreserved: [false, false, false, false],
    gaps: [],
    quality: null,
    timingMs,
    error,
  };
}

/** Segment the hand in `frame`. `landmarks` are the 21 MediaPipe points in the frame's pixels (null = no hand). */
export async function segmentHand(frame: ImageLike, landmarks: readonly Pt[] | null, options: SegmentationOptions = {}): Promise<SegmentationResult> {
  const backend = options.backend ?? "grabcut";
  const timing: Record<string, number> = {};
  const t0 = now();
  let t = t0;
  const lap = (name: string) => {
    const n = now();
    timing[name] = n - t;
    t = n;
  };

  if (!landmarks || landmarks.length < 21) return empty(backend, ["no_hand"], timing);

  const { image, scale } = toWorking(frame, options.workingSize ?? DEFAULT_WORKING_SIZE);
  const W = image.width;
  const H = image.height;
  const lm = scaleLandmarks(landmarks, scale);
  lap("resize");

  const seeds = buildSeeds(lm, W, H);
  lap("seeds");

  let raw: Uint8Array;
  try {
    if (backend === "grabcut") {
      if (!options.cv) throw new Error("the grabcut backend needs options.cv");
      raw = runGrabCut(options.cv, image, seeds, options.grabCutIterations ?? GRABCUT_ITERATIONS);
    } else if (backend === "interactive") {
      if (!options.interactiveSegmenter) throw new Error("the interactive backend needs options.interactiveSegmenter");
      raw = runInteractive(options.interactiveSegmenter, image, lm);
    } else {
      raw = runSkin(image, seeds);
    }
  } catch (err) {
    lap("backend");
    timing.total = now() - t0;
    return { ...empty(backend, ["segmentation_failed"], timing, String(err instanceof Error ? err.message : err)), scaleToSource: 1 / scale };
  }
  lap("backend");

  // Post-processing: forearm cut, main component, small holes, smoothing, finger gaps.
  const wrist = cutAtWrist(raw, W, H, lm);
  let { mask: main, strayShare } = keepMainComponent(wrist.mask, W, H, seeds.sureFg);
  main = fillSmallHoles(main, W, H, Math.max(4, Math.round(MAX_FILLED_HOLE_FRACTION * countOn(main))));
  main = open(majority3(main, W, H), W, H, 1); // no closing: a closing would seal narrow real gaps between fingers
  main = keepMainComponent(main, W, H, seeds.sureFg).mask;
  lap("post");

  const gapAnalysis = analyseGaps(main, W, H, lm, options.carveGaps ?? true);
  const finalMask = keepMainComponent(gapAnalysis.mask, W, H, seeds.sureFg).mask;
  lap("gaps");

  const mask: BinaryMask = { width: W, height: H, data: finalMask };
  const crack = maskToContour(mask);
  const contourWork = simplifyPolygon(crack, 0.7);
  const contour = contourWork.map((p) => ({ x: p.x / scale, y: p.y / scale }));
  const pixels = countOn(finalMask);
  lap("contour");

  const tips = refineFingertips(finalMask, W, H, lm);
  const wristFinal = cutAtWrist(finalMask, W, H, lm);
  lap("hand");

  const quality = measureQuality({
    mask,
    image,
    gray: toGray(image),
    landmarks: lm,
    palmWidthPx: seeds.palmWidthPx,
    hullArea: seeds.hullArea,
    sureFg: seeds.sureFg,
    tipsFound: tipsFound(tips),
    gaps: gapAnalysis.gaps,
    strayShare,
  });
  const reasons = pixels === 0 ? (["segmentation_failed"] as RejectReason[]) : gateReasons(quality, gapAnalysis.gaps);
  lap("quality");
  timing.total = now() - t0;

  const toSource = (p: Pt): Pt => ({ x: p.x / scale, y: p.y / scale });
  return {
    ok: reasons.length === 0,
    reasons,
    backend,
    mask,
    scaleToSource: 1 / scale,
    contour,
    areaPx: pixels / (scale * scale),
    areaPolygonPx: contourArea(crack) / (scale * scale),
    fingertips: tips.map((x) => (x.point ? toSource({ x: x.point.x, y: x.point.y }) : null)),
    wristLine: wristFinal.line ? ([toSource(wristFinal.line[0]), toSource(wristFinal.line[1])] as [Pt, Pt]) : null,
    wristWidthPx: wristFinal.widthPx / scale,
    gapsPreserved: gapAnalysis.gaps.map((g) => g.preserved),
    gaps: gapAnalysis.gaps,
    quality,
    timingMs: timing,
  };
}
