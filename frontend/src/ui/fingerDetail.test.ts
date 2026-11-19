import { describe, expect, it } from "vitest";
import type { Measurement } from "../api/types";
import { fingerFrameDetail, REASONS } from "./format";
import { HOLD_STILL_MESSAGE, LIVE_MESSAGES } from "../vision/liveChecks";

const base: Measurement = {
  key: "index_length_mm",
  label: "Index finger length",
  value_mm: 82,
  uncertainty_mm: 6,
  interval95_mm: [70, 94],
  status: "low_confidence",
  source: "camera_landmarks",
  method: "",
  definition: "",
  calibrated: false,
  frames_used: 11,
  uncertainty_components_mm: {},
  reasons: [],
};

describe("finger frame detail (advice only)", () => {
  it("says nothing for a finger with no exclusions and no flag", () => {
    expect(fingerFrameDetail(base)).toBeUndefined();
    expect(fingerFrameDetail(undefined)).toBeUndefined();
  });

  it("names the frames left out and how to hold the hand", () => {
    const d = fingerFrameDetail({ ...base, frame_exclusions: { finger_bent: 3, finger_obscured: 1, outlier_frame: 2 } });
    expect(d).toContain("3 bent");
    expect(d).toContain("1 hidden or poorly detected");
    expect(d).toContain("2 far from the other frames");
    expect(d).toContain("flat and still");
  });

  it("explains a hidden finger and a tilted one without exclusions", () => {
    expect(fingerFrameDetail({ ...base, value_mm: null, status: "invalid", reasons: ["too_few_frames"] })).toContain("fingers straight and spread");
    expect(fingerFrameDetail({ ...base, reasons: ["finger_tilted"] })).toBeDefined();
    expect(REASONS.finger_tilted).toMatch(/tilted/);
  });

  it("is only for the thumb and fingers, never for hand or palm values", () => {
    expect(fingerFrameDetail({ ...base, key: "hand_length_mm", frame_exclusions: { finger_bent: 3 } })).toBeUndefined();
  });
});

describe("live guidance wording for the fingers", () => {
  it("tells the customer how to hold the hand while a frame is fine, and keeps the bent-finger message", () => {
    expect(HOLD_STILL_MESSAGE).toMatch(/fingers straight, spread and flat/);
    expect(LIVE_MESSAGES.fingers_bent).toMatch(/Straighten your fingers/);
  });
});
