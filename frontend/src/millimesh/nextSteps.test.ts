// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Measurement, Recommendation, ScanResponse } from "../api/types";
import { copyText, DETAILS_STEP, nextSteps, REPEAT_STEP, sizeStep, summaryText, tapeStep, thumbHint, thumbTiltDeg } from "./nextSteps";
import { simpleNumbers } from "./SimpleResults";

const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
  status: "recommended", size: "M", alternative_size: null, confidence_level: "likely", chart_id: "c", manufacturer: null, product_model: null,
  is_demo_chart: true, disclaimer: null, basis: [], explanation: [], needed_measurements: [], plausible_sizes: ["M"], by_measurement: [], ...over,
});
const meas = (key: string, value: number | null, extra: Partial<Measurement> = {}): Measurement => ({
  key, label: key, value_mm: value, uncertainty_mm: 6, interval95_mm: null, status: "low_confidence", source: "camera_landmarks", method: "", definition: "",
  calibrated: false, frames_used: 12, uncertainty_components_mm: {}, reasons: [], ...extra,
});
const response = (r: Recommendation | null, thumbTilt?: number): ScanResponse => ({
  status: "accepted", issues: [], calibration: null,
  measurements: [meas("hand_length_mm", 167.4), meas("mcp_span_mm", 72.2), meas("thumb_length_mm", 55, { finger_tilt_deg: thumbTilt, crease_to_tip_mm: 54 }), meas("index_length_mm", 91, { crease_to_tip_mm: 66 })],
  proportions: {}, frames_received: 40, frames_accepted: 36, frame_rejection_counts: {}, landmarks_px_median: null, coin_median: null, image_width: 1, image_height: 1,
  recommendation: r, uncertainty_basis: "prior_assumptions", limitations: [],
});

describe("next steps", () => {
  it("states the existing recommendation without claiming a firm size", () => {
    expect(sizeStep(rec())).toBe("Your estimated size is M (not a firm size). Compare it with the size chart of the glove you want.");
    expect(sizeStep(rec({ alternative_size: "L", status: "borderline" }))).toMatch(/estimated size is M, close to L \(borderline, not a firm size\)/);
    expect(sizeStep(rec({ size: null, closest_size: "S", closest_alternative: "M", status: "needs_more_data" }))).toMatch(/closest size is S, then M \(not a firm size/);
    expect(sizeStep(rec({ size: null, status: "unavailable" }))).toMatch(/cannot pick a size/);
    expect(sizeStep(null)).toMatch(/could not suggest a size/);
    for (const s of [sizeStep(rec()), sizeStep(null)]) expect(s).not.toMatch(/perfect|guarantee|will fit|buy/i);
  });

  it("asks for a tape or ruler only when the recommendation needs one", () => {
    expect(tapeStep(rec({ needed_measurements: ["hand_circumference_mm"] }))).toMatch(/around your hand at the knuckles with a soft tape.*More details/);
    expect(tapeStep(rec({ needed_measurements: ["hand_length_mm"] }))).toMatch(/ruler.*More details/);
    expect(tapeStep(rec())).toBeNull();
    expect(tapeStep(null)).toBeNull();
  });

  it("has 3 or 4 steps in order: size, tape (when needed), scan again, details", () => {
    const three = nextSteps(response(rec()));
    expect(three).toHaveLength(3);
    expect(three[1]).toBe(REPEAT_STEP);
    expect(three[2]).toBe(DETAILS_STEP);
    const four = nextSteps(response(rec({ needed_measurements: ["hand_circumference_mm"] })));
    expect(four).toHaveLength(4);
    expect(four[1]).toMatch(/soft tape/);
    expect(REPEAT_STEP).toMatch(/hand flat, fingers spread, thumb out and the whole coin visible/);
  });
});

describe("the per-scan thumb hint", () => {
  it("appears only when the thumb's median elevation is at least the (ASSUMED) 35 degrees, rounded to 5, and says what to do", () => {
    expect(thumbHint(response(rec(), 12))).toBeNull();
    expect(thumbHint(response(rec(), 30))).toBeNull(); // what the sample open hand reads
    expect(thumbHint(response(rec(), undefined))).toBeNull();
    expect(thumbHint(response(rec(), 34.9))).toBeNull();
    expect(thumbTiltDeg(response(rec(), 35))).toBe(35);
    expect(thumbHint(response(rec(), 36.8))).toBe("Your thumb was turned about 35° out of the palm plane in this scan (a rough depth estimate), which makes the thumb reading less reliable. Spread it flat and scan again.");
    expect(thumbHint(response(rec(), 41))).toMatch(/about 40°/);
  });
});

describe("copy results", () => {
  const r = response(rec());
  it("writes a plain-text summary with the numbers as shown, the size, the date and the estimate warning", () => {
    const t = summaryText(simpleNumbers(r, "crease"), "Suggested size M", new Date(2026, 10, 19));
    expect(t).toContain("MILLIMESH hand estimate (unvalidated prototype)");
    expect(t).toContain("Date: 2026-11-19");
    expect(t).toContain("Hand length: ≈ 16.7 cm");
    expect(t).toContain("Hand width (knuckle to knuckle): ≈ 7.2 cm");
    expect(t).toContain("Finger length, crease to tip (estimate):");
    expect(t).toContain("Thumb: ≈ 54 mm");
    expect(t).toContain("Suggested size M");
    expect(t).toMatch(/not validated and not a guarantee of fit/);
    expect(summaryText(simpleNumbers(r, "knuckle"), "x", new Date(2026, 0, 2))).toContain("Finger length, knuckle to tip:");
  });

  it("uses the clipboard API when there is one, and falls back to the selection trick when there is not", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyText("abc", document, { clipboard: { writeText } } as unknown as Navigator)).toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
    const exec = vi.fn().mockReturnValue(true);
    const doc = { createElement: () => ({ setAttribute() {}, style: {}, select() {}, value: "" }), body: { appendChild() {}, removeChild() {} }, execCommand: exec } as unknown as Document;
    expect(await copyText("abc", doc, {} as Navigator)).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(await copyText("abc", doc, { clipboard: { writeText: () => Promise.reject(new Error("denied")) } } as unknown as Navigator)).toBe(true);
    expect(await copyText("abc", { ...doc, execCommand: () => false } as unknown as Document, {} as Navigator)).toBe(false);
    expect(await copyText("abc", {} as Document, {} as Navigator)).toBe(false);
  });
});
