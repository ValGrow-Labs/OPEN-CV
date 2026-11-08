// Part labels of a hand mask: palm, wrist, thumb, index, middle, ring, little finger (and background), plus per-finger
// geometry measured from the MASK (area, outline, fingertip, length, width profile).
//
// How a pixel gets its label: the 21 landmarks give a skeleton of line segments, each belonging to one part. Every mask
// pixel takes the part of the skeleton segment it is closest to along a path that stays INSIDE the mask (geodesic
// distance, multi-source Dijkstra), so a label never jumps across a gap of background. The landmarks only decide which
// part a hand pixel belongs to; which pixels are hand is decided by the mask alone. The outline of every part is the
// mask's outline (plus the internal borders between parts).
//
// Conventions (orientation-independent, all from landmark axes):
//  * A finger begins at its KNUCKLE LINE: the line through its MCP joint (landmark 5/9/13/17) perpendicular to the
//    proximal phalanx (MCP to PIP). This comes from a palm skeleton "stub" that ends at each knuckle along the finger's
//    axis, so the Voronoi border between palm and finger is that perpendicular. The web skin above the knuckle line is
//    split between the two neighbouring fingers. This is NOT the palmar crease or the web point (anthropometric finger
//    length is often taken from the crease); the web point is reported separately by the gap analysis.
//  * The thumb begins at the line through its MCP joint (landmark 2) perpendicular to its proximal phalanx (2 to 3);
//    the thumb metacarpal (1 to 2) is palm.
//  * Wrist: palm pixels within WRIST_BAND palm widths of the wrist cut (the line through landmark 0 perpendicular to the
//    forearm axis), on the hand side.
//  * Fingertip: the mask pixel of that finger's label reaching farthest along the finger's axis (the landmark polyline
//    MCP-PIP-DIP-TIP continued past the tip), never the landmark tip itself.
//
// EXPERIMENTAL. Thresholds in constants.ts are provisional. Nothing here is a measurement of a person.
import type { Pt } from "../common";
import { COLOUR_BREAK_MAX_AT, PALM_STUB, WIDTH_STATIONS, WRIST_BAND } from "./constants";
import { DIGITS, dist, palmWidth } from "./geometry";
import type { ImageLike } from "./imageops";
import { maskToContour, simplifyPolygon } from "./metrics";

export const PART = { background: 0, palm: 1, wrist: 2, thumb: 3, index: 4, middle: 5, ring: 6, little: 7 } as const;
export type PartName = "background" | "palm" | "wrist" | "thumb" | "index" | "middle" | "ring" | "little";
export const PART_NAMES: readonly PartName[] = ["background", "palm", "wrist", "thumb", "index", "middle", "ring", "little"];
/** Digits in MediaPipe order (the existing modules call the fifth one "pinky"; this one says "little"). */
export const FINGER_NAMES = ["thumb", "index", "middle", "ring", "little"] as const;
export type FingerName = (typeof FINGER_NAMES)[number];
/** Part label of digit 0..4 (thumb..little). */
export const fingerPart = (digit: number): number => PART.thumb + digit;

interface Segment {
  a: Pt;
  b: Pt;
  part: number;
}

const unit = (a: Pt, b: Pt): Pt => {
  const l = dist(a, b) || 1;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
};
const along = (p: Pt, u: Pt, s: number): Pt => ({ x: p.x + u.x * s, y: p.y + u.y * s });

/** The labelled skeleton: palm segments (with a stub ending at every knuckle along its finger) and the digit bones. */
export function skeletonSegments(lm: readonly Pt[]): Segment[] {
  const pw = palmWidth(lm);
  const segs: Segment[] = [];
  const palm = PART.palm;
  // Thumb: wrist -> CMC (1) -> stub start -> MCP (2), the stub running along the thumb's proximal phalanx.
  const ut = unit(lm[2], lm[3]);
  const thumbStub = along(lm[2], ut, -Math.min(PALM_STUB * pw, 0.8 * dist(lm[1], lm[2])));
  segs.push({ a: lm[0], b: lm[1], part: palm }, { a: lm[1], b: thumbStub, part: palm }, { a: thumbStub, b: lm[2], part: palm });
  // Fingers: wrist -> stub start -> knuckle, the stub along the proximal phalanx.
  for (const k of [5, 9, 13, 17]) {
    const u = unit(lm[k], lm[k + 1]);
    const stub = along(lm[k], u, -Math.min(PALM_STUB * pw, 0.8 * dist(lm[0], lm[k])));
    segs.push({ a: lm[0], b: stub, part: palm }, { a: stub, b: lm[k], part: palm });
  }
  segs.push({ a: lm[2], b: lm[3], part: PART.thumb }, { a: lm[3], b: lm[4], part: PART.thumb });
  for (let d = 1; d < 5; d++) {
    const [m, p, q, t] = DIGITS[d];
    for (const [a, b] of [[m, p], [p, q], [q, t]] as const) segs.push({ a: lm[a], b: lm[b], part: fingerPart(d) });
  }
  return segs;
}

function pointSegDist(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - a.x - t * dx, py - a.y - t * dy);
}

/** A minimal binary min-heap of (key, value) pairs. */
class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.k.length;
  }
  push(key: number, val: number): void {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k;
    const v = this.v;
    const topK = k[0];
    const topV = v[0];
    const lastK = k.pop() as number;
    const lastV = v.pop() as number;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= lastK) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return [topK, topV];
  }
}

export interface PartLabels {
  /** Part label per pixel (PART values; 0 = background). */
  labels: Uint8Array;
  /** Mask pixels no skeleton segment could reach inside the mask (left as background in `labels`). */
  unlabelledPixels: number;
  /** Pixel count per part label (index = PART value). */
  counts: number[];
}

/**
 * Label every mask pixel with the part of its geodesically nearest skeleton segment (paths stay inside the mask,
 * 8-neighbour steps). Seeds are the mask pixels within 0.75 px of a segment, starting at their exact distance to it.
 */
export function labelParts(mask: Uint8Array, w: number, h: number, lm: readonly Pt[]): PartLabels {
  const n = w * h;
  const best = new Float64Array(n).fill(Infinity);
  const labels = new Uint8Array(n);
  const heap = new MinHeap();
  for (const s of skeletonSegments(lm)) {
    const x0 = Math.max(0, Math.floor(Math.min(s.a.x, s.b.x) - 1));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(s.a.x, s.b.x) + 1));
    const y0 = Math.max(0, Math.floor(Math.min(s.a.y, s.b.y) - 1));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(s.a.y, s.b.y) + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const d = pointSegDist(x + 0.5, y + 0.5, s.a, s.b);
        if (d <= 0.75 && d < best[i]) {
          best[i] = d;
          labels[i] = s.part;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) if (best[i] < Infinity) heap.push(best[i], i);
  const done = new Uint8Array(n);
  const SQ2 = Math.SQRT2;
  while (heap.size) {
    const [d, i] = heap.pop();
    if (done[i] || d > best[i]) continue;
    done[i] = 1;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (!mask[j] || done[j]) continue;
        const nd = d + (dx && dy ? SQ2 : 1);
        if (nd < best[j]) {
          best[j] = nd;
          labels[j] = labels[i];
          heap.push(nd, j);
        }
      }
    }
  }
  // Wrist band: palm pixels close to the wrist cut, on the hand side.
  const pw = palmWidth(lm);
  const kc = { x: (lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 4, y: (lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 4 };
  const up = unit(lm[0], kc);
  const band = WRIST_BAND * pw;
  let unlabelled = 0;
  const counts = new Array<number>(PART_NAMES.length).fill(0);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    if (!labels[i]) {
      unlabelled++;
      continue;
    }
    if (labels[i] === PART.palm) {
      const x = (i % w) + 0.5;
      const y = Math.floor(i / w) + 0.5;
      if ((x - lm[0].x) * up.x + (y - lm[0].y) * up.y < band) labels[i] = PART.wrist;
    }
    counts[labels[i]]++;
  }
  return { labels, unlabelledPixels: unlabelled, counts };
}

// ---------------------------------------------------------------------------------------------------------------
// Per-finger geometry

/** What stopped a width measurement on one side: the mask's own edge, another part's label, or the image border. */
export type EdgeKind = "mask" | "part" | "image";

export interface WidthSample {
  /** Station as a fraction of the finger's mask length from its knuckle line. */
  at: number;
  /** Station distance from the knuckle line along the axis, SOURCE pixels. */
  alongPx: number;
  /** Width across the finger's label at the station, perpendicular to the axis, SOURCE pixels (null = not found). */
  widthPx: number | null;
  /** What ended the run on each side. "part" means the width there is a label border, not the mask's outline. */
  edges: [EdgeKind, EdgeKind] | null;
}

export interface FingerPart {
  finger: FingerName;
  part: number;
  /** Label pixels found (false = no pixel of this finger in the mask: missing or completely covered). */
  present: boolean;
  /** Pixel area of the finger's label, SOURCE pixels squared. */
  areaPx: number;
  /** Outline of the finger's label region (largest piece), SOURCE pixels, simplified to ~0.7 working px. */
  outline: Pt[];
  /** Fingertip: the label pixel reaching farthest along the finger's axis, SOURCE pixels (null if absent). */
  tip: Pt | null;
  /** Distance from the mask fingertip to the landmark fingertip, in palm widths. */
  tipToLandmarkPw: number | null;
  /** Length of the label along the axis from the knuckle line to the mask fingertip, SOURCE pixels. */
  maskLengthPx: number;
  /** Length of the landmark chain (knuckle to landmark tip), SOURCE pixels. */
  landmarkLengthPx: number;
  /** maskLength / landmarkLength (about 1.05-1.2 for a whole finger: the skin ends beyond the landmark tip). */
  lengthRatio: number;
  /** A label pixel lies on the image border. */
  touchesBorder: boolean;
  /** Widths at WIDTH_STATIONS. */
  widths: WidthSample[];
  /**
   * Median width from a dense scan (every working pixel) between 20 % and 80 % of the length, counting only cross
   * sections bounded by the mask's own outline on both sides, SOURCE pixels (null = too few such sections).
   */
  medianWidthPx: number | null;
  /** Narrowest such section divided by that median (a neck: something may cover the finger), and where (fraction). */
  neck: { ratio: number; at: number } | null;
  /** Widest such section divided by that median (a bulge: something attached to or lying over the finger), and where. */
  bulge: { ratio: number; at: number } | null;
  /**
   * The worst cross-band (0.1 of the length wide, centred on a station from 10 % to COLOUR_BREAK_MAX_AT) by colour: the share of its
   * pixels whose rg chromaticity is outside the hand's own range (null when no picture was given). Above 0.5 the band
   * is mostly not hand-coloured: an object or a strong cast over the finger.
   */
  colourBreak: { share: number; at: number } | null;
}

/** The finger's axis: knuckle, joints, landmark tip, continued past the tip by `ext` pixels. */
export function fingerAxis(lm: readonly Pt[], digit: number, ext: number): { pts: Pt[]; cum: number[]; landmarkLength: number } {
  const idx = digit === 0 ? [2, 3, 4] : [...DIGITS[digit]];
  const pts = idx.map((i) => lm[i]);
  const last = pts[pts.length - 1];
  pts.push(along(last, unit(pts[pts.length - 2], last), ext));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, cum, landmarkLength: cum[cum.length - 2] };
}

/** Arc length of the nearest point of a polyline (clamped at both ends). */
function project(pts: readonly Pt[], cum: readonly number[], x: number, y: number): number {
  let bestD = Infinity;
  let bestS = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
    if (d < bestD) ((bestD = d), (bestS = cum[i] + t * Math.sqrt(l2)));
  }
  return bestS;
}

export function pointAt(pts: readonly Pt[], cum: readonly number[], s: number): { p: Pt; t: Pt } {
  let i = 0;
  while (i + 2 < pts.length && cum[i + 1] < s) i++;
  const seg = cum[i + 1] - cum[i] || 1;
  const f = (s - cum[i]) / seg;
  const a = pts[i];
  const b = pts[i + 1];
  return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, t: unit(a, b) };
}

/** Largest 4-connected piece of one label, as a 0/255 mask. */
function largestPiece(labels: Uint8Array, w: number, h: number, part: number): Uint8Array {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let bestStart = -1;
  let bestSize = 0;
  for (let s = 0; s < n; s++) {
    if (labels[s] !== part || seen[s]) continue;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    let size = 0;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < n && labels[q] === part && !seen[q]) ((seen[q] = 1), (stack[sp++] = q));
      }
    }
    if (size > bestSize) ((bestSize = size), (bestStart = s));
  }
  const out = new Uint8Array(n);
  if (bestStart < 0) return out;
  let sp = 0;
  stack[sp++] = bestStart;
  out[bestStart] = 255;
  while (sp) {
    const p = stack[--sp];
    const x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q >= 0 && q < n && labels[q] === part && !out[q]) ((out[q] = 255), (stack[sp++] = q));
    }
  }
  return out;
}

/**
 * Geometry of each of the five digits from the part labels (working-image pixels in, SOURCE pixels out:
 * `scaleToSource` = source px per working px).
 */
export function measureFingers(labels: Uint8Array, mask: Uint8Array, w: number, h: number, lm: readonly Pt[], scaleToSource: number, image?: ImageLike): FingerPart[] {
  const pw = palmWidth(lm);
  const k = scaleToSource;
  const out: FingerPart[] = [];
  const chroma = image ? handChroma(image, mask) : null;
  for (let d = 0; d < 5; d++) {
    const part = fingerPart(d);
    const axis = fingerAxis(lm, d, 0.8 * pw);
    let area = 0;
    let sMax = -Infinity;
    let touches = false;
    const ss = new Float32Array(w * h).fill(-1);
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== part) continue;
      area++;
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      const s = project(axis.pts, axis.cum, x + 0.5, y + 0.5);
      ss[i] = s;
      if (s > sMax) sMax = s;
    }
    const base: FingerPart = {
      finger: FINGER_NAMES[d],
      part,
      present: area > 0,
      areaPx: area * k * k,
      outline: [],
      tip: null,
      tipToLandmarkPw: null,
      maskLengthPx: 0,
      landmarkLengthPx: axis.landmarkLength * k,
      lengthRatio: 0,
      touchesBorder: touches,
      widths: [],
      medianWidthPx: null,
      neck: null,
      bulge: null,
      colourBreak: null,
    };
    if (!area) {
      out.push(base);
      continue;
    }
    let tx = 0;
    let ty = 0;
    let tn = 0;
    for (let i = 0; i < ss.length; i++) {
      if (ss[i] >= sMax - 0.75) {
        tx += (i % w) + 0.5;
        ty += Math.floor(i / w) + 0.5;
        tn++;
      }
    }
    const tipW = { x: tx / tn, y: ty / tn };
    const tipLm = lm[d === 0 ? 4 : DIGITS[d][3]];
    const piece = largestPiece(labels, w, h, part);
    const outline = simplifyPolygon(maskToContour({ width: w, height: h, data: piece }), 0.7).map((p) => ({ x: p.x * k, y: p.y * k }));
    const widths: WidthSample[] = WIDTH_STATIONS.map((f) => {
      const s = f * sMax;
      const { p, t } = pointAt(axis.pts, axis.cum, s);
      const r = widthAcross(labels, mask, w, h, p, { x: -t.y, y: t.x }, part, 0.2 * pw);
      return { at: f, alongPx: s * k, widthPx: r ? r.width * k : null, edges: r ? r.edges : null };
    });
    // Dense scan for the median width, a neck and a bulge (sections with the mask's outline on both sides only).
    const dense: { at: number; width: number }[] = [];
    for (let s = 0.2 * sMax; s <= 0.8 * sMax; s += 1) {
      const { p, t } = pointAt(axis.pts, axis.cum, s);
      const r = widthAcross(labels, mask, w, h, p, { x: -t.y, y: t.x }, part, 0.2 * pw);
      if (r && r.edges[0] === "mask" && r.edges[1] === "mask") dense.push({ at: s / sMax, width: r.width });
    }
    let medianWidth: number | null = null;
    let neck: FingerPart["neck"] = null;
    let bulge: FingerPart["bulge"] = null;
    if (dense.length >= 5) {
      const vals = dense.map((x) => x.width).sort((a, b) => a - b);
      const med = vals[Math.floor(vals.length / 2)];
      medianWidth = med * k;
      let lo = dense[0];
      let hi = dense[0];
      for (const x of dense) {
        if (x.width < lo.width) lo = x;
        if (x.width > hi.width) hi = x;
      }
      neck = { ratio: med > 0 ? lo.width / med : 0, at: lo.at };
      bulge = { ratio: med > 0 ? hi.width / med : 0, at: hi.at };
    }
    let colourBreak: FingerPart["colourBreak"] = null;
    if (chroma && image) {
      colourBreak = { share: 0, at: 0 };
      for (const f of WIDTH_STATIONS) {
        if (f > COLOUR_BREAK_MAX_AT + 1e-9) continue;
        let n = 0;
        let off = 0;
        for (let i = 0; i < ss.length; i++) {
          if (ss[i] < 0 || Math.abs(ss[i] - f * sMax) > 0.05 * sMax) continue;
          const c = pixelChroma(image, i);
          if (!c) continue;
          n++;
          if (Math.abs(c[0] - chroma.r) > chroma.tr || Math.abs(c[1] - chroma.g) > chroma.tg) off++;
        }
        if (n >= 4 && off / n > colourBreak.share) colourBreak = { share: off / n, at: f };
      }
    }
    out.push({
      ...base,
      outline,
      tip: { x: tipW.x * k, y: tipW.y * k },
      tipToLandmarkPw: dist(tipW, tipLm) / pw,
      maskLengthPx: sMax * k,
      lengthRatio: axis.landmarkLength > 0 ? sMax / axis.landmarkLength : 0,
      widths,
      medianWidthPx: medianWidth,
      neck,
      bulge,
      colourBreak,
    });
  }
  return out;
}

/**
 * Width of the run of `part` pixels crossing the line through `c` along `n` (working px). If `c` itself is not in the
 * part, the nearest part pixel along the line within `search` px is used. Steps of 0.25 px.
 */
function widthAcross(labels: Uint8Array, mask: Uint8Array, w: number, h: number, c: Pt, n: Pt, part: number, search: number): { width: number; edges: [EdgeKind, EdgeKind] } | null {
  const STEP = 0.25;
  const at = (o: number): number => {
    const x = Math.floor(c.x + n.x * o);
    const y = Math.floor(c.y + n.y * o);
    if (x < 0 || y < 0 || x >= w || y >= h) return -1;
    return y * w + x;
  };
  let start: number | null = null;
  for (let o = 0; o <= search; o += STEP) {
    const a = at(o);
    if (a >= 0 && labels[a] === part) {
      start = o;
      break;
    }
    const b = at(-o);
    if (b >= 0 && labels[b] === part) {
      start = -o;
      break;
    }
  }
  if (start === null) return null;
  const walk = (dir: 1 | -1): { off: number; edge: EdgeKind } => {
    let o = start as number;
    for (;;) {
      const next = o + dir * STEP;
      const i = at(next);
      if (i < 0) return { off: next, edge: "image" };
      if (labels[i] !== part) return { off: next, edge: mask[i] ? "part" : "mask" };
      o = next;
    }
  };
  const plus = walk(1);
  const minus = walk(-1);
  return { width: Math.max(0, plus.off - minus.off - STEP), edges: [minus.edge, plus.edge] };
}

/** rg chromaticity of a pixel (illumination-invariant), or null when it is too dark to trust. */
function pixelChroma(image: ImageLike, i: number): [number, number] | null {
  const r = image.data[4 * i];
  const g = image.data[4 * i + 1];
  const b = image.data[4 * i + 2];
  const sum = r + g + b;
  return sum < 60 ? null : [r / sum, g / sum];
}

/** The hand's own chromaticity: median over the mask and a tolerance of 3 robust SDs (at least 0.025). */
function handChroma(image: ImageLike, mask: Uint8Array): { r: number; g: number; tr: number; tg: number } | null {
  const rs: number[] = [];
  const gs: number[] = [];
  const step = Math.max(1, Math.floor(mask.length / 60000));
  for (let i = 0; i < mask.length; i += step) {
    if (!mask[i]) continue;
    const c = pixelChroma(image, i);
    if (c) (rs.push(c[0]), gs.push(c[1]));
  }
  if (rs.length < 20) return null;
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const r = med(rs);
  const g = med(gs);
  const tr = Math.max(0.025, 3 * 1.4826 * med(rs.map((v) => Math.abs(v - r))));
  const tg = Math.max(0.025, 3 * 1.4826 * med(gs.map((v) => Math.abs(v - g))));
  return { r, g, tr, tg };
}
