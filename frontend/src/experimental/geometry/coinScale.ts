// What a single coin on the palm gives as metric scale, and what it cannot.
//
// READ-ONLY with respect to the production calibration: this module never recomputes or replaces the production scale
// (backend glovesize/calibration.py, src/vision/liveChecks.ts). It re-expresses the same facts for research and states
// their limits. The coin's ellipse comes from the existing detection (api/types CoinObservation); the reference diameters
// come from the existing reference objects (config/reference_objects.json), passed in by the caller, never hard-coded.
//
// EXPERIMENTAL and unvalidated.

import type { Intrinsics } from "../common";
import { ASSUMED_HFOV_DEG } from "./camera";

/** The part of the existing coin detection (CoinObservation) this module reads. */
export interface CoinEllipse {
  major_axis_px: number;
  minor_axis_px: number;
  /** As reported by the detection; its exact convention is the detector's (OpenCV ellipse angle), not interpreted here. */
  angle_deg?: number;
}

export interface CoinPlaneScale {
  /** D / major: millimetres per pixel in the coin's plane, along the direction of the ellipse's major axis. */
  mmPerPxMajor: number;
  /** D / minor: the apparent mm per pixel across the foreshortened direction (larger than the true in-plane scale by 1 / cos(tilt)). */
  mmPerPxMinorApparent: number;
  axisRatio: number;
  /** acos(minor / major): the angle between the coin's plane and the image plane, in degrees. Its SIGN is not observable. */
  tiltDeg: number;
  tiltSign: "ambiguous";
  tiltAxisImageAngleDeg: number | null;
  /** Z = fx * D / major, from known/assumed intrinsics (null without them). */
  distanceMm: number | null;
  /** The same distance for the app's assumed field-of-view range (null without an image size). */
  distanceRangeMm: [number, number] | null;
}

/** Plain-language limits of one circle. Exported so the UI and the docs say the same thing. */
export const LIMITS_OF_ONE_CIRCLE: readonly string[] = [
  "One circle gives the scale and the tilt of ITS OWN plane. It gives no scale at any other depth: a point on the hand " +
    "that is dz farther from the camera than the coin has a scale larger by (Z + dz) / Z.",
  "The tilt is only known as an angle: the ellipse is the same for +tilt and -tilt (the plane could lean toward or away from the camera).",
  "The rotation of the coin about its own normal is invisible (a circle looks the same turned), so the circle gives no " +
    "in-plane orientation: it does not give a full camera pose.",
  "The distance Z = fx * D / major needs the focal length, which the browser does not provide (assumed 55 to 80 degrees).",
];

/**
 * Scale, tilt and distance of the coin's plane from its image ellipse.
 * `opts.intrinsics` gives fx for the distance; `opts.imageSize` with the assumed field-of-view range gives a distance range.
 * The major axis is taken as the true diameter (small perspective corrections, of the order (D / Z)^2, are ignored).
 */
export function coinPlaneScale(
  ellipse: CoinEllipse,
  referenceDiameterMm: number,
  opts: { intrinsics?: Intrinsics; imageSize?: { width: number; height: number }; hfovRangeDeg?: readonly [number, number] } = {},
): CoinPlaneScale {
  const { major_axis_px: major, minor_axis_px: minor } = ellipse;
  if (!(referenceDiameterMm > 0)) throw new Error("reference diameter must be positive");
  if (!(major > 0 && minor > 0)) throw new Error("ellipse axes must be positive");
  const a = Math.max(major, minor);
  const b = Math.min(major, minor);
  const ratio = b / a;
  const tiltDeg = (Math.acos(Math.min(1, ratio)) * 180) / Math.PI;
  const distanceMm = opts.intrinsics ? distanceFromCoin(a, referenceDiameterMm, opts.intrinsics.fx) : null;
  let distanceRangeMm: [number, number] | null = null;
  if (opts.imageSize) {
    const side = Math.max(opts.imageSize.width, opts.imageSize.height);
    const range = opts.hfovRangeDeg ?? ASSUMED_HFOV_DEG;
    const zs = range.map((fov) => distanceFromCoin(a, referenceDiameterMm, side / 2 / Math.tan((fov * Math.PI) / 360)));
    distanceRangeMm = [Math.min(...zs), Math.max(...zs)];
  }
  return {
    mmPerPxMajor: referenceDiameterMm / a,
    mmPerPxMinorApparent: referenceDiameterMm / b,
    axisRatio: ratio,
    tiltDeg,
    tiltSign: "ambiguous",
    tiltAxisImageAngleDeg: ellipse.angle_deg ?? null,
    distanceMm,
    distanceRangeMm,
  };
}

/** Pinhole distance of a circle of diameter D whose image diameter is `majorPx`, for focal length `fxPx`. */
export function distanceFromCoin(majorPx: number, referenceDiameterMm: number, fxPx: number): number {
  return (fxPx * referenceDiameterMm) / majorPx;
}

/** The scale (mm per pixel) in a plane `planeOffsetMm` farther from the camera than the coin's plane (negative: nearer). */
export function scaleAtPlaneOffset(mmPerPxAtCoin: number, distanceMm: number, planeOffsetMm: number): number {
  if (!(distanceMm + planeOffsetMm > 0)) throw new Error("the plane would be behind the camera");
  return (mmPerPxAtCoin * (distanceMm + planeOffsetMm)) / distanceMm;
}

export interface PoseReference {
  id: string;
  name: string;
  gives: string;
  /** Fewest points needed per view (0 where not a point set). */
  minimumPoints: number;
  needsKnownIntrinsics: boolean;
  availability: "option_not_in_product" | "platform_dependent";
  caveats: string[];
}

/**
 * What a full camera pose per view would need. A coin alone is NOT enough (see LIMITS_OF_ONE_CIRCLE). This is the option
 * space for the research, not a statement that any of these exists in the product.
 */
export function requiredReferenceForPose(): PoseReference[] {
  return [
    {
      id: "marker_grid",
      name: "Printed planar marker grid (ArUco / AprilTag style board)",
      gives: "A full 6-degree-of-freedom pose of every view in one shared, metric frame (the printed size sets the scale), and it can carry the coin's plane as well.",
      minimumPoints: 4,
      needsKnownIntrinsics: true,
      availability: "option_not_in_product",
      caveats: ["The customer must print and place it; the printed size must be exact (printer scaling errors are a scale error).", "Needs a marker detector in the browser (not in the bundled OpenCV build; must be checked)."],
    },
    {
      id: "known_quad",
      name: "Four or more coplanar points of known size (for example the corners of a standard sheet of paper)",
      gives: "A homography to the plane, hence a pose with known intrinsics (poseFromPlanarPoints) and metric scale from the paper size.",
      minimumPoints: 4,
      needsKnownIntrinsics: true,
      availability: "option_not_in_product",
      caveats: ["Paper sizes differ (A4 210 x 297 mm, US Letter 215.9 x 279.4 mm) and the sheet must lie flat.", "Corner detection on a plain table needs contrast."],
    },
    {
      id: "coin_plus_landmarks",
      name: "Coin plus the hand's own landmarks",
      gives: "The coin gives its plane's normal (sign ambiguous) and scale; the wrist-to-middle-finger direction gives an in-plane rotation. Together a weak, noisy pose of the camera relative to the palm.",
      minimumPoints: 0,
      needsKnownIntrinsics: true,
      availability: "option_not_in_product",
      caveats: ["Landmark jitter of a few degrees becomes pose error.", "Valid only while the palm is flat; the hand is soft and moves.", "The tilt sign must be settled by another cue."],
    },
    {
      id: "webxr_arcore",
      name: "WebXR session on Android (ARCore visual-inertial tracking)",
      gives: "Metric camera poses from the device's own tracking, and on some devices a depth map (depth-sensing feature).",
      minimumPoints: 0,
      needsKnownIntrinsics: false,
      availability: "platform_dependent",
      caveats: ["Chrome on Android with ARCore only; not Safari or iOS.", "Raw camera frames are not available to a page by default (camera-access is a separate, optional feature).", "Must be started from a user gesture; not testable without a device."],
    },
    {
      id: "gyro_rotation",
      name: "Device orientation / motion sensors (gyroscope)",
      gives: "A rough relative ROTATION between views (drifts); no translation, no scale.",
      minimumPoints: 0,
      needsKnownIntrinsics: false,
      availability: "platform_dependent",
      caveats: ["Needs a permission prompt on iOS; accuracy of a few degrees at best.", "Cannot give the baseline length, so no metric depth by itself."],
    },
  ];
}
