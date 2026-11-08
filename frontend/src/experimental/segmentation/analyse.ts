// analyseHand: the board-independent hand analysis of one picture (stage 2a of the experimental 3D engine).
//
//   picture + 21 landmarks (in its pixels)  ->  mask (existing GrabCut path, or another backend), part labels, per-finger
//   geometry (area, outline, fingertip, length, width profile), finger gaps, per-pixel confidence, boundary metrics and
//   gates, each rejection with a named reason.
//
// The mask's boundary is always the segmenter's: the landmarks seed the segmentation and assign hand pixels to parts,
// but are never drawn into the result (finger-gap carving is OFF here unless asked for).
// EXPERIMENTAL. Not used by the production scan, the coin pipeline or the sizing. Thresholds are provisional.
import type { BinaryMask, Pt } from "../common";
import { boundaryMetrics, type BoundaryMetrics } from "./boundary";
import { pixelConfidence, type ConfidenceResult } from "./confidence";
import {
  AREA_RATIO_RANGE,
  COLOUR_BREAK_SHARE,
  EDGE_TOUCH_MIN_PIXELS,
  GAP_MERGED_DEPTH_RATIO,
  MAX_EDGE_WIDTH_PX,
  MAX_LOW_CONFIDENCE_SHARE,
  MIN_BOUNDARY_CONFIDENCE,
  MIN_EDGE_VALID_SHARE,
  MIN_LANDMARKS_INSIDE,
  MIN_SEED_CONSISTENCY,
  MISSING_FINGER_AREA_RATIO,
  OCCLUDED_BULGE_RATIO,
  OCCLUDED_LENGTH_RATIO,
  OCCLUDED_NECK_RATIO,
} from "./constants";
import { analyseFingerGaps, type FingerGap } from "./fingerGaps";
import { TIPS, palmWidth, scaleLandmarks } from "./geometry";
import type { ImageLike } from "./imageops";
import { PART_NAMES, labelParts, measureFingers, type FingerPart, type PartName } from "./parts";
import { segmentHand, type SegBackend, type SegmentationOptions, type SegmentationResult } from "./segmentHand";

export type GateCode = "no_hand" | "segmentation_failed" | "blurred" | "incomplete" | "occluded" | "fingers_merged" | "implausible" | "low_confidence";

export interface GateReason {
  code: GateCode;
  /** Plain-language explanation with the measured number. */
  message: string;
  /** The part concerned, when the reason is about one part (a finger, or "thumb" for the thumb-index gap's first digit). */
  part?: PartName;
}

export interface HandAnalysis {
  /** True when no gate fired. A false result must not be used for any measurement. */
  ok: boolean;
  backend: SegBackend;
  /** Binary hand mask at the working size, or null. */
  mask: BinaryMask | null;
  /** Source pixels per working pixel. */
  scaleToSource: number;
  /** Part label per working pixel (PART values: 0 background, 1 palm, 2 wrist, 3 thumb .. 7 little), or null. */
  labels: Uint8Array | null;
  parts: {
    /** Thumb, index, middle, ring, little (SOURCE pixels). */
    fingers: FingerPart[];
    /** Pixel area per part, SOURCE pixels squared. */
    areaPx: Record<PartName, number>;
    /** Mask pixels that no skeleton segment reached inside the mask. */
    unlabelledPixels: number;
  };
  gaps: FingerGap[];
  /** Per working pixel: 0, 1-4 open gap of pair 0-3, 5-8 enclosed background of pair 0-3. */
  gapMap: Uint8Array | null;
  confidence: ConfidenceResult | null;
  boundaryMetrics: BoundaryMetrics | null;
  gates: { ok: boolean; reasons: GateReason[] };
  /** The underlying segmentation (contour, wrist line, the legacy quality numbers and reasons). */
  segmentation: SegmentationResult;
  /** Milliseconds per stage in the runtime that ran it. */
  timings: Record<string, number>;
}

export interface AnalyseOptions extends SegmentationOptions {
  /** Skip the per-pixel confidence (it is the slowest analysis stage). Default false. */
  skipConfidence?: boolean;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const pct = (v: number) => `${Math.round(v * 100)} %`;

/** Analyse the hand in `image`. `landmarks` are the 21 MediaPipe points in the image's pixels (null = no hand). */
export async function analyseHand(image: ImageLike, landmarks: readonly Pt[] | null, opts: AnalyseOptions = {}): Promise<HandAnalysis> {
  const timings: Record<string, number> = {};
  const t0 = now();
  let t = t0;
  const lap = (name: string) => {
    const n = now();
    timings[name] = n - t;
    t = n;
  };
  const seg = await segmentHand(image, landmarks, { ...opts, carveGaps: opts.carveGaps ?? false });
  lap("segment");
  const zeroAreas = Object.fromEntries(PART_NAMES.map((p) => [p, 0])) as Record<PartName, number>;
  const base: HandAnalysis = {
    ok: false,
    backend: seg.backend,
    mask: seg.mask,
    scaleToSource: seg.scaleToSource,
    labels: null,
    parts: { fingers: [], areaPx: zeroAreas, unlabelledPixels: 0 },
    gaps: [],
    gapMap: null,
    confidence: null,
    boundaryMetrics: null,
    gates: { ok: false, reasons: [] },
    segmentation: seg,
    timings,
  };
  if (!landmarks || landmarks.length < 21) {
    base.gates.reasons.push({ code: "no_hand", message: "no hand landmarks were given" });
    timings.total = now() - t0;
    return base;
  }
  if (!seg.mask || !seg.workingImage || seg.areaPx === 0) {
    base.gates.reasons.push({ code: "segmentation_failed", message: seg.error ? `the segmentation failed: ${seg.error}` : "the segmentation produced no mask" });
    timings.total = now() - t0;
    return base;
  }
  const { width: W, height: H, data: mask } = seg.mask;
  const k = seg.scaleToSource;
  const lm = scaleLandmarks(landmarks, 1 / k);
  const pw = palmWidth(lm);

  const pl = labelParts(mask, W, H, lm);
  const fingers = measureFingers(pl.labels, mask, W, H, lm, k, seg.workingImage);
  const areaPx = Object.fromEntries(PART_NAMES.map((p, i) => [p, pl.counts[i] * k * k])) as Record<PartName, number>;
  lap("parts");
  const gapRes = analyseFingerGaps(mask, W, H, lm, fingers, k);
  lap("gaps");
  const confidence = opts.skipConfidence ? null : pixelConfidence(seg.workingImage, mask, pw, pl.labels, seg.colourModel ?? null, forearmSide(W, H, lm));
  lap("confidence");
  const bm = boundaryMetrics(seg.mask, seg.workingImage, lm, fingers, pw);
  lap("boundary");
  const reasons = gate({ seg, lm, W, H, pw, fingers, gaps: gapRes.gaps, confidence, unlabelled: pl.unlabelledPixels, maskPixels: seg.areaPx / (k * k), bm });
  lap("gates");
  timings.total = now() - t0;
  return {
    ...base,
    ok: reasons.length === 0,
    labels: pl.labels,
    parts: { fingers, areaPx, unlabelledPixels: pl.unlabelledPixels },
    gaps: gapRes.gaps,
    gapMap: gapRes.gapMap,
    confidence,
    boundaryMetrics: bm,
    gates: { ok: reasons.length === 0, reasons },
  };
}

/** Pixels on the forearm side of the wrist line (the half-plane the wrist cut removes; fingers.ts cutAtWrist rule). */
export function forearmSide(w: number, h: number, lm: readonly Pt[]): Uint8Array {
  const c = { x: (lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 4, y: (lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 4 };
  const ax = lm[0].x - c.x;
  const ay = lm[0].y - c.y;
  const l = Math.hypot(ax, ay) || 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (((x + 0.5 - lm[0].x) * ax + (y + 0.5 - lm[0].y) * ay) / l > 0) out[y * w + x] = 255;
  return out;
}

interface GateInput {
  seg: SegmentationResult;
  lm: readonly Pt[];
  W: number;
  H: number;
  pw: number;
  fingers: readonly FingerPart[];
  gaps: readonly FingerGap[];
  confidence: ConfidenceResult | null;
  unlabelled: number;
  maskPixels: number;
  bm: BoundaryMetrics;
}

/** Every gate that fires, with its reason. Order: incomplete, blurred, occluded, merged, implausible, low confidence. */
export function gate(g: GateInput): GateReason[] {
  const r: GateReason[] = [];
  const q = g.seg.quality;
  // ---- incomplete: the hand is cut by the image border, or a fingertip lies outside the frame.
  const cutFingers = new Set<string>();
  if (q && q.edgeTouchPixels >= EDGE_TOUCH_MIN_PIXELS) r.push({ code: "incomplete", message: `the hand touches the image border (${q.edgeTouchPixels} mask pixels at the edge)` });
  g.fingers.forEach((f, d) => {
    const p = g.lm[TIPS[d]];
    if (p.x < 0 || p.y < 0 || p.x >= g.W || p.y >= g.H) {
      cutFingers.add(f.finger);
      r.push({ code: "incomplete", message: `the ${f.finger} fingertip landmark lies outside the frame`, part: f.finger });
    } else if (f.touchesBorder) {
      cutFingers.add(f.finger);
      r.push({ code: "incomplete", message: `the ${f.finger} is cut by the image border`, part: f.finger });
    }
  });
  // ---- blurred (the existing edge-width measure).
  if (q && q.edgeWidthPx !== null && q.edgeValidShare >= MIN_EDGE_VALID_SHARE && q.edgeWidthPx > MAX_EDGE_WIDTH_PX) {
    r.push({ code: "blurred", message: `the hand outline is blurred: median edge width ${q.edgeWidthPx.toFixed(1)} px (limit ${MAX_EDGE_WIDTH_PX})` });
  }
  // ---- occluded: a finger missing, shorter than its landmark chain, narrowing to a neck, or covered seeds.
  g.fingers.forEach((f, d) => {
    if (cutFingers.has(f.finger)) return; // the border explains it
    const k = g.seg.scaleToSource;
    const expectedArea = (f.landmarkLengthPx / k) * 0.2 * g.pw;
    if (!f.present || f.areaPx / (k * k) < MISSING_FINGER_AREA_RATIO * expectedArea) {
      r.push({ code: "occluded", message: `the ${f.finger} is missing from the mask (${f.present ? pct(f.areaPx / (k * k) / expectedArea) : "no pixels"} of the area its landmarks imply)`, part: f.finger });
      return;
    }
    if (f.lengthRatio < OCCLUDED_LENGTH_RATIO) {
      r.push({ code: "occluded", message: `the ${f.finger} reaches only ${pct(f.lengthRatio)} of its landmark length`, part: f.finger });
    }
    if (f.neck && f.neck.ratio < OCCLUDED_NECK_RATIO) {
      r.push({ code: "occluded", message: `the ${f.finger} narrows to ${pct(f.neck.ratio)} of its median width at ${pct(f.neck.at)} of its length (something may cover it)`, part: f.finger });
    }
    if (f.bulge && f.bulge.ratio > OCCLUDED_BULGE_RATIO) {
      r.push({ code: "occluded", message: `the ${f.finger} widens to ${pct(f.bulge.ratio)} of its median width at ${pct(f.bulge.at)} of its length (something may lie over it)`, part: f.finger });
    }
    if (f.colourBreak && f.colourBreak.share > COLOUR_BREAK_SHARE) {
      r.push({ code: "occluded", message: `${pct(f.colourBreak.share)} of the ${f.finger}'s pixels around ${pct(f.colourBreak.at)} of its length are not hand-coloured (an object over the finger?)`, part: f.finger });
    }
    const tip = g.bm.fingertips[d];
    if (!tip.landmarkInside) r.push({ code: "occluded", message: `the ${f.finger} fingertip landmark is not on the mask`, part: f.finger });
  });
  if (q && q.seedConsistency < MIN_SEED_CONSISTENCY) {
    r.push({ code: "occluded", message: `only ${pct(q.seedConsistency)} of the pixels along the landmark skeleton share the hand's colour (something may cover part of the hand)` });
  }
  if (q && q.landmarksInsideShare < MIN_LANDMARKS_INSIDE) {
    r.push({ code: "occluded", message: `${Math.round((1 - q.landmarksInsideShare) * 21)} of 21 landmarks lie off the mask` });
  }
  // ---- merged fingers.
  for (const gp of g.gaps) {
    if (!gp.merged) continue;
    const how =
      gp.status !== "open"
        ? gp.status === "enclosed"
          ? "only enclosed background is left between them"
          : "no background is left between them"
        : gp.enclosedAreaPx > 0 && gp.depthRatio >= GAP_MERGED_DEPTH_RATIO
          ? "something bridges them, enclosing background between them"
          : `the open gap reaches only ${pct(gp.depthRatio)} of the expected depth`;
    r.push({ code: "fingers_merged", message: `the ${gp.names[0]} and ${gp.names[1]} are joined in the mask although the landmarks show them apart (${how})`, part: gp.names[0] });
  }
  // ---- implausible regions.
  if (q) {
    if (q.areaRatio < AREA_RATIO_RANGE[0] || q.areaRatio > AREA_RATIO_RANGE[1]) {
      r.push({ code: "implausible", message: `the mask is ${q.areaRatio.toFixed(2)} x the landmark hull area (expected ${AREA_RATIO_RANGE[0]}-${AREA_RATIO_RANGE[1]})` });
    }
    if (q.strayShare > 0.25) r.push({ code: "implausible", message: `${pct(q.strayShare)} of the raw mask lay in pieces not connected to the hand` });
  }
  if (g.maskPixels > 0 && g.unlabelled / g.maskPixels > 0.02) {
    r.push({ code: "implausible", message: `${pct(g.unlabelled / g.maskPixels)} of the mask could not be reached from the landmark skeleton inside the mask` });
  }
  // ---- low confidence.
  if (g.confidence) {
    const s = g.confidence.summary;
    if (s.meanBoundaryBand < MIN_BOUNDARY_CONFIDENCE) r.push({ code: "low_confidence", message: `mean confidence along the boundary is ${s.meanBoundaryBand.toFixed(2)} (minimum ${MIN_BOUNDARY_CONFIDENCE})` });
    if (s.lowShareHand > MAX_LOW_CONFIDENCE_SHARE) r.push({ code: "low_confidence", message: `${pct(s.lowShareHand)} of the hand pixels have confidence below 0.5` });
  }
  return r;
}
