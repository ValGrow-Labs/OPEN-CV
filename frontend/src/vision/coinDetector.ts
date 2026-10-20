// Browser port of backend/glovesize/coin_detection.py (the reference implementation).
// Keep the two in step: same parameters (config/measurement.json), same steps, same
// ordering. Parity is checked by coinDetector.parity.test.ts against Python fixtures.
import type { CoinDetectionParams, CoinObservation } from "../api/types";
import type { CV } from "./opencv";

export const CHROMA_GAIN = 3.0;

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array; // RGBA, row-major
  width: number;
  height: number;
}

export interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Candidate {
  cx: number;
  cy: number;
  major: number;
  minor: number;
  angleDeg: number;
  method: string;
}

export interface CandidateSummary {
  method: string;
  diameter_px: number;
  axis_ratio: number;
  confidence: number;
  accepted: boolean;
}

export interface CoinDetection extends CoinObservation {
  found: boolean;
  candidates: CandidateSummary[];
}

function emptyDetection(reasons: string[]): CoinDetection {
  return {
    found: false,
    accepted: false,
    center_x: 0,
    center_y: 0,
    major_axis_px: 0,
    minor_axis_px: 0,
    angle_deg: 0,
    edge_support: 0,
    max_angular_gap_deg: 360,
    fit_residual_px: Infinity,
    edge_width_px: Infinity,
    glare_fraction: 0,
    contrast: 0,
    n_edge_points: 0,
    confidence: 0,
    method: "",
    reasons,
    candidates: [],
  };
}

/** Numeric observation as sent to /api/scan (JSON cannot carry Infinity). */
export function toObservation(d: CoinDetection): CoinObservation {
  const { found: _found, candidates: _c, ...obs } = d;
  return {
    ...obs,
    fit_residual_px: Math.min(obs.fit_residual_px, 1e3),
    edge_width_px: Math.min(obs.edge_width_px, 1e3),
  };
}

// ----------------------------------------------------------------------------
// Numeric helpers (mirror numpy semantics)
// ----------------------------------------------------------------------------

export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return NaN;
  const s = Float64Array.from(values).sort();
  const mid = n >> 1;
  return n % 2 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

const mod180 = (a: number) => ((a % 180) + 180) % 180;

export function ramp(value: number, good: number, bad: number): number {
  if (good === bad) return value === good ? 1 : 0;
  const t = (value - bad) / (good - bad);
  return Math.min(1, Math.max(0, t));
}

export function ellipseRadius(phi: number, major: number, minor: number, angleDeg: number): number {
  const a = major / 2;
  const b = minor / 2;
  const t = phi - (angleDeg * Math.PI) / 180;
  return (a * b) / Math.sqrt((b * Math.cos(t)) ** 2 + (a * Math.sin(t)) ** 2);
}

function bilinear(img: Float64Array, w: number, h: number, xs: number, ys: number): [number, boolean] {
  const valid = xs >= 0 && ys >= 0 && xs <= w - 1 && ys <= h - 1;
  const x = Math.min(Math.max(xs, 0), w - 1.000001);
  const y = Math.min(Math.max(ys, 0), h - 1.000001);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const v00 = img[i];
  const v01 = img[i + 1];
  const v10 = img[i + w];
  const v11 = img[i + w + 1];
  return [(v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy, valid];
}

// ----------------------------------------------------------------------------
// Image channels
// ----------------------------------------------------------------------------

/** Signed normalised warm chroma (R - B) / (R + G + B) around 128, see chroma_channel() in Python. */
export function chromaChannel(rgba: Uint8Array | Uint8ClampedArray, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = rgba[j];
    const g = rgba[j + 1];
    const b = rgba[j + 2];
    // float32 arithmetic, as in the NumPy reference
    const ratio = Math.fround(Math.fround(r - b) / Math.fround(r + g + b + 30));
    const c = Math.fround(Math.fround(Math.fround(ratio * CHROMA_GAIN) * 127.5) + 128);
    out[i] = c <= 0 ? 0 : c >= 255 ? 255 : Math.trunc(c);
  }
  return out;
}

function cropRgba(img: RgbaImage, roi: Roi): Uint8Array {
  const out = new Uint8Array(roi.w * roi.h * 4);
  for (let y = 0; y < roi.h; y++) {
    const src = ((roi.y + y) * img.width + roi.x) * 4;
    out.set(img.data.subarray(src, src + roi.w * 4), y * roi.w * 4);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Candidate generation
// ----------------------------------------------------------------------------

function fitEllipse(cv: CV, points: Float32Array | null, mat?: InstanceType<CV["Mat"]>): Candidate | null {
  let m = mat;
  let owned = false;
  if (!m) {
    if (!points || points.length / 2 < 6) return null;
    m = cv.matFromArray(points.length / 2, 1, cv.CV_32FC2, Array.from(points));
    owned = true;
  } else if (m.rows < 6) {
    return null;
  }
  try {
    const r = cv.fitEllipse(m);
    const w = r.size.width;
    const h = r.size.height;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    if (w >= h) return { cx: r.center.x, cy: r.center.y, major: w, minor: h, angleDeg: mod180(r.angle), method: "" };
    return { cx: r.center.x, cy: r.center.y, major: h, minor: w, angleDeg: mod180(r.angle + 90), method: "" };
  } finally {
    if (owned) m.delete();
  }
}

function shapeFilter(
  cv: CV,
  contour: InstanceType<CV["Mat"]>,
  p: CoinDetectionParams,
  dMin: number,
  dMax: number,
): { hull: InstanceType<CV["Mat"]>; ok: boolean } {
  const hull = new cv.Mat();
  cv.convexHull(contour, hull, false, true);
  const area = cv.contourArea(hull);
  const perim = cv.arcLength(hull, true);
  if (area <= 0 || perim <= 0) return { hull, ok: false };
  const eqD = 2 * Math.sqrt(area / Math.PI);
  if (eqD < dMin || eqD > dMax) return { hull, ok: false };
  if ((4 * Math.PI * area) / perim ** 2 < p.min_contour_circularity) return { hull, ok: false };
  return { hull, ok: true };
}

function contourCandidates(cv: CV, blurred: InstanceType<CV["Mat"]>, p: CoinDetectionParams, dMin: number, dMax: number): Candidate[] {
  const edges = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const out: Candidate[] = [];
  try {
    cv.Canny(blurred, edges, p.canny_high * p.canny_low_ratio, p.canny_high);
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      try {
        if (c.rows < 0.5 * Math.PI * dMin) continue;
        const { hull, ok } = shapeFilter(cv, c, p, dMin, dMax);
        hull.delete();
        if (!ok) continue;
        const cand = fitEllipse(cv, null, c);
        if (!cand || cand.minor / cand.major < p.min_axis_ratio) continue;
        if (!(dMin <= cand.major && cand.major <= dMax)) continue;
        cand.method = "contour";
        out.push(cand);
      } finally {
        c.delete();
      }
    }
  } finally {
    edges.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
  return out;
}

function houghCandidates(cv: CV, blurred: InstanceType<CV["Mat"]>, p: CoinDetectionParams, dMin: number, dMax: number): Candidate[] {
  const circles = new cv.Mat();
  const out: Candidate[] = [];
  try {
    cv.HoughCircles(
      blurred,
      circles,
      cv.HOUGH_GRADIENT,
      p.hough_dp,
      Math.max(dMin, 1),
      p.canny_high,
      p.hough_param2,
      Math.max(1, Math.floor(dMin / 2)),
      Math.ceil(dMax / 2),
    );
    const d = circles.data32F;
    for (let i = 0; i + 2 < d.length; i += 3) {
      out.push({ cx: d[i], cy: d[i + 1], major: 2 * d[i + 2], minor: 2 * d[i + 2], angleDeg: 0, method: "hough" });
    }
  } finally {
    circles.delete();
  }
  return out;
}

function segmentationCandidates(cv: CV, chroma: InstanceType<CV["Mat"]>, p: CoinDetectionParams, dMin: number, dMax: number): Candidate[] {
  const blurred = new cv.Mat();
  const mask = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const out: Candidate[] = [];
  try {
    cv.GaussianBlur(chroma, blurred, new cv.Size(p.blur_kernel, p.blur_kernel), 0);
    cv.threshold(blurred, mask, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      try {
        if (c.rows < 0.5 * Math.PI * dMin) continue;
        const { hull, ok } = shapeFilter(cv, c, p, dMin, dMax);
        try {
          if (!ok) continue;
          const cand = fitEllipse(cv, null, hull);
          if (!cand || cand.minor / cand.major < p.min_axis_ratio) continue;
          cand.method = "segmentation";
          out.push(cand);
        } finally {
          hull.delete();
        }
      } finally {
        c.delete();
      }
    }
  } finally {
    blurred.delete();
    mask.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
  return out;
}

function dedupe(cands: Candidate[]): Candidate[] {
  const kept: Candidate[] = [];
  for (const c of cands) {
    let dup = false;
    for (const k of kept) {
      const r = Math.max(k.major, c.major) / 2;
      if (Math.hypot(k.cx - c.cx, k.cy - c.cy) < 0.2 * r && Math.abs(k.major - c.major) < 0.15 * k.major) {
        if (!k.method.includes(c.method)) k.method = `${k.method}+${c.method}`;
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(c);
  }
  return kept;
}

// ----------------------------------------------------------------------------
// Radial refinement
// ----------------------------------------------------------------------------

interface EdgeScan {
  points: Float32Array; // x,y pairs
  angles: number[];
  strengths: number[];
}

interface Channel {
  data: Float64Array;
  w: number;
  h: number;
}

function radialScan(img: Channel, cand: Candidate, p: CoinDetectionParams, searchFraction: number, polarity: number | null): EdgeScan {
  const k = p.radial_rays;
  const step = p.radial_step_px;
  const rExp = new Float64Array(k);
  const phis = new Float64Array(k);
  let rMax = 0;
  for (let i = 0; i < k; i++) {
    phis[i] = i * ((2 * Math.PI) / k);
    rExp[i] = ellipseRadius(phis[i], cand.major, cand.minor, cand.angleDeg);
    rMax = Math.max(rMax, rExp[i]);
  }
  const nSteps = Math.max(5, Math.ceil((2 * searchFraction * rMax) / step) + 1);
  const t = new Float64Array(nSteps);
  for (let j = 0; j < nSteps; j++) t[j] = nSteps === 1 ? -1 : -1 + (2 * j) / (nSteps - 1);
  const D = nSteps - 2;

  const strength = new Float64Array(k);
  const sign = new Float64Array(k);
  const idxArr = new Int32Array(k);
  const rEdge = new Float64Array(k);
  const rayOk = new Uint8Array(k);
  const radii = new Float64Array(nSteps);
  const vals = new Float64Array(nSteps);
  const deriv = new Float64Array(D);
  const absd = new Float64Array(D);

  for (let i = 0; i < k; i++) {
    const cos = Math.cos(phis[i]);
    const sin = Math.sin(phis[i]);
    let ok = true;
    for (let j = 0; j < nSteps; j++) {
      radii[j] = rExp[i] * (1 + searchFraction * t[j]);
      const [v, valid] = bilinear(img.data, img.w, img.h, cand.cx + radii[j] * cos, cand.cy + radii[j] * sin);
      vals[j] = v;
      ok &&= valid;
    }
    rayOk[i] = ok ? 1 : 0;
    let best = 0;
    for (let j = 0; j < D; j++) {
      deriv[j] = (vals[j + 2] - vals[j]) / (radii[j + 2] - radii[j]);
      absd[j] = polarity === null ? Math.abs(deriv[j]) : Math.max(deriv[j] * polarity, 0);
      if (absd[j] > absd[best]) best = j;
    }
    idxArr[i] = best;
    strength[i] = absd[best];
    sign[i] = Math.sign(deriv[best]);
    const ic = Math.min(Math.max(best, 1), D - 2);
    const a = absd[ic - 1];
    const b = absd[ic];
    const c = absd[ic + 1];
    const denom = a - 2 * b + c;
    let delta = Math.abs(denom) > 1e-9 ? (0.5 * (a - c)) / denom : 0;
    delta = best >= 1 && best <= D - 2 ? Math.min(Math.max(delta, -0.5), 0.5) : 0;
    rEdge[i] = radii[best + 1] + delta * (radii[1] - radii[0]);
  }

  const inBounds: number[] = [];
  for (let i = 0; i < k; i++) if (rayOk[i]) inBounds.push(strength[i]);
  let thresh = p.edge_strength_min;
  if (inBounds.length) thresh = Math.max(thresh, p.edge_strength_rel * median(inBounds));

  const okRay = new Uint8Array(k);
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < k; i++) {
    okRay[i] = rayOk[i] && strength[i] >= thresh && idxArr[i] > 0 && idxArr[i] < D - 1 ? 1 : 0;
    if (okRay[i]) {
      if (sign[i] > 0) pos++;
      else if (sign[i] < 0) neg++;
    }
  }
  let pol = polarity;
  if (pol === null && (pos > 0 || neg > 0)) pol = pos >= neg ? 1 : -1;

  const pts: number[] = [];
  const angles: number[] = [];
  const strengths: number[] = [];
  for (let i = 0; i < k; i++) {
    if (!okRay[i] || (pol !== null && sign[i] !== pol)) continue;
    pts.push(cand.cx + rEdge[i] * Math.cos(phis[i]), cand.cy + rEdge[i] * Math.sin(phis[i]));
    angles.push(phis[i]);
    strengths.push(strength[i]);
  }
  return { points: Float32Array.from(pts), angles, strengths };
}

function residuals(points: Float32Array, e: Candidate): Float64Array {
  const n = points.length / 2;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = points[2 * i] - e.cx;
    const dy = points[2 * i + 1] - e.cy;
    out[i] = Math.abs(Math.hypot(dx, dy) - ellipseRadius(Math.atan2(dy, dx), e.major, e.minor, e.angleDeg));
  }
  return out;
}

function select(points: Float32Array, mask: Uint8Array): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(points[2 * i], points[2 * i + 1]);
  return Float32Array.from(out);
}

function robustFit(cv: CV, scan: EdgeScan, kMad: number): [Candidate | null, Uint8Array] {
  const n = scan.points.length / 2;
  let mask = new Uint8Array(n).fill(1);
  for (let iter = 0; iter < 3; iter++) {
    const fit = fitEllipse(cv, select(scan.points, mask));
    if (!fit) return [null, mask];
    const res = residuals(scan.points, fit);
    const inMask: number[] = [];
    for (let i = 0; i < n; i++) if (mask[i]) inMask.push(res[i]);
    const med = median(inMask);
    const mad = median(inMask.map((r) => Math.abs(r - med)));
    const limit = Math.max(kMad * 1.4826 * mad + med, 0.5);
    const next = new Uint8Array(n);
    let count = 0;
    let same = true;
    for (let i = 0; i < n; i++) {
      next[i] = res[i] <= limit ? 1 : 0;
      count += next[i];
      if (next[i] !== mask[i]) same = false;
    }
    if (count < 6 || same) break;
    mask = next;
  }
  const kept = mask.reduce((a, b) => a + b, 0);
  return [kept >= 6 ? fitEllipse(cv, select(scan.points, mask)) : null, mask];
}

function maxGapDeg(angles: number[]): number {
  if (angles.length < 2) return 360;
  const a = angles.map((x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).sort((x, y) => x - y);
  let gap = a[0] + 2 * Math.PI - a[a.length - 1];
  for (let i = 1; i < a.length; i++) gap = Math.max(gap, a[i] - a[i - 1]);
  return (gap * 180) / Math.PI;
}

function ringMedian(img: Channel, e: Candidate, scale: number, rays: number): number {
  const vals: number[] = [];
  for (let i = 0; i < rays; i++) {
    const phi = i * ((2 * Math.PI) / rays);
    const r = ellipseRadius(phi, e.major, e.minor, e.angleDeg) * scale;
    const [v, valid] = bilinear(img.data, img.w, img.h, e.cx + r * Math.cos(phi), e.cy + r * Math.sin(phi));
    if (valid) vals.push(v);
  }
  return vals.length ? median(vals) : NaN;
}

function glareFraction(cv: CV, raw: InstanceType<CV["Mat"]>, e: Candidate, level: number): number {
  const mask = cv.Mat.zeros(raw.rows, raw.cols, cv.CV_8UC1);
  try {
    const box = new cv.RotatedRect(new cv.Point(e.cx, e.cy), new cv.Size(e.major * 0.95, e.minor * 0.95), e.angleDeg);
    cv.ellipse1(mask, box, new cv.Scalar(255), -1, cv.LINE_8);
    const m = mask.data;
    const g = raw.data;
    let inside = 0;
    let bright = 0;
    for (let i = 0; i < m.length; i++) {
      if (m[i]) {
        inside++;
        if (g[i] >= level) bright++;
      }
    }
    return inside ? bright / inside : 0;
  } finally {
    mask.delete();
  }
}

function refine(cv: CV, img: Channel, raw: InstanceType<CV["Mat"]>, cand: Candidate, p: CoinDetectionParams, polarity: number | null): CoinDetection | null {
  let scan = radialScan(img, cand, p, p.radial_search_fraction, polarity);
  const [fit] = robustFit(cv, scan, p.outlier_mad_k);
  if (!fit) return null;
  scan = radialScan(img, fit, p, Math.min(p.narrow_search_fraction, p.radial_search_fraction), polarity);
  const [fit2, mask] = robustFit(cv, scan, p.outlier_mad_k);
  if (!fit2) return null;
  const pts = select(scan.points, mask);
  const angles = scan.angles.filter((_, i) => mask[i]);
  const strengths = scan.strengths.filter((_, i) => mask[i]);
  const res = residuals(pts, fit2);

  const contrastGl = Math.abs(ringMedian(img, fit2, 0.8, p.radial_rays) - ringMedian(img, fit2, 1.2, p.radial_rays));
  const medStrength = strengths.length ? median(strengths) : 0;
  const edgeWidth = medStrength > 0 ? contrastGl / medStrength : Infinity;
  let ss = 0;
  for (const r of res) ss += r * r;

  return {
    found: true,
    accepted: false,
    center_x: fit2.cx,
    center_y: fit2.cy,
    major_axis_px: fit2.major,
    minor_axis_px: fit2.minor,
    angle_deg: fit2.angleDeg,
    edge_support: angles.length / p.radial_rays,
    max_angular_gap_deg: maxGapDeg(angles),
    fit_residual_px: res.length ? Math.sqrt(ss / res.length) : Infinity,
    edge_width_px: edgeWidth,
    glare_fraction: glareFraction(cv, raw, fit2, p.glare_level),
    contrast: contrastGl / 255,
    n_edge_points: angles.length,
    confidence: 0,
    method: cand.method,
    reasons: [],
    candidates: [],
  };
}

export function scoreDetection(det: CoinObservation, p: CoinDetectionParams): void {
  const acc = p.accept;
  const sc = p.score;
  const residLimit = Math.max(acc.max_fit_residual_px, (acc.max_fit_residual_rel * det.major_axis_px) / 2);
  const scores = [
    ramp(det.edge_support, sc.edge_support_good, sc.edge_support_bad),
    ramp(det.max_angular_gap_deg, sc.angular_gap_good_deg, acc.max_angular_gap_deg * sc.angular_gap_bad_factor),
    ramp(det.fit_residual_px, sc.fit_residual_good_px, residLimit * sc.fit_residual_bad_factor),
    ramp(det.edge_width_px, sc.edge_width_good_px, acc.max_edge_width_px * sc.edge_width_bad_factor),
    ramp(det.glare_fraction, sc.glare_good, acc.max_glare_fraction * sc.glare_bad_factor),
    ramp(det.contrast, sc.contrast_good, acc.min_contrast * sc.contrast_bad_factor),
  ];
  det.confidence = Math.pow(scores.reduce((a, s) => a * Math.min(1, Math.max(1e-3, s)), 1), 1 / scores.length);

  const reasons: string[] = [];
  if (det.major_axis_px < p.min_diameter_px) reasons.push("coin_too_small");
  if (det.edge_support < acc.min_edge_support || det.max_angular_gap_deg > acc.max_angular_gap_deg) reasons.push("coin_occluded");
  if (det.fit_residual_px > residLimit) reasons.push("coin_irregular_boundary");
  if (det.edge_width_px > acc.max_edge_width_px) reasons.push("coin_blurry");
  if (det.glare_fraction > acc.max_glare_fraction) reasons.push("coin_glare");
  if (det.contrast < acc.min_contrast) reasons.push("coin_low_contrast");
  if (det.confidence < acc.min_confidence && reasons.length === 0) reasons.push("coin_low_confidence");
  det.reasons = reasons;
  det.accepted = reasons.length === 0;
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

/** A different coin-like circle almost as convincing as the best one (see _has_rival in Python). */
function hasRival(best: CoinDetection, others: CoinDetection[], p: CoinDetectionParams): boolean {
  return others.some(
    (d) =>
      d.accepted &&
      Math.hypot(d.center_x - best.center_x, d.center_y - best.center_y) > 0.5 * best.major_axis_px &&
      d.confidence >= p.ambiguity_confidence_ratio * best.confidence,
  );
}

export function detectCoin(
  cv: CV,
  image: RgbaImage,
  p: CoinDetectionParams,
  roi?: Roi | null,
  diameterRangePx?: [number, number] | null,
): CoinDetection {
  let r: Roi = { x: 0, y: 0, w: image.width, h: image.height };
  if (roi) {
    const x = Math.max(0, Math.trunc(roi.x));
    const y = Math.max(0, Math.trunc(roi.y));
    r = { x, y, w: Math.min(image.width - x, Math.trunc(roi.w)), h: Math.min(image.height - y, Math.trunc(roi.h)) };
  }
  if (r.w < 8 || r.h < 8) return emptyDetection(["coin_not_found"]);

  let dMin = p.min_diameter_px;
  let dMax = 0.95 * Math.min(r.w, r.h);
  if (diameterRangePx) {
    dMin = Math.max(dMin, diameterRangePx[0]);
    dMax = Math.min(dMax, diameterRangePx[1]);
  }
  if (dMin >= dMax) return emptyDetection(["coin_too_small"]);

  const rgbaBytes = r.x === 0 && r.y === 0 && r.w === image.width && r.h === image.height ? image.data : cropRgba(image, r);
  const rgba = new cv.Mat(r.h, r.w, cv.CV_8UC4);
  const raw = new cv.Mat();
  const claheOut = new cv.Mat();
  const blurred = new cv.Mat();
  const chroma = new cv.Mat(r.h, r.w, cv.CV_8UC1);
  const smoothMat = new cv.Mat();
  const clahe = new cv.CLAHE(p.clahe_clip_limit, new cv.Size(p.clahe_tile_grid, p.clahe_tile_grid));
  try {
    rgba.data.set(rgbaBytes);
    cv.cvtColor(rgba, raw, cv.COLOR_RGBA2GRAY);
    clahe.apply(raw, claheOut);
    cv.GaussianBlur(claheOut, blurred, new cv.Size(p.blur_kernel, p.blur_kernel), 0);
    chroma.data.set(chromaChannel(rgbaBytes, r.w * r.h));
    cv.GaussianBlur(chroma, smoothMat, new cv.Size(3, 3), 0);
    const smooth: Channel = { data: Float64Array.from(smoothMat.data), w: r.w, h: r.h };

    let cands = [
      ...segmentationCandidates(cv, chroma, p, dMin, dMax),
      ...contourCandidates(cv, blurred, p, dMin, dMax),
      ...houghCandidates(cv, blurred, p, dMin, dMax),
    ];
    cands = dedupe(cands).slice(0, p.max_candidates * 2);

    const results: CoinDetection[] = [];
    for (const cand of cands) {
      const det = refine(cv, smooth, raw, cand, p, 1);
      const [loTol, hiTol] = p.candidate_size_tolerance;
      if (!det || !(loTol * dMin <= det.major_axis_px && det.major_axis_px <= hiTol * dMax)) continue;
      scoreDetection(det, p);
      results.push(det);
    }
    if (!results.length) return emptyDetection(["coin_not_found"]);
    results.sort((a, b) => Number(b.accepted) - Number(a.accepted) || b.confidence - a.confidence);
    const best = results[0];
    if (best.accepted && hasRival(best, results.slice(1), p)) {
      best.accepted = false;
      best.reasons = ["coin_ambiguous"];
    }
    best.candidates = results.slice(0, p.max_candidates).map((d) => ({
      method: d.method,
      diameter_px: Math.round(d.major_axis_px * 100) / 100,
      axis_ratio: Math.round((d.minor_axis_px / d.major_axis_px) * 1e4) / 1e4,
      confidence: Math.round(d.confidence * 1000) / 1000,
      accepted: d.accepted,
    }));
    best.center_x += r.x;
    best.center_y += r.y;
    return best;
  } finally {
    rgba.delete();
    raw.delete();
    claheOut.delete();
    blurred.delete();
    chroma.delete();
    smoothMat.delete();
    clahe.delete();
  }
}
