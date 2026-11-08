// Per-pixel confidence (0..1) that the mask's label at a pixel (hand or background) is right, and a summary.
//
//   conf = colour * (dist + (1 - dist) * edge)
//
//   * colour: how strongly the pixel's colour favours the label it got, from two colour models (hand, background):
//     the logistic of the log-likelihood ratio, signed by the label (0.5 = the colour cannot tell). With the GrabCut
//     backend the models are GrabCut's own final Gaussian mixtures; otherwise mixtures are fitted here to the pixels
//     on both sides of the mask boundary. Shadows and skin-coloured backgrounds push it towards 0.5.
//   * dist: distance to the mask boundary, saturating at CONF_DIST_SCALE palm widths (far from the boundary, only
//     the colour matters).
//   * edge: image gradient support of the nearby boundary (mean over boundary pixels within ~1.5 x that scale of the
//     strongest grey gradient next to each), saturating at CONF_EDGE_REF grey levels per pixel. Low contrast and blur
//     lower it, so the band around a weak boundary gets low confidence.
//
// This is a heuristic score for ranking and gating, NOT a calibrated probability: nothing here was fitted to labelled
// data. Thresholds are provisional (constants.ts).
import { CONF_COLOUR_SCALE, CONF_DIST_SCALE, CONF_EDGE_REF } from "./constants";
import type { ImageLike } from "./imageops";
import { toGray } from "./imageops";
import { boundaryPixels } from "./metrics";
import { dilate, distanceTo } from "./morph";
import { PART_NAMES, type PartName } from "./parts";

/** A Gaussian mixture over RGB in OpenCV's GrabCut layout: K weights, K x 3 means, K x 9 covariances (13 K values). */
export type ColourGmm = Float64Array;

interface Prepared {
  k: number;
  w: number[];
  mean: number[][];
  inv: number[][];
  logNorm: number[];
}

function prepare(g: ColourGmm): Prepared {
  const k = Math.floor(g.length / 13);
  const out: Prepared = { k, w: [], mean: [], inv: [], logNorm: [] };
  for (let c = 0; c < k; c++) {
    const wt = g[c];
    const m = [g[k + 3 * c], g[k + 3 * c + 1], g[k + 3 * c + 2]];
    const s = Array.from(g.subarray(4 * k + 9 * c, 4 * k + 9 * c + 9));
    let det = s[0] * (s[4] * s[8] - s[5] * s[7]) - s[1] * (s[3] * s[8] - s[5] * s[6]) + s[2] * (s[3] * s[7] - s[4] * s[6]);
    if (!(det > 1e-9)) {
      s[0] += 0.01;
      s[4] += 0.01;
      s[8] += 0.01;
      det = s[0] * (s[4] * s[8] - s[5] * s[7]) - s[1] * (s[3] * s[8] - s[5] * s[6]) + s[2] * (s[3] * s[7] - s[4] * s[6]);
    }
    if (!(wt > 0) || !(det > 0)) continue;
    const inv = [
      (s[4] * s[8] - s[5] * s[7]) / det,
      (s[2] * s[7] - s[1] * s[8]) / det,
      (s[1] * s[5] - s[2] * s[4]) / det,
      (s[5] * s[6] - s[3] * s[8]) / det,
      (s[0] * s[8] - s[2] * s[6]) / det,
      (s[2] * s[3] - s[0] * s[5]) / det,
      (s[3] * s[7] - s[4] * s[6]) / det,
      (s[1] * s[6] - s[0] * s[7]) / det,
      (s[0] * s[4] - s[1] * s[3]) / det,
    ];
    out.w.push(wt);
    out.mean.push(m);
    out.inv.push(inv);
    out.logNorm.push(Math.log(wt) - 0.5 * Math.log(det) - 1.5 * Math.log(2 * Math.PI));
  }
  out.k = out.w.length;
  return out;
}

function logLik(p: Prepared, r: number, g: number, b: number): number {
  let best = -Infinity;
  const terms: number[] = [];
  for (let c = 0; c < p.k; c++) {
    const m = p.mean[c];
    const iv = p.inv[c];
    const d0 = r - m[0];
    const d1 = g - m[1];
    const d2 = b - m[2];
    const q = d0 * (iv[0] * d0 + iv[1] * d1 + iv[2] * d2) + d1 * (iv[3] * d0 + iv[4] * d1 + iv[5] * d2) + d2 * (iv[6] * d0 + iv[7] * d1 + iv[8] * d2);
    const t = p.logNorm[c] - 0.5 * q;
    terms.push(t);
    if (t > best) best = t;
  }
  if (best === -Infinity) return -1e9;
  let s = 0;
  for (const t of terms) s += Math.exp(t - best);
  return best + Math.log(s);
}

/**
 * Fit a K-component full-covariance colour mixture to RGB samples (k-means with a deterministic brightness-quantile
 * start, then one moment step). Samples are a flat [r,g,b, r,g,b, ...] list.
 */
export function fitColourGmm(samples: Float32Array, k = 5, iterations = 8): ColourGmm {
  const n = Math.floor(samples.length / 3);
  const out = new Float64Array(13 * k);
  if (n === 0) return out;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => samples[3 * a] + samples[3 * a + 1] + samples[3 * a + 2] - (samples[3 * b] + samples[3 * b + 1] + samples[3 * b + 2]));
  const centres: number[][] = [];
  for (let c = 0; c < k; c++) {
    const i = order[Math.min(n - 1, Math.floor(((c + 0.5) / k) * n))];
    centres.push([samples[3 * i], samples[3 * i + 1], samples[3 * i + 2]]);
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iterations; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let bc = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (samples[3 * i] - centres[c][0]) ** 2 + (samples[3 * i + 1] - centres[c][1]) ** 2 + (samples[3 * i + 2] - centres[c][2]) ** 2;
        if (d < bd) ((bd = d), (bc = c));
      }
      assign[i] = bc;
      sum[bc][0] += samples[3 * i];
      sum[bc][1] += samples[3 * i + 1];
      sum[bc][2] += samples[3 * i + 2];
      sum[bc][3]++;
    }
    for (let c = 0; c < k; c++) if (sum[c][3]) centres[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
  }
  const cnt = new Array<number>(k).fill(0);
  const cov = centres.map(() => new Array<number>(9).fill(0));
  for (let i = 0; i < n; i++) {
    const c = assign[i];
    cnt[c]++;
    const d = [samples[3 * i] - centres[c][0], samples[3 * i + 1] - centres[c][1], samples[3 * i + 2] - centres[c][2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[c][3 * a + b] += d[a] * d[b];
  }
  for (let c = 0; c < k; c++) {
    out[c] = cnt[c] / n;
    for (let a = 0; a < 3; a++) out[k + 3 * c + a] = centres[c][a];
    for (let j = 0; j < 9; j++) out[4 * k + 9 * c + j] = cnt[c] ? cov[c][j] / cnt[c] + (j % 4 === 0 ? 1 : 0) : j % 4 === 0 ? 1 : 0;
  }
  return out;
}

export interface ConfidenceSummary {
  /** Mean confidence over the hand pixels. */
  meanHand: number;
  /** Mean confidence over the band within CONF_DIST_SCALE palm widths of the boundary (both sides). */
  meanBoundaryBand: number;
  /** Share of the hand pixels with confidence below 0.5. */
  lowShareHand: number;
  /** Share of the boundary band with confidence below 0.5. */
  lowShareBand: number;
  /** Mean colour term over the band (0.5 = colour cannot separate hand from background there). */
  colourAgreementBand: number;
  /** Mean edge-support term over the boundary pixels. */
  edgeSupportBoundary: number;
  /** Mean confidence per part label (null when the part has no pixels or no labels were given). */
  perPart: Record<PartName, number | null>;
  /** Where the colour models came from. */
  colourModel: "grabcut" | "fitted";
}

export interface ConfidenceResult {
  /** Per pixel (working size): confidence that the mask's label there is right, 0..1. */
  map: Float32Array;
  summary: ConfidenceSummary;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Per-pixel confidence of a mask on its (working-size) picture. `palmWidthPx` sets the distance scale. `ignore` marks
 * background pixels to leave out of the background colour model, the boundary and the summary (the forearm side of
 * the wrist cut); their map values are still computed.
 */
export function pixelConfidence(
  image: ImageLike,
  mask: Uint8Array,
  palmWidthPx: number,
  labels?: Uint8Array | null,
  models?: { fg: ColourGmm; bg: ColourGmm } | null,
  ignore?: Uint8Array | null,
): ConfidenceResult {
  const { width: w, height: h, data } = image;
  const n = w * h;
  const D = Math.max(1.5, CONF_DIST_SCALE * palmWidthPx);
  // Colour models.
  let source: "grabcut" | "fitted" = "grabcut";
  let fgM = models?.fg;
  let bgM = models?.bg;
  if (!fgM || !bgM) {
    source = "fitted";
    const outer = dilate(mask, w, h, Math.max(4, 0.75 * palmWidthPx));
    const fs: number[] = [];
    const bs: number[] = [];
    const step = Math.max(1, Math.round(Math.sqrt(n / 40000)));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = y * w + x;
        const list = mask[i] ? fs : outer[i] && !(ignore && ignore[i]) ? bs : null;
        if (list) list.push(data[4 * i], data[4 * i + 1], data[4 * i + 2]);
      }
    }
    fgM = fitColourGmm(Float32Array.from(fs));
    bgM = fitColourGmm(Float32Array.from(bs));
  }
  const pf = prepare(fgM);
  const pb = prepare(bgM);
  // Distance to the boundary (pixel centre to the crack between hand and background, about d - 0.5).
  // Pixels in `ignore` (the forearm side of the wrist cut) count as neither boundary nor background: the cut is a
  // convention, not an image edge, so it neither lowers nor raises the confidence of the hand next to it.
  let solid = mask;
  if (ignore) {
    solid = new Uint8Array(mask);
    for (let i = 0; i < n; i++) if (ignore[i]) solid[i] = 255;
  }
  const dIn = distanceTo(solid, w, h, 0);
  const dOut = distanceTo(mask, w, h, 255);
  // Edge support: strongest grey gradient around each boundary pixel, averaged over boundary pixels nearby.
  const gray = toGray(image);
  const grad = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
      const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
      grad[i] = Math.hypot(gx, gy) / 8;
    }
  }
  const bnd = boundaryPixels({ width: w, height: h, data: solid });
  if (ignore) for (let i = 0; i < n; i++) if (!mask[i]) bnd[i] = 0;
  const eB = new Float64Array(n);
  const cB = new Float64Array(n);
  let edgeSum = 0;
  let edgeN = 0;
  for (let i = 0; i < n; i++) {
    if (!bnd[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && grad[yy * w + xx] > m) m = grad[yy * w + xx];
    }
    eB[i] = Math.min(1, m / CONF_EDGE_REF);
    cB[i] = 1;
    edgeSum += eB[i];
    edgeN++;
  }
  const R = Math.max(2, Math.ceil(1.5 * D));
  const boxE = boxSum(eB, w, h, R);
  const boxC = boxSum(cB, w, h, R);
  const map = new Float32Array(n);
  const sums = new Array<number>(PART_NAMES.length).fill(0);
  const cnts = new Array<number>(PART_NAMES.length).fill(0);
  let hand = 0;
  let handSum = 0;
  let handLow = 0;
  let band = 0;
  let bandSum = 0;
  let bandLow = 0;
  let colBand = 0;
  for (let i = 0; i < n; i++) {
    const inside = mask[i] !== 0;
    const d = Math.max(0, (inside ? dIn[i] : dOut[i]) - 0.5);
    const cd = Math.min(1, d / D);
    const llr = Math.max(-20, Math.min(20, logLik(pf, data[4 * i], data[4 * i + 1], data[4 * i + 2]) - logLik(pb, data[4 * i], data[4 * i + 1], data[4 * i + 2])));
    const cc = sigmoid((inside ? llr : -llr) / CONF_COLOUR_SCALE);
    const ce = boxC[i] > 0 ? boxE[i] / boxC[i] : 1;
    const c = cc * (cd + (1 - cd) * ce);
    map[i] = c;
    if (ignore && ignore[i] && !inside) continue;
    if (inside) {
      hand++;
      handSum += c;
      if (c < 0.5) handLow++;
      if (labels) ((sums[labels[i]] += c), cnts[labels[i]]++);
    }
    if (d <= D) {
      band++;
      bandSum += c;
      colBand += cc;
      if (c < 0.5) bandLow++;
    }
  }
  const perPart = {} as Record<PartName, number | null>;
  PART_NAMES.forEach((p, i) => (perPart[p] = labels && cnts[i] ? sums[i] / cnts[i] : null));
  perPart.background = null;
  return {
    map,
    summary: {
      meanHand: hand ? handSum / hand : 0,
      meanBoundaryBand: band ? bandSum / band : 0,
      lowShareHand: hand ? handLow / hand : 1,
      lowShareBand: band ? bandLow / band : 1,
      colourAgreementBand: band ? colBand / band : 0,
      edgeSupportBoundary: edgeN ? edgeSum / edgeN : 0,
      perPart,
      colourModel: source,
    },
  };
}

/** Sum over the (2r+1)^2 window around every pixel (clamped at the borders), via an integral image. */
function boxSum(v: Float64Array, w: number, h: number, r: number): Float64Array {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += v[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      out[y * w + x] = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
    }
  }
  return out;
}
