// The "focus mask": while the 3D layer draws the measuring, everything in the camera picture except the hand and
// the coin is shown black, so the glowing hand stands out and the room stays out of sight. It is drawn on its own
// small canvas (longest side config live_scan.overlay_3d.focus_mask_max_px) that CSS stretches over the video,
// so its cost does not depend on the camera resolution, and it is DISPLAY ONLY: the hand and the coin are still
// found in the full camera frame, so nothing about a measurement depends on it.
import type { Point } from "../api/types";
import { traceSmoothContour } from "./handOutline";

export interface FocusMaskParams {
  /** How far the clear window reaches beyond the hand outline, and how soft its edge is (fractions of the hand length). */
  margin: number;
  feather: number;
  /** Time for the black to come in (full range) while a hand is tracked, and to go when it is lost. */
  fadeInMs: number;
  fadeOutMs: number;
  /** How black it gets, 0..1. */
  maxAlpha: number;
}

/** What stays visible: the hand outline (a closed contour in video pixels), its length and the coin, if one was seen. */
export interface FocusShape {
  contour: Point[];
  handLength: number;
  coin: { x: number; y: number; rx: number; ry: number; angleRad: number } | null;
}

/** The black's opacity for the next frame: it rises to ``maxAlpha`` while a hand is tracked and falls back to 0
 *  when it is lost (the customer always gets the full picture back to find their hand). */
export function nextFocusAlpha(prev: number, handTracked: boolean, dtMs: number, p: FocusMaskParams): number {
  const step = (ms: number) => (ms > 0 ? (Math.max(0, dtMs) / ms) * p.maxAlpha : p.maxAlpha);
  if (handTracked) return Math.min(p.maxAlpha, prev + step(p.fadeInMs));
  return Math.max(0, prev - step(p.fadeOutMs));
}

/** Extra clearance around the coin so its rim is never cut, in fractions of its radius. */
const COIN_CLEARANCE = 0.12;

/** The soft edge: a few faint strokes, widest first, under the solid window ([how far into the feather, how much
 *  black each removes]). A canvas blur would cost many times more than everything else here; with these the
 *  edge steps down in three small steps and the CSS stretch of the small canvas over the video smooths it. */
const FEATHER_STEPS: readonly (readonly [number, number])[] = [
  [1, 0.25],
  [0.66, 0.35],
  [0.33, 0.5],
];

/** How the shape's coordinates map onto the canvas: ``width`` x ``height`` is the area the shape lives in (the
 *  video's pixels) and ``scale`` the canvas pixels per such pixel (a small canvas has scale below 1). */
export interface FocusView {
  width: number;
  height: number;
  scale: number;
}

/** The canvas size for a video of ``width`` x ``height`` with its longest side capped at ``maxPx`` (same aspect). */
export function maskCanvasSize(width: number, height: number, maxPx: number): { width: number; height: number; scale: number } {
  const scale = Math.min(1, maxPx / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** Black over the whole canvas at ``alpha``, then clear windows (soft-edged) where the hand and the coin are.
 *  The shape is in video pixels; ``view`` maps it onto the (smaller) canvas. */
export function drawFocusMask(
  ctx: CanvasRenderingContext2D,
  shape: FocusShape,
  alpha: number,
  p: FocusMaskParams,
  view: FocusView = { width: ctx.canvas.width, height: ctx.canvas.height, scale: 1 },
): void {
  if (!(alpha > 0) || shape.contour.length < 3) return;
  const { width, height, scale } = view;
  const margin = p.margin * shape.handLength;
  const feather = p.feather * shape.handLength;

  ctx.save();
  ctx.scale(scale, scale); // from here on everything is in video pixels
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
  ctx.fillRect(0, 0, width, height);

  // Erase: faint wide strokes first for the soft edge, then the solid window (the outline, widened by the margin).
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.lineJoin = "round";
  traceSmoothContour(ctx, shape.contour);
  if (feather > 0) {
    for (const [reach, a] of FEATHER_STEPS) {
      ctx.globalAlpha = a;
      ctx.lineWidth = 2 * (margin + feather * reach);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2 * margin;
  ctx.fill();
  if (margin > 0) ctx.stroke();
  const c = shape.coin;
  if (c) {
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, c.rx * (1 + COIN_CLEARANCE), c.ry * (1 + COIN_CLEARANCE), c.angleRad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
