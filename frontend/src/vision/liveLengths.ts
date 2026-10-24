// Rough lengths from a single camera frame, shown on the camera picture while scanning so the
// customer sees the measurement happening. They are straight-line landmark distances scaled by
// this frame's coin; the reported values come from the server, which combines all frames.
import type { Point } from "../api/types";
import { dist, MIDDLE_TIP, WRIST } from "./geometry";

export type FingerName = "thumb" | "index" | "middle" | "ring" | "little";

/** Knuckle (MCP) and tip landmark of each finger. */
export const FINGER_TIPS: Record<FingerName, [number, number]> = {
  thumb: [2, 4],
  index: [5, 8],
  middle: [9, 12],
  ring: [13, 16],
  little: [17, 20],
};

export interface LiveLengths {
  handMm: number;
  fingersMm: Record<FingerName, number>;
}

export function liveLengths(landmarks: Point[], coinMajorPx: number, coinDiameterMm: number): LiveLengths | null {
  if (!(coinMajorPx > 0) || !(coinDiameterMm > 0) || landmarks.length < 21) return null;
  const pxPerMm = coinMajorPx / coinDiameterMm;
  const fingersMm = Object.fromEntries(
    (Object.keys(FINGER_TIPS) as FingerName[]).map((f) => {
      const [a, b] = FINGER_TIPS[f];
      return [f, dist(landmarks[a], landmarks[b]) / pxPerMm];
    }),
  ) as Record<FingerName, number>;
  return { handMm: dist(landmarks[WRIST], landmarks[MIDDLE_TIP]) / pxPerMm, fingersMm };
}

/** Where to put a finger's label: just beyond the tip, along the finger's direction. */
export function labelAnchor(landmarks: Point[], finger: FingerName, offsetPx: number): Point {
  const [, tip] = FINGER_TIPS[finger];
  const t = landmarks[tip];
  const prev = landmarks[tip - 1];
  const len = dist(prev, t) || 1;
  return { x: t.x + ((t.x - prev.x) / len) * offsetPx, y: t.y + ((t.y - prev.y) / len) * offsetPx, z: 0 };
}
