// Live, per-frame capture guidance. These checks mirror the server's frame gates so the
// customer gets immediate feedback; the server re-applies all of them authoritatively.
import type { CalibrationParams, CaptureParams, FrameObservation, Point } from "../api/types";
import {
  LONG_FINGERS,
  MIDDLE_TIP,
  PALM_POLYGON,
  WRIST,
  chainBendDeg,
  dist,
  insideFrame,
  jitterFraction,
  palmTiltDeg,
  pointInPolygon,
} from "./geometry";

export type LiveCode =
  | "no_hand"
  | "hand_out_of_frame"
  | "hand_too_small"
  | "fingers_bent"
  | "index_finger_bent"
  | "fingers_touching"
  | "palm_not_flat"
  | "too_dark"
  | "too_bright"
  | "coin_missing"
  | "coin_not_on_palm"
  | "coin_tilted"
  | "coin_too_small"
  | "coin_occluded"
  | "coin_blurry"
  | "coin_glare"
  | "coin_low_contrast"
  | "coin_irregular_boundary"
  | "coin_low_confidence"
  | "coin_ambiguous"
  | "too_close"
  | "coin_not_found"
  | "hold_still";

export const LIVE_MESSAGES: Record<LiveCode, string> = {
  no_hand: "Show your open palm to the camera",
  hand_out_of_frame: "Move your hand into the guide",
  hand_too_small: "Bring your hand closer to the camera",
  fingers_bent: "Straighten your fingers",
  index_finger_bent: "Straighten your index finger",
  fingers_touching: "Spread your fingers slightly",
  palm_not_flat: "Hold your palm flat, facing the camera",
  too_dark: "It's too dark. Move to brighter light",
  too_bright: "Too bright. Avoid direct light behind the camera",
  coin_missing: "Place the coin flat in the centre of your palm",
  coin_not_found: "Place the coin flat in the centre of your palm",
  coin_not_on_palm: "Move the coin to the centre of your palm",
  coin_tilted: "Keep your palm and the coin flat to the camera",
  coin_too_small: "Bring your hand a little closer",
  coin_occluded: "Make sure the whole coin is visible",
  coin_blurry: "Hold still, the image is blurry",
  coin_glare: "Glare on the coin. Tilt away from the light",
  coin_low_contrast: "Use brighter, even lighting",
  coin_irregular_boundary: "Use a single coin lying flat",
  coin_low_confidence: "Hold still so the coin can be measured",
  coin_ambiguous: "Use one coin only and keep other round objects out of view",
  too_close: "Move your hand a little farther from the camera",
  hold_still: "Hold still…",
};

const COIN_CODES = new Set<string>([
  "coin_too_small",
  "coin_occluded",
  "coin_blurry",
  "coin_glare",
  "coin_low_contrast",
  "coin_irregular_boundary",
  "coin_low_confidence",
  "coin_ambiguous",
]);

/** Camera distance implied by the coin's size, for an assumed horizontal FOV range (geometric mean). */
export function estimatedDistanceMm(
  coinMajorPx: number,
  diameterMm: number,
  imageW: number,
  imageH: number,
  hfovDeg: [number, number],
): number {
  const longSide = Math.max(imageW, imageH);
  const [a, b] = hfovDeg.map((fov) => ((longSide / 2) / Math.tan((fov * Math.PI) / 360)) * diameterMm / coinMajorPx);
  return Math.sqrt(a * b);
}

export interface ScaleContext {
  referenceDiameterMm: number;
  assumedHfovDeg: [number, number];
}

export interface LiveResult {
  ok: boolean;
  codes: LiveCode[];
  message: string;
}

export function evaluateFrame(
  frame: FrameObservation | null,
  previousLandmarks: Point[] | null,
  capture: CaptureParams,
  calibration: CalibrationParams,
  scale?: ScaleContext,
): LiveResult {
  const codes: LiveCode[] = [];
  if (!frame) return result(["no_hand"]);
  const lm = frame.landmarks;
  const w = frame.image_width;
  const h = frame.image_height;

  if (!insideFrame(lm, w, h, capture.edge_margin_fraction)) codes.push("hand_out_of_frame");
  if (dist(lm[WRIST], lm[MIDDLE_TIP]) < capture.min_hand_length_fraction * Math.min(w, h)) codes.push("hand_too_small");
  const index = LONG_FINGERS.index;
  const indexBent2d = chainBendDeg(lm, index);
  const indexBent3d = frame.world_landmarks ? chainBendDeg(frame.world_landmarks, index, true) : 0;
  const indexBent = !(indexBent2d <= capture.max_finger_bend_deg) || !(indexBent3d <= capture.max_finger_bend_deg_3d);

  const middle = LONG_FINGERS.middle;
  const middleBent2d = chainBendDeg(lm, middle);
  const middleBent3d = frame.world_landmarks ? chainBendDeg(frame.world_landmarks, middle, true) : 0;
  const middleBent = !(middleBent2d <= capture.max_finger_bend_deg) || !(middleBent3d <= capture.max_finger_bend_deg_3d);

  if (middleBent && indexBent) {
    codes.push("fingers_bent");
  } else if (indexBent) {
    codes.push("index_finger_bent");
  } else if (middleBent) {
    codes.push("fingers_bent");
  }

  // Finger separation check: adjacent fingertips must have clearance
  const handLen = dist(lm[WRIST], lm[MIDDLE_TIP]);
  const minFingerGap = handLen * 0.055;
  const tips = [4, 8, 12, 16, 20];
  for (let i = 1; i < tips.length - 1; i++) {
    if (dist(lm[tips[i]], lm[tips[i + 1]]) < minFingerGap) {
      codes.push("fingers_touching");
      break;
    }
  }

  if (frame.world_landmarks && palmTiltDeg(frame.world_landmarks) > capture.max_palm_tilt_deg_model) codes.push("palm_not_flat");
  if (frame.brightness !== null) {
    if (frame.brightness < capture.brightness_range[0]) codes.push("too_dark");
    else if (frame.brightness > capture.brightness_range[1]) codes.push("too_bright");
  }

  const coin = frame.coin;
  if (!coin) {
    codes.push("coin_missing");
  } else {
    for (const r of coin.reasons) if (COIN_CODES.has(r)) codes.push(r as LiveCode);
    const poly = PALM_POLYGON.map((i) => lm[i]);
    if (calibration.require_coin_on_palm && !pointInPolygon(coin.center_x, coin.center_y, poly)) codes.push("coin_not_on_palm");
    const tilt = (Math.acos(Math.min(1, coin.minor_axis_px / coin.major_axis_px)) * 180) / Math.PI;
    if (tilt > calibration.max_tilt_deg) codes.push("coin_tilted");
    if (
      scale &&
      coin.major_axis_px > 0 &&
      estimatedDistanceMm(coin.major_axis_px, scale.referenceDiameterMm, w, h, scale.assumedHfovDeg) < capture.min_camera_distance_mm
    ) {
      codes.push("too_close");
    }
  }
  if (codes.length === 0 && previousLandmarks && jitterFraction(lm, previousLandmarks) > capture.max_landmark_jitter_fraction) {
    codes.push("hold_still");
  }
  return result(codes);
}

function result(codes: LiveCode[]): LiveResult {
  return { ok: codes.length === 0, codes, message: codes.length ? LIVE_MESSAGES[codes[0]] : "Hold still while we measure" };
}
