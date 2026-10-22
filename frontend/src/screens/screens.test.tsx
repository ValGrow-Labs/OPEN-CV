// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Measurement, Recommendation, ScanResponse } from "../api/types";
import { publicConfig } from "../test/fixtures";
import { loadReference, saveReference } from "../ui/settings";
import { MeasurementsScreen } from "./MeasurementsScreen";
import { ResultsScreen } from "./ResultsScreen";
import { ScanScreen } from "./ScanScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setMediaDevices(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
}

describe("ScanScreen camera errors", () => {
  it("explains a denied camera permission and offers retry", async () => {
    setMediaDevices(() => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })));
    render(<ScanScreen config={publicConfig()} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onCancel={() => {}} onResult={() => {}} showIntro={false} requireCoinConfirm={false} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Camera access is blocked/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("explains a missing camera", async () => {
    setMediaDevices(() => Promise.reject(Object.assign(new Error("none"), { name: "NotFoundError" })));
    render(<ScanScreen config={publicConfig()} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onCancel={() => {}} onResult={() => {}} showIntro={false} requireCoinConfirm={false} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/No camera found/);
  });

  it("explains an insecure (http) origin without a retry button", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    render(<ScanScreen config={publicConfig()} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onCancel={() => {}} onResult={() => {}} showIntro={false} requireCoinConfirm={false} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Secure connection required/);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
  });
});

const baseResponse: ScanResponse = {
  status: "rejected",
  issues: [
    { code: "insufficient_frames", severity: "error", message: "Not enough good-quality frames were captured.", frames_affected: null },
    { code: "coin_glare", severity: "error", message: "There is glare on the coin.", frames_affected: 40 },
  ],
  calibration: null,
  measurements: [],
  proportions: {},
  frames_received: 48,
  frames_accepted: 3,
  frame_rejection_counts: { coin_glare: 40 },
  landmarks_px_median: null,
  coin_median: null,
  image_width: 1280,
  image_height: 720,
  recommendation: null,
  uncertainty_basis: "prior_assumptions",
  limitations: ["Single camera view."],
};

describe("MeasurementsScreen", () => {
  it("explains what to correct when a scan is rejected", () => {
    const cfg = publicConfig();
    render(
      <MeasurementsScreen config={cfg} chart={cfg.charts[0]} result={baseResponse} mirrored={false} onRescan={() => {}} onContinue={() => {}} busy={false} error={null} />,
    );
    expect((screen.getByRole("heading", { level: 1 })).textContent).toMatch(/couldn't measure/);
    expect(screen.getByText(/glare on the coin/)).toBeTruthy();
    expect(screen.getByText(/3 of 48 frames/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan again" })).toBeTruthy();
  });

  it("explains non-contradictory frame requirement when all received frames passed checks", () => {
    const cfg = publicConfig();
    const allPassedResponse: ScanResponse = {
      ...baseResponse,
      frames_received: 8,
      frames_accepted: 8,
      frame_rejection_counts: {},
      issues: [
        { code: "insufficient_frames", severity: "error", message: "Not enough good-quality frames were captured.", frames_affected: null },
      ],
    };
    render(
      <MeasurementsScreen config={cfg} chart={cfg.charts[0]} result={allPassedResponse} mirrored={false} onRescan={() => {}} onContinue={() => {}} busy={false} error={null} />,
    );
    expect(screen.getByText(/All 8 captured frames passed quality checks/)).toBeTruthy();
    expect(screen.getByText(/minimum 8 required/)).toBeTruthy();
  });
});

const mockMeasurements: Measurement[] = [
  { key: "hand_length_mm", label: "Hand length", value_mm: 185.0, uncertainty_mm: 2.0, interval95_mm: [181, 189], status: "valid", source: "camera_landmarks", method: "straight", definition: "wrist to tip", calibrated: true, frames_used: 10, uncertainty_components_mm: {}, reasons: [] },
  { key: "index_length_mm", label: "Index finger length", value_mm: 75.4, uncertainty_mm: 2.1, interval95_mm: [71, 79], status: "valid", source: "camera_landmarks", method: "polyline", definition: "MCP to tip", calibrated: true, frames_used: 10, uncertainty_components_mm: {}, reasons: [] },
  { key: "middle_length_mm", label: "Middle finger length", value_mm: 89.8, uncertainty_mm: 2.0, interval95_mm: [86, 94], status: "valid", source: "camera_landmarks", method: "polyline", definition: "MCP to tip", calibrated: true, frames_used: 10, uncertainty_components_mm: {}, reasons: [] },
  { key: "ring_length_mm", label: "Ring finger length", value_mm: 74.2, uncertainty_mm: 2.0, interval95_mm: [70, 78], status: "valid", source: "camera_landmarks", method: "polyline", definition: "MCP to tip", calibrated: true, frames_used: 10, uncertainty_components_mm: {}, reasons: [] },
  { key: "little_length_mm", label: "Pinky (Little) finger length", value_mm: 60.1, uncertainty_mm: 1.9, interval95_mm: [56, 64], status: "valid", source: "camera_landmarks", method: "polyline", definition: "MCP to tip", calibrated: true, frames_used: 10, uncertainty_components_mm: {}, reasons: [] },
  { key: "thumb_length_mm", label: "Thumb length", value_mm: 59.5, uncertainty_mm: 4.2, interval95_mm: [51, 68], status: "low_confidence", source: "camera_landmarks", method: "polyline", definition: "MCP to tip", calibrated: true, frames_used: 10, uncertainty_components_mm: {}, reasons: ["out_of_plane"] },
  { key: "mcp_span_mm", label: "Palm width (knuckle joint centres)", value_mm: 82.0, uncertainty_mm: 2.5, interval95_mm: [77, 87], status: "valid", source: "camera_landmarks", method: "straight", definition: "MCP span", calibrated: true, frames_used: 10, uncertainty_components_mm: {}, reasons: [] },
  { key: "palm_breadth_mm", label: "Palm breadth (skin edge to skin edge)", value_mm: null, uncertainty_mm: null, interval95_mm: null, status: "not_measured", source: "not_available", method: "none", definition: "skin to skin", calibrated: false, frames_used: 0, uncertainty_components_mm: {}, reasons: ["requires_validated_model_or_manual_entry"] },
  { key: "hand_circumference_mm", label: "Hand circumference (around knuckles)", value_mm: null, uncertainty_mm: null, interval95_mm: null, status: "not_measured", source: "not_available", method: "none", definition: "circumference", calibrated: false, frames_used: 0, uncertainty_components_mm: {}, reasons: ["requires_validated_model_or_manual_entry"] },
];

const rec: Recommendation = {
  status: "recommended",
  size: "M",
  alternative_size: "L",
  confidence_level: "likely",
  chart_id: "demo-length-v1",
  manufacturer: "Demo Manufacturer",
  product_model: "Demo Work Glove",
  is_demo_chart: true,
  disclaimer: "DEMONSTRATION CHART WITH SYNTHETIC VALUES.",
  basis: ["hand length"],
  explanation: ["Your hand length is 185 mm (7.28 in)."],
  needed_measurements: [],
  plausible_sizes: ["M", "L"],
  by_measurement: [{ key: "hand_length_mm", value_mm: 185, uncertainty_mm: 2, size: "M", plausible_sizes: ["M", "L"] }],
};

describe("ResultsScreen", () => {
  it("shows size, alternative, demo disclaimer and limitations without guaranteeing fit", () => {
    const { container } = render(
      <ResultsScreen recommendation={rec} result={{ ...baseResponse, status: "accepted" }} extraMeasurements={[]} onRescan={() => {}} onBack={() => {}} onStartOver={() => {}} />,
    );
    expect(screen.getByText("M")).toBeTruthy();
    expect(screen.getByText(/Also consider size L/)).toBeTruthy();
    expect(screen.getByText(/DEMONSTRATION CHART/)).toBeTruthy();
    expect(screen.getByText(/not the probability that a glove will fit/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/guaranteed fit|100%/i);
    expect(screen.getByRole("button", { name: "Rescan" })).toBeTruthy();
  });

  it("displays all measured finger lengths, palm dimensions, and not measured circumferences", () => {
    render(
      <ResultsScreen
        recommendation={rec}
        result={{ ...baseResponse, status: "accepted", measurements: mockMeasurements, frames_accepted: 10, frames_received: 10 }}
        extraMeasurements={[]}
        onRescan={() => {}}
        onBack={() => {}}
        onStartOver={() => {}}
      />,
    );
    // Finger lengths displayed in mm
    expect(screen.getAllByText("75 mm").length).toBeGreaterThan(0);
    expect(screen.getAllByText("90 mm").length).toBeGreaterThan(0);
    expect(screen.getByText("74 mm")).toBeTruthy();
    expect(screen.getAllByText("60 mm").length).toBeGreaterThan(0);

    // Palm dimensions
    expect(screen.getByText("185 mm")).toBeTruthy();
    expect(screen.getByText("82 mm")).toBeTruthy();

    // Circumference labelled Not measured
    expect(screen.getAllByText("Not measured").length).toBeGreaterThan(0);
    expect(screen.getByText(/A single 2D camera view cannot measure 3D circumferences/)).toBeTruthy();
    expect(screen.getByText(/SPLNTD Benchmark Base/)).toBeTruthy();
  });
});

describe("settings storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("falls back to the default reference and ignores disabled or corrupt values", () => {
    const cfg = publicConfig();
    expect(loadReference(cfg)).toEqual({ object_id: "us_quarter" });
    saveReference({ object_id: "us_nickel" });
    expect(loadReference(cfg)).toEqual({ object_id: "us_quarter" });
    window.localStorage.setItem("glovesize.reference.v1", "{not json");
    expect(loadReference(cfg)).toEqual({ object_id: "us_quarter" });
    saveReference({ custom_diameter_mm: 30, custom_label: "Token" });
    expect(loadReference(cfg)).toEqual({ custom_diameter_mm: 30, custom_label: "Token" });
  });

  it("works when storage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadReference(publicConfig())).toEqual({ object_id: "us_quarter" });
    spy.mockRestore();
  });
});
