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
  /** Capture view id (config capture.views); the server treats a missing one as the primary view. */
  view?: string;
}

export interface ReferenceSelection {
  object_id?: string;
  custom_diameter_mm?: number;
  custom_label?: string;
  /** Set when the customer or operator explicitly confirmed the coin; the server rejects scans without it. */
  confirmed?: boolean;
  /** The customer confirmed the coin's size (required for coins with `size_check`). */
  size_checked?: boolean;
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
  plausible_sizes: string[];
  /** Only when no single size is supported: the size the reading falls in, and its nearer neighbour. */
  closest_size?: string | null;
  closest_alternative?: string | null;
  by_measurement: SizeByMeasurement[];
}

export interface FingerBend {
  bend_2d_deg: number;
  bend_3d_deg: number | null;
  limit_2d_deg: number;
  limit_3d_deg: number;
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
  uncertainty_basis: "prior_assumptions" | "fitted_unvalidated" | "validated";
  limitations: string[];
  /** How bent each finger looked over the scan (median of its frames) against the limits. */
  finger_bends?: Record<string, FingerBend>;
  /** Per capture view: how many frames, whether it was used, its own hand length. */
  views?: ViewSummary[];
  /** Hand length of the views compared (only with two or more views used). */
  view_agreement?: ViewAgreement | null;
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

export interface CoinScoreParams {
  edge_support_good: number;
  edge_support_bad: number;
  angular_gap_good_deg: number;
  angular_gap_bad_factor: number;
  fit_residual_good_px: number;
  fit_residual_bad_factor: number;
  edge_width_good_px: number;
  edge_width_bad_factor: number;
  glare_good: number;
  glare_bad_factor: number;
  contrast_good: number;
  contrast_bad_factor: number;
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
  narrow_search_fraction: number;
  candidate_size_tolerance: [number, number];
  ambiguity_confidence_ratio: number;
  score: CoinScoreParams;
  accept: CoinAcceptance;
}

/** One angle the customer is guided through (config capture.views); the first is the primary one. */
export interface CaptureView {
  id: string;
  label: string;
  required: boolean;
  /** Whether the view's frames go into the size. A view that is not is captured only (a side view). */
  used_for_size: boolean;
  /** The honest one-liner shown when this view is offered next. */
  note: string;
  title: string;
  instruction: string;
  /** Live-guidance texts that differ from the palm wording, by live-check code. */
  messages: Record<string, string>;
  /** Largest coin tilt accepted in this view; null/absent uses calibration.max_tilt_deg. */
  max_coin_tilt_deg?: number | null;
}

export interface ViewSummary {
  id: string;
  label: string;
  frames_received: number;
  frames_accepted: number;
  used: boolean;
  hand_length_mm: number | null;
  reason: string | null;
}

export interface ViewAgreement {
  hand_length_diff_mm: number;
  max_allowed_mm: number;
  agree: boolean;
}

export interface CaptureParams {
  views: CaptureView[];
  view_max_rel_diff: number;
  frames_target: number;
  frames_min_accepted: number;
  max_frames_per_request: number;
  min_hand_length_fraction: number;
  edge_margin_fraction: number;
  max_finger_bend_deg: number;
  max_finger_bend_deg_3d: number;
  finger_bend_3d_frame_factor: number;
  max_palm_tilt_deg_model: number;
  brightness_range: [number, number];
  max_landmark_jitter_fraction: number;
  min_camera_distance_mm: number;
  max_frame_rel_sd: number;
}

/** The browser's scan loop (config/measurement.json "live_scan"). */
export interface LiveScanParams {
  min_frame_interval_ms: number;
  full_coin_search_every: number;
  track_min_confidence: number;
  palm_mask_grow: number | null;
  mobile_frames_target: number;
  mobile_frames_min: number;
  timeout_s: number;
  early_stop_frames_mobile: number;
  early_stop_frames_desktop: number;
  early_stop_rel_sd: number;
  early_stop_after_s: number;
  hint_after_s: number;
  issue_window_s: number;
  show_live_measurements: boolean;
  guidance_window_ms: number;
  guidance_hold_ms: number;
  guidance_min_share: number;
  guidance_keep_share: number;
  guidance_switch_margin: number;
  auto_exposure: boolean;
  exposure_step_ev: number;
  exposure_min_ev: number;
  exposure_max_ev: number;
  exposure_hold_ms: number;
  exposure_min_share: number;
}

export interface CalibrationParams {
  max_tilt_deg: number;
  tilt_window_frames: number;
  warn_tilt_deg: number;
  tilt_correction_min_deg: number;
  tilt_rectification: boolean;
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
  /** "pilot": only offered in the remote pilot, where the coin is also measured with a ruler. */
  availability: "all" | "pilot";
  /** Older coins of the same value have a different size: the customer confirms the size. */
  size_check: boolean;
  customer_hint: string | null;
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
  live_scan: LiveScanParams;
  calibration: CalibrationParams;
  measurement_labels: Record<string, string>;
  manual_measurement_sd_mm: number;
  assumed_hfov_deg: [number, number];
  calibration_status: "uncalibrated" | "calibrated";
  /** True only after human sign-off on held-out real-world evidence. */
  calibration_validated: boolean;
  charts: ChartSummary[];
  default_chart_id: string;
  research_collection_enabled: boolean;
  validation_mode_enabled: boolean;
  validation_reference_tolerance_mm: number;
  operator_access: "localhost" | "token";
  pilot_remote_enabled: boolean;
}

// ----------------------------------------------------------------------------
// Developer validation mode
// ----------------------------------------------------------------------------

export type LengthUnit = "mm" | "cm" | "in";

export interface Reading {
  value: number;
  unit: LengthUnit;
}

export interface ValidationReference {
  protocol: "HL-1";
  hand_length: Reading[];
  palm_breadth?: Reading;
  hand_circumference?: Reading;
  tool: "ruler" | "tape" | "calipers" | "anthropometer" | "other";
  measured_by: "operator" | "participant";
  operator_code?: string;
}

export interface CaptureConditions {
  device: string;
  lighting: "daylight" | "indoor_bright" | "indoor_dim" | "mixed" | "other";
  distance_cm?: number;
  background?: string;
  notes?: string;
}

export type TrialCondition =
  | "standard"
  | "distance_near"
  | "distance_far"
  | "coin_off_centre"
  | "lighting_changed"
  | "hand_rotated"
  | "fingers_slightly_bent";

export interface Trial {
  hand: "left" | "right";
  condition: TrialCondition;
}

export type DataOrigin = "real_participant" | "software_test";

export interface ValidationScanRequest {
  data_origin: DataOrigin;
  consent_confirmed: boolean;
  participant_code: string;
  reference: ValidationReference;
  trial: Trial;
  conditions: CaptureConditions;
  scan: ScanRequest;
}

export interface ReferenceSummary {
  hand_length_mm: number;
  readings_mm: number[];
  spread_mm: number;
  repeated: boolean;
  reliability: "agreed" | "single_reading" | "discrepant";
  tolerance_mm: number;
}

export interface CaptureInfo {
  coin_accepted_frames: number;
  coin_confidence_median: number | null;
  coin_diameter_px: number | null;
  px_per_mm: number | null;
  coin_tilt_deg: number | null;
  depth_correction_factor: number | null;
  estimated_camera_distance_mm: [number, number] | null;
  image_width: number;
  image_height: number;
  detected_handedness: "Left" | "Right" | null;
  landmark_motion_px: number | null;
}

export interface ValidationComparison {
  key: string;
  reference_mm: number;
  estimate_mm: number | null;
  uncertainty_mm: number | null;
  status: string;
  abs_error_mm: number | null;
  pct_error: number | null;
  signed_error_mm: number | null;
  within_95: boolean | null;
}

export interface ValidationRecord {
  schema_version: 2;
  id: string;
  created_at: string;
  data_origin: DataOrigin;
  consent_confirmed: boolean;
  participant_code: string;
  trial: Trial;
  calibration_status: string;
  calibration_validated: boolean;
  config_fingerprint: string;
  app_version: string;
  scan_status: "accepted" | "rejected";
  quality_passed: boolean;
  frames_received: number;
  frames_accepted: number;
  scan_rejection_reasons: string[];
  frame_rejection_counts: Record<string, number>;
  reference: ValidationReference;
  reference_summary: ReferenceSummary;
  conditions: CaptureConditions;
  capture: CaptureInfo;
  comparisons: ValidationComparison[];
  recorded_only: Record<string, number>;
  integrity_flags: string[];
  frames_stored: boolean;
  remote: {
    invite_id: string;
    consent_version: string;
    consent_text_sha256: string;
    consented_at: string;
    helper: "alone" | "with_helper";
    coin_object_id: string;
    coin_check_mm: number;
  } | null;
}

export interface ErrorStats {
  n: number;
  mean_signed_error_mm?: number;
  mae_mm?: number;
  rmse_mm?: number;
  median_abs_error_mm?: number;
  max_abs_error_mm?: number;
  error_sd_mm?: number | null;
  histogram?: { bin_edges_mm: number[]; counts: number[]; below: number; above: number };
  errors_mm?: number[];
}

export interface ConditionShift {
  n_hands: number;
  mean_shift_mm: number;
  max_abs_shift_mm: number;
  exceeds_repeatability: boolean | null;
}

export interface ConditionStats {
  scans: number;
  rejected: number;
  scored: number;
  mean_signed_error_mm: number | null;
  mae_mm: number | null;
}

export interface ParticipantRow {
  participant_code: string;
  hand: "left" | "right";
  reference_mm: number | null;
  reference_reliability: ReferenceSummary["reliability"];
  scans: number;
  rejected: number;
  standard_scored: number;
  standard_mean_signed_error_mm: number | null;
  standard_mae_mm: number | null;
  standard_error_range_mm: [number, number] | null;
  other_conditions_scored: number;
  other_conditions_mean_signed_error_mm: number | null;
}

export interface DistanceBand {
  band: string;
  scans: number;
  rejected: number;
  scans_scored: number;
  hands_scored: number;
  mean_signed_error_mm: number | null;
  mae_mm: number | null;
  sufficient: boolean;
}

export interface DistanceBreakdown {
  rows: DistanceBand[];
  without_distance: number;
  note: string;
}

export interface ValidationSummary {
  config_fingerprint: string;
  calibration: { status: string; validated: boolean };
  real_world: {
    label: string;
    participants: number;
    hands: number;
    scans: {
      total: number;
      accepted: number;
      rejected: number;
      rejected_pct: number | null;
      rejection_reasons: Record<string, number>;
      accepted_without_estimate: number;
    };
    references: Partial<Record<ReferenceSummary["reliability"], number>>;
    accuracy: {
      measurement: string;
      scope: string;
      by_scan: ErrorStats;
      by_hand: ErrorStats;
      n_hands: number;
      within_reported_95_interval: { count: number; of: number };
      sample_note: string;
    };
    conditions: Partial<Record<TrialCondition, ConditionStats>>;
    by_participant: ParticipantRow[];
    by_reference_source: Record<"operator" | "participant", { scans: number; hands_scored: number; by_hand: ErrorStats }>;
    by_distance: {
      scope: string;
      min_hands_per_band: number;
      operator_measured: DistanceBreakdown;
      coin_implied: DistanceBreakdown;
    };
    repeatability: {
      hands_with_repeats: number;
      within_hand_sd_mm: number | null;
      repeatability_coefficient_mm: number | null;
      per_hand: { participant_code: string; hand: string; n: number; mean_mm: number; sd_mm: number; range_mm: number }[];
      condition_shifts: Partial<Record<TrialCondition, ConditionShift>>;
      note: string;
    };
  };
  excluded: Record<string, number>;
  record_flags: Record<string, string[]>;
}

// ----------------------------------------------------------------------------
// Remote pilot (volunteers measure and scan their own hand from an invite link)
// ----------------------------------------------------------------------------

export interface PilotInvite {
  id: string;
  participant_code: string;
  purpose: "pilot" | "test";
  created_at: string;
  expires_at: string;
  submissions: number;
  max_submissions: number;
  enrolled: boolean;
  status: "open" | "complete" | "expired" | "revoked" | "withdrawn";
}

export interface PilotSession {
  participant_code: string;
  purpose: "pilot" | "test";
  consent: { version: string; title: string; paragraphs: string[]; reviewed: boolean };
  coins: { id: string; label: string; diameter_mm: number }[];
  coin_check_tolerance_mm: number;
  enrolment: { hand: "left" | "right"; coin_object_id: string } | null;
  scan_plan: TrialCondition[];
  scans: { condition: TrialCondition; scan_status: "accepted" | "rejected"; reasons: string[] }[];
  submissions: number;
  max_submissions: number;
  expires_at: string;
}

export interface PilotEnrolRequest {
  consent_version: string;
  consent_accepted: true;
  hand: "left" | "right";
  helper: "alone" | "with_helper";
  hand_length: Reading[];
  tool: "ruler" | "tape" | "calipers" | "other";
  coin_object_id: string;
  coin_check: Reading;
  device: string;
}

export interface PilotScanResult {
  scan_status: "accepted" | "rejected";
  reasons: string[];
  submissions: number;
  max_submissions: number;
}
