import { describe, expect, it } from "vitest";
import { coinParams, searchWindowCase } from "../test/fixtures";
import { buildObservation, coinSearchWindow, meanBrightness } from "./frameAnalysis";

describe("frame analysis", () => {
  it("computes the same coin search window as Python", () => {
    const f = searchWindowCase.frame;
    const w = coinSearchWindow(f.landmarks, f.image_width, f.image_height, coinParams);
    expect([w.roi.x, w.roi.y, w.roi.w, w.roi.h]).toEqual(searchWindowCase.roi);
    expect(w.diameterRange[0]).toBeCloseTo(searchWindowCase.diameter_range_px[0], 9);
    expect(w.diameterRange[1]).toBeCloseTo(searchWindowCase.diameter_range_px[1], 9);
  });

  it("computes mean luma", () => {
    expect(meanBrightness(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]))).toBeCloseTo(127.5, 6);
  });

  it("omits coin data when no coin was found and never includes pixels", () => {
    const f = searchWindowCase.frame;
    const obs = buildObservation({
      timestampMs: 1,
      width: f.image_width,
      height: f.image_height,
      landmarks: f.landmarks,
      world: null,
      handedness: null,
      handednessScore: null,
      coin: null,
      brightness: 120,
    });
    expect(obs.coin).toBeNull();
    expect(Object.keys(obs).sort()).toEqual(
      ["brightness", "coin", "handedness", "handedness_score", "image_height", "image_width", "landmarks", "timestamp_ms", "world_landmarks"].sort(),
    );
  });
});
