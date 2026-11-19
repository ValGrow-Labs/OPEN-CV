// The five live finger-length labels of the capture screen (pure parts: no DOM, no canvas).
//
// WHAT THEY ARE. Each label shows the straight-line length the app already computes for that finger from the current camera
// frame (vision/liveLengths.ts: knuckle to tip, scaled by this frame's coin). Nothing here measures anything: it only takes
// those numbers, smooths them over the last few frames, writes them as "~72 mm" and finds a place for the label next to its
// fingertip. They are rough LIVE ESTIMATES (a single frame, the whole-hand audit puts a finger's length at about +/-12 mm,
// 95 % of the time); the reported result comes from the server, which combines all the frames. They are shown only while the
// coin is accepted (the numbers do not exist otherwise), and the screen says so ("live estimate").
import type { Point } from "../api/types";
import { FINGER_TIPS, labelAnchor, type FingerName } from "../vision/liveLengths";

export const LABEL_FINGERS: readonly FingerName[] = ["thumb", "index", "middle", "ring", "little"];

/** The only lengths worth showing: a finger of a hand that fits a glove is never shorter or longer than this. A value outside
 *  it means the coin or the hand was misread for a moment, and the label waits for the next frames instead. */
export const PLAUSIBLE_MM = { min: 10, max: 140 };

/** "~72 mm": a tilde, because it is an estimate. */
export function formatLabel(mm: number): string {
  return `~${Math.round(mm)} mm`;
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type FingerLengths = Partial<Record<FingerName, number>>;

/**
 * Median of the last few readings of each finger, so the label does not flicker from one frame to the next, plus a little
 * stickiness on the shown whole number (it changes only when the median has moved a clear step away from it).
 */
export class LengthSmoother {
  private readonly history = new Map<FingerName, number[]>();
  private readonly shown = new Map<FingerName, number>();
  private lastAt = -Infinity;

  /** `window` readings are kept per finger; fewer than `minSamples` show nothing yet; a reading older than `holdMs` is gone. */
  constructor(
    private readonly window = 5,
    private readonly minSamples = 3,
    private readonly holdMs = 700,
    private readonly step = 1.2,
  ) {}

  /** A new reading (null: there is none this frame, e.g. the coin is not accepted). */
  push(mm: FingerLengths | null, nowMs: number): void {
    if (!mm) return;
    let any = false;
    for (const f of LABEL_FINGERS) {
      const v = mm[f];
      if (typeof v !== "number" || !Number.isFinite(v) || v < PLAUSIBLE_MM.min || v > PLAUSIBLE_MM.max) continue;
      const h = this.history.get(f) ?? [];
      h.push(v);
      if (h.length > this.window) h.shift();
      this.history.set(f, h);
      any = true;
    }
    if (any) this.lastAt = nowMs;
  }

  /** The smoothed lengths to show now (whole mm), or null: no coin reading for a moment, or too few readings yet. */
  read(nowMs: number): FingerLengths | null {
    if (nowMs - this.lastAt > this.holdMs) {
      this.reset();
      return null;
    }
    const out: FingerLengths = {};
    let n = 0;
    for (const f of LABEL_FINGERS) {
      const h = this.history.get(f);
      if (!h || h.length < this.minSamples) continue;
      const m = median(h);
      const prev = this.shown.get(f);
      const shown = prev !== undefined && Math.abs(m - prev) < this.step ? prev : Math.round(m);
      this.shown.set(f, shown);
      out[f] = shown;
      n++;
    }
    return n > 0 ? out : null;
  }

  reset(): void {
    this.history.clear();
    this.shown.clear();
    this.lastAt = -Infinity;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Placement

export interface LabelInput {
  finger: FingerName;
  text: string;
  /** The fingertip, in canvas px. */
  tip: { x: number; y: number };
  /** Unit vector of the finger's direction (from the knuckle to the tip): the label goes beyond the tip along it. */
  dir: { x: number; y: number };
  /** The label's size in px (text plus padding). */
  w: number;
  h: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PlacedLabel extends LabelInput {
  /** Top left of the label box. */
  x: number;
  y: number;
  /** false: no room was found for it without overlapping another label, a reserved area or the edge. */
  visible: boolean;
}

export interface PlaceOptions {
  /** Distance from the fingertip to the near edge of the label. */
  gap?: number;
  /** Empty space kept between two labels. */
  pad?: number;
  /** Areas the labels must stay out of (a button on the picture, say). */
  reserved?: readonly Rect[];
}

/** Which label gives way when two cannot both be shown (the thumb and the little finger, the ones with most room, go first). */
const GIVE_WAY: readonly FingerName[] = ["middle", "index", "ring", "little", "thumb"];

const overlapAmount = (a: Rect, b: Rect, pad: number): { x: number; y: number } => ({
  x: Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + pad,
  y: Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + pad,
});

/**
 * Put every label just beyond its fingertip (along the finger), then nudge them until no two overlap, none touches a
 * reserved area and all lie inside `bounds` (the camera picture less a margin). A label that still cannot be placed is
 * marked invisible rather than drawn on top of another one.
 */
export function placeLabels(inputs: readonly LabelInput[], bounds: Rect, options: PlaceOptions = {}): PlacedLabel[] {
  const gap = options.gap ?? 9;
  const pad = options.pad ?? 4;
  const reserved = options.reserved ?? [];
  const rects = inputs.map((l) => {
    // the box's edge nearest the tip is `gap` away: the centre is half the box's extent along the finger further out
    const reach = Math.abs(l.dir.x) * (l.w / 2) + Math.abs(l.dir.y) * (l.h / 2);
    const cx = l.tip.x + l.dir.x * (gap + reach);
    const cy = l.tip.y + l.dir.y * (gap + reach);
    return { x0: cx - l.w / 2, y0: cy - l.h / 2, x1: cx + l.w / 2, y1: cy + l.h / 2 };
  });
  const clamp = (r: Rect, l: LabelInput) => {
    const w = l.w;
    const h = l.h;
    const x0 = Math.max(bounds.x0, Math.min(r.x0, bounds.x1 - w));
    const y0 = Math.max(bounds.y0, Math.min(r.y0, bounds.y1 - h));
    r.x0 = x0;
    r.y0 = y0;
    r.x1 = x0 + w;
    r.y1 = y0 + h;
  };
  rects.forEach((r, i) => clamp(r, inputs[i]));

  for (let iter = 0; iter < 80; iter++) {
    let moved = false;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const o = overlapAmount(rects[i], rects[j], pad);
        if (o.x <= 0 || o.y <= 0) continue;
        moved = true;
        // push apart along the axis that needs the smaller move
        const ci = { x: (rects[i].x0 + rects[i].x1) / 2, y: (rects[i].y0 + rects[i].y1) / 2 };
        const cj = { x: (rects[j].x0 + rects[j].x1) / 2, y: (rects[j].y0 + rects[j].y1) / 2 };
        if (o.x < o.y) {
          const s = ci.x <= cj.x ? -1 : 1;
          rects[i].x0 += (s * o.x) / 2;
          rects[i].x1 += (s * o.x) / 2;
          rects[j].x0 -= (s * o.x) / 2;
          rects[j].x1 -= (s * o.x) / 2;
        } else {
          const s = ci.y <= cj.y ? -1 : 1;
          rects[i].y0 += (s * o.y) / 2;
          rects[i].y1 += (s * o.y) / 2;
          rects[j].y0 -= (s * o.y) / 2;
          rects[j].y1 -= (s * o.y) / 2;
        }
      }
      // keep clear of reserved areas: out by the shortest way
      for (const rv of reserved) {
        const o = overlapAmount(rects[i], rv, pad);
        if (o.x <= 0 || o.y <= 0) continue;
        moved = true;
        const ci = { x: (rects[i].x0 + rects[i].x1) / 2, y: (rects[i].y0 + rects[i].y1) / 2 };
        const cr = { x: (rv.x0 + rv.x1) / 2, y: (rv.y0 + rv.y1) / 2 };
        if (o.x < o.y) {
          const d = (ci.x <= cr.x ? -1 : 1) * o.x;
          rects[i].x0 += d;
          rects[i].x1 += d;
        } else {
          const d = (ci.y <= cr.y ? -1 : 1) * o.y;
          rects[i].y0 += d;
          rects[i].y1 += d;
        }
      }
    }
    rects.forEach((r, i) => clamp(r, inputs[i]));
    if (!moved) break;
  }

  const out: PlacedLabel[] = inputs.map((l, i) => ({ ...l, x: rects[i].x0, y: rects[i].y0, visible: true }));
  // anything still overlapping (no room in a tight picture): the label that gives way is hidden, not drawn over another
  const rank = (f: FingerName) => GIVE_WAY.indexOf(f);
  for (let guard = 0; guard < out.length; guard++) {
    let clash = -1;
    for (let i = 0; i < out.length && clash < 0; i++) {
      if (!out[i].visible) continue;
      const ri = { x0: out[i].x, y0: out[i].y, x1: out[i].x + out[i].w, y1: out[i].y + out[i].h };
      if (reserved.some((rv) => overlapAmount(ri, rv, 0).x > 0 && overlapAmount(ri, rv, 0).y > 0)) clash = i;
      for (let j = i + 1; j < out.length && clash < 0; j++) {
        if (!out[j].visible) continue;
        const rj = { x0: out[j].x, y0: out[j].y, x1: out[j].x + out[j].w, y1: out[j].y + out[j].h };
        const o = overlapAmount(ri, rj, 0);
        if (o.x > 0 && o.y > 0) clash = rank(out[i].finger) >= rank(out[j].finger) ? i : j;
      }
    }
    if (clash < 0) break;
    out[clash].visible = false;
  }
  return out;
}

/** The labels to place for these smoothed lengths: each at the end of its fingertip's cap (a third of the last bone past the tip
 *  landmark, found with the app's own labelAnchor), pointing along the finger. `textWidth` measures a string in px. */
export function labelInputs(lm: readonly Point[], lengths: FingerLengths, textWidth: (text: string) => number, height = 22, padX = 16): LabelInput[] {
  const out: LabelInput[] = [];
  for (const finger of LABEL_FINGERS) {
    const mm = lengths[finger];
    if (mm === undefined) continue;
    const tipI = FINGER_TIPS[finger][1];
    const bone = Math.hypot(lm[tipI].x - lm[tipI - 1].x, lm[tipI].y - lm[tipI - 1].y) || 1;
    const tip = labelAnchor(lm as Point[], finger, bone * 0.3);
    const text = formatLabel(mm);
    out.push({
      finger,
      text,
      tip: { x: tip.x, y: tip.y },
      dir: { x: (lm[tipI].x - lm[tipI - 1].x) / bone, y: (lm[tipI].y - lm[tipI - 1].y) / bone },
      w: Math.ceil(textWidth(text)) + padX,
      h: height,
    });
  }
  return out;
}

/** The point of the label's box nearest the fingertip: where a thin leader line from the tip ends. */
export function leaderEnd(l: PlacedLabel): { x: number; y: number } {
  return { x: Math.max(l.x, Math.min(l.tip.x, l.x + l.w)), y: Math.max(l.y, Math.min(l.tip.y, l.y + l.h)) };
}
