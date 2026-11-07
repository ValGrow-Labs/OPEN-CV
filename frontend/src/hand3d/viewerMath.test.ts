import { describe, expect, it } from "vitest";
import { CAPTION, fitDistance, handLabel, hasDepth, isUsableHand, palmFacesCamera, SCENE_PER_METRE, sceneRadius, smoothInto, toScene, type WorldPoint } from "./viewerMath";

/** A flat, upright right hand seen palm-first: fingers up (y negative), index knuckle on the picture's right. */
function hand(over: (i: number, p: WorldPoint) => WorldPoint = (_i, p) => p): WorldPoint[] {
  const pts: WorldPoint[] = [];
  for (let i = 0; i < 21; i++) pts.push({ x: 0, y: 0, z: 0 });
  pts[0] = { x: 0, y: 0.09, z: 0.01 }; // wrist, low
  pts[5] = { x: 0.03, y: -0.01, z: 0 }; // index knuckle: right of the picture
  pts[17] = { x: -0.03, y: -0.005, z: 0 }; // pinky knuckle: left
  pts[9] = { x: 0.01, y: -0.015, z: 0 };
  pts[13] = { x: -0.01, y: -0.012, z: 0 };
  pts[12] = { x: 0.01, y: -0.1, z: -0.01 }; // middle tip, high and a little toward the camera
  for (let i = 0; i < 21; i++) pts[i] = over(i, pts[i]);
  return pts;
}

const out = () => new Float32Array(63);

describe("axis conversion (MediaPipe world to scene)", () => {
  it("flips y (down to up) and z (away from the camera to toward the viewer) and scales metres to scene units", () => {
    const p = hand();
    const o = out();
    expect(toScene(p, false, o)).toBe(true);
    const idx = (i: number) => [o[i * 3], o[i * 3 + 1], o[i * 3 + 2]];
    // the wrist is below the middle tip in the picture (y larger), so it is lower in the scene
    expect(idx(0)[1]).toBeLessThan(idx(12)[1]);
    // the middle tip is nearer the camera (smaller z): larger scene z (toward the viewer)
    expect(idx(12)[2]).toBeGreaterThan(idx(0)[2]);
    // right of the picture stays right of the scene
    expect(idx(5)[0]).toBeGreaterThan(idx(17)[0]);
    // metres to scene units
    expect(idx(5)[0] - idx(17)[0]).toBeCloseTo(0.06 * SCENE_PER_METRE, 5);
    expect(idx(12)[1] - idx(0)[1]).toBeCloseTo(0.19 * SCENE_PER_METRE, 5);
  });

  it("flips x for a mirrored (front camera) picture, and only x", () => {
    const p = hand();
    const a = out();
    const b = out();
    toScene(p, false, a);
    toScene(p, true, b);
    for (let i = 0; i < 21; i++) {
      expect(b[i * 3]).toBeCloseTo(-a[i * 3], 5);
      expect(b[i * 3 + 1]).toBeCloseTo(a[i * 3 + 1], 5);
      expect(b[i * 3 + 2]).toBeCloseTo(a[i * 3 + 2], 5);
    }
  });

  it("centres the hand: a drifting world origin does not move it", () => {
    const a = out();
    const b = out();
    toScene(hand(), false, a);
    toScene(hand((_i, p) => ({ x: p.x + 5, y: p.y - 3, z: p.z + 2 })), false, b);
    for (let i = 0; i < 63; i++) expect(b[i]).toBeCloseTo(a[i], 3);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 21; i++) {
      minX = Math.min(minX, a[i * 3]);
      maxX = Math.max(maxX, a[i * 3]);
      minY = Math.min(minY, a[i * 3 + 1]);
      maxY = Math.max(maxY, a[i * 3 + 1]);
    }
    expect(minX + maxX).toBeCloseTo(0, 5);
    expect(minY + maxY).toBeCloseTo(0, 5);
  });

  it("never invents depth: a missing z makes the whole hand 2D, flat at z = 0", () => {
    const p = hand((i, q) => (i === 7 ? { ...q, z: NaN } : q));
    expect(hasDepth(p)).toBe(false);
    const o = out();
    expect(toScene(p, false, o)).toBe(false);
    for (let i = 0; i < 21; i++) expect(o[i * 3 + 2]).toBe(0);
    expect(hasDepth(hand())).toBe(true);
  });

  it("only accepts a full hand with finite x and y", () => {
    expect(isUsableHand(hand())).toBe(true);
    expect(isUsableHand(null)).toBe(false);
    expect(isUsableHand(hand().slice(0, 20))).toBe(false);
    expect(isUsableHand(hand((i, p) => (i === 3 ? { ...p, x: NaN } : p)))).toBe(false);
    expect(isUsableHand(hand((i, p) => (i === 3 ? { ...p, y: Infinity } : p)))).toBe(false);
  });
});

describe("fit, smoothing and size", () => {
  it("puts the camera far enough for the whole sphere on both axes, further for a narrow card", () => {
    const wide = fitDistance(1.3, 38, 2);
    const square = fitDistance(1.3, 38, 1);
    const narrow = fitDistance(1.3, 38, 0.5);
    expect(wide).toBeCloseTo(square, 5); // limited by the vertical view
    expect(narrow).toBeGreaterThan(square);
    expect(square).toBeGreaterThan(1.3);
    expect(Number.isFinite(fitDistance(1, 38, 0))).toBe(true);
  });

  it("measures the radius of a hand in scene units", () => {
    const o = out();
    toScene(hand(), false, o);
    const r = sceneRadius(o);
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(2.5);
  });

  it("eases toward a target in place and clamps the share", () => {
    const cur = new Float32Array([0, 10]);
    smoothInto(cur, new Float32Array([10, 0]), 0.5);
    expect(Array.from(cur)).toEqual([5, 5]);
    smoothInto(cur, new Float32Array([10, 0]), 5); // clamped to 1
    expect(Array.from(cur)).toEqual([10, 0]);
    smoothInto(cur, new Float32Array([0, 0]), -1); // clamped to 0
    expect(Array.from(cur)).toEqual([10, 0]);
  });
});

describe("which side of the hand shows", () => {
  it("tells a right palm toward the camera from its back, and flips for a left hand", () => {
    const p = hand();
    expect(palmFacesCamera(p, "Right")).toBe(true);
    expect(palmFacesCamera(p, "Left")).toBe(false);
    // turned over: the index knuckle is now on the left of the picture
    const back = hand((i, q) => (i === 5 ? { ...q, x: -0.03 } : i === 17 ? { ...q, x: 0.03 } : q));
    expect(palmFacesCamera(back, "Right")).toBe(false);
    expect(palmFacesCamera(back, "Left")).toBe(true);
  });

  it("says nothing without a handedness, or when the hand is edge-on", () => {
    expect(palmFacesCamera(hand(), null)).toBeNull();
    expect(palmFacesCamera(hand(), "Both")).toBeNull();
    const edge = hand((i, q) => (i === 5 ? { ...q, x: 0, y: -0.1 } : i === 17 ? { ...q, x: 0, y: -0.2 } : q));
    expect(palmFacesCamera(edge, "Right")).toBeNull();
  });
});

describe("words", () => {
  it("labels the hand and keeps the honest caption", () => {
    expect(handLabel("Left")).toBe("Left hand");
    expect(handLabel("Right")).toBe("Right hand");
    expect(handLabel(null)).toBe("Hand");
    expect(CAPTION).toBe("Estimated 3D landmark view. Depth is MediaPipe's relative estimate, not a calibrated measurement.");
  });
});
