import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, PerfGuard, type Plan } from "./perfGuard";

/** Run the guard for ``seconds`` of simulated animation frames. */
function run(guard: PerfGuard, startMs: number, seconds: number, intervalMs: number, costMs: number | ((i: number) => number)): number {
  let now = startMs;
  const frames = Math.round((seconds * 1000) / intervalMs);
  for (let i = 0; i < frames; i++) {
    now += intervalMs;
    guard.tick(now);
    guard.frame(typeof costMs === "function" ? costMs(i) : costMs);
  }
  return now;
}

describe("PerfGuard", () => {
  it("starts at full quality", () => {
    const p = new PerfGuard().plan;
    expect(p).toMatchObject({ level: 0, pointFraction: 1, wire: true, twinkle: true, fps: 30, disabled: false });
  });

  it("stays at full quality for a long, healthy run (thousands of frames)", () => {
    const g = new PerfGuard();
    const levels = new Set<number>();
    let now = 0;
    for (let i = 0; i < 20000; i++) {
      now += 16.7;
      levels.add(g.tick(now).level);
      g.frame(1.5 + (i % 7) * 0.2); // a couple of ms, with a little noise
    }
    expect([...levels]).toEqual([0]);
  });

  it("ignores the first frames (shader compile, buffer upload)", () => {
    const g = new PerfGuard();
    let now = 0;
    for (let i = 0; i < 12; i++) {
      now += 200; // slow, but inside the warm-up
      g.tick(now);
      g.frame(120);
    }
    // then healthy: nothing was held against it
    run(g, now, 10, 16.7, 2);
    expect(g.plan.level).toBe(0);
  });

  it("steps down one level at a time, in order, each after about 1.5 s over budget", () => {
    const g = new PerfGuard({ maxFrameMs: 9, minFps: 18 });
    const seen: Plan[] = [];
    let now = 0;
    let last = -1;
    for (let i = 0; i < 4000 && g.plan.level < 4; i++) {
      now += 16.7;
      const p = g.tick(now);
      g.frame(25); // far over 9 ms
      if (p.level !== last) {
        seen.push(p);
        last = p.level;
      }
    }
    expect(seen.map((p) => p.level)).toEqual([0, 1, 2, 3, 4]);
    expect(seen[1]).toMatchObject({ pointFraction: 0.5, wire: true, twinkle: true, fps: 30 }); // half the points
    expect(seen[2]).toMatchObject({ pointFraction: 0.5, wire: false, twinkle: false, fps: 30 }); // no wireframe, no twinkle
    expect(seen[3]).toMatchObject({ pointFraction: 0.5, wire: false, twinkle: false, fps: 20 }); // 20 fps
    expect(seen[4].disabled).toBe(true);
  });

  it("does not step down for a brief spike", () => {
    const g = new PerfGuard();
    let now = run(g, 0, 3, 16.7, 2);
    now = run(g, now, 0.6, 16.7, 40); // 0.6 s of heavy frames
    run(g, now, 5, 16.7, 2);
    expect(g.plan.level).toBe(0);
  });

  it("each step needs a full window over budget", () => {
    const g = new PerfGuard({ maxFrameMs: 9, minFps: 18 }, 1500);
    let now = run(g, 0, 1.2, 16.7, 30);
    expect(g.plan.level).toBe(0); // 1.2 s is not enough
    now = run(g, now, 0.6, 16.7, 30);
    expect(g.plan.level).toBe(1);
    now = run(g, now, 1.0, 16.7, 30); // the averages start again after a step
    expect(g.plan.level).toBe(1);
    run(g, now, 1.2, 16.7, 30);
    expect(g.plan.level).toBe(2);
  });

  it("never steps back up, however healthy it gets", () => {
    const g = new PerfGuard();
    let now = run(g, 0, 8, 16.7, 30);
    const level = g.plan.level;
    expect(level).toBeGreaterThan(0);
    now = run(g, now, 120, 16.7, 0.5);
    expect(g.plan.level).toBe(level);
  });

  it("a slow page (frame interval over 1 / minFps) also steps it down, even when its own cost is small", () => {
    const g = new PerfGuard({ maxFrameMs: 9, minFps: 24 });
    run(g, 0, 10, 60, 1); // about 16 frames a second
    expect(g.plan.level).toBeGreaterThan(0);
  });

  it("a frame interval just inside the budget is fine", () => {
    const g = new PerfGuard({ maxFrameMs: 9, minFps: 24 });
    run(g, 0, 20, 40, 1); // 25 frames a second
    expect(g.plan.level).toBe(0);
  });

  it("a long gap between ticks (a hidden tab) is not slowness", () => {
    const g = new PerfGuard();
    let now = run(g, 0, 3, 16.7, 2);
    for (let i = 0; i < 20; i++) {
      now += 30_000; // the tab was in the background
      g.tick(now);
      g.frame(2);
      now = run(g, now, 0.3, 16.7, 2);
    }
    expect(g.plan.level).toBe(0);
  });

  it("is switched off for good: nothing changes after level 4", () => {
    const g = new PerfGuard();
    run(g, 0, 60, 16.7, 40);
    expect(g.plan.disabled).toBe(true);
    const before = g.plan;
    run(g, 100_000, 30, 16.7, 0.1);
    expect(g.plan).toBe(before);
  });

  it("uses the budget it is given", () => {
    const strict = new PerfGuard({ maxFrameMs: 2, minFps: 18 });
    const lenient = new PerfGuard({ maxFrameMs: 30, minFps: 18 });
    run(strict, 0, 4, 16.7, 6);
    run(lenient, 0, 4, 16.7, 6);
    expect(strict.plan.level).toBeGreaterThan(0);
    expect(lenient.plan.level).toBe(0);
    expect(DEFAULT_BUDGET.maxFrameMs).toBeGreaterThan(0);
    expect(DEFAULT_BUDGET.minFps).toBeGreaterThan(0);
  });

  it("ignores nonsense costs and a clock that runs backwards", () => {
    const g = new PerfGuard();
    let now = run(g, 0, 2, 16.7, 2);
    g.frame(Number.NaN);
    g.frame(-5);
    now -= 5000;
    g.tick(now);
    run(g, now, 5, 16.7, 2);
    expect(g.plan.level).toBe(0);
  });
});
