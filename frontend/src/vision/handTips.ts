// One tip method for the whole hand (repeatability).
//
// The outline fingertip (vision/fingertip.ts) is found on some fingers and not on others, and it moves a tip by about 5 to 7 mm.
// If each finger simply used its own outline tip when found and the landmark when not, the same hand would read a different length
// on the next scan whenever a finger was found one time and not the next (SIMULATED: scan-to-scan SD of a finger 1.1 to 2.2 mm with
// landmark tips rose to 2.6 to 4.1 mm; docs/FINGER_ACCURACY_AUDIT.md, section 9). So the extension is decided per HAND:
//
//   * a finger whose outline was found keeps its own measured extension, as long as it is close to the hand's (`source: "outline"`);
//   * the hand's extension is the median of the found fingers' (at least 2, agreeing); every other finger uses it
//     (`source: "estimated"`: an estimate, not a measurement);
//   * with fewer than 2 found fingers, the extension seen in an earlier view of the same scan is used (`carry`), and failing that
//     an ASSUMED prior (`prior`, config finger_tip.prior_frac: the mean of the two real photos, ONE hand, not a population value);
//   * with no prior (null) every tip is the landmark: the whole scan then switches together.
// The scan therefore never mixes methods finger by finger.
import type { FingerTipResult } from "./fingertip";

export type TipSource = "outline" | "estimated" | "landmark";

export interface PlannedTip {
  source: TipSource;
  /** Extension beyond the landmark tip as a fraction of the distal segment (0 for "landmark"). */
  ratio: number;
  /** For "landmark" and "estimated": why the finger's own outline was not used. */
  reason?: string;
}

export interface HandTipPlan {
  tips: Record<number, PlannedTip>;
  /** The hand's extension when at least 2 fingers agreed on one (null otherwise): carried to the next view. */
  measuredRatio: number | null;
  /** Fingers whose own outline was found and used. */
  found: number;
  /** Where the hand's extension came from: this view's fingers, an earlier view, the assumed prior, or nowhere. */
  basis: "measured" | "earlier_view" | "assumed_prior" | "none";
}

export const HAND_SPREAD = 0.1; // the found fingers must agree within this (MAD, fraction of the distal segment)
// A found finger further than this from the hand's extension is not trusted. Deliberately loose: fingers really differ (0.21 to 0.36 on the
// two real photos), and a tight limit made a finger flip between its own value and the hand's from scan to scan (SD 1.8 mm on a thumb).
export const FINGER_AGREE = 0.25;

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function planHandTips(byFinger: Record<number, FingerTipResult>, tipIndices: number[], carry: number | null, prior: number | null): HandTipPlan {
  const found = tipIndices.filter((t) => byFinger[t]?.ok);
  let hand: number | null = null;
  let basis: HandTipPlan["basis"] = "none";
  let measured: number | null = null;
  if (found.length >= 2) {
    const ratios = found.map((t) => byFinger[t].ratio);
    const med = median(ratios);
    if (1.4826 * median(ratios.map((r) => Math.abs(r - med))) <= HAND_SPREAD) {
      hand = med;
      measured = med;
      basis = "measured";
    }
  }
  if (hand === null && carry !== null) {
    hand = carry;
    basis = "earlier_view";
  }
  if (hand === null && prior !== null) {
    hand = prior;
    basis = "assumed_prior";
  }
  const tips: Record<number, PlannedTip> = {};
  let used = 0;
  for (const t of tipIndices) {
    const r = byFinger[t];
    if (hand === null) {
      tips[t] = { source: "landmark", ratio: 0, reason: r?.ok ? "hand_not_agreed" : r?.reason ?? "no_boundary" };
    } else if (r?.ok && Math.abs(r.ratio - hand) <= FINGER_AGREE) {
      tips[t] = { source: "outline", ratio: r.ratio };
      used++;
    } else {
      tips[t] = { source: "estimated", ratio: hand, reason: r?.ok ? "differs_from_hand" : r?.reason ?? "no_boundary" };
    }
  }
  return { tips, measuredRatio: measured, found: used, basis };
}
