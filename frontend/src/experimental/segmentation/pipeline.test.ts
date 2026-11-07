// The segmentation pipeline on SYNTHETIC hands (exact ground truth, no OpenCV needed: the pure skin backend).
// These check the mechanics (post-processing, finger gaps, wrist cut, fingertips, gates, orientation independence).
// They say nothing about accuracy on real hands.
import { describe, expect, it } from "vitest";
import type { BinaryMask } from "../common";
import { analyseGaps, cutAtWrist, refineFingertips } from "./fingers";
import { MAX_EDGE_WIDTH_PX } from "./constants";
import { boundaryDistance, iou, maskArea } from "./metrics";
import { gateReasons, seedConsistency, type QualityNumbers } from "./quality";
import { buildSeeds } from "./seeds";
import { segmentHand } from "./segmentHand";
import { blurImage, makeSyntheticHand, paintDisc } from "./synthetic";
import { toWorking } from "./imageops";

const seg = (h: ReturnType<typeof makeSyntheticHand>, carveGaps = true) => segmentHand(h.image, h.landmarks, { backend: "skin", carveGaps, workingSize: 400 });

describe("segmentHand on a clean synthetic hand (pure skin backend)", () => {
  it("recovers the hand with high overlap, a sane contour, area, five fingertips and open finger gaps", async () => {
    const h = makeSyntheticHand();
    const r = await seg(h);
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(iou(r.mask as BinaryMask, h.truth)).toBeGreaterThan(0.93);
    expect(boundaryDistance(r.mask as BinaryMask, h.truth).p95Px).toBeLessThan(3.5);
    expect(r.areaPx).toBeGreaterThan(0.9 * maskArea(h.truth));
    expect(Math.abs(r.areaPolygonPx - r.areaPx) / r.areaPx).toBeLessThan(0.01);
    expect(r.contour.length).toBeGreaterThan(20);
    expect(r.fingertips.every((t) => t !== null)).toBe(true);
    expect(r.gapsPreserved.slice(1)).toEqual([true, true, true]); // between the four fingers
    expect(r.quality?.tipsFound).toBe(5);
  });

  it("returns the mask at the working size with the scale back to the source", async () => {
    const h = makeSyntheticHand({ width: 800, height: 800, palmWidth: 224 });
    const r = await segmentHand(h.image, h.landmarks, { backend: "skin", workingSize: 400 });
    expect(r.mask?.width).toBe(400);
    expect(r.scaleToSource).toBeCloseTo(2, 1);
    // The area is reported in SOURCE pixels, so it matches the source-size truth, not the working-size one.
    expect(Math.abs(r.areaPx - maskArea(h.truth)) / maskArea(h.truth)).toBeLessThan(0.1);
    const xs = r.contour.map((p) => p.x);
    expect(Math.max(...xs)).toBeGreaterThan(400); // contour is in source pixels
  });

  it("is orientation independent: the same hand turned any way round gives the same area and an equally good mask", async () => {
    const areas: number[] = [];
    for (const deg of [0, 37, 90, 180, 250, 315]) {
      const h = makeSyntheticHand({ rotationDeg: deg, wrist: { x: 200, y: 200 }, palmWidth: 70 });
      const r = await seg(h);
      expect(r.ok, `rotation ${deg}: ${r.reasons.join(",")}`).toBe(true);
      expect(iou(r.mask as BinaryMask, h.truth), `rotation ${deg}`).toBeGreaterThan(0.9);
      areas.push(r.areaPx);
    }
    const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
    for (const a of areas) expect(Math.abs(a - mean) / mean).toBeLessThan(0.05);
  });

  it("cuts the forearm at the wrist line and reports the wrist boundary", async () => {
    const h = makeSyntheticHand({ forearm: 2.5 });
    const r = await seg(h);
    const rows = (m: BinaryMask) => {
      let lowest = 0;
      for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.data[y * m.width + x]) lowest = y;
      return lowest;
    };
    expect(rows(r.mask as BinaryMask)).toBeLessThanOrEqual(Math.round(h.landmarks[0].y) + 1); // nothing below the wrist
    expect(r.wristLine).not.toBeNull();
    const [a, b] = r.wristLine as [{ x: number; y: number }, { x: number; y: number }];
    expect(Math.abs(a.y - b.y)).toBeLessThan(3); // perpendicular to an upright forearm
    expect(r.wristWidthPx / h.palmWidth).toBeGreaterThan(0.7);
    expect(r.wristWidthPx / h.palmWidth).toBeLessThan(1.3);
  });
});

describe("quality gates reject, with named reasons", () => {
  it("returns no_hand without landmarks or with fewer than 21", async () => {
    const h = makeSyntheticHand();
    expect((await segmentHand(h.image, null, { backend: "skin" })).reasons).toEqual(["no_hand"]);
    expect((await segmentHand(h.image, h.landmarks.slice(0, 10), { backend: "skin" })).reasons).toEqual(["no_hand"]);
  });

  it("flags fingers held together as merged", async () => {
    const r = await seg(makeSyntheticHand({ spreadDeg: 0, fingerRadius: 0.17 }));
    expect(r.reasons).toContain("fingers_merged");
    expect(r.ok).toBe(false);
    expect(r.gaps.slice(1).every((g) => !g.expected)).toBe(true); // the landmarks do not show a gap either
  });

  it("flags a hand cut off by the frame as incomplete", async () => {
    const h = makeSyntheticHand({ wrist: { x: 200, y: 230 }, palmWidth: 130 }); // the fingers run off the top of the picture
    const r = await seg(h);
    expect(r.reasons).toContain("hand_incomplete");
  });

  it("flags a blurred picture", async () => {
    const h = makeSyntheticHand();
    const blurred = blurImage(h.image, 5, 3);
    const r = await segmentHand(blurred, h.landmarks, { backend: "skin", workingSize: 400 });
    expect(r.quality?.edgeWidthPx ?? 0).toBeGreaterThan(MAX_EDGE_WIDTH_PX);
    expect(r.reasons).toContain("hand_blurred");
    const sharp = await seg(h);
    expect(sharp.quality?.edgeWidthPx ?? 99).toBeLessThan(MAX_EDGE_WIDTH_PX);
  });

  it("flags something covering the palm as occluded (the seeds there are not skin-coloured)", async () => {
    const h = makeSyntheticHand();
    const covered = paintDisc(h.image, h.landmarks[9], 0.42 * h.palmWidth, [30, 90, 200]);
    const r = await segmentHand(covered, h.landmarks, { backend: "skin", workingSize: 400 });
    expect(r.quality?.seedConsistency ?? 1).toBeLessThan(0.8);
    expect(r.reasons).toContain("hand_occluded");
  });

  it("rejects a hand on a skin-coloured background instead of returning a plausible-looking blob", async () => {
    const h = makeSyntheticHand({ background: [196, 146, 118], skin: [201, 150, 120], noise: 6 });
    const r = await seg(h);
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("a plain-background hand of a dark skin tone still passes", async () => {
    const r = await seg(makeSyntheticHand({ skin: [92, 62, 48], background: [225, 228, 230] }));
    expect(r.reasons).toEqual([]);
  });

  it("gateReasons maps measured numbers to reasons with the documented thresholds", () => {
    const good: QualityNumbers = {
      edgeWidthPx: 2.5,
      edgeValidShare: 0.8,
      bandLaplacianVariance: 100,
      landmarksInsideShare: 1,
      areaRatio: 1.3,
      edgeTouchPixels: 0,
      tipsFound: 5,
      seedCoverage: 1,
      seedConsistency: 1,
      strayShare: 0,
    };
    const gap = (pair: 0 | 1 | 2 | 3, preserved: boolean) => ({ pair, names: ["a", "b"] as [string, string], expected: true, separation: 0.6, backgroundShare: preserved ? 1 : 0, preserved, carvedPixels: 0 });
    const open = [gap(0, true), gap(1, true), gap(2, true), gap(3, true)];
    expect(gateReasons(good, open)).toEqual([]);
    expect(gateReasons({ ...good, tipsFound: 4 }, open)).toEqual(["hand_incomplete"]);
    expect(gateReasons({ ...good, edgeTouchPixels: 12 }, open)).toEqual(["hand_incomplete"]);
    expect(gateReasons({ ...good, edgeWidthPx: 9 }, open)).toEqual(["hand_blurred"]);
    expect(gateReasons({ ...good, edgeWidthPx: 9, edgeValidShare: 0.1 }, open)).toEqual([]); // too little contrast to judge
    expect(gateReasons({ ...good, landmarksInsideShare: 0.6 }, open)).toEqual(["hand_occluded"]);
    expect(gateReasons({ ...good, seedConsistency: 0.5 }, open)).toEqual(["hand_occluded"]);
    expect(gateReasons(good, [gap(0, false), gap(1, true), gap(2, true), gap(3, true)])).toEqual([]); // thumb gap alone is not gated
    expect(gateReasons(good, [gap(0, true), gap(1, true), gap(2, false), gap(3, true)])).toEqual(["fingers_merged"]);
    expect(gateReasons({ ...good, areaRatio: 3.1 }, open)).toEqual(["mask_implausible"]);
    expect(gateReasons({ ...good, areaRatio: 0.5 }, open)).toEqual(["mask_implausible"]);
    expect(gateReasons({ ...good, strayShare: 0.4 }, open)).toEqual(["mask_implausible"]);
  });
});

describe("finger gaps, fingertips and the wrist cut on known masks", () => {
  it("restores a gap that a mask merged, using the landmarks, and only where fingers are spread", () => {
    const h = makeSyntheticHand({ spreadDeg: 16 });
    const w = h.truth.width;
    const merged = new Uint8Array(h.truth.data);
    // Bridge the middle and ring fingers with skin from their knuckles to beyond their tips.
    const a = h.landmarks[10];
    const b = h.landmarks[14];
    const tipA = h.landmarks[12];
    const tipB = h.landmarks[16];
    for (let y = Math.floor(Math.min(tipA.y, tipB.y) - 6); y <= Math.ceil(Math.max(a.y, b.y)); y++) {
      for (let x = Math.floor(Math.min(a.x, tipA.x)); x <= Math.ceil(Math.max(b.x, tipB.x)); x++) merged[y * w + x] = 255;
    }
    const before = analyseGaps(merged, w, h.truth.height, h.landmarks, false);
    expect(before.gaps[2].expected).toBe(true);
    expect(before.gaps[2].preserved).toBe(false);
    const after = analyseGaps(merged, w, h.truth.height, h.landmarks, true);
    expect(after.gaps[2].preserved).toBe(true);
    expect(after.gaps[2].carvedPixels).toBeGreaterThan(0);
    expect(after.gaps[1].carvedPixels).toBe(0); // other gaps were fine and are left alone
    // The carve only removes a thin line: the fingers keep nearly all their area.
    expect(maskArea({ width: w, height: h.truth.height, data: after.mask })).toBeGreaterThan(0.9 * maskArea({ width: w, height: h.truth.height, data: merged }));
  });

  it("never carves between fingers the landmarks show together", () => {
    const h = makeSyntheticHand({ spreadDeg: 0, fingerRadius: 0.17 });
    const out = analyseGaps(h.truth.data, h.truth.width, h.truth.height, h.landmarks, true);
    expect(out.gaps.every((g) => g.carvedPixels === 0)).toBe(true);
    expect(out.gaps.slice(1).every((g) => !g.expected)).toBe(true);
  });

  it("refines fingertips to the end of the mask along each finger, near the landmark tips", () => {
    const h = makeSyntheticHand();
    const tips = refineFingertips(h.truth.data, h.truth.width, h.truth.height, h.landmarks);
    expect(tips.every((t) => t.point !== null)).toBe(true);
    for (const t of tips) expect(t.offset).toBeLessThan(0.2); // the capsule cap lies ~0.115 palm widths beyond the landmark
  });

  it("finds no fingertip when the mask is empty or the finger is missing", () => {
    const h = makeSyntheticHand();
    const empty = new Uint8Array(h.truth.data.length);
    expect(refineFingertips(empty, h.truth.width, h.truth.height, h.landmarks).every((t) => t.point === null)).toBe(true);
    const noPinky = new Uint8Array(h.truth.data);
    const p = h.landmarks[17];
    const tip = h.landmarks[20];
    for (let y = 0; y < h.truth.height; y++) for (let x = 0; x < h.truth.width; x++) if (Math.hypot(x - tip.x, y - tip.y) < 0.2 * h.palmWidth || (x > p.x - 4 && y < p.y - 0.15 * h.palmWidth && x > h.landmarks[13].x + 0.2 * h.palmWidth)) noPinky[y * h.truth.width + x] = 0;
    const tips = refineFingertips(noPinky, h.truth.width, h.truth.height, h.landmarks);
    expect(tips[4].point === null || tips[4].offset > 0.1).toBe(true);
  });

  it("the wrist cut works for a rotated hand and reports its two ends", () => {
    const h = makeSyntheticHand({ rotationDeg: 60, wrist: { x: 200, y: 220 }, palmWidth: 90 });
    const cut = cutAtWrist(h.withForearm.data, 400, 400, h.landmarks);
    expect(cut.removedPixels).toBeGreaterThan(1000);
    expect(Math.abs(maskArea({ width: 400, height: 400, data: cut.mask }) - maskArea(h.truth)) / maskArea(h.truth)).toBeLessThan(0.02);
    expect(cut.line).not.toBeNull();
    expect(cut.widthPx).toBeGreaterThan(0.7 * h.palmWidth);
  });
});

describe("seeds and helpers", () => {
  it("the seeds mark the hand's core as sure hand and keep the corners as background, never the whole hull as the mask", () => {
    const h = makeSyntheticHand();
    const s = buildSeeds(h.landmarks, 400, 400);
    expect(s.labels[h.landmarks[9].y * 400 | 0 ? Math.round(h.landmarks[9].y) * 400 + Math.round(h.landmarks[9].x) : 0]).toBe(1);
    expect(s.labels[0]).toBe(0); // the corner
    expect(maskArea({ width: 400, height: 400, data: s.sureFg })).toBeLessThan(maskArea(h.truth)); // seeds are inside the hand, not the hand
    expect(s.hullArea).toBeGreaterThan(0);
  });

  it("seed consistency is high for uniform skin and low when an occluder covers a part", () => {
    const h = makeSyntheticHand();
    const s = buildSeeds(h.landmarks, 400, 400);
    expect(seedConsistency(h.image, s.sureFg)).toBeGreaterThan(0.95);
    expect(seedConsistency(paintDisc(h.image, h.landmarks[9], 0.5 * h.palmWidth, [20, 80, 210]), s.sureFg)).toBeLessThan(0.8);
  });

  it("downscaling keeps the aspect, never enlarges and reports the exact scale", () => {
    const h = makeSyntheticHand({ width: 1000, height: 500, wrist: { x: 500, y: 380 }, palmWidth: 140 });
    const { image, scale } = toWorking(h.image, 250);
    expect(image.width).toBe(250);
    expect(image.height).toBe(125);
    expect(scale).toBeCloseTo(0.25, 6);
    expect(toWorking(h.image, 4000).scale).toBe(1);
  });
});
