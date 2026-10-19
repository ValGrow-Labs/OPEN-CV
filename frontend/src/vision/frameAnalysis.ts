// Per-frame analysis (mirror of backend/glovesize/frame_analysis.py).
import type { CoinDetectionParams, FrameObservation, Point } from "../api/types";
import { toObservation, type CoinDetection } from "./coinDetector";
import { MIDDLE_MCP, WRIST, dist, palmCentre } from "./geometry";

export interface SearchWindow {
  roi: { x: number; y: number; w: number; h: number };
  diameterRange: [number, number];
}

export function coinSearchWindow(landmarks: Point[], imageW: number, imageH: number, p: CoinDetectionParams): SearchWindow {
  const centre = palmCentre(landmarks);
  const palmLen = dist(landmarks[WRIST], landmarks[MIDDLE_MCP]);
  const half = p.search_roi_half_size_palm_lengths * palmLen;
  const x0 = Math.max(0, Math.floor(centre.x - half));
  const y0 = Math.max(0, Math.floor(centre.y - half));
  const x1 = Math.min(imageW, Math.ceil(centre.x + half));
  const y1 = Math.min(imageH, Math.ceil(centre.y + half));
  const [lo, hi] = p.search_diameter_range_palm_lengths;
  return { roi: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, diameterRange: [lo * palmLen, hi * palmLen] };
}

/** Mean luma (BT.601, as OpenCV's RGB->GRAY) of an RGBA buffer. */
export function meanBrightness(rgba: Uint8ClampedArray | Uint8Array): number {
  let sum = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  return n ? sum / n : 0;
}

export function buildObservation(args: {
  timestampMs: number;
  width: number;
  height: number;
  landmarks: Point[];
  world: Point[] | null;
  handedness: "Left" | "Right" | null;
  handednessScore: number | null;
  coin: CoinDetection | null;
  brightness: number | null;
}): FrameObservation {
  return {
    timestamp_ms: args.timestampMs,
    image_width: args.width,
    image_height: args.height,
    landmarks: args.landmarks,
    world_landmarks: args.world,
    handedness: args.handedness,
    handedness_score: args.handednessScore,
    coin: args.coin && args.coin.found ? toObservation(args.coin) : null,
    brightness: args.brightness,
  };
}
