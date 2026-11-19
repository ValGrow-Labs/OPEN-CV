import type { ConfidenceLevel, Measurement, MeasurementSource, MeasurementStatus } from "../api/types";

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
  finger_tilted: "This finger looked tilted towards or away from the camera, which can make it look shorter.",
};

/** The thumb and the four fingers' length keys. */
export const FINGER_KEY_RE = /^(thumb|index|middle|ring|little)_length_mm$/;

const FRAME_EXCLUSION_WORDS: Record<string, string> = {
  finger_bent: "bent",
  finger_obscured: "hidden or poorly detected",
  implausible_value: "outside the expected size",
  outlier_frame: "far from the other frames",
};

/** Why frames did not count for a finger, and how to get a better reading. Advice only: nothing here changes
 *  a gate, a value or a status. */
export function fingerFrameDetail(m: Measurement | undefined): string | undefined {
  if (!m || !FINGER_KEY_RE.test(m.key)) return undefined;
  const left = Object.entries(m.frame_exclusions ?? {})
    .filter(([k, n]) => n > 0 && FRAME_EXCLUSION_WORDS[k])
    .map(([k, n]) => `${n} ${FRAME_EXCLUSION_WORDS[k]}`);
  const flagged = m.reasons.some((r) => ["finger_tilted", "finger_bent", "finger_obscured", "too_few_frames"].includes(r));
  if (left.length === 0 && !flagged) return undefined;
  const lead = left.length ? `Frames left out for this finger: ${left.join(", ")}. ` : "";
  return `${lead}For a better reading, keep your hand flat and still with your fingers straight and spread.`;
}

export const COMPONENTS: Record<string, string> = {
  frame_variation: "Frame-to-frame variation",
  landmark_localisation: "Landmark position",
  coin_scale: "Coin scale",
  tilt: "Hand / coin tilt",
  depth_layer: "Depth: coin vs. joints",
  perspective_and_hand_flatness: "Perspective & hand flatness",
  landmark_definition_prior: "Anatomical definition (prior, unvalidated)",
  validated_residual: "Validated residual error",
  view_disagreement: "Disagreement between views",
  finger_foreshortening: "Finger tilt (looks shorter when tilted)",
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

/** The crease-to-tip estimate line of a thumb or finger (detailed page), or undefined when the server sent none. */
export function creaseLine(m: Measurement | undefined): string | undefined {
  if (!m || !FINGER_KEY_RE.test(m.key) || m.crease_to_tip_mm == null) return undefined;
  const [lo, hi] = m.crease_interval95_mm ?? [null, null];
  const range = lo != null && hi != null ? ` (95%: ${Math.round(lo)} to ${Math.round(hi)} mm)` : "";
  const sigma = m.crease_uncertainty_mm != null ? ` ±${m.crease_uncertainty_mm.toFixed(1)} mm` : "";
  return `Crease to tip (estimate): ≈ ${Math.round(m.crease_to_tip_mm)} mm${sigma}${range}`;
}

/** What the crease estimate is, and what it rests on, for the "How it's measured" text. */
export function creaseHow(m: Measurement | undefined): string | undefined {
  if (!m || !FINGER_KEY_RE.test(m.key) || m.crease_to_tip_mm == null) return undefined;
  const t = m.crease_t != null ? `${Math.round(m.crease_t * 100)}%` : "a fixed share";
  const where = m.key.startsWith("thumb") ? "the thumb's knuckle-to-middle-joint segment" : "the knuckle-to-middle-joint segment of the finger";
  return `Crease to tip is the glove-industry finger length. The camera has no crease point, so it is estimated: the knuckle-to-tip length minus ${t} of ${where}. That share is an ASSUMED standard hand proportion (fitted to published finger proportions on one hand's landmarks), not measured on you and not validated; its uncertainty (about ±20% of that segment) is included.`;
}

/** A thumb or finger the server would hide (status invalid) that still carries its number as information. The
 *  result page shows it with the wide interval and a "Very uncertain" tag; the size never uses it. */
export function veryUncertainFinger(m: Measurement | undefined): { mm: number; sigma: number | null; interval: [number, number] | null; why: string } | null {
  if (!m || !FINGER_KEY_RE.test(m.key) || m.status !== "invalid" || m.value_mm !== null || m.info_value_mm == null) return null;
  const reason = m.reasons.map((r) => REASONS[r]).find(Boolean);
  return {
    mm: m.info_value_mm,
    sigma: m.info_uncertainty_mm ?? null,
    interval: m.info_interval95_mm ?? null,
    why: `${reason ?? "The camera could not pin this finger down."} Shown for information; not used for your glove size.`,
  };
}
