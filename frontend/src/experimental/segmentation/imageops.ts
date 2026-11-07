// Small pure image helpers (no DOM): an RGBA image type that ImageData satisfies, area-average downscaling, grey.

/** An RGBA picture. The DOM's ImageData fits this, so nothing here needs a canvas. */
export interface ImageLike {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Shrink so the longest side is at most `longest` (area average); never enlarges. `scale` = working px per source px. */
export function toWorking(src: ImageLike, longest: number): { image: ImageLike; scale: number } {
  const scale = Math.min(1, longest / Math.max(src.width, src.height));
  if (scale >= 1) return { image: src, scale: 1 };
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = src.width / w;
  const sy = src.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.ceil((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  // The scale actually applied differs from the request by the rounding of the size: report the exact one.
  return { image: { width: w, height: h, data: out }, scale: (w / src.width + h / src.height) / 2 };
}

/** Luma (0-255) of every pixel. */
export function toGray(img: ImageLike): Float32Array {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = 0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2];
  return out;
}
