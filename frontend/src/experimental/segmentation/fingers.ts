// Hand-specific analysis of a binary mask using the landmarks: fingertips, the wrist boundary and the gaps between
// fingers. All in the pixels of the mask's own image, orientation-independent (everything derives from landmark axes).
import type { Pt } from "../common";
import {
  GAP_EXPECTED_MIN_SEPARATION,
  GAP_PRESERVED_MIN_SHARE,
  GAP_SAMPLE_COUNT,
  GAP_SAMPLE_FROM,
  GAP_SAMPLE_TO,
  MAX_TIP_OFFSET,
} from "./constants";
import { DIGITS, DIGIT_NAMES, dist, drawThickLine, lerp, palmWidth, sub } from "./geometry";

export interface Tip {
  /** The fingertip as found in the mask (farthest hand pixel along the DIP-to-tip axis), or null. */
  point: Pt | null;
  /** Distance from the landmark fingertip, as a fraction of the palm width. */
  offset: number;
}

const inMask = (m: Uint8Array, w: number, h: number, x: number, y: number): boolean => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  return xi >= 0 && yi >= 0 && xi < w && yi < h && m[yi * w + xi] !== 0;
};

/**
 * Fingertips refined from the mask: walk outwards from the DIP joint along the DIP-to-tip axis and stop where the
 * hand ends (a gap of up to two pixels is bridged). A tip is "found" only when the walk starts inside the hand and
 * reaches at least 60 % of the way to the landmark tip. Convention: the farthest mask pixel on that line.
 */
export function refineFingertips(mask: Uint8Array, w: number, h: number, lm: readonly Pt[]): Tip[] {
  const pw = palmWidth(lm);
  return DIGITS.map((d) => {
    const dip = lm[d[2]];
    const tip = lm[d[3]];
    const len = dist(dip, tip);
    if (len < 1e-6) return { point: null, offset: Infinity };
    const ux = (tip.x - dip.x) / len;
    const uy = (tip.y - dip.y) / len;
    const maxLen = len * 1.25 + 0.4 * pw;
    let start = dip;
    if (!inMask(mask, w, h, start.x, start.y)) start = lm[d[1]]; // the DIP landmark may sit just off a thin mask
    if (!inMask(mask, w, h, start.x, start.y)) return { point: null, offset: Infinity };
    const startAlong = dist(dip, start) > 0 ? -dist(dip, start) : 0;
    let last = start;
    let lastS = startAlong;
    let gap = 0;
    for (let s = startAlong; s <= maxLen; s += 0.5) {
      const p = { x: dip.x + ux * s, y: dip.y + uy * s };
      if (inMask(mask, w, h, p.x, p.y)) {
        last = p;
        lastS = s;
        gap = 0;
      } else if ((gap += 0.5) > 2) break;
    }
    const reached = lastS >= len * 0.6;
    return { point: reached ? last : null, offset: reached ? dist(last, tip) / pw : Infinity };
  });
}

export function tipsFound(tips: readonly Tip[]): number {
  return tips.filter((t) => t.point !== null && t.offset <= MAX_TIP_OFFSET).length;
}

export interface WristCut {
  /** The mask with the forearm side of the wrist line removed. */
  mask: Uint8Array;
  /** The two ends of the cut across the hand, or null when the mask does not reach the line. */
  line: [Pt, Pt] | null;
  /** Length of the cut (the wrist width at the cut) in pixels. */
  widthPx: number;
  removedPixels: number;
}

/**
 * Wrist boundary convention: the line through landmark 0 (the wrist point MediaPipe places at the base of the palm)
 * perpendicular to the forearm axis, which runs from the middle of the four knuckles (landmarks 5, 9, 13, 17)
 * through landmark 0 and on. Hand pixels beyond that line, on the forearm side, are removed. The cut ends are
 * where the mask crosses the line, found from landmark 0 outwards on both sides.
 */
export function cutAtWrist(mask: Uint8Array, w: number, h: number, lm: readonly Pt[]): WristCut {
  const knuckles = [5, 9, 13, 17].map((i) => lm[i]);
  const c = { x: knuckles.reduce((s, p) => s + p.x, 0) / 4, y: knuckles.reduce((s, p) => s + p.y, 0) / 4 };
  const w0 = lm[0];
  const ax = w0.x - c.x;
  const ay = w0.y - c.y;
  const al = Math.hypot(ax, ay) || 1;
  const ux = ax / al; // forearm direction
  const uy = ay / al;
  const out = new Uint8Array(mask);
  let removed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!out[y * w + x]) continue;
      if ((x + 0.5 - w0.x) * ux + (y + 0.5 - w0.y) * uy > 0) {
        out[y * w + x] = 0;
        removed++;
      }
    }
  }
  // Ends of the cut: walk along the line (perpendicular to the forearm axis) from the wrist point while the hand
  // is there (one pixel of tolerance towards the hand side, where the cut left the edge).
  const nx = -uy;
  const ny = ux;
  const touches = (s: number) => {
    for (const back of [0, 1, 2]) {
      const x = w0.x + nx * s - ux * back;
      const y = w0.y + ny * s - uy * back;
      if (inMask(out, w, h, x, y)) return true;
    }
    return false;
  };
  const lim = Math.max(w, h);
  let sMin = 0;
  let sMax = 0;
  let any = touches(0);
  if (!any) {
    for (let s = 1; s < lim && !any; s++) {
      if (touches(s)) ((sMax = s), (sMin = s), (any = true));
      else if (touches(-s)) ((sMax = -s), (sMin = -s), (any = true));
    }
  }
  if (!any) return { mask: out, line: null, widthPx: 0, removedPixels: removed };
  for (let s = sMax; s < lim && touches(s + 1); s++) sMax = s + 1;
  for (let s = sMin; s > -lim && touches(s - 1); s--) sMin = s - 1;
  const a = { x: w0.x + nx * sMin, y: w0.y + ny * sMin };
  const b = { x: w0.x + nx * sMax, y: w0.y + ny * sMax };
  return { mask: out, line: [a, b], widthPx: dist(a, b), removedPixels: removed };
}

// ---------------------------------------------------------------------------------------------------------------
// Gaps between adjacent digits

export interface GapReport {
  /** Which two digits: 0 thumb-index, 1 index-middle, 2 middle-ring, 3 ring-pinky. */
  pair: 0 | 1 | 2 | 3;
  names: [string, string];
  /** The landmarks show the two digits spread apart, so a gap of background is expected between them. */
  expected: boolean;
  /** Largest centre-line separation of the two digits (fraction of the palm width). */
  separation: number;
  /** Share of valley samples that are background in the mask (1 = a clear gap all the way). */
  backgroundShare: number;
  /** The gap is open in the mask (share at or above the threshold). */
  preserved: boolean;
  /** Hand pixels cleared by carving the gap (0 when none were needed or carving is off). */
  carvedPixels: number;
}

/** The reference segment of a digit for valley sampling: from its PIP (thumb: MCP) joint to its tip. */
function reference(lm: readonly Pt[], digit: number): [Pt, Pt] {
  const d = DIGITS[digit];
  return [lm[d[1]], lm[d[3]]];
}

function valley(lm: readonly Pt[], pair: number, t: number): { mid: Pt; separation: number } {
  const [a0, a1] = reference(lm, pair);
  const [b0, b1] = reference(lm, pair + 1);
  const pa = lerp(a0, a1, t);
  const pb = lerp(b0, b1, t);
  return { mid: lerp(pa, pb, 0.5), separation: dist(pa, pb) };
}

/** True when the pixel at the point, or one 1.5 px to either side across the valley, is background. */
function isGapPixel(mask: Uint8Array, w: number, h: number, p: Pt, across: Pt): boolean {
  const offs = [0, 1.5, -1.5];
  for (const o of offs) {
    const x = p.x + across.x * o;
    const y = p.y + across.y * o;
    if (x >= 0 && y >= 0 && x < w && y < h && !inMask(mask, w, h, x, y)) return true;
  }
  return false;
}

export interface GapAnalysis {
  gaps: GapReport[];
  /** The mask after carving (a copy; the input is untouched). */
  mask: Uint8Array;
}

/**
 * Check, and optionally restore, the background gap between every two adjacent digits.
 * The valley line between two digits runs midway between their bone axes. Where the landmarks show the digits spread
 * far enough apart (centre lines more than GAP_EXPECTED_MIN_SEPARATION of the palm width apart) the midway line is
 * more than half a finger width from both bones, so it lies in background by geometry: if the mask has hand pixels
 * there it has merged the fingers, and a thin line along the valley is cleared. Gaps the landmarks do not show
 * (fingers together) and the thumb-index gap are only reported, never carved.
 */
export function analyseGaps(mask: Uint8Array, w: number, h: number, lm: readonly Pt[], carve: boolean): GapAnalysis {
  const pw = palmWidth(lm);
  const out = new Uint8Array(mask);
  const gaps: GapReport[] = [];
  for (let pair = 0 as 0 | 1 | 2 | 3; pair < 4; pair = (pair + 1) as 0 | 1 | 2 | 3) {
    let maxSep = 0;
    for (let k = 0; k <= 8; k++) maxSep = Math.max(maxSep, valley(lm, pair, 0.5 + (k / 8) * 0.7).separation / pw);
    const expected = maxSep >= GAP_EXPECTED_MIN_SEPARATION;
    let carved = 0;
    // The thumb-index web is a wide skin region and the thumb is not parallel to the fingers, so that gap is only
    // reported, never carved: carving is for the three finger-to-finger valleys.
    if (carve && expected && pair >= 1) {
      const radius = Math.max(0.8, 0.06 * pw);
      let prev: Pt | null = null;
      for (let k = 0; k <= 24; k++) {
        const t = 0.2 + (k / 24) * 1.1;
        const v = valley(lm, pair, t);
        if (v.separation / pw < GAP_EXPECTED_MIN_SEPARATION * 0.95) {
          prev = null;
          continue;
        }
        if (prev) {
          const before = countIn(out, w, h, prev, v.mid, radius);
          drawThickLine(out, w, h, prev, v.mid, radius, 0);
          carved += before;
        }
        prev = v.mid;
      }
    }
    let bg = 0;
    let n = 0;
    for (let k = 0; k < GAP_SAMPLE_COUNT; k++) {
      const t = GAP_SAMPLE_FROM + (k / (GAP_SAMPLE_COUNT - 1)) * (GAP_SAMPLE_TO - GAP_SAMPLE_FROM);
      const v = valley(lm, pair, t);
      if (expected && v.separation / pw < GAP_EXPECTED_MIN_SEPARATION * 0.6) continue; // fingers practically touch here
      const [a0, a1] = reference(lm, pair);
      const dir = sub(a1, a0);
      const dl = Math.hypot(dir.x, dir.y) || 1;
      const across = { x: -dir.y / dl, y: dir.x / dl };
      n++;
      if (isGapPixel(out, w, h, v.mid, across)) bg++;
    }
    const share = n ? bg / n : 0;
    gaps.push({
      pair,
      names: [DIGIT_NAMES[pair], DIGIT_NAMES[pair + 1]],
      expected,
      separation: maxSep,
      backgroundShare: share,
      preserved: share >= GAP_PRESERVED_MIN_SHARE,
      carvedPixels: carved,
    });
  }
  return { gaps, mask: out };
}

/** Number of hand pixels a thick line would clear (counted before it is drawn). */
function countIn(mask: Uint8Array, w: number, h: number, a: Pt, b: Pt, radius: number): number {
  const probe = new Uint8Array(mask.length);
  drawThickLine(probe, w, h, a, b, radius, 255);
  let n = 0;
  for (let i = 0; i < probe.length; i++) if (probe[i] && mask[i]) n++;
  return n;
}
