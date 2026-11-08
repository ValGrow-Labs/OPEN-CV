// Drawing of the EXPERIMENTAL dense-scan page. The frozen still is a canvas of the camera frame's own size. The dot and
// line layers are sized to how the frame is SHOWN (CSS px x devicePixelRatio, same aspect as the frame) and draw in
// source-pixel coordinates through a transform, so dots and lines are crisp on a phone and line up with the still
// (every layer fills the same box with object-fit: contain). The 21 landmarks are a thin supporting layer on the live
// picture only.
//
// DISPLAY ONLY: when the lattice is too fine to read on this screen, the dot layer draws a coarser display lattice
// (every k-th point). The point arrays, the counters, the processing and the export always use every point.
import type { Point } from "../../../api/types";
import { HAND_CONNECTIONS } from "../../../vision/geometry";
import type { Pt } from "../../common";
import type { CoinSnapshot } from "../../capture/types";
import type { SurfacePoint } from "../core";
import { displayStride, displaySubset, READABLE_PITCH_CSS } from "./helpers";

/** How the frame is shown: CSS px per source px, and the device pixel ratio. */
export interface View {
  scale: number;
  dpr: number;
}

function size(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas.getContext("2d");
}

/** Size a layer to the frame as displayed and set the transform so drawing is in source px. */
function sizeToView(canvas: HTMLCanvasElement, frameW: number, frameH: number, view: View): CanvasRenderingContext2D | null {
  const k = Math.max(1e-3, view.scale * view.dpr);
  const ctx = size(canvas, Math.max(1, Math.round(frameW * k)), Math.max(1, Math.round(frameH * k)));
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(canvas.width / frameW, 0, 0, canvas.height / frameH, 0, 0);
  return ctx;
}

/** The supporting tracking layer: thin, translucent bones and small joints, and the coin outline. Not the main effect. */
export function drawLiveLandmarks(canvas: HTMLCanvasElement, landmarks: Point[] | null, coin: CoinSnapshot | null, w: number, h: number): void {
  const ctx = size(canvas, w, h);
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const s = Math.max(1, Math.min(w, h) / 540);
  if (landmarks) {
    ctx.lineWidth = 1.2 * s;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(landmarks[a].x, landmarks[a].y);
      ctx.lineTo(landmarks[b].x, landmarks[b].y);
    }
    ctx.stroke();
    ctx.fillStyle = "rgba(31,94,234,0.75)";
    for (const p of landmarks) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (coin?.found) {
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = coin.accepted ? "rgba(22,163,74,0.9)" : "rgba(217,119,6,0.9)";
    ctx.beginPath();
    ctx.ellipse(coin.center_x, coin.center_y, coin.major_axis_px / 2, coin.minor_axis_px / 2, (coin.angle_deg * Math.PI) / 180, 0, Math.PI * 2);
    ctx.stroke();
  }
}

export function clearCanvas(canvas: HTMLCanvasElement | null): void {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function drawStill(canvas: HTMLCanvasElement, pixels: ImageData): void {
  const ctx = size(canvas, pixels.width, pixels.height);
  ctx?.putImageData(pixels, 0, 0);
}

/** A darker cyan with a thin dark edge, so a dot stands out on light and dark skin and on a white background. */
export const DOT_ACCEPTED = "#00b2e3";
export const DOT_REJECTED = "#ef4444";
export const DOT_EDGE = "rgba(4,28,58,0.72)";

export interface DotDisplay {
  /** Every k-th lattice point in each direction is drawn (1 = all). */
  k: number;
  /** On-screen pitch of the full lattice and of the drawn lattice, CSS px. */
  pitchCss: number;
  shownPitchCss: number;
  /** Accepted points drawn now, and all accepted points (all are kept for processing). */
  shownAccepted: number;
  totalAccepted: number;
  /** Canvas pixel size of the dot layer. */
  canvas: { width: number; height: number };
}

/** The dot layer: points are drawn once, as the scan line reaches them (each frame draws only the newly passed ones).
 *  `finish()` redraws the accepted points only (the rejected ones were shown briefly, then hidden). */
export class DotLayer {
  private order: number[] = [];
  private next = 0;
  private lineY = -Infinity;
  private finished = false;
  private dotSrc = 2;
  private edgeSrc = 0.5;
  private ctx: CanvasRenderingContext2D | null = null;
  info: DotDisplay;

  constructor(
    private canvas: HTMLCanvasElement,
    private points: readonly SurfacePoint[],
    private frameW: number,
    private frameH: number,
    private spacingPx: number,
    view: View,
  ) {
    this.info = this.layout(view);
  }

  private layout(view: View): DotDisplay {
    this.ctx = sizeToView(this.canvas, this.frameW, this.frameH, view);
    const k = displayStride(this.spacingPx, view.scale, READABLE_PITCH_CSS);
    const subset = displaySubset(this.points, k);
    this.order = subset.sort((a, b) => this.points[a].y - this.points[b].y);
    this.next = 0;
    const pitchCss = this.spacingPx * view.scale;
    const shownPitchCss = pitchCss * k;
    // Dot size in CSS px: a little under half the shown pitch, between 1.4 and 3.2 px; edge 0.5 CSS px.
    const dotCss = Math.max(1.4, Math.min(3.2, shownPitchCss * 0.42));
    const s = Math.max(1e-3, view.scale);
    this.dotSrc = dotCss / s;
    this.edgeSrc = 0.5 / s;
    let shownAccepted = 0;
    let totalAccepted = 0;
    for (const p of this.points) if (p.accepted) totalAccepted++;
    for (const i of subset) if (this.points[i].accepted) shownAccepted++;
    return { k, pitchCss, shownPitchCss, shownAccepted, totalAccepted, canvas: { width: this.canvas.width, height: this.canvas.height } };
  }

  /** The screen size changed (rotation, resize): lay out again and redraw what was already shown. */
  setView(view: View): DotDisplay {
    this.info = this.layout(view);
    if (this.finished) this.finish();
    else if (Number.isFinite(this.lineY)) this.revealTo(this.lineY);
    return this.info;
  }

  private dot(ctx: CanvasRenderingContext2D, p: SurfacePoint, fill: string): void {
    const d = this.dotSrc;
    const e = this.edgeSrc;
    ctx.fillStyle = DOT_EDGE;
    ctx.fillRect(p.x - d / 2 - e, p.y - d / 2 - e, d + 2 * e, d + 2 * e);
    ctx.fillStyle = fill;
    ctx.fillRect(p.x - d / 2, p.y - d / 2, d, d);
  }

  /** Draw every (displayed) point at or above `lineY` not drawn yet. Returns how many were drawn this call. */
  revealTo(lineY: number): number {
    this.lineY = Math.max(this.lineY, lineY);
    const ctx = this.ctx;
    if (!ctx) return 0;
    let n = 0;
    while (this.next < this.order.length && this.points[this.order[this.next]].y <= lineY) {
      const p = this.points[this.order[this.next++]];
      this.dot(ctx, p, p.accepted ? DOT_ACCEPTED : DOT_REJECTED);
      n++;
    }
    return n;
  }

  /** The final picture: accepted points only (of the display lattice). */
  finish(): void {
    this.finished = true;
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    for (const i of this.order) if (this.points[i].accepted) this.dot(ctx, this.points[i], DOT_ACCEPTED);
    this.next = this.order.length;
  }
}

/** The outline of the real mask, drawn OVER the dots with a dark halo so it stays visible on skin, on the dots and on a
 *  white background, and the scan line across the hand. Widths are in CSS px. */
export function drawLineLayer(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  contour: readonly Pt[] | null,
  line: { y: number; x0: number; x1: number } | null,
  view: View,
): void {
  const ctx = sizeToView(canvas, w, h, view);
  if (!ctx) return;
  const px = 1 / Math.max(1e-3, view.scale); // one CSS px in source px
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (contour && contour.length > 2) {
    ctx.beginPath();
    ctx.moveTo(contour[0].x, contour[0].y);
    for (let i = 1; i < contour.length; i++) ctx.lineTo(contour[i].x, contour[i].y);
    ctx.closePath();
    ctx.lineWidth = 4 * px;
    ctx.strokeStyle = "rgba(6,22,52,0.62)";
    ctx.stroke();
    ctx.lineWidth = 1.6 * px;
    ctx.strokeStyle = "#f2fcff";
    ctx.stroke();
  }
  if (line) {
    const g = ctx.createLinearGradient(0, line.y - 14 * px, 0, line.y + 2 * px);
    g.addColorStop(0, "rgba(25,200,255,0)");
    g.addColorStop(1, "rgba(25,200,255,0.35)");
    ctx.fillStyle = g;
    ctx.fillRect(line.x0, line.y - 14 * px, line.x1 - line.x0, 16 * px);
    ctx.beginPath();
    ctx.moveTo(line.x0, line.y);
    ctx.lineTo(line.x1, line.y);
    ctx.lineWidth = 4 * px;
    ctx.strokeStyle = "rgba(25,200,255,0.45)";
    ctx.stroke();
    ctx.lineWidth = 1.6 * px;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }
}
