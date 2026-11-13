import { describe, expect, it } from "vitest";
import { genericHand } from "../hand3d/handModel";
import { particleCount, skinSamples, skinTable, swarmShare, videoToCanvas } from "./swarm";

/** The generic hand as image pixels: 500 px wrist to fingertip, wrist at (300, 600). */
const hand = (dx = 0, dy = 0) => genericHand().map((p) => ({ x: 300 + dx + p.x * 500, y: 600 + dy - p.y * 500, z: 0 }));

describe("videoToCanvas", () => {
  it("covers the canvas, centred (object-fit: cover)", () => {
    // a 1280x720 video in a 360x640 portrait window: scaled by 640/720, cropped left and right
    const m = videoToCanvas({ x: 640, y: 360 }, { width: 1280, height: 720 }, { width: 360, height: 640 }, false);
    expect(m.x).toBeCloseTo(180, 5);
    expect(m.y).toBeCloseTo(320, 5);
    const left = videoToCanvas({ x: 0, y: 0 }, { width: 1280, height: 720 }, { width: 360, height: 640 }, false);
    expect(left.x).toBeLessThan(0); // cropped
  });

  it("mirrors for a front camera", () => {
    const a = videoToCanvas({ x: 100, y: 50 }, { width: 640, height: 480 }, { width: 400, height: 300 }, false);
    const b = videoToCanvas({ x: 100, y: 50 }, { width: 640, height: 480 }, { width: 400, height: 300 }, true);
    expect(a.x + b.x).toBeCloseTo(400, 5);
    expect(a.y).toBeCloseTo(b.y, 5);
  });
});

describe("skin samples", () => {
  const table = skinTable(400);
  const run = (lm: ReturnType<typeof hand>) => {
    const out = new Float32Array(800);
    skinSamples(lm, table, out);
    return out;
  };

  it("are deterministic and follow the hand when it moves", () => {
    const a = run(hand());
    const b = run(hand());
    expect([...a]).toEqual([...b]);
    const moved = run(hand(80, -40));
    for (let i = 0; i < 400; i++) {
      expect(moved[2 * i] - a[2 * i]).toBeCloseTo(80, 3);
      expect(moved[2 * i + 1] - a[2 * i + 1]).toBeCloseTo(-40, 3);
    }
  });

  it("lie on the hand: inside its bounding box, grown by a finger's width", () => {
    const lm = hand();
    const out = run(lm);
    const xs = lm.map((p) => p.x);
    const ys = lm.map((p) => p.y);
    const pad = 0.06 * 500;
    for (let i = 0; i < 400; i++) {
      expect(out[2 * i]).toBeGreaterThanOrEqual(Math.min(...xs) - pad);
      expect(out[2 * i]).toBeLessThanOrEqual(Math.max(...xs) + pad);
      expect(out[2 * i + 1]).toBeGreaterThanOrEqual(Math.min(...ys) - pad);
      expect(out[2 * i + 1]).toBeLessThanOrEqual(Math.max(...ys) + pad);
    }
  });

  it("spread over the palm and the fingers", () => {
    const parts = new Set(table.part);
    expect(parts.size).toBeGreaterThan(12);
    const palm = [...table.part].filter((p) => p < 5).length;
    expect(palm / 400).toBeGreaterThan(0.3);
    expect(palm / 400).toBeLessThan(0.7);
  });
});

describe("how many particles swarm and are drawn", () => {
  it("swarm more as the real coverage grows, from most of them to all of them", () => {
    expect(swarmShare(0)).toBeCloseTo(0.6, 5);
    expect(swarmShare(50)).toBeCloseTo(0.8, 5);
    expect(swarmShare(100)).toBeCloseTo(1, 5);
    expect(swarmShare(-5)).toBe(swarmShare(0));
    expect(swarmShare(250)).toBe(swarmShare(100));
    expect(swarmShare(Number.NaN)).toBe(swarmShare(0));
  });

  it("are scaled down by the speed guard and never to nothing", () => {
    expect(particleCount(460, 1)).toBe(460);
    expect(particleCount(460, 0.5)).toBe(230);
    expect(particleCount(460, 0)).toBeGreaterThan(0);
  });
});
