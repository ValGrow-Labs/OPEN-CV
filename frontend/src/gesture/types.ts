// Types of the hand-pose reader. Display only: this folder READS MediaPipe landmarks and never touches a
// measurement, the coin pipeline or any setting.

export type FingerName = "thumb" | "index" | "middle" | "ring" | "little";

export type FingerState = "extended" | "half_bent" | "bent";

export interface FingerPose {
  name: FingerName;
  state: FingerState;
  /** Total flexion in degrees over the finger's joints (0 = perfectly straight). Thumb: its two joints only. */
  bendDeg: number;
}

export type HandPoseLabel =
  | "open_palm"
  | "fist"
  | "fingers_spread"
  | "fingers_together"
  | "thumb_extended"
  | "index_extended"
  | "pointing"
  | "relaxed"
  | "unknown";

export interface HandPoseReading {
  label: HandPoseLabel;
  /** Customer wording, for example "Open palm". */
  text: string;
  /** Five fingers, thumb first. */
  fingers: FingerPose[];
  /** Neighbouring fingers (index to little) that are extended: all close, all apart, or a mixture. */
  spread: "together" | "apart" | "mixed";
  thumbOut: boolean;
  /** 0 to 1: lower when only 2D landmarks were used and when a finger is close to a threshold. */
  confidence: number;
  /** True when the 3D world landmarks were used (true joint angles), false for image landmarks (2D angles). */
  usedWorld: boolean;
}

/** The fingers in the order of a reading's `fingers` array. */
export const FINGER_ORDER: readonly FingerName[] = ["thumb", "index", "middle", "ring", "little"];
