import { describe, expect, it } from "vitest";
import type { Point } from "../../api/types";
import { buildScale, MODEL_LABEL, NO_COIN_NOTE, reasonWords, summariseSegmentation, type ScaleContext } from "./analysis";
import type { CoinSnapshot } from "./types";

const ctx: ScaleContext = { referenceDiameterMm: 24.26, referenceDiameterUncertaintyMm: 0.05, assumedHfovDeg: [55, 80] };
const image = { width: 1280, height: 720 };

/** SYNTHETIC landmarks: a wrist at (600, 650) and a middle fingertip 400 px above it. */
const landmarks: Point[] = Array.from({ length: 21 }, (_, i) => ({ x: 600, y: 650 - i * 20, z: 0 }));
landmarks[0] = { x: 600, y: 650, z: 0 };
landmarks[12] = { x: 600, y: 250, z: 0 };

const coin = (over: Partial<CoinSnapshot> = {}): CoinSnapshot => ({
  found: true,
  accepted: true,
  center_x: 700,
  center_y: 500,
  major_axis_px: 121.3, // 24.26 mm over 121.3 px = 0.2 mm per pixel
  minor_axis_px: 118,
  angle_deg: 20,
  edge_support: 1,
  max_angular_gap_deg: 0,
  fit_residual_px: 0.2,
  edge_width_px: 1.5,
  glare_fraction: 0,
  contrast: 0.3,
  n_edge_points: 200,
  confidence: 0.95,
  method: "hough",
  reasons: [],
  ...over,
});

describe("the scale of a view", () => {
  it("is unavailable, in words, when there is no accepted coin (never a guess)", () => {
    for (const c of [null, coin({ found: false, accepted: false }), coin({ accepted: false })]) {
      const s = buildScale(c, landmarks, image, { ok: true, areaPx: 100000 }, ctx);
      expect(s.available).toBe(false);
      expect(s.note).toBe(NO_COIN_NOTE);
      expect(s.mmPerPx).toBeNull();
      expect(s.areaMm2).toBeNull();
      expect(s.handLengthLandmarkMm).toBeNull();
    }
  });

  it("gives the coin-plane scale from the coin's size and the reference diameter, labelled a model estimate", () => {
    const s = buildScale(coin(), landmarks, image, { ok: true, areaPx: 100000 }, ctx);
    expect(s.available).toBe(true);
    expect(s.note).toBe(MODEL_LABEL);
    expect(s.note).toMatch(/unvalidated/);
    expect(s.mmPerPx).toBeCloseTo(24.26 / 121.3, 6);
    expect(s.areaMm2).toBeCloseTo(100000 * (24.26 / 121.3) ** 2, 3);
    expect(s.handLengthLandmarkMm).toBeCloseTo(400 * (24.26 / 121.3), 3);
    expect(s.coinTiltDeg).toBeGreaterThan(0);
    expect(s.coinTiltDeg).toBeLessThan(20);
    expect(s.distanceRangeMm![0]).toBeLessThan(s.distanceRangeMm![1]);
  });

  it("attaches a model uncertainty that is not zero and names its dominant term", () => {
    const s = buildScale(coin(), landmarks, image, { ok: true, areaPx: 1 }, ctx);
    expect(s.handLengthUncertaintyMm).toBeGreaterThan(0.5);
    expect(s.handLengthUncertaintyMm).toBeLessThan(40);
    expect(s.dominantUncertainty).toBeTruthy();
  });

  it("withholds the area in mm2 when the segmentation was rejected, but keeps the scale", () => {
    const s = buildScale(coin(), landmarks, image, { ok: false, areaPx: 90000 }, ctx);
    expect(s.available).toBe(true);
    expect(s.areaMm2).toBeNull();
    expect(s.mmPerPx).not.toBeNull();
    expect(buildScale(coin(), landmarks, image, null, ctx).areaMm2).toBeNull();
  });

  it("refuses a coin detection without a usable size", () => {
    const s = buildScale(coin({ major_axis_px: 0, minor_axis_px: 0 }), landmarks, image, null, ctx);
    expect(s.available).toBe(false);
    expect(s.note).toMatch(/no usable size/);
  });
});

describe("the segmentation summary and its words", () => {
  it("has a plain-language sentence for every reject reason, and passes an unknown one through", () => {
    for (const r of ["no_hand", "hand_incomplete", "hand_blurred", "hand_occluded", "fingers_merged", "mask_implausible", "segmentation_failed"]) {
      expect(reasonWords(r)).not.toBe(r);
      expect(reasonWords(r).length).toBeGreaterThan(20);
    }
    expect(reasonWords("something_new")).toBe("something_new");
  });

  it("copies a result into plain JSON-safe data without the mask pixels", () => {
    const summary = summariseSegmentation({
      ok: false,
      reasons: ["fingers_merged"],
      backend: "grabcut",
      mask: { width: 4, height: 4, data: new Uint8Array(16) },
      scaleToSource: 2,
      contour: [],
      areaPx: 1234,
      areaPolygonPx: 1200,
      fingertips: [{ x: 1, y: 2 }, null, null, null, null],
      wristLine: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      wristWidthPx: 50,
      gapsPreserved: [true, false, true, true],
      gaps: [],
      quality: null,
      timingMs: { total: 2100 },
    });
    expect(summary).toMatchObject({ ok: false, backend: "grabcut", areaPx: 1234, maskWidth: 4, maskHeight: 4, scaleToSource: 2 });
    expect(summary.reasons).toEqual(["fingers_merged"]);
    expect(JSON.stringify(summary)).not.toMatch(/"data"/);
  });
});
