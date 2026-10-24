import { describe, expect, it } from "vitest";
import { coinTiltDeg, smoothedTiltDeg, type CoinShape } from "./coinTilt";

const coin = (major: number, ratio: number, angle: number): CoinShape => ({
  major_axis_px: major,
  minor_axis_px: major * ratio,
  angle_deg: angle,
});

describe("coin tilt (same numbers as backend/tests/test_tilt_smoothing.py)", () => {
  it("one frame: acos of the axis ratio", () => {
    expect(coinTiltDeg(coin(60, 1, 0))).toBeCloseTo(0, 9);
    expect(coinTiltDeg(coin(60, Math.cos((20 * Math.PI) / 180), 0))).toBeCloseTo(20, 6);
  });

  it("matches the Python reference on noisy frames in different directions", () => {
    // Python: smoothed_coin_tilts(coins, 7)[3] = 5.300297645880132 (its raw tilt is 16.26 deg)
    const frames = [
      coin(60, 0.98, 10),
      coin(60, 0.97, 100),
      coin(60, 0.99, 45),
      coin(60, 0.96, 30),
      coin(60, 0.985, 150),
      coin(60, 0.975, 80),
      coin(60, 0.99, 120),
    ];
    expect(coinTiltDeg(frames[3])).toBeCloseTo(16.26020470831199, 6);
    expect(smoothedTiltDeg(frames)).toBeCloseTo(5.300297645880132, 6);
  });

  it("matches the Python reference on a really tilted coin and keeps its tilt", () => {
    // Python: 19.802423221423975
    const frames = [
      coin(55, 0.94, 32),
      coin(56, 0.945, 35),
      coin(55.5, 0.935, 30),
      coin(55, 0.94, 34),
      coin(56, 0.94, 31),
      coin(55, 0.945, 33),
      coin(55.5, 0.94, 36),
    ];
    expect(smoothedTiltDeg(frames)).toBeCloseTo(19.802423221423975, 6);
    expect(smoothedTiltDeg(frames)!).toBeGreaterThan(12);
  });

  it("a single coin is its own tilt, and there is none without coins", () => {
    const c = coin(60, 0.96, 77);
    expect(smoothedTiltDeg([c])).toBeCloseTo(coinTiltDeg(c), 9);
    expect(smoothedTiltDeg([])).toBeNull();
  });

  it("a flat coin with direction-free noise stays under the limit once averaged", () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const frames = Array.from({ length: 70 }, () => coin(60, 1 - Math.abs(gauss() * 0.02), rand() * 180));
    const rawOver = frames.filter((f) => coinTiltDeg(f) > 12).length / frames.length;
    let smoothOver = 0;
    for (let i = 0; i + 7 <= frames.length; i++) if (smoothedTiltDeg(frames.slice(i, i + 7))! > 12) smoothOver++;
    expect(rawOver).toBeGreaterThan(0.1);
    expect(smoothOver).toBe(0);
  });
});
