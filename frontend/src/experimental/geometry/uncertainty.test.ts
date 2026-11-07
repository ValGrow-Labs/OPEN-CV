// The error budget, term by term against hand calculations. MODEL-BASED: this checks the arithmetic, not any measurement.
import { describe, expect, it } from "vitest";
import { focalLengthSensitivity } from "./camera";
import { defaultRelFocalError, estimateMeasurementUncertainty, type UncertaintyInput, type UncertaintyKey } from "./uncertainty";

const near = (a: number, b: number, tol = 1e-4) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const S3 = Math.sqrt(3);

/** A 190 mm hand length, a US quarter (24.26 mm, +-0.05 mm allowance) 121.3 px across at 0.2 mm/px, 350 mm away. */
const base: UncertaintyInput = {
  lengthMm: 190,
  mmPerPx: 0.2,
  coinMajorPx: 121.3,
  referenceDiameterMm: 24.26,
  referenceDiameterUncertaintyMm: 0.05,
  distanceMm: 350,
};
const sigma = (b: ReturnType<typeof estimateMeasurementUncertainty>, k: UncertaintyKey) => b.components.find((c) => c.key === k)!.sigmaMm;

describe("each term against a hand calculation (defaults: edge 0.5 px, boundary 1 px, plane offset 15 mm uncorrected, no tilt, no distortion)", () => {
  const b = estimateMeasurementUncertainty(base);

  it("(a) coin edge localisation: 190 * sqrt(2) * 0.5 / 121.3 = 1.1076 mm", () => {
    near(sigma(b, "coin_edge"), 190 * Math.SQRT2 * 0.5 / 121.3);
    near(sigma(b, "coin_edge"), 1.1076, 1e-3);
  });
  it("(b) reference diameter: 190 * (0.05 / sqrt(3)) / 24.26 = 0.2261 mm", () => {
    near(sigma(b, "reference_diameter"), (190 * (0.05 / S3)) / 24.26);
    near(sigma(b, "reference_diameter"), 0.2261, 1e-3);
  });
  it("(c) plane offset: 190 * 15 / 350 = 8.1429 mm, the dominant term", () => {
    near(sigma(b, "plane_offset"), 190 * (15 / 350));
    near(sigma(b, "plane_offset"), 8.1429, 1e-3);
    expect(b.dominant).toBe("plane_offset");
  });
  it("(d) tilt: zero for a length in the image plane", () => {
    expect(sigma(b, "length_tilt")).toBe(0);
  });
  it("(e) distortion: zero without k1", () => {
    expect(sigma(b, "lens_distortion")).toBe(0);
  });
  it("(f) boundary: sqrt(2) * 1 px * 0.2 mm/px = 0.2828 mm", () => {
    near(sigma(b, "boundary"), Math.SQRT2 * 0.2);
    near(sigma(b, "boundary"), 0.2828, 1e-3);
  });
  it("(g) focal assumption: no effect when the plane offset is not corrected from the distance", () => {
    expect(sigma(b, "focal_assumption")).toBe(0);
  });
  it("combined by root-sum-square: 8.226 mm (4.3 %), always labelled model-based and unvalidated", () => {
    const rss = Math.sqrt(b.components.reduce((s, c) => s + c.sigmaMm ** 2, 0));
    near(b.combined.value!, rss, 1e-12);
    near(b.combined.value!, 8.2258, 1e-3);
    near(b.relative, 8.2258 / 190, 1e-5);
    expect(b.combined.basis).toBe("model");
    expect(b.combined.unit).toBe("mm");
    expect(b.label).toMatch(/unvalidated/i);
    for (const c of b.components) expect(c.basis).toBe("model");
  });
});

describe("the terms respond to their inputs the way the formulas say", () => {
  it("(c) plane offset scales as dz / Z over the stated ranges (dz 10-25 mm, Z 250-500 mm)", () => {
    for (const dz of [10, 15, 25]) {
      for (const Z of [250, 350, 500]) {
        const b = estimateMeasurementUncertainty({ ...base, planeOffsetMm: dz, distanceMm: Z });
        near(sigma(b, "plane_offset"), 190 * (dz / Z), 1e-9);
      }
    }
    near(estimateMeasurementUncertainty({ ...base, planeOffsetMm: 25, distanceMm: 250 }).relative >= 0.1 ? 1 : 0, 1, 0); // 10 % at the worst corner
  });
  it("(c) corrected: only the residual remains, and (g) the focal assumption now matters", () => {
    const b = estimateMeasurementUncertainty({ ...base, planeOffsetCorrected: true, planeOffsetResidualMm: 5 });
    near(sigma(b, "plane_offset"), 190 * (5 / 350), 1e-9);
    const e = defaultRelFocalError() / S3;
    const expected = Math.abs(focalLengthSensitivity({ relFocalError: e, distanceMm: 350, planeOffsetMm: 15, lengthMm: 190 }).lengthErrorMm);
    near(sigma(b, "focal_assumption"), expected, 1e-12);
    expect(expected).toBeGreaterThan(0.3);
    expect(b.combined.value!).toBeLessThan(estimateMeasurementUncertainty(base).combined.value!);
  });
  it("(d) tilt: 20 degrees gives 190 * (1 - cos 20) = 11.46 mm; 10 degrees 2.89 mm", () => {
    near(sigma(estimateMeasurementUncertainty({ ...base, lengthTiltDeg: 20 }), "length_tilt"), 190 * (1 - Math.cos((20 * Math.PI) / 180)), 1e-9);
    near(sigma(estimateMeasurementUncertainty({ ...base, lengthTiltDeg: 20 }), "length_tilt"), 11.4585, 1e-3);
    near(sigma(estimateMeasurementUncertainty({ ...base, lengthTiltDeg: 10 }), "length_tilt"), 190 * (1 - Math.cos((10 * Math.PI) / 180)), 1e-9);
    near(sigma(estimateMeasurementUncertainty({ ...base, lengthTiltDeg: 10 }), "length_tilt"), 2.8865, 1e-3);
  });
  it("(e) distortion: k1 = -0.1, r_measured 0.6, r_coin 0.1 gives 190 * 0.1 * 0.35 / sqrt(3) = 3.839 mm", () => {
    const b = estimateMeasurementUncertainty({ ...base, k1: -0.1, rMeasuredNorm: 0.6, rCoinNorm: 0.1 });
    near(sigma(b, "lens_distortion"), (190 * 0.1 * 0.35) / S3, 1e-9);
    near(sigma(b, "lens_distortion"), 3.8396, 1e-3);
  });
  it("(a)/(f) finer edges give smaller terms; a larger coin image shrinks the coin-edge term", () => {
    const sharp = estimateMeasurementUncertainty({ ...base, coinEdgeSigmaPx: 0.1, boundaryErrorPx: 0.25 });
    expect(sigma(sharp, "coin_edge")).toBeLessThan(sigma(estimateMeasurementUncertainty(base), "coin_edge"));
    near(sigma(sharp, "boundary"), Math.SQRT2 * 0.25 * 0.2, 1e-12);
    const big = estimateMeasurementUncertainty({ ...base, coinMajorPx: 242.6 });
    near(sigma(big, "coin_edge") * 2, sigma(estimateMeasurementUncertainty(base), "coin_edge"), 1e-9);
  });
  it("(b) the Indian 2-rupee coin's looser allowance (0.1 mm on 23 mm) costs more than the quarter's", () => {
    const inr = estimateMeasurementUncertainty({ ...base, referenceDiameterMm: 23, referenceDiameterUncertaintyMm: 0.1, coinMajorPx: 115 });
    near(sigma(inr, "reference_diameter"), (190 * (0.1 / S3)) / 23, 1e-9);
    expect(sigma(inr, "reference_diameter")).toBeGreaterThan(sigma(estimateMeasurementUncertainty(base), "reference_diameter"));
  });
});

describe("a 0.1 mm per pixel scale does not give 0.1 mm accuracy", () => {
  it("at 0.1 mm/px with the same assumptions the budget is still several millimetres, dominated by the plane offset", () => {
    const b = estimateMeasurementUncertainty({ ...base, mmPerPx: 0.1, coinMajorPx: 242.6, distanceMm: 350 });
    expect(b.combined.value!).toBeGreaterThan(5);
    expect(b.dominant).toBe("plane_offset");
    // the pixel-limited terms alone (edge + boundary) are small, which is exactly the point
    const pixelLimited = Math.hypot(sigma(b, "coin_edge"), sigma(b, "boundary"));
    expect(pixelLimited).toBeLessThan(1);
    expect(b.combined.value!).toBeGreaterThan(5 * pixelLimited);
  });
  it("even with the plane offset corrected and no tilt, one pixel of boundary error is only the floor", () => {
    const b = estimateMeasurementUncertainty({ ...base, mmPerPx: 0.1, coinMajorPx: 242.6, planeOffsetCorrected: true, planeOffsetResidualMm: 2 });
    expect(b.combined.value!).toBeGreaterThan(0.5); // still well above 0.1 mm
  });
});

describe("input checking", () => {
  it("rejects non-positive inputs", () => {
    expect(() => estimateMeasurementUncertainty({ ...base, lengthMm: 0 })).toThrow();
    expect(() => estimateMeasurementUncertainty({ ...base, distanceMm: -1 })).toThrow();
  });
  it("the default focal error is half the relative spread of the app's assumed field-of-view range (about 0.234)", () => {
    near(defaultRelFocalError(), 0.2343, 1e-3);
    near(defaultRelFocalError([70, 70]), 0, 1e-12);
  });
});
