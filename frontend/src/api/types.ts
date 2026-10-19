// Mirrors backend/glovesize/schemas.py and the /api/config payload.

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface CoinObservation {
  center_x: number;
  center_y: number;
  major_axis_px: number;
  minor_axis_px: number;
  angle_deg: number;
  edge_support: number;
  max_angular_gap_deg: number;
  fit_residual_px: number;
  edge_width_px: number;
  glare_fraction: number;
  contrast: number;
  n_edge_points: number;
  confidence: number;
  accepted: boolean;
  method: string;
  reasons: string[];
}

export interface FrameObservation {
  timestamp_ms: number;
  image_width: number;
  image_height: number;
  landmarks: Point[];
  world_landmarks: Point[] | null;
  handedness: "Left" | "Right" | null;
  handedness_score: number | null;
  coin: CoinObservation | null;
  brightness: number | null;
}

export interface ReferenceSelection {
  object_id?: string;
  custom_diameter_mm?: number;
  custom_label?: string;
}

export interface ManualMeasurements {
  hand_circumference_mm?: number;
  palm_breadth_mm?: number;
}

export interface ScanRequest {
  frames: FrameObservation[];
  reference: ReferenceSelection;
  chart_id?: string;
  manual_measurements?: ManualMeasurements;
  capture?: { device_class: "mobile" | "desktop" | "unknown"; camera_facing: "user" | "environment" | "unknown" };
}

export type Severity = "error" | "warning" | "info";

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  frames_affected: number | null;
}

export type MeasurementStatus = "valid" | "low_confidence" | "invalid" | "not_measured" | "user_entered";
export type MeasurementSource = "camera_landmarks" | "camera_model_estimate" | "user_entered" | "not_available";

export interface Measurement {
  key: string;
  label: string;
  value_mm: number | null;
  uncertainty_mm: number | null;
  interval95_mm: [number, number] | null;
  status: MeasurementStatus;
  source: MeasurementSource;
  method: string;
  definition: string;
  calibrated: boolean;
  frames_used: number;
  uncertainty_components_mm: Record<string, number>;
  reasons: string[];
}

export interface CalibrationSummary {
  reference_label: string;
  reference_diameter_mm: number;
  custom_reference: boolean;
  coin_diameter_px: number;
  px_per_mm: number;
  px_per_mm_rel_uncertainty: number;
  coin_tilt_deg: number;
  tilt_corrected: boolean;
  depth_correction_factor: number;
  estimated_camera_distance_mm: [number, number];
}

export interface SizeByMeasurement {
  key: string;
  value_mm: number;
  uncertainty_mm: number;
  size: string;
  plausible_sizes: string[];
}

export type ConfidenceLevel = "clear" | "likely" | "borderline" | "uncertain";

export interface Recommendation {
  status: "recommended" | "borderline" | "needs_more_data" | "unavailable";
  size: string | null;
  alternative_size: string | null;
  confidence_level: ConfidenceLevel | null;
  chart_id: string;
  manufacturer: string | null;
  product_model: string | null;
  is_demo_chart: boolean;
  disclaimer: string | null;
  basis: string[];
  explanation: string[];
  needed_measurements: string[];
  by_measurement: SizeByMeasurement[];
}

export interface ScanResponse {
  status: "accepted" | "rejected";
  issues: Issue[];
  calibration: CalibrationSummary | null;
  measurements: Measurement[];
  proportions: Record<string, number>;
  frames_received: number;
  frames_accepted: number;
  frame_rejection_counts: Record<string, number>;
  landmarks_px_median: Point[] | null;
  coin_median: CoinObservation | null;
  image_width: number;
  image_height: number;
  recommendation: Recommendation | null;
  uncertainty_basis: "prior_assumptions" | "validated";
  limitations: string[];
}

// ----------------------------------------------------------------------------
// Public configuration
// ----------------------------------------------------------------------------

export interface CoinAcceptance {
  min_edge_support: number;
  max_angular_gap_deg: number;
  max_fit_residual_px: number;
  max_fit_residual_rel: number;
  max_edge_width_px: number;
  max_glare_fraction: number;
  min_contrast: number;
  min_confidence: number;
}

export interface CoinDetectionParams {
  clahe_clip_limit: number;
  clahe_tile_grid: number;
  blur_kernel: number;
  canny_high: number;
  canny_low_ratio: number;
  min_contour_circularity: number;
  min_axis_ratio: number;
  hough_dp: number;
  hough_param2: number;
  max_candidates: number;
  radial_rays: number;
  radial_search_fraction: number;
  radial_step_px: number;
  edge_strength_min: number;
  edge_strength_rel: number;
  outlier_mad_k: number;
  min_diameter_px: number;
  glare_level: number;
  search_roi_half_size_palm_lengths: number;
  search_diameter_range_palm_lengths: [number, number];
  accept: CoinAcceptance;
}

export interface CaptureParams {
  frames_target: number;
  frames_min_accepted: number;
  max_frames_per_request: number;
  min_hand_length_fraction: number;
  edge_margin_fraction: number;
  max_finger_bend_deg: number;
  max_finger_bend_deg_3d: number;
  max_palm_tilt_deg_model: number;
  brightness_range: [number, number];
  max_landmark_jitter_fraction: number;
}

export interface CalibrationParams {
  max_tilt_deg: number;
  warn_tilt_deg: number;
  tilt_correction_min_deg: number;
  diameter_edge_floor_px: number;
  require_coin_on_palm: boolean;
}

export interface ReferenceObject {
  id: string;
  label: string;
  shape: "circle";
  diameter_mm: number;
  diameter_uncertainty_mm: number;
  thickness_mm: number | null;
  source: string;
  enabled: boolean;
  notes: string | null;
}

export interface ChartSummary {
  chart_id: string;
  manufacturer: string | null;
  product_model: string | null;
  is_demo: boolean;
  disclaimer: string | null;
  measurements: string[];
  combine: string;
  sizes: string[];
}

export interface PublicConfig {
  reference_objects: { default: string; objects: ReferenceObject[] };
  coin_detection: CoinDetectionParams;
  capture: CaptureParams;
  calibration: CalibrationParams;
  measurement_labels: Record<string, string>;
  manual_measurement_sd_mm: number;
  calibration_status: "uncalibrated" | "calibrated";
  charts: ChartSummary[];
  default_chart_id: string;
  research_collection_enabled: boolean;
}
