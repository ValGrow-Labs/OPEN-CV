// Pure helpers shared by the segmentation backends and by the evaluation: mask overlap (IoU, Dice), outer contour
// extraction, polygon area, and boundary distance between two masks. No OpenCV, no DOM.
//
// These measure how well two masks agree. With a ground-truth mask that is segmentation accuracy; without one they
// say nothing about accuracy (the evaluation labels which of the two it is).
import type { BinaryMask, Pt } from "../common";
import { polygonArea } from "./geometry";
import { distanceTo } from "./morph";

function sameSize(a: BinaryMask, b: BinaryMask): void {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`mask sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
}

/** Number of hand pixels. */
export function maskArea(m: BinaryMask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) if (m.data[i]) n++;
  return n;
}

/** Intersection over union of two masks of the same size (1 when both are empty). */
export function iou(a: BinaryMask, b: BinaryMask): number {
  sameSize(a, b);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i] !== 0;
    const y = b.data[i] !== 0;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union === 0 ? 1 : inter / union;
}

/** Dice coefficient of two masks of the same size (1 when both are empty). */
export function dice(a: BinaryMask, b: BinaryMask): number {
  sameSize(a, b);
  let inter = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i] !== 0;
    const y = b.data[i] !== 0;
    if (x && y) inter++;
    if (x) sa++;
    if (y) sb++;
  }
  return sa + sb === 0 ? 1 : (2 * inter) / (sa + sb);
}

/** Shoelace area of a contour (pixels squared). */
export function contourArea(contour: readonly Pt[]): number {
  return polygonArea(contour);
}

/**
 * The outer boundary of the first (top-left-most) 4-connected component of the mask, as a closed polygon of pixel
 * corners (crack following), so that `contourArea` equals the component's pixel count exactly. Holes are ignored.
 * Vertices are only kept where the boundary turns.
 */
export function maskToContour(m: BinaryMask): Pt[] {
  const { width: w, height: h, data } = m;
  const fg = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] !== 0;
  let start = -1;
  for (let i = 0; i < data.length; i++) {
    if (data[i]) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const sx = start % w;
  const sy = (start - sx) / w;
  // Directions: 0 right, 1 down, 2 left, 3 up. The hand stays on the right-hand side of travel.
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  let cx = sx;
  let cy = sy;
  let d = 0;
  const pts: Pt[] = [];
  const maxSteps = 4 * (w + 1) * (h + 1) + 8;
  let steps = 0;
  // The start corner is touched by exactly one hand pixel (it is the top-left corner of the first one in raster
  // order), so the walk passes it once: it ends when it comes back.
  while (steps === 0 || !(cx === sx && cy === sy)) {
    // The two pixels ahead of the corner, relative to the direction of travel.
    let fl: boolean;
    let fr: boolean;
    if (d === 0) {
      fl = fg(cx, cy - 1);
      fr = fg(cx, cy);
    } else if (d === 1) {
      fl = fg(cx, cy);
      fr = fg(cx - 1, cy);
    } else if (d === 2) {
      fl = fg(cx - 1, cy);
      fr = fg(cx - 1, cy - 1);
    } else {
      fl = fg(cx - 1, cy - 1);
      fr = fg(cx, cy - 1);
    }
    let nd = d;
    if (!fr) nd = (d + 1) % 4; // turn right
    else if (fl) nd = (d + 3) % 4; // turn left
    if (nd !== d || pts.length === 0) pts.push({ x: cx, y: cy });
    d = nd;
    cx += DX[d];
    cy += DY[d];
    if (++steps > maxSteps) break;
  }
  return pts;
}

/** Douglas-Peucker simplification of a closed polygon (`epsilon` in the polygon's units). */
export function simplifyPolygon(poly: readonly Pt[], epsilon: number): Pt[] {
  const n = poly.length;
  if (n <= 4 || epsilon <= 0) return [...poly];
  // Split the ring at its two mutually farthest vertices (sampled), then simplify both halves as open paths.
  let a = 0;
  let b = Math.floor(n / 2);
  let far = 0;
  const step = Math.max(1, Math.floor(n / 64));
  for (let i = 0; i < n; i += step) {
    for (let j = i + 1; j < n; j += step) {
      const dd = (poly[i].x - poly[j].x) ** 2 + (poly[i].y - poly[j].y) ** 2;
      if (dd > far) ((far = dd), (a = i), (b = j));
    }
  }
  if (a > b) [a, b] = [b, a];
  const first = poly.slice(a, b + 1);
  const second = [...poly.slice(b), ...poly.slice(0, a + 1)];
  const dp = (path: readonly Pt[]): Pt[] => {
    if (path.length < 3) return [...path];
    const p = path[0];
    const q = path[path.length - 1];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    let maxD = -1;
    let idx = -1;
    for (let i = 1; i < path.length - 1; i++) {
      const r = path[i];
      const dd = len === 0 ? Math.hypot(r.x - p.x, r.y - p.y) : Math.abs(dy * (r.x - p.x) - dx * (r.y - p.y)) / len;
      if (dd > maxD) ((maxD = dd), (idx = i));
    }
    if (maxD <= epsilon) return [p, q];
    const left = dp(path.slice(0, idx + 1));
    const right = dp(path.slice(idx));
    return [...left.slice(0, -1), ...right];
  };
  const s1 = dp(first);
  const s2 = dp(second);
  return [...s1.slice(0, -1), ...s2.slice(0, -1)];
}

/** Rasterise a closed polygon into a mask (sampled at pixel centres). */
export function polygonToMask(poly: readonly Pt[], width: number, height: number): BinaryMask {
  const data = new Uint8Array(width * height);
  // Local scanline fill (kept here so metrics.ts has no dependency on the drawing helpers).
  if (poly.length >= 3) {
    const xs: number[] = [];
    for (let y = 0; y < height; y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const p = poly[i];
        const q = poly[j];
        if (p.y > yc !== q.y > yc) xs.push(p.x + ((yc - p.y) * (q.x - p.x)) / (q.y - p.y));
      }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
        const xb = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = xa; x <= xb; x++) data[y * width + x] = 255;
      }
    }
  }
  return { width, height, data };
}

/** Pixels of the mask that touch the background (4-neighbourhood; the image border counts as background). */
export function boundaryPixels(m: BinaryMask): Uint8Array {
  const { width: w, height: h, data } = m;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !data[y * w + x - 1] || !data[y * w + x + 1] || !data[(y - 1) * w + x] || !data[(y + 1) * w + x]) {
        out[y * w + x] = 255;
      }
    }
  }
  return out;
}

export interface BoundaryDistance {
  /** Mean over both directions of the distance from a boundary pixel of one mask to the other's boundary (pixels). */
  meanPx: number;
  /** 95th percentile of all those distances (pixels). */
  p95Px: number;
  /** Largest distance (symmetric Hausdorff, pixels). */
  maxPx: number;
}

/** Symmetric boundary distance between two masks of the same size, in pixels. Infinity when one mask is empty. */
export function boundaryDistance(a: BinaryMask, b: BinaryMask): BoundaryDistance {
  sameSize(a, b);
  const ba = boundaryPixels(a);
  const bb = boundaryPixels(b);
  let na = 0;
  let nb = 0;
  for (let i = 0; i < ba.length; i++) {
    if (ba[i]) na++;
    if (bb[i]) nb++;
  }
  if (na === 0 || nb === 0) return { meanPx: na === nb ? 0 : Infinity, p95Px: na === nb ? 0 : Infinity, maxPx: na === nb ? 0 : Infinity };
  const toB = distanceTo(bb, a.width, a.height, 255);
  const toA = distanceTo(ba, a.width, a.height, 255);
  const ds: number[] = [];
  for (let i = 0; i < ba.length; i++) {
    if (ba[i]) ds.push(toB[i]);
    if (bb[i]) ds.push(toA[i]);
  }
  ds.sort((p, q) => p - q);
  const mean = ds.reduce((s, v) => s + v, 0) / ds.length;
  return { meanPx: mean, p95Px: ds[Math.min(ds.length - 1, Math.floor(0.95 * ds.length))], maxPx: ds[ds.length - 1] };
}

/** Resample a mask to another size with nearest-neighbour sampling (for comparing masks made at different scales). */
export function resizeMaskNearest(m: BinaryMask, width: number, height: number): BinaryMask {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(m.height - 1, Math.floor(((y + 0.5) * m.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(m.width - 1, Math.floor(((x + 0.5) * m.width) / width));
      data[y * width + x] = m.data[sy * m.width + sx];
    }
  }
  return { width, height, data };
}
