import { describe, expect, it } from "vitest";
import { captureParams, goodFrame } from "../test/fixtures";
import { chainBendDeg, handTurn, jitterFraction, LONG_FINGERS, PALM_POLYGON, palmCentre, medianHandTurn, medianOf, palmTiltDeg, pointInPolygon } from "./geometry";

describe("geometry", () => {
  it("measures finger bend", () => {
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 10, z: 0 },
      { x: 0, y: 20, z: 0 },
      { x: 10, y: 20, z: 0 },
    ];
    expect(chainBendDeg(pts, [0, 1, 2, 3])).toBeCloseTo(90, 6);
    expect(chainBendDeg(pts, [0, 1, 2])).toBeCloseTo(0, 6);
    expect(Number.isNaN(chainBendDeg([pts[0], pts[0], pts[1]], [0, 1, 2]))).toBe(true);
  });

  it("detects palm tilt from world landmarks", () => {
    const f = goodFrame();
    const flat = f.landmarks.map((p) => ({ x: p.x / 1000, y: p.y / 1000, z: 0 }));
    expect(palmTiltDeg(flat)).toBeCloseTo(0, 6);
    const t = (40 * Math.PI) / 180;
    const tilted = flat.map((p) => ({ x: p.x, y: p.y * Math.cos(t), z: p.y * Math.sin(t) }));
    expect(palmTiltDeg(tilted)).toBeCloseTo(40, 4);
  });

  it("locates the palm centre inside the palm polygon", () => {
    const f = goodFrame();
    const c = palmCentre(f.landmarks);
    const poly = PALM_POLYGON.map((i) => f.landmarks[i]);
    expect(pointInPolygon(c.x, c.y, poly)).toBe(true);
    expect(pointInPolygon(c.x, c.y - 2000, poly)).toBe(false);
  });

  it("measures jitter relative to hand size", () => {
    const f = goodFrame();
    expect(jitterFraction(f.landmarks, f.landmarks)).toBe(0);
    expect(jitterFraction(f.landmarks, f.landmarks.map((p) => ({ ...p, x: p.x + 5 })))).toBeGreaterThan(0);
  });

  it("the canonical synthetic hand has straight fingers", () => {
    const f = goodFrame();
    for (const chain of Object.values(LONG_FINGERS)) expect(chainBendDeg(f.landmarks, chain)).toBeLessThan(5);
  });
});

describe("hand turn (which way up the hand is)", () => {
  const mirrored = (lm: { x: number; y: number; z: number }[], w: number) => lm.map((p) => ({ ...p, x: w - p.x }));

  it("is about 0.67 in size for the canonical open hand (the sine of the knuckle angle)", () => {
    const f = goodFrame();
    expect(handTurn(f.landmarks)).toBeCloseTo(-0.672, 2);
    expect(Math.abs(handTurn(f.landmarks))).toBeGreaterThan(0.5);
    expect(Math.abs(handTurn(f.landmarks))).toBeLessThan(0.8);
  });

  it("flips sign, and keeps its size, when the hand is turned over (mirrored)", () => {
    const f = goodFrame();
    const a = handTurn(f.landmarks);
    const b = handTurn(mirrored(f.landmarks, f.image_width));
    expect(Math.sign(b)).toBe(-Math.sign(a));
    expect(b).toBeCloseTo(-a, 9);
  });

  it("does not change when the hand is rotated in the picture or scaled", () => {
    const f = goodFrame();
    const t = 0.7;
    const rot = f.landmarks.map((p) => ({ ...p, x: 3 * (p.x * Math.cos(t) - p.y * Math.sin(t)), y: 3 * (p.x * Math.sin(t) + p.y * Math.cos(t)) }));
    expect(handTurn(rot)).toBeCloseTo(handTurn(f.landmarks), 9);
  });

  it("is near 0 for a hand seen edge-on and 0 for a degenerate hand", () => {
    const f = goodFrame();
    const flat = f.landmarks.map((p) => ({ ...p, y: f.landmarks[0].y + (p.y - f.landmarks[0].y) * 0.01, x: f.landmarks[0].x + (p.x - f.landmarks[0].x) * 0.01 }));
    const edge = f.landmarks.map((p) => ({ ...p, x: f.landmarks[0].x + (p.x - f.landmarks[0].x) * 0.05 }));
    expect(Math.abs(handTurn(edge))).toBeLessThan(captureParams.views[2].max_hand_turn_abs!);
    expect(Math.abs(handTurn(flat))).toBeGreaterThan(0); // tiny but finite
    expect(handTurn(f.landmarks.map((p) => ({ ...p, x: 5, y: 5 })))).toBe(0);
  });

  it("medianOf: 0 for none, the middle of an odd count, the mean of the middle two, NaN ignored", () => {
    expect(medianOf([])).toBe(0);
    expect(medianOf([5])).toBe(5);
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    expect(medianOf([1, Number.NaN, 3, 5, Number.NaN])).toBe(3);
    expect(medianOf([Number.NaN])).toBe(0);
  });

  it("takes the median over frames, ignoring a stray frame, and is 0 for no frames", () => {
    const f = goodFrame();
    const flipped = { landmarks: mirrored(f.landmarks, f.image_width) };
    const frames = [f, f, f, flipped];
    expect(medianHandTurn(frames)).toBeCloseTo(handTurn(f.landmarks), 9);
    expect(medianHandTurn([f, flipped])).toBeCloseTo(0, 9); // even count: mean of the middle two
    expect(medianHandTurn([])).toBe(0);
  });
});
