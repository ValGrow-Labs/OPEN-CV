// Per-frame analysis (mirror of backend/glovesize/frame_analysis.py).
import type { CoinDetectionParams, FrameObservation, Point } from "../api/types";
import { toObservation, type CoinDetection } from "./coinDetector";
import { MIDDLE_MCP, WRIST, dist, palmCentre, pointInPolygon } from "./geometry";

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

/** Paint everything outside the palm with the palm's own mean colour, in place, so the coin search
 *  cannot take anything else for a coin. The dark, colourless gaps between the fingers look just
 *  like a coin to an edge detector (a phone recording showed them accepted as the coin while the
 *  real coin was ignored). `polygon` is the palm outline in the image's own pixels; it is grown by
 *  `grow` about its centre so a coin lying right at the edge of the palm is not clipped. */
export function maskOutsidePalm(
  image: { data: Uint8Array | Uint8ClampedArray; width: number; height: number },
  polygon: Point[],
  grow: number,
): boolean {
  const { data, width, height } = image;
  const cx = polygon.reduce((s, p) => s + p.x, 0) / polygon.length;
  const cy = polygon.reduce((s, p) => s + p.y, 0) / polygon.length;
  const poly = polygon.map((p) => ({ ...p, x: cx + (p.x - cx) * grow, y: cy + (p.y - cy) * grow }));
  const inside = new Uint8Array(width * height);
  let n = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pointInPolygon(x + 0.5, y + 0.5, poly)) continue;
      const i = y * width + x;
      inside[i] = 1;
      n++;
      r += data[i * 4];
      g += data[i * 4 + 1];
      b += data[i * 4 + 2];
    }
  }
  // A palm that barely overlaps the window (or a degenerate outline): leave the image alone.
  if (n < 0.05 * width * height) return false;
  const fr = Math.round(r / n);
  const fg = Math.round(g / n);
  const fb = Math.round(b / n);
  for (let i = 0; i < width * height; i++) {
    if (inside[i]) continue;
    data[i * 4] = fr;
    data[i * 4 + 1] = fg;
    data[i * 4 + 2] = fb;
    data[i * 4 + 3] = 255;
  }
  return true;
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
