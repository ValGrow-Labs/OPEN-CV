// Square-marker detector for the EXPERIMENTAL printed board (board/spec.ts, board/dictionary.ts).
//
// Pure TypeScript on an RGBA (or grey) image: no DOM, no OpenCV, so it runs in Node tests and in a Web Worker. The
// bundled OpenCV.js has no aruco module and no cornerSubPix (docs/hand3d-research/CONSOLIDATED_FINDINGS.md section 3),
// hence this file.
//
// Pipeline (the usual square-fiducial recipe, cf. Garrido-Jurado et al., "Automatic generation and detection of highly
// reliable fiducial markers under occlusion", Pattern Recognition 2014; Romero-Ramirez et al., "Speeded up detection of
// squared fiducial markers", IVC 2018):
//   1. grey; adaptive threshold against the local mean (integral image): dark = grey < mean - offset;
//   2. connected components of the dark pixels (8-connected, union-find); cheap size filters on the bounding box;
//   3. outer contour (Moore tracing) -> convex hull -> quadrilateral (greedy removal of the least-area hull vertex),
//      checked for "quad-ness" (contour area close to the quad's area, contour close to its sides). NO aspect-ratio
//      limit: a marker seen at 10 degrees elevation is a long thin quad and must survive;
//   4. sub-pixel corners BEFORE decoding (at grazing angles a one-pixel corner error is a third of a cell): on each side,
//      perpendicular intensity profiles; the edge is the peak of the profile's derivative (parabolic interpolation);
//      a robust total-least-squares line per side; corners = intersections of adjacent side lines (in undistorted
//      coordinates when intrinsics are supplied);
//   5. perspective sampling of the 6 x 6 cell grid through the quad's homography (several samples in the middle of
//      each cell), Otsu threshold over the 36 cell means, border check, 4 x 4 code -> identify() -> id and rotation;
//   6. corners reordered to the printed order (TL, TR, BR, BL of the upright page), duplicate ids resolved.
// Every rejected candidate keeps a reason, for diagnostics.
//
// EXPERIMENTAL and unvalidated on real phone images: its accuracy figures (README.md) are SIMULATED.

import type { Intrinsics, Pt } from "../common";
import { distortNormalized, undistortNormalized } from "../geometry/camera";
import { estimateHomography } from "../geometry/pnp";
import { identify, MARKER_CODES } from "./dictionary";
import { downsample2, isGray, sampleBilinear, toGray, type GrayImage, type RgbaImage } from "./image";
import { BOARD, type BoardLayout } from "./spec";

export interface DetectOptions {
  layout?: BoardLayout;
  codes?: readonly number[];
  /** Adaptive-threshold window side in pixels (odd). Default: max(width, height) / 40, at least 15. */
  windowPx?: number;
  /** A pixel is dark when grey < local mean - offset (grey levels). Default 7. */
  thresholdOffset?: number;
  /** The shortest quad side accepted, pixels (at full resolution). Default 8. */
  minSidePx?: number;
  /** Border cells (of 20) allowed to read white. Default 2. */
  maxBorderErrors?: number;
  /** Minimum difference between the white and black cell means, grey levels. Default 12. */
  minCellContrast?: number;
  /** Sub-pixel corner refinement (default true). */
  refine?: boolean;
  /** When known, side lines are fitted in undistorted coordinates (lens distortion bends straight edges). */
  intrinsics?: Intrinsics;
  /** 2: find candidate quads on a half-size image (faster), then refine and decode at full resolution. Default 1. */
  decimate?: 1 | 2;
  /** Cap on the number of rejected candidates kept for diagnostics (default 200). */
  maxRejected?: number;
}

export type Quad = [Pt, Pt, Pt, Pt];

export interface MarkerDetection {
  id: number;
  /** Refined image corners in the PRINTED order: top-left, top-right, bottom-right, bottom-left of the upright page. */
  corners: Quad;
  /** The integer-pixel quad from the contour, same order (before refinement). */
  rawCorners: Quad;
  /** Data bits that disagreed with the dictionary code (corrected by identify()). */
  bitErrors: number;
  /** Border cells (of 20) that read white. */
  borderErrors: number;
  /** Clockwise quarter turns from the read orientation to the printed one. */
  rotation: number;
  /** Mean grey step across the outer marker edge (paper minus ink), from the refinement profiles. */
  edgeContrast: number;
  /** Mean white-cell minus mean black-cell grey value. */
  cellContrast: number;
  /** RMS distance of the accepted edge points to their fitted side lines, pixels (NaN when not refined). */
  edgeFitRmsPx: number;
  refined: boolean;
  areaPx: number;
}

export type CandidateRejectReason =
  | "too_small"
  | "too_large"
  | "touches_image_edge"
  | "not_quad"
  | "low_contrast"
  | "border_bits"
  | "unknown_code"
  | "id_not_on_board"
  | "duplicate_id";

export interface RejectedCandidate {
  reason: CandidateRejectReason;
  /** Bounding box (x0, y0, x1, y1) in full-resolution pixels. */
  bbox: [number, number, number, number];
  corners?: Quad;
  detail?: string;
}

export interface DetectResult {
  width: number;
  height: number;
  markers: MarkerDetection[];
  rejected: RejectedCandidate[];
  /** Counts per rejection reason (all candidates, not only the kept list). */
  rejectedCounts: Partial<Record<CandidateRejectReason, number>>;
  stats: { components: number; quadCandidates: number; windowPx: number };
  timingsMs: { gray: number; threshold: number; components: number; quads: number; refineDecode: number; total: number };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ------------------------------------------------------------------------------------------------ threshold

/** Binary "dark" mask by comparison with the local mean in a w x w window (clipped at the borders). */
export function adaptiveThreshold(g: GrayImage, windowPx: number, offset: number): Uint8Array {
  const { width: W, height: H, data } = g;
  const IW = W + 1;
  const integral = new Float64Array(IW * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    const o = (y + 1) * IW;
    const p = y * IW;
    for (let x = 0; x < W; x++) {
      rowSum += data[y * W + x];
      integral[o + x + 1] = integral[p + x + 1] + rowSum;
    }
  }
  const r = windowPx >> 1;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = y - r < 0 ? 0 : y - r;
    const y1 = y + r + 1 > H ? H : y + r + 1;
    for (let x = 0; x < W; x++) {
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r + 1 > W ? W : x + r + 1;
      const sum = integral[y1 * IW + x1] - integral[y0 * IW + x1] - integral[y1 * IW + x0] + integral[y0 * IW + x0];
      const area = (x1 - x0) * (y1 - y0);
      if (data[y * W + x] * area < sum - offset * area) out[y * W + x] = 1;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ components

interface Component {
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** First pixel in raster order (topmost, then leftmost): a contour start whose west neighbour is background. */
  start: number;
}

/** 8-connected components of the mask (two-pass union-find). Returns per-pixel labels (0 = background) and stats. */
export function connectedComponents(mask: Uint8Array, W: number, H: number): { labels: Int32Array; comps: Component[] } {
  const labels = new Int32Array(W * H);
  const parent: number[] = [0];
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      if (ra < rb) parent[rb] = ra;
      else parent[ra] = rb;
    }
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      // neighbours already visited: W, NW, N, NE
      const w = x > 0 ? labels[i - 1] : 0;
      const nw = x > 0 && y > 0 ? labels[i - W - 1] : 0;
      const n = y > 0 ? labels[i - W] : 0;
      const ne = x < W - 1 && y > 0 ? labels[i - W + 1] : 0;
      let l = w || nw || n || ne;
      if (!l) {
        l = parent.length;
        parent.push(l);
      } else {
        if (w && w !== l) union(l, w);
        if (nw && nw !== l) union(l, nw);
        if (n && n !== l) union(l, n);
        if (ne && ne !== l) union(l, ne);
      }
      labels[i] = l;
    }
  const compact = new Int32Array(parent.length);
  const comps: Component[] = [];
  for (let i = 0; i < W * H; i++) {
    const l = labels[i];
    if (!l) continue;
    const root = find(l);
    let c = compact[root];
    if (!c) {
      comps.push({ area: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1, start: i });
      c = compact[root] = comps.length;
    }
    labels[i] = c;
    const comp = comps[c - 1];
    const x = i % W;
    const y = (i - x) / W;
    comp.area++;
    if (x < comp.x0) comp.x0 = x;
    if (x > comp.x1) comp.x1 = x;
    if (y < comp.y0) comp.y0 = y;
    if (y > comp.y1) comp.y1 = y;
  }
  return { labels, comps };
}

// Clockwise on screen (y down): W, NW, N, NE, E, SE, S, SW.
const DX = [-1, -1, 0, 1, 1, 1, 0, -1];
const DY = [0, -1, -1, -1, 0, 1, 1, 1];

/** Outer boundary of component `label` (Moore-neighbour tracing, Jacob's stopping criterion), as pixel coordinates. */
export function traceContour(labels: Int32Array, W: number, H: number, label: number, start: number, maxSteps: number): Pt[] {
  const sx = start % W;
  const sy = (start - sx) / W;
  const out: Pt[] = [{ x: sx, y: sy }];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && labels[y * W + x] === label;
  let cx = sx, cy = sy;
  let back = 0; // direction from the current pixel to the backtrack (background) pixel: west
  const startBack = back;
  for (let step = 0; step < maxSteps; step++) {
    let found = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      if (inside(cx + DX[d], cy + DY[d])) {
        found = d;
        break;
      }
    }
    if (found < 0) return out; // isolated pixel
    // the backtrack for the new pixel is the neighbour checked just before `found`, seen from the new pixel
    const prev = (found + 7) % 8;
    const bx = cx + DX[prev], by = cy + DY[prev];
    cx += DX[found];
    cy += DY[found];
    // direction from the new pixel to (bx, by)
    const ddx = bx - cx, ddy = by - cy;
    back = 0;
    for (let d = 0; d < 8; d++)
      if (DX[d] === ddx && DY[d] === ddy) {
        back = d;
        break;
      }
    if (cx === sx && cy === sy && back === startBack) break;
    out.push({ x: cx, y: cy });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ quads

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Convex hull (Andrew's monotone chain), counter-clockwise in a y-up sense = clockwise on screen. */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function polygonArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Reduce a convex polygon to a quadrilateral by repeatedly dropping the vertex whose triangle has the least area. */
function hullToQuad(hull: Pt[]): Pt[] | null {
  const h = [...hull];
  if (h.length < 4) return null;
  while (h.length > 4) {
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < h.length; i++) {
      const a = Math.abs(cross(h[(i + h.length - 1) % h.length], h[i], h[(i + 1) % h.length]));
      if (a < bestArea) {
        bestArea = a;
        best = i;
      }
    }
    h.splice(best, 1);
  }
  return h;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const L2 = vx * vx + vy * vy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2)) : 0;
  return Math.hypot(p.x - a.x - t * vx, p.y - a.y - t * vy);
}

/** Order a convex quad clockwise on screen (positive shoelace with y down), starting from the vertex nearest the top-left. */
function clockwise(q: Pt[]): Quad {
  const out = polygonArea(q) < 0 ? [q[0], q[3], q[2], q[1]] : [...q];
  let s = 0;
  for (let i = 1; i < 4; i++) if (out[i].x + out[i].y < out[s].x + out[s].y) s = i;
  return [out[s], out[(s + 1) % 4], out[(s + 2) % 4], out[(s + 3) % 4]];
}

// ------------------------------------------------------------------------------------------------ homography helpers

function applyH(H: readonly number[], x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

const UNIT6: Pt[] = [
  { x: 0, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 6 },
  { x: 0, y: 6 },
];

// ------------------------------------------------------------------------------------------------ refinement

interface Line {
  // n . p = c, |n| = 1
  nx: number;
  ny: number;
  c: number;
}

function fitLine(pts: readonly Pt[], w: readonly number[]): Line | null {
  let sw = 0, mx = 0, my = 0;
  for (let i = 0; i < pts.length; i++) {
    sw += w[i];
    mx += w[i] * pts[i].x;
    my += w[i] * pts[i].y;
  }
  if (!(sw > 0)) return null;
  mx /= sw;
  my /= sw;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - mx, dy = pts[i].y - my;
    sxx += w[i] * dx * dx;
    sxy += w[i] * dx * dy;
    syy += w[i] * dy * dy;
  }
  // normal = eigenvector of the smaller eigenvalue of the scatter matrix
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direction of the larger eigenvalue
  const nx = -Math.sin(theta), ny = Math.cos(theta);
  return { nx, ny, c: nx * mx + ny * my };
}

function intersect(a: Line, b: Line): Pt | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-12) return null;
  return { x: (a.c * b.ny - a.ny * b.c) / det, y: (a.nx * b.c - a.c * b.nx) / det };
}

interface Refinement {
  corners: Quad;
  ok: boolean;
  contrast: number;
  rms: number;
}

/**
 * Sub-pixel refinement of a quad (clockwise on screen) whose outer edge is dark inside, bright outside. For each side:
 * perpendicular profiles at evenly spaced points (away from the corners), the edge at the peak of the outward
 * derivative (parabolic interpolation), a robust line fit; corners at the intersections. The inward reach of each
 * profile is limited to most of one cell (the black border is one cell wide; beyond it may be a white data cell).
 */
function refineQuad(g: GrayImage, quad: Quad, K: Intrinsics | undefined): Refinement {
  const H = estimateHomography(UNIT6, quad);
  if (!H) return { corners: quad, ok: false, contrast: 0, rms: NaN };
  const centre = applyH(H, 3, 3);
  const lines: (Line | null)[] = [];
  let contrastSum = 0, contrastN = 0, resSum = 0, resN = 0;
  const step = 0.25;
  for (let side = 0; side < 4; side++) {
    const a = quad[side];
    const b = quad[(side + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len; // candidate outward normal
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if ((mx - centre.x) * nx + (my - centre.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const nProf = Math.max(3, Math.min(24, Math.round(len / 2.5)));
    const pts: Pt[] = [];
    const wts: number[] = [];
    for (let k = 0; k < nProf; k++) {
      const t = 0.17 + (0.66 * k) / Math.max(1, nProf - 1);
      // the side point and the point one cell inward, in cell coordinates through H
      const cellPt = sideCellPoint(side, t);
      const p = applyH(H, cellPt.x, cellPt.y);
      const q = applyH(H, cellPt.x + cellPt.ix, cellPt.y + cellPt.iy);
      const cellDepth = Math.abs((q.x - p.x) * nx + (q.y - p.y) * ny); // one cell, measured along the normal
      const inner = Math.max(1, Math.min(6, 0.8 * cellDepth));
      const outer = Math.max(2.5, Math.min(6, 1.2 * cellDepth));
      const n = Math.floor((inner + outer) / step) + 1;
      // derivative over +-0.5 px around each sample position
      let bestG = -Infinity, bestS = 0, bestI = -1;
      const gs: number[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const s = -inner + i * step;
        const v1 = sampleBilinear(g, p.x + (s + 0.5) * nx, p.y + (s + 0.5) * ny);
        const v0 = sampleBilinear(g, p.x + (s - 0.5) * nx, p.y + (s - 0.5) * ny);
        gs[i] = v1 - v0;
        if (gs[i] > bestG) {
          bestG = gs[i];
          bestS = s;
          bestI = i;
        }
      }
      if (bestI <= 0 || bestI >= n - 1 || !(bestG > 6)) continue;
      // The edge is the CENTROID of the derivative lobe around the peak (equivalently the point that balances the
      // areas of the step). Unlike the peak position it is exact for a pixel-integrated step read through bilinear
      // interpolation, whose derivative is flat-topped and would snap the peak to half pixels.
      let lo = bestI, hi = bestI;
      const floor = 0.12 * bestG;
      while (lo > 0 && gs[lo - 1] > floor) lo--;
      while (hi < n - 1 && gs[hi + 1] > floor) hi++;
      let sw = 0, sm = 0;
      for (let i = lo; i <= hi; i++) {
        const w = gs[i] - floor;
        sw += w;
        sm += w * (-inner + i * step);
      }
      const sEdge = sw > 0 ? sm / sw : bestS;
      pts.push({ x: p.x + sEdge * nx, y: p.y + sEdge * ny });
      wts.push(bestG);
      const vin = sampleBilinear(g, p.x + (sEdge - inner) * nx, p.y + (sEdge - inner) * ny);
      const vout = sampleBilinear(g, p.x + (sEdge + outer) * nx, p.y + (sEdge + outer) * ny);
      contrastSum += vout - vin;
      contrastN++;
    }
    if (pts.length < 3) {
      lines.push(null);
      continue;
    }
    // robust fit: drop points far from the line (more than max(0.5 px, 3 x median residual)), twice
    let P = pts.map((p) => (K ? undistortPx(K, p) : p));
    let Wt = [...wts];
    let line = fitLine(P, Wt);
    for (let it = 0; it < 2 && line; it++) {
      const L = line;
      const res = P.map((p) => Math.abs(L.nx * p.x + L.ny * p.y - L.c));
      const med = [...res].sort((x, y) => x - y)[res.length >> 1];
      const lim = Math.max(K ? 0.5 / K.fx : 0.5, 3 * med);
      const keep = res.map((r) => r <= lim);
      if (keep.filter(Boolean).length < 3) break;
      P = P.filter((_, i) => keep[i]);
      Wt = Wt.filter((_, i) => keep[i]);
      line = fitLine(P, Wt);
    }
    if (line) {
      const L = line;
      for (const p of P) {
        const r = L.nx * p.x + L.ny * p.y - L.c;
        resSum += (K ? r * K.fx : r) ** 2;
        resN++;
      }
    }
    lines.push(line);
  }
  if (lines.some((l) => !l)) return { corners: quad, ok: false, contrast: contrastN ? contrastSum / contrastN : 0, rms: NaN };
  const out: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const c = intersect(lines[(i + 3) % 4]!, lines[i]!); // corner i joins side i-1 and side i
    if (!c) return { corners: quad, ok: false, contrast: contrastSum / Math.max(1, contrastN), rms: NaN };
    out.push(K ? distortPx(K, c) : c);
  }
  return { corners: out as Quad, ok: true, contrast: contrastSum / Math.max(1, contrastN), rms: Math.sqrt(resSum / Math.max(1, resN)) };
}

/** A point at parameter t along side `side` of the 6 x 6 cell square (corners (0,0), (6,0), (6,6), (0,6)) and the
 *  inward step of one cell. */
function sideCellPoint(side: number, t: number): { x: number; y: number; ix: number; iy: number } {
  switch (side) {
    case 0:
      return { x: 6 * t, y: 0, ix: 0, iy: 1 };
    case 1:
      return { x: 6, y: 6 * t, ix: -1, iy: 0 };
    case 2:
      return { x: 6 - 6 * t, y: 6, ix: 0, iy: -1 };
    default:
      return { x: 0, y: 6 - 6 * t, ix: 1, iy: 0 };
  }
}

function undistortPx(K: Intrinsics, p: Pt): Pt {
  return undistortNormalized((p.x - K.cx) / K.fx, (p.y - K.cy) / K.fy, K.k1, K.k2);
}

function distortPx(K: Intrinsics, n: Pt): Pt {
  const d = distortNormalized(n.x, n.y, K.k1, K.k2);
  return { x: K.fx * d.x + K.cx, y: K.fy * d.y + K.cy };
}

// ------------------------------------------------------------------------------------------------ decoding

function otsu(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  let total = 0;
  for (const v of sorted) total += v;
  let best = -1, thr = (sorted[0] + sorted[n - 1]) / 2, sumLo = 0;
  for (let i = 0; i < n - 1; i++) {
    sumLo += sorted[i];
    const nLo = i + 1, nHi = n - nLo;
    const mLo = sumLo / nLo, mHi = (total - sumLo) / nHi;
    const between = nLo * nHi * (mLo - mHi) ** 2;
    if (between > best) {
      best = between;
      thr = (sorted[i] + sorted[i + 1]) / 2;
    }
  }
  return thr;
}

interface Decoded {
  code: number;
  borderErrors: number;
  cellContrast: number;
}

/** Read the 6 x 6 cell grid of a quad (clockwise on screen, q0 = read top-left). */
function readGrid(g: GrayImage, quad: Quad): Decoded | null {
  const H = estimateHomography(UNIT6, quad);
  if (!H) return null;
  const cells: number[] = new Array(36);
  // samples per cell side: more for big cells
  const side = Math.min(Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y), Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y));
  const m = side / 6 > 12 ? 4 : 3;
  for (let r = 0; r < 6; r++)
    for (let c = 0; c < 6; c++) {
      let acc = 0;
      for (let i = 0; i < m; i++)
        for (let j = 0; j < m; j++) {
          const u = c + 0.3 + (0.4 * (j + 0.5)) / m;
          const v = r + 0.3 + (0.4 * (i + 0.5)) / m;
          const p = applyH(H, u, v);
          acc += sampleBilinear(g, p.x, p.y);
        }
      cells[r * 6 + c] = acc / (m * m);
    }
  const thr = otsu(cells);
  let lo = 0, nlo = 0, hi = 0, nhi = 0;
  for (const v of cells)
    if (v < thr) {
      lo += v;
      nlo++;
    } else {
      hi += v;
      nhi++;
    }
  const cellContrast = nlo && nhi ? hi / nhi - lo / nlo : 0;
  let borderErrors = 0;
  for (let r = 0; r < 6; r++)
    for (let c = 0; c < 6; c++) if ((r === 0 || c === 0 || r === 5 || c === 5) && cells[r * 6 + c] >= thr) borderErrors++;
  let code = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (cells[(r + 1) * 6 + (c + 1)] >= thr) code |= 1 << (15 - (r * 4 + c));
  return { code, borderErrors, cellContrast };
}

// ------------------------------------------------------------------------------------------------ main

/** Detect the board's markers in an image. */
export function detectMarkers(img: RgbaImage | GrayImage, opts: DetectOptions = {}): DetectResult {
  const t0 = now();
  const layout = opts.layout ?? BOARD;
  const codes = opts.codes ?? MARKER_CODES;
  const full = isGray(img) ? img : toGray(img);
  const tGray = now();
  const dec = opts.decimate === 2 ? 2 : 1;
  const work = dec === 2 ? downsample2(full) : full;
  const W = work.width, H = work.height;
  const windowPx = (opts.windowPx ? Math.round(opts.windowPx / dec) : Math.max(15, Math.round(Math.max(W, H) / 40))) | 1;
  const mask = adaptiveThreshold(work, windowPx, opts.thresholdOffset ?? 7);
  const tThr = now();
  const { labels, comps } = connectedComponents(mask, W, H);
  const tComp = now();

  const minSide = (opts.minSidePx ?? 8) / dec;
  const maxRejected = opts.maxRejected ?? 200;
  const rejected: RejectedCandidate[] = [];
  const rejectedCounts: Partial<Record<CandidateRejectReason, number>> = {};
  const toFull = (p: Pt): Pt => (dec === 2 ? { x: 2 * p.x + 0.5, y: 2 * p.y + 0.5 } : p);
  const reject = (reason: CandidateRejectReason, c: { x0: number; y0: number; x1: number; y1: number }, corners?: Quad, detail?: string) => {
    rejectedCounts[reason] = (rejectedCounts[reason] ?? 0) + 1;
    if (rejected.length < maxRejected)
      rejected.push({ reason, bbox: [c.x0 * dec, c.y0 * dec, c.x1 * dec + dec - 1, c.y1 * dec + dec - 1], corners, detail });
  };

  const quads: { quad: Quad; comp: Component }[] = [];
  for (let li = 0; li < comps.length; li++) {
    const c = comps[li];
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    // cheap filters first; tiny specks are not even reported
    if (Math.max(bw, bh) < minSide || c.area < 12 / (dec * dec)) continue;
    if (bw * bh > 0.5 * W * H) {
      reject("too_large", c);
      continue;
    }
    if (c.x0 <= 0 || c.y0 <= 0 || c.x1 >= W - 1 || c.y1 >= H - 1) {
      reject("touches_image_edge", c);
      continue;
    }
    if (Math.min(bw, bh) < 0.5 * minSide) {
      reject("too_small", c);
      continue;
    }
    const contour = traceContour(labels, W, H, li + 1, c.start, 8 * (bw + bh) + 64);
    if (contour.length < 8) {
      reject("too_small", c);
      continue;
    }
    const hull = convexHull(contour);
    const q = hullToQuad(hull);
    if (!q) {
      reject("not_quad", c);
      continue;
    }
    const quad = clockwise(q);
    const sides = [0, 1, 2, 3].map((i) => Math.hypot(quad[(i + 1) % 4].x - quad[i].x, quad[(i + 1) % 4].y - quad[i].y));
    if (Math.min(...sides) < minSide) {
      reject("too_small", c, quad.map(toFull) as Quad, `shortest side ${(Math.min(...sides) * dec).toFixed(1)} px`);
      continue;
    }
    const qa = polygonArea(quad);
    const ca = Math.abs(polygonArea(contour));
    // quad-ness: the contour fills its quad, and no contour point strays far outside it
    let maxDev = 0;
    for (const p of hull) {
      let d = Infinity;
      for (let i = 0; i < 4; i++) d = Math.min(d, distToSegment(p, quad[i], quad[(i + 1) % 4]));
      maxDev = Math.max(maxDev, d);
    }
    // Thresholding rounds corners; on a long thin quad (a marker at grazing elevation) the rounding of its acute
    // corners scales with its thickness and its length, so the tolerance does too.
    const tol = Math.max(2, 0.04 * Math.max(...sides), 0.3 * Math.min(...sides));
    if (!(qa > 0) || ca / qa < 0.82 || ca / qa > 1.15 || maxDev > tol) {
      reject("not_quad", c, quad.map(toFull) as Quad, `fill ${(ca / qa).toFixed(2)}, deviation ${maxDev.toFixed(1)} px`);
      continue;
    }
    quads.push({ quad: quad.map(toFull) as Quad, comp: c });
  }
  const tQuads = now();

  const found: MarkerDetection[] = [];
  const rejectedFull = (reason: CandidateRejectReason, comp: Component, quad: Quad, detail?: string) => reject(reason, comp, quad, detail);
  for (const { quad, comp } of quads) {
    let corners = quad;
    let ref: Refinement = { corners: quad, ok: false, contrast: 0, rms: NaN };
    if (opts.refine !== false) {
      for (let it = 0; it < 2; it++) {
        const r = refineQuad(full, corners, opts.intrinsics);
        if (!r.ok) break;
        // a refinement that moves a corner implausibly far is ignored
        const minSideNow = Math.min(...[0, 1, 2, 3].map((i) => Math.hypot(corners[(i + 1) % 4].x - corners[i].x, corners[(i + 1) % 4].y - corners[i].y)));
        const maxSideNow = Math.max(...[0, 1, 2, 3].map((i) => Math.hypot(corners[(i + 1) % 4].x - corners[i].x, corners[(i + 1) % 4].y - corners[i].y)));
        const lim = Math.max(3, 0.35 * minSideNow, 0.08 * maxSideNow);
        if (r.corners.some((p, i) => Math.hypot(p.x - quad[i].x, p.y - quad[i].y) > lim)) break;
        ref = r;
        corners = r.corners;
      }
    }
    const d = readGrid(full, corners);
    if (!d || d.cellContrast < (opts.minCellContrast ?? 12)) {
      rejectedFull("low_contrast", comp, corners, d ? `cell contrast ${d.cellContrast.toFixed(1)}` : "degenerate quad");
      continue;
    }
    if (d.borderErrors > (opts.maxBorderErrors ?? 2)) {
      rejectedFull("border_bits", comp, corners, `${d.borderErrors} border cells read white`);
      continue;
    }
    const idf = identify(d.code, codes);
    if (!idf) {
      rejectedFull("unknown_code", comp, corners, `read 0x${d.code.toString(16)}`);
      continue;
    }
    if (!layout.markers.some((m) => m.id === idf.id)) {
      rejectedFull("id_not_on_board", comp, corners, `id ${idf.id}`);
      continue;
    }
    // printed corner i is read corner (i - rotation) mod 4 (rotating the read grid clockwise k times gives the print)
    const k = idf.rotation;
    const reorder = (q: Quad): Quad => [q[(4 - k) % 4], q[(5 - k) % 4], q[(6 - k) % 4], q[(7 - k) % 4]];
    found.push({
      id: idf.id,
      corners: reorder(corners),
      rawCorners: reorder(quad),
      bitErrors: idf.errors,
      borderErrors: d.borderErrors,
      rotation: k,
      edgeContrast: ref.contrast,
      cellContrast: d.cellContrast,
      edgeFitRmsPx: ref.rms,
      refined: ref.ok,
      areaPx: polygonArea(corners),
    });
  }
  // duplicate ids: keep the most trustworthy reading
  found.sort((a, b) => a.bitErrors - b.bitErrors || a.borderErrors - b.borderErrors || b.cellContrast * Math.sqrt(b.areaPx) - a.cellContrast * Math.sqrt(a.areaPx));
  const markers: MarkerDetection[] = [];
  for (const m of found) {
    if (markers.some((k) => k.id === m.id)) {
      const xs = m.corners.map((p) => p.x), ys = m.corners.map((p) => p.y);
      reject("duplicate_id", { x0: Math.min(...xs) / dec, y0: Math.min(...ys) / dec, x1: Math.max(...xs) / dec, y1: Math.max(...ys) / dec }, m.corners, `id ${m.id}`);
      continue;
    }
    markers.push(m);
  }
  markers.sort((a, b) => a.id - b.id);
  const tEnd = now();
  return {
    width: full.width,
    height: full.height,
    markers,
    rejected,
    rejectedCounts,
    stats: { components: comps.length, quadCandidates: quads.length, windowPx: windowPx * dec },
    timingsMs: { gray: tGray - t0, threshold: tThr - tGray, components: tComp - tThr, quads: tQuads - tComp, refineDecode: tEnd - tQuads, total: tEnd - t0 },
  };
}
