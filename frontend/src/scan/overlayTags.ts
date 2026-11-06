// The labels the 3D camera overlay draws on the hand while scanning: each finger's length near its tip and
// the hand length halfway up the hand (the same live numbers the 2D tags used to show).
import type { HandStageTag } from "../hand3d/HandStage";
import { FINGER_TIPS, type FingerName, type LiveLengths } from "../vision/liveLengths";
import { MIDDLE_TIP, WRIST } from "../vision/geometry";

export function overlayTags(live: LiveLengths | null): HandStageTag[] | undefined {
  if (!live) return undefined;
  const fingers = (Object.keys(FINGER_TIPS) as FingerName[]).map((f) => ({
    joint: FINGER_TIPS[f][1],
    label: `${Math.round(live.fingersMm[f])} mm`,
  }));
  return [...fingers, { joint: MIDDLE_TIP, between: [WRIST, MIDDLE_TIP] as const, label: `${Math.round(live.handMm)} mm`, emphasis: true }];
}
