import { describe, expect, it } from "vitest";
import { genericHand, poseSamples, sampleHand } from "../hand3d/handModel";
import {
  buildContours,
  clampBox,
  buildLattice,
  easeBox,
  FINGER_CHAINS,
  fingerPoint,
  frameTarget,
  FULL_LATTICE,
  handGeom,
  HIDDEN,
  latticePoints,
  latticeSize,
  newHandGeom,
  PALM,
  PART_COUNT,
  palmPoint,
  particleCount,
  rowCount,
  SPACING,
  STUB,
  STUB_LENGTH,
  THENAR,
  TIP_U,
  WEB0,
  scanLineFraction,
  swarmShare,
  videoToCanvas,
  visibleLimit,
} from "./swarm";

/** The generic hand as image pixels: 500 px wrist to fingertip, wrist at (300, 600). */
const hand = (dx = 0, dy = 0) => genericHand().map((p) => ({ x: 300 + dx + p.x * 500, y: 600 + dy - p.y * 500, z: 0 }));
const lat = buildLattice();
const points = (lm: ReturnType<typeof hand>) => {
  const out = new Float32Array(lat.count * 2);
  latticePoints(lm, handGeom(lm), lat, out);
  return out;
};
const ALL_PARTS = new Set(Array.from({ length: PART_COUNT }, (_, i) => i));
const shown = (out: Float32Array, i: number) => out[2 * i] > HIDDEN / 2;
type Pt = { x: number; y: number };
/** The same hand seen as a left hand (mirrored), turned upside down, turned a quarter, or flipped over. */
const TRANSFORMS: Record<string, (p: Pt) => Pt> = {
  right: (p) => p,
  left: (p) => ({ x: 600 - p.x, y: p.y }),
  "upside-down right": (p) => ({ x: 600 - p.x, y: 1200 - p.y }),
  "quarter-turned right": (p) => ({ x: 300 + (p.y - 600), y: 600 - (p.x - 300) }),
  "upside-down left": (p) => ({ x: p.x, y: 1200 - p.y }),
};
const variants = Object.fromEntries(Object.entries(TRANSFORMS).map(([name, t]) => [name, hand().map((p) => ({ ...p, ...t(p) }))]));

/** The 21 landmarks MediaPipe's hand landmarker gives for a real photo of an open hand (a right hand held up, thumb on the
 *  left of a 720 x 1280 portrait picture): the fingers are slightly spread, the thumb out. A realistic test of the patches
 *  the generic hand's tidy pose cannot show (the thenar, the webs). */
const REAL = [[426, 770], [306, 740], [234, 674], [184, 605], [131, 545], [298, 555], [266, 444], [247, 373], [238, 311], [368, 542], [355, 412], [349, 325], [345, 256], [427, 552], [438, 436], [444, 354], [450, 290], [475, 567], [502, 476], [517, 417], [530, 363]];
const REAL_TRANSFORMS: Record<string, (p: Pt) => Pt> = {
  "right hand": (p) => p,
  "left hand": (p) => ({ x: 720 - p.x, y: p.y }),
  "upside-down right hand": (p) => ({ x: 720 - p.x, y: 1280 - p.y }),
  "quarter-turned right hand": (p) => ({ x: 1280 - p.y, y: p.x }),
  "upside-down left hand": (p) => ({ x: p.x, y: 1280 - p.y }),
};
const realVariants = Object.fromEntries(
  Object.entries(REAL_TRANSFORMS).map(([name, t]) => [name, REAL.map(([x, y]) => ({ ...t({ x, y }), z: 0 }))]),
) as Record<string, ReturnType<typeof hand>>;
const real = realVariants["right hand"];

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

describe("the lattice", () => {
  it("is dense: 2500 to 4000 dots at full quality, on the fingers, the palm, the thenar, the wrist and the webs", () => {
    expect(lat.count).toBeGreaterThanOrEqual(2500);
    expect(lat.count).toBeLessThanOrEqual(4000);
    expect(lat.count).toBe(latticeSize(FULL_LATTICE));
    expect(new Set(lat.part)).toEqual(ALL_PARTS);
    expect(WEB0 + 3).toBe(PART_COUNT - 1);
    const palm = [...lat.part].filter((p) => p === PALM).length;
    expect(palm / lat.count).toBeGreaterThan(0.25);
    expect(palm / lat.count).toBeLessThan(0.5);
  });

  it("is built the same way every time (nothing random)", () => {
    const again = buildLattice();
    expect([...again.u]).toEqual([...lat.u]);
    expect([...again.v]).toEqual([...lat.v]);
    expect([...again.rank]).toEqual([...lat.rank]);
    expect([...again.rim]).toEqual([...lat.rim]);
  });

  it("puts every dot on a fixed place of its finger or the palm, with even rows and a half-step shift on odd rows", () => {
    for (let i = 0; i < lat.count; i++) {
      if (lat.part[i] >= PALM) {
        expect(lat.u[i]).toBeGreaterThan(0);
        expect(lat.u[i]).toBeLessThan(1);
        expect(lat.v[i]).toBeGreaterThan(0);
        expect(lat.v[i]).toBeLessThan(1);
      } else {
        expect(lat.u[i]).toBeGreaterThan(0);
        expect(lat.u[i]).toBeLessThan(1);
        expect(Math.abs(lat.v[i])).toBeLessThan(1);
      }
    }
    // first finger: row 0 and row 1 are shifted against each other
    const cols = FULL_LATTICE.fingerCols[0];
    expect(lat.v[cols] - lat.v[0]).toBeCloseTo(1 / cols, 5);
  });

  it("keeps each dot where it is on the hand from frame to frame, and moves it with the hand", () => {
    const a = points(hand());
    expect([...points(hand())]).toEqual([...a]); // the same landmarks, the same dots
    const moved = points(hand(80, -40));
    for (let i = 0; i < lat.count; i++) {
      expect(shown(moved, i)).toBe(shown(a, i)); // the same dots are needed
      if (!shown(a, i)) continue;
      expect(moved[2 * i] - a[2 * i]).toBeCloseTo(80, 2);
      expect(moved[2 * i + 1] - a[2 * i + 1]).toBeCloseTo(-40, 2);
    }
  });

  it("does not jump when the landmarks jitter: a 1 px wobble moves a dot by a few px at most", () => {
    const base = points(hand());
    const wobble = hand().map((p, i) => ({ ...p, x: p.x + (i % 2 ? 1 : -1), y: p.y + (i % 3 ? 1 : -1) }));
    const wob = points(wobble);
    let worst = 0;
    for (let i = 0; i < lat.count; i++) {
      if (shown(base, i) && shown(wob, i)) worst = Math.max(worst, Math.hypot(wob[2 * i] - base[2 * i], wob[2 * i + 1] - base[2 * i + 1]));
    }
    // every landmark moved by up to 1.4 px in the worst direction at once; a dot near a fingertip (where the strip narrows
    // into its dome) moves a little more than the landmark, but never jumps (measured 4.5 px, 6.3 px now that the strip runs on to a cap beyond the tip). The live landmarks are
    // already smoothed (vision/smoothing.ts), so real jitter is a fraction of this.
    expect(worst).toBeLessThan(7);
    // ... and the average dot moves about as much as the landmarks do
    let sum = 0;
    let n = 0;
    for (let i = 0; i < lat.count; i++) {
      if (!shown(base, i) || !shown(wob, i)) continue;
      sum += Math.hypot(wob[2 * i] - base[2 * i], wob[2 * i + 1] - base[2 * i + 1]);
      n++;
    }
    expect(sum / n).toBeLessThan(2);
  });

  it("covers the hand: the dots stay within the hand's box (grown by a finger's width) and spread over all of it", () => {
    const lm = hand();
    const p = points(lm);
    const xs = lm.map((q) => q.x);
    const ys = lm.map((q) => q.y);
    const pad = 0.12 * 500;
    for (let i = 0; i < lat.count; i++) {
      if (!shown(p, i)) continue;
      expect(p[2 * i]).toBeGreaterThanOrEqual(Math.min(...xs) - pad);
      expect(p[2 * i]).toBeLessThanOrEqual(Math.max(...xs) + pad);
      expect(p[2 * i + 1]).toBeGreaterThanOrEqual(Math.min(...ys) - pad);
      expect(p[2 * i + 1]).toBeLessThanOrEqual(Math.max(...ys) + pad + STUB_LENGTH * 500); // (the wrist stub reaches below the wrist)
    }
    // the palm dots really are on the palm: inside the polygon wrist - thumb base - knuckles
    const palmDots = [...lat.part].map((part, i) => (part === PALM ? i : -1)).filter((i) => i >= 0);
    const cx = palmDots.reduce((s, i) => s + p[2 * i], 0) / palmDots.length;
    const cy = palmDots.reduce((s, i) => s + p[2 * i + 1], 0) / palmDots.length;
    // halfway between the wrist and the middle of the knuckle line
    const centre = { x: (lm[0].x + (lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 4) / 2, y: (lm[0].y + (lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 4) / 2 };
    expect(Math.hypot(cx - centre.x, cy - centre.y)).toBeLessThan(0.1 * 500);
  });

  it("tapers the fingers: narrower at the tip than at the base, and the strip closes in a dome", () => {
    const lm = hand();
    const g = handGeom(lm);
    const buf = new Float32Array(2);
    const width = (f: number, u: number) => {
      fingerPoint(lm, g, f, u, -1, buf, 0);
      const ax = buf[0];
      const ay = buf[1];
      fingerPoint(lm, g, f, u, 1, buf, 0);
      return Math.hypot(buf[0] - ax, buf[1] - ay);
    };
    for (let f = 0; f < 5; f++) {
      expect(width(f, 0.05)).toBeGreaterThan(width(f, 0.8));
      expect(width(f, 0.8)).toBeGreaterThan(width(f, 0.99));
      expect(width(f, 0.999)).toBeLessThan(0.2 * width(f, 0.05));
    }
    // the middle finger's rows run along the real bones: the centre line passes through the joints
    fingerPoint(lm, g, 2, 0, 0, buf, 0);
    expect(buf[0]).toBeCloseTo(lm[FINGER_CHAINS[2][0]].x, 3);
    fingerPoint(lm, g, 2, TIP_U, 0, buf, 0);
    expect(buf[0]).toBeCloseTo(lm[FINGER_CHAINS[2][3]].x, 3);
    expect(buf[1]).toBeCloseTo(lm[FINGER_CHAINS[2][3]].y, 3);
  });

  it("rounds every fingertip off beyond the tip landmark: a few millimetres of cap, in the finger's direction", () => {
    const lm = hand();
    const g = handGeom(lm);
    const buf = new Float32Array(2);
    expect(TIP_U).toBeGreaterThan(0.88);
    expect(TIP_U).toBeLessThan(0.96);
    for (let f = 0; f < 5; f++) {
      const ch = FINGER_CHAINS[f];
      fingerPoint(lm, g, f, 1, 0, buf, 0); // the very end of the strip
      const past = Math.hypot(buf[0] - lm[ch[3]].x, buf[1] - lm[ch[3]].y);
      // about 9 % of the finger's length: 5 to 9 mm on a real finger
      const finger = g.cum[f * 4 + 3];
      expect(past).toBeGreaterThan(0.07 * finger);
      expect(past).toBeLessThan(0.11 * finger);
      // ... straight on from the last bone
      const dx = lm[ch[3]].x - lm[ch[2]].x;
      const dy = lm[ch[3]].y - lm[ch[2]].y;
      const cos = ((buf[0] - lm[ch[3]].x) * dx + (buf[1] - lm[ch[3]].y) * dy) / (past * Math.hypot(dx, dy));
      expect(cos).toBeGreaterThan(0.999);
    }
  });

  it("maps the palm patch onto the landmarks: it reaches the outer edge of the index and little fingers' bases and the wrist", () => {
    const lm = hand();
    const g = handGeom(lm);
    const buf = new Float32Array(2);
    const near = (p: { x: number; y: number }, tol: number) => Math.hypot(buf[0] - p.x, buf[1] - p.y) < tol;
    // the knuckles themselves are on the top edge ...
    palmPoint(g, g.topT[1], 1, buf, 0);
    expect(near(lm[5], 0.5)).toBe(true);
    palmPoint(g, g.topT[4], 1, buf, 0);
    expect(near(lm[17], 0.5)).toBe(true);
    // ... which runs on past them to the outer edge of the index finger (thumb side) and of the little finger
    palmPoint(g, 0, 1, buf, 0);
    expect(Math.hypot(buf[0] - lm[5].x, buf[1] - lm[5].y)).toBeGreaterThan(0.04 * 500);
    expect(buf[0]).toBeGreaterThan(lm[5].x); // genericHand: a right hand, thumb at +x
    palmPoint(g, 1, 1, buf, 0);
    expect(buf[0]).toBeLessThan(lm[17].x);
    // the middle of the wrist line is the wrist landmark
    palmPoint(g, 0.5, 0, buf, 0);
    expect(near(lm[0], 0.5)).toBe(true);
  });

  it("spaces the palm dots by distance along each edge, not by landmark: the short end pieces of the knuckle row do not crowd", () => {
    const lm = hand();
    const g = handGeom(lm);
    const a = new Float32Array(2);
    const b = new Float32Array(2);
    const step = (a0: number) => {
      palmPoint(g, a0, 0.5, a, 0);
      palmPoint(g, a0 + 0.02, 0.5, b, 0);
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    };
    const steps = [0.02, 0.1, 0.3, 0.5, 0.7, 0.9, 0.96].map(step);
    expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(1.6);
  });
});

/** The hand model's own surface (capsule fingers, palm slab, forearm), as image points: an independent picture of where the
 *  skin is. Its forearm is far longer than the stub, so only the part the stub reaches is kept. */
function modelSurface(): { x: number; y: number }[] {
  const model = genericHand();
  const sampled = sampleHand(model, 9000, 7);
  const raw = new Float32Array(sampled.count * 3);
  poseSamples(sampled, model, raw);
  const out: { x: number; y: number }[] = [];
  for (let k = 0; k < sampled.count; k++) {
    if (sampled.bone[k] === 16 && sampled.t[k] > 0.36) continue;
    out.push({ x: 300 + raw[3 * k] * 500, y: 600 - raw[3 * k + 1] * 500 });
  }
  return out;
}

/** For each of `from`, the distance to the nearest of the shown dots (a hash grid of 24 px cells keeps this quick). */
function distancesToDots(from: { x: number; y: number }[], dots: Float32Array): number[] {
  const cell = 24;
  const grid = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 100003 + cy;
  for (let i = 0; i < dots.length / 2; i++) {
    if (!shown(dots, i)) continue;
    const k = key(Math.floor(dots[2 * i] / cell), Math.floor(dots[2 * i + 1] / cell));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  return from.map((p) => {
    let best = Infinity;
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let r = 1; r <= 4 && best === Infinity; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (const i of grid.get(key(cx + dx, cy + dy)) ?? []) best = Math.min(best, Math.hypot(dots[2 * i] - p.x, dots[2 * i + 1] - p.y));
        }
      }
    }
    return best;
  });
}

describe("the whole visible hand is covered, with no free spaces", () => {
  const surface = modelSurface();
  const quantile = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))];

  for (const [name, lm] of Object.entries(variants)) {
    it(`every part of the ${name} hand is near a dot (thenar, wrist, webs and fingertips included)`, () => {
      const dots = points(lm);
      const move = TRANSFORMS[name];
      const d = distancesToDots(surface.map(move), dots);
      // dots are about 5.5 px apart on this 500 px hand: a skin point is within about 3 dot spacings of a dot, nearly all within 2
      expect(quantile(d, 0.9)).toBeLessThan(10);
      expect(quantile(d, 0.98)).toBeLessThan(17);
      expect(quantile(d, 0.995)).toBeLessThan(30);
    });
  }

  it("spreads the dots evenly: no clumps and no holes between neighbouring dots, across the fingers, the webs, the thenar and the wrist", () => {
    const dots = points(real);
    const idx = [...Array(lat.count).keys()].filter((i) => shown(dots, i));
    const grid = new Map<number, number[]>();
    const cell = 20;
    const key = (cx: number, cy: number) => cx * 100003 + cy;
    for (const i of idx) {
      const k = key(Math.floor(dots[2 * i] / cell), Math.floor(dots[2 * i + 1] / cell));
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    }
    const nn = idx.map((i) => {
      let best = Infinity;
      const cx = Math.floor(dots[2 * i] / cell);
      const cy = Math.floor(dots[2 * i + 1] / cell);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          for (const j of grid.get(key(cx + dx, cy + dy)) ?? []) if (j !== i) best = Math.min(best, Math.hypot(dots[2 * j] - dots[2 * i], dots[2 * j + 1] - dots[2 * i + 1]));
        }
      }
      return best;
    });
    const sorted = [...nn].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(sorted[Math.floor(sorted.length * 0.01)]).toBeGreaterThan(0.3 * median); // clumps: hardly any dot sits on top of another
    expect(sorted[Math.floor(sorted.length * 0.99)]).toBeLessThan(1.7 * median); // holes: hardly any dot is far from every other
    // per part: the typical spacing of a thenar / wrist / web / finger dot is about the same as the palm's
    const perPart = (part: number) => {
      const v = idx.map((i, k) => (lat.part[i] === part ? nn[k] : -1)).filter((x) => x >= 0).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    };
    for (const part of [0, 1, 2, 3, 4, PALM, THENAR, STUB]) {
      expect(perPart(part)).toBeGreaterThan(0.75 * median);
      expect(perPart(part)).toBeLessThan(1.3 * median);
    }
  });

  for (const [name, lm] of Object.entries(realVariants)) {
    it(`puts the thenar by the thumb, the stub behind the wrist and each web between its two fingers (${name} hand)`, () => {
      const g = handGeom(lm);
      const dots = new Float32Array(lat.count * 2);
      latticePoints(lm, g, lat, dots);
      const len = g.len;
      const mean = (part: number) => {
        let x = 0;
        let y = 0;
        let n = 0;
        for (let i = 0; i < lat.count; i++) if (lat.part[i] === part && shown(dots, i)) (x += dots[2 * i]), (y += dots[2 * i + 1]), n++;
        return { x: x / n, y: y / n, n };
      };
      const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
      const thenar = mean(THENAR);
      expect(thenar.n).toBeGreaterThan(40);
      expect(dist(thenar, lm[1])).toBeLessThan(dist(thenar, lm[17])); // on the thumb's side, not the little finger's
      expect(dist(thenar, lm[1])).toBeLessThan(0.3 * len);
      const stub = mean(STUB);
      expect(stub.n).toBeGreaterThan(150);
      // behind the wrist: farther from the fingertips than the wrist is, by about half the stub's length
      expect(dist(stub, lm[12]) - dist(lm[0], lm[12])).toBeGreaterThan(0.03 * len);
      expect(dist(stub, lm[12]) - dist(lm[0], lm[12])).toBeLessThan(STUB_LENGTH * len);
      // the webs: between the bases of two neighbouring fingers (the thumb's: its knuckle), a little way up
      const pairs: [number, number][] = [[2, 5], [5, 9], [9, 13], [13, 17]];
      pairs.forEach(([a, b], w) => {
        const m = mean(WEB0 + w);
        const mid = { x: (lm[a].x + lm[b].x) / 2, y: (lm[a].y + lm[b].y) / 2 };
        expect(m.n).toBeGreaterThan(1);
        expect(dist(m, mid)).toBeLessThan(0.11 * len);
      });
    });
  }

  it("a web's dots are shown only where the gap between the fingers is wide enough, and rows keep their count unless the gap clearly changes", () => {
    expect(rowCount(0.2 * SPACING * 500, 500, 0, 6)).toBe(0); // a closed web has no dots of its own (the fingers' dots touch)
    expect(rowCount(30, 500, 0, 6)).toBe(Math.round(30 / (SPACING * 500)));
    expect(rowCount(1000, 500, 0, 6)).toBe(6); // never more than a row has
    // hysteresis: at a borderline width the count stays where it was
    expect(rowCount(2.45 * SPACING * 500, 500, 3, 6)).toBe(3);
    expect(rowCount(2.45 * SPACING * 500, 500, 2, 6)).toBe(2);
    expect(rowCount(2.45 * SPACING * 500, 500, 0, 6)).toBe(2);
    expect(rowCount(3.9 * SPACING * 500, 500, 2, 6)).toBe(4); // a clear change does move it
  });

  it("keeps the dots of a patch row steady while the landmarks wobble by half a pixel (no flicker between two counts)", () => {
    const g = newHandGeom();
    const out = new Float32Array(lat.count * 2);
    const lm = real;
    latticePoints(lm, handGeom(lm, g), lat, out);
    const base = Array.from(g.rowN);
    for (let k = 0; k < 30; k++) {
      const w = lm.map((p, i) => ({ ...p, x: p.x + (((i * 7 + k) % 3) - 1) * 0.5, y: p.y + (((i * 5 + k) % 3) - 1) * 0.5 }));
      latticePoints(w, handGeom(w, g), lat, out);
      expect(Array.from(g.rowN)).toEqual(base);
    }
  });

  it("the scan frame holds the whole hand with its wrist stub and fingertip caps", () => {
    const lm = hand();
    const t = frameTarget(lm);
    const lowest = Math.max(...lm.map((p) => p.y));
    expect(t.y1).toBeGreaterThan(lowest + STUB_LENGTH * 500 - 1);
    const dots = points(lm);
    for (let i = 0; i < lat.count; i++) {
      if (!shown(dots, i)) continue;
      expect(dots[2 * i]).toBeGreaterThan(t.x0);
      expect(dots[2 * i]).toBeLessThan(t.x1);
      expect(dots[2 * i + 1]).toBeGreaterThan(t.y0);
      expect(dots[2 * i + 1]).toBeLessThan(t.y1);
    }
  });
});

describe("rim weight (the glowing silhouette edge)", () => {
  it("does not glow along the side of a finger that faces its neighbour at the base (the web is there), on either hand, but does on the outside", () => {
    for (const [name, lm] of Object.entries(realVariants)) {
      const g = handGeom(lm);
      const dots = new Float32Array(lat.count * 2);
      const rim = new Float32Array(lat.count);
      latticePoints(lm, g, lat, dots, rim);
      const base = (f: number, side: number) => {
        let s = 0;
        let n = 0;
        for (let i = 0; i < lat.count; i++) {
          if (lat.part[i] === f && lat.side[i] === side && lat.u[i] < 0.08 && Math.abs(lat.v[i]) > 0.8) (s += rim[i]), n++;
        }
        return s / n;
      };
      // the middle finger has a neighbour on both sides: neither glows at its base; further up both do
      for (const side of [1, -1]) {
        expect(base(2, side), `${name}: middle ${side}`).toBeLessThan(0.15);
      }
      // the little finger: the ring-finger side is quiet, the outside glows
      const quiet = g.facePrev[4];
      expect(base(4, quiet), `${name}: little, ring side`).toBeLessThan(0.15);
      expect(base(4, -quiet), `${name}: little, outside`).toBeGreaterThan(0.5);
      // the index finger: the thumb side and the middle-finger side are both inside the hand at the base
      expect(base(1, 1)).toBeLessThan(0.15);
      expect(base(1, -1)).toBeLessThan(0.15);
      // further up the same finger the edge glows on both sides
      let up = 0;
      let nUp = 0;
      for (let i = 0; i < lat.count; i++) if (lat.part[i] === 2 && lat.u[i] > 0.4 && lat.u[i] < 0.7 && Math.abs(lat.v[i]) > 0.8) (up += rim[i]), nUp++;
      expect(up / nUp).toBeGreaterThan(0.6);
    }
  });

  it("works out which side of a finger faces which neighbour from the landmarks: opposite on a left and a right hand", () => {
    const right = handGeom(realVariants["right hand"]);
    const left = handGeom(realVariants["left hand"]);
    for (let f = 0; f < 4; f++) expect(left.faceNext[f]).toBe(-right.faceNext[f]);
    for (let f = 1; f < 5; f++) expect(left.facePrev[f]).toBe(-right.facePrev[f]);
    // a finger's two neighbours are on opposite sides
    for (const f of [1, 2, 3]) expect(right.faceNext[f]).toBe(-right.facePrev[f]);
    expect(right.facePrev[0]).toBe(0);
    expect(right.faceNext[4]).toBe(0);
  });

  it("is carried by the outer edge of the thenar, the two sides of the wrist stub and the crotch of a web, and nowhere else on them", () => {
    const g = handGeom(real);
    const dots = new Float32Array(lat.count * 2);
    const rim = new Float32Array(lat.count);
    latticePoints(real, g, lat, dots, rim);
    for (let i = 0; i < lat.count; i++) {
      if (!shown(dots, i) || lat.part[i] < THENAR) continue;
      expect(rim[i]).toBeGreaterThanOrEqual(0);
      expect(rim[i]).toBeLessThanOrEqual(1);
    }
    const stub = [...Array(lat.count).keys()].filter((i) => lat.part[i] === STUB && shown(dots, i));
    const edge = stub.filter((i) => rim[i] > 0.5);
    const middle = stub.filter((i) => rim[i] < 0.05);
    expect(edge.length).toBeGreaterThan(10);
    expect(middle.length).toBeGreaterThan(stub.length / 4);
  });

  it("is 1 at the silhouette edge of a finger and near 0 down its middle", () => {
    let edge = 0;
    let middle = 0;
    let nEdge = 0;
    let nMiddle = 0;
    for (let i = 0; i < lat.count; i++) {
      if (lat.part[i] >= PALM || lat.u[i] > 0.8) continue;
      if (Math.abs(lat.v[i]) > 0.85) (edge += lat.rim[i]), nEdge++;
      if (Math.abs(lat.v[i]) < 0.25) (middle += lat.rim[i]), nMiddle++;
    }
    expect(edge / nEdge).toBeGreaterThan(0.6);
    expect(middle / nMiddle).toBeLessThan(0.05);
  });

  it("on the palm only the little-finger edge glows: not the thumb side (it runs into the thumb), the wrist or the knuckle line", () => {
    let side = 0;
    let thumbSide = 0;
    let centre = 0;
    let wrist = 0;
    let knuckles = 0;
    for (let i = 0; i < lat.count; i++) {
      if (lat.part[i] !== PALM) continue;
      const a = lat.u[i];
      const b = lat.v[i];
      if (a > 0.96) side = Math.max(side, lat.rim[i]);
      if (a < 0.04) thumbSide = Math.max(thumbSide, lat.rim[i]);
      if (a > 0.3 && a < 0.7 && b > 0.2 && b < 0.8) centre = Math.max(centre, lat.rim[i]);
      if (b < 0.05 && a > 0.3 && a < 0.7) wrist = Math.max(wrist, lat.rim[i]);
      if (b > 0.95 && a > 0.3 && a < 0.7) knuckles = Math.max(knuckles, lat.rim[i]);
    }
    expect(side).toBeGreaterThan(0.5);
    expect(thumbSide).toBe(0);
    expect(centre).toBe(0);
    expect(wrist).toBe(0);
    expect(knuckles).toBe(0);
    expect(Math.max(...lat.rim)).toBeLessThanOrEqual(1);
    expect(Math.min(...lat.rim)).toBeGreaterThanOrEqual(0);
  });
});

describe("how many dots are shown", () => {
  it("shows more as the real coverage grows, from most of them to all of them", () => {
    expect(swarmShare(0)).toBeCloseTo(0.6, 5);
    expect(swarmShare(50)).toBeCloseTo(0.8, 5);
    expect(swarmShare(100)).toBeCloseTo(1, 5);
    expect(swarmShare(-5)).toBe(swarmShare(0));
    expect(swarmShare(250)).toBe(swarmShare(100));
    expect(swarmShare(Number.NaN)).toBe(swarmShare(0));
  });

  it("is scaled down by the speed guard and never to nothing", () => {
    expect(particleCount(460, 1)).toBe(460);
    expect(particleCount(460, 0.5)).toBe(230);
    expect(particleCount(460, 0)).toBeGreaterThan(0);
    expect(visibleLimit(lat, 1, 1)).toBe(lat.count);
    expect(Math.abs(visibleLimit(lat, 1, 0.5) - lat.count / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(visibleLimit(lat, 0.6, 0.5) - lat.count * 0.3)).toBeLessThanOrEqual(1);
    expect(visibleLimit(lat, 0, 0)).toBeGreaterThan(0);
  });

  it("a smaller count is always a subset of a bigger one, and still covers the whole hand", () => {
    const set = (n: number) => new Set([...lat.rank].map((r, i) => (r < n / lat.count ? i : -1)).filter((i) => i >= 0));
    const half = set(visibleLimit(lat, 1, 0.5));
    const full = set(visibleLimit(lat, 1, 1));
    expect(half.size).toBeLessThan(full.size);
    for (const i of half) expect(full.has(i)).toBe(true);
    expect(new Set([...half].map((i) => lat.part[i]))).toEqual(ALL_PARTS); // every finger, the palm, the thenar, the wrist and the webs
    const palmShare = [...half].filter((i) => lat.part[i] === PALM).length / half.size;
    expect(palmShare).toBeGreaterThan(0.25);
    expect(palmShare).toBeLessThan(0.5);
  });
});

describe("contours", () => {
  const c = buildContours();
  it("has a ring contour across every finger, several along each, bending towards the tip", () => {
    for (let f = 0; f < 5; f++) expect(c.fingerArcs.filter((a) => a.finger === f).length).toBeGreaterThanOrEqual(5);
    for (const a of c.fingerArcs) {
      expect(a.vs.length).toBeGreaterThanOrEqual(5);
      expect(a.u).toBeGreaterThan(0);
      expect(a.u).toBeLessThan(1);
    }
    const lm = hand();
    const g = handGeom(lm);
    // an arc's middle is nearer the fingertip than its ends (it bends the way a ring on a finger looks)
    const arc = c.fingerArcs.find((a) => a.finger === 2 && a.u > 0.3)!;
    const buf = new Float32Array(2);
    const along = (v: number) => {
      fingerPoint(lm, g, 2, arc.u + 0.03 * (1 - v * v), v, buf, 0);
      return -buf[1]; // the middle finger points up
    };
    expect(along(0)).toBeGreaterThan(along(1));
  });

  it("has fine curved relief lines over the palm, all inside the palm patch", () => {
    expect(c.palm.length).toBeGreaterThanOrEqual(8);
    for (const line of c.palm) {
      expect(line.length).toBeGreaterThanOrEqual(20);
      for (let k = 0; k < line.length; k += 2) {
        expect(line[k]).toBeGreaterThan(-0.1);
        expect(line[k]).toBeLessThan(1.1);
        expect(line[k + 1]).toBeGreaterThan(0);
        expect(line[k + 1]).toBeLessThan(1);
      }
    }
  });
});

describe("the scan frame and the scan line", () => {
  it("the frame is the hand's box with a margin, and eases without overshooting or jittering", () => {
    const lm = hand();
    const t = frameTarget(lm);
    const xs = lm.map((p) => p.x);
    expect(t.x0).toBeLessThan(Math.min(...xs));
    expect(t.x1).toBeGreaterThan(Math.max(...xs));
    const far = { x0: 0, y0: 0, x1: 100, y1: 100 };
    let cur = far;
    let prevGap = Infinity;
    for (let i = 0; i < 60; i++) {
      cur = easeBox(cur, t, 1 / 60);
      const gap = Math.abs(cur.x0 - t.x0);
      expect(gap).toBeLessThanOrEqual(prevGap + 1e-9); // always closer, never past it
      prevGap = gap;
    }
    expect(prevGap).toBeLessThan(2);
    // a 2 px landmark jitter moves the eased frame by far less than 2 px in one step
    const jitter = { ...t, x0: t.x0 + 2 };
    expect(Math.abs(easeBox(t, jitter, 1 / 60).x0 - t.x0)).toBeLessThan(0.4);
  });

  it("the frame is kept inside the camera picture, whatever the hand does", () => {
    const c = clampBox({ x0: -40, y0: -10, x1: 500, y1: 900 }, 360, 640);
    expect(c.x0).toBeGreaterThanOrEqual(14);
    expect(c.y0).toBeGreaterThanOrEqual(14);
    expect(c.x1).toBeLessThanOrEqual(360 - 14);
    expect(c.y1).toBeLessThanOrEqual(640 - 14);
    const inside = { x0: 60, y0: 80, x1: 300, y1: 560 };
    expect(clampBox(inside, 360, 640)).toEqual(inside); // a frame already inside is left alone
    const odd = clampBox({ x0: 900, y0: 900, x1: 950, y1: 950 }, 360, 640); // a hand far outside still gives a sane box
    expect(odd.x1).toBeGreaterThan(odd.x0);
    expect(odd.y1).toBeGreaterThan(odd.y0);
  });

  it("the scan line sits where the real coverage is: low at the wrist, high near the fingertips, never a timer", () => {
    expect(scanLineFraction(0)).toBeCloseTo(0.06, 5);
    expect(scanLineFraction(100)).toBeCloseTo(0.94, 5);
    expect(scanLineFraction(50)).toBeGreaterThan(scanLineFraction(30));
    expect(scanLineFraction(Number.NaN)).toBe(scanLineFraction(0));
    expect(scanLineFraction(-20)).toBe(scanLineFraction(0));
    expect(scanLineFraction(200)).toBe(scanLineFraction(100));
    expect(scanLineFraction(66)).toBe(scanLineFraction(66)); // a function of the coverage alone
  });
});
