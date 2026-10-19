// Canvas overlay drawing (landmark skeleton, coin outline, search window).
// The overlay canvas has the video's intrinsic size, so everything is drawn in raw image
// pixels; mirroring for the selfie camera is applied with CSS to video and canvas alike.
import type { CoinObservation, Point } from "../api/types";
import { HAND_CONNECTIONS } from "./geometry";

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
