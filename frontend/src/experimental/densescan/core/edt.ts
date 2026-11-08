// Distance to the nearest non-hand pixel, for every pixel of a binary mask (two-pass 3-4 chamfer, divided by 3, so
// in pixels; within about 8 % of the true Euclidean distance). Pixels outside the image count as background, so a hand
// touching the border has small distances there. Background pixels get 0.
import type { BinaryMask } from "../../common";

export function edgeDistance(mask: BinaryMask): Float32Array {
  const { width: w, height: h, data } = mask;
  const BIG = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = data[i] ? BIG : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  // forward pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let v = d[i];
      v = Math.min(v, at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
      d[i] = v;
    }
  }
  // backward pass
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let v = d[i];
      v = Math.min(v, at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
      d[i] = v;
    }
  }
  for (let i = 0; i < w * h; i++) d[i] = d[i] / 3;
  return d;
}

/** Nearest working pixel of a source-pixel position, or -1 outside the mask image. */
export function maskIndex(mask: BinaryMask, scaleToSource: number, x: number, y: number): number {
  const wx = Math.floor(x / scaleToSource);
  const wy = Math.floor(y / scaleToSource);
  if (wx < 0 || wy < 0 || wx >= mask.width || wy >= mask.height) return -1;
  return wy * mask.width + wx;
}

export function insideMask(mask: BinaryMask, scaleToSource: number, x: number, y: number): boolean {
  const i = maskIndex(mask, scaleToSource, x, y);
  return i >= 0 && mask.data[i] > 0;
}
