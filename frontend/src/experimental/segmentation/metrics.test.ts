import { describe, expect, it } from "vitest";
import type { BinaryMask, Pt } from "../common";
import { convexHull, fillPolygon, palmWidth, pointInPolygon, polygonArea } from "./geometry";
import { boundaryDistance, boundaryPixels, contourArea, dice, iou, maskArea, maskToContour, polygonToMask, resizeMaskNearest, simplifyPolygon } from "./metrics";
import { components, countOn, dilate, distanceTo, erode, fillSmallHoles, keepMainComponent, majority3 } from "./morph";

const blank = (w: number, h: number): BinaryMask => ({ width: w, height: h, data: new Uint8Array(w * h) });
function rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): BinaryMask {
  const m = blank(w, h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m.data[y * w + x] = 255;
  return m;
}

describe("overlap metrics", () => {
  it("IoU and Dice of identical masks are 1, of disjoint masks 0, and of an empty pair 1", () => {
    const a = rect(20, 20, 2, 2, 10, 10);
    expect(iou(a, a)).toBe(1);
    expect(dice(a, a)).toBe(1);
    expect(iou(a, rect(20, 20, 12, 12, 18, 18))).toBe(0);
    expect(dice(a, rect(20, 20, 12, 12, 18, 18))).toBe(0);
    expect(iou(blank(5, 5), blank(5, 5))).toBe(1);
    expect(dice(blank(5, 5), blank(5, 5))).toBe(1);
  });

  it("matches hand-computed values on overlapping rectangles", () => {
    const a = rect(20, 20, 0, 0, 10, 10); // 100
    const b = rect(20, 20, 5, 0, 15, 10); // 100, overlap 50
    expect(iou(a, b)).toBeCloseTo(50 / 150, 10);
    expect(dice(a, b)).toBeCloseTo(100 / 200, 10);
    expect(maskArea(a)).toBe(100);
  });

  it("refuses masks of different sizes", () => {
    expect(() => iou(blank(4, 4), blank(5, 5))).toThrow(/sizes differ/);
  });
});

describe("contour tracing", () => {
  it("traces a rectangle with exactly four corners and the exact area", () => {
    const m = rect(30, 30, 5, 7, 20, 18); // 15 x 11
    const c = maskToContour(m);
    expect(c).toHaveLength(4);
    expect(contourArea(c)).toBe(15 * 11);
  });

  it("the traced polygon area equals the pixel count for an L shape and a disc", () => {
    const l = rect(30, 30, 2, 2, 12, 20);
    for (let y = 14; y < 20; y++) for (let x = 12; x < 25; x++) l.data[y * 30 + x] = 255;
    expect(contourArea(maskToContour(l))).toBe(maskArea(l));
    const disc = blank(40, 40);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if ((x - 20) ** 2 + (y - 20) ** 2 <= 144) disc.data[y * 40 + x] = 255;
    expect(contourArea(maskToContour(disc))).toBe(maskArea(disc));
  });

  it("returns [] for an empty mask and a single pixel as a unit square", () => {
    expect(maskToContour(blank(4, 4))).toEqual([]);
    const one = blank(4, 4);
    one.data[1 * 4 + 2] = 255;
    expect(contourArea(maskToContour(one))).toBe(1);
  });

  it("a mask touching the image border is traced to the border", () => {
    const m = rect(10, 10, 0, 0, 10, 4);
    expect(contourArea(maskToContour(m))).toBe(40);
  });

  it("polygonToMask is the inverse of the trace (round trip keeps the mask)", () => {
    const m = rect(40, 40, 8, 5, 30, 33);
    for (let y = 10; y < 14; y++) for (let x = 30; x < 37; x++) m.data[y * 40 + x] = 255;
    const back = polygonToMask(maskToContour(m), 40, 40);
    expect(iou(m, back)).toBe(1);
  });

  it("simplification keeps the area within a pixel-scale tolerance and drops collinear points", () => {
    const disc = blank(80, 80);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) if ((x - 40) ** 2 + (y - 40) ** 2 <= 900) disc.data[y * 80 + x] = 255;
    const raw = maskToContour(disc);
    const simple = simplifyPolygon(raw, 0.8);
    expect(simple.length).toBeLessThan(raw.length);
    expect(Math.abs(contourArea(simple) - contourArea(raw)) / contourArea(raw)).toBeLessThan(0.01);
  });
});

describe("boundary distance", () => {
  it("is zero for identical masks and one pixel for masks shifted by one pixel", () => {
    const a = rect(40, 40, 10, 10, 30, 30);
    expect(boundaryDistance(a, a)).toEqual({ meanPx: 0, p95Px: 0, maxPx: 0 });
    const b = rect(40, 40, 11, 10, 31, 30);
    const d = boundaryDistance(a, b);
    expect(d.maxPx).toBeLessThanOrEqual(1.5);
    expect(d.meanPx).toBeGreaterThan(0);
    expect(d.meanPx).toBeLessThan(0.6);
  });

  it("grows with the offset and is symmetric", () => {
    const a = rect(60, 60, 10, 10, 30, 30);
    const b = rect(60, 60, 15, 10, 35, 30);
    const ab = boundaryDistance(a, b);
    const ba = boundaryDistance(b, a);
    expect(ab.meanPx).toBeCloseTo(ba.meanPx, 10);
    expect(ab.maxPx).toBeGreaterThan(boundaryDistance(a, rect(60, 60, 12, 10, 32, 30)).maxPx);
    expect(ab.p95Px).toBeGreaterThanOrEqual(ab.meanPx);
  });

  it("is infinite when only one mask is empty", () => {
    expect(boundaryDistance(rect(10, 10, 2, 2, 5, 5), blank(10, 10)).meanPx).toBe(Infinity);
    expect(boundaryDistance(blank(10, 10), blank(10, 10)).meanPx).toBe(0);
  });

  it("boundary pixels of a filled square are its ring", () => {
    const ring = boundaryPixels(rect(20, 20, 5, 5, 15, 15));
    expect(countOn(ring)).toBe(10 * 10 - 8 * 8);
  });

  it("nearest-neighbour resize keeps a rectangle's proportions", () => {
    const m = rect(40, 40, 10, 10, 30, 30);
    const half = resizeMaskNearest(m, 20, 20);
    expect(maskArea(half)).toBe(100);
  });
});

describe("morphology", () => {
  it("the distance transform is exact on a single pixel", () => {
    const m = blank(11, 11);
    m.data[5 * 11 + 5] = 255;
    const d = distanceTo(m.data, 11, 11, 255);
    expect(d[5 * 11 + 5]).toBe(0);
    expect(d[5 * 11 + 8]).toBeCloseTo(3, 6);
    expect(d[8 * 11 + 9]).toBeCloseTo(5, 6);
  });

  it("dilation then erosion by the same radius never loses a rectangle, and erosion removes thin spurs", () => {
    const m = rect(40, 40, 10, 10, 30, 30);
    for (let x = 30; x < 38; x++) m.data[20 * 40 + x] = 255; // a one-pixel spur
    const eroded = erode(m.data, 40, 40, 2);
    expect(eroded[20 * 40 + 35]).toBe(0);
    expect(eroded[20 * 40 + 20]).toBe(255);
    const grown = dilate(rect(40, 40, 15, 15, 25, 25).data, 40, 40, 3);
    expect(countOn(grown)).toBeGreaterThan(100);
    expect(grown[20 * 40 + 27]).toBe(255);
    expect(grown[20 * 40 + 29]).toBe(0);
  });

  it("keeps the main component (largest, or the one holding the seeds) and reports the stray share", () => {
    const m = rect(40, 40, 2, 2, 20, 20);
    for (let y = 30; y < 34; y++) for (let x = 30; x < 34; x++) m.data[y * 40 + x] = 255;
    const { mask, strayShare } = keepMainComponent(m.data, 40, 40);
    expect(countOn(mask)).toBe(18 * 18);
    expect(strayShare).toBeCloseTo(16 / (324 + 16), 6);
    const seed = new Uint8Array(40 * 40);
    seed[31 * 40 + 31] = 255;
    expect(countOn(keepMainComponent(m.data, 40, 40, seed).mask)).toBe(16);
  });

  it("fills small closed holes but not ones open to the border", () => {
    const m = rect(40, 40, 5, 5, 30, 30);
    for (let y = 15; y < 18; y++) for (let x = 15; x < 18; x++) m.data[y * 40 + x] = 0; // hole of 9
    expect(countOn(fillSmallHoles(m.data, 40, 40, 20))).toBe(25 * 25);
    expect(countOn(fillSmallHoles(m.data, 40, 40, 5))).toBe(25 * 25 - 9);
    const notch = rect(40, 40, 5, 5, 30, 30);
    for (let y = 5; y < 12; y++) for (let x = 15; x < 18; x++) notch.data[y * 40 + x] = 0; // open at the top
    expect(countOn(fillSmallHoles(notch.data, 40, 40, 1000))).toBe(25 * 25 - 21);
  });

  it("labels components with 4-connectivity (a diagonal touch is two components)", () => {
    const m = blank(6, 6);
    m.data[1 * 6 + 1] = 255;
    m.data[2 * 6 + 2] = 255;
    expect(components(m.data, 6, 6).sizes.length - 1).toBe(2);
  });

  it("the majority filter removes isolated pixels", () => {
    const m = rect(20, 20, 4, 4, 14, 14);
    m.data[1 * 20 + 1] = 255;
    const out = majority3(m.data, 20, 20);
    expect(out[1 * 20 + 1]).toBe(0);
    expect(out[8 * 20 + 8]).toBe(255);
  });
});

describe("geometry helpers", () => {
  it("polygon area, convex hull and point-in-polygon agree on a square", () => {
    const sq: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(polygonArea(sq)).toBe(100);
    expect(polygonArea(convexHull([...sq, { x: 5, y: 5 }]))).toBe(100);
    expect(pointInPolygon(5, 5, sq)).toBe(true);
    expect(pointInPolygon(11, 5, sq)).toBe(false);
  });

  it("fillPolygon fills the interior at pixel centres", () => {
    const data = new Uint8Array(20 * 20);
    fillPolygon(data, 20, 20, [{ x: 2, y: 2 }, { x: 12, y: 2 }, { x: 12, y: 8 }, { x: 2, y: 8 }]);
    expect(countOn(data)).toBe(10 * 6);
  });

  it("the palm width is the index-to-little knuckle distance", () => {
    const lm: Pt[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
    lm[5] = { x: 3, y: 0 };
    lm[17] = { x: 3, y: 4 };
    expect(palmWidth(lm)).toBe(4);
  });
});
