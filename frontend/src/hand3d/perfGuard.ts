// A self-protecting performance guard for the camera-view overlay (pure: no DOM, no three.js).
//
// The overlay runs on top of live hand tracking on phones of every class, and scan speed matters more than the
// picture. The guard watches a rolling average of the layer's own cost per frame and of the page's frame
// interval; when either is over budget for about a second and a half it takes the layer one step down, in this
// order, and never back up (a flickering quality is worse than a steady lower one):
//   1. half the points   2. no wireframe, no twinkle   3. 20 frames a second   4. switched off (the 2D drawing)

export interface Budget {
  /** The most the layer may cost per frame (JS time to re-pose and draw), in ms. */
  maxFrameMs: number;
  /** The slowest the page may run (frames a second) before the layer steps down. */
  minFps: number;
}

export const DEFAULT_BUDGET: Budget = { maxFrameMs: 9, minFps: 18 };

export type Level = 0 | 1 | 2 | 3 | 4;

export interface Plan {
  level: Level;
  /** Share of the points that are posed and drawn. */
  pointFraction: number;
  wire: boolean;
  twinkle: boolean;
  /** Frames a second the layer draws. */
  fps: number;
  disabled: boolean;
}

const PLANS: readonly Plan[] = [
  { level: 0, pointFraction: 1, wire: true, twinkle: true, fps: 30, disabled: false },
  { level: 1, pointFraction: 0.5, wire: true, twinkle: true, fps: 30, disabled: false },
  { level: 2, pointFraction: 0.5, wire: false, twinkle: false, fps: 30, disabled: false },
  { level: 3, pointFraction: 0.5, wire: false, twinkle: false, fps: 20, disabled: false },
  { level: 4, pointFraction: 0, wire: false, twinkle: false, fps: 20, disabled: true },
];

const EMA = 0.1; // weight of the newest frame in the rolling averages
const WARMUP_TICKS = 12; // the first frames compile shaders and upload buffers: not judged
const SETTLE_TICKS = 8; // after a step down the averages start again
const GAP_MS = 250; // a longer gap between ticks is a hidden tab or a stall, not slowness

export class PerfGuard {
  private level: Level = 0;
  private cost = -1;
  private interval = -1;
  private lastTick = -1;
  private ticks = 0;
  private overSince = -1;
  private ignore = WARMUP_TICKS;

  constructor(
    private readonly budget: Budget = DEFAULT_BUDGET,
    private readonly overMs = 1500,
  ) {}

  get plan(): Plan {
    return PLANS[this.level];
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
    if (this.level === 4) return this.plan;
    if (this.ignore > 0) {
      this.ignore--;
      return this.plan;
    }
    const slowPage = this.interval > 1000 / this.budget.minFps;
    const heavy = this.cost > this.budget.maxFrameMs;
    if (slowPage || heavy) {
      if (this.overSince < 0) this.overSince = now;
      else if (now - this.overSince >= this.overMs) this.stepDown();
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

  private stepDown(): void {
    this.level = Math.min(4, this.level + 1) as Level;
    this.cost = -1;
    this.interval = -1;
    this.overSince = -1;
    this.ignore = SETTLE_TICKS;
  }
}
