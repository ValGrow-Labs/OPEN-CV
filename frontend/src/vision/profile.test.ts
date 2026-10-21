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
  cv = await initOpenCV(createRequire(import.meta.url)("@techstark/opencv-js"));
});

describe("coin detection performance profiling", () => {
  it("verifies coin tracking is sub-15ms and full search is sub-100ms", () => {
    let totalFull = 0;
    let totalTrack = 0;
    let trackCount = 0;

    for (const scene of fixtures.scenes) {
      const img = image(scene);
      const t0 = performance.now();
      const det = detectCoin(cv, img, params);
      const tFull = performance.now() - t0;
      totalFull += tFull;

      if (det.found) {
        const t1 = performance.now();
        const tracked = detectCoin(cv, img, params, null, null, det);
        const tTrack = performance.now() - t1;
        totalTrack += tTrack;
        trackCount++;
        expect(tracked.found).toBe(true);
      }
    }

    const avgFull = totalFull / fixtures.scenes.length;
    const avgTrack = totalTrack / (trackCount || 1);

    expect(avgTrack).toBeLessThan(20);
    expect(avgFull).toBeLessThan(100);
  });
});
