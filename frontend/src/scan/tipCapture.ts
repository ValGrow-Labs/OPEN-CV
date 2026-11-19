// Fingertips from the hand outline, for one scan view (vision/fingertip.ts does the measuring).
//
// While a view is scanned, small crops of the camera picture around the five fingertips are cut at the moment of
// each coin search (the same video frame the hand landmarks belong to). Only the sharpest few crops of frames the
// live checks accepted are kept. When the view is complete they are measured ONCE in the coin worker (off the
// page's main thread), the findings of the frames are combined per finger (median extension as a fraction of the
// distal segment) and that extension is applied to the tip landmark of EVERY frame of the view, as the optional
// `refined_tips` field. A finger without a clear outline keeps its landmark tip, with the reason. The server
// re-checks every refined tip (extension 0 to a fraction of the distal segment, in the frame, finger not bent).
import type { FrameObservation, Point } from "../api/types";
import type { CoinEngine } from "../vision/coinEngine";
import { combineTipResults, sharpness, type FingerTipResult, type TipEstimate } from "../vision/fingertip";
import { planHandTips, type HandTipPlan, type PlannedTip } from "../vision/handTips";
import type { TipJobFinger } from "../vision/tipJob";

/** Tip landmark and the joint before it (the DIP; the thumb's IP), MediaPipe indices. */
export const TIP_FINGERS: { tip: number; dip: number }[] = [
  { tip: 4, dip: 3 },
  { tip: 8, dip: 7 },
  { tip: 12, dip: 11 },
  { tip: 16, dip: 15 },
  { tip: 20, dip: 19 },
];

/** Frames whose crops are kept and measured per view: few, so the work is a small fixed cost. */
export const TIP_FRAMES_KEPT = 4;
/** The most the measuring may delay completing a view; past it the landmark tips are used. */
export const TIP_BUDGET_MS = 2500;

export interface TipCrop extends TipJobFinger {
  sharp: number;
}
export interface TipCropSet {
  crops: TipCrop[];
  score: number;
}

export interface TipSummary {
  byFinger: Record<number, FingerTipResult>;
  /** What every finger of the view got: its own outline, the hand's extension (estimated) or the landmark. */
  plan: HandTipPlan;
  ms: number;
  usedFrames: number;
}

export class TipCapture {
  private canvas: HTMLCanvasElement | null = null;
  private kept: TipCropSet[] = [];

  reset(): void {
    this.kept = [];
  }

  get keptFrames(): number {
    return this.kept.length;
  }

  /** Cut a crop around each fingertip from the live video (never from a rescaled copy: that would blur the edge). */
  grab(video: HTMLVideoElement, landmarks: Point[], width: number, height: number): TipCrop[] {
    const out: TipCrop[] = [];
    if (!this.canvas) this.canvas = document.createElement("canvas");
    const c = this.canvas;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return out;
    for (const { tip, dip } of TIP_FINGERS) {
      const T = landmarks[tip];
      const D = landmarks[dip];
      const L = Math.hypot(T.x - D.x, T.y - D.y);
      if (!(L >= 12)) continue;
      const half = Math.ceil(1.5 * L) + 8;
      const x0 = Math.max(0, Math.round(T.x - half));
      const y0 = Math.max(0, Math.round(T.y - half));
      const x1 = Math.min(width, Math.round(T.x + half));
      const y1 = Math.min(height, Math.round(T.y + half));
      const w = x1 - x0;
      const h = y1 - y0;
      if (w < 24 || h < 24) continue;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      ctx.drawImage(video, x0, y0, w, h, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      out.push({
        tipIndex: tip,
        image: { data: img.data, width: w, height: h },
        dip: { x: D.x - x0, y: D.y - y0 },
        tip: { x: T.x - x0, y: T.y - y0 },
        sharp: 0,
      });
    }
    return out;
  }

  /** The frame these crops came from was accepted: keep them if they are among the sharpest so far. */
  keep(crops: TipCrop[]): void {
    if (crops.length === 0) return;
    for (const c of crops) c.sharp = sharpness(c.image);
    const score = crops.reduce((s, c) => s + c.sharp, 0) / crops.length;
    this.kept.push({ crops, score });
    this.kept.sort((a, b) => b.score - a.score);
    if (this.kept.length > TIP_FRAMES_KEPT) this.kept.length = TIP_FRAMES_KEPT;
  }

  /** Measure the kept crops once, combine them per finger, decide ONE extension for the whole hand (vision/handTips.ts) and
   *  write `refined_tips` on every frame of the view. Never throws: when measuring fails or times out, the fingers are
   *  planned from `carry` (an earlier view of this scan) or the assumed `prior`, so a scan does not switch method.
   *  Returns null when nothing was written. */
  async finalize(
    engine: CoinEngine | null,
    frames: FrameObservation[],
    maxExtFrac: number,
    opts: { carry?: number | null; prior?: number | null; budgetMs?: number } = {},
  ): Promise<TipSummary | null> {
    const sets = this.kept;
    this.kept = [];
    if (frames.length === 0) return null;
    const t0 = performance.now();
    const byFinger: Record<number, FingerTipResult> = {};
    if (engine?.tips && sets.length > 0) {
      try {
        const run = Promise.all(sets.map((s) => engine.tips!({ fingers: s.crops.map((c): TipJobFinger => ({ tipIndex: c.tipIndex, image: c.image, dip: c.dip, tip: c.tip })), maxExtFrac })));
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.budgetMs ?? TIP_BUDGET_MS));
        const results = await Promise.race([run, timeout]);
        if (results) {
          const per = new Map<number, TipEstimate[]>();
          for (const r of results) for (const f of r.fingers) per.set(f.tipIndex, [...(per.get(f.tipIndex) ?? []), f.est]);
          for (const { tip } of TIP_FINGERS) if (per.has(tip)) byFinger[tip] = combineTipResults(per.get(tip)!);
        }
      } catch (err) {
        console.error("fingertip measurement failed; the hand's extension is estimated instead", err);
      }
    }
    const plan = planHandTips(byFinger, TIP_FINGERS.map((f) => f.tip), opts.carry ?? null, opts.prior ?? null);
    if (plan.basis === "none") return null; // landmark tips everywhere: nothing to write
    applyRefinedTips(frames, plan.tips, maxExtFrac);
    return { byFinger, plan, ms: performance.now() - t0, usedFrames: sets.length };
  }
}

/** Write `refined_tips` on every frame: each tip landmark moved outward along its own distal segment by the planned extension
 *  ratio ("outline": the finger's own; "estimated": the hand's), or left where it is with the reason ("landmark").
 *  Exported for the tests. */
export function applyRefinedTips(frames: FrameObservation[], planned: Record<number, PlannedTip>, maxExtFrac: number): void {
  for (const f of frames) {
    const tips: NonNullable<FrameObservation["refined_tips"]> = {};
    for (const { tip, dip } of TIP_FINGERS) {
      const res = planned[tip];
      if (!res) continue;
      const T = f.landmarks[tip];
      const D = f.landmarks[dip];
      if (res.source === "landmark") {
        tips[String(tip)] = { x: T.x, y: T.y, extension_px: 0, source: "landmark", reason: res.reason };
        continue;
      }
      const ratio = Math.min(res.ratio, maxExtFrac * 0.98);
      const dx = T.x - D.x;
      const dy = T.y - D.y;
      tips[String(tip)] = { x: T.x + ratio * dx, y: T.y + ratio * dy, extension_px: ratio * Math.hypot(dx, dy), source: res.source, ...(res.reason ? { reason: res.reason } : {}) };
    }
    if (Object.keys(tips).length) f.refined_tips = tips;
  }
}
