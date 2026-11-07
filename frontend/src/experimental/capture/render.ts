// Canvas helpers of the capture prototype (DOM only): PNG encoding of stills and masks, and the overlay drawings. Display only.
import { HAND_CONNECTIONS } from "../../vision/geometry";
import type { Point } from "../../api/types";
import type { BinaryMask } from "../common";
import type { SegmentationResult } from "../segmentation/segmentHand";
import type { CoinSnapshot } from "./types";

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png"): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the image"))), type));
}

/** A still frame as a PNG. */
export async function pixelsToPng(pixels: ImageData): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = pixels.width;
  c.height = pixels.height;
  c.getContext("2d")!.putImageData(pixels, 0, 0);
  return canvasToBlob(c);
}

/** A binary mask as a black-and-white PNG (white = hand), at the mask's own (working) size. */
export async function maskToPng(mask: BinaryMask): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = mask.width;
  c.height = mask.height;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) {
    const v = mask.data[i] ? 255 : 0;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasToBlob(c);
}

const TIP_COLOURS = ["#e11d48", "#7c3aed", "#059669", "#2563eb", "#d97706"]; // thumb, index, middle, ring, pinky

/** Draw the live overlay (skeleton and coin ellipse) onto a canvas that has the video's pixel size. */
export function drawLiveOverlay(canvas: HTMLCanvasElement, landmarks: Point[] | null, coin: CoinSnapshot | null, width: number, height: number): void {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  const s = Math.max(1, Math.min(width, height) / 540);
  if (landmarks) {
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = "rgba(31,94,234,0.85)";
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(landmarks[a].x, landmarks[a].y);
      ctx.lineTo(landmarks[b].x, landmarks[b].y);
    }
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    for (const p of landmarks) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (coin?.found) {
    ctx.lineWidth = 2.5 * s;
    ctx.strokeStyle = coin.accepted ? "#16a34a" : "#d97706";
    ctx.setLineDash(coin.accepted ? [] : [6 * s, 5 * s]);
    ctx.beginPath();
    ctx.ellipse(coin.center_x, coin.center_y, coin.major_axis_px / 2, coin.minor_axis_px / 2, (coin.angle_deg * Math.PI) / 180, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** The captured still with the experimental mask, outline, fingertips, wrist line and coin drawn over it. Returns the scale used. */
export function drawAnalysis(canvas: HTMLCanvasElement, still: ImageData, result: SegmentationResult | null, coin: CoinSnapshot | null, displayWidth: number): void {
  const k = displayWidth / still.width;
  canvas.width = Math.round(still.width * k);
  canvas.height = Math.round(still.height * k);
  const ctx = canvas.getContext("2d")!;
  const base = document.createElement("canvas");
  base.width = still.width;
  base.height = still.height;
  base.getContext("2d")!.putImageData(still, 0, 0);
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
  if (!result?.mask) return;
  const m = result.mask;
  const tint = document.createElement("canvas");
  tint.width = m.width;
  tint.height = m.height;
  const tctx = tint.getContext("2d")!;
  const img = tctx.createImageData(m.width, m.height);
  for (let i = 0; i < m.data.length; i++) {
    if (m.data[i]) {
      img.data[i * 4] = 0;
      img.data[i * 4 + 1] = 140;
      img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = 90;
    }
  }
  tctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tint, 0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#0b3fb8";
  if (result.contour.length > 2) {
    ctx.beginPath();
    result.contour.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * k, p.y * k) : ctx.lineTo(p.x * k, p.y * k)));
    ctx.closePath();
    ctx.stroke();
  }
  result.fingertips.forEach((p, i) => {
    if (!p) return;
    ctx.fillStyle = TIP_COLOURS[i];
    ctx.beginPath();
    ctx.arc(p.x * k, p.y * k, 5, 0, Math.PI * 2);
    ctx.fill();
  });
  if (result.wristLine) {
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(result.wristLine[0].x * k, result.wristLine[0].y * k);
    ctx.lineTo(result.wristLine[1].x * k, result.wristLine[1].y * k);
    ctx.stroke();
  }
  if (coin?.found) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = coin.accepted ? "#16a34a" : "#d97706";
    ctx.beginPath();
    ctx.ellipse(coin.center_x * k, coin.center_y * k, (coin.major_axis_px / 2) * k, (coin.minor_axis_px / 2) * k, (coin.angle_deg * Math.PI) / 180, 0, Math.PI * 2);
    ctx.stroke();
  }
}
