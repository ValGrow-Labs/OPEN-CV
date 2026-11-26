// The alignment guide of the capture screen (pure parts: no DOM). A box sits in the camera view with an arrow at each of
// its four corners; a corner turns green when the corner of the box around the hand reaches it, and all four are green
// once the hand is lined up (inside the box, filling it, fingers up). It is feedback for the customer only: it changes
// no threshold, rejects no frame and feeds no measurement.
import type { Landmark } from "../hand3d/handModel";
import type { PhaseId } from "./coverage";
import { type Box, type Size, frameTarget, videoToCanvas } from "./swarm";

export type Corner = "tl" | "tr" | "bl" | "br";
export const CORNERS: readonly Corner[] = ["tl", "tr", "bl", "br"];

export type AlignHint = "show_hand" | "closer" | "back" | "left" | "right" | "up" | "down" | "upright" | "aligned";

export const ALIGN_MESSAGES: Record<AlignHint, string> = {
  show_hand: "Line your hand up with the box",
  closer: "Move your hand a little closer",
  back: "Move your hand back a little",
  left: "Move your hand left",
  right: "Move your hand right",
  up: "Move your hand up",
  down: "Move your hand down",
  upright: "Point your fingers up",
  aligned: "Lined up. Hold it there",
};

/** Width over height of the guide box: about that of an open hand with its margin. */
export const GUIDE_ASPECT = 0.8;
/** How far a hand edge may poke out of the box (share of the box's size) before that corner is not lined up. */
export const EDGE_TOLERANCE = 0.035;
/** How far inside the box a hand edge may stay (share of the box's size) and still count as reaching its corner. */
export const EDGE_SLACK = 0.2;
/** How far the fingers may lean from straight up (degrees). */
export const MAX_TILT_DEG = 25;
/** Once lined up, the same limits are a little wider so the corners do not flicker at the edge. */
export const HOLD_TOLERANCE = 0.07;
export const HOLD_SLACK = 0.26;
export const HOLD_TILT_DEG = 32;

/** The box the hand should fill: centred, a little above the middle (the hint sits at the bottom), as large as fits. */
export function guideBox(w: number, h: number): Box {
  const bh = Math.max(1, Math.min(h * 0.74, (w * 0.84) / GUIDE_ASPECT));
  const bw = bh * GUIDE_ASPECT;
  const cx = w / 2;
  const cy = h * 0.47;
  return { x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 };
}

/** The box around the hand in view pixels (the same box the scan frame follows), from the landmarks in video pixels. */
export function handBoxInView(landmarks: readonly Landmark[], video: Size, view: Size, mirror: boolean): Box | null {
  if (landmarks.length < 21 || video.width <= 0 || video.height <= 0 || view.width <= 0 || view.height <= 0) return null;
  const pts = landmarks.map((p) => {
    const m = videoToCanvas(p, video, view, mirror);
    return { ...p, x: m.x, y: m.y };
  });
  const b = frameTarget(pts);
  return [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite) ? b : null;
}

/** How far the fingers lean from straight up in the view, in degrees (0 = up), from the wrist to the middle knuckle. */
export function tiltDeg(landmarks: readonly Landmark[], video: Size, view: Size, mirror: boolean): number | null {
  if (landmarks.length < 21) return null;
  const a = videoToCanvas(landmarks[0], video, view, mirror);
  const b = videoToCanvas(landmarks[9], video, view, mirror);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-6) return null;
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

export interface AlignResult {
  /** Which corner arrows are lit green. */
  corners: Record<Corner, boolean>;
  /** All four are lit and the fingers point up: the hand is lined up. */
  aligned: boolean;
  /** What to tell the customer next, or null when nothing is needed. */
  hint: AlignHint;
}

export const NO_HAND: AlignResult = { corners: { tl: false, tr: false, bl: false, br: false }, aligned: false, hint: "show_hand" };

export interface AlignInput {
  /** The box around the hand in view pixels, or null while no hand is tracked. */
  hand: Box | null;
  /** Lean of the fingers from straight up in degrees, or null when unknown. */
  tilt: number | null;
  /** The view's size in pixels. */
  view: Size;
  phase: PhaseId;
  /** Whether the previous result was lined up (wider limits, so the arrows do not flicker). */
  wasAligned?: boolean;
}

/** Compare the box around the hand with the guide box. Per edge, `inside` is how far the hand's edge sits inside the guide's
 *  edge as a share of the guide's size (negative = poking out). A corner is lit when both of its edges are within
 *  [-tolerance, slack]. In the Side view the hand is on its edge and narrow, so its left and right edges only have to stay
 *  inside the box, and the fingers need not point up. */
export function evaluateAlignment(input: AlignInput): AlignResult {
  const { hand, tilt, view, phase, wasAligned = false } = input;
  if (!hand) return NO_HAND;
  const t = guideBox(view.width, view.height);
  const tw = t.x1 - t.x0;
  const th = t.y1 - t.y0;
  const tol = wasAligned ? HOLD_TOLERANCE : EDGE_TOLERANCE;
  const slack = wasAligned ? HOLD_SLACK : EDGE_SLACK;
  const left = (hand.x0 - t.x0) / tw;
  const right = (t.x1 - hand.x1) / tw;
  const top = (hand.y0 - t.y0) / th;
  const bottom = (t.y1 - hand.y1) / th;
  const free = phase === "side";
  const okH = (v: number) => (free ? v >= -tol : v >= -tol && v <= slack);
  const okV = (v: number) => v >= -tol && v <= slack;
  const corners: Record<Corner, boolean> = {
    tl: okH(left) && okV(top),
    tr: okH(right) && okV(top),
    bl: okH(left) && okV(bottom),
    br: okH(right) && okV(bottom),
  };
  const maxTilt = wasAligned ? HOLD_TILT_DEG : MAX_TILT_DEG;
  const upright = free || tilt === null || Math.abs(tilt) <= maxTilt;
  const aligned = corners.tl && corners.tr && corners.bl && corners.br && upright;
  if (aligned) return { corners, aligned, hint: "aligned" };

  // What to say: poking out first (move away from that side), then too far inside (move towards it), then the lean.
  const pokeL = left < -tol;
  const pokeR = right < -tol;
  const pokeT = top < -tol;
  const pokeB = bottom < -tol;
  let hint: AlignHint | null = null;
  if ((pokeL && pokeR) || (pokeT && pokeB) || ((pokeL || pokeR) && (pokeT || pokeB))) hint = "back";
  else if (pokeL) hint = "right";
  else if (pokeR) hint = "left";
  else if (pokeT) hint = "down";
  else if (pokeB) hint = "up";
  if (!hint) {
    const farL = !free && left > slack;
    const farR = !free && right > slack;
    const farT = top > slack;
    const farB = bottom > slack;
    if ((farL && farR) || (farT && farB)) hint = "closer";
    else if (farL) hint = "left";
    else if (farR) hint = "right";
    else if (farT) hint = "up";
    else if (farB) hint = "down";
  }
  if (!hint && !upright) hint = "upright";
  return { corners, aligned: false, hint: hint ?? "closer" };
}

/** Same lit corners and verdict (the hint can change without anything being redrawn). */
export function sameAlignment(a: AlignResult | null, b: AlignResult | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.aligned === b.aligned && a.hint === b.hint && CORNERS.every((c) => a.corners[c] === b.corners[c]);
}
