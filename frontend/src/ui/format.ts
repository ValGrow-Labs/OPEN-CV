import type { ConfidenceLevel, MeasurementSource, MeasurementStatus } from "../api/types";

export const MM_PER_INCH = 25.4;

export const fmtMm = (mm: number, digits = 0) => `${mm.toFixed(digits)} mm`;
export const fmtIn = (mm: number, digits = 2) => `${(mm / MM_PER_INCH).toFixed(digits)} in`;

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

export const STATUS: Record<MeasurementStatus, { label: string; tone: Tone }> = {
  valid: { label: "Estimated", tone: "good" },
  low_confidence: { label: "Low confidence", tone: "warn" },
  invalid: { label: "Not reliable", tone: "bad" },
  not_measured: { label: "Not measured", tone: "neutral" },
  user_entered: { label: "You entered", tone: "info" },
};

export const SOURCE: Record<MeasurementSource, string> = {
  camera_landmarks: "Estimated from camera hand landmarks, scaled by the coin",
  camera_model_estimate: "Estimated by a model fitted on tape-measured hands",
  user_entered: "Entered by you",
  not_available: "Cannot be measured from a single camera view",
};

const FINGER_OF_KEY: Record<string, string> = {
  index_length_mm: "index",
  middle_length_mm: "middle",
  ring_length_mm: "ring",
  little_length_mm: "little",
};

/** For a finger refused as "not straight enough": the bend that was measured and its limits. */
export function fingerBendDetail(
  bends: Record<string, { bend_2d_deg: number; bend_3d_deg: number | null; limit_2d_deg: number; limit_3d_deg: number }> | undefined,
  key: string,
  reasons: string[],
): string | undefined {
  const b = bends?.[FINGER_OF_KEY[key]];
  if (!b || !reasons.includes("finger_bent")) return undefined;
  const depth = b.bend_3d_deg === null ? "" : `, ${Math.round(b.bend_3d_deg)}° in the depth estimate (limit ${Math.round(b.limit_3d_deg)}°)`;
  return `Measured bend: ${Math.round(b.bend_2d_deg)}° in the image (limit ${Math.round(b.limit_2d_deg)}°)${depth}.`;
}

export const REASONS: Record<string, string> = {
  out_of_plane: "The thumb usually turns out of the palm plane, so its length is less reliable.",
  unstable: "The value varied between frames.",
  uncertainty_too_large: "The uncertainty is too large for this value to be useful.",
  finger_bent: "This finger was not straight enough to measure.",
  finger_obscured: "This finger was obscured or poorly detected.",
  implausible_value: "The value is outside the expected human range.",
  too_few_frames: "Too few good frames were available for this measurement.",
  requires_validated_model_or_manual_entry: "Needs a tape measurement (or a model validated on reference data).",
};

export const COMPONENTS: Record<string, string> = {
  frame_variation: "Frame-to-frame variation",
  landmark_localisation: "Landmark position",
  coin_scale: "Coin scale",
  tilt: "Hand / coin tilt",
  depth_layer: "Depth: coin vs. joints",
  perspective_and_hand_flatness: "Perspective & hand flatness",
  landmark_definition_prior: "Anatomical definition (prior, unvalidated)",
  validated_residual: "Validated residual error",
};

export const CONFIDENCE: Record<ConfidenceLevel, { label: string; text: string }> = {
  clear: { label: "Clear", text: "One size covers your measurement even allowing for measurement uncertainty." },
  likely: { label: "Likely", text: "This size is most likely; the neighbouring size is possible." },
  borderline: { label: "Borderline", text: "Your measurement sits on a size boundary, so both sizes may fit." },
  uncertain: { label: "Uncertain", text: "The measurement uncertainty spans several sizes. Confirm with a tape measure." },
};

export const MEASUREMENT_NAMES: Record<string, string> = {
  hand_length_mm: "Hand length",
  hand_circumference_mm: "Hand circumference",
  palm_breadth_mm: "Palm breadth (skin edge to skin edge)",
};

export const MANUAL_LABELS: Record<string, string> = {
  hand_length_mm: "Hand length",
  hand_circumference_mm: "Hand circumference",
  palm_breadth_mm: "Palm breadth (skin edge to skin edge)",
};
