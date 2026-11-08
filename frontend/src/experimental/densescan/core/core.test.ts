// SYNTHETIC tests of the dense surface-point core: they prove the mechanics against known masks and images. They say
// nothing about real hands, real phones or physical accuracy.
import { describe, expect, it } from "vitest";
import type { BinaryMask, Pt, Pt3 } from "../../common";
import { makeSyntheticHand } from "../../segmentation/synthetic";
import {
  applyMeasuredDepth,
  buildPointCloud,
  buildPointSet,
  dedupeAndFilter,
  DEFAULT_DOT_CONFIG,
  edgeDistance,
  estimateRelativeDepth,
  exportPointSet,
  generateSurfacePoints,
  initialScanState,
  labelRegions,
  measureFromPoints,
  meshFromLattice,
  resolveSpacing,
  scanReducer,
  validatePoints,
  type ImageRGBA,
  type ScanEvent,
  type ScanState,
  type SurfacePoint,
} from "./index";

const mask = (w: number, h: number, on: (x: number, y: number) => boolean): BinaryMask => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = on(x, y) ? 255 : 0;
  return { width: w, height: h, data };
};
const area = (m: BinaryMask) => m.data.reduce((n, v) => n + (v ? 1 : 0), 0);
const on = (m: BinaryMask, x: number, y: number) => m.data[Math.floor(y) * m.width + Math.floor(x)] > 0;

/** Two "fingers" (rectangles) separated by a gap of `gap` px. */
const twoFingers = (gap: number) => mask(80, 60, (x, y) => y >= 5 && y < 55 && ((x >= 10 && x < 35) || (x >= 35 + gap && x < 60 + gap)));

/** A textured image (deterministic noise) where the mask is skin-coloured. */
function texturedImage(m: BinaryMask, seed = 3, amp = 30): ImageRGBA {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
  const data = new Uint8ClampedArray(m.width * m.height * 4);
  for (let i = 0; i < m.width * m.height; i++) {
    const n = rnd() * amp;
    const base = m.data[i] ? [180, 130, 105] : [235, 235, 238];
    data[i * 4] = base[0] + n;
    data[i * 4 + 1] = base[1] + n;
    data[i * 4 + 2] = base[2] + n;
    data[i * 4 + 3] = 255;
  }
  return { width: m.width, height: m.height, data };
}

describe("spacing: a sampling step, never an accuracy (synthetic)", () => {
  it("clamps a 0.1 mm target to one pixel at a phone-video scale and says so", () => {
    const r = resolveSpacing({ ...DEFAULT_DOT_CONFIG, targetSpacingMm: 0.1 }, { mmPerPx: 0.35, relUncertainty: 0.02, source: "coin" });
    expect(r.spacingPx).toBe(1);
    expect(r.limitedByResolution).toBe(true);
    expect(r.note).toMatch(/clamped to 1 px/);
    expect(r.note).toMatch(/interpolate/);
    expect(r.spacingMm.basis).toBe("model");
    expect(r.spacingMm.value).toBeCloseTo(0.35, 6);
  });
  it("converts a coarser target with the coin scale, and has no millimetres without a scale", () => {
    const r = resolveSpacing({ ...DEFAULT_DOT_CONFIG, targetSpacingMm: 1 }, { mmPerPx: 0.25, relUncertainty: 0.02, source: "coin" });
    expect(r.spacingPx).toBeCloseTo(4, 9);
    expect(r.limitedByResolution).toBe(false);
    const n = resolveSpacing(DEFAULT_DOT_CONFIG, null);
    expect(n.spacingPx).toBe(4);
    expect(n.spacingMm.basis).toBe("none");
    expect(n.spacingMm.value).toBeNull();
  });
});

describe("point generation inside the mask (synthetic)", () => {
  const hand = makeSyntheticHand({ width: 320, height: 320, noise: 12, spreadDeg: 14 });
  it("puts every point on a hand pixel, none outside, in lattice order", () => {
    const pts = generateSurfacePoints(hand.truth, 1, DEFAULT_DOT_CONFIG);
    expect(pts.length).toBeGreaterThan(500);
    for (const p of pts) expect(on(hand.truth, p.x, p.y)).toBe(true);
    pts.forEach((p, i) => expect(p.id).toBe(i));
    for (let i = 1; i < pts.length; i++) expect(pts[i].gy >= pts[i - 1].gy).toBe(true);
    for (const p of pts) expect(p.depth).toBe("none");
  });
  it("density follows area / spacing^2", () => {
    for (const sp of [2, 3, 4, 6]) {
      const n = generateSurfacePoints(hand.truth, 1, { ...DEFAULT_DOT_CONFIG, spacingPx: sp }).length;
      const expected = area(hand.truth) / (sp * sp);
      expect(Math.abs(n - expected) / expected).toBeLessThan(0.1);
    }
  });
  it("is deterministic for a seed, differs between seeds, and jitter keeps points inside", () => {
    const cfg = { ...DEFAULT_DOT_CONFIG, jitter: 0.4, seed: 7 };
    const a = generateSurfacePoints(hand.truth, 1, cfg);
    const b = generateSurfacePoints(hand.truth, 1, cfg);
    const c = generateSurfacePoints(hand.truth, 1, { ...cfg, seed: 8 });
    expect(a).toEqual(b);
    expect(a.map((p) => p.x)).not.toEqual(c.map((p) => p.x));
    for (const p of a) expect(on(hand.truth, p.x, p.y)).toBe(true);
  });
  it("never puts a point in a 2 or 3 px gap between fingers, even with a 1 px step and jitter", () => {
    for (const gap of [2, 3]) {
      const m = twoFingers(gap);
      for (const cfg of [{ ...DEFAULT_DOT_CONFIG, spacingPx: 1 }, { ...DEFAULT_DOT_CONFIG, spacingPx: 1, jitter: 0.45, seed: 5 }]) {
        const pts = generateSurfacePoints(m, 1, cfg);
        expect(pts.some((p) => p.x >= 35 && p.x < 35 + gap)).toBe(false);
      }
    }
  });
  it("works in source pixels when the mask is at a reduced working size", () => {
    const pts = generateSurfacePoints(hand.truth, 2, { ...DEFAULT_DOT_CONFIG, spacingPx: 8 });
    for (const p of pts) expect(on(hand.truth, p.x / 2, p.y / 2)).toBe(true);
    expect(Math.max(...pts.map((p) => p.x))).toBeGreaterThan(320); // source frame is twice the mask
  });
  it("the edge distance map is about the distance to the nearest background pixel", () => {
    const m = mask(41, 41, (x, y) => x >= 5 && x <= 35 && y >= 5 && y <= 35);
    const d = edgeDistance(m);
    expect(d[20 * 41 + 20]).toBeCloseTo(16, 0); // centre of a 31 px square: 16 px to the outside
    expect(d[5 * 41 + 20]).toBeCloseTo(1, 5);
    expect(d[0]).toBe(0);
  });
});

describe("validation is measured, not cosmetic (synthetic)", () => {
  const m = mask(120, 80, (x, y) => x >= 5 && x < 115 && y >= 5 && y < 75);
  const img = texturedImage(m);
  // paint regions: a flat (out-of-focus-like, no texture) block, a clipped white block, a black block
  const paint = (x0: number, x1: number, v: number | null) => {
    for (let y = 10; y < 70; y++) {
      for (let x = x0; x < x1; x++) {
        const k = (y * img.width + x) * 4;
        const c = v ?? 150;
        img.data[k] = c;
        img.data[k + 1] = v === null ? 120 : c;
        img.data[k + 2] = v === null ? 100 : c;
      }
    }
  };
  paint(15, 35, null); // flat: blurred
  paint(45, 65, 255); // overexposed
  paint(75, 95, 0); // underexposed
  const pts = validatePoints(generateSurfacePoints(m, 1, { ...DEFAULT_DOT_CONFIG, spacingPx: 3 }), img, m, 1);
  const inBox = (p: SurfacePoint, x0: number, x1: number) => p.x >= x0 + 4 && p.x < x1 - 4 && p.y >= 16 && p.y < 64;
  it("rejects flat (blurred), clipped white and clipped black regions with their reasons", () => {
    expect(pts.filter((p) => inBox(p, 15, 35)).every((p) => p.reject === "blurred")).toBe(true);
    expect(pts.filter((p) => inBox(p, 45, 65)).every((p) => p.reject === "overexposed")).toBe(true);
    expect(pts.filter((p) => inBox(p, 75, 95)).every((p) => p.reject === "underexposed")).toBe(true);
  });
  it("rejects points near the mask edge and keeps good textured points", () => {
    expect(pts.filter((p) => p.edgeDistPx < 2).every((p) => p.reject === "near_edge")).toBe(true);
    const good = pts.filter((p) => p.x > 99 && p.x < 110 && p.y > 15 && p.y < 65);
    expect(good.length).toBeGreaterThan(5);
    expect(good.every((p) => p.accepted)).toBe(true);
    for (const p of pts) expect(p.quality >= 0 && p.quality <= 1).toBe(true);
  });
  it("rejects a point that is no longer on the given mask", () => {
    const moved = { ...pts[0], x: 1, y: 1, edgeDistPx: 10 };
    expect(validatePoints([moved], img, m, 1)[0].reject).toBe("outside_mask");
  });
});

describe("duplicates and isolated points are marked, never silently deleted (synthetic)", () => {
  const m = mask(60, 60, (x, y) => x >= 5 && x < 55 && y >= 5 && y < 55);
  const pts = generateSurfacePoints(m, 1, { ...DEFAULT_DOT_CONFIG, spacingPx: 4 }).map((p) => ({ ...p, accepted: true, reject: null }));
  it("marks the second copy of a lattice node as a duplicate", () => {
    const withDup = [...pts, { ...pts[10], id: 9999 }];
    const out = dedupeAndFilter(withDup, { ...DEFAULT_DOT_CONFIG, spacingPx: 4 });
    expect(out).toHaveLength(withDup.length);
    expect(out[out.length - 1].reject).toBe("duplicate");
    expect(out[10].accepted).toBe(true);
  });
  it("marks a lone accepted point as isolated", () => {
    const lone: SurfacePoint = { ...pts[0], id: 5000, gx: 100, gy: 100, x: 402, y: 402 };
    const out = dedupeAndFilter([...pts, lone], { ...DEFAULT_DOT_CONFIG, spacingPx: 4 });
    expect(out[out.length - 1].reject).toBe("isolated");
    expect(out.filter((p) => p.reject === "isolated")).toHaveLength(1);
  });
});

describe("regions from the landmarks: rotation, mirror and handedness invariant (synthetic)", () => {
  const regionsAt = (lm: Pt[], probes: Pt[]) =>
    labelRegions(
      probes.map((p, i) => ({ id: i, x: p.x, y: p.y, gx: 0, gy: 0, region: "unknown", edgeDistPx: 5, quality: 1, accepted: true, reject: null, depth: "none", z: null })),
      lm,
    ).map((p) => p.region);
  for (const rot of [0, 90, 200]) {
    it(`labels finger tips, palm and wrist at ${rot} degrees and mirrored`, () => {
      const h = makeSyntheticHand({ width: 400, height: 400, rotationDeg: rot, wrist: { x: 200, y: 200 } });
      const lm = h.landmarks;
      const palmC = { x: (lm[0].x + lm[5].x + lm[17].x + lm[9].x) / 4, y: (lm[0].y + lm[5].y + lm[17].y + lm[9].y) / 4 };
      const below = { x: lm[0].x - (lm[9].x - lm[0].x) * 0.3, y: lm[0].y - (lm[9].y - lm[0].y) * 0.3 };
      const probes = [lm[4], lm[8], lm[12], lm[16], lm[20], palmC, below];
      const expected = ["thumb", "index", "middle", "ring", "little", "palm", "wrist"];
      expect(regionsAt(lm, probes)).toEqual(expected);
      const mir = (p: Pt) => ({ x: 400 - p.x, y: p.y });
      expect(regionsAt(lm.map(mir), probes.map(mir))).toEqual(expected);
    });
  }
});

describe("depth labels: none by default, estimated only from landmarks, measured only from a real depth map (synthetic)", () => {
  const h = makeSyntheticHand({ width: 200, height: 200, noise: 10 });
  const base = generateSurfacePoints(h.truth, 1, { ...DEFAULT_DOT_CONFIG, spacingPx: 6 });
  const lm3: Pt3[] = h.landmarks.map((p, i) => ({ x: p.x, y: p.y, z: -0.01 * i }));
  it("estimateRelativeDepth labels 'estimated' with z inside the landmarks' z range", () => {
    const est = estimateRelativeDepth(base, lm3);
    expect(est.every((p) => p.depth === "estimated" && p.z !== null && p.z <= 0 && p.z >= -0.2)).toBe(true);
    expect(base.every((p) => p.depth === "none" && p.z === null)).toBe(true); // input untouched
  });
  it("applyMeasuredDepth labels 'measured' only where the map has a valid, confident sample", () => {
    const w = 200,
      hgt = 200;
    const data = new Float32Array(w * hgt).fill(350);
    for (let x = 0; x < w; x++) data[100 * w + x] = 0; // a row of invalid samples
    const confidence = new Uint8Array(w * hgt).fill(255);
    for (let x = 0; x < 50; x++) for (let y = 0; y < hgt; y++) confidence[y * w + x] = 10; // low confidence on the left
    const out = applyMeasuredDepth(estimateRelativeDepth(base, lm3), { width: w, height: hgt, data, confidence });
    for (const p of out) {
      const invalid = Math.floor(p.y) === 100 || p.x < 50;
      expect(p.depth).toBe(invalid ? "estimated" : "measured");
      if (!invalid) expect(p.z).toBe(350);
    }
  });
});

describe("point cloud: coordinates and honest units (synthetic)", () => {
  const h = makeSyntheticHand({ width: 200, height: 200, noise: 12 });
  const set = buildPointSet({ mask: h.truth, scaleToSource: 1, frameWidth: 200, frameHeight: 200, image: h.image, landmarks: h.landmarks });
  it("a 2D set is a flat cloud with no z unit, xy equal to the accepted points", () => {
    const cloud = buildPointCloud(set);
    const acc = set.points.filter((p) => p.accepted);
    expect(cloud.count).toBe(acc.length);
    expect(cloud.units).toEqual({ xy: "px", z: null });
    acc.forEach((p, i) => {
      expect(cloud.positions[i * 3]).toBeCloseTo(p.x, 3);
      expect(cloud.positions[i * 3 + 1]).toBeCloseTo(p.y, 3);
      expect(cloud.positions[i * 3 + 2]).toBe(0);
    });
    expect(cloud.depth.every((d) => d === "none")).toBe(true);
  });
  it("estimated depth gives relative units; any measured depth gives mm and only measured points", () => {
    const est = { ...set, points: estimateRelativeDepth(set.points, h.landmarks.map((p) => ({ ...p, z: 0.01 }))) };
    expect(buildPointCloud(est).units.z).toBe("relative");
    const one = est.points.findIndex((p) => p.accepted);
    const mixed = { ...est, points: est.points.map((p, i) => (i === one ? { ...p, depth: "measured" as const, z: 333 } : p)) };
    const cloud = buildPointCloud(mixed);
    expect(cloud.units.z).toBe("mm");
    expect(cloud.count).toBe(1);
    expect(cloud.positions[2]).toBe(333);
  });
});

describe("lattice mesh: gaps stay open, noise is dropped, completeness is reported (synthetic)", () => {
  it("never makes a triangle across a 3 px gap between fingers", () => {
    const m = twoFingers(3);
    const set = buildPointSet({ mask: m, scaleToSource: 1, frameWidth: 80, frameHeight: 60, config: { spacingPx: 2, edgeMarginPx: 0 } });
    const r = meshFromLattice(set);
    expect(r.triangles).toBeGreaterThan(100);
    const v = r.mesh!.vertices;
    const ix = r.mesh!.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const xs = [ix[t], ix[t + 1], ix[t + 2]].map((k) => v[k * 3]);
      const left = xs.filter((x) => x < 35).length;
      expect(left === 0 || left === 3).toBe(true);
    }
    expect(r.components).toBe(2);
    expect(r.note).toMatch(/NOT a 3D surface/);
  });
  it("drops a tiny separate blob and reports completeness against the mask", () => {
    const m = mask(80, 80, (x, y) => (x >= 5 && x < 60 && y >= 5 && y < 60) || (x >= 70 && x < 75 && y >= 70 && y < 75));
    const set = buildPointSet({ mask: m, scaleToSource: 1, frameWidth: 80, frameHeight: 80, config: { spacingPx: 2, edgeMarginPx: 0 } });
    const r = meshFromLattice(set);
    expect(r.components).toBe(1);
    const xs = Array.from(r.mesh!.vertices).filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs)).toBeLessThan(65);
    expect(r.completeness).toBeGreaterThan(0.8);
    expect(r.completeness).toBeLessThanOrEqual(1);
    expect(Array.from(r.mesh!.vertices).filter((_, i) => i % 3 === 2).every((z) => z === 0)).toBe(true);
  });
});

describe("measurements carry their basis (synthetic)", () => {
  const h = makeSyntheticHand({ width: 300, height: 300, noise: 12 });
  const set = buildPointSet({ mask: h.truth, scaleToSource: 1, frameWidth: 300, frameHeight: 300, image: h.image, landmarks: h.landmarks });
  it("direct in pixels, model in mm with a coin scale, none for what one frame cannot give", () => {
    const m = measureFromPoints(set, h.landmarks, { mmPerPx: 0.3, relUncertainty: 0.02, source: "coin" });
    expect(m.projected_area_px2.basis).toBe("direct");
    expect(m.projected_area_px2.value).toBe(area(h.truth));
    expect(m.projected_area_mm2.basis).toBe("model");
    expect(m.projected_area_mm2.value).toBeCloseTo(area(h.truth) * 0.09, 3);
    expect(m.palm_breadth_px.basis).toBe("direct");
    expect(m.palm_breadth_px.value! / h.palmWidth).toBeGreaterThan(0.9);
    expect(m.palm_breadth_px.value! / h.palmWidth).toBeLessThan(1.6);
    expect(m.hand_length_px.basis).toBe("model");
    expect(m.index_length_mm.basis).toBe("model");
    for (const k of ["thickness_mm", "circumference_mm", "surface_area_3d_mm2"]) {
      expect(m[k].basis).toBe("none");
      expect(m[k].value).toBeNull();
    }
    const n = measureFromPoints(set, h.landmarks, null);
    expect(n.projected_area_mm2.basis).toBe("none");
    expect(n.hand_length_mm.value).toBeNull();
  });
});

describe("export: reproducible numbers, no pixels (synthetic)", () => {
  const h = makeSyntheticHand({ width: 200, height: 200, noise: 12 });
  const make = (seed: number) =>
    buildPointSet({ mask: h.truth, scaleToSource: 1, frameWidth: 200, frameHeight: 200, image: h.image, landmarks: h.landmarks, config: { jitter: 0.3, seed } });
  it("round-trips through JSON and CSV and is byte-identical for the same seed", () => {
    const a = exportPointSet(make(11), { device: "test" });
    const b = exportPointSet(make(11), { device: "test" });
    const c = exportPointSet(make(12), { device: "test" });
    expect(a.json).toBe(b.json);
    expect(a.csv).toBe(b.csv);
    expect(a.json).not.toBe(c.json);
    const doc = JSON.parse(a.json);
    const set = make(11);
    expect(doc.schema).toBe("densescan.pointset/1");
    expect(doc.points).toHaveLength(set.points.length);
    expect(doc.counts).toEqual(set.counts);
    expect(doc.config.seed).toBe(11);
    const lines = a.csv.trim().split("\n");
    expect(lines).toHaveLength(set.points.length + 1);
    const first = lines[1].split(",");
    expect(Number(first[1])).toBeCloseTo(set.points[0].x, 3);
    expect(a.json).not.toMatch(/data:image|base64/);
  });
});

describe("scan sequence (synthetic points)", () => {
  const h = makeSyntheticHand({ width: 300, height: 300, noise: 12 });
  const set = buildPointSet({ mask: h.truth, scaleToSource: 1, frameWidth: 300, frameHeight: 300, image: h.image, landmarks: h.landmarks });
  const ys = set.points.map((p) => p.y);
  const ctx = { points: set.points, frameHeight: 300, sweepMs: 1200 };
  const run = (events: ScanEvent[]) => events.reduce<ScanState>((s, e) => scanReducer(s, e, ctx), initialScanState());
  const start: ScanEvent[] = [{ type: "hand_found" }, { type: "frame_frozen" }, { type: "mask_ready", top: Math.min(...ys), bottom: Math.max(...ys) }];
  it("goes hand -> outline -> sweep -> validate -> capture -> process -> done, revealing real points", () => {
    let s = run(start);
    expect(s.phase).toBe("sweeping");
    let last = s.revealed;
    for (let t = 0; t < 1300; t += 16) {
      s = scanReducer(s, { type: "tick", dtMs: 16 }, ctx);
      expect(s.revealed).toBeGreaterThanOrEqual(last);
      last = s.revealed;
    }
    expect(s.phase).toBe("validating");
    expect(s.revealed).toBe(set.points.length);
    s = scanReducer(s, { type: "validated", accepted: set.counts.accepted }, ctx);
    expect(s.phase).toBe("captured");
    s = scanReducer(scanReducer(s, { type: "process_start" }, ctx), { type: "processed" }, ctx);
    expect(s.phase).toBe("done");
  });
  it("is frame-rate independent", () => {
    let a = run(start),
      b = run(start);
    for (let t = 0; t < 600; t += 10) a = scanReducer(a, { type: "tick", dtMs: 10 }, ctx);
    for (let t = 0; t < 600; t += 30) b = scanReducer(b, { type: "tick", dtMs: 30 }, ctx);
    expect(a.sweepY).toBeCloseTo(b.sweepY, 6);
    expect(a.revealed).toBe(b.revealed);
  });
  it("rejects with a reason when the hand is lost, the outline fails, or too few points pass", () => {
    expect(run([...start, { type: "hand_lost" }]).phase).toBe("rejected");
    const failed = run([{ type: "hand_found" }, { type: "frame_frozen" }, { type: "mask_failed", reason: "fingers_merged" }]);
    expect(failed.phase).toBe("rejected");
    expect(failed.reasons).toEqual(["fingers_merged"]);
    let s = run(start);
    s = scanReducer(s, { type: "tick", dtMs: 5000 }, ctx);
    s = scanReducer(s, { type: "validated", accepted: 10 }, ctx);
    expect(s.phase).toBe("rejected");
    expect(s.reasons[0]).toMatch(/Only 10 points/);
    expect(scanReducer(s, { type: "reset" }, ctx).phase).toBe("waiting_hand");
    expect(run([{ type: "frame_frozen" }]).phase).toBe("waiting_hand"); // no hand seen yet: nothing to freeze
  });
});

describe("performance in Node (NOT a phone)", () => {
  it("generates, validates and filters points for a 640 x 480 hand mask", () => {
    const h = makeSyntheticHand({ width: 640, height: 480, noise: 12 });
    const t0 = performance.now();
    const set = buildPointSet({ mask: h.truth, scaleToSource: 1, frameWidth: 640, frameHeight: 480, image: h.image, landmarks: h.landmarks });
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[densescan perf, Node, not a phone] ${set.counts.generated} points generated, ${set.counts.accepted} accepted in ${ms.toFixed(0)} ms`);
    expect(set.counts.generated).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(10_000);
  });
});
