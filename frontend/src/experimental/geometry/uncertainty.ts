// A transparent error budget for ONE length (or width) measured from a single phone image scaled by a coin.
//
// MODEL-BASED AND UNVALIDATED. Every term below is a stated assumption turned into a number; no physical reference
// measurement has checked any of them. The result is a way to see WHICH error dominates, not a claim of accuracy.
//
// Every component is a one-sigma standard uncertainty in millimetres for the length `lengthMm`. Rules used:
//   * a bounded allowance +-a (a manufacturing tolerance, a distortion bound) becomes sigma = a / sqrt(3) (uniform);
//   * a systematic error whose size is known only roughly (plane offset, tilt) is added at FULL size: conservative;
//   * independent terms combine by root-sum-square.

import type { Quantity } from "../common";
import { ASSUMED_HFOV_DEG, focalLengthSensitivity } from "./camera";

export type UncertaintyKey = "coin_edge" | "reference_diameter" | "plane_offset" | "length_tilt" | "lens_distortion" | "boundary" | "focal_assumption";

export interface UncertaintyInput {
  /** The measured length (or width), millimetres. */
  lengthMm: number;
  /** Scale at the coin's plane, mm per pixel. */
  mmPerPx: number;
  /** The coin's major axis in pixels. */
  coinMajorPx: number;
  /** From the existing reference object (config/reference_objects.json: diameter_mm and diameter_uncertainty_mm). */
  referenceDiameterMm: number;
  referenceDiameterUncertaintyMm: number;
  /** Camera distance to the coin's plane, millimetres. */
  distanceMm: number;
  /** One-sigma position error of each coin edge, pixels. Default 0.5 (the production floor, calibration.diameter_edge_floor_px). */
  coinEdgeSigmaPx?: number;
  /** One-sigma position error of the silhouette boundary on each side, pixels. Default 1. */
  boundaryErrorPx?: number;
  /** Distance of the measured plane behind the coin's plane (the hand is thicker than a coin), mm. Default 15. */
  planeOffsetMm?: number;
  /** True when the plane offset is corrected from a distance estimate (then only a residual remains). Default false. */
  planeOffsetCorrected?: boolean;
  /** One-sigma error of the plane offset left after correction, mm. Default 5. */
  planeOffsetResidualMm?: number;
  /** The angle between the measured length and the image plane, degrees. Default 0. */
  lengthTiltDeg?: number;
  /** Radial lens distortion k1 of the (undistorted-by-the-phone or not) image; default 0. */
  k1?: number;
  /** Normalised radius (x/z, y/z scale) of the coin and of the measured segment's far end. Defaults 0.1 and 0.5. */
  rCoinNorm?: number;
  rMeasuredNorm?: number;
  /** Bounded relative focal-length error (half range). Default: half of the app's assumed field-of-view range, about 0.23. */
  relFocalError?: number;
}

export interface UncertaintyComponent {
  key: UncertaintyKey;
  label: string;
  sigmaMm: number;
  rule: string;
  basis: "model";
}

export interface UncertaintyBudget {
  components: UncertaintyComponent[];
  combined: Quantity;
  /** combined / lengthMm */
  relative: number;
  dominant: UncertaintyKey;
  label: string;
  assumptions: string[];
}

/** Half of the relative spread of the focal length implied by the app's assumed field-of-view range. */
export function defaultRelFocalError(range: readonly [number, number] = ASSUMED_HFOV_DEG): number {
  const f = range.map((fov) => 1 / Math.tan((fov * Math.PI) / 360));
  return (Math.max(...f) - Math.min(...f)) / (Math.max(...f) + Math.min(...f));
}

const S3 = Math.sqrt(3);

export function estimateMeasurementUncertainty(input: UncertaintyInput): UncertaintyBudget {
  const L = input.lengthMm;
  const Z = input.distanceMm;
  if (!(L > 0 && input.mmPerPx > 0 && input.coinMajorPx > 0 && input.referenceDiameterMm > 0 && Z > 0)) throw new Error("length, scale, coin size and distance must be positive");
  const edge = input.coinEdgeSigmaPx ?? 0.5;
  const boundary = input.boundaryErrorPx ?? 1;
  const dz = input.planeOffsetMm ?? 15;
  const corrected = input.planeOffsetCorrected ?? false;
  const residual = input.planeOffsetResidualMm ?? 5;
  const tilt = ((input.lengthTiltDeg ?? 0) * Math.PI) / 180;
  const k1 = input.k1 ?? 0;
  const rc = input.rCoinNorm ?? 0.1;
  const rm = input.rMeasuredNorm ?? 0.5;
  const eFocal = input.relFocalError ?? defaultRelFocalError();

  const components: UncertaintyComponent[] = [
    {
      key: "coin_edge",
      label: "Coin edge localisation (both edges of the diameter)",
      sigmaMm: (L * Math.SQRT2 * edge) / input.coinMajorPx,
      rule: "relative error = sqrt(2) * sigma_edge / major_px, applied to the length",
      basis: "model",
    },
    {
      key: "reference_diameter",
      label: "Reference-object diameter tolerance",
      sigmaMm: (L * (input.referenceDiameterUncertaintyMm / S3)) / input.referenceDiameterMm,
      rule: "bounded allowance +-u becomes sigma = u / sqrt(3); relative to the diameter",
      basis: "model",
    },
    {
      key: "plane_offset",
      label: corrected ? "Plane offset, residual after correction" : "Plane offset between the coin's plane and the measured plane (uncorrected)",
      sigmaMm: (L * (corrected ? residual : Math.abs(dz))) / Z,
      rule: corrected ? "relative error = residual / Z (the correction itself is exact in the model)" : "relative error = dz / Z, a systematic bias added at full size",
      basis: "model",
    },
    {
      key: "length_tilt",
      label: "Foreshortening of a length tilted out of the image plane",
      sigmaMm: L * (1 - Math.cos(tilt)),
      rule: "relative error = 1 - cos(tilt), a systematic bias added at full size",
      basis: "model",
    },
    {
      key: "lens_distortion",
      label: "Radial lens distortion between the coin and the measured segment",
      sigmaMm: (L * Math.abs(k1) * Math.abs(rm * rm - rc * rc)) / S3,
      rule: "relative error bound = |k1| * |r_measured^2 - r_coin^2|, then / sqrt(3)",
      basis: "model",
    },
    {
      key: "boundary",
      label: "Segmentation boundary position (one boundary at each end of the length)",
      sigmaMm: Math.SQRT2 * boundary * input.mmPerPx,
      rule: "sqrt(2) * sigma_boundary_px * mm_per_px",
      basis: "model",
    },
    {
      key: "focal_assumption",
      label: "Assumed focal length (only matters when the plane offset is corrected from the distance)",
      sigmaMm: corrected ? Math.abs(focalLengthSensitivity({ relFocalError: eFocal / S3, distanceMm: Z, planeOffsetMm: dz, lengthMm: L }).lengthErrorMm) : 0,
      rule: corrected ? "length * |F(Z (1 + e)) / F(Z) - 1|, e = half-range / sqrt(3); see focalLengthSensitivity" : "no focal dependence: the in-plane scale is D / major_px",
      basis: "model",
    },
  ];
  const combinedSigma = Math.sqrt(components.reduce((s, c) => s + c.sigmaMm * c.sigmaMm, 0));
  const dominant = components.reduce((a, b) => (b.sigmaMm > a.sigmaMm ? b : a)).key;
  return {
    components,
    combined: {
      value: combinedSigma,
      unit: "mm",
      basis: "model",
      note: "One-sigma, model-based and UNVALIDATED: a budget of assumptions, not a measured accuracy.",
    },
    relative: combinedSigma / L,
    dominant,
    label: "Model-based, unvalidated. No physical reference measurement has verified any of these terms.",
    assumptions: [
      "Independent, zero-mean errors except where a term is stated as a bias.",
      "A flat coin lying in the palm plane; the measured length lies in a plane parallel to the image plane except for the stated tilt.",
      "A pinhole camera with the stated radial distortion only.",
      "Soft-tissue and pose variation of the hand itself are NOT in this budget.",
    ],
  };
}
