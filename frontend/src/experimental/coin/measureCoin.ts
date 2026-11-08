// EXPERIMENTAL coin calibration on one image: the PRODUCTION detector (imported, unchanged) finds the coin, then this
// module refines it and states what the coin gives as a scale, with a propagated uncertainty.
//
//  1. detectCoin (src/vision/coinDetector.ts, production, read-only) with the production parameters passed in by the
//     caller (config/measurement.json coin_detection). Its ellipse is the start; a caller-given seed is used only when it
//     finds nothing.
//  2. Edge points on radial profiles. The colour image is smoothed (Gaussian, 0.7 px) around the coin and projected on
//     the colour direction that separates the coin's face from its surroundings (medians of an inner and an outer ring),
//     so the same code works for a silver coin on skin (mostly a chroma step) and on white paper (a brightness step).
//     On each ray the OUTERMOST strong rising step is taken (the silhouette, not the face/wall boundary or relief),
//     located to sub-pixel by a parabola through the derivative peak. Rays whose profile leaves the image are marked.
//  3. With intrinsics, edge points are undistorted (geometry/camera.ts radial model) before fitting.
//  4. Robust geometric ellipse fit (Sampson distances, Levenberg-Marquardt, MAD trimming; conic.ts), second pass of
//     narrower rays from the fitted ellipse.
//  5. Visibility (whole rim in the picture, occluded arc share, longest gap, glare share on the face), orientation
//     (tilt from the axis ratio, sign ambiguous, the in-image angle; with intrinsics the two exact circle poses),
//     distance, the coin-plane scale and its uncertainty budget, a confidence and reason codes.
//
// THE SCALE. mm per px at the coin = D / major (D from config/reference_objects.json, never hard-coded). Two corrections
// are reported separately: PERSPECTIVE (the exact scale at the depth of the coin's centre, Z / f, from the circle pose,
// needs a focal length: known intrinsics or the app's assumed field-of-view range) and THICKNESS (the silhouette is the
// coin's TOP face, `thickness` above the surface it lies on; the surface's scale is larger by (Z + h cos(tilt)) / Z).
// It is the scale of ONE PLANE at ONE DEPTH: see ../geometry/coinScale.ts LIMITS_OF_ONE_CIRCLE.
//
// Everything here is EXPERIMENTAL; its accuracy figures (sensitivity.ts) are SIMULATED on rendered coins.

import type { CoinDetectionParams } from "../../api/types";
import { detectCoin, ramp, type CoinDetection, type RgbaImage, type Roi } from "../../vision/coinDetector";
import type { CV } from "../../vision/opencv";
import { gaussianBlurPlane } from "../board/image";
import type { Intrinsics, Pt } from "../common";
import { ASSUMED_HFOV_DEG, intrinsicsFromHfov, undistortNormalized } from "../geometry/camera";
import { circlePosesFromConic, ellipseRadiusAt, ellipseToConic, fitEllipseRobust, type CirclePose, type Ellipse } from "./conic";
import { fitCoinCircle3D } from "./sceneScale";

const DEG = Math.PI / 180;
const S3 = Math.sqrt(3);

// ------------------------------------------------------------------------------------------------ reference

/** The reference coin as read from config/reference_objects.json (never hard-coded in the logic). */
export interface CoinReference {
  id: string;
  diameterMm: number;
  /** config diameter_uncertainty_mm: a bounded allowance (+-), itself an assumption in the config. */
  diameterAllowanceMm: number;
  thicknessMm: number;
  /** "config": thickness_mm in the reference entry; "assumed": the entry has none and a stated assumption is used. */
  thicknessSource: "config" | "assumed";
  /** Bounded allowance (+-) on the thickness. */
  thicknessAllowanceMm: number;
}

interface ReferenceObjectsJson {
  objects: { id: string; diameter_mm: number; diameter_uncertainty_mm: number; thickness_mm: number | null }[];
}

/**
 * Build the reference from the config files' content. When the entry has no thickness (the 2019 Rs 2 coin: no primary
 * source states one, see README), `assumedThicknessMm` is used (production uses calibration.custom_reference_thickness_mm)
 * with a wide allowance (default +-0.5 mm, an assumption).
 */
export function coinReferenceFromConfig(
  referenceObjects: ReferenceObjectsJson,
  id: string,
  assumedThicknessMm: number,
  opts: { assumedThicknessAllowanceMm?: number; configThicknessAllowanceMm?: number } = {},
): CoinReference {
  const obj = referenceObjects.objects.find((o) => o.id === id);
  if (!obj) throw new Error(`reference object ${id} not in the config`);
  const fromConfig = obj.thickness_mm !== null && obj.thickness_mm !== undefined;
  return {
    id,
    diameterMm: obj.diameter_mm,
    diameterAllowanceMm: obj.diameter_uncertainty_mm,
    thicknessMm: fromConfig ? (obj.thickness_mm as number) : assumedThicknessMm,
    thicknessSource: fromConfig ? "config" : "assumed",
    thicknessAllowanceMm: fromConfig ? (opts.configThicknessAllowanceMm ?? 0.05) : (opts.assumedThicknessAllowanceMm ?? 0.5),
  };
}

// ------------------------------------------------------------------------------------------------ types

export interface MeasureCoinOptions {
  /** Production coin-detection parameters (config/measurement.json coin_detection). */
  params: CoinDetectionParams;
  reference: CoinReference;
  /** Known camera (fx, fy, cx, cy and k1, k2 of the radial model) in the coordinates of `image`. */
  intrinsics?: Intrinsics;
  /** Without intrinsics: the assumed field-of-view range across the long side (default: the app's, 55 to 80 degrees). */
  assumedHfovDeg?: readonly [number, number];
  /** Where `image` sits in the full camera frame (a crop); used only for assumed intrinsics. Default: it is the frame. */
  frame?: { x0: number; y0: number; width: number; height: number };
  roi?: Roi | null;
  diameterRangePx?: [number, number] | null;
  /** Used only when the production detector finds no coin (e.g. the coin predicted from another view). */
  fallbackSeed?: Ellipse;
  /** Rays per pass (default 360). */
  rays?: number;
  /** Assumed bound (+-) on a systematic edge-location bias per edge, px (default 0.25; NOT measured on real coins). */
  edgeBiasAllowancePx?: number;
  /** Largest combined relative standard uncertainty of the scale before `uncertain_scale` (default 0.03, an assumption). */
  maxRelSigma?: number;
  /** Margin the rim must keep from the picture border, px (default 2). */
  marginPx?: number;
}

export type CoinReason =
  | "coin_not_found"
  | "rim_outside_image"
  | "rim_occluded"
  | "glare"
  | "poor_fit"
  | "blurry"
  | "too_small"
  | "uncertain_scale";

export interface ScaleComponent {
  key: "edge_fit" | "edge_bias" | "reference_diameter" | "perspective" | "lens_distortion" | "thickness";
  /** Relative one-sigma uncertainty of the scale. */
  rel: number;
  rule: string;
}

export interface CoinMeasurement {
  ok: boolean;
  reasons: CoinReason[];
  /** Production verdicts, reported, not used as gates here (the refinement may work where the production gates refuse). */
  warnings: string[];
  production: Pick<CoinDetection, "found" | "accepted" | "reasons" | "center_x" | "center_y" | "major_axis_px" | "minor_axis_px" | "angle_deg" | "confidence" | "method">;
  source: "production" | "seed" | "none";
  /** Refined ellipse in the image's own (distorted) pixels. */
  ellipseImage: Ellipse | null;
  /** Refined ellipse in undistorted pixels (equal to ellipseImage without intrinsics). */
  ellipse: Ellipse | null;
  /** Inlier edge points in undistorted pixels (for sceneScale), with their ray angle. */
  edgePoints: Pt[];
  fit: { rmsPx: number; sigmaMajorPx: number; sigmaMinorPx: number; rays: number; edgePoints: number; inliers: number } | null;
  visibility: {
    rimInsideImage: boolean;
    minMarginPx: number;
    /** Share of rays whose profile left the picture. */
    outsideShare: number;
    /** Share of in-picture rays with no accepted edge point (a finger, glare at the rim, low contrast). */
    occludedShare: number;
    maxGapDeg: number;
    /** Share of the face (inside 0.9 of the ellipse) at or above the production glare level. */
    glareShare: number;
    /** Median rising step along the contrast direction, grey levels per px. */
    edgeStrength: number;
    /** Median edge width (step height / peak slope), px: blur and soft shadows widen it. */
    edgeWidthPx: number;
  } | null;
  orientation: {
    /** acos(minor / major): angle between the coin's plane and the plane perpendicular to the viewing ray. */
    tiltDeg: number;
    /** The same after removing the coin wall from the minor axis (first order); null below about 4 atan(h / D). */
    tiltDegThicknessCorrected: number | null;
    /** "ambiguous" from an ellipse; "suggested_by_wall" when the 3D outline fit prefers one pose (visible wall). A HINT only:
     *  the signal is a few hundredths of a pixel and an edge bias can reverse it (SIMULATED: wrong on paper at 30 degrees). */
    tiltSign: "ambiguous" | "suggested_by_wall";
    /** Image angle of the major axis (the tilt axis), degrees from +x toward +y. The normal leans along the minor axis, toward one side or the other. */
    imageAngleDeg: number;
    /** With intrinsics: the two circle poses (camera frame, mm, top face) that explain the ellipse. */
    poses: CirclePose[] | null;
    /** With intrinsics: the 3D outline fit (coin as a cylinder when its wall shows). Its two starts are the two poses; when
     *  the wall is visible their residuals differ and suggest the tilt sign (wallSuggestsSign: a hint, not proof). */
    outlineFit: { model: "top" | "cylinder"; normal: [number, number, number]; centerTop: [number, number, number]; rmsPx: number; otherPoseRmsPx: number | null; wallSuggestsSign: boolean } | null;
  } | null;
  distance: { mm: number | null; rangeMm: [number, number] | null } | null;
  scale: {
    /** D / major: mm per px at the coin's top face, no correction. */
    mmPerPxMajor: number;
    /** Perspective-corrected: Z_top / f at the depth of the top face's centre (cone of the ellipse; with intrinsics the
     *  3D outline fit, which also models the coin's wall). */
    mmPerPxCorrected: number;
    /** The cone-only value (ellipse treated as the image of a circle), for comparison. */
    mmPerPxCone: number;
    /** Thickness-corrected: at the surface the coin lies on (palm or table) under its centre. */
    mmPerPxSupport: number;
    components: ScaleComponent[];
    relSigma: number;
    /** One-sigma of mmPerPxSupport, mm per px. */
    sigmaMmPerPx: number;
    /** Size of the corrections applied (relative): perspective = corrected / major - 1, thickness = support / corrected - 1, distortion = undistorted vs raw major. */
    corrections: { perspective: number; thickness: number; distortion: number };
    focal: "known" | "assumed_fov";
  } | null;
  confidence: number;
}

// ------------------------------------------------------------------------------------------------ edge extraction

interface Planes {
  x0: number;
  y0: number;
  w: number;
  h: number;
  ch: Float32Array[];
  W: number;
  H: number;
}

function cropPlanes(img: RgbaImage, e: Ellipse, sigma: number): Planes {
  const r = 0.75 * e.major + 6;
  const x0 = Math.max(0, Math.floor(e.cx - r));
  const y0 = Math.max(0, Math.floor(e.cy - r));
  const x1 = Math.min(img.width, Math.ceil(e.cx + r) + 1);
  const y1 = Math.min(img.height, Math.ceil(e.cy + r) + 1);
  const w = Math.max(2, x1 - x0), h = Math.max(2, y1 - y0);
  const ch = [0, 1, 2].map((c) => {
    const p = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = ((y0 + y) * img.width + x0) * 4;
      for (let x = 0; x < w; x++) p[y * w + x] = img.data[row + 4 * x + c];
    }
    if (sigma > 0) gaussianBlurPlane(p, w, h, sigma);
    return p;
  });
  return { x0, y0, w, h, ch, W: img.width, H: img.height };
}

/** Bilinear sample of a plane at image coordinates; NaN outside the crop. */
function samplePlane(P: Planes, p: Float32Array, x: number, y: number): number {
  const lx = x - P.x0, ly = y - P.y0;
  if (!(lx >= 0 && ly >= 0 && lx <= P.w - 1 && ly <= P.h - 1)) return NaN;
  const xi = Math.min(P.w - 2, Math.floor(lx)), yi = Math.min(P.h - 2, Math.floor(ly));
  const fx = lx - xi, fy = ly - yi;
  const i = yi * P.w + xi;
  return (p[i] * (1 - fx) + p[i + 1] * fx) * (1 - fy) + (p[i + P.w] * (1 - fx) + p[i + P.w + 1] * fx) * fy;
}

function median(v: number[]): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** Unit colour direction from the face (inner ring) to the surroundings (outer ring), and its contrast. */
function contrastDirection(P: Planes, e: Ellipse): { dir: [number, number, number]; contrast: number } {
  const ring = (lo: number, hi: number) => {
    const vals: number[][] = [[], [], []];
    for (let k = 0; k < 180; k++) {
      const phi = (2 * Math.PI * k) / 180;
      const r0 = ellipseRadiusAt(e, phi);
      for (let f = 0; f <= 3; f++) {
        const r = r0 * (lo + ((hi - lo) * f) / 3);
        const x = e.cx + r * Math.cos(phi), y = e.cy + r * Math.sin(phi);
        const v = P.ch.map((p) => samplePlane(P, p, x, y));
        if (v.some((q) => Number.isNaN(q))) continue;
        v.forEach((q, c) => vals[c].push(q));
      }
    }
    return vals.map(median);
  };
  const inner = ring(0.5, 0.8);
  const outer = ring(1.15, 1.35);
  const d = outer.map((o, c) => o - inner[c]);
  const n = Math.hypot(d[0], d[1], d[2]);
  if (!(n > 1e-6)) return { dir: [0.299, 0.587, 0.114], contrast: 0 };
  return { dir: [d[0] / n, d[1] / n, d[2] / n], contrast: n };
}

interface RayEdge {
  phi: number;
  pt: Pt | null;
  strength: number;
  outside: boolean;
  widthPx: number;
}

function castRays(P: Planes, e: Ellipse, dir: readonly number[], nRays: number, frac: number, minHalfPx: number): RayEdge[] {
  const step = 0.25;
  const out: RayEdge[] = [];
  for (let k = 0; k < nRays; k++) {
    const phi = (2 * Math.PI * k) / nRays;
    const c = Math.cos(phi), s = Math.sin(phi);
    const r0 = ellipseRadiusAt(e, phi);
    const half = Math.max(frac * r0, minHalfPx);
    const lo = r0 - half, hi = r0 + half;
    const n = Math.max(8, Math.ceil((hi - lo) / step) + 1);
    const prof = new Float64Array(n);
    let outside = false;
    for (let j = 0; j < n; j++) {
      const r = lo + j * step;
      const x = e.cx + r * c, y = e.cy + r * s;
      if (x < 0 || y < 0 || x > P.W - 1 || y > P.H - 1) outside = true;
      const v0 = samplePlane(P, P.ch[0], x, y), v1 = samplePlane(P, P.ch[1], x, y), v2 = samplePlane(P, P.ch[2], x, y);
      if (Number.isNaN(v0)) {
        outside = true;
        prof[j] = j > 0 ? prof[j - 1] : 0;
        continue;
      }
      prof[j] = dir[0] * v0 + dir[1] * v1 + dir[2] * v2;
    }
    // derivative over +-2 samples (1 px baseline): rising steps outward are positive
    const der = new Float64Array(n);
    for (let j = 2; j < n - 2; j++) der[j] = (prof[j + 2] - prof[j - 2]) / (4 * step);
    // the strongest rising step (the silhouette: the face/wall boundary and relief are weaker or falling)
    let jPk = -1;
    let best = 0;
    for (let j = 3; j < n - 3; j++) if (der[j] > best && der[j] >= der[j - 1] && der[j] >= der[j + 1]) {
      best = der[j];
      jPk = j;
    }
    if (jPk < 0) {
      out.push({ phi, pt: null, strength: 0, outside, widthPx: NaN });
      continue;
    }
    const a = der[jPk - 1], b = der[jPk], cc = der[jPk + 1];
    const den = a - 2 * b + cc;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - cc)) / den)) : 0;
    const r = lo + (jPk + off) * step;
    // edge width: the step's height (ends of the profile) over the peak slope, as the production detector defines it
    const widthPx = (prof[n - 1] - prof[0]) / b;
    out.push({ phi, pt: { x: e.cx + r * c, y: e.cy + r * s }, strength: b, outside, widthPx });
  }
  return out;
}

function maxGapDeg(angles: number[]): number {
  if (angles.length < 2) return 360;
  const a = [...angles].sort((x, y) => x - y);
  let gap = a[0] + 2 * Math.PI - a[a.length - 1];
  for (let i = 1; i < a.length; i++) gap = Math.max(gap, a[i] - a[i - 1]);
  return gap / DEG;
}

function glareShare(img: RgbaImage, e: Ellipse, level: number): number {
  const a = 0.45 * e.major, b = 0.45 * e.minor;
  const c = Math.cos(e.angleDeg * DEG), s = Math.sin(e.angleDeg * DEG);
  let inside = 0, bright = 0;
  for (let y = Math.max(0, Math.floor(e.cy - a)); y <= Math.min(img.height - 1, Math.ceil(e.cy + a)); y++)
    for (let x = Math.max(0, Math.floor(e.cx - a)); x <= Math.min(img.width - 1, Math.ceil(e.cx + a)); x++) {
      const dx = x - e.cx, dy = y - e.cy;
      const u = (dx * c + dy * s) / a, v = (-dx * s + dy * c) / b;
      if (u * u + v * v > 1) continue;
      inside++;
      const i = (y * img.width + x) * 4;
      if (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2] >= level) bright++;
    }
  return inside ? bright / inside : 0;
}

function ellipseExtent(e: Ellipse): { hx: number; hy: number } {
  const a = e.major / 2, b = e.minor / 2;
  const c = Math.cos(e.angleDeg * DEG), s = Math.sin(e.angleDeg * DEG);
  return { hx: Math.sqrt((a * c) ** 2 + (b * s) ** 2), hy: Math.sqrt((a * s) ** 2 + (b * c) ** 2) };
}

const undistortPx = (K: Intrinsics, p: Pt): Pt => {
  if (!K.k1 && !K.k2) return p;
  const n = undistortNormalized((p.x - K.cx) / K.fx, (p.y - K.cy) / K.fy, K.k1, K.k2);
  return { x: K.fx * n.x + K.cx, y: K.fy * n.y + K.cy };
};

/** The tilt that explains an outline whose minor axis includes the coin wall (orthographic, first order). */
export function thicknessCorrectedTiltDeg(majorPx: number, minorPx: number, diameterMm: number, thicknessMm: number): number | null {
  const hp = (thicknessMm * majorPx) / diameterMm;
  const R = Math.hypot(majorPx, hp);
  const phi = Math.atan2(hp, majorPx);
  const q = Math.acos(Math.min(1, minorPx / R));
  const naive = Math.acos(Math.min(1, minorPx / majorPx));
  // Below about 4 atan(h / D) (15 degrees for 23 x 1.5 mm) the wall barely shows and edge noise dominates the axis
  // ratio; the first-order model is not used there.
  if (!(q > phi) || naive < 4 * phi) return null;
  return (phi + q) / DEG;
}

// ------------------------------------------------------------------------------------------------ main

export function measureCoin(cv: CV, image: RgbaImage, opts: MeasureCoinOptions): CoinMeasurement {
  const p = opts.params;
  const ref = opts.reference;
  const det = detectCoin(cv, image, p, opts.roi ?? null, opts.diameterRangePx ?? null);
  const production = {
    found: det.found,
    accepted: det.accepted,
    reasons: det.reasons,
    center_x: det.center_x,
    center_y: det.center_y,
    major_axis_px: det.major_axis_px,
    minor_axis_px: det.minor_axis_px,
    angle_deg: det.angle_deg,
    confidence: det.confidence,
    method: det.method,
  };
  const warnings: string[] = det.found ? (det.accepted ? [] : det.reasons.map((r) => `production:${r}`)) : ["production:coin_not_found"];
  const empty = (source: CoinMeasurement["source"], reasons: CoinReason[]): CoinMeasurement => ({
    ok: false,
    reasons,
    warnings,
    production,
    source,
    ellipseImage: null,
    ellipse: null,
    edgePoints: [],
    fit: null,
    visibility: null,
    orientation: null,
    distance: null,
    scale: null,
    confidence: 0,
  });
  let start: Ellipse;
  let source: CoinMeasurement["source"];
  if (det.found && det.major_axis_px > 0) {
    start = { cx: det.center_x, cy: det.center_y, major: det.major_axis_px, minor: det.minor_axis_px, angleDeg: det.angle_deg };
    source = "production";
  } else if (opts.fallbackSeed) {
    start = opts.fallbackSeed;
    source = "seed";
  } else return empty("none", ["coin_not_found"]);

  const nRays = opts.rays ?? 360;
  const K = opts.intrinsics;
  let P = cropPlanes(image, start, 0.7);
  const { dir } = contrastDirection(P, start);

  // pass 1 (wide) and pass 2 (narrow), each followed by a robust fit in image pixels
  let e = start;
  let rays: RayEdge[] = [];
  let imgFit: ReturnType<typeof fitEllipseRobust> = null;
  let accepted: RayEdge[] = [];
  for (const frac of [0.2, 0.07]) {
    rays = castRays(P, e, dir, nRays, frac, 5);
    const inImage = rays.filter((r) => !r.outside);
    const strengths = inImage.filter((r) => r.pt).map((r) => r.strength);
    const thr = Math.max(p.edge_strength_min, p.edge_strength_rel * (median(strengths) || 0));
    accepted = rays.filter((r) => r.pt && !r.outside && r.strength >= thr);
    imgFit = fitEllipseRobust(accepted.map((r) => r.pt as Pt), { madK: p.outlier_mad_k, start: e });
    if (!imgFit) return empty(source, ["poor_fit"]);
    e = imgFit.ellipse;
    P = cropPlanes(image, e, 0.7);
  }
  if (!imgFit) return empty(source, ["poor_fit"]);
  const inl = imgFit.inliers.map((i) => accepted[i]);
  const ptsU = inl.map((r) => (K ? undistortPx(K, r.pt as Pt) : (r.pt as Pt)));
  // inlier points of the final fit, undistorted (imgFit's inliers ARE ptsU; a refit indexes into ptsU)
  const inlU = () => (fitU === imgFit ? ptsU : (fitU as NonNullable<typeof fitU>).inliers.map((i) => ptsU[i]));
  const fitU = K && (K.k1 || K.k2) ? fitEllipseRobust(ptsU, { madK: p.outlier_mad_k, start: imgFit.ellipse }) : imgFit;
  if (!fitU) return empty(source, ["poor_fit"]);
  const eI = imgFit.ellipse;
  const eU = fitU.ellipse;

  // visibility
  const ext = ellipseExtent(eI);
  const minMarginPx = Math.min(eI.cx - ext.hx, eI.cy - ext.hy, image.width - 1 - (eI.cx + ext.hx), image.height - 1 - (eI.cy + ext.hy));
  const marginPx = opts.marginPx ?? 2;
  const rimInsideImage = minMarginPx >= marginPx;
  const inImageRays = rays.filter((r) => !r.outside).length;
  const outsideShare = 1 - inImageRays / rays.length;
  const occludedShare = inImageRays ? 1 - inl.length / inImageRays : 1;
  const gap = maxGapDeg(inl.map((r) => r.phi));
  const glare = glareShare(image, eI, p.glare_level);
  const edgeStrength = median(inl.map((r) => r.strength));
  const edgeWidthPx = median(inl.map((r) => r.widthPx).filter((w) => Number.isFinite(w) && w > 0));

  // orientation
  const D = ref.diameterMm;
  const h = ref.thicknessMm;
  const tiltDeg = Math.acos(Math.min(1, eU.minor / eU.major)) / DEG;
  const tiltCorr = thicknessCorrectedTiltDeg(eU.major, eU.minor, D, h);
  let poses: CirclePose[] | null = null;

  // scale: perspective via the circle poses for the known or assumed focal length
  const conic = ellipseToConic(eU);
  const scaleFor = (Kx: Pick<Intrinsics, "fx" | "fy" | "cx" | "cy">) => {
    const sols = circlePosesFromConic(conic, Kx, D / 2);
    const f = 0.5 * (Kx.fx + Kx.fy);
    return { sols, s: sols.map((q) => q.center[2] / f), z: sols.map((q) => q.center[2]) };
  };
  const mmPerPxMajor = D / eU.major;
  let mmPerPxCorrected = mmPerPxMajor;
  let relPersp = 0;
  let distMm: number | null = null;
  let range: [number, number] | null = null;
  let zSigmaRel = 0;
  let normalZ = Math.cos(tiltDeg * DEG); // |n . optical axis|, approximated by the ray tilt without intrinsics
  let focal: "known" | "assumed_fov" = "assumed_fov";
  let outlineFit: NonNullable<CoinMeasurement["orientation"]>["outlineFit"] = null;
  let mmPerPxCone = mmPerPxMajor;
  if (K) {
    focal = "known";
    const r = scaleFor(K);
    poses = r.sols;
    if (r.s.length) {
      mmPerPxCorrected = r.s.reduce((a, b) => a + b, 0) / r.s.length;
      mmPerPxCone = mmPerPxCorrected;
      relPersp = (Math.abs(r.s[0] - r.s[r.s.length - 1]) / 2 / mmPerPxCorrected) / S3;
      distMm = r.z.reduce((a, b) => a + b, 0) / r.z.length;
      normalZ = r.sols.reduce((a, q) => a + Math.abs(q.normal[2]), 0) / r.sols.length;
    }
    const f3 = fitCoinCircle3D([{ K, pose: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, points: inlU() }], { diameterMm: D, thicknessMm: h, fixedRadiusMm: D / 2, model: "auto" });
    if (f3.ok && f3.circle) {
      const c = f3.circle;
      // The two starts are the two circle poses. With the cylinder model the visible wall breaks the symmetry: either
      // both starts end in the same pose, or one fits clearly worse. That SUGGESTS the tilt sign; the difference between
      // the two is only about 0.07 px RMS for an exact outline (300 mm, 1280 px), so a small edge bias can reverse it.
      const ang = (a: readonly number[], b: readonly number[]) => Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / DEG;
      const ambiguityReal = !!poses && poses.length === 2 && ang(poses[0].normal, poses[1].normal) > 5;
      const cyl = (f3.fits ?? []).filter((q) => q.model === "cylinder");
      const other = cyl.find((q) => q !== c && ang(q.normal, c.normal) > 2) ?? null;
      const otherRms = other ? other.rmsPx : null;
      const converged = cyl.length === 2 && !other;
      const nPts = inlU().length;
      outlineFit = {
        model: c.model,
        normal: [...c.normal],
        centerTop: [...c.center],
        rmsPx: c.rmsPx,
        otherPoseRmsPx: otherRms,
        // heuristic: the residual sum of squares of the other pose exceeds the best by more than 30 noise variances
        wallSuggestsSign: c.model === "cylinder" && ambiguityReal && (converged || (otherRms !== null && nPts * ((otherRms / c.rmsPx) ** 2 - 1) > 30)),
      };
      const f = 0.5 * (K.fx + K.fy);
      mmPerPxCorrected = c.center[2] / f;
      distMm = c.center[2];
      normalZ = Math.abs(c.normal[2]);
    }
  } else {
    const fr = opts.frame ?? { x0: 0, y0: 0, width: image.width, height: image.height };
    const fovs = opts.assumedHfovDeg ?? ASSUMED_HFOV_DEG;
    const est = fovs.map((fov) => {
      const Kf = intrinsicsFromHfov(fr.width, fr.height, fov);
      return scaleFor({ fx: Kf.fx, fy: Kf.fy, cx: Kf.cx - fr.x0, cy: Kf.cy - fr.y0 });
    });
    const all = est.flatMap((q) => q.s);
    const zs = est.flatMap((q) => q.z);
    if (all.length) {
      mmPerPxCorrected = 0.5 * (Math.min(...all) + Math.max(...all));
      relPersp = ((Math.max(...all) - Math.min(...all)) / 2 / mmPerPxCorrected) / S3;
      range = [Math.min(...zs), Math.max(...zs)];
      distMm = Math.sqrt(range[0] * range[1]);
      zSigmaRel = ((range[1] - range[0]) / 2 / distMm) / S3;
    }
  }
  if (!K) mmPerPxCone = mmPerPxCorrected;
  // thickness: the surface under the coin is h * |n_z| farther than the top face's centre
  const Z = distMm ?? NaN;
  const thicknessFactor = Number.isFinite(Z) ? (Z + h * normalZ) / Z : 1;
  const mmPerPxSupport = mmPerPxCorrected * thicknessFactor;
  const sigmaH = ref.thicknessAllowanceMm / S3;
  const relThick = Number.isFinite(Z) ? Math.hypot((sigmaH * normalZ) / Z, (h * normalZ * zSigmaRel) / Z) : 0;
  const distortion = K && (K.k1 || K.k2) ? eI.major / eU.major - 1 : 0;
  const bias = opts.edgeBiasAllowancePx ?? 0.25;
  const components: ScaleComponent[] = [
    { key: "edge_fit", rel: fitU.sigma.major / eU.major, rule: "statistical standard error of the major axis from the fit covariance / major" },
    { key: "edge_bias", rel: (Math.SQRT2 * bias) / S3 / eU.major, rule: `assumed systematic edge bias +-${bias} px per edge (uniform), both edges` },
    { key: "reference_diameter", rel: ref.diameterAllowanceMm / S3 / D, rule: "config diameter_uncertainty_mm as +-u (uniform) / D" },
    {
      key: "perspective",
      rel: relPersp,
      rule: K ? "half the difference of the two circle-pose solutions (uniform)" : "half the spread of the corrected scale over the assumed field-of-view range (uniform)",
    },
    {
      key: "lens_distortion",
      rel: 0,
      rule: K ? (K.k1 || K.k2 ? "corrected with the given radial model (its own error not included)" : "given intrinsics have no distortion") : "unknown without intrinsics; not included",
    },
    { key: "thickness", rel: relThick, rule: `thickness ${h} mm (${ref.thicknessSource}) +-${ref.thicknessAllowanceMm} mm (uniform) and the distance's uncertainty, at the surface under the coin` },
  ];
  const relSigma = Math.sqrt(components.reduce((s, c) => s + c.rel * c.rel, 0));

  // gates and confidence (image-quality ramps reuse the production score parameters)
  const acc = p.accept;
  const sc = p.score;
  const residLimit = Math.max(acc.max_fit_residual_px, (acc.max_fit_residual_rel * eU.major) / 2);
  const reasons: CoinReason[] = [];
  if (eU.major < p.min_diameter_px) reasons.push("too_small");
  if (!rimInsideImage || outsideShare > 0) reasons.push("rim_outside_image");
  if (1 - occludedShare < acc.min_edge_support || gap > acc.max_angular_gap_deg) reasons.push("rim_occluded");
  if (glare > acc.max_glare_fraction) reasons.push("glare");
  if (fitU.rmsPx > residLimit) reasons.push("poor_fit");
  if (!(edgeWidthPx <= acc.max_edge_width_px)) reasons.push("blurry");
  const maxRel = opts.maxRelSigma ?? 0.03;
  if (relSigma > maxRel) reasons.push("uncertain_scale");
  const scores = [
    ramp(1 - occludedShare, sc.edge_support_good, sc.edge_support_bad),
    ramp(gap, sc.angular_gap_good_deg, acc.max_angular_gap_deg * sc.angular_gap_bad_factor),
    ramp(fitU.rmsPx, sc.fit_residual_good_px, residLimit * sc.fit_residual_bad_factor),
    ramp(glare, sc.glare_good, acc.max_glare_fraction * sc.glare_bad_factor),
    ramp(edgeWidthPx, sc.edge_width_good_px, acc.max_edge_width_px * sc.edge_width_bad_factor),
    ramp(relSigma, 0.005, maxRel * 1.5),
    rimInsideImage ? 1 : 0,
  ];
  const confidence = Math.pow(scores.reduce((a, s) => a * Math.min(1, Math.max(1e-3, s)), 1), 1 / scores.length);

  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
    production,
    source,
    ellipseImage: eI,
    ellipse: eU,
    edgePoints: inlU(),
    fit: { rmsPx: fitU.rmsPx, sigmaMajorPx: fitU.sigma.major, sigmaMinorPx: fitU.sigma.minor, rays: nRays, edgePoints: accepted.length, inliers: fitU.inliers.length },
    visibility: { rimInsideImage, minMarginPx, outsideShare, occludedShare, maxGapDeg: gap, glareShare: glare, edgeStrength, edgeWidthPx },
    orientation: { tiltDeg, tiltDegThicknessCorrected: tiltCorr, tiltSign: outlineFit?.wallSuggestsSign ? "suggested_by_wall" : "ambiguous", imageAngleDeg: eU.angleDeg, poses, outlineFit },
    distance: { mm: distMm, rangeMm: range },
    scale: {
      mmPerPxMajor,
      mmPerPxCorrected,
      mmPerPxCone,
      mmPerPxSupport,
      components,
      relSigma,
      sigmaMmPerPx: relSigma * mmPerPxSupport,
      corrections: { perspective: mmPerPxCorrected / mmPerPxMajor - 1, thickness: thicknessFactor - 1, distortion },
      focal,
    },
    confidence,
  };
}
