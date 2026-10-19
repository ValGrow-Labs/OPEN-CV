import { describe, expect, it } from "vitest";
import { LandmarkSmoother, OneEuroFilter } from "./smoothing";

const sd = (a: number[]) => {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};

describe("One Euro filter", () => {
  it("passes a constant signal unchanged", () => {
    const f = new OneEuroFilter();
    let y = 0;
    for (let i = 0; i < 30; i++) y = f.filter(100, i * 33);
    expect(y).toBeCloseTo(100, 9);
  });

  it("reduces jitter on a static target", () => {
    const f = new OneEuroFilter();
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 4;
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 200; i++) {
      const v = 50 + rand();
      raw.push(v);
      out.push(f.filter(v, i * 33));
    }
    expect(sd(out.slice(50))).toBeLessThan(sd(raw.slice(50)) * 0.6);
  });

  it("follows fast motion with limited lag", () => {
    const f = new OneEuroFilter();
    let y = 0;
    for (let i = 0; i < 20; i++) y = f.filter(i * 20, i * 33);
    expect(380 - y).toBeLessThan(40);
  });

  it("smooths whole landmark sets", () => {
    const s = new LandmarkSmoother();
    const pts = Array.from({ length: 21 }, (_, i) => ({ x: i, y: i, z: 0 }));
    expect(s.smooth(pts, 0)).toEqual(pts);
  });
});
