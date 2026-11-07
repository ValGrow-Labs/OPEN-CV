// Every threshold of the hand-pose reader. ALL PROVISIONAL: chosen from hand anatomy and from synthetic hands, not
// validated against real people's hands or real MediaPipe output. Angles are in degrees.
import type { FingerName, HandPoseLabel } from "./types";

// ---- Finger flexion (the sum of the deviations from straight at the finger's joints) ---------------------------
/** A finger is "extended" below this total flexion. A relaxed straight finger measures about 10 to 40. */
export const FINGER_EXTENDED_MAX_DEG = 60;
/** A finger is "bent" at or above this total flexion. A curled finger measures 140 to 270, a loose fist about 200+. */
export const FINGER_BENT_MIN_DEG = 140;
/** The thumb has two joints in the chain used (MCP and IP), so its range is smaller. */
export const THUMB_EXTENDED_MAX_DEG = 35;
export const THUMB_BENT_MIN_DEG = 70;

// ---- Spread (angle between neighbouring extended fingers, from knuckle to tip) ---------------------------------
// Closed fingers measure 0 to 8 degrees, a natural open hand 10 to 16, deliberately spread fingers 18 and more. The
// bands are wide because the angle between two noisy fingertip directions jitters by a few degrees.
/** The mean gap of the extended neighbours below this is "together" (if also no single gap is wide). */
export const SPREAD_TOGETHER_MAX_DEG = 9;
/** A single gap at least this wide stops the fingers counting as "together". */
export const SPREAD_TOGETHER_PAIR_MAX_DEG = 15;
/** A mean gap at least this wide (and no gap closed, i.e. every gap at least SPREAD_TOGETHER_MAX_DEG) is "apart". Otherwise "mixed". */
export const SPREAD_APART_MIN_DEG = 17;

// ---- Thumb out -----------------------------------------------------------------------------------------------
/** Angle between the thumb (CMC to tip) and the index metacarpal (wrist to index knuckle) above which the thumb is out. */
export const THUMB_OUT_MIN_DEG = 30;
/** And the thumb tip must be at least this far from the index knuckle, in palm lengths (wrist to middle knuckle). */
export const THUMB_OUT_MIN_REACH = 0.6;

// ---- 2D fallback: foreshortening of a finger that bends toward the camera --------------------------------------
/** Tip-to-wrist distance in palm lengths of a straight finger (anatomical proportions, provisional). */
export const REACH_EXTENDED: Readonly<Record<Exclude<FingerName, "thumb">, number>> = {
  index: 1.9,
  middle: 2.0,
  ring: 1.9,
  little: 1.65,
};
/** Tip-to-wrist distance (palm lengths) of a fully curled finger seen from the front: the tip lies about at its own knuckle. */
export const REACH_FIST: Readonly<Record<Exclude<FingerName, "thumb">, number>> = { index: 1.0, middle: 1.0, ring: 0.95, little: 0.88 };
/** In 2D, a finger whose projected knuckle-to-PIP bone is shorter than this many palm lengths (straight: about 0.46) is foreshortened. */
export const FORESHORTEN_PROX_MIN = 0.25;
/** ... or whose projected PIP-to-tip chord is shorter than this (straight: about 0.52). */
export const FORESHORTEN_CHORD_MIN = 0.29;
/** The flexion a fully curled finger is given by the reach rule (the rule is quadratic in the lost reach). */
export const REACH_BEND_FULL_DEG = 270;

// ---- Confidence ----------------------------------------------------------------------------------------------
export const CONFIDENCE_WORLD = 0.9;
export const CONFIDENCE_2D = 0.6;
/** A finger this many degrees away from its nearest threshold counts as a clear call. */
export const MARGIN_SPAN_DEG = 25;

// ---- Smoothing -----------------------------------------------------------------------------------------------
/** A new label (or finger state) must win this long before it replaces the current one. */
export const HOLD_MS_DEFAULT = 250;
/** A label that the latest frames keep contradicting is replaced after this many times the hold time anyway. */
export const STALE_FACTOR = 4;
/** Time constants of the light smoothing of the bend angles and the confidence. */
export const BEND_SMOOTH_MS = 80;
export const CONFIDENCE_SMOOTH_MS = 200;

/** The most often the panel's spoken text may change. */
export const ANNOUNCE_MIN_INTERVAL_MS = 250;

// ---- Wording -------------------------------------------------------------------------------------------------
export const LABEL_TEXT: Readonly<Record<HandPoseLabel, string>> = {
  open_palm: "Open palm",
  fist: "Closed fist",
  fingers_spread: "Fingers spread",
  fingers_together: "Fingers together",
  thumb_extended: "Thumb extended",
  index_extended: "Index finger extended",
  pointing: "Pointing",
  relaxed: "Relaxed hand",
  unknown: "Hand not clear",
};

export const FINGER_TITLE: Readonly<Record<FingerName, string>> = {
  thumb: "Thumb",
  index: "Index",
  middle: "Middle",
  ring: "Ring",
  little: "Pinky",
};
