// The background between adjacent digits (thumb-index, index-middle, middle-ring, ring-little), measured in the MASK.
//
// For two adjacent digits the gap region is the background inside the polygon bounded by the two finger axes (from
// each knuckle along the landmark polyline) up to the height of the LESS advanced of the two mask fingertips, closed by
// the line across at that height. Its pixels split into an OPEN part (connected, across that tip line, to the background outside: an
// ordinary gap) and ENCLOSED parts (background surrounded by hand: fingers touching further out). Reported per pair:
//   * status: open / enclosed / closed (no background between them) / unknown (a finger has no pixels);
//   * depth of the open gap (from that tip line back to its deepest point, the valley or web point) and its width at
//     stated distances from the valley towards the tips; an open region shallower than GAP_OPEN_MIN_RATIO of the
//     landmark reference depth (e.g. the notch between two touching rounded fingertips) is not a gap;
//   * "merged": the landmarks show the two digits apart (the existing valley rule of fingers.ts) but the mask has no
//     open gap there, the open gap stops short (depth below GAP_MERGED_DEPTH_RATIO of the tip-line-to-knuckle-line
//     distance), or background is enclosed between them (a bridge). The mask is never carved here: the boundary stays
//     the mask's.
//
// EXPERIMENTAL; thresholds provisional (constants.ts).
import type { Pt } from "../common";
import { GAP_MERGED_DEPTH_RATIO, GAP_MIN_AREA, GAP_MIN_DEPTH, GAP_OPEN_MIN_RATIO, GAP_WIDTH_DISTANCES } from "./constants";
import { analyseGaps } from "./fingers";
import { DIGITS, dist, fillPolygon, palmWidth } from "./geometry";
import { components } from "./morph";
import { FINGER_NAMES, fingerAxis, pointAt, type FingerName, type FingerPart } from "./parts";

export type GapStatus = "open" | "enclosed" | "closed" | "unknown";

export interface GapWidth {
  /** Distance from the valley point towards the fingertips, palm widths (one of GAP_WIDTH_DISTANCES). */
  distancePw: number;
  /** The same distance in SOURCE pixels. */
  distancePx: number;
  /** Width of the open gap across that line (perpendicular to the gap's axis), SOURCE pixels (null = gap ends before). */
  widthPx: number | null;
}

export interface FingerGap {
  pair: 0 | 1 | 2 | 3;
  names: [FingerName, FingerName];
  status: GapStatus;
  /** The landmarks show the two digits spread apart, so a gap is expected (fingers.ts valley rule). */
  expected: boolean;
  /** Expected but absent or stopping short in the mask: the mask joins two digits the landmarks say are separate. */
  merged: boolean;
  /** Area of the open gap region, SOURCE pixels squared. */
  openAreaPx: number;
  /** Area of background enclosed between the two digits, SOURCE pixels squared. */
  enclosedAreaPx: number;
  /** Depth of the open gap from the less advanced mask fingertip's height to its deepest point, SOURCE pixels. */
  depthPx: number;
  /** The same height for the landmark fingertips above the knuckle line (the depth a full gap would have), SOURCE pixels. */
  referenceDepthPx: number;
  /** depthPx / referenceDepthPx (0 when there is no open gap). */
  depthRatio: number;
  /** Deepest point of the open gap (web / valley), SOURCE pixels. */
  valley: Pt | null;
  widths: GapWidth[];
  /** The existing valley-line check (share of samples midway between the digits that are background). */
  valleyBackgroundShare: number;
}

export interface GapAnalysisResult {
  gaps: FingerGap[];
  /** Per pixel: 0 none, 1-4 the open gap of pair 0-3, 5-8 enclosed background of pair 0-3 (working size). */
  gapMap: Uint8Array;
}

const baseLandmark = (d: number) => (d === 0 ? 2 : DIGITS[d][0]);
const tipLandmark = (d: number) => DIGITS[d][3];

/**
 * Gap analysis from the mask, the part labels' finger measurements and the landmarks (working-image pixels in,
 * SOURCE pixels out; `scaleToSource` = source px per working px).
 */
export function analyseFingerGaps(mask: Uint8Array, w: number, h: number, lm: readonly Pt[], fingers: readonly FingerPart[], scaleToSource: number): GapAnalysisResult {
  const k = scaleToSource;
  const pw = palmWidth(lm);
  const legacy = analyseGaps(mask, w, h, lm, false).gaps;
  const gapMap = new Uint8Array(w * h);
  const gaps: FingerGap[] = [];
  for (let pair = 0 as 0 | 1 | 2 | 3; pair < 4; pair = (pair + 1) as 0 | 1 | 2 | 3) {
    const fa = fingers[pair];
    const fb = fingers[pair + 1];
    const empty: FingerGap = {
      pair,
      names: [FINGER_NAMES[pair], FINGER_NAMES[pair + 1]],
      status: "unknown",
      expected: legacy[pair].expected,
      merged: false,
      openAreaPx: 0,
      enclosedAreaPx: 0,
      depthPx: 0,
      referenceDepthPx: 0,
      depthRatio: 0,
      valley: null,
      widths: GAP_WIDTH_DISTANCES.map((t) => ({ distancePw: t, distancePx: t * pw * k, widthPx: null })),
      valleyBackgroundShare: legacy[pair].backgroundShare,
    };
    if (!fa.present || !fb.present) {
      gaps.push(empty);
      continue;
    }
    // Gap direction v: from the middle of the two mask fingertips towards the middle of the two knuckles. "Height" of a
    // point = its distance above the knuckle line along -v. Both axes are cut at the height of the LESS advanced
    // fingertip, so the region beyond the shorter finger's tip (beside the longer finger) never counts as gap.
    const axA = fingerAxis(lm, pair, 0.8 * pw);
    const axB = fingerAxis(lm, pair + 1, 0.8 * pw);
    const endA = pointAt(axA.pts, axA.cum, fa.maskLengthPx / k).p;
    const endB = pointAt(axB.pts, axB.cum, fb.maskLengthPx / k).p;
    const bA = lm[baseLandmark(pair)];
    const bB = lm[baseLandmark(pair + 1)];
    const baseMid = { x: (bA.x + bB.x) / 2, y: (bA.y + bB.y) / 2 };
    const tipMid = { x: (endA.x + endB.x) / 2, y: (endA.y + endB.y) / 2 };
    const vl = dist(tipMid, baseMid) || 1;
    const v = { x: (baseMid.x - tipMid.x) / vl, y: (baseMid.y - tipMid.y) / vl };
    const height = (q: Pt) => (baseMid.x - q.x) * v.x + (baseMid.y - q.y) * v.y;
    const level = Math.min(height(endA), height(endB));
    const cut = (ax: { pts: Pt[]; cum: number[] }, sEnd: number): Pt[] => {
      const pts: Pt[] = [ax.pts[0]];
      for (let i = 0; i + 1 < ax.pts.length; i++) {
        const a = ax.pts[i];
        const b = ax.pts[i + 1];
        const segEnd = Math.min(sEnd, ax.cum[i + 1]);
        const e = segEnd >= ax.cum[i + 1] ? b : pointAt(ax.pts, ax.cum, segEnd).p;
        const ha = height(a);
        const he = height(e);
        if (he >= level) {
          const t = he > ha ? Math.max(0, Math.min(1, (level - ha) / (he - ha))) : 1;
          pts.push({ x: a.x + (e.x - a.x) * t, y: a.y + (e.y - a.y) * t });
          return pts;
        }
        pts.push(e);
        if (segEnd >= sEnd) return pts;
      }
      return pts;
    };
    const A = cut(axA, fa.maskLengthPx / k);
    const B = cut(axB, fb.maskLengthPx / k);
    const poly = [...A, ...B.slice().reverse()];
    const inPoly = new Uint8Array(w * h);
    fillPolygon(inPoly, w, h, poly, 255);
    const g = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) if (inPoly[i] && !mask[i]) g[i] = 255;
    const comps = components(g, w, h, 255);
    const open = new Array<boolean>(comps.sizes.length).fill(false);
    for (let i = 0; i < g.length; i++) {
      const c = comps.labels[i];
      if (!c || open[c]) continue;
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        open[c] = true;
        continue;
      }
      for (const j of [i - 1, i + 1, i - w, i + w]) if (!inPoly[j] && !mask[j]) open[c] = true;
    }
    let bestOpen = 0;
    let enclosed = 0;
    for (let c = 1; c < comps.sizes.length; c++) {
      if (open[c]) {
        if (!bestOpen || comps.sizes[c] > comps.sizes[bestOpen]) bestOpen = c;
      } else enclosed += comps.sizes[c];
    }
    // Reference: the same construction from the landmark tips (the knuckle line is height 0).
    const refDepth = Math.max(0, Math.min(height(lm[tipLandmark(pair)]), height(lm[tipLandmark(pair + 1)])));
    let depth = 0;
    let openArea = 0;
    let valley: Pt | null = null;
    if (bestOpen) {
      openArea = comps.sizes[bestOpen];
      for (let i = 0; i < g.length; i++) {
        if (comps.labels[i] !== bestOpen) continue;
        const dd = level - height({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 });
        if (dd > depth) depth = dd;
      }
      let vx = 0;
      let vy = 0;
      let vn = 0;
      for (let i = 0; i < g.length; i++) {
        const c = comps.labels[i];
        if (c) gapMap[i] = c === bestOpen ? pair + 1 : open[c] ? 0 : pair + 5;
        if (c !== bestOpen) continue;
        const q = { x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 };
        if (level - height(q) >= depth - 0.75) ((vx += q.x), (vy += q.y), vn++);
      }
      valley = { x: vx / vn, y: vy / vn };
    } else {
      for (let i = 0; i < g.length; i++) if (comps.labels[i]) gapMap[i] = pair + 5;
    }
    const rawRatio = refDepth > 0 ? depth / refDepth : 0;
    const isOpen = openArea >= Math.max(4, GAP_MIN_AREA * pw * pw) && depth >= GAP_MIN_DEPTH * pw && rawRatio >= GAP_OPEN_MIN_RATIO;
    const status: GapStatus = isOpen ? "open" : enclosed >= Math.max(4, GAP_MIN_AREA * pw * pw) ? "enclosed" : "closed";
    const ratio = isOpen ? rawRatio : 0;
    const widths: GapWidth[] = GAP_WIDTH_DISTANCES.map((t) => {
      const distW = t * pw;
      if (!valley || !isOpen || distW >= depth) return { distancePw: t, distancePx: distW * k, widthPx: null };
      const c = { x: valley.x - v.x * distW, y: valley.y - v.y * distW };
      const wd = runWidth(comps.labels, bestOpen, w, h, c, { x: -v.y, y: v.x }, 0.3 * pw);
      return { distancePw: t, distancePx: distW * k, widthPx: wd === null ? null : wd * k };
    });
    gaps.push({
      ...empty,
      status,
      // Merged: expected but no open gap, an open gap stopping short, or background enclosed between the two digits
      // (something bridges them further out; holes smaller than the post-processing fill limit are already gone).
      merged: empty.expected && (!isOpen || ratio < GAP_MERGED_DEPTH_RATIO || enclosed >= Math.max(4, GAP_MIN_AREA * pw * pw)),
      openAreaPx: openArea * k * k,
      enclosedAreaPx: enclosed * k * k,
      depthPx: isOpen ? depth * k : 0,
      referenceDepthPx: refDepth * k,
      depthRatio: ratio,
      valley: valley && isOpen ? { x: valley.x * k, y: valley.y * k } : null,
      widths,
    });
  }
  return { gaps, gapMap };
}

/** Width of the run of component `c` crossing the line through `p` along `n` (working px, 0.25 px steps). */
function runWidth(labels: Int32Array, c: number, w: number, h: number, p: Pt, n: Pt, search: number): number | null {
  const STEP = 0.25;
  const inC = (o: number) => {
    const x = Math.floor(p.x + n.x * o);
    const y = Math.floor(p.y + n.y * o);
    return x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === c;
  };
  let start: number | null = null;
  for (let o = 0; o <= search && start === null; o += STEP) {
    if (inC(o)) start = o;
    else if (inC(-o)) start = -o;
  }
  if (start === null) return null;
  let a = start;
  while (inC(a + STEP)) a += STEP;
  let b = start;
  while (inC(b - STEP)) b -= STEP;
  return a - b + STEP;
}
