// The validation statistics, on made-up numbers whose answers are known by hand. (Synthetic arithmetic; no validation data exists.)
import { describe, expect, it } from "vitest";
import { errorStats, failureRate, median, repeatability } from "./stats";

describe("errorStats", () => {
  it("computes bias, MAE, RMSE, SD and the extremes of known errors", () => {
    // estimate - reference = +1, 0, -1, +2
    const s = errorStats([
      { estimate: 10, reference: 9 },
      { estimate: 12, reference: 12 },
      { estimate: 8, reference: 9 },
      { estimate: 7, reference: 5 },
    ])!;
    expect(s.n).toBe(4);
    expect(s.bias).toBeCloseTo(0.5, 12);
    expect(s.mae).toBeCloseTo(1, 12);
    expect(s.rmse).toBeCloseTo(Math.sqrt(6 / 4), 12);
    expect(s.sd).toBeCloseTo(Math.sqrt(((0.5) ** 2 + 0.5 ** 2 + 1.5 ** 2 + 1.5 ** 2) / 3), 12);
    expect(s.maxAbs).toBe(2);
    expect(s.p95Abs).toBe(2);
  });

  it("a method with only a constant offset has bias equal to the offset and no spread", () => {
    const s = errorStats([1, 2, 3, 4].map((r) => ({ estimate: r + 3, reference: r })))!;
    expect(s.bias).toBe(3);
    expect(s.sd).toBe(0);
    expect(s.rmse).toBe(3);
  });

  it("ignores non-finite values and returns null when nothing is left", () => {
    expect(errorStats([{ estimate: NaN, reference: 1 }, { estimate: 2, reference: Infinity }])).toBeNull();
    expect(errorStats([])).toBeNull();
    expect(errorStats([{ estimate: 5, reference: 4 }, { estimate: NaN, reference: 1 }])!.n).toBe(1);
  });

  it("RMSE is never smaller than MAE", () => {
    const s = errorStats([3, -1, 0.2, -4, 2].map((e) => ({ estimate: e, reference: 0 })))!;
    expect(s.rmse).toBeGreaterThanOrEqual(s.mae);
  });
});

describe("failureRate", () => {
  it("counts attempts that gave no usable reconstruction", () => {
    expect(failureRate([{ ok: true }, { ok: false }, { ok: true }, { ok: false }])).toEqual({ attempts: 4, failures: 2, rate: 0.5 });
    expect(failureRate([]).rate).toBeNaN();
  });
});

describe("repeatability", () => {
  it("gives mean, SD, range, CV and the 95 % repeatability limit of repeated measurements of the same hand", () => {
    const r = repeatability([100, 102, 98, 100])!;
    expect(r.n).toBe(4);
    expect(r.mean).toBe(100);
    expect(r.sd).toBeCloseTo(Math.sqrt(8 / 3), 12);
    expect(r.range).toBe(4);
    expect(r.cvPercent).toBeCloseTo((100 * Math.sqrt(8 / 3)) / 100, 12);
    expect(r.repeatabilityLimit95).toBeCloseTo(2.77 * Math.sqrt(8 / 3), 12);
  });

  it("needs at least two finite repeats", () => {
    expect(repeatability([5])).toBeNull();
    expect(repeatability([5, NaN])).toBeNull();
    expect(repeatability([])).toBeNull();
  });
});

describe("median", () => {
  it("handles odd, even and empty sets", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});
