// Cross-language parity: the TypeScript detector must reproduce the Python reference
// (backend/glovesize/coin_detection.py) on the same synthetic scenes.
// Regenerate fixtures with: cd backend && python -m scripts.make_parity_fixtures
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import type { CoinDetectionParams, CoinObservation } from "../api/types";
import { detectCoin, type RgbaImage } from "./coinDetector";
import { initOpenCV, type CV } from "./opencv";

interface Scene {
  name: string;
  width: number;
  height: number;
  rgba_zlib_b64: string;
  truth: { major_axis_px: number; minor_axis_px: number; center_x: number; center_y: number };
  python: CoinObservation;
}

const fixtures = JSON.parse(readFileSync(new URL("./__fixtures__/coin_scenes.json", import.meta.url), "utf-8")) as {
  scenes: Scene[];
  roi_case: { scene: string; roi: [number, number, number, number]; diameter_range_px: [number, number]; python: CoinObservation };
};
const params = JSON.parse(readFileSync(new URL("../../../config/measurement.json", import.meta.url), "utf-8"))
  .coin_detection as CoinDetectionParams;

function image(s: Scene): RgbaImage {
  return { data: new Uint8Array(inflateSync(Buffer.from(s.rgba_zlib_b64, "base64"))), width: s.width, height: s.height };
}

let cv: CV;
beforeAll(async () => {
  // Synchronous require: awaiting a dynamic import would adopt the module's `then`.
  cv = await initOpenCV(createRequire(import.meta.url)("@techstark/opencv-js"));
});

describe("coin detector parity with Python reference", () => {
  for (const scene of fixtures.scenes) {
    it(scene.name, () => {
      const ts = detectCoin(cv, image(scene), params);
      const py = scene.python;
      expect(ts.accepted).toBe(py.accepted);
      expect(ts.reasons).toEqual(py.reasons);
      // Accepted coins set the scale, so they must match tightly. A rejected coin's geometry
      // is never used; on deliberately smeared edges float32/float64 differences can move the
      // sub-pixel peak slightly, so only coarse agreement is required there.
      const tol = py.accepted ? 0.05 : 0.5;
      expect(Math.abs(ts.major_axis_px - py.major_axis_px)).toBeLessThan(tol);
      expect(Math.abs(ts.minor_axis_px - py.minor_axis_px)).toBeLessThan(tol);
      expect(ts.center_x).toBeCloseTo(py.center_x, 1);
      expect(ts.center_y).toBeCloseTo(py.center_y, 1);
      const qualityTol = py.accepted ? 0.005 : 0.05;
      expect(Math.abs(ts.edge_support - py.edge_support)).toBeLessThan(qualityTol);
      expect(Math.abs(ts.confidence - py.confidence)).toBeLessThan(py.accepted ? 0.005 : 0.1);
      expect(Math.abs(ts.glare_fraction - py.glare_fraction)).toBeLessThan(qualityTol);
    });
  }

  it("ROI and diameter range", () => {
    const rc = fixtures.roi_case;
    const scene = fixtures.scenes.find((s) => s.name === rc.scene)!;
    const [x, y, w, h] = rc.roi;
    const ts = detectCoin(cv, image(scene), params, { x, y, w, h }, rc.diameter_range_px);
    expect(ts.accepted).toBe(rc.python.accepted);
    expect(ts.center_x).toBeCloseTo(rc.python.center_x, 1);
    expect(ts.major_axis_px).toBeCloseTo(rc.python.major_axis_px, 1);
  });

  it("recovers the true diameter of clean scenes", () => {
    for (const scene of fixtures.scenes.filter((s) => s.python.accepted)) {
      const ts = detectCoin(cv, image(scene), params);
      expect(Math.abs(ts.major_axis_px - scene.truth.major_axis_px)).toBeLessThan(0.35 + 0.0075 * scene.truth.major_axis_px);
    }
  });
});
