// A batch of fingertip measurements (vision/fingertip.ts) on small crops cut from one camera frame. Pure, so the
// same code runs in the coin worker (off the page's main thread) and, as a fallback, on the page.
import type { RgbaImage } from "./coinDetector";
import { measureTip, type Pt, type TipEstimate } from "./fingertip";

export interface TipJobFinger {
  /** The tip landmark index: 4, 8, 12, 16 or 20. */
  tipIndex: number;
  /** A crop around the fingertip; modified by nothing, handed over to the worker. */
  image: RgbaImage;
  /** DIP (thumb: IP) and tip landmark in crop pixels. */
  dip: Pt;
  tip: Pt;
}

export interface TipJob {
  fingers: TipJobFinger[];
  maxExtFrac: number;
}

export interface TipJobResult {
  fingers: { tipIndex: number; est: TipEstimate }[];
}

export function runTipJob(job: TipJob): TipJobResult {
  return { fingers: job.fingers.map((f) => ({ tipIndex: f.tipIndex, est: measureTip(f.image, f.dip, f.tip, job.maxExtFrac) })) };
}
