// One coin search on a window cut from a camera frame: mask everything outside the palm, then
// track the coin from its previous position or search the whole window. Pure (no DOM), so the
// same code runs in the coin worker (vision/coinWorker.ts) and, as a fallback, on the page.
import type { CoinDetectionParams, Point } from "../api/types";
import { detectCoin, type CoinDetection, type CoinSeed, type RgbaImage } from "./coinDetector";
import { maskOutsidePalm } from "./frameAnalysis";
import type { CV } from "./opencv";

export interface CoinJob {
  /** The search window's pixels; modified in place (masked). */
  image: RgbaImage;
  params: CoinDetectionParams;
  diameterRange: [number, number] | null;
  /** Palm outline in window pixels, and how far it is grown (null: search the whole window). */
  palm: Point[] | null;
  palmGrow: number | null;
  /** The coin from the previous frame, in window pixels: refine it instead of a full search. */
  seed: CoinSeed | null;
  /** A tracked fit weaker than this means the tracker drifted: search the whole window instead. */
  trackMinConfidence: number;
}

export interface CoinJobResult {
  /** In window pixels. */
  coin: CoinDetection;
  /** True when the coin was tracked from the seed, false after a full search. */
  tracked: boolean;
}

export function runCoinJob(cv: CV, job: CoinJob): CoinJobResult {
  if (job.palm && job.palmGrow !== null) maskOutsidePalm(job.image, job.palm, job.palmGrow);
  if (job.seed) {
    const t = detectCoin(cv, job.image, job.params, null, job.diameterRange, job.seed);
    if (t.accepted || (t.found && t.confidence >= job.trackMinConfidence)) return { coin: t, tracked: true };
  }
  return { coin: detectCoin(cv, job.image, job.params, null, job.diameterRange), tracked: false };
}
