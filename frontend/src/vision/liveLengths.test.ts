import { describe, expect, it } from "vitest";
import type { Point } from "../api/types";
import { labelAnchor, liveLengths } from "./liveLengths";

/** A straight, upright hand: wrist at y = 200, fingers pointing up (decreasing y). */
function hand(): Point[] {
  const p: Point[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  p[0] = { x: 100, y: 200, z: 0 };
  const fingers: [number, number][] = [
    [1, 60],
    [5, 80],
    [9, 100],
    [13, 120],
    [17, 140],
  ];
  for (const [base, x] of fingers) for (let j = 0; j < 4; j++) p[base + j] = { x, y: 120 - 20 * j, z: 0 };
  return p;
}

describe("live lengths during a scan", () => {
  it("scales landmark distances by the coin", () => {
    // 50 px coin of 25 mm: 2 px per mm.
    const r = liveLengths(hand(), 50, 25)!;
    expect(r.handMm).toBeCloseTo(Math.hypot(0, 200 - 60) / 2, 6); // wrist (100,200) to middle tip (100,60)
    expect(r.fingersMm.middle).toBeCloseTo(60 / 2, 6); // MCP (y 120) to tip (y 60)
    expect(r.fingersMm.thumb).toBeCloseTo(40 / 2, 6); // thumb MCP is landmark 2 (y 100) to tip (y 60)
  });

  it("gives nothing without a usable coin", () => {
    expect(liveLengths(hand(), 0, 25)).toBeNull();
    expect(liveLengths(hand(), 50, Number.NaN)).toBeNull();
  });

  it("places a label beyond the fingertip, along the finger", () => {
    const a = labelAnchor(hand(), "index", 15);
    expect(a.x).toBeCloseTo(80, 6);
    expect(a.y).toBeCloseTo(60 - 15, 6);
  });
});
