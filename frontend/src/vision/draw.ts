import type { CoinObservation, Point } from "../api/types";
import { HAND_CONNECTIONS } from "./geometry";
import { computeHandOutline, drawSmoothContour } from "./handOutline";

export const COLORS = {
  good: "#3ddc97",
  warn: "#ffb020",
  bad: "#ff5d5d",
  neutral: "rgba(255,255,255,0.85)",
  roi: "rgba(255,255,255,0.25)",
};

export function clear(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

export function drawHandOutline(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  color: string,
  scale: number,
  quality = 1.0,
): void {
  const { contour } = computeHandOutline(pts);
  if (contour.length < 3) return;
  const isGood = color === COLORS.good && quality >= 0.7;
  const strokeColor = isGood ? COLORS.good : COLORS.warn;
  const fillColor = isGood ? "rgba(61, 220, 151, 0.09)" : "rgba(255, 176, 32, 0.08)";
  drawSmoothContour(ctx, contour, strokeColor, fillColor, 2.5 * scale);
}

export function drawSkeleton(ctx: CanvasRenderingContext2D, pts: Point[], color: string, scale: number): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = 3 * scale;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
  }
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawCoin(ctx: CanvasRenderingContext2D, coin: CoinObservation, scale: number): void {
  ctx.save();
  ctx.lineWidth = 3 * scale;
  ctx.strokeStyle = coin.accepted ? COLORS.good : COLORS.warn;
  ctx.setLineDash(coin.accepted ? [] : [8 * scale, 6 * scale]);
  ctx.beginPath();
  ctx.ellipse(coin.center_x, coin.center_y, coin.major_axis_px / 2, coin.minor_axis_px / 2, (coin.angle_deg * Math.PI) / 180, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function drawRoi(ctx: CanvasRenderingContext2D, roi: { x: number; y: number; w: number; h: number }, scale: number): void {
  ctx.save();
  ctx.strokeStyle = COLORS.roi;
  ctx.lineWidth = 1.5 * scale;
  ctx.setLineDash([6 * scale, 6 * scale]);
  ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);
  ctx.restore();
}

/** A small dark tag with white text, e.g. a live finger length. The overlay canvas is flipped with
 *  CSS for the selfie camera, so the text is flipped back to stay readable. */
export function drawTag(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, text: string, scale: number, mirrored: boolean): void {
  ctx.save();
  ctx.translate(at.x, at.y);
  if (mirrored) ctx.scale(-1, 1);
  ctx.font = `600 ${13 * scale}px "Geist Variable", system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 12 * scale;
  const h = 20 * scale;
  ctx.fillStyle = "rgba(10, 11, 14, 0.78)";
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(-w / 2, -h / 2, w, h, 6 * scale);
  else ctx.rect(-w / 2, -h / 2, w, h);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, 0.5 * scale);
  ctx.restore();
}
