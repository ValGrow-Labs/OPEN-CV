// Hand mask per view from the KNOWN printed board (EXPERIMENTAL, multi-view board reconstruction).
//
// With the camera intrinsics and the board-to-camera pose, every pixel's ray meets the board plane at a known board
// point, so the picture of an EMPTY board is predictable: white paper, black marker ink, the grey coin-target outline,
// the coin, or "off the paper" (the table, the room). A pixel that is inconsistent with that prediction is the hand.
//
//   * Paper: the paper's white level is estimated LOCALLY (blocks of the picture; the illumination varies) from paper
//     pixels that look like paper; a pixel is then described by its brightness ratio s to the local white and its
//     chroma k (spread of its white-balanced R, G, B ratios). Paper and ink are achromatic; a cast SHADOW only darkens
//     (lower s, same chromaticity); skin is chromatic at every tone (red > green > blue), so k separates skin from
//     shadowed paper for light and dark skin. A very dark pixel far from any ink (darker than any shadow) is also hand.
//   * Ink: skin over black ink is chromatic (and usually brighter); ink in shadow is just darker. Where a pixel is too
//     dark for its chroma to be measured above the noise, it is UNKNOWN.
//   * Near printed edges (within edgeTolPx of an ink / paper / outline boundary, which absorbs blur and small pose
//     errors) any achromatic value is accepted as board.
//   * The coin and its surroundings: UNKNOWN (the coin is not part of the board model).
//   * Off the paper: a pixel whose ray does not cross the hand's search volume cannot be hand in that volume
//     (background, known). Otherwise a colour model learned in THIS view (hand: confident hand pixels on the paper;
//     background: the table / room pixels whose rays miss the hand and forearm regions, plus board pixels) decides,
//     and only where its log-likelihood ratio is clear; the rest is UNKNOWN.
// Then a 3 x 3 majority filter, small components removed, small holes filled.
//
// Returns the mask and a `known` mask (255 = the classification is reliable). The reconstruction never carves with an
// unknown pixel (carving.ts) and does not count contours next to one as observed (quality.ts).
//
// Limits (plainly): it assumes a neutral (same-colour) ambient and direct light, so shadows stay achromatic; a strongly
// tinted ambient, skin-coloured tables or clothing, specular glare on the paper and motion blur are not handled;
// misprinted or curled paper breaks the board prediction; the thresholds were tuned on SIMULATED pictures only.
import type { BinaryMask, CameraPose, Intrinsics } from "../common";
import { BOARD, boardIsBlack, onCoinOutline, type BoardLayout } from "../board/spec";
import type { Vec3 } from "../reconstruction/linalg";
import { components, distanceTo, fillSmallHoles, majority3 } from "../segmentation/morph";
import { boxMean, rayBox, rayGrid, SRGB_TO_LINEAR, type RGBAImage } from "./image";

/** Predicted content of each pixel. */
export const ZONE = { offPaper: 0, paper: 1, ink: 2, edge: 3, outline: 4, coin: 5 } as const;

export interface SegmentOptions {
  layout: BoardLayout;
  /** The hand's search volume (board mm). Off-paper pixels whose rays miss it are background. */
  volume: { min: Vec3; max: Vec3 } | null;
  /** Where the forearm may be (beyond the open left edge); its pixels are not used as background samples. */
  forearmBox: { min: Vec3; max: Vec3 } | null;
  /** The coin lying on the coin target (pixels on and around it are unknown); null = no coin. */
  coin: { diameterMm: number; heightMm: number; marginMm: number } | null;
  /** Pixels within this distance of a predicted print boundary accept any achromatic value as board. Raise it when
   *  the pose is uncertain (1 deg of pose error moves the predicted print by roughly f * 0.017 pixels). */
  edgeTolPx: number;
  /** Chroma above which a paper pixel is hand. */
  chromaPaper: number;
  /** Chroma above which an ink / edge / outline pixel is hand. */
  chromaInk: number;
  /** Brightness ratio (to the local white) below which a paper pixel far from ink is hand: darker than any shadow. */
  darkRatio: number;
  /** ... and the distance from predicted ink (px) for that rule. */
  darkGuardPx: number;
  /** Brightness ratio above which a pixel is not paper (brighter than the white). */
  brightRatio: number;
  /** Linear luminance below which chroma cannot be measured (the pixel is unknown unless clearly decided). */
  darkFloor: number;
  /** Log-likelihood ratio needed by the off-paper colour model to decide. */
  colourLLR: number;
  /** Components smaller than this share of the largest are removed. */
  minComponentFraction: number;
  /** Background holes up to this many pixels are filled. */
  maxHolePx: number;
  /** Re-decide the pixels within 2 px of the mask edge by their mixing fraction between the local skin colour and the
   *  local background colour (unsmoothed, linear): removes the inward bias of dark skin against white paper. */
  refineBoundary: boolean;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  layout: BOARD,
  volume: null,
  forearmBox: null,
  coin: { diameterMm: 23.25, heightMm: 2.5, marginMm: 3 },
  edgeTolPx: 3,
  chromaPaper: 0.2,
  chromaInk: 0.3,
  darkRatio: 0.15,
  darkGuardPx: 12,
  brightRatio: 1.3,
  darkFloor: 0.004,
  colourLLR: 2,
  minComponentFraction: 0.08,
  maxHolePx: 60,
  refineBoundary: true,
};

export interface SegmentStats {
  /** Median local white (linear RGB) and the ink's brightness ratio to it. */
  paperWhite: [number, number, number];
  inkRatio: number;
  handPixels: number;
  /** Share of all pixels marked known. */
  knownFraction: number;
  /** Pixels whose rays cross the search volume, and the share of them that is unknown. */
  volumePixels: number;
  unknownInVolume: number;
  /** Off-paper pixels whose rays cross the volume, and how they were decided. */
  offPaperInVolume: number;
  offPaperHand: number;
  offPaperUnknown: number;
  colourModel: { handSamples: number; backgroundSamples: number; used: boolean };
  timeMs: number;
}

export interface SegmentResult {
  mask: BinaryMask;
  known: BinaryMask;
  zone: Uint8Array;
  /** 1 where the pixel's ray crosses the search volume / the forearm box. */
  inVolume: Uint8Array;
  inForearm: Uint8Array;
  stats: SegmentStats;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** The board-predicted zone of every pixel, and whether its ray crosses the volume / forearm box. */
export function predictBoard(K: Intrinsics, pose: CameraPose, opts: Partial<SegmentOptions> = {}): { zone: Uint8Array; inVolume: Uint8Array; inForearm: Uint8Array } {
  const o = { ...DEFAULT_SEGMENT_OPTIONS, ...opts };
  const { width: w, height: h } = K;
  const grid = rayGrid(K, pose);
  const O = grid.origin;
  const L = o.layout;
  const PW = L.paper.widthMm, PH = L.paper.heightMm;
  const zone = new Uint8Array(w * h);
  const inVolume = new Uint8Array(w * h);
  const inForearm = new Uint8Array(w * h);
  const ccx = L.coinTarget.center.x, ccy = L.coinTarget.center.y;
  const coinR = o.coin ? o.coin.diameterMm / 2 + o.coin.marginMm : 0;
  const vMin = o.volume ? [o.volume.min[0] - 3, o.volume.min[1] - 3, o.volume.min[2] - 1] : null;
  const vMax = o.volume ? [o.volume.max[0] + 3, o.volume.max[1] + 3, o.volume.max[2] + 3] : null;
  for (let p = 0; p < w * h; p++) {
    const d = [grid.dirs[p * 3], grid.dirs[p * 3 + 1], grid.dirs[p * 3 + 2]];
    if (vMin && vMax && rayBox(O, d, vMin, vMax)) inVolume[p] = 1;
    if (o.forearmBox && rayBox(O, d, o.forearmBox.min, o.forearmBox.max)) inForearm[p] = 1;
    if (d[2] >= -1e-9) continue; // never meets the board plane: off the paper
    const t = -O[2] / d[2];
    const x = O[0] + d[0] * t, y = O[1] + d[1] * t;
    if (o.coin) {
      const th = (o.coin.heightMm - O[2]) / d[2];
      const xt = O[0] + d[0] * th - ccx, yt = O[1] + d[1] * th - ccy;
      if ((x - ccx) ** 2 + (y - ccy) ** 2 <= coinR * coinR || xt * xt + yt * yt <= coinR * coinR) {
        zone[p] = ZONE.coin;
        continue;
      }
    }
    if (x < 0 || y < 0 || x > PW || y > PH) continue;
    zone[p] = boardIsBlack(x, y, L) ? ZONE.ink : onCoinOutline(x, y, L) ? ZONE.outline : ZONE.paper;
  }
  // print boundaries (paper / ink / outline / paper edge), widened by the tolerance
  const border = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x, z = zone[p];
      if (z === ZONE.coin) continue;
      if ((x + 1 < w && zone[p + 1] !== z && zone[p + 1] !== ZONE.coin) || (y + 1 < h && zone[p + w] !== z && zone[p + w] !== ZONE.coin)) border[p] = 255;
    }
  const dist = distanceTo(border, w, h, 255);
  for (let p = 0; p < w * h; p++) {
    const z = zone[p];
    if ((z === ZONE.paper || z === ZONE.ink || z === ZONE.outline) && dist[p] <= o.edgeTolPx) {
      // next to the paper edge, the table may show: leave those to the off-paper colour model
      zone[p] = z === ZONE.paper && nearOffPaper(zone, w, h, p, Math.ceil(o.edgeTolPx) + 1) ? ZONE.offPaper : ZONE.edge;
    }
  }
  return { zone, inVolume, inForearm };
}

function nearOffPaper(zone: Uint8Array, w: number, h: number, p: number, r: number): boolean {
  const x0 = p % w, y0 = (p - x0) / w;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (zone[y * w + x] === ZONE.offPaper) return true;
    }
  return false;
}

export function segmentBoardView(image: RGBAImage, K: Intrinsics, pose: CameraPose, options: Partial<SegmentOptions> = {}): SegmentResult {
  const t0 = now();
  const o = { ...DEFAULT_SEGMENT_OPTIONS, ...options };
  const { width: w, height: h } = image;
  if (w !== K.width || h !== K.height) throw new Error("segmentBoardView: the picture size must equal the intrinsics' size");
  const n = w * h;
  const { zone, inVolume, inForearm } = predictBoard(K, pose, o);

  // linear, lightly smoothed colour planes (3 x 3 mean) for robust ratios
  const lin = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) lin[c][p] = SRGB_TO_LINEAR[image.data[p * 4 + c]];
  const F = lin.map((pl) => boxMean(pl, w, h, 1));
  const lum = new Float32Array(n);
  for (let p = 0; p < n; p++) lum[p] = 0.2126 * F[0][p] + 0.7152 * F[1][p] + 0.0722 * F[2][p];

  // global paper tint from the brighter half of the predicted paper pixels
  const paperIdx: number[] = [];
  for (let p = 0; p < n; p++) if (zone[p] === ZONE.paper) paperIdx.push(p);
  const tint = estimateTint(paperIdx, F, lum);
  const chroma = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const r = F[0][p] / tint[0], g = F[1][p] / tint[1], b = F[2][p] / tint[2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    chroma[p] = (mx - mn) / ((r + g + b) / 3 + 0.004);
  }

  // local white (luminance) from paper-looking paper pixels, per 16 px block, filled and interpolated
  const white = localWhite(zone, chroma, lum, w, h, 16);
  // the ink's brightness ratio (median over predicted ink pixels)
  const inkRatios: number[] = [];
  for (let p = 0; p < n; p++) if (zone[p] === ZONE.ink && white[p] > 0) inkRatios.push(lum[p] / white[p]);
  const inkRatio = median(inkRatios) ?? 0.05;

  const inkDist = distanceTo(zoneMask(zone, ZONE.ink), w, h, 255);
  const hand = new Uint8Array(n);
  const known = new Uint8Array(n).fill(255);
  for (let p = 0; p < n; p++) {
    const z = zone[p];
    const s = white[p] > 0 ? lum[p] / white[p] : 1;
    const k = chroma[p];
    if (z === ZONE.coin) {
      known[p] = 0;
    } else if (z === ZONE.paper) {
      if (k > o.chromaPaper || s > o.brightRatio || (s < o.darkRatio && inkDist[p] > o.darkGuardPx)) hand[p] = 255;
    } else if (z === ZONE.ink || z === ZONE.edge || z === ZONE.outline) {
      if (lum[p] < o.darkFloor) known[p] = 0; // too dark to measure chroma above the noise
      else if (k > o.chromaInk || s > o.brightRatio) hand[p] = 255;
    }
  }

  // off the paper: a colour model learned in this view
  let offPaperInVolume = 0, offPaperHand = 0, offPaperUnknown = 0;
  const colour = { handSamples: 0, backgroundSamples: 0, used: false };
  {
    const handSeed = erodeOnce(erodeOnce(hand, w, h), w, h);
    const hModel = new ColourHistogram(), bModel = new ColourHistogram();
    for (let p = 0; p < n; p++) {
      const z = zone[p];
      if (handSeed[p] && (z === ZONE.paper || z === ZONE.ink)) {
        hModel.add(F, lum, p, 1);
        colour.handSamples++;
      } else if (z === ZONE.offPaper && !inVolume[p] && !inForearm[p]) {
        bModel.add(F, lum, p, 1);
        colour.backgroundSamples++;
      } else if ((z === ZONE.paper || z === ZONE.edge) && !hand[p] && p % 4 === 0) {
        bModel.add(F, lum, p, 1);
        colour.backgroundSamples++;
      }
    }
    colour.used = colour.handSamples >= 150 && colour.backgroundSamples >= 150;
    if (colour.used) {
      hModel.finish();
      bModel.finish();
    }
    for (let p = 0; p < n; p++) {
      if (zone[p] !== ZONE.offPaper) continue;
      const relevant = inVolume[p] || inForearm[p];
      if (!relevant) continue; // cannot be the hand inside the volume: background, known
      if (inVolume[p]) offPaperInVolume++;
      if (!colour.used) {
        if (inVolume[p]) {
          known[p] = 0;
          offPaperUnknown++;
        }
        continue;
      }
      const llr = hModel.logP(F, lum, p) - bModel.logP(F, lum, p);
      if (llr > o.colourLLR) {
        hand[p] = 255;
        if (inVolume[p]) offPaperHand++;
      } else if (llr >= -o.colourLLR && inVolume[p]) {
        known[p] = 0;
        offPaperUnknown++;
      }
    }
  }

  // clean-up: majority filter, small components, small holes; unknown pixels are never hand
  let m = majority3(hand, w, h);
  for (let p = 0; p < n; p++) if (!known[p]) m[p] = 0;
  const beforeComponents = m;
  m = keepLargeComponents(m, w, h, o.minComponentFraction);
  // a removed fragment was classified hand: calling it background is a guess, so it is unknown (never carves)
  for (let p = 0; p < n; p++) if (beforeComponents[p] && !m[p]) known[p] = 0;
  if (o.refineBoundary) m = refineBoundary(m, known, lin, w, h);
  m = fillSmallHoles(m, w, h, o.maxHolePx);
  let handPixels = 0, knownCount = 0, volumePixels = 0, unknownVol = 0;
  for (let p = 0; p < n; p++) {
    if (m[p]) handPixels++;
    if (known[p]) knownCount++;
    if (inVolume[p]) {
      volumePixels++;
      if (!known[p]) unknownVol++;
    }
  }
  const whites = white.filter((v) => v > 0);
  const wl = median(Array.from(whites.filter((_, i) => i % 7 === 0))) ?? 0;
  return {
    mask: { width: w, height: h, data: m },
    known: { width: w, height: h, data: known },
    zone,
    inVolume,
    inForearm,
    stats: {
      paperWhite: [wl * tint[0], wl * tint[1], wl * tint[2]],
      inkRatio,
      handPixels,
      knownFraction: knownCount / n,
      volumePixels,
      unknownInVolume: volumePixels ? unknownVol / volumePixels : 0,
      offPaperInVolume,
      offPaperHand,
      offPaperUnknown,
      colourModel: colour,
      timeMs: now() - t0,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// helpers

function median(a: number[]): number | null {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}

function zoneMask(zone: Uint8Array, z: number): Uint8Array {
  const m = new Uint8Array(zone.length);
  for (let p = 0; p < zone.length; p++) if (zone[p] === z) m[p] = 255;
  return m;
}

/** Per-channel tint of the paper (normalised so its luminance is 1): the median colour ratios of the brighter half of
 *  the predicted paper pixels that are nearly neutral (within 25 % of grey). The neutrality prior keeps skin out when
 *  the hand covers most of the predicted paper (a view along the forearm). */
function estimateTint(idx: number[], F: Float32Array[], lum: Float32Array): [number, number, number] {
  const neutral = idx.filter((p) => {
    const r = F[0][p], g = F[1][p], b = F[2][p];
    return (Math.max(r, g, b) - Math.min(r, g, b)) / ((r + g + b) / 3 + 0.004) < 0.25;
  });
  if (neutral.length < 50) return [1, 1, 1];
  const l = neutral.map((p) => lum[p]).sort((a, b) => a - b);
  const cut = l[Math.floor(l.length * 0.5)];
  const rg: number[] = [], bg: number[] = [];
  for (const p of neutral) {
    if (lum[p] < cut || F[1][p] <= 0) continue;
    rg.push(F[0][p] / F[1][p]);
    bg.push(F[2][p] / F[1][p]);
  }
  const r = median(rg) ?? 1, b = median(bg) ?? 1;
  const L = 0.2126 * r + 0.7152 + 0.0722 * b;
  return [r / L, 1 / L, b / L];
}

/** A smooth map of the paper's white luminance: the 80th percentile of paper-looking paper pixels per block, empty
 *  blocks filled from their neighbours, bilinear in between. Zero where no paper was seen anywhere. */
function localWhite(zone: Uint8Array, chroma: Float32Array, lum: Float32Array, w: number, h: number, B: number): Float32Array {
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const val = new Float32Array(bw * bh);
  const ok = new Uint8Array(bw * bh);
  const samples: number[] = [];
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      samples.length = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y++)
        for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x++) {
          const p = y * w + x;
          if (zone[p] === ZONE.paper && chroma[p] < 0.1) samples.push(lum[p]);
        }
      if (samples.length >= 12) {
        samples.sort((a, b) => a - b);
        val[by * bw + bx] = samples[Math.floor(samples.length * 0.8)];
        ok[by * bw + bx] = 1;
      }
    }
  // fill empty blocks by repeated neighbour averaging
  let any = false;
  for (let i = 0; i < ok.length; i++) if (ok[i]) any = true;
  const out = new Float32Array(w * h);
  if (!any) return out;
  for (let iter = 0; iter < bw + bh; iter++) {
    let changed = false;
    const next = ok.slice();
    for (let by = 0; by < bh; by++)
      for (let bx = 0; bx < bw; bx++) {
        const i = by * bw + bx;
        if (ok[i]) continue;
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = bx + dx, y = by + dy;
            if (x < 0 || y < 0 || x >= bw || y >= bh || !ok[y * bw + x]) continue;
            s += val[y * bw + x];
            c++;
          }
        if (c) {
          val[i] = s / c;
          next[i] = 1;
          changed = true;
        }
      }
    ok.set(next);
    if (!changed) break;
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      out[y * w + x] = (1 - ty) * ((1 - tx) * val[y0 * bw + x0] + tx * val[y0 * bw + x1]) + ty * ((1 - tx) * val[y1 * bw + x0] + tx * val[y1 * bw + x1]);
    }
  }
  return out;
}

/** Boundary refinement by linear unmixing: a pixel near the mask edge is hand when its colour is nearer the local
 *  skin colour than the local background colour along the line between them (mixing fraction > 0.5). Local colours
 *  are means of the confident interior pixels of each side within 4 px. Blur is linear in radiance, so the 0.5 point
 *  is the edge for light and dark skin alike (a smoothed chroma threshold moves it into dark skin). */
function refineBoundary(m: Uint8Array, known: Uint8Array, lin: Float32Array[], w: number, h: number): Uint8Array {
  const n = w * h;
  const inner = erodeOnce(erodeOnce(m, w, h), w, h);
  const bgMask = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (!m[p] && known[p]) bgMask[p] = 255;
  const outer = erodeOnce(erodeOnce(bgMask, w, h), w, h);
  const notM = new Uint8Array(n);
  for (let p = 0; p < n; p++) notM[p] = m[p] ? 0 : 255;
  const shrunk = erodeOnce(erodeOnce(notM, w, h), w, h);
  const band = new Uint8Array(n);
  for (let p = 0; p < n; p++) band[p] = shrunk[p] ? 0 : 255; // within 2 px (city-block) of the mask
  const fi = new Float32Array(n), fo = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    fi[p] = inner[p] ? 1 : 0;
    fo[p] = outer[p] ? 1 : 0;
  }
  const ci = boxMean(fi, w, h, 4), co = boxMean(fo, w, h, 4);
  const si: Float32Array[] = [], so: Float32Array[] = [];
  for (let c = 0; c < 3; c++) {
    const a = new Float32Array(n), b = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      a[p] = lin[c][p] * fi[p];
      b[p] = lin[c][p] * fo[p];
    }
    si.push(boxMean(a, w, h, 4));
    so.push(boxMean(b, w, h, 4));
  }
  const out = new Uint8Array(m);
  for (let p = 0; p < n; p++) {
    if (!band[p] || inner[p] || !known[p] || ci[p] <= 0 || co[p] <= 0) continue;
    let num = 0, den = 0;
    for (let c = 0; c < 3; c++) {
      const S = si[c][p] / ci[p], B = so[c][p] / co[p];
      num += (lin[c][p] - B) * (S - B);
      den += (S - B) * (S - B);
    }
    if (den < 1e-5) continue; // skin and background look alike here: keep the first decision
    const alpha = num / den;
    // a pixel off the skin-background line (a shadow is darker but not skin-coloured) is not a mixture: keep it
    let res = 0;
    for (let c = 0; c < 3; c++) {
      const S = si[c][p] / ci[p], B = so[c][p] / co[p];
      res += (lin[c][p] - B - alpha * (S - B)) ** 2;
    }
    if (res > 0.06 * den) continue;
    out[p] = alpha > 0.5 ? 255 : 0;
  }
  return out;
}

function erodeOnce(m: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (m[p] && m[p - 1] && m[p + 1] && m[p - w] && m[p + w]) out[p] = 255;
    }
  return out;
}

function keepLargeComponents(m: Uint8Array, w: number, h: number, frac: number): Uint8Array {
  const { labels, sizes } = components(m, w, h, 255);
  if (sizes.length <= 1) return m;
  const biggest = Math.max(...sizes.slice(1));
  const keep = sizes.map((s) => s >= Math.max(20, frac * biggest));
  const out = new Uint8Array(w * h);
  for (let p = 0; p < labels.length; p++) if (labels[p] && keep[labels[p]]) out[p] = 255;
  return out;
}

/** A colour histogram over (chromaticity r, g in 20 x 20 bins) x (log brightness, 6 bins), smoothed, for a two-class
 *  likelihood ratio. Brightness bins are coarse so a shadow does not move a colour far. */
class ColourHistogram {
  static readonly NC = 20;
  static readonly NL = 6;
  private h = new Float64Array(ColourHistogram.NC * ColourHistogram.NC * ColourHistogram.NL);
  private total = 0;
  private logp: Float64Array | null = null;

  private bin(F: Float32Array[], lum: Float32Array, p: number): number {
    const s = F[0][p] + F[1][p] + F[2][p] + 1e-6;
    const NC = ColourHistogram.NC, NL = ColourHistogram.NL;
    const r = Math.min(NC - 1, Math.floor((F[0][p] / s) * NC));
    const g = Math.min(NC - 1, Math.floor((F[1][p] / s) * NC));
    const l = Math.max(0, Math.min(NL - 1, Math.floor((Math.log2(lum[p] + 1e-5) + 9) / 1.5)));
    return (l * NC + g) * NC + r;
  }

  add(F: Float32Array[], lum: Float32Array, p: number, wgt: number): void {
    this.h[this.bin(F, lum, p)] += wgt;
    this.total += wgt;
  }

  finish(): void {
    const NC = ColourHistogram.NC, NL = ColourHistogram.NL;
    const sm = new Float64Array(this.h.length);
    for (let l = 0; l < NL; l++)
      for (let g = 0; g < NC; g++)
        for (let r = 0; r < NC; r++) {
          let acc = 0;
          for (let dl = -1; dl <= 1; dl++)
            for (let dg = -1; dg <= 1; dg++)
              for (let dr = -1; dr <= 1; dr++) {
                const L = l + dl, G = g + dg, Rr = r + dr;
                if (L < 0 || G < 0 || Rr < 0 || L >= NL || G >= NC || Rr >= NC) continue;
                const wgt = (dl ? 0.5 : 1) * (dg ? 0.5 : 1) * (dr ? 0.5 : 1);
                acc += wgt * this.h[(L * NC + G) * NC + Rr];
              }
          sm[(l * NC + g) * NC + r] = acc;
        }
    let tot = 0;
    for (let i = 0; i < sm.length; i++) tot += sm[i];
    const alpha = 0.02 * (tot / sm.length) + 1e-3;
    const lp = new Float64Array(sm.length);
    for (let i = 0; i < sm.length; i++) lp[i] = Math.log((sm[i] + alpha) / (tot + alpha * sm.length));
    this.logp = lp;
  }

  logP(F: Float32Array[], lum: Float32Array, p: number): number {
    return this.logp ? this.logp[this.bin(F, lum, p)] : 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluation against an exact mask (for SIMULATED reports)

export interface MaskScore {
  /** IoU over the pixels whose rays cross the volume (the only ones the carving uses). */
  iou: number;
  /** IoU over the known pixels among those. */
  iouKnown: number;
  /** Mean / 95th percentile symmetric boundary distance (px) over those pixels (whole-picture boundary). */
  boundaryMeanPx: number;
  boundaryP95Px: number;
  /** Share of the true hand pixels (in the volume region) that are known. */
  handKnown: number;
  /** True hand pixels marked KNOWN background: these carve real hand away (the dangerous error). */
  missedKnown: number;
  /** Background pixels marked hand (adds volume; less harmful). */
  falseHand: number;
}

export function scoreMask(res: SegmentResult, truth: BinaryMask): MaskScore {
  const n = truth.data.length;
  let inter = 0, uni = 0, interK = 0, uniK = 0, handT = 0, handTK = 0, missedKnown = 0, falseHand = 0;
  const a = new Uint8Array(n), b = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (!res.inVolume[p]) continue;
    const t = truth.data[p] > 0, m = res.mask.data[p] > 0, k = res.known.data[p] > 0;
    if (t) a[p] = 255;
    if (m) b[p] = 255;
    if (t && m) inter++;
    if (t || m) uni++;
    if (k) {
      if (t && m) interK++;
      if (t || m) uniK++;
    }
    if (t) {
      handT++;
      if (k) handTK++;
      if (k && !m) missedKnown++;
    } else if (m) falseHand++;
  }
  const bd = boundaryStats({ width: truth.width, height: truth.height, data: a }, { width: truth.width, height: truth.height, data: b });
  return { iou: uni ? inter / uni : 1, iouKnown: uniK ? interK / uniK : 1, boundaryMeanPx: bd.mean, boundaryP95Px: bd.p95, handKnown: handT ? handTK / handT : 1, missedKnown, falseHand };
}

function boundaryStats(a: BinaryMask, b: BinaryMask): { mean: number; p95: number } {
  const { width: w, height: h } = a;
  const edge = (m: Uint8Array) => {
    const e = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (m[p] && ((x > 0 && !m[p - 1]) || (x < w - 1 && !m[p + 1]) || (y > 0 && !m[p - w]) || (y < h - 1 && !m[p + w]))) e[p] = 255;
      }
    return e;
  };
  const ea = edge(a.data), eb = edge(b.data);
  const da = distanceTo(ea, w, h, 255), db = distanceTo(eb, w, h, 255);
  const ds: number[] = [];
  for (let p = 0; p < w * h; p++) {
    if (ea[p] && Number.isFinite(db[p])) ds.push(db[p]);
    if (eb[p] && Number.isFinite(da[p])) ds.push(da[p]);
  }
  if (!ds.length) return { mean: 0, p95: 0 };
  ds.sort((x, y) => x - y);
  return { mean: ds.reduce((s, v) => s + v, 0) / ds.length, p95: ds[Math.floor(0.95 * (ds.length - 1))] };
}
