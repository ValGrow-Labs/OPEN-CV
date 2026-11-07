import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, LAST_VISIBLE_LEVEL, OWN_SHARE, PAGE_SLOW_FLOOR, PerfGuard, type Plan } from "./perfGuard";

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
    expect(p).toMatchObject({ level: 0, pointFraction: 1, rings: true, halo: true, sweep: true, wire: true, nodes: true, fps: 30, disabled: false });
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
    for (let i = 0; i < 6000 && g.plan.level < 5; i++) {
      now += 16.7;
      const p = g.tick(now);
      g.frame(25); // far over 9 ms
      if (p.level !== last) {
        seen.push(p);
        last = p.level;
      }
    }
    expect(seen.map((p) => p.level)).toEqual([0, 1, 2, 3, 4, 5]);
    // the look goes first: halo and sweep, then wireframe and nodes; the points and the frame rate last
    expect(seen[1]).toMatchObject({ pointFraction: 1, rings: false, halo: false, sweep: false, wire: true, nodes: true, fps: 30 });
    expect(seen[2]).toMatchObject({ pointFraction: 1, halo: false, sweep: false, wire: false, nodes: false, fps: 30 });
    expect(seen[3]).toMatchObject({ pointFraction: 0.5, wire: false, nodes: false, fps: 30 }); // half the points
    expect(seen[4]).toMatchObject({ pointFraction: 0.5, fps: 20 }); // 20 fps
    expect(seen[5].disabled).toBe(true);
  });

  it("drops the orbit rings and sparkles first, at the very first step, and never brings them back", () => {
    const g = new PerfGuard({ maxFrameMs: 9, minFps: 18 });
    expect(g.plan.rings).toBe(true);
    let now = 0;
    let firstDown = -1;
    for (let i = 0; i < 6000 && g.plan.level < 5; i++) {
      now += 16.7;
      const p = g.tick(now);
      g.frame(25);
      if (p.level === 1 && firstDown < 0) {
        firstDown = i;
        // the same step that loses the halo and the sweep, while the wireframe, nodes and every point are still there
        expect(p).toMatchObject({ rings: false, halo: false, sweep: false, wire: true, nodes: true, pointFraction: 1 });
      }
      if (p.level >= 1) expect(p.rings).toBe(false);
    }
    expect(firstDown).toBeGreaterThan(0);
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

  it("a slow page (frame interval over 1 / minFps) steps it down, even when its own cost is small, but only to the floor", () => {
    const g = new PerfGuard({ maxFrameMs: 9, minFps: 24 });
    run(g, 0, 10, 60, 1); // about 16 frames a second
    expect(g.plan.level).toBe(PAGE_SLOW_FLOOR);
    expect(g.plan).toMatchObject({ rings: false, halo: false, sweep: false, wire: true, nodes: true, pointFraction: 1, disabled: false });
  });

  it("a page that stays busy for minutes (a slow tracker, a cheap layer) never switches the layer off", () => {
    // The real phone: the hand tracker and the coin search set the page's frame rate (a frame every 150 ms, 6 fps),
    // the layer itself costs a few ms. It must stay a visible 3D hand, not hand back to the 2D drawing.
    for (const interval of [90, 150, 240]) {
      const g = new PerfGuard({ maxFrameMs: 40, minFps: 12 }); // the shipped config
      run(g, 0, 300, interval, 4);
      expect(g.plan.level).toBe(PAGE_SLOW_FLOOR);
      expect(g.plan.disabled).toBe(false);
      expect(g.disabledReason).toBeNull();
    }
  });

  it("a busy page with a layer that takes a big share of every frame steps all the way down", () => {
    const g = new PerfGuard({ maxFrameMs: 40, minFps: 12 });
    // page frame every 120 ms (8 fps) and the layer costs 60% of it: the layer is a big part of the problem
    run(g, 0, 120, 120, 0.6 * 120 * 0.8);
    expect(g.plan.level).toBeGreaterThan(PAGE_SLOW_FLOOR);
    expect(OWN_SHARE).toBeLessThan(0.6 * 0.8);
  });

  it("is switched off only when its own cost is over budget even at the last visible level, with the reason", () => {
    const g = new PerfGuard({ maxFrameMs: 9, minFps: 18 });
    const levels: number[] = [];
    let now = 0;
    for (let i = 0; i < 8000 && !g.plan.disabled; i++) {
      now += 16.7;
      levels.push(g.tick(now).level);
      g.frame(25);
    }
    expect(new Set(levels).has(LAST_VISIBLE_LEVEL)).toBe(true);
    expect(g.plan.disabled).toBe(true);
    expect(g.disabledReason).toBe("too_slow");
  });

  it("a cheap layer is never switched off by a slow page, however slow the page gets", () => {
    const g = new PerfGuard({ maxFrameMs: 9, minFps: 18 });
    run(g, 0, 120, 200, 1); // 5 fps, 1 ms of its own
    expect(g.plan.disabled).toBe(false);
    expect(g.disabledReason).toBeNull();
  });

  it("exposes its rolling numbers for diagnostics", () => {
    const g = new PerfGuard();
    expect(g.costMs).toBe(-1);
    expect(g.intervalMs).toBe(-1);
    run(g, 0, 3, 20, 3);
    expect(g.costMs).toBeGreaterThan(0);
    expect(g.intervalMs).toBeCloseTo(20, 0);
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

  it("is switched off for good: nothing changes after the last level", () => {
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
