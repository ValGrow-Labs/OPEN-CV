// One Euro filter (Casiez et al., CHI 2012) for smooth landmark rendering.
// Used for the live overlay only; measurements use the raw per-frame landmarks and are
// aggregated robustly (median + outlier rejection) on the server.
import type { Point } from "../api/types";

class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number | null {
    return this.y;
  }
  reset(): void {
    this.y = null;
  }
}

const alphaFor = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuroFilter {
  private x = new LowPass();
  private dx = new LowPass();
  private lastT: number | null = null;

  constructor(
    private minCutoff = 1.2,
    private beta = 0.02,
    private dCutoff = 1.0,
  ) {}

  filter(value: number, tMs: number): number {
    if (this.lastT === null) {
      this.lastT = tMs;
      this.dx.filter(0, 1);
      return this.x.filter(value, 1);
    }
    const dt = Math.max(1e-3, (tMs - this.lastT) / 1000);
    this.lastT = tMs;
    const prev = this.x.last() ?? value;
    const edx = this.dx.filter((value - prev) / dt, alphaFor(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastT = null;
  }
}

export class LandmarkSmoother {
  private filters: OneEuroFilter[][] = [];

  smooth(points: Point[], tMs: number): Point[] {
    if (this.filters.length !== points.length) {
      this.filters = points.map(() => [new OneEuroFilter(), new OneEuroFilter()]);
    }
    return points.map((p, i) => ({ x: this.filters[i][0].filter(p.x, tMs), y: this.filters[i][1].filter(p.y, tMs), z: p.z }));
  }

  reset(): void {
    this.filters = [];
  }
}
