// Live quality measures of the EXPERIMENTAL capture prototype: how steady the hand is, how sharp the picture is, whether the
// hand's posture fits the view, and the run of consecutive good frames that triggers an automatic capture.
//
// Every threshold below is PROVISIONAL and UNVALIDATED. They gate a research capture, never a measurement, and a view that
// fails one can still be taken by hand and is then recorded as "quality not passed" with the reasons. Nothing here changes
// or reads the production acceptance checks except the capture settings named below, read from the public config.
import type { Point } from "../../api/types";
import { jitterFraction, medianOf } from "../../vision/geometry";
import type { PostureRule, ViewDef, ViewId } from "./views";

/** Consecutive good frames before the automatic capture fires. */
export const AUTO_CAPTURE_FRAMES = 8;

/** Frames over which landmark jitter is averaged. */
export const JITTER_WINDOW = 5;

/** Frames over which the hand's turn is smoothed (the median), as the production side-of-hand checks do. */
export const TURN_WINDOW = 5;

/** Fallback landmark jitter limit (fraction of the hand size) when the config does not provide one. */
export const FALLBACK_MAX_JITTER = 0.025;

/** Smallest variance of the Laplacian (luminance 0..1, hand region resized to at most SHARPNESS_SIDE_PX) for a picture to count
 *  as sharp. PROVISIONAL: chosen from the fake camera's still photo and blurred copies of it; a real phone will differ. */
export const MIN_SHARPNESS = 0.0004;

/** The hand region is shrunk to at most this many pixels on its long side before the sharpness is measured, so the number does
 *  not depend on the camera's resolution. */
export const SHARPNESS_SIDE_PX = 256;

/** Fallbacks for the capture settings read from the public config (capture.hand_turn_min_abs and the side view's max_hand_turn_abs). */
export const FALLBACK_MIN_TURN_ABS = 0.2;
export const FALLBACK_MAX_EDGE_TURN_ABS = 0.55;

/** Luminance 0..1 from RGBA pixels (Rec. 601 weights, as the app's own brightness measure). */
export function grayFromRgba(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255;
  return out;
}

/** Variance of the 4-neighbour Laplacian over the interior pixels of a grey image (0..1). A blurred picture has a small value. */
export function laplacianVariance(gray: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const l = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/** Area-average shrink of a grey image so that the long side is at most `maxSide` (never enlarges). */
export function shrinkGray(gray: Float32Array, width: number, height: number, maxSide: number): { gray: Float32Array; width: number; height: number } {
  const k = Math.min(1, maxSide / Math.max(width, height));
  if (k >= 1) return { gray, width, height };
  const w = Math.max(3, Math.round(width * k));
  const h = Math.max(3, Math.round(height * k));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(((y + 1) * height) / h)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(((x + 1) * width) / w)));
      let s = 0;
      let c = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) (s += gray[yy * width + xx]), c++;
      out[y * w + x] = s / c;
    }
  }
  return { gray: out, width: w, height: h };
}

/** Sharpness of a picture region: the Laplacian variance after shrinking to SHARPNESS_SIDE_PX (so it does not scale with resolution). */
export function regionSharpness(rgba: ArrayLike<number>, width: number, height: number): number {
  const g = shrinkGray(grayFromRgba(rgba, width, height), width, height, SHARPNESS_SIDE_PX);
  return laplacianVariance(g.gray, g.width, g.height);
}

export interface Steadiness {
  /** Mean landmark movement between consecutive frames, as a fraction of the hand size, or null when there is too little history. */
  jitter: number | null;
  steady: boolean;
}

/** How still the hand is over the last frames (null jitter and steady false until two frames exist). */
export function steadiness(history: readonly (readonly Point[])[], maxJitter: number): Steadiness {
  const recent = history.slice(-JITTER_WINDOW);
  if (recent.length < 2) return { jitter: null, steady: false };
  let total = 0;
  for (let i = 1; i < recent.length; i++) total += jitterFraction([...recent[i - 1]], [...recent[i]]);
  const jitter = total / (recent.length - 1);
  return { jitter, steady: Number.isFinite(jitter) && jitter <= maxJitter };
}

export interface PostureContext {
  /** capture.hand_turn_min_abs from the config (smallest |turn| at which a side of the hand is judged). */
  minTurnAbs: number;
  /** The side view's max_hand_turn_abs from the config (largest |turn| of a hand on its edge). */
  maxEdgeTurnAbs: number;
  /** The smoothed turn recorded in the view named by an `opposite_of` rule, or null when that view has not been captured. */
  turnOf: (view: ViewId) => number | null;
}

export interface PostureResult {
  ok: boolean;
  /** "n/a" when the rule judges nothing. */
  verdict: "ok" | "wrong" | "unknown" | "n/a";
  message: string;
}

/** Judge the smoothed hand turn against the view's posture rule. Never passes a view it cannot judge (verdict "unknown"). */
export function postureCheck(rule: PostureRule, turn: number | null, ctx: PostureContext): PostureResult {
  if (rule.kind === "none") return { ok: true, verdict: "n/a", message: "No posture is judged for this view." };
  if (turn === null) return { ok: false, verdict: "unknown", message: "Waiting for a steady hand to judge the posture." };
  const size = Math.abs(turn);
  if (rule.kind === "edge_on") {
    return size <= ctx.maxEdgeTurnAbs
      ? { ok: true, verdict: "ok", message: "The hand is on its edge." }
      : { ok: false, verdict: "wrong", message: "Turn the hand further onto its edge." };
  }
  if (size < ctx.minTurnAbs) return { ok: false, verdict: "wrong", message: "Show the flat of the hand (palm or back) to the camera." };
  if (rule.kind === "face_on") return { ok: true, verdict: "ok", message: "The hand faces the camera." };
  const other = ctx.turnOf(rule.view);
  if (other === null || Math.abs(other) < ctx.minTurnAbs) return { ok: false, verdict: "unknown", message: `The ${rule.view} view is needed first to judge which side this is.` };
  return Math.sign(turn) !== Math.sign(other)
    ? { ok: true, verdict: "ok", message: "This is the other side of the hand." }
    : { ok: false, verdict: "wrong", message: "This is the same side as the palm view: turn the hand over." };
}

/** The smoothed turn: the median of the last TURN_WINDOW per-frame turns (0 for none). */
export function smoothedTurn(turns: readonly number[]): number | null {
  const recent = turns.slice(-TURN_WINDOW).filter(Number.isFinite);
  return recent.length >= 3 ? medianOf([...recent]) : null;
}

/** Counts consecutive good frames. */
export class GoodRun {
  private n = 0;
  push(good: boolean): number {
    this.n = good ? this.n + 1 : 0;
    return this.n;
  }
  reset(): void {
    this.n = 0;
  }
  get count(): number {
    return this.n;
  }
}

export interface QualityChips {
  handFound: boolean;
  inFrame: boolean;
  coin: { required: boolean; found: boolean; accepted: boolean; reasons: string[] };
  posture: PostureResult;
  steady: Steadiness;
  sharpness: { value: number | null; sharp: boolean };
}

/** All the named reasons a frame is not good (empty = good). Words for the person, never hidden. */
export function failedChecks(_def: ViewDef, chips: QualityChips): string[] {
  const out: string[] = [];
  if (!chips.handFound) return ["No hand found."];
  if (!chips.inFrame) out.push("Move the whole hand inside the picture.");
  if (chips.coin.required && !chips.coin.accepted) out.push(chips.coin.found ? "The coin is found but not accepted yet (check the lighting and keep it flat)." : "The coin is not found: rest it flat on the skin.");
  if (!chips.posture.ok) out.push(chips.posture.message);
  if (!chips.steady.steady) out.push("Hold the hand still.");
  if (!chips.sharpness.sharp) out.push("The picture is blurred: hold still and let the camera focus.");
  return out;
}
