// The pure maths of the CLEAN overlay look (look="clean"): sizes, shading, stroke geometry and the wrist stub.
// SYNTHETIC hands only: this proves the geometry, not accuracy on real hands.
import { describe, expect, it } from "vitest";
import { CONNECTIONS } from "./landmarkTopology";
import {
  SKELETON_BONE_VERTS,
  SKELETON_EDGE_PX,
  SKELETON_HW,
  SKELETON_MIN_HW_PX,
  SKELETON_MIN_JOINT_PX,
  fillBoneVerts,
  fillWristStub,
  jointDiameter,
  palmLength,
  skeletonShade,
  skeletonToneAlpha,
  sortByKey,
  strokeHalfWidth,
} from "./overlayMath";

/** A flat open hand in screen pixels (x, y, relief per joint): wrist at (cx, cy), fingers pointing up, ``s`` px per unit. */
function openHandJoints(cx = 200, cy = 400, s = 1, relief = 0): Float32Array {
  const j = new Float32Array(63);
  const put = (i: number, x: number, y: number, z = relief) => {
    j[i * 3] = cx + x * s;
    j[i * 3 + 1] = cy + y * s;
    j[i * 3 + 2] = z * s;
  };
  put(0, 0, 0);
  // thumb: out to the side and up
  [[-30, -20], [-55, -45], [-72, -70], [-84, -92]].forEach(([x, y], k) => put(1 + k, x, y));
  // four fingers: knuckle row at y = -100, then three segments up
  const xs = [-30, -10, 10, 30];
  const lens = [100, 112, 104, 84]; // index, middle, ring, pinky: wrist-to-tip distances beyond the knuckle (rough)
  xs.forEach((x, f) => {
    const base = 5 + f * 4;
    put(base, x, -100);
    put(base + 1, x, -100 - lens[f] * 0.4);
    put(base + 2, x, -100 - lens[f] * 0.7);
    put(base + 3, x, -100 - lens[f]);
  });
  return j;
}

describe("skeleton sizes and shading (clean look)", () => {
  it("measures the palm from the wrist to the middle knuckle, so a fist does not shrink the strokes", () => {
    const open = openHandJoints();
    expect(palmLength(open)).toBeCloseTo(Math.hypot(10, 100), 3); // wrist (0,0) to joint 9 at (-10... see openHandJoints)
    // a fist: the fingertips fold onto the palm; the palm length is unchanged
    const fist = open.slice();
    for (let f = 0; f < 4; f++) {
      const base = 5 + f * 4;
      for (let k = 1; k < 4; k++) {
        fist[(base + k) * 3] = fist[base * 3];
        fist[(base + k) * 3 + 1] = fist[base * 3 + 1] + 12 * k;
      }
    }
    expect(palmLength(fist)).toBeCloseTo(palmLength(open), 6);
    // a degenerate hand never divides by zero
    expect(palmLength(new Float32Array(63))).toBe(1);
  });

  it("shades nearer relief lighter and farther darker, within a fixed range, and 1 for no relief", () => {
    expect(skeletonShade(0, 100)).toBe(1);
    expect(skeletonShade(60, 100)).toBeCloseTo(1.22, 6);
    expect(skeletonShade(600, 100)).toBeCloseTo(1.22, 6); // clamped
    expect(skeletonShade(-60, 100)).toBeCloseTo(0.78, 6);
    expect(skeletonShade(30, 100)).toBeGreaterThan(skeletonShade(0, 100));
  });

  it("makes strokes taper from the knuckle to the tip, never thinner than the floor, and fingertip discs a little larger", () => {
    const palm = 120;
    for (const finger of [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20], [1, 2, 3, 4]]) {
      const w = finger.map((i) => strokeHalfWidth(i, palm));
      for (let k = 1; k < w.length; k++) expect(w[k]).toBeLessThanOrEqual(w[k - 1]);
    }
    expect(SKELETON_HW).toHaveLength(21);
    expect(strokeHalfWidth(8, 10)).toBe(SKELETON_MIN_HW_PX); // a tiny hand still gets a visible stroke
    expect(jointDiameter(8, 120, 0)).toBeGreaterThan(jointDiameter(7, 120, 0)); // a fingertip is emphasised
    expect(jointDiameter(7, 10, 0)).toBe(SKELETON_MIN_JOINT_PX);
    expect(jointDiameter(8, 120, 60)).toBeGreaterThan(jointDiameter(8, 120, -60)); // nearer is a little larger
  });

  it("changes only the opacity with the pose tone, never the colours", () => {
    expect(skeletonToneAlpha("ok")).toBe(1);
    expect(skeletonToneAlpha("idle")).toBe(1);
    expect(skeletonToneAlpha(undefined)).toBe(1);
    expect(skeletonToneAlpha("warn")).toBeLessThan(1);
    expect(skeletonToneAlpha("warn")).toBeGreaterThan(0.6);
  });
});

describe("sortByKey", () => {
  it("sorts indices by key, ascending, in place, and keeps equal keys in their order", () => {
    const order = [0, 1, 2, 3, 4];
    sortByKey(order, [5, 1, 3, 1, 9]);
    expect(order).toEqual([1, 3, 2, 0, 4]);
    const again = [3, 1, 0, 4, 2];
    sortByKey(again, [5, 1, 3, 1, 9]);
    expect(again.map((i) => [5, 1, 3, 1, 9][i])).toEqual([1, 1, 3, 5, 9]);
  });
  it("is cheap on an already sorted list and works on a typed array", () => {
    const order = new Uint8Array([0, 1, 2]);
    sortByKey(order, [0, 1, 2]);
    expect(Array.from(order)).toEqual([0, 1, 2]);
    sortByKey(order, [2, 1, 0]);
    expect(Array.from(order)).toEqual([2, 1, 0]);
  });
});

describe("fillBoneVerts (the strokes of the skeleton)", () => {
  const NB = CONNECTIONS.length;
  const rgb = new Float32Array(NB * 3).fill(0.5);
  const palm = 100;

  it("writes three quads per bone (dark outline, white halo, colour), widest first, each centred on the bone", () => {
    const joints = openHandJoints();
    const order = Array.from({ length: NB }, (_, k) => k);
    const pos = new Float32Array(NB * SKELETON_BONE_VERTS * 3);
    const col = new Float32Array(NB * SKELETON_BONE_VERTS * 4);
    fillBoneVerts(joints, CONNECTIONS, order, rgb, palm, pos, col);
    // bone 4 is the index base (0 -> 5); read its three quads
    const k = 4;
    const [a, b] = CONNECTIONS[k];
    const widths: number[] = [];
    for (let q = 0; q < 3; q++) {
      const v = (k * SKELETON_BONE_VERTS + q * 4) * 3;
      // vertices 0 and 1 straddle joint a: their midpoint is joint a, and they are exactly 2 * halfWidth apart
      const mx = (pos[v] + pos[v + 3]) / 2;
      const my = (pos[v + 1] + pos[v + 4]) / 2;
      expect(mx).toBeCloseTo(joints[a * 3], 3);
      expect(my).toBeCloseTo(joints[a * 3 + 1], 3);
      const wA = Math.hypot(pos[v] - pos[v + 3], pos[v + 1] - pos[v + 4]);
      widths.push(wA);
      expect(wA).toBeCloseTo(2 * (strokeHalfWidth(a, palm) + SKELETON_EDGE_PX[q]), 3);
      // vertices 2 and 3 straddle joint b
      const nx = (pos[v + 6] + pos[v + 9]) / 2;
      const ny = (pos[v + 7] + pos[v + 10]) / 2;
      expect(nx).toBeCloseTo(joints[b * 3], 3);
      expect(ny).toBeCloseTo(joints[b * 3 + 1], 3);
      // every vertex is flat (z = 0): the layer is a 2D drawing of a 3D skeleton
      for (let m = 0; m < 4; m++) expect(pos[v + m * 3 + 2]).toBe(0);
    }
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[2]);
    // colours: outline dark, halo white, fill the bone's colour (shaded 1 for flat relief)
    const c = (k * SKELETON_BONE_VERTS) * 4;
    expect(col[c + 3]).toBeCloseTo(0.34, 6);
    expect(Array.from(col.slice(c + 16, c + 19))).toEqual([1, 1, 1]);
    expect(col[c + 32]).toBeCloseTo(0.5, 6);
  });

  it("draws far bones first: the order decides the slot, and nearer relief shades the colour lighter", () => {
    const joints = openHandJoints();
    // push joint 5 (index base) towards the camera: the bones that end at it are lighter there
    joints[5 * 3 + 2] = 60;
    const reversed = Array.from({ length: NB }, (_, k) => NB - 1 - k);
    const pos = new Float32Array(NB * SKELETON_BONE_VERTS * 3);
    const col = new Float32Array(NB * SKELETON_BONE_VERTS * 4);
    fillBoneVerts(joints, CONNECTIONS, reversed, rgb, palm, pos, col);
    // slot 0 holds the last bone now
    const [a0] = CONNECTIONS[NB - 1];
    const v0 = 0;
    expect((pos[v0] + pos[v0 + 3]) / 2).toBeCloseTo(joints[a0 * 3], 3);
    // the bone 0 -> 5 is in slot NB - 1 - 4; its fill is lighter at the end that touches joint 5 than at the wrist
    const slot = reversed.indexOf(4);
    const fill = slot * SKELETON_BONE_VERTS * 4 + 8 * 4; // third quad, first vertex (joint a = 0)
    const endB = fill + 2 * 4; // third vertex (joint b = 5)
    expect(col[endB]).toBeGreaterThan(col[fill]);
  });

  it("never produces NaN for two joints on the same pixel", () => {
    const joints = new Float32Array(63);
    const order = Array.from({ length: NB }, (_, k) => k);
    const pos = new Float32Array(NB * SKELETON_BONE_VERTS * 3);
    const col = new Float32Array(NB * SKELETON_BONE_VERTS * 4);
    fillBoneVerts(joints, CONNECTIONS, order, rgb, 1, pos, col);
    expect(pos.every((x) => Number.isFinite(x))).toBe(true);
    expect(col.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe("fillWristStub", () => {
  it("extends from the wrist away from the fingers, fading out, as a quad about the width of the palm's base", () => {
    const joints = openHandJoints(200, 400, 1);
    const pos = new Float32Array(12);
    const col = new Float32Array(16);
    expect(fillWristStub(joints, palmLength(joints), [0.4, 0.4, 0.4], pos, col)).toBe(true);
    // fingers point up (negative y), so the stub goes down (positive y): its far edge is below the wrist
    expect(pos[7]).toBeGreaterThan(400);
    expect(pos[10]).toBeGreaterThan(400);
    expect(col[3]).toBeGreaterThan(0.3); // visible at the wrist ...
    expect(col[15]).toBe(0); // ... and gone at the far end
    // wide at the wrist: between the near vertices
    expect(Math.hypot(pos[0] - pos[3], pos[1] - pos[4])).toBeGreaterThan(12);
  });
  it("refuses a degenerate hand (wrist on the middle knuckle)", () => {
    const joints = new Float32Array(63);
    expect(fillWristStub(joints, 1, [0, 0, 0], new Float32Array(12), new Float32Array(16))).toBe(false);
  });
});
