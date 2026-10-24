import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CalibrationParams, CaptureParams, CoinDetectionParams, FrameObservation, LiveScanParams, PublicConfig } from "../api/types";

// Paths relative to the frontend root (vitest's cwd); import.meta.url is not a file URL under jsdom.
const measurement = JSON.parse(readFileSync(resolve(process.cwd(), "../config/measurement.json"), "utf-8"));
const coinScenes = JSON.parse(readFileSync(resolve(process.cwd(), "src/vision/__fixtures__/coin_scenes.json"), "utf-8"));

export const coinParams = measurement.coin_detection as CoinDetectionParams;
export const captureParams = measurement.capture as CaptureParams;
export const liveScanParams = measurement.live_scan as LiveScanParams;
export const calibrationParams = measurement.calibration as CalibrationParams;

export const searchWindowCase = coinScenes.search_window_case as {
  frame: FrameObservation;
  roi: [number, number, number, number];
  diameter_range_px: [number, number];
};

/** A clean synthetic frame (from backend/glovesize/synthetic.py) that passes every gate. */
export function goodFrame(): FrameObservation {
  return structuredClone(searchWindowCase.frame);
}

export function publicConfig(overrides: Partial<PublicConfig> = {}): PublicConfig {
  return {
    reference_objects: {
      default: "us_quarter",
      objects: [
        {
          id: "us_quarter",
          label: "US quarter (25¢)",
          shape: "circle",
          diameter_mm: 24.26,
          diameter_uncertainty_mm: 0.05,
          thickness_mm: 1.75,
          source: "US Mint",
          enabled: true,
          availability: "all",
          size_check: false,
          customer_hint: null,
          notes: null,
        },
        {
          id: "us_nickel",
          label: "US nickel (5¢)",
          shape: "circle",
          diameter_mm: 21.21,
          diameter_uncertainty_mm: 0.05,
          thickness_mm: 1.95,
          source: "US Mint",
          enabled: false,
          availability: "all",
          size_check: false,
          customer_hint: null,
          notes: null,
        },
      ],
    },
    coin_detection: coinParams,
    capture: captureParams,
    live_scan: liveScanParams,
    calibration: calibrationParams,
    measurement_labels: {},
    manual_measurement_sd_mm: 4,
    assumed_hfov_deg: [55, 80],
    calibration_status: "uncalibrated",
    calibration_validated: false,
    charts: [
      {
        chart_id: "demo-length-v1",
        manufacturer: "Demo Manufacturer",
        product_model: "Demo Work Glove",
        is_demo: true,
        disclaimer: "DEMONSTRATION CHART WITH SYNTHETIC VALUES.",
        measurements: ["hand_length_mm"],
        combine: "primary_only",
        sizes: ["S", "M", "L"],
      },
    ],
    default_chart_id: "demo-length-v1",
    research_collection_enabled: false,
    validation_mode_enabled: false,
    validation_reference_tolerance_mm: 2,
    operator_access: "localhost",
    pilot_remote_enabled: false,
    ...overrides,
  };
}
