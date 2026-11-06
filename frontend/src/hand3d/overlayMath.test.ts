import { describe, expect, it } from "vitest";
import { genericHand, handWire, normalizePose, poseSamples, sampleHand, type Landmark, type Vec3 } from "./handModel";
import {
  BEAD_COUNT,
  FINGER_RAIL_VERTS,
  FINGER_RAILS,
  HAND_RAIL_VERTS,
  beadGlow,
  containRect,
  fillRails,
  hasDepth,
  mapToElement,
  normalizeInto,
  poseBounds,
  railSide,
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
