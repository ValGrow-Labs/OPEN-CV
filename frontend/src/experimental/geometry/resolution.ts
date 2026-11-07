// How many pixels a given millimetre-per-pixel scale needs, and what the app's own video really gives.
//
// PIXEL RESOLUTION IS NOT MEASUREMENT ACCURACY. A scale of 0.1 mm per pixel says how fine the pixel grid is on the hand.
// It does not say the boundary of the hand is found to one pixel, that the coin and the hand are at the same distance,
// that the lens is undistorted, that the coin is exactly 24.26 mm, or that the hand did not move. See README.md and
// uncertainty.ts for the numbers. EXPERIMENTAL; model-based; unvalidated.

import { ASSUMED_HFOV_DEG, APP_VIDEO_SIZE } from "./camera";

const DEG = Math.PI / 180;

/** The width (mm) of the scene a camera sees at `distanceMm` for a field of view across the image side. Independent of the pixel count. */
export function fieldOfViewOnHandMm(distanceMm: number, fovDeg: number): number {
  return 2 * distanceMm * Math.tan((fovDeg * DEG) / 2);
}

/** Millimetres per pixel at `distanceMm` for an image side of `sidePx` pixels spanning `fovDeg`. */
export function mmPerPxAtDistance(distanceMm: number, sidePx: number, fovDeg: number): number {
  return fieldOfViewOnHandMm(distanceMm, fovDeg) / sidePx;
}

export interface RequiredResolution {
  targetMmPerPx: number;
  distanceMm: number;
  fovDeg: number;
  /** Width of the scene across the image side, mm (= 2 d tan(fov / 2); does not depend on the target). */
  fieldMm: number;
  /** Focal length in pixels: d / target. */
  requiredFxPx: number;
  /** Pixels along the image side: field / target. */
  requiredSidePx: number;
  /** Megapixels of a 4:3 image with that long side. */
  requiredMegapixels43: number;
}

/** What it takes to reach `targetMmPerPx` on the hand at `distanceMm` with a camera whose field of view along the long side is `hfovDeg`. */
export function requiredResolutionForMmPerPx(targetMmPerPx: number, distanceMm: number, hfovDeg: number): RequiredResolution {
  if (!(targetMmPerPx > 0 && distanceMm > 0 && hfovDeg > 0 && hfovDeg < 180)) throw new Error("target, distance and field of view must be positive");
  const fieldMm = fieldOfViewOnHandMm(distanceMm, hfovDeg);
  const requiredSidePx = fieldMm / targetMmPerPx;
  return {
    targetMmPerPx,
    distanceMm,
    fovDeg: hfovDeg,
    fieldMm,
    requiredFxPx: distanceMm / targetMmPerPx,
    requiredSidePx,
    requiredMegapixels43: (requiredSidePx * (requiredSidePx * 0.75)) / 1e6,
  };
}

/** Typical phone fields of view across the long side: the app's assumed range and a common main camera (26 mm-equivalent is about 69 degrees). */
export const TYPICAL_FOVS_DEG: readonly number[] = [ASSUMED_HFOV_DEG[0], 69.4, ASSUMED_HFOV_DEG[1]];
export const TABLE_DISTANCES_MM: readonly number[] = [250, 350, 500];

/** The table for 0.1 mm per pixel (computed, not typed in). */
export function buildResolutionTable(target = 0.1, distances: readonly number[] = TABLE_DISTANCES_MM, fovs: readonly number[] = TYPICAL_FOVS_DEG): RequiredResolution[] {
  return distances.flatMap((d) => fovs.map((f) => requiredResolutionForMmPerPx(target, d, f)));
}

export const RESOLUTION_TABLE_0_1_MM: readonly RequiredResolution[] = buildResolutionTable();

export interface VideoScaleRow {
  distanceMm: number;
  fovDeg: number;
  sidePx: number;
  mmPerPx: number;
  /** Pixels across a coin of the given diameter at that scale. */
  coinPx: number;
}

/**
 * What the app's own video gives: the long side is 1280 px on phones (1920 on desktops, src/camera/camera.ts), spanning the
 * app's assumed field of view of 55 to 80 degrees (config uncertainty.assumed_hfov_deg). The coin lies in the palm, so its
 * scale is the scale of the hand's plane: the coin is NOT sharper than the hand.
 */
export function appVideoScale(coinDiameterMm: number, kind: "mobile" | "desktop" = "mobile", distances: readonly number[] = TABLE_DISTANCES_MM, fovs: readonly number[] = ASSUMED_HFOV_DEG): VideoScaleRow[] {
  const side = Math.max(APP_VIDEO_SIZE[kind].width, APP_VIDEO_SIZE[kind].height);
  return distances.flatMap((d) =>
    fovs.map((f) => {
      const mmPerPx = mmPerPxAtDistance(d, side, f);
      return { distanceMm: d, fovDeg: f, sidePx: side, mmPerPx, coinPx: coinDiameterMm / mmPerPx };
    }),
  );
}

/**
 * Why 0.1 mm per pixel is not 0.1 mm accuracy: the one-sigma errors that do NOT shrink with the pixel size, as millimetres
 * on a 190 mm hand length at 350 mm (illustrative defaults; see estimateMeasurementUncertainty for each term).
 */
export const NOT_PIXEL_LIMITED: readonly string[] = [
  "Boundary position: a skin edge is blurred over 2 to 5 pixels by optics, motion, hair and shadow; +-1 px is +-0.1 mm only if the edge were perfect.",
  "Plane offset: a hand 15 mm thicker than the coin's plane at 350 mm changes the scale by 15 / 350 = 4.3 %, about 8 mm on 190 mm.",
  "Tilt: a length tilted 10 degrees out of the image plane is short by 1.5 %, about 2.9 mm on 190 mm.",
  "Coin: the coin's own diameter tolerance (0.05 mm on 24.26 mm = 0.2 %) and its edge position set the scale.",
  "Lens distortion and the assumed focal length are not known on a browser camera.",
  "The hand is soft: pose, finger spread and skin compression change a length by millimetres whatever the pixel size.",
];
