// Pose consistency across views. ALL landmark sets here are SYNTHETIC (an invented open hand, in metres): they test the
// comparison logic, not how steady any real hand or MediaPipe is. That needs real captures.
import { describe, expect, it } from "vitest";
import type { Pt3 } from "../common";
import { rotationFromAxisAngle } from "./camera";
import { seededRandom } from "./linalg";
import { boneRatios, flexionAngles, palmCupping, poseConsistency, type ViewLandmarks } from "./poseConsistency";

const near = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

/** SYNTHETIC open, flat hand in the plane z = 0 (metres): wrist at the origin, fingers along +y. */
function openHand(): Pt3[] {
  const p: Pt3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  const set = (i: number, x: number, y: number, z = 0) => (p[i] = { x, y, z });
  set(0, 0, 0);
  // thumb 1-4
  set(1, -0.025, 0.02);
  set(2, -0.05, 0.045);
  set(3, -0.067, 0.063);
  set(4, -0.08, 0.078);
  // fingers: MCP x, MCP y, segment lengths
  const fingers: [number, number, number, number, number][] = [
    [5, -0.03, 0.088, 0.04, 0.022], // index
    [9, 0, 0.09, 0.045, 0.025], // middle
    [13, 0.028, 0.086, 0.043, 0.024], // ring
    [17, 0.052, 0.078, 0.032, 0.018], // pinky
  ];
  for (const [i, x, y, l1, l2] of fingers) {
    set(i, x, y);
    set(i + 1, x, y + l1);
    set(i + 2, x, y + l1 + l2);
    set(i + 3, x, y + l1 + l2 + 0.019);
  }
  return p;
}

function rotated(points: Pt3[], axis: [number, number, number], angle: number, shift = [0.1, -0.2, 0.3]): Pt3[] {
  const R = rotationFromAxisAngle(axis, angle);
  return points.map((q) => ({
    x: R[0] * q.x + R[1] * q.y + R[2] * q.z + shift[0],
    y: R[3] * q.x + R[4] * q.y + R[5] * q.z + shift[1],
    z: R[6] * q.x + R[7] * q.y + R[8] * q.z + shift[2],
  }));
}

/** Bend the joints after `pivot` about the x axis through `pivot` (synthetic flexion toward +z). */
function flex(points: Pt3[], pivot: number, rest: number[], deg: number): Pt3[] {
  const out = points.map((q) => ({ ...q }));
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const o = points[pivot];
  for (const i of rest) {
    const dy = points[i].y - o.y;
    const dz = points[i].z - o.z;
    out[i] = { x: points[i].x, y: o.y + dy * c - dz * s, z: o.z + dy * s + dz * c };
  }
  return out;
}

const view = (id: string, points: Pt3[], kind: "world" | "image" = "world"): ViewLandmarks => ({ id, kind, points });

describe("the building blocks (synthetic hand)", () => {
  const h = openHand();
  it("bone ratios are relative to the wrist-to-middle-knuckle length, and do not change when the hand is turned or moved", () => {
    const a = boneRatios(h);
    const b = boneRatios(rotated(h, [1, 2, 3], 1.3));
    a.forEach((v, i) => near(v, b[i], 1e-9));
    expect(a.length).toBe(4 + 4 * 4 + 3);
  });
  it("a flat open hand has straight finger joints (PIP and DIP bend ~ 0) and a flat palm (cupping ~ 0)", () => {
    // Order: thumb (3 joints), then index, middle, ring, pinky at 3 joints each: knuckle, PIP, DIP. The knuckle angle
    // includes the natural splay of the metacarpals (up to ~34 degrees for the pinky here), so only PIP and DIP are straight.
    const angles = flexionAngles(h);
    expect(angles).toHaveLength(15);
    for (let finger = 1; finger <= 4; finger++) {
      near(angles[finger * 3 + 1], 0, 1e-6);
      near(angles[finger * 3 + 2], 0, 1e-6);
    }
    near(palmCupping(h), 0, 1e-12);
  });
  it("flexing a finger raises that finger's joint angle by the bend; rotating the hand does not change any angle", () => {
    const before = flexionAngles(h);
    const bent = flexionAngles(flex(h, 6, [7, 8], 40));
    const idx = before.map((v, i) => Math.abs(bent[i] - v));
    expect(Math.max(...idx)).toBeGreaterThan(30);
    const turned = flexionAngles(rotated(h, [0, 1, 0], 2.0));
    before.forEach((v, i) => near(v, turned[i], 1e-7));
  });
  it("cupping grows when the middle knuckles rise out of the palm plane", () => {
    const cupped = h.map((q, i) => (i === 9 || i === 13 ? { ...q, z: 0.015 } : q));
    expect(palmCupping(cupped)).toBeGreaterThan(0.1);
  });
});

describe("views of the same pose from different directions are consistent", () => {
  const h = openHand();
  it("palm, back, thumb side and little-finger side (rotations of the same synthetic hand, 0.3 mm of landmark noise) raise no flag", () => {
    const rnd = seededRandom(7);
    const noisy = (p: Pt3[]) => p.map((q) => ({ x: q.x + 0.0003 * rnd.gaussian(), y: q.y + 0.0003 * rnd.gaussian(), z: q.z + 0.0003 * rnd.gaussian() }));
    const r = poseConsistency([
      view("palm", noisy(h)),
      view("back", noisy(rotated(h, [0, 1, 0], Math.PI))),
      view("thumb_side", noisy(rotated(h, [0, 1, 0], Math.PI / 2))),
      view("little_side", noisy(rotated(h, [0, 1, 0], -Math.PI / 2))),
    ]);
    expect(r.reliable).toBe(true);
    expect(r.flaggedIds).toEqual([]);
    for (const v of r.views) expect(v.boneRatioDeviation).toBeLessThan(0.08);
  });
  it("with no noise the rotation changes nothing at all", () => {
    const r = poseConsistency([view("a", h), view("b", rotated(h, [1, 1, 0], 0.9)), view("c", rotated(h, [0, 0, 1], 2.4))]);
    for (const v of r.views) {
      near(v.boneRatioDeviation, 0, 1e-9);
      near(v.flexionDeviationDeg, 0, 1e-4); // acos near 1 amplifies rounding
      near(v.palmCupDeviation, 0, 1e-9);
    }
  });
});

describe("a view in which the hand changed is flagged", () => {
  const h = openHand();
  const three = (odd: Pt3[]) => [view("palm", h), view("back", rotated(h, [0, 1, 0], Math.PI)), view("side", rotated(odd, [0, 1, 0], Math.PI / 2))];

  it("bent fingers in one of three views: that view is flagged for flexion, the others are not", () => {
    const bent = flex(flex(h, 6, [7, 8], 35), 7, [8], 30);
    const r = poseConsistency(three(bent));
    expect(r.flaggedIds).toEqual(["side"]);
    expect(r.views.find((v) => v.id === "side")!.reasons).toContain("fingers_flexed");
  });
  it("a finger 15 % longer in one view (a different hand or a tracking error): flagged as changed bones", () => {
    const longer = h.map((q, i) => (i >= 6 && i <= 8 ? { ...q, y: 0.088 + (q.y - 0.088) * 1.15 } : q));
    const r = poseConsistency(three(longer));
    expect(r.flaggedIds).toEqual(["side"]);
    expect(r.views.find((v) => v.id === "side")!.reasons).toContain("bones_changed");
  });
  it("a cupped palm in one view: flagged for cupping", () => {
    const cupped = h.map((q, i) => (i === 9 || i === 13 ? { ...q, z: 0.016 } : q));
    const r = poseConsistency(three(cupped));
    expect(r.flaggedIds).toEqual(["side"]);
    expect(r.views.find((v) => v.id === "side")!.reasons).toContain("palm_cupped");
  });
  it("with only two views neither can be called the odd one out: both are flagged and the notes say so", () => {
    const bent = flex(flex(h, 6, [7, 8], 40), 7, [8], 30);
    const r = poseConsistency([view("a", h), view("b", rotated(bent, [0, 1, 0], 1))]);
    expect(r.flaggedIds.sort()).toEqual(["a", "b"]);
    expect(r.notes.join(" ")).toMatch(/two views/);
  });
  it("the tolerances are stated in the result and can be tightened", () => {
    const slight = h.map((q, i) => (i >= 6 && i <= 8 ? { ...q, y: 0.088 + (q.y - 0.088) * 1.05 } : q));
    expect(poseConsistency(three(slight)).flaggedIds).toEqual([]);
    const strict = poseConsistency(three(slight), { boneRatioTol: 0.02 });
    expect(strict.tolerances.boneRatioTol).toBe(0.02);
    expect(strict.flaggedIds).toEqual(["side"]);
  });
});

describe("2D image landmarks are not reliable across directions", () => {
  it("is marked unreliable with a note, instead of blaming the hand for the camera's movement", () => {
    const h = openHand();
    const r = poseConsistency([view("a", h, "image"), view("b", rotated(h, [1, 0, 0], 0.8), "image")]);
    expect(r.reliable).toBe(false);
    expect(r.notes.join(" ")).toMatch(/foreshorten/);
  });
});

describe("input checking", () => {
  it("needs two views of 21 landmarks each", () => {
    const h = openHand();
    expect(() => poseConsistency([view("a", h)])).toThrow();
    expect(() => poseConsistency([view("a", h), view("b", h.slice(0, 20))])).toThrow();
  });
});
