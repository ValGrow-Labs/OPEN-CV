// Boundary-quality metrics of a hand mask.
//
// WITHOUT ground truth (always available): contour smoothness, image contrast across the boundary, agreement between
// the mask edge and the image gradient, and landmark-to-boundary consistency. These say whether a boundary is
// plausible; they are NOT accuracy.
// WITH ground truth (composite or synthetic evaluation only): IoU, Dice, boundary distance, per-part IoU and finger-gap
// recall/precision. Which truth was used is stated in the result (`partTruth`).
//
// All lengths here are WORKING-image pixels (the analysis resolution) unless a name says otherwise.
import type { BinaryMask, Pt } from "../common";
import { GRADIENT_AGREE_PX, MAX_TIP_OFFSET, MIN_EDGE_CONTRAST, MIN_GRADIENT } from "./constants";
import { analyseFingerGaps, type FingerGap } from "./fingerGaps";
import { cutAtWrist } from "./fingers";
import { TIPS, sampleBilinear } from "./geometry";
import type { ImageLike } from "./imageops";
import { toGray } from "./imageops";
import { boundaryDistance, boundaryPixels, dice, iou, maskToContour, resizeMaskNearest, type BoundaryDistance } from "./metrics";
import { distanceTo } from "./morph";
import { FINGER_NAMES, PART_NAMES, labelParts, measureFingers, type FingerName, type FingerPart, type PartName } from "./parts";
import { boundaryNormals } from "./quality";

export interface BoundaryMetrics {
  /** Outer contour length (crack contour, working px). */
  perimeterWorkPx: number;
  /** Mean distance between the contour resampled every pixel and its Gaussian-smoothed copy (sigma 2 px). Lower = smoother. */
  roughnessWorkPx: number;
  /** Grey contrast across the boundary (|inside - outside| at 2-3 px along the normal), median and 10th percentile. */
  greyContrastMedian: number;
  greyContrastP10: number;
  /** RGB distance across the boundary, median. */
  colourContrastMedian: number;
  /** Share of boundary samples with grey contrast below MIN_EDGE_CONTRAST (where the picture barely shows the edge). */
  lowContrastShare: number;
  /** Share of boundary samples whose strongest image gradient along the normal lies within GRADIENT_AGREE_PX of the mask edge. */
  gradientAgreementShare: number;
  /** Mean |offset| between the mask edge and the strongest gradient (samples with a gradient of at least MIN_GRADIENT). */
  gradientOffsetMeanWorkPx: number | null;
  /** Median |cos| between the gradient direction and the boundary normal at those maxima (1 = aligned). */
  gradientAlignmentMedian: number | null;
  /** Landmark-to-boundary consistency per fingertip (thumb..little). */
  fingertips: { finger: FingerName; landmarkInside: boolean; tipToLandmarkPw: number | null; consistent: boolean }[];
  /** Every fingertip landmark is on the mask and within MAX_TIP_OFFSET palm widths of its mask fingertip. */
  fingertipsConsistent: boolean;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** Contour roughness and perimeter from the crack contour. */
export function contourRoughness(mask: BinaryMask): { perimeter: number; roughness: number } {
  const c = maskToContour(mask);
  if (c.length < 3) return { perimeter: 0, roughness: 0 };
  // Resample every 1 px of arc length.
  const pts: Pt[] = [];
  let carry = 0;
  let perim = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    perim += L;
    let s = carry;
    while (s < L) {
      pts.push({ x: a.x + ((b.x - a.x) * s) / L, y: a.y + ((b.y - a.y) * s) / L });
      s += 1;
    }
    carry = s - L;
  }
  const n = pts.length;
  const sigma = 2;
  const R = 6;
  const wts: number[] = [];
  let wsum = 0;
  for (let k = -R; k <= R; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    wts.push(v);
    wsum += v;
  }
  let dev = 0;
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sy = 0;
    for (let k = -R; k <= R; k++) {
      const p = pts[(((i + k) % n) + n) % n];
      sx += p.x * wts[k + R];
      sy += p.y * wts[k + R];
    }
    dev += Math.hypot(pts[i].x - sx / wsum, pts[i].y - sy / wsum);
  }
  return { perimeter: perim, roughness: n ? dev / n : 0 };
}

/** The no-ground-truth boundary metrics of a mask on its working-size picture. */
export function boundaryMetrics(mask: BinaryMask, image: ImageLike, lm: readonly Pt[], fingers: readonly FingerPart[], palmWidthPx: number): BoundaryMetrics {
  const { width: w, height: h } = mask;
  const gray = toGray(image);
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = image.data[4 * i + c];
    return a;
  });
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1]) / 8;
      gy[i] = (gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]) / 8;
    }
  }
  const mag = new Float32Array(w * h);
  for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(gx[i], gy[i]);
  const bnd = boundaryPixels(mask);
  const { idx, nx, ny } = boundaryNormals(mask, bnd);
  const grey: number[] = [];
  const colour: number[] = [];
  const offsets: number[] = [];
  const align: number[] = [];
  let agree = 0;
  let samples = 0;
  for (let k = 0; k < idx.length; k += 2) {
    const x = (idx[k] % w) + 0.5;
    const y = Math.floor(idx[k] / w) + 0.5;
    const ux = nx[k];
    const uy = ny[k];
    // Contrast: inside at -2..-3 px, outside at +2..+3 px (from the crack, which is ~0.5 px outwards of this centre).
    const side = (s0: number, s1: number, img: Float32Array) => (sampleBilinear(img, w, h, x + ux * s0, y + uy * s0) + sampleBilinear(img, w, h, x + ux * s1, y + uy * s1)) / 2;
    grey.push(Math.abs(side(2.5, 3.5, gray) - side(-1.5, -2.5, gray)));
    colour.push(Math.hypot(...ch.map((c) => side(2.5, 3.5, c) - side(-1.5, -2.5, c))));
    // Gradient agreement: strongest gradient magnitude along the normal within +-4 px.
    let bestS = 0;
    let best = -1;
    for (let s = -4; s <= 4; s += 0.5) {
      const m = sampleBilinear(mag, w, h, x + ux * s, y + uy * s);
      if (m > best) ((best = m), (bestS = s));
    }
    samples++;
    if (best >= MIN_GRADIENT) {
      const off = Math.abs(bestS - 0.5);
      offsets.push(off);
      if (off <= GRADIENT_AGREE_PX) agree++;
      const px = x + ux * bestS;
      const py = y + uy * bestS;
      const gxx = sampleBilinear(gx, w, h, px, py);
      const gyy = sampleBilinear(gy, w, h, px, py);
      const gl = Math.hypot(gxx, gyy);
      if (gl > 0) align.push(Math.abs((gxx * ux + gyy * uy) / gl));
    }
  }
  grey.sort((a, b) => a - b);
  colour.sort((a, b) => a - b);
  align.sort((a, b) => a - b);
  const toBg = distanceTo(mask.data, w, h, 255);
  const fingertips = FINGER_NAMES.map((finger, d) => {
    const p = lm[TIPS[d]];
    const xi = Math.floor(p.x);
    const yi = Math.floor(p.y);
    const inside = xi >= 0 && yi >= 0 && xi < w && yi < h && toBg[yi * w + xi] <= Math.max(1, 0.03 * palmWidthPx);
    const off = fingers[d]?.tipToLandmarkPw ?? null;
    return { finger, landmarkInside: inside, tipToLandmarkPw: off, consistent: inside && off !== null && off <= MAX_TIP_OFFSET };
  });
  const rough = contourRoughness(mask);
  return {
    perimeterWorkPx: rough.perimeter,
    roughnessWorkPx: rough.roughness,
    greyContrastMedian: percentile(grey, 0.5),
    greyContrastP10: percentile(grey, 0.1),
    colourContrastMedian: percentile(colour, 0.5),
    lowContrastShare: grey.length ? grey.filter((g) => g < MIN_EDGE_CONTRAST).length / grey.length : 1,
    gradientAgreementShare: samples ? agree / samples : 0,
    gradientOffsetMeanWorkPx: offsets.length ? offsets.reduce((s, v) => s + v, 0) / offsets.length : null,
    gradientAlignmentMedian: align.length ? percentile(align, 0.5) : null,
    fingertips,
    fingertipsConsistent: fingertips.every((t) => t.consistent),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// With ground truth

export interface TruthComparison {
  iou: number;
  dice: number;
  /** Symmetric boundary distance, working px. */
  boundary: BoundaryDistance;
  /** IoU per part label (null when neither mask has that part). */
  perPartIoU: Record<PartName, number | null>;
  /**
   * "generator": part truth from the synthetic generator (real per-part accuracy of the labelling on synthetic hands).
   * "labeller-on-truth-mask": the same labeller applied to the truth mask with the same landmarks, so the per-part IoU
   * shows only how mask errors propagate into the parts, NOT whether the labelling itself is right.
   */
  partTruth: "generator" | "labeller-on-truth-mask";
  /** Open gaps in the truth (thumb-index .. ring-little) and in the prediction. */
  gapTruthOpen: boolean[];
  gapPredOpen: boolean[];
  /** Share of the truth's open gaps the prediction also has open (null when the truth has none). */
  gapRecall: number | null;
  /** Share of the prediction's open gaps that are open in the truth (null when the prediction has none). */
  gapPrecision: number | null;
}

/**
 * Compare a predicted mask (working size) with a truth mask (any size; resampled nearest) using the same landmarks
 * (working px). The truth is cut at the wrist line like the prediction unless `cutTruthAtWrist` is false.
 * `truthParts` (any size, PART values) gives generator part truth; without it the labeller is run on the truth mask.
 */
export function compareToTruth(
  pred: { mask: BinaryMask; labels: Uint8Array; gaps: readonly FingerGap[] },
  truthMask: BinaryMask,
  lm: readonly Pt[],
  opts: { truthParts?: BinaryMask; cutTruthAtWrist?: boolean } = {},
): TruthComparison {
  const { width: w, height: h } = pred.mask;
  let t = resizeMaskNearest(truthMask, w, h);
  t = { width: w, height: h, data: t.data.map((v) => (v ? 255 : 0)) };
  if (opts.cutTruthAtWrist ?? true) t = { width: w, height: h, data: cutAtWrist(t.data, w, h, lm).mask };
  const tl = opts.truthParts ? resizeMaskNearest(opts.truthParts, w, h).data : labelParts(t.data, w, h, lm).labels;
  if (opts.truthParts) for (let i = 0; i < tl.length; i++) if (!t.data[i]) tl[i] = 0;
  const perPartIoU = {} as Record<PartName, number | null>;
  PART_NAMES.forEach((name, p) => {
    if (p === 0) return void (perPartIoU[name] = null);
    let inter = 0;
    let uni = 0;
    for (let i = 0; i < tl.length; i++) {
      const a = pred.labels[i] === p;
      const b = tl[i] === p;
      if (a && b) inter++;
      if (a || b) uni++;
    }
    perPartIoU[name] = uni ? inter / uni : null;
  });
  const tFingers = measureFingers(tl, t.data, w, h, lm, 1);
  const tGaps = analyseFingerGaps(t.data, w, h, lm, tFingers, 1).gaps;
  const gapTruthOpen = tGaps.map((g) => g.status === "open");
  const gapPredOpen = pred.gaps.map((g) => g.status === "open");
  const tp = gapTruthOpen.filter((v, i) => v && gapPredOpen[i]).length;
  const nt = gapTruthOpen.filter(Boolean).length;
  const np = gapPredOpen.filter(Boolean).length;
  return {
    iou: iou(pred.mask, t),
    dice: dice(pred.mask, t),
    boundary: boundaryDistance(pred.mask, t),
    perPartIoU,
    partTruth: opts.truthParts ? "generator" : "labeller-on-truth-mask",
    gapTruthOpen,
    gapPredOpen,
    gapRecall: nt ? tp / nt : null,
    gapPrecision: np ? tp / np : null,
  };
}
