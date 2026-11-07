import { describe, expect, it } from "vitest";
import { genericHand, handWire, normalizePose, poseSamples, sampleHand, type Landmark, type Vec3 } from "./handModel";
import {
  LABEL_EDGE,
  LABEL_GAP,
  LABEL_LEAD,
  layoutLabels,
  sideFor,
  topReserveFor,
  type LabelIn,
  type LabelOut,
  BEAD_COUNT,
  FINGER_RAIL_VERTS,
  FINGER_RAILS,
  HAND_RAIL_VERTS,
  beadGlow,
  containRect,
  fillNodes,
  fillRails,
  haloOf,
  hasDepth,
  mapToElement,
  nodeGlow,
  normalizeInto,
  orbitBead,
  orbitFrameOf,
  orbitPose,
  poseBounds,
  railSide,
  RING_A,
  RING_B,
  ringRadius,
  rimWeights,
  easeFrame,
  sparkleShell,
  triangle,
  type Bounds,
  type HandFrame,
  type RailInfo,
} from "./overlayMath";

/** The generic hand as video-pixel landmarks (y down), at a given size and place. */
function videoHand(size = 300, at = { x: 400, y: 600 }, withZ = true): Landmark[] {
  return genericHand().map((p) => ({ x: at.x + p.x * size, y: at.y - p.y * size, ...(withZ ? { z: -p.z * size * 0.5 } : {}) }));
}

describe("containRect (the part of the element the video fills)", () => {
  it("pillarboxes a portrait video in a wider element", () => {
    const r = containRect(800, 600, 360, 640);
    expect(r.s).toBeCloseTo(600 / 640, 9);
    expect(r.oy).toBeCloseTo(0, 9);
    expect(r.ox).toBeCloseTo((800 - 360 * r.s) / 2, 9);
  });

  it("letterboxes a landscape video in a taller element", () => {
    const r = containRect(400, 700, 1280, 720);
    expect(r.s).toBeCloseTo(400 / 1280, 9);
    expect(r.ox).toBeCloseTo(0, 9);
    expect(r.oy).toBeCloseTo((700 - 720 * r.s) / 2, 9);
  });

  it("falls back to the identity for an unknown or empty frame or element, never NaN", () => {
    for (const [w, h, fw, fh] of [[0, 0, 640, 480], [400, 700, 0, 0], [400, 700, NaN, 480], [-1, 5, 3, 3]] as const) {
      expect(containRect(w, h, fw, fh)).toEqual({ s: 1, ox: 0, oy: 0 });
    }
  });
});

describe("mapToElement (a video pixel lands on the pixel of the picture where the real hand is)", () => {
  const out = new Float32Array(63);

  it("scales and offsets by the contain rect", () => {
    const rect = containRect(400, 700, 720, 1280);
    const lm = videoHand();
    mapToElement(lm, 720, rect, false, true, out);
    for (let i = 0; i < 21; i++) {
      expect(out[i * 3]).toBeCloseTo(rect.ox + lm[i].x * rect.s, 3);
      expect(out[i * 3 + 1]).toBeCloseTo(rect.oy + lm[i].y * rect.s, 3);
    }
  });

  it("flips about the middle of the video when the video is shown mirrored", () => {
    const rect = containRect(400, 700, 720, 1280);
    const lm = videoHand();
    const a = new Float32Array(63);
    mapToElement(lm, 720, rect, false, true, a);
    mapToElement(lm, 720, rect, true, true, out);
    for (let i = 0; i < 21; i++) {
      expect(out[i * 3] + a[i * 3]).toBeCloseTo(2 * rect.ox + 720 * rect.s, 3); // symmetric about the centre
      expect(out[i * 3 + 1]).toBeCloseTo(a[i * 3 + 1], 6);
    }
  });

  it("gives the relief towards the viewer as positive, zero without depth", () => {
    const rect = containRect(720, 1280, 720, 1280);
    const lm = videoHand().map((p, i) => ({ ...p, z: i === 8 ? -40 : 0 }));
    lm[0] = { ...lm[0], z: 0 };
    mapToElement(lm, 720, rect, false, true, out);
    expect(out[8 * 3 + 2]).toBeCloseTo(40, 3); // MediaPipe's negative z is nearer the camera
    mapToElement(videoHand(300, { x: 400, y: 600 }, false), 720, rect, false, false, out);
    for (let i = 0; i < 21; i++) expect(out[i * 3 + 2]).toBe(0);
  });
});

describe("hasDepth", () => {
  it("needs a finite z on every landmark and at least one that is not zero", () => {
    expect(hasDepth(videoHand())).toBe(true);
    expect(hasDepth(videoHand(300, { x: 1, y: 1 }, false))).toBe(false);
    expect(hasDepth(videoHand().map((p) => ({ ...p, z: 0 })))).toBe(false);
    const nan = videoHand();
    nan[5] = { ...nan[5], z: NaN };
    expect(hasDepth(nan)).toBe(false);
  });
});

describe("normalizeInto (hand space: wrist at the origin, y up, wrist to middle fingertip = 1)", () => {
  const generic = genericHand();
  const pose: Vec3[] = generic.map((p) => ({ ...p }));
  const hf: HandFrame = { x0: 0, y0: 0, len: 0 };

  it("agrees with normalizePose for a hand in screen pixels (without mirroring: the mapping already mirrored)", () => {
    const lm = videoHand(280, { x: 150, y: 420 });
    const cur = new Float32Array(63);
    mapToElement(lm, 720, containRect(720, 1280, 720, 1280), false, true, cur);
    expect(normalizeInto(cur, pose, generic, true, 1, hf)).toBe(true);
    expect(hf.len).toBeCloseTo(280, 3);
    expect(hf.x0).toBeCloseTo(150, 3);
    const ref = normalizePose(lm);
    for (let i = 0; i < 21; i++) {
      expect(pose[i].x).toBeCloseTo(ref[i].x, 3);
      expect(pose[i].y).toBeCloseTo(ref[i].y, 3);
    }
    expect(pose[12].y).toBeCloseTo(1, 3);
    expect(pose[0].x).toBeCloseTo(0, 9);
    expect(pose[0].y).toBeCloseTo(0, 9);
  });

  it("uses the generic depth when the landmarks carry none, and limits a wild one", () => {
    const cur = new Float32Array(63);
    mapToElement(videoHand(), 720, containRect(720, 1280, 720, 1280), false, true, cur);
    normalizeInto(cur, pose, generic, false, 1, hf);
    for (let i = 0; i < 21; i++) expect(pose[i].z).toBeCloseTo(generic[i].z, 9);
    cur[8 * 3 + 2] = 1e6;
    normalizeInto(cur, pose, generic, true, 1.35, hf);
    expect(pose[8].z).toBeLessThanOrEqual(0.35);
  });

  it("refuses a hand too small to place, and never produces NaN", () => {
    const cur = new Float32Array(63); // everything at the origin
    expect(normalizeInto(cur, pose, generic, true, 1, hf)).toBe(false);
    cur.fill(5);
    expect(normalizeInto(cur, pose, generic, true, 1, hf)).toBe(false);
  });
});

describe("measuring rails", () => {
  const pose = genericHand();
  const fingers = new Float32Array(FINGER_RAIL_VERTS * 3);
  const hand = new Float32Array(HAND_RAIL_VERTS * 3);
  const beads = new Float32Array(BEAD_COUNT * 3);
  const info: RailInfo = { mx: 0, my: 0, side: 1 };

  it("the finger rails run knuckle to tip, the same pairs the live finger lengths use", () => {
    fillRails(pose, fingers, hand, beads, info);
    FINGER_RAILS.forEach(([a, b], r) => {
      const o = r * 18;
      expect(fingers[o]).toBeCloseTo(pose[a].x, 6);
      expect(fingers[o + 1]).toBeCloseTo(pose[a].y, 6);
      expect(fingers[o + 3]).toBeCloseTo(pose[b].x, 6);
      expect(fingers[o + 4]).toBeCloseTo(pose[b].y, 6);
    });
    expect(FINGER_RAILS).toEqual([[2, 4], [5, 8], [9, 12], [13, 16], [17, 20]]);
  });

  it("the hand-length rail runs beside the hand, as long as wrist to middle fingertip, on the little-finger side", () => {
    fillRails(pose, fingers, hand, beads, info);
    const len = Math.hypot(hand[3] - hand[0], hand[4] - hand[1]);
    expect(len).toBeCloseTo(Math.hypot(pose[12].x - pose[0].x, pose[12].y - pose[0].y), 2);
    // the generic hand has its thumb at +x, so the little finger and the rail are at -x
    expect(info.side).toBe(-1);
    expect(hand[0]).toBeLessThan(pose[5].x);
    expect(info.mx).toBeCloseTo((hand[0] + hand[3]) / 2, 6);
    expect(info.my).toBeCloseTo((hand[1] + hand[4]) / 2, 6);
  });

  it("flips sides with the hand (a mirrored hand has the rail on the other side)", () => {
    const flipped = pose.map((p) => ({ x: -p.x, y: p.y, z: p.z }));
    fillRails(flipped, fingers, hand, beads, info);
    expect(info.side).toBe(1);
  });

  it("strings the beads along the rails, brightest at the ends", () => {
    fillRails(pose, fingers, hand, beads, info);
    const glow = beadGlow();
    expect(glow).toHaveLength(BEAD_COUNT);
    expect(glow[0]).toBe(1);
    expect(glow[4]).toBe(0.5);
    expect(glow[8]).toBe(1);
    // the first bead of the first rail is its knuckle, the ninth its tip
    expect(beads[0]).toBeCloseTo(pose[2].x, 6);
    expect(beads[8 * 3]).toBeCloseTo(pose[4].x, 6);
    for (const v of [...fingers, ...hand, ...beads]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("railSide (the hand-length rail stays inside the picture)", () => {
  const pose = genericHand(); // thumb at +x, so the little-finger side is -x on the screen
  it("is the little-finger side when it has room", () => {
    expect(railSide(pose, 300, 300, 600)).toBe(1);
  });

  it("goes to the other side when the little-finger side is against the edge and the other has room", () => {
    // the hand near the left edge: the rail would leave the picture on the little-finger (left) side
    expect(railSide(pose, 150, 300, 600)).toBe(-1);
  });

  it("keeps the little-finger side when neither side has room but it has more", () => {
    expect(railSide(pose, 100, 300, 260)).toBeDefined();
    const mirrored = pose.map((p) => ({ x: -p.x, y: p.y, z: p.z }));
    expect(railSide(mirrored, 450, 300, 600)).toBe(-1); // little finger now on the right, no room
    expect(railSide(mirrored, 300, 300, 600)).toBe(1);
  });
});

describe("poseBounds and triangle", () => {
  it("bounds a pose", () => {
    const b: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    poseBounds(genericHand(), b);
    expect(b.maxY).toBeCloseTo(1.0, 1);
    expect(b.minX).toBeLessThan(0);
    expect(b.maxX).toBeGreaterThan(0);
  });

  it("goes 0 -> 1 -> 0 over a period, whatever the time (even negative)", () => {
    expect(triangle(0, 2)).toBe(0);
    expect(triangle(1, 2)).toBe(1);
    expect(triangle(2, 2)).toBe(0);
    expect(triangle(0.5, 2)).toBeCloseTo(0.5, 9);
    expect(triangle(-0.5, 2)).toBeCloseTo(0.5, 9);
  });
});

describe("a long run (thousands of frames) stays finite, bounded and allocation-free in its buffers", () => {
  it("poses, rails and bounds 5000 jittering frames without NaN, drift or growth", () => {
    const generic = genericHand();
    const sampled = sampleHand(generic, 3000, 7);
    const positions = new Float32Array(3000 * 3);
    const pose: Vec3[] = generic.map((p) => ({ ...p }));
    const fingers = new Float32Array(FINGER_RAIL_VERTS * 3);
    const hand = new Float32Array(HAND_RAIL_VERTS * 3);
    const beads = new Float32Array(BEAD_COUNT * 3);
    const info: RailInfo = { mx: 0, my: 0, side: 1 };
    const hf: HandFrame = { x0: 0, y0: 0, len: 0 };
    const bounds: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    const cur = new Float32Array(63);
    const wireLen = handWire(generic).length;
    const buffers = [positions, fingers, hand, beads, cur];
    const sizes = buffers.map((b) => b.length);
    let seed = 1;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let f = 0; f < 5000; f++) {
      const lm = videoHand(240 + 60 * Math.sin(f / 40), { x: 360 + 40 * Math.sin(f / 17), y: 700 + 30 * Math.cos(f / 23) }, f % 5 !== 0).map((p) => ({
        x: p.x + (rnd() - 0.5) * 3,
        y: p.y + (rnd() - 0.5) * 3,
        ...(p.z === undefined ? {} : { z: p.z + (rnd() - 0.5) }),
      }));
      const useZ = hasDepth(lm);
      mapToElement(lm, 720, containRect(400, 700, 720, 1280), f % 2 === 0, useZ, cur);
      expect(normalizeInto(cur, pose, generic, useZ, 1.35, hf)).toBe(true);
      poseSamples(sampled, pose, positions);
      fillRails(pose, fingers, hand, beads, info);
      poseBounds(pose, bounds);
      if (f % 500 === 0) {
        expect(handWire(pose)).toHaveLength(wireLen);
        for (const b of buffers) for (const v of b) expect(Number.isFinite(v)).toBe(true);
        // the cloud stays about the hand, in hand lengths
        for (let i = 0; i < positions.length; i++) expect(Math.abs(positions[i])).toBeLessThan(3);
      }
    }
    expect(buffers.map((b) => b.length)).toEqual(sizes);
    expect(Number.isFinite(info.mx) && Number.isFinite(info.my)).toBe(true);
    expect(bounds.maxY).toBeGreaterThan(bounds.minY);
  }, 60000);
});

// ---------------------------------------------------------------------------------------------------------
describe("rimWeights (which points are on the silhouette of the hand)", () => {
  const sampled = sampleHand(genericHand(), 4000, 7);
  const rim = rimWeights(sampled);

  it("gives every point a weight in 0..1, one per point", () => {
    expect(rim.length).toBe(sampled.count);
    for (const v of rim) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("is high on the sides of a finger tube and low on its face (towards the viewer)", () => {
    // a capsule point: local = (u, v, w) with u along the palm normal (towards the viewer), v sideways
    const ids = [...Array(sampled.count).keys()].filter((i) => [5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19].includes(sampled.bone[i]));
    const side = ids.filter((i) => Math.abs(sampled.local[3 * i + 1]) > 3 * Math.abs(sampled.local[3 * i]));
    const face = ids.filter((i) => Math.abs(sampled.local[3 * i]) > 3 * Math.abs(sampled.local[3 * i + 1]));
    expect(side.length).toBeGreaterThan(20);
    expect(face.length).toBeGreaterThan(20);
    const mean = (xs: number[]) => xs.reduce((a, i) => a + rim[i], 0) / xs.length;
    expect(mean(side)).toBeGreaterThan(0.7);
    expect(mean(face)).toBeLessThan(0.3);
  });

  it("the edge of the palm slab is brighter than its faces", () => {
    const palm = [...Array(sampled.count).keys()].filter((i) => [4, 8, 12].includes(sampled.bone[i]));
    const edge = palm.filter((i) => Math.abs(sampled.local[3 * i + 2]) < 0.01 && Math.abs(sampled.local[3 * i + 1]) > 0.02);
    const faces = palm.filter((i) => Math.abs(sampled.local[3 * i + 2]) > 0.04 && Math.abs(sampled.local[3 * i + 1]) < 0.005);
    if (edge.length && faces.length) {
      const mean = (xs: number[]) => xs.reduce((a, i) => a + rim[i], 0) / xs.length;
      expect(mean(edge)).toBeGreaterThan(mean(faces));
    }
    expect(palm.length).toBeGreaterThan(100);
  });
});

describe("haloOf (dust round the hand)", () => {
  const base = sampleHand(genericHand(), 1500, 23);
  const seeded = () => {
    let a = 5;
    return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  };
  const halo = haloOf(base, seeded());

  it("keeps the points' places on their bones and pushes the offsets away from the skin", () => {
    expect(halo.count).toBe(base.count);
    expect(Array.from(halo.bone)).toEqual(Array.from(base.bone));
    expect(Array.from(halo.t)).toEqual(Array.from(base.t));
    let moved = 0;
    for (let i = 0; i < base.count; i++) {
      const b = base.bone[i];
      const a0 = Math.hypot(base.local[3 * i + 1], base.local[3 * i + 2], base.local[3 * i]);
      const a1 = Math.hypot(halo.local[3 * i + 1], halo.local[3 * i + 2], halo.local[3 * i]);
      if (a1 > a0 * 1.2) moved++;
      if ([4, 8, 12].includes(b)) expect(halo.local[3 * i]).toBe(base.local[3 * i]); // the palm's place across the slab is kept
      else if (b !== 16) expect(halo.local[3 * i + 2]).toBe(base.local[3 * i + 2]); // a finger's place along the bone is kept
    }
    expect(moved).toBeGreaterThan(base.count * 0.6);
  });

  it("is dim, does not touch the original, and follows a pose", () => {
    for (const g of halo.glow) {
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThan(0.3);
    }
    expect(base.local).not.toBe(halo.local);
    const out = new Float32Array(halo.count * 3);
    poseSamples(halo, genericHand(), out);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("glowing nodes at the joints", () => {
  it("places the 21 joints a little above the skin", () => {
    const pose = genericHand();
    const out = new Float32Array(63);
    fillNodes(pose, out, 0.05);
    for (let i = 0; i < 21; i++) {
      expect(out[i * 3]).toBeCloseTo(pose[i].x, 5);
      expect(out[i * 3 + 1]).toBeCloseTo(pose[i].y, 5);
      expect(out[i * 3 + 2]).toBeCloseTo(pose[i].z + 0.05, 5);
    }
  });

  it("the wrist and the fingertips shine most", () => {
    const g = nodeGlow();
    expect(g.length).toBe(21);
    for (const tip of [0, 4, 8, 12, 16, 20]) expect(g[tip]).toBeGreaterThan(1);
    for (const mid of [2, 3, 6, 7, 10, 11]) expect(g[mid]).toBeLessThan(g[8]);
  });
});

describe("the orbit rings and sparkles", () => {
  const frame = () => ({ cx: 0, cy: 0, hw: 0, hh: 0 });

  it("takes the centre and half-extents of a hand's box, and the unit hand when there is none", () => {
    const f = frame();
    orbitFrameOf({ minX: -0.3, maxX: 0.4, minY: 0, maxY: 1.1 }, f);
    expect(f.cx).toBeCloseTo(0.05, 6);
    expect(f.cy).toBeCloseTo(0.55, 6);
    expect(f.hw).toBeCloseTo(0.35, 6);
    expect(f.hh).toBeCloseTo(0.55, 6);
    for (const bad of [
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
      { minX: 0, maxX: 0, minY: 0, maxY: 1 },
      { minX: 0, maxX: NaN, minY: 0, maxY: 1 },
    ]) {
      orbitFrameOf(bad, f);
      expect(f).toEqual({ cx: 0, cy: 0.5, hw: 0.35, hh: 0.55 });
    }
  });

  it("sizes each ring from the larger half-extent, so the wide ring always clears the hand and the inner one is smaller", () => {
    const f = { cx: 0, cy: 0.5, hw: 0.35, hh: 0.55 };
    expect(ringRadius(f, RING_A)).toBeCloseTo(0.55 * RING_A, 9);
    expect(ringRadius(f, RING_B)).toBeLessThan(ringRadius(f, RING_A));
    expect(ringRadius(f, RING_B)).toBeGreaterThan(f.hh); // clears the box
    // a hand that is wider than tall (turned on its side) is sized by its width
    expect(ringRadius({ cx: 0, cy: 0, hw: 0.8, hh: 0.3 }, 1)).toBe(0.8);
  });

  it("eases a frame towards its target without overshooting, jumps for a hand that has just appeared, and never lags forever", () => {
    const cur = { cx: 0, cy: 0, hw: 0.2, hh: 0.2 };
    const tgt = { cx: 1, cy: -1, hw: 0.6, hh: 0.8 };
    easeFrame(cur, tgt, 16, 250, false);
    expect(cur.cx).toBeGreaterThan(0);
    expect(cur.cx).toBeLessThan(1);
    expect(cur.cy).toBeLessThan(0);
    expect(cur.cy).toBeGreaterThan(-1);
    for (let i = 0; i < 80; i++) easeFrame(cur, tgt, 16, 250, false);
    expect(cur.cx).toBeCloseTo(1, 3);
    expect(cur.hh).toBeCloseTo(0.8, 3);
    const j = { cx: 5, cy: 5, hw: 1, hh: 1 };
    easeFrame(j, tgt, 16, 250, true);
    expect(j).toEqual(tgt);
    const z = { cx: 5, cy: 5, hw: 1, hh: 1 };
    easeFrame(z, tgt, 0, 250, false); // no time passed: nothing moves
    expect(z).toEqual({ cx: 5, cy: 5, hw: 1, hh: 1 });
  });

  it("tilts the rings gently round a steady pose: two different tilts, each within a few percent of its rest", () => {
    const a = { tilt: 0, turn: 0 };
    const b = { tilt: 0, turn: 0 };
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 120; t += 0.5) {
      orbitPose(t, 0, a);
      orbitPose(t, 1, b);
      expect(Math.abs(a.tilt - 1.22)).toBeLessThanOrEqual(0.06 + 1e-9);
      expect(Math.abs(b.tilt - 0.98)).toBeLessThanOrEqual(0.06 + 1e-9);
      expect(a.tilt).toBeGreaterThan(b.tilt); // the wide ring lies flatter
      expect(Math.sign(a.turn)).toBe(-1); // turned opposite ways, so they cross
      expect(Math.sign(b.turn)).toBe(1);
      lo = Math.min(lo, a.tilt);
      hi = Math.max(hi, a.tilt);
    }
    expect(hi - lo).toBeGreaterThan(0.05); // it does move
    orbitPose(1.2, 0, a); // the reduced-motion time
    const again = { tilt: 0, turn: 0 };
    orbitPose(1.2, 0, again);
    expect(again).toEqual(a);
  });

  it("runs a bead round the ring: on the unit circle, bright on the near half, dim behind", () => {
    const o = { x: 0, y: 0, glow: 0 };
    let near = 0;
    let far = 0;
    for (let i = 0; i < 100; i++) {
      orbitBead(i * 0.05, 0.2, 0.1, o);
      expect(Math.hypot(o.x, o.y)).toBeCloseTo(1, 9);
      expect(o.glow).toBe(o.y > 0 ? 1 : 0.45);
      if (o.y > 0) near++;
      else far++;
    }
    expect(near).toBeGreaterThan(30);
    expect(far).toBeGreaterThan(30);
    orbitBead(0, 0.2, 0, o); // phase 0 starts on the x axis
    expect(o.x).toBeCloseTo(1, 9);
    expect(o.y).toBeCloseTo(0, 9);
  });

  it("scatters sparkles outside the silhouette, thinning towards the edge, deterministically and without NaN", () => {
    let s = 7;
    const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const n = 120;
    const pos = new Float32Array(n * 3);
    const glow = new Float32Array(n);
    const seed = new Float32Array(n);
    sparkleShell(n, rand, pos, glow, seed);
    let near = 0;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(pos[i * 3], pos[i * 3 + 1]);
      expect(r).toBeGreaterThanOrEqual(1.02 - 1e-6);
      expect(r).toBeLessThanOrEqual(1.82 + 1e-6);
      expect(Math.abs(pos[i * 3 + 2])).toBeLessThanOrEqual(0.25 + 1e-6);
      expect(glow[i]).toBeGreaterThan(0.1);
      expect(glow[i]).toBeLessThan(0.8);
      expect(seed[i]).toBeGreaterThanOrEqual(0);
      expect(seed[i]).toBeLessThan(1);
      if (r < 1.3) near++;
    }
    expect(near).toBeGreaterThan(n / 2); // denser close to the outline
    expect(pos.every(Number.isFinite)).toBe(true);
  });
});

describe("labels round the hand: which side", () => {
  // a hand drawn from x = 100 to 260 (middle 180, width 160)
  it("takes the preferred side, swapped when the picture is mirrored", () => {
    expect(sideFor("left", false, 180, 100, 260)).toBe("left");
    expect(sideFor("right", false, 180, 100, 260)).toBe("right");
    expect(sideFor("left", true, 180, 100, 260)).toBe("right"); // the front camera swaps the columns
    expect(sideFor("right", true, 180, 100, 260)).toBe("left");
  });

  it("moves a label to the nearer margin when its point is on the far half (a leader must not cross the hand)", () => {
    expect(sideFor("left", false, 250, 100, 260)).toBe("right"); // a left-column finger that sits on the right: a left hand
    expect(sideFor("right", false, 110, 100, 260)).toBe("left");
    expect(sideFor("left", true, 110, 100, 260)).toBe("left"); // mirrored: the preference was right, the point is left
  });

  it("keeps the preference for points near the middle (within 15% of the hand's width)", () => {
    expect(sideFor("left", false, 180 + 0.14 * 160, 100, 260)).toBe("left");
    expect(sideFor("left", false, 180 + 0.16 * 160, 100, 260)).toBe("right");
  });
});

describe("labels round the hand: the columns", () => {
  const frame = { left: 0, top: 0, right: 390, bottom: 520, loX: 120, hiX: 270, topReserve: 60 }; // a fixed reserve: the tests below do not depend on topReserveFor
  const mk = (n: number): LabelOut[] => Array.from({ length: n }, () => ({ visible: false, left: 0, top: 0, x1: 0, y1: 0 }));
  const lab = (side: "left" | "right", y: number, priority: number, w = 64, h = 34): LabelIn => ({ x: side === "left" ? 140 : 250, y, w, h, side, priority });

  it("lines each side up on its own edge of the hand and joins the label's inner edge to its point", () => {
    const ins = [lab("left", 200, 1), lab("right", 220, 0)];
    const out = mk(2);
    expect(layoutLabels(ins, frame, out)).toBe(2);
    expect(out[0].left + 64).toBe(frame.loX - LABEL_LEAD); // a left label ends a lead before the hand
    expect(out[0].x1).toBe(frame.loX - LABEL_LEAD);
    expect(out[1].left).toBe(frame.hiX + LABEL_LEAD); // a right label starts a lead after it
    expect(out[1].x1).toBe(frame.hiX + LABEL_LEAD);
    expect(out[0].y1).toBeCloseTo(out[0].top + 17);
  });

  it("stacks a column in the order of the measured points, never overlapping, with the minimum gap", () => {
    const ins = [lab("right", 300, 0), lab("right", 302, 1), lab("right", 304, 2), lab("right", 150, 3)];
    const out = mk(4);
    layoutLabels(ins, frame, out);
    const order = [3, 0, 1, 2]; // by the point's y
    for (let k = 1; k < order.length; k++) {
      expect(out[order[k]].top).toBeGreaterThanOrEqual(out[order[k - 1]].top + 34 + LABEL_GAP - 1e-9);
    }
    expect(out.every((o) => o.visible)).toBe(true);
  });

  it("keeps every label inside the picture and below the top reserve, even when the points are at the edges", () => {
    const ins = [lab("left", -50, 0), lab("left", 5, 1), lab("left", 900, 2), lab("left", 1000, 3)];
    const out = mk(4);
    layoutLabels(ins, frame, out);
    for (const o of out) {
      expect(o.visible).toBe(true);
      expect(o.top).toBeGreaterThanOrEqual(frame.topReserve - 1e-9);
      expect(o.top + 34).toBeLessThanOrEqual(frame.bottom - LABEL_EDGE + 1e-9);
      expect(o.left).toBeGreaterThanOrEqual(frame.left + LABEL_EDGE);
    }
    // and still separated
    const tops = out.map((o) => o.top).sort((a, b) => a - b);
    for (let k = 1; k < tops.length; k++) expect(tops[k] - tops[k - 1]).toBeGreaterThanOrEqual(34 + LABEL_GAP - 1e-9);
  });

  it("drops a label that is wider than its margin, and only on that side", () => {
    const narrowLeft = { ...frame, loX: 60 }; // 60 - 16 - 4 = 40 px of room on the left, 100 on the right
    const ins = [lab("left", 200, 1, 64), lab("right", 200, 0, 64)];
    const out = mk(2);
    expect(layoutLabels(ins, narrowLeft, out)).toBe(1);
    expect(out[0].visible).toBe(false);
    expect(out[1].visible).toBe(true);
  });

  it("on a narrow picture shows only the labels that fit the column's height, best priority first", () => {
    const short = { ...frame, bottom: 60 + 34 * 3 + LABEL_GAP * 2 + LABEL_EDGE }; // room for exactly three labels
    const ins = [lab("right", 100, 6), lab("right", 110, 0), lab("right", 120, 3), lab("right", 130, 1), lab("right", 140, 5)];
    const out = mk(5);
    expect(layoutLabels(ins, short, out)).toBe(3);
    expect(out.map((o) => o.visible)).toEqual([false, true, false, true, false].map((v, i) => (i === 2 ? true : v)));
    expect(out[2].visible && out[1].visible && out[3].visible).toBe(true); // priorities 3, 0, 1
    expect(out[0].visible || out[4].visible).toBe(false); // 6 and 5 are the ones dropped
  });

  it("shows nothing when the hand fills the picture (no margin at all) and never invents room", () => {
    const full = { ...frame, loX: 10, hiX: 380 };
    const ins = [lab("left", 200, 0), lab("right", 200, 1)];
    const out = mk(2);
    expect(layoutLabels(ins, full, out)).toBe(0);
    expect(out.every((o) => !o.visible)).toBe(true);
  });

  it("never produces NaN and leaves no label outside the picture over many random hands", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let n = 0; n < 300; n++) {
      const w = 240 + rand() * 400;
      const h = 300 + rand() * 500;
      const lo = rand() * w * 0.5;
      const hi = lo + 40 + rand() * (w - lo - 40);
      const f = { left: 0, top: 0, right: w, bottom: h, loX: lo, hiX: hi, topReserve: topReserveFor(h) };
      const ins: LabelIn[] = Array.from({ length: 7 }, (_, i) => ({
        x: lo + rand() * (hi - lo),
        y: rand() * h,
        w: 50 + rand() * 60,
        h: 24 + rand() * 12,
        side: rand() < 0.5 ? "left" : "right",
        priority: i,
      }));
      const out = mk(7);
      layoutLabels(ins, f, out);
      out.forEach((o, i) => {
        if (!o.visible) return;
        expect([o.left, o.top, o.x1, o.y1].every(Number.isFinite)).toBe(true);
        expect(o.left).toBeGreaterThanOrEqual(f.left + LABEL_EDGE - 1e-6);
        expect(o.left + ins[i].w).toBeLessThanOrEqual(f.right - LABEL_EDGE + 1e-6);
        expect(o.top).toBeGreaterThanOrEqual(f.topReserve - 1e-6);
        expect(o.top + ins[i].h).toBeLessThanOrEqual(f.bottom - LABEL_EDGE + 1e-6);
        // clear of the hand's box sideways
        if (ins[i].side === "left") expect(o.left + ins[i].w).toBeLessThanOrEqual(f.loX - LABEL_LEAD + 1e-6);
        else expect(o.left).toBeGreaterThanOrEqual(f.hiX + LABEL_LEAD - 1e-6);
      });
    }
  });

  it("reserves a pill's room at the top, less on a short picture", () => {
    expect(topReserveFor(800)).toBe(76);
    expect(topReserveFor(200)).toBeCloseTo(68);
    expect(topReserveFor(0)).toBe(0);
  });
});
