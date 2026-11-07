// Hand topology and small pure geometry helpers for the experimental segmentation (no OpenCV, no DOM).
import type { Pt } from "../common";

/** MediaPipe hand landmark indices per digit, base to tip. */
export const THUMB = [1, 2, 3, 4] as const;
export const INDEX = [5, 6, 7, 8] as const;
export const MIDDLE = [9, 10, 11, 12] as const;
export const RING = [13, 14, 15, 16] as const;
export const PINKY = [17, 18, 19, 20] as const;
export const DIGITS = [THUMB, INDEX, MIDDLE, RING, PINKY] as const;
export const DIGIT_NAMES = ["thumb", "index", "middle", "ring", "pinky"] as const;
export const TIPS = [4, 8, 12, 16, 20] as const;
export const WRIST = 0;
export const PALM_POLYGON = [0, 1, 2, 5, 9, 13, 17] as const;

/** The 21 bones MediaPipe draws. */
export const BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
]; // fmt: skip

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });

/** The size unit of a hand in an image: the distance between the index and little knuckle centres, in pixels. */
export function palmWidth(lm: readonly Pt[]): number {
  return dist(lm[5], lm[17]);
}

export function scaleLandmarks(lm: readonly Pt[], k: number): Pt[] {
  return lm.map((p) => ({ x: p.x * k, y: p.y * k }));
}

/** Shoelace area of a polygon (always positive). */
export function polygonArea(poly: readonly Pt[]): number {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Convex hull (Andrew's monotone chain), counter-clockwise in a y-up sense (orientation is irrelevant to callers). */
export function convexHull(points: readonly Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function pointInPolygon(x: number, y: number, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Fill a polygon into a mask (even-odd, sampled at pixel centres). */
export function fillPolygon(data: Uint8Array, w: number, h: number, poly: readonly Pt[], value = 255): void {
  if (poly.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > yc !== b.y > yc) xs.push(a.x + ((yc - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) data[y * w + x] = value;
    }
  }
}

/** Stamp a thick line (round caps) into a mask. */
export function drawThickLine(data: Uint8Array, w: number, h: number, a: Pt, b: Pt, radius: number, value = 255): void {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - r - 1));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x) + r + 1));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - r - 1));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y) + r + 1));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - a.x;
      const py = y + 0.5 - a.y;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
      const ex = px - t * dx;
      const ey = py - t * dy;
      if (ex * ex + ey * ey <= r * r) data[y * w + x] = value;
    }
  }
}

export function fillDisc(data: Uint8Array, w: number, h: number, c: Pt, radius: number, value = 255): void {
  drawThickLine(data, w, h, c, c, radius, value);
}

/** Bilinear sample of a single-channel float image (clamped at the borders). */
export function sampleBilinear(img: Float32Array, w: number, h: number, x: number, y: number): number {
  const xf = Math.min(w - 1, Math.max(0, x - 0.5));
  const yf = Math.min(h - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(xf);
  const y0 = Math.floor(yf);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = xf - x0;
  const fy = yf - y0;
  const top = img[y0 * w + x0] * (1 - fx) + img[y0 * w + x1] * fx;
  const bot = img[y1 * w + x0] * (1 - fx) + img[y1 * w + x1] * fx;
  return top * (1 - fy) + bot * fy;
}
