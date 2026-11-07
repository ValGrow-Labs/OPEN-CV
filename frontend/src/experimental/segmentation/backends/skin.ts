// Backend (c): a skin-colour threshold. The NAIVE BASELINE: it exists to show where colour alone fails (skin-coloured
// tables, wood, warm light, shadows), not to be used. The thresholds adapt to the person: they are sampled from the
// palm core given by the landmark seeds, in the YCrCb chroma plane, so different skin tones work on a plain background.
import type { ImageLike } from "../imageops";
import type { Seeds } from "../seeds";

/**
 * Width of the accepted chroma window in ROBUST standard deviations (median absolute deviation) of the seed sample.
 * Robust, because the coin lies on the palm in this app and a plain mean and deviation would be dragged towards grey.
 */
export const SKIN_SIGMAS = 3;
/** The chroma window is never narrower than this (chroma units, 0-255), so a smooth palm does not give a razor window. */
export const SKIN_MIN_HALF_WIDTH = 8;

function chroma(img: ImageLike, i: number): { y: number; cr: number; cb: number } {
  const r = img.data[i * 4];
  const g = img.data[i * 4 + 1];
  const b = img.data[i * 4 + 2];
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return { y, cr: (r - y) * 0.713 + 128, cb: (b - y) * 0.564 + 128 };
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function runSkin(img: ImageLike, seeds: Seeds): Uint8Array {
  const n = img.width * img.height;
  const crs: number[] = [];
  const cbs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!seeds.sureFg[i]) continue;
    const c = chroma(img, i);
    crs.push(c.cr);
    cbs.push(c.cb);
  }
  const out = new Uint8Array(n);
  if (crs.length === 0) return out;
  const mcr = median(crs);
  const mcb = median(cbs);
  const hcr = Math.max(SKIN_MIN_HALF_WIDTH, SKIN_SIGMAS * 1.4826 * median(crs.map((v) => Math.abs(v - mcr))));
  const hcb = Math.max(SKIN_MIN_HALF_WIDTH, SKIN_SIGMAS * 1.4826 * median(cbs.map((v) => Math.abs(v - mcb))));
  for (let i = 0; i < n; i++) {
    if (!seeds.band[i]) continue; // like the other backends, nothing outside the probable band can be hand
    const c = chroma(img, i);
    if (c.y > 25 && Math.abs(c.cr - mcr) <= hcr && Math.abs(c.cb - mcb) <= hcb) out[i] = 255;
  }
  for (let i = 0; i < n; i++) if (seeds.sureFg[i]) out[i] = 255;
  return out;
}
