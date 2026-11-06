import { describe, expect, it } from "vitest";
import { BONES, genericHand, handWire, measureRings, normalizePose, poseSamples, sampleHand, type Landmark, type Vec3 } from "./handModel";

const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The generic hand as a camera would report it: pixels, y down, offset, z towards the camera negative. */
function asImagePixels(scale = 400, offset = { x: 120, y: 700, z: 5 }, mirror = false): Landmark[] {
  return genericHand().map((p) => ({
    x: offset.x + (mirror ? -1 : 1) * scale * p.x,
    y: offset.y - scale * p.y,
    z: offset.z - scale * p.z,
  }));
}

/** Distance from a point to the segment a-b. */
function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
  const len2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / len2));
  return Math.hypot(ap.x - t * ab.x, ap.y - t * ab.y, ap.z - t * ab.z);
}

describe("genericHand", () => {
  const h = genericHand();

  it("is 21 joints in MediaPipe order with the wrist at the origin and the middle fingertip at y = 1", () => {
    expect(h).toHaveLength(21);
    expect(h[0]).toEqual({ x: 0, y: 0, z: 0 });
    expect(h[12].y).toBeCloseTo(1, 12);
    expect(h[12].x).toBeCloseTo(0, 12);
    expect(Math.hypot(h[12].x, h[12].y)).toBeCloseTo(1, 12); // wrist-to-middle-tip length 1
    for (const p of h) for (const c of [p.x, p.y, p.z]) expect(Number.isFinite(c)).toBe(true);
  });

  it("is a right hand seen from the palm side: thumb at +x, little finger at -x, palm normal towards the viewer", () => {
    expect(h[4].x).toBeGreaterThan(0.3);
    expect(h[20].x).toBeLessThan(-0.2);
    const a = h[5];
    const b = h[17];
    expect(a.x * b.y - a.y * b.x).toBeGreaterThan(0); // normal z > 0
  });

  it("has realistic finger proportions and a gentle depth so it reads as 3D", () => {
    const len = (base: number) => dist3(h[base], h[base + 3]);
    expect(len(9)).toBeGreaterThan(len(13));
    expect(len(13)).toBeGreaterThan(len(5));
    expect(len(5)).toBeGreaterThan(len(17));
    expect(len(17) / len(9)).toBeGreaterThan(0.6);
    expect(len(17) / len(9)).toBeLessThan(0.85);
    const zs = h.map((p) => p.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.05);
    expect(Math.max(...zs.map(Math.abs))).toBeLessThan(0.35);
    for (const f of [5, 9, 13, 17]) expect(h[f + 3].z).toBeGreaterThan(h[f].z); // fingers curl towards the viewer
  });

  it("returns copies, not the shared hand", () => {
    const a = genericHand();
    a[12].y = 5;
    expect(genericHand()[12].y).toBeCloseTo(1, 12);
  });
});

describe("normalizePose", () => {
  it("brings image pixels (y down, any scale and offset) back to the generic hand", () => {
    const n = normalizePose(asImagePixels());
    const g = genericHand();
    for (let i = 0; i < 21; i++) {
      expect(n[i].x).toBeCloseTo(g[i].x, 6);
      expect(n[i].y).toBeCloseTo(g[i].y, 6);
      expect(n[i].z).toBeCloseTo(g[i].z, 6);
    }
  });

  it("is the same whatever the pixel scale", () => {
    const a = normalizePose(asImagePixels(100));
    const b = normalizePose(asImagePixels(1300, { x: 0, y: 40, z: 0 }));
    for (let i = 0; i < 21; i++) expect(a[i].x).toBeCloseTo(b[i].x, 9);
  });

  it("mirror flips x only", () => {
    const g = genericHand();
    const n = normalizePose(asImagePixels(), { mirror: true });
    for (let i = 0; i < 21; i++) {
      expect(n[i].x).toBeCloseTo(-g[i].x, 6);
      expect(n[i].y).toBeCloseTo(g[i].y, 6);
      expect(n[i].z).toBeCloseTo(g[i].z, 6);
    }
  });

  it("uses the canonical depth when z is missing or all zero", () => {
    const g = genericHand();
    const noZ = asImagePixels().map(({ x, y }) => ({ x, y }));
    const zero = asImagePixels().map(({ x, y }) => ({ x, y, z: 0 }));
    for (const input of [noZ, zero]) {
      const n = normalizePose(input);
      for (let i = 0; i < 21; i++) expect(n[i].z).toBeCloseTo(g[i].z, 9);
    }
  });

  it("limits a wild depth to a gentle relief", () => {
    const wild = asImagePixels().map((p, i) => ({ ...p, z: (i % 2 ? 1 : -1) * 5000 }));
    for (const p of normalizePose(wild)) expect(Math.abs(p.z)).toBeLessThanOrEqual(0.35 + 1e-12);
  });

  it("falls back to the generic hand for degenerate input", () => {
    const g = genericHand();
    const flat = Array.from({ length: 21 }, () => ({ x: 50, y: 50 })); // no hand length
    const nan = asImagePixels();
    nan[8] = { x: NaN, y: 3 };
    for (const bad of [[], flat, nan, asImagePixels().slice(0, 20)]) expect(normalizePose(bad)).toEqual(g);
  });
});

describe("sampleHand", () => {
  const pose = genericHand();
  const s = sampleHand(pose, 3000, 11);
  const palmOrStub = new Set([4, 8, 12, 16]);
  const capsules = new Set([0, 1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19]);

  it("has the asked number of points, with valid bones, t, offsets and glow", () => {
    expect(s.count).toBe(3000);
    expect(s.bone).toHaveLength(3000);
    expect(s.t).toHaveLength(3000);
    expect(s.local).toHaveLength(9000);
    expect(s.glow).toHaveLength(3000);
    for (let i = 0; i < s.count; i++) {
      expect(capsules.has(s.bone[i]) || palmOrStub.has(s.bone[i])).toBe(true);
      expect(s.bone[i]).toBeLessThan(BONES.length);
      expect(s.t[i]).toBeGreaterThanOrEqual(0);
      expect(s.t[i]).toBeLessThanOrEqual(1);
      expect(s.glow[i]).toBeGreaterThanOrEqual(0);
      expect(s.glow[i]).toBeLessThanOrEqual(1);
    }
    for (const v of s.local) expect(Number.isFinite(v)).toBe(true);
  });

  it("is deterministic for a seed and different for another", () => {
    const again = sampleHand(pose, 3000, 11);
    expect(Array.from(again.local)).toEqual(Array.from(s.local));
    expect(Array.from(again.bone)).toEqual(Array.from(s.bone));
    const other = sampleHand(pose, 3000, 12);
    expect(Array.from(other.local)).not.toEqual(Array.from(s.local));
  });

  it("covers every finger, the palm and the forearm, with the brightest points at the fingertips", () => {
    const used = new Set(Array.from(s.bone));
    for (const b of [...capsules, 4, 8, 12, 16]) expect(used.has(b), `bone ${b}`).toBe(true);
    const tipGlow = Array.from(s.glow).filter((_, i) => [3, 7, 11, 15, 19].includes(s.bone[i]) && s.t[i] > 0.9);
    const meanTip = tipGlow.reduce((a, b) => a + b, 0) / tipGlow.length;
    const mean = Array.from(s.glow).reduce((a, b) => a + b, 0) / s.count;
    expect(meanTip).toBeGreaterThan(mean + 0.2);
  });

  it("gives the requested count, including none", () => {
    expect(sampleHand(pose, 0, 1).count).toBe(0);
    expect(sampleHand(pose, 17, 1).bone).toHaveLength(17);
  });
});

describe("poseSamples", () => {
  const pose = genericHand();
  const s = sampleHand(pose, 4000, 3);

  it("puts every point on a finite, hand-sized shape around the hand", () => {
    const out = new Float32Array(s.count * 3);
    poseSamples(s, pose, out);
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThan(1.6);
    }
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < s.count; i++) {
      minY = Math.min(minY, out[3 * i + 1]);
      maxY = Math.max(maxY, out[3 * i + 1]);
    }
    expect(maxY).toBeGreaterThan(0.95); // the middle fingertip
    expect(maxY).toBeLessThan(1.15);
    expect(minY).toBeLessThan(-0.3); // the forearm stub behind the wrist
  });

  it("makes a finger's points follow its joints when the pose changes", () => {
    const bent = genericHand();
    // curl the index finger hard towards the viewer and spread it
    bent[6] = { x: bent[6].x + 0.05, y: bent[6].y - 0.02, z: bent[6].z + 0.04 };
    bent[7] = { x: bent[6].x + 0.04, y: bent[6].y + 0.05, z: bent[6].z + 0.14 };
    bent[8] = { x: bent[7].x + 0.02, y: bent[7].y - 0.02, z: bent[7].z + 0.12 };
    const before = new Float32Array(s.count * 3);
    const after = new Float32Array(s.count * 3);
    poseSamples(s, pose, before);
    poseSamples(s, bent, after);
    let checked = 0;
    let moved = 0;
    for (let i = 0; i < s.count; i++) {
      if (s.bone[i] !== 7) continue; // the index fingertip bone (joints 7 and 8)
      const p = { x: after[3 * i], y: after[3 * i + 1], z: after[3 * i + 2] };
      expect(distToSegment(p, bent[7], bent[8])).toBeLessThan(0.12);
      checked++;
      if (dist3(p, { x: before[3 * i], y: before[3 * i + 1], z: before[3 * i + 2] }) > 0.05) moved++;
    }
    expect(checked).toBeGreaterThan(30);
    expect(moved / checked).toBeGreaterThan(0.9);
    // points of other fingers are untouched
    for (let i = 0; i < s.count; i++) {
      if (s.bone[i] === 9 || s.bone[i] === 10) {
        for (let c = 0; c < 3; c++) expect(after[3 * i + c]).toBeCloseTo(before[3 * i + c], 5);
      }
    }
  });

  it("stretches the palm with a measured pose and survives a mirrored one", () => {
    const wide = genericHand().map((p) => ({ x: p.x * 1.3, y: p.y, z: p.z }));
    const out = new Float32Array(s.count * 3);
    poseSamples(s, wide, out);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < s.count; i++) {
      minX = Math.min(minX, out[3 * i]);
      maxX = Math.max(maxX, out[3 * i]);
    }
    expect(maxX - minX).toBeGreaterThan(0.85);
    const mirrored = normalizePose(asImagePixels(300, { x: 10, y: 500, z: 0 }, true));
    poseSamples(s, mirrored, out);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it("is fast enough to run on every frame (12000 points)", () => {
    const big = sampleHand(pose, 12000, 5);
    const out = new Float32Array(big.count * 3);
    poseSamples(big, pose, out); // warm up
    const t0 = performance.now();
    poseSamples(big, pose, out);
    expect(performance.now() - t0).toBeLessThan(40);
  });
});

describe("handWire", () => {
  it("is a few hundred finite line segments, the same every time", () => {
    const w = handWire(genericHand());
    expect(w.length % 6).toBe(0);
    const segments = w.length / 6;
    expect(segments).toBeGreaterThanOrEqual(400);
    expect(segments).toBeLessThanOrEqual(900);
    for (const v of w) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThan(1.6);
    }
    expect(Array.from(handWire(genericHand()))).toEqual(Array.from(w));
  });

  it("follows the pose", () => {
    const a = handWire(genericHand());
    const shifted = genericHand().map((p) => ({ ...p, x: p.x + 0.5 }));
    const b = handWire(shifted);
    expect(b).toHaveLength(a.length);
    expect(b[0]).not.toBeCloseTo(a[0], 3);
  });
});

describe("light theme geometry", () => {
  it("handWire is unchanged by default and denser with { dense: true }", () => {
    const hand = genericHand();
    const base = handWire(hand);
    expect(Array.from(handWire(hand, {}))).toEqual(Array.from(base));
    expect(Array.from(handWire(hand, { dense: false }))).toEqual(Array.from(base));
    const dense = handWire(hand, { dense: true });
    expect(dense.length).toBeGreaterThan(base.length);
    expect(dense.length % 6).toBe(0);
    for (const v of dense) expect(Number.isFinite(v)).toBe(true);
  });

  it("measureRings: the same number of segments for every pose, all finite, and they follow the pose", () => {
    const a = measureRings(genericHand());
    expect(a.length % 6).toBe(0);
    expect(a.length).toBeGreaterThan(0);
    const shifted = genericHand().map((p) => ({ x: p.x + 2, y: p.y, z: p.z }));
    const b = measureRings(shifted);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i += 3) expect(b[i] - a[i]).toBeCloseTo(2, 4);
    for (const v of b) expect(Number.isFinite(v)).toBe(true);
    const pixels = normalizePose(asImagePixels(300, { x: 50, y: 500, z: 0 }, true));
    expect(measureRings(pixels).length).toBe(a.length);
  });

  it("each finger ring is a closed loop: consecutive segments join up", () => {
    const r = measureRings(genericHand());
    for (let i = 0; i < 19; i++) {
      for (let c = 0; c < 3; c++) expect(r[i * 6 + 3 + c]).toBeCloseTo(r[(i + 1) * 6 + c], 5);
    }
  });
});
