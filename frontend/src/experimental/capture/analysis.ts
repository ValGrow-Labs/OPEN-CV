// Per-view analysis of the EXPERIMENTAL capture prototype, as pure functions: summarise a segmentation, and turn a coin
// detection into a coin-plane scale with the model-based uncertainty budget from src/experimental/geometry.
//
// EVERY millimetre figure here is a MODEL ESTIMATE, unvalidated: the coin gives the scale of its own plane only, and the
// hand's surface lies above that plane. They are produced only when an accepted coin exists in the view, and the label that
// says so travels with every number.
import type { Point } from "../../api/types";
import { coinPlaneScale, estimateMeasurementUncertainty } from "../geometry";
import type { SegmentationResult } from "../segmentation/segmentHand";
import type { CoinSnapshot, ScaleSummary, SegmentationSummary } from "./types";

export const MODEL_LABEL = "Model estimate from the coin's plane scale: unvalidated, and biased because the hand's surface lies above the coin's plane.";

export const NO_COIN_NOTE = "No accepted coin in this view, so no millimetre figures are shown.";

export function summariseSegmentation(r: SegmentationResult): SegmentationSummary {
  return {
    backend: r.backend,
    ok: r.ok,
    reasons: [...r.reasons],
    areaPx: r.areaPx,
    areaPolygonPx: r.areaPolygonPx,
    wristWidthPx: r.wristWidthPx,
    fingertips: r.fingertips.map((p) => (p ? { x: p.x, y: p.y } : null)),
    wristLine: r.wristLine ? [{ ...r.wristLine[0] }, { ...r.wristLine[1] }] : null,
    gapsPreserved: [...r.gapsPreserved],
    scaleToSource: r.scaleToSource,
    maskWidth: r.mask?.width ?? 0,
    maskHeight: r.mask?.height ?? 0,
    timingMs: { ...r.timingMs },
    error: r.error,
  };
}

export interface ScaleContext {
  referenceDiameterMm: number;
  referenceDiameterUncertaintyMm: number;
  assumedHfovDeg: readonly [number, number];
}

const NONE = (note: string): ScaleSummary => ({
  available: false,
  note,
  mmPerPx: null,
  coinTiltDeg: null,
  distanceRangeMm: null,
  areaMm2: null,
  handLengthLandmarkMm: null,
  handLengthUncertaintyMm: null,
  dominantUncertainty: null,
});

/**
 * The coin-plane scale of a view, its model uncertainty for the landmark hand length, and the silhouette area in mm2.
 * `landmarks` are in the still's pixels (wrist = 0, middle fingertip = 12). Returns an "unavailable" summary, never a guess,
 * when there is no accepted coin.
 */
export function buildScale(
  coin: CoinSnapshot | null,
  landmarks: readonly Point[],
  image: { width: number; height: number },
  seg: Pick<SegmentationResult, "ok" | "areaPx"> | null,
  ctx: ScaleContext,
): ScaleSummary {
  if (!coin || !coin.found || !coin.accepted) return NONE(NO_COIN_NOTE);
  if (!(coin.major_axis_px > 0 && coin.minor_axis_px > 0) || !(ctx.referenceDiameterMm > 0)) return NONE("The coin detection has no usable size.");
  const s = coinPlaneScale({ major_axis_px: coin.major_axis_px, minor_axis_px: coin.minor_axis_px, angle_deg: coin.angle_deg }, ctx.referenceDiameterMm, {
    imageSize: image,
    hfovRangeDeg: ctx.assumedHfovDeg,
  });
  const mmPerPx = s.mmPerPxMajor;
  const range = s.distanceRangeMm;
  const lengthPx = landmarks.length >= 13 ? Math.hypot(landmarks[12].x - landmarks[0].x, landmarks[12].y - landmarks[0].y) : 0;
  const lengthMm = lengthPx * mmPerPx;
  let handLengthUncertaintyMm: number | null = null;
  let dominant: string | null = null;
  if (lengthMm > 0 && range) {
    const budget = estimateMeasurementUncertainty({
      lengthMm,
      mmPerPx,
      coinMajorPx: Math.max(coin.major_axis_px, coin.minor_axis_px),
      referenceDiameterMm: ctx.referenceDiameterMm,
      referenceDiameterUncertaintyMm: ctx.referenceDiameterUncertaintyMm,
      distanceMm: (range[0] + range[1]) / 2, // the middle of the distance range implied by the assumed field of view
    });
    handLengthUncertaintyMm = budget.combined.value;
    dominant = budget.dominant;
  }
  return {
    available: true,
    note: MODEL_LABEL,
    mmPerPx,
    coinTiltDeg: s.tiltDeg,
    distanceRangeMm: range,
    areaMm2: seg && seg.ok ? seg.areaPx * mmPerPx * mmPerPx : null,
    handLengthLandmarkMm: lengthMm > 0 ? lengthMm : null,
    handLengthUncertaintyMm,
    dominantUncertainty: dominant,
  };
}

/** Words for a segmentation reject reason (the names of src/experimental/common.ts RejectReason). */
export const REASON_WORDS: Record<string, string> = {
  no_hand: "No hand was found in the picture.",
  hand_incomplete: "The hand is incomplete: it touches the edge of the picture or a fingertip is missing.",
  hand_blurred: "The edge of the hand is blurred.",
  hand_occluded: "Part of the hand seems covered: the landmarks fall outside the mask.",
  fingers_merged: "The gap between two fingers is closed, so the outline would be wrong there.",
  mask_implausible: "The mask is far too small, too large or broken up for this hand.",
  segmentation_failed: "The segmentation could not run on this picture.",
};

export const reasonWords = (reason: string): string => REASON_WORDS[reason] ?? reason;
