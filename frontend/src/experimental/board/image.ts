// Plain image types and helpers for the EXPERIMENTAL board detector (no DOM, no OpenCV: runs in Node and in a Worker).
//
// Pixel convention (the OpenCV one, the same as geometry/camera.ts): pixel (i, j) is CENTRED on the image coordinate
// (x = i, y = j) and covers [i - 0.5, i + 0.5] x [j - 0.5, j + 0.5]. Bilinear sampling therefore reads pixel values at
// integer coordinates exactly.

/** An RGBA image, row-major, 4 bytes per pixel (the layout of `ImageData`). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A grey image, row-major, one float per pixel (0 to 255). */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

/** Luma (ITU-R BT.601 weights) of an RGBA image. */
export function toGray(img: RgbaImage): GrayImage {
  const { width, height, data } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return { width, height, data: out };
}

export function isGray(img: RgbaImage | GrayImage): img is GrayImage {
  return img.data instanceof Float32Array;
}

/** Bilinear sample at (x, y); coordinates outside the image are clamped to the edge pixels. */
export function sampleBilinear(img: GrayImage, x: number, y: number): number {
  const { width: W, height: H, data } = img;
  const xc = x < 0 ? 0 : x > W - 1 ? W - 1 : x;
  const yc = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
  const x0 = Math.min(W - 2, Math.floor(xc));
  const y0 = Math.min(H - 2, Math.floor(yc));
  const fx = xc - x0;
  const fy = yc - y0;
  const i = y0 * W + x0;
  const a = data[i];
  const b = data[i + 1];
  const c = data[i + W];
  const d = data[i + W + 1];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Half-size grey image (2 x 2 box average). Pixel i of the result is centred on full-resolution x = 2 i + 0.5. */
export function downsample2(img: GrayImage): GrayImage {
  const W = img.width >> 1;
  const H = img.height >> 1;
  const out = new Float32Array(W * H);
  const src = img.data;
  const sw = img.width;
  for (let y = 0; y < H; y++) {
    const r0 = 2 * y * sw;
    const r1 = r0 + sw;
    for (let x = 0; x < W; x++) {
      const k = 2 * x;
      out[y * W + x] = 0.25 * (src[r0 + k] + src[r0 + k + 1] + src[r1 + k] + src[r1 + k + 1]);
    }
  }
  return { width: W, height: H, data: out };
}

/** Separable Gaussian blur of a float plane in place (sigma in pixels; edges clamped). */
export function gaussianBlurPlane(data: Float32Array, width: number, height: number, sigma: number): void {
  if (!(sigma > 0)) return;
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += kernel[i + radius] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(Math.max(width, height));
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k >= width ? width - 1 : x + k;
        acc += kernel[k + radius] * data[row + xx];
      }
      tmp[x] = acc;
    }
    data.set(tmp.subarray(0, width), row);
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k;
        acc += kernel[k + radius] * data[yy * width + x];
      }
      tmp[y] = acc;
    }
    for (let y = 0; y < height; y++) data[y * width + x] = tmp[y];
  }
}
