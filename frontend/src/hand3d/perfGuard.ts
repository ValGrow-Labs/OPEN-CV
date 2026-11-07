// A self-protecting performance guard for the camera-view overlay (pure: no DOM, no three.js).
//
// The overlay runs on top of live hand tracking on phones of every class, and scan speed matters more than the
// picture. The guard watches a rolling average of the layer's OWN cost per frame and of the page's frame
// interval, and takes the layer one step down when either is over budget for about a second and a half, in this
// order, and never back up (a flickering quality is worse than a steady lower one):
//   1. no orbit rings or sparkles, no halo of dust, no scanning sweep or twinkle   2. no wireframe, no joint nodes
//   3. half the points   4. 20 frames a second   5. switched off (the 2D drawing)
//
// Who is to blame decides how far it may go (the lesson of a busy phone: the page's frame rate is set by the hand
// tracker and the coin search, not by this layer, and a layer switched off for slowness it did not cause is a
// missing 3D hand):
//   * The layer's own cost is over budget (over ``maxFrameMs``, or, while the page is slow, over OWN_SHARE of the page's
//     frame interval, i.e. the layer itself eats a big part of every frame): it may go all the way down, and is
//     switched off only if it is STILL over budget at the last visible level (reason "too_slow").
//   * Only the page is slow (the layer is cheap): it goes down to PAGE_SLOW_FLOOR (no rings, halo or sweep, but every
//     point, the wireframe and the joint nodes) and stays visible however long the page stays slow.

export interface Budget {
  /** The most the layer may cost per frame (JS time to re-pose and draw), in ms. */
  maxFrameMs: number;
  /** The slowest the page may run (frames a second) before the layer steps down. */
  minFps: number;
}

export const DEFAULT_BUDGET: Budget = { maxFrameMs: 9, minFps: 18 };

export type Level = 0 | 1 | 2 | 3 | 4 | 5;

/** The lowest level a merely busy PAGE (cheap layer, slow tracker) takes the layer to: still a full 3D hand. */
export const PAGE_SLOW_FLOOR: Level = 1;
/** While the page is slow, the share of the page's frame interval the layer's own cost may take. */
export const OWN_SHARE = 0.4;
/** The last level that still draws a hand; the guard switches the layer off only from here. */
export const LAST_VISIBLE_LEVEL: Level = 4;

export interface Plan {
  level: Level;
  /** Share of the points that are posed and drawn. */
  pointFraction: number;
  /** The two luminous orbit rings and the sparkles round the hand (the first thing a slow phone loses). */
  rings: boolean;
  /** The soft halo of dust round the hand. */
  halo: boolean;
  /** The scanning sweep and the twinkle of the points. */
  sweep: boolean;
  /** The thin wireframe outline. */
  wire: boolean;
  /** The glowing nodes at the 21 joints. */
  nodes: boolean;
  /** Frames a second the layer draws. */
  fps: number;
  disabled: boolean;
}

const PLANS: readonly Plan[] = [
  { level: 0, pointFraction: 1, rings: true, halo: true, sweep: true, wire: true, nodes: true, fps: 30, disabled: false },
  { level: 1, pointFraction: 1, rings: false, halo: false, sweep: false, wire: true, nodes: true, fps: 30, disabled: false },
  { level: 2, pointFraction: 1, rings: false, halo: false, sweep: false, wire: false, nodes: false, fps: 30, disabled: false },
  { level: 3, pointFraction: 0.5, rings: false, halo: false, sweep: false, wire: false, nodes: false, fps: 30, disabled: false },
  { level: 4, pointFraction: 0.5, rings: false, halo: false, sweep: false, wire: false, nodes: false, fps: 20, disabled: false },
  { level: 5, pointFraction: 0, rings: false, halo: false, sweep: false, wire: false, nodes: false, fps: 20, disabled: true },
];

const EMA = 0.1; // weight of the newest frame in the rolling averages
const WARMUP_TICKS = 12; // the first frames compile shaders and upload buffers: not judged
const SETTLE_TICKS = 8; // after a step down the averages start again
const GAP_MS = 250; // a longer gap between ticks is a hidden tab or a stall, not slowness

export type DisableReason = "too_slow";

export class PerfGuard {
  private level: Level = 0;
  private cost = -1;
  private interval = -1;
  private lastTick = -1;
  private ticks = 0;
  private overSince = -1;
  private ignore = WARMUP_TICKS;
  private why: DisableReason | null = null;

  constructor(
    private readonly budget: Budget = DEFAULT_BUDGET,
    private readonly overMs = 1500,
  ) {}

  get plan(): Plan {
    return PLANS[this.level];
  }

  /** Why the layer was switched off (null while it is on). */
  get disabledReason(): DisableReason | null {
    return this.why;
  }

  /** Read-only numbers for diagnostics (window.__OVERLAY_STATS__): the rolling cost of the layer's own frame in
   *  ms (-1: not measured yet) and the rolling page frame interval in ms (-1: not measured yet). */
  get costMs(): number {
    return this.cost;
  }

  get intervalMs(): number {
    return this.interval;
  }

  /** Call on every animation frame the page gets (drawn or not) with its timestamp in ms. */
  tick(now: number): Plan {
    if (this.lastTick >= 0) {
      const dt = now - this.lastTick;
      if (dt > GAP_MS || dt < 0) {
        this.interval = -1; // hidden tab, resume, clock jump: start measuring again
        this.overSince = -1;
      } else {
        this.interval = this.interval < 0 ? dt : this.interval + EMA * (dt - this.interval);
      }
    }
    this.lastTick = now;
    this.ticks++;
    if (this.level === 5) return this.plan;
    if (this.ignore > 0) {
      this.ignore--;
      return this.plan;
    }
    const slowPage = this.interval > 1000 / this.budget.minFps;
    const heavy = this.cost > this.budget.maxFrameMs || (slowPage && this.interval > 0 && this.cost > OWN_SHARE * this.interval);
    if (slowPage || heavy) {
      if (this.overSince < 0) this.overSince = now;
      else if (now - this.overSince >= this.overMs) this.stepDown(heavy);
    } else {
      this.overSince = -1;
    }
    return this.plan;
  }

  /** Call after each frame the layer draws with what it cost, in ms. */
  frame(costMs: number): void {
    if (!(costMs >= 0) || this.ignore > 0) return;
    this.cost = this.cost < 0 ? costMs : this.cost + EMA * (costMs - this.cost);
  }

  /** ``ownCost``: the layer itself is over budget (it may go all the way down); otherwise only the page is slow. */
  private stepDown(ownCost: boolean): void {
    if (!ownCost && this.level >= PAGE_SLOW_FLOOR) {
      this.overSince = -1; // a busy page, a cheap layer: it stays as it is, visible
      return;
    }
    this.level = Math.min(5, this.level + 1) as Level;
    if (this.level === 5) this.why = "too_slow";
    this.cost = -1;
    this.interval = -1;
    this.overSince = -1;
    this.ignore = SETTLE_TICKS;
  }
}
