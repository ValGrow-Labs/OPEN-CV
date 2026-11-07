// The in-memory data model of the EXPERIMENTAL capture prototype. Captured views live only in memory on this device: they are
// never sent anywhere, and they vanish when the page is reloaded or "Clear all captures" is pressed.
import type { Point } from "../../api/types";
import type { CoinDetection } from "../../vision/coinDetector";
import type { Pt } from "../common";
import type { ViewDef, ViewId } from "./views";

/** What the browser says about the camera stream (JSON-safe copies). */
export interface StreamInfo {
  settings: Record<string, unknown>;
  capabilities: Record<string, unknown> | null;
  /** The track's label is a device name; it is recorded because it identifies the lens, and listed in the README as personal-ish data. */
  label: string;
  facing: "user" | "environment";
}

/** A coin detection without the candidate list (numbers only). Coordinates are in the still's pixels. */
export type CoinSnapshot = Omit<CoinDetection, "candidates">;

export interface QualitySnapshot {
  /** True only when every check passed on the frame that was captured. */
  passed: boolean;
  /** Plain-language reasons (empty when passed). */
  reasons: string[];
  /** How the capture was triggered. */
  trigger: "auto" | "button";
  sharpness: number | null;
  jitter: number | null;
  turn: number | null;
}

export interface SegmentationSummary {
  backend: string;
  ok: boolean;
  reasons: string[];
  areaPx: number;
  areaPolygonPx: number;
  wristWidthPx: number;
  fingertips: (Pt | null)[];
  wristLine: [Pt, Pt] | null;
  gapsPreserved: boolean[];
  /** Source pixels per working pixel of the mask. */
  scaleToSource: number;
  maskWidth: number;
  maskHeight: number;
  timingMs: Record<string, number>;
  error?: string;
}

/** Every millimetre figure of the prototype is a MODEL ESTIMATE from the coin's plane scale: unvalidated, and biased because the
 *  hand's surface lies above the coin's plane. They are shown only when a valid coin scale exists. */
export interface ScaleSummary {
  available: boolean;
  /** Why not available, or the label that must accompany any number. */
  note: string;
  mmPerPx: number | null;
  coinTiltDeg: number | null;
  distanceRangeMm: [number, number] | null;
  /** Projected silhouette area at the coin-plane scale, mm2 (model estimate). */
  areaMm2: number | null;
  /** Wrist-to-middle-fingertip distance from the landmarks at the coin-plane scale, mm, with the model budget. */
  handLengthLandmarkMm: number | null;
  handLengthUncertaintyMm: number | null;
  dominantUncertainty: string | null;
}

export interface ViewAnalysis {
  segmentation: SegmentationSummary | null;
  scale: ScaleSummary | null;
  /** Wall-clock milliseconds the whole analysis took on this device. */
  totalMs: number;
}

export interface CapturedView {
  def: ViewDef;
  /** 1-based order of capture. */
  order: number;
  capturedAt: string;
  quality: QualitySnapshot;
  still: { blob: Blob; width: number; height: number; pixels: ImageData };
  /** An optional full-resolution still from ImageCapture.takePhoto(), when the browser has it. */
  highRes: { blob: Blob; width: number; height: number; mime: string } | null;
  landmarks: Point[];
  world: Point[] | null;
  handedness: "Left" | "Right" | null;
  handednessScore: number | null;
  coin: CoinSnapshot | null;
  stream: StreamInfo;
  analysis: ViewAnalysis | null;
  /** The binary mask as a PNG (white = hand), when segmentation produced one. */
  maskPng: Blob | null;
}

export type ViewStatus = "pending" | "captured" | "captured_unchecked" | "skipped";

export interface ViewRecord {
  def: ViewDef;
  status: ViewStatus;
}

export type { ViewId };
