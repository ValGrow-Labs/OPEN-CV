// Quality gates of the experimental segmentation: numbers measured from the result, and the reasons that make a
// result unusable. A gate never fixes anything and never stays silent: every failure is a named reason.
// All thresholds are in constants.ts and are provisional / unvalidated.
import type { BinaryMask, Pt, RejectReason } from "../common";
import {
  AREA_RATIO_RANGE,
  EDGE_MARGIN_FRACTION,
  EDGE_TOUCH_MIN_PIXELS,
  MAX_EDGE_WIDTH_PX,
  MIN_EDGE_CONTRAST,
  MIN_EDGE_VALID_SHARE,
  MIN_LANDMARKS_INSIDE,
  MIN_SEED_CONSISTENCY,
} from "./constants";
import type { ImageLike } from "./imageops";
import type { GapReport } from "./fingers";
import { dilate } from "./morph";
import { boundaryPixels } from "./metrics";
import { sampleBilinear } from "./geometry";

export interface QualityNumbers {
  /** Median 10-90 % rise width of the picture across the mask boundary, in working-image pixels (null = unknown). */
  edgeWidthPx: number | null;
  /** Share of sampled boundary points that had enough contrast to judge sharpness. */
  edgeValidShare: number;
  /** Variance of the Laplacian of the grey picture in a band around the boundary (reported, not gated). */
  bandLaplacianVariance: number;
  /** Share of the 21 landmarks inside the mask (or within 3 % of the palm width of it). */
  landmarksInsideShare: number;
  /** Mask area divided by the landmark hull area. */
  areaRatio: number;
  /** Hand pixels within the border margin of the image (the hand is cut off by the frame when large). */
  edgeTouchPixels: number;
  /** Fingertips recovered from the mask (of five). */
  tipsFound: number;
  /** Share of the sure-hand seed pixels the final mask covers. */
  seedCoverage: number;
  /** Share of the seed pixels whose chroma agrees with the seeds' median (low when something covers the hand). */
  seedConsistency: number;
  /** Share of the raw mask area that belonged to components other than the main one. */
  strayShare: number;
}

export interface QualityInput {
  mask: BinaryMask;
  /** The working-size picture the mask belongs to. */
  image: ImageLike;
  /** Grey working image (0-255), same size as the mask. */
  gray: Float32Array;
  landmarks: readonly Pt[];
  palmWidthPx: number;
  hullArea: number;
  sureFg: Uint8Array;
  tipsFound: number;
  gaps: readonly GapReport[];
  strayShare: number;
}

/** Normal direction (from the hand outwards) at every boundary pixel, from the gradient of a blurred mask. */
function boundaryNormals(mask: BinaryMask, boundary: Uint8Array): { idx: number[]; nx: Float32Array; ny: Float32Array } {
  const { width: w, height: h, data } = mask;
  const blurred = new Float32Array(w * h);
  const r = 3;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += data[y * w + Math.min(w - 1, Math.max(0, x))] ? 1 : 0;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1);
      acc += (data[y * w + Math.min(w - 1, x + r + 1)] ? 1 : 0) - (data[y * w + Math.max(0, x - r)] ? 1 : 0);
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      blurred[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < boundary.length; i++) if (boundary[i]) idx.push(i);
  const nx = new Float32Array(idx.length);
  const ny = new Float32Array(idx.length);
  idx.forEach((i, k) => {
    const x = i % w;
    const y = (i - x) / w;
    const gx = blurred[y * w + Math.min(w - 1, x + 1)] - blurred[y * w + Math.max(0, x - 1)];
    const gy = blurred[Math.min(h - 1, y + 1) * w + x] - blurred[Math.max(0, y - 1) * w + x];
    const l = Math.hypot(gx, gy) || 1;
    nx[k] = -gx / l; // the blurred mask falls off outwards, so outwards is minus its gradient
    ny[k] = -gy / l;
  });
  return { idx, nx, ny };
}

/**
 * Median edge width and the share of valid samples, from grey profiles across the boundary.
 * Width = contrast / steepest slope within 4 px of the boundary, on a profile averaged over five points along the
 * contour (so pixel noise and background texture do not widen it). For a Gaussian-blurred step this equals the
 * 10-90 % rise width; for a sharp edge it is about one pixel. Unreliable under very strong texture or when the mask
 * boundary is far from the true edge: then fewer samples are valid and the picture is not called blurred.
 */
export function edgeSharpness(mask: BinaryMask, gray: Float32Array): { widthPx: number | null; validShare: number } {
  const { width: w, height: h } = mask;
  const boundary = boundaryPixels(mask);
  const { idx, nx, ny } = boundaryNormals(mask, boundary);
  const widths: number[] = [];
  let sampled = 0;
  const STEP = 0.5;
  const HALF = 8;
  const n = Math.round((2 * HALF) / STEP) + 1;
  const profile = new Float32Array(n);
  const ALONG = [-4, -2, 0, 2, 4]; // pixels along the contour that are averaged
  for (let k = 0; k < idx.length; k += 3) {
    const x = (idx[k] % w) + 0.5;
    const y = Math.floor(idx[k] / w) + 0.5;
    sampled++;
    const tx = -ny[k];
    const ty = nx[k];
    for (let j = 0; j < n; j++) {
      const s = -HALF + j * STEP; // negative: inside the hand
      let acc = 0;
      for (const a of ALONG) acc += sampleBilinear(gray, w, h, x + nx[k] * s + tx * a, y + ny[k] * s + ty * a);
      profile[j] = acc / ALONG.length;
    }
    let inSum = 0;
    let outSum = 0;
    let inN = 0;
    let outN = 0;
    for (let j = 0; j < n; j++) {
      const s = -HALF + j * STEP;
      if (s >= -7 && s <= -3) ((inSum += profile[j]), inN++);
      if (s >= 3 && s <= 7) ((outSum += profile[j]), outN++);
    }
    const lo = inSum / inN;
    const hi = outSum / outN;
    const contrast = Math.abs(hi - lo);
    if (contrast < MIN_EDGE_CONTRAST) continue;
    let slope = 0; // grey levels per pixel, central difference over one pixel
    for (let j = 2; j < n - 2; j++) {
      const s = -HALF + j * STEP;
      if (Math.abs(s) > 4) continue;
      slope = Math.max(slope, Math.abs(profile[j + 2] - profile[j - 2]) / (4 * STEP));
    }
    if (slope > 0) widths.push(Math.max(1, contrast / slope));
  }
  const validShare = sampled ? widths.length / sampled : 0;
  if (!widths.length) return { widthPx: null, validShare };
  widths.sort((a, b) => a - b);
  return { widthPx: widths[Math.floor(widths.length / 2)], validShare };
}

/** Variance of the 4-neighbour Laplacian of the grey picture inside a band of +-6 px around the mask boundary. */
export function bandLaplacianVariance(mask: BinaryMask, gray: Float32Array): number {
  const { width: w, height: h, data } = mask;
  const grown = dilate(data, w, h, 6);
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!grown[i]) continue;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
      sum += lap;
      sum2 += lap * lap;
      n++;
    }
  }
  if (n < 2) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

export function landmarksInsideShare(mask: BinaryMask, landmarks: readonly Pt[], palmWidthPx: number): number {
  const { width: w, height: h, data } = mask;
  const grown = dilate(data, w, h, Math.max(1, 0.03 * palmWidthPx));
  let inside = 0;
  for (const p of landmarks) {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x >= 0 && y >= 0 && x < w && y < h && grown[y * w + x]) inside++;
  }
  return inside / landmarks.length;
}

export function edgeTouchPixels(mask: BinaryMask): number {
  const { width: w, height: h, data } = mask;
  const m = Math.max(1, Math.round(EDGE_MARGIN_FRACTION * Math.min(w, h)));
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((x < m || y < m || x >= w - m || y >= h - m) && data[y * w + x]) n++;
    }
  }
  return n;
}

/**
 * How uniform the colour of the sure-hand seed pixels is: share within 3 robust standard deviations (MAD based,
 * at least 10 chroma units) of the median chroma in both Cr and Cb. A hand with creases and nails is mostly
 * consistent; a hand partly covered by something of another colour is not.
 */
export function seedConsistency(image: ImageLike, sureFg: Uint8Array): number {
  const cr: number[] = [];
  const cb: number[] = [];
  for (let i = 0; i < sureFg.length; i++) {
    if (!sureFg[i]) continue;
    const r = image.data[i * 4];
    const g = image.data[i * 4 + 1];
    const b = image.data[i * 4 + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    cr.push((r - y) * 0.713 + 128);
    cb.push((b - y) * 0.564 + 128);
  }
  if (cr.length < 10) return 1;
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const mcr = median(cr);
  const mcb = median(cb);
  const tcr = Math.max(10, 3 * 1.4826 * median(cr.map((v) => Math.abs(v - mcr))));
  const tcb = Math.max(10, 3 * 1.4826 * median(cb.map((v) => Math.abs(v - mcb))));
  let ok = 0;
  for (let i = 0; i < cr.length; i++) if (Math.abs(cr[i] - mcr) <= tcr && Math.abs(cb[i] - mcb) <= tcb) ok++;
  return ok / cr.length;
}

export function measureQuality(input: QualityInput): QualityNumbers {
  const { mask, gray, landmarks, palmWidthPx, hullArea, sureFg } = input;
  let area = 0;
  let seeds = 0;
  let covered = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i]) area++;
    if (sureFg[i]) {
      seeds++;
      if (mask.data[i]) covered++;
    }
  }
  const edge = edgeSharpness(mask, gray);
  return {
    edgeWidthPx: edge.widthPx,
    edgeValidShare: edge.validShare,
    bandLaplacianVariance: bandLaplacianVariance(mask, gray),
    landmarksInsideShare: landmarksInsideShare(mask, landmarks, palmWidthPx),
    areaRatio: hullArea > 0 ? area / hullArea : 0,
    edgeTouchPixels: edgeTouchPixels(mask),
    tipsFound: input.tipsFound,
    seedCoverage: seeds ? covered / seeds : 0,
    seedConsistency: seedConsistency(input.image, sureFg),
    strayShare: input.strayShare,
  };
}

/** The reasons (possibly none) that make a result unusable, from its measured numbers and its finger gaps. */
export function gateReasons(q: QualityNumbers, gaps: readonly GapReport[]): RejectReason[] {
  const reasons: RejectReason[] = [];
  if (q.edgeTouchPixels >= EDGE_TOUCH_MIN_PIXELS || q.tipsFound < 5) reasons.push("hand_incomplete");
  if (q.edgeWidthPx !== null && q.edgeValidShare >= MIN_EDGE_VALID_SHARE && q.edgeWidthPx > MAX_EDGE_WIDTH_PX) reasons.push("hand_blurred");
  if (q.landmarksInsideShare < MIN_LANDMARKS_INSIDE || q.seedCoverage < 0.9 || q.seedConsistency < MIN_SEED_CONSISTENCY) reasons.push("hand_occluded");
  if (gaps.slice(1).some((g) => !g.preserved)) reasons.push("fingers_merged");
  if (q.areaRatio < AREA_RATIO_RANGE[0] || q.areaRatio > AREA_RATIO_RANGE[1] || q.strayShare > 0.25) reasons.push("mask_implausible");
  return reasons;
}
