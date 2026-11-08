// analyseHand on SYNTHETIC hands (exact mask and part truth from the generator). Mechanics only: part labels, fingertips,
// widths, gaps, confidence, boundary metrics, gates. Nothing here is accuracy on real hands.
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { initOpenCV, type CV } from "../../vision/opencv";
import type { BinaryMask, Pt } from "../common";
import { analyseHand, type HandAnalysis } from "./analyse";
import { compareToTruth } from "./boundary";
import { fitColourGmm, pixelConfidence } from "./confidence";
import { fillPolygon } from "./geometry";
import type { ImageLike } from "./imageops";
import { dilate } from "./morph";
import { PART, PART_NAMES, labelParts, measureFingers } from "./parts";
import { blurImage, makeSyntheticHand, paintDisc } from "./synthetic";

const W = { workingSize: 400 };
const skin = (img: ImageLike, lm: Pt[]) => analyseHand(img, lm, { backend: "skin", ...W });
const codes = (a: HandAnalysis) => [...new Set(a.gates.reasons.map((r) => r.code))];
const truthCompare = (a: HandAnalysis, h: ReturnType<typeof makeSyntheticHand>) =>
  compareToTruth({ mask: a.mask as BinaryMask, labels: a.labels as Uint8Array, gaps: a.gaps }, h.truth, h.landmarks, { truthParts: h.parts });

function paintPolygon(img: ImageLike, poly: Pt[], colour: [number, number, number]): ImageLike {
  const m = new Uint8Array(img.width * img.height);
  fillPolygon(m, img.width, img.height, poly, 255);
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < m.length; i++) if (m[i]) ((data[4 * i] = colour[0]), (data[4 * i + 1] = colour[1]), (data[4 * i + 2] = colour[2]));
  return { width: img.width, height: img.height, data };
}
/** A bar of `halfLen` across the bone a-b at fraction t, `halfTh` thick along it. */
function bar(a: Pt, b: Pt, t: number, halfLen: number, halfTh: number): Pt[] {
  const c = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  const d = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  const n = { x: -d.y, y: d.x };
  return [
    { x: c.x + n.x * halfLen + d.x * halfTh, y: c.y + n.y * halfLen + d.y * halfTh },
    { x: c.x - n.x * halfLen + d.x * halfTh, y: c.y - n.y * halfLen + d.y * halfTh },
    { x: c.x - n.x * halfLen - d.x * halfTh, y: c.y - n.y * halfLen - d.y * halfTh },
    { x: c.x + n.x * halfLen - d.x * halfTh, y: c.y + n.y * halfLen - d.y * halfTh },
  ];
}

describe("part labels (synthetic hand, generator part truth)", () => {
  it("labels palm, wrist, thumb and four fingers close to the generator's parts, for any orientation", async () => {
    for (const deg of [0, 90, 200]) {
      const h = makeSyntheticHand({ rotationDeg: deg, wrist: { x: 200, y: 200 }, palmWidth: 80, spreadDeg: 16 });
      const a = await skin(h.image, h.landmarks);
      const c = truthCompare(a, h);
      expect(c.partTruth).toBe("generator");
      for (const p of ["thumb", "index", "middle", "ring", "little"] as const) expect(c.perPartIoU[p], `${deg} ${p}`).toBeGreaterThan(0.85);
      expect(c.perPartIoU.palm, `${deg} palm`).toBeGreaterThan(0.85);
      expect(c.perPartIoU.wrist, `${deg} wrist`).toBeGreaterThan(0.7);
      expect(a.parts.unlabelledPixels).toBe(0);
    }
  });

  it("every hand pixel gets exactly one part and a finger's label is one connected piece (geodesic: no jumps across a gap)", () => {
    const h = makeSyntheticHand({ spreadDeg: 18 });
    const { labels, counts, unlabelledPixels } = labelParts(h.truth.data, 400, 400, h.landmarks);
    const handPixels = h.truth.data.reduce((s, v) => s + (v ? 1 : 0), 0);
    expect(counts.reduce((s, v) => s + v, 0) + unlabelledPixels).toBe(handPixels);
    for (let i = 0; i < labels.length; i++) if (!h.truth.data[i]) expect(labels[i]).toBe(0);
    const fingers = measureFingers(labels, h.truth.data, 400, 400, h.landmarks, 1);
    for (const f of fingers) {
      // The outline of the largest piece encloses (almost) the whole finger area: one piece.
      let area = 0;
      for (let i = 0, n = f.outline.length; i < n; i++) area += f.outline[i].x * f.outline[(i + 1) % n].y - f.outline[(i + 1) % n].x * f.outline[i].y;
      expect(Math.abs(area) / 2 / f.areaPx, f.finger).toBeGreaterThan(0.97);
    }
  });

  it("a pixel is never labelled with a finger it can only reach across background (geodesic, not straight-line, distance)", () => {
    // Move the middle finger's PIP and DIP landmarks into the background gap, just beside the index finger. An index
    // pixel on the edge facing that gap is then closer in a straight line to the middle finger's skeleton than to its
    // own, but inside the mask it can only be reached through the index finger: it must stay "index".
    const h = makeSyntheticHand({ spreadDeg: 22, palmWidth: 112 });
    const lm = h.landmarks.map((p) => ({ ...p }));
    const fr = 0.115 * h.palmWidth;
    const towards = (t: number) => {
      const a = { x: lm[5].x + (lm[8].x - lm[5].x) * t, y: lm[5].y + (lm[8].y - lm[5].y) * t };
      const b = { x: lm[9].x + (lm[12].x - lm[9].x) * t, y: lm[9].y + (lm[12].y - lm[9].y) * t };
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      return { a, n: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } };
    };
    for (const [idx, t] of [[10, 0.45], [11, 0.75]] as const) {
      const { a, n } = towards(t);
      lm[idx] = { x: a.x + n.x * (fr + 4), y: a.y + n.y * (fr + 4) };
    }
    const { a, n } = towards(0.62);
    const p = { x: a.x + n.x * (fr - 1.5), y: a.y + n.y * (fr - 1.5) };
    expect(h.truth.data[Math.floor(p.y) * 400 + Math.floor(p.x)]).toBe(255); // the probe is on the index finger
    const { labels } = labelParts(h.truth.data, 400, 400, lm);
    expect(labels[Math.floor(p.y) * 400 + Math.floor(p.x)]).toBe(PART.index);
  });

  it("the fingertip is the mask's farthest point along the finger, beyond the landmark tip by about the finger radius", async () => {
    const h = makeSyntheticHand({ spreadDeg: 14 });
    const a = await skin(h.image, h.landmarks);
    const fr = 0.115 * h.palmWidth;
    a.parts.fingers.slice(1).forEach((f, i) => {
      const tipLm = h.landmarks[[8, 12, 16, 20][i]];
      expect(f.tip, f.finger).not.toBeNull();
      const d = Math.hypot((f.tip as Pt).x - tipLm.x, (f.tip as Pt).y - tipLm.y);
      expect(d, f.finger).toBeGreaterThan(fr - 2.5);
      expect(d, f.finger).toBeLessThan(fr + 2);
      expect(f.lengthRatio, f.finger).toBeGreaterThan(1.02);
    });
  });

  it("measures the finger width along the axis (the generator's capsules are 2 x 0.115 palm widths wide)", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16 });
    const a = await skin(h.image, h.landmarks);
    for (const f of a.parts.fingers.slice(1)) {
      expect(f.medianWidthPx, f.finger).not.toBeNull();
      expect(Math.abs((f.medianWidthPx as number) - 2 * 0.115 * h.palmWidth), f.finger).toBeLessThan(2);
      expect(f.widths.map((w) => w.at)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
      expect(f.neck?.ratio, f.finger).toBeGreaterThan(0.8);
      expect(f.colourBreak?.share ?? 0, f.finger).toBeLessThan(0.2);
    }
  });
});

describe("finger gaps", () => {
  it("spread fingers: four open gaps, none merged, with a valley point and widths growing towards the tips", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16 });
    const a = await skin(h.image, h.landmarks);
    expect(a.gaps.map((g) => g.status)).toEqual(["open", "open", "open", "open"]);
    expect(a.gaps.some((g) => g.merged)).toBe(false);
    for (const g of a.gaps.slice(1)) {
      expect(g.valley).not.toBeNull();
      expect(g.depthRatio).toBeGreaterThan(0.6);
      const ws = g.widths.filter((w) => w.widthPx !== null).map((w) => w.widthPx as number);
      expect(ws.length).toBeGreaterThanOrEqual(3);
      expect(ws[ws.length - 1]).toBeGreaterThan(ws[0]);
    }
    expect((a.gapMap as Uint8Array).some((v) => v >= 1 && v <= 4)).toBe(true);
  });

  it("fingers held together (the landmarks agree): gaps closed but not 'merged', and widths end at label borders", async () => {
    const h = makeSyntheticHand({ spreadDeg: 0, fingerRadius: 0.17 });
    const a = await skin(h.image, h.landmarks);
    for (const g of a.gaps.slice(1)) {
      expect(g.status).not.toBe("open");
      expect(g.expected).toBe(false);
      expect(g.merged).toBe(false);
    }
    expect(codes(a)).not.toContain("fingers_merged");
    const mid = a.parts.fingers[2].widths[4];
    expect(mid.edges).toEqual(["part", "part"]);
  });

  it("a skin-coloured bridge between spread fingers is flagged as merged, naming the pair", async () => {
    const h = makeSyntheticHand({ spreadDeg: 18, background: [60, 90, 160], noise: 10 });
    const lm = h.landmarks;
    const img = paintPolygon(h.image, [lm[10], lm[14], lm[15], lm[11]], [201, 150, 120]);
    const a = await skin(img, lm);
    expect(codes(a)).toContain("fingers_merged");
    expect(a.gates.reasons.find((r) => r.code === "fingers_merged")?.message).toMatch(/middle and ring/);
    expect(a.gaps[2].merged).toBe(true);
  });
});

describe("gates with reasons", () => {
  it("a clean synthetic hand passes every gate", async () => {
    const h = makeSyntheticHand({ spreadDeg: 14, background: [40, 80, 170], noise: 12 });
    const a = await skin(h.image, h.landmarks);
    expect(a.gates.reasons).toEqual([]);
    expect(a.ok).toBe(true);
  });

  it("a background-coloured bar across a finger is 'occluded', naming the finger", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16 });
    const lm = h.landmarks;
    const img = paintPolygon(h.image, bar(lm[10], lm[11], 0.5, 0.2 * h.palmWidth, 0.06 * h.palmWidth), [235, 235, 238]);
    const a = await skin(img, lm);
    const occ = a.gates.reasons.filter((r) => r.code === "occluded");
    expect(occ.length).toBeGreaterThan(0);
    expect(occ.some((r) => r.part === "middle")).toBe(true);
  });

  it("an object-coloured bar across a finger is 'occluded' too", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16 });
    const lm = h.landmarks;
    const img = paintPolygon(h.image, bar(lm[14], lm[15], 0.5, 0.2 * h.palmWidth, 0.06 * h.palmWidth), [40, 60, 170]);
    const a = await skin(img, lm);
    expect(a.gates.reasons.some((r) => r.code === "occluded" && r.part === "ring")).toBe(true);
  });

  it("a finger painted out of the picture (landmarks still there) is reported missing / occluded", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16 });
    const lm = h.landmarks;
    const img = paintPolygon(h.image, bar(lm[13], lm[16], 0.55, 0.16 * h.palmWidth, 0.5 * h.palmWidth), [235, 235, 238]);
    const a = await skin(img, lm);
    expect(a.gates.reasons.some((r) => r.code === "occluded" && r.part === "ring")).toBe(true);
    expect(a.ok).toBe(false);
  });

  it("a hand cut by the image border is 'incomplete', naming the fingers whose tips left the frame", async () => {
    const h = makeSyntheticHand({ wrist: { x: 200, y: 215 }, palmWidth: 110 });
    const a = await skin(h.image, h.landmarks);
    expect(codes(a)).toContain("incomplete");
    expect(a.gates.reasons.some((r) => r.code === "incomplete" && r.part === "middle")).toBe(true);
  });

  it("a blurred picture is 'blurred'", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16 });
    const a = await skin(blurImage(h.image, 5, 3), h.landmarks);
    expect(codes(a)).toContain("blurred");
  });

  it("a mask far larger than the hand is 'implausible' and gets low confidence along its boundary", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16, background: [40, 80, 170], noise: 12, wrist: { x: 200, y: 260 }, palmWidth: 70 });
    const grown: BinaryMask = { width: 400, height: 400, data: dilate(h.truth.data, 400, 400, 0.5 * h.palmWidth) };
    const a = await analyseHand(h.image, h.landmarks, { backend: "external", externalMask: grown, ...W });
    expect(codes(a)).toContain("implausible");
    expect(codes(a)).toContain("low_confidence");
  });

  it("no landmarks: no_hand; a missing external mask: segmentation_failed with the message", async () => {
    const h = makeSyntheticHand();
    expect(codes(await skin(h.image, h.landmarks.slice(0, 5)))).toEqual(["no_hand"]);
    const a = await analyseHand(h.image, h.landmarks, { backend: "external" });
    expect(codes(a)).toEqual(["segmentation_failed"]);
    expect(a.gates.reasons[0].message).toMatch(/externalMask/);
  });
});

describe("confidence and boundary metrics", () => {
  it("confidence lies in 0..1, is high in the interior and lower in the band around the boundary", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16, background: [40, 80, 170], noise: 12 });
    const a = await skin(h.image, h.landmarks);
    const c = a.confidence!;
    let lo = 1;
    let hi = 0;
    for (const v of c.map) ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)));
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(c.summary.colourModel).toBe("fitted");
    expect(c.summary.meanHand).toBeGreaterThan(0.85);
    expect(c.summary.meanBoundaryBand).toBeGreaterThan(0.6);
    expect(c.summary.meanBoundaryBand).toBeLessThan(c.summary.meanHand);
    for (const p of PART_NAMES.slice(1)) expect(c.summary.perPart[p], p).not.toBeNull();
  });

  it("low contrast between hand and background lowers the boundary confidence", () => {
    const strong = makeSyntheticHand({ background: [40, 80, 170], noise: 8 });
    const weak = makeSyntheticHand({ background: [190, 150, 128], noise: 8 });
    const cs = pixelConfidence(strong.image, strong.truth.data, strong.palmWidth).summary;
    const cw = pixelConfidence(weak.image, weak.truth.data, weak.palmWidth).summary;
    expect(cw.meanBoundaryBand).toBeLessThan(cs.meanBoundaryBand - 0.15);
    expect(cw.edgeSupportBoundary).toBeLessThan(cs.edgeSupportBoundary);
  });

  it("fits a colour mixture whose weights sum to 1 and whose means sit on the data", () => {
    const s = new Float32Array(3 * 200);
    for (let i = 0; i < 200; i++) s.set(i < 100 ? [200, 150, 120] : [40, 80, 170], 3 * i);
    const g = fitColourGmm(s, 2);
    expect(g[0] + g[1]).toBeCloseTo(1, 6);
    const means = [[g[2], g[3], g[4]], [g[5], g[6], g[7]]].sort((p, q) => p[0] - q[0]);
    expect(means[0]).toEqual([40, 80, 170]);
    expect(means[1]).toEqual([200, 150, 120]);
  });

  it("a mask on the true edge agrees with the image gradient; a mask grown by 3 px does not", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16, background: [40, 80, 170], noise: 6 });
    const good = await analyseHand(h.image, h.landmarks, { backend: "external", externalMask: h.truth, ...W });
    const grown: BinaryMask = { width: 400, height: 400, data: dilate(h.truth.data, 400, 400, 3) };
    const bad = await analyseHand(h.image, h.landmarks, { backend: "external", externalMask: grown, ...W });
    expect(good.boundaryMetrics!.gradientAgreementShare).toBeGreaterThan(0.85);
    expect(bad.boundaryMetrics!.gradientAgreementShare).toBeLessThan(0.3);
    expect(good.boundaryMetrics!.fingertipsConsistent).toBe(true);
    expect(good.boundaryMetrics!.roughnessWorkPx).toBeLessThan(0.6);
    expect(good.boundaryMetrics!.greyContrastMedian).toBeGreaterThan(40);
  });

  it("compared with its own truth: IoU 1, per-part IoU 1 and gap recall 1", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16 });
    const a = await analyseHand(h.image, h.landmarks, { backend: "external", externalMask: h.truth, ...W });
    const c = compareToTruth({ mask: a.mask as BinaryMask, labels: a.labels as Uint8Array, gaps: a.gaps }, h.truth, h.landmarks);
    expect(c.partTruth).toBe("labeller-on-truth-mask");
    expect(c.iou).toBeGreaterThan(0.99);
    for (const p of PART_NAMES.slice(1)) expect(c.perPartIoU[p], p).toBeGreaterThan(0.98);
    expect(c.gapRecall).toBe(1);
    expect(c.gapPrecision).toBe(1);
  });
});

describe("GrabCut path (Node, OpenCV.js)", () => {
  let cv: CV;
  beforeAll(async () => {
    cv = await initOpenCV(createRequire(import.meta.url)("@techstark/opencv-js"));
  }, 60_000);

  it("analyses a synthetic hand with GrabCut's own colour models and passes the gates", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16, background: [40, 80, 170], noise: 18, seed: 5 });
    const a = await analyseHand(h.image, h.landmarks, { backend: "grabcut", cv, ...W });
    expect(a.gates.reasons).toEqual([]);
    expect(a.confidence?.summary.colourModel).toBe("grabcut");
    expect(a.segmentation.colourModel?.fg.length).toBe(65);
    const c = truthCompare(a, h);
    for (const p of ["thumb", "index", "middle", "ring", "little"] as const) expect(c.perPartIoU[p], p).toBeGreaterThan(0.85);
    expect(c.gapRecall).toBe(1);
    for (const k of ["segment", "parts", "gaps", "confidence", "boundary", "gates", "total"]) expect(a.timings[k], k).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("leaves the mask uncarved by default (the boundary is the segmenter's), carving only on request", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16, background: [40, 80, 170], noise: 18, seed: 5 });
    const a = await analyseHand(h.image, h.landmarks, { backend: "grabcut", cv, ...W });
    expect(a.segmentation.gaps.every((g) => g.carvedPixels === 0)).toBe(true);
  }, 60_000);

  it("an occluder painted over the palm and a finger is rejected with a named reason", async () => {
    const h = makeSyntheticHand({ spreadDeg: 16, background: [40, 80, 170], noise: 18, seed: 5 });
    const img = paintDisc(h.image, h.landmarks[10], 0.3 * h.palmWidth, [235, 235, 238]);
    const a = await analyseHand(img, h.landmarks, { backend: "grabcut", cv, ...W });
    expect(a.ok).toBe(false);
    expect(codes(a)).toContain("occluded");
  }, 60_000);
});
