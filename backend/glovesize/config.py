"""Loading and validation of the JSON configuration in ``config/``.

All numeric thresholds, reference-object dimensions, measurement definitions
and sizing charts live in configuration files so that they can be changed
without touching measurement code.
"""

from __future__ import annotations

import json
import os
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

REPO_ROOT = Path(__file__).resolve().parents[2]


def config_dir() -> Path:
    return Path(os.environ.get("GLOVESIZE_CONFIG_DIR", REPO_ROOT / "config"))


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# --------------------------------------------------------------------------- #
# Reference objects
# --------------------------------------------------------------------------- #


class ReferenceObject(_Strict):
    id: str
    label: str
    shape: Literal["circle"]
    diameter_mm: float = Field(gt=5, lt=100)
    diameter_uncertainty_mm: float = Field(ge=0, lt=2)
    thickness_mm: float | None = Field(default=None, ge=0, lt=10)
    source: str
    enabled: bool = True
    # "pilot": offered only in the remote pilot, where the volunteer also measures the coin with a
    # ruler (some coins exist in several sizes under the same name). Refused by /api/scan.
    availability: Literal["all", "pilot"] = "all"
    # True when older coins with the same name but a different size are still in circulation:
    # the customer must confirm the size before scanning (the server refuses unconfirmed scans).
    size_check: bool = False
    customer_hint: str | None = Field(default=None, max_length=160)
    notes: str | None = None


class ReferenceObjectsConfig(_Strict):
    schema_version: int
    default: str
    objects: list[ReferenceObject]

    @model_validator(mode="after")
    def _check_default(self) -> ReferenceObjectsConfig:
        ids = [o.id for o in self.objects]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate reference object ids")
        default = self.get(self.default)
        if default is None or not default.enabled:
            raise ValueError(f"default reference object {self.default!r} missing or disabled")
        return self

    def get(self, object_id: str) -> ReferenceObject | None:
        return next((o for o in self.objects if o.id == object_id), None)


# --------------------------------------------------------------------------- #
# Measurement system parameters
# --------------------------------------------------------------------------- #


class CoinAcceptance(_Strict):
    min_edge_support: float = Field(gt=0, le=1)
    max_angular_gap_deg: float = Field(gt=0, le=360)
    max_fit_residual_px: float = Field(gt=0)
    max_fit_residual_rel: float = Field(gt=0, lt=1)
    max_edge_width_px: float = Field(gt=0)
    max_glare_fraction: float = Field(ge=0, le=1)
    min_contrast: float = Field(ge=0, le=1)
    min_confidence: float = Field(ge=0, le=1)


class CoinScoreParams(_Strict):
    """Linear ramps of the heuristic detection-quality score: 1 at *good*, 0 at *bad*.
    *bad* values are given as factors of the matching acceptance threshold."""

    edge_support_good: float
    edge_support_bad: float
    angular_gap_good_deg: float
    angular_gap_bad_factor: float
    fit_residual_good_px: float
    fit_residual_bad_factor: float
    edge_width_good_px: float
    edge_width_bad_factor: float
    glare_good: float
    glare_bad_factor: float
    contrast_good: float
    contrast_bad_factor: float


class CoinDetectionParams(_Strict):
    clahe_clip_limit: float = Field(gt=0)
    clahe_tile_grid: int = Field(ge=1)
    blur_kernel: int = Field(ge=1)
    canny_high: float = Field(gt=0)
    canny_low_ratio: float = Field(gt=0, lt=1)
    min_contour_circularity: float = Field(gt=0, le=1)
    min_axis_ratio: float = Field(gt=0, le=1)
    hough_dp: float = Field(ge=1)
    hough_param2: float = Field(gt=0)
    max_candidates: int = Field(ge=1)
    radial_rays: int = Field(ge=16)
    radial_search_fraction: float = Field(gt=0, lt=0.5)
    radial_step_px: float = Field(gt=0)
    edge_strength_min: float = Field(ge=0)
    edge_strength_rel: float = Field(ge=0, le=1)
    outlier_mad_k: float = Field(gt=0)
    min_diameter_px: float = Field(gt=0)
    glare_level: int = Field(ge=0, le=255)
    search_roi_half_size_palm_lengths: float = Field(gt=0)
    search_diameter_range_palm_lengths: tuple[float, float]
    narrow_search_fraction: float = Field(gt=0, lt=0.5)
    candidate_size_tolerance: tuple[float, float]
    ambiguity_confidence_ratio: float = Field(gt=0, le=1)
    score: CoinScoreParams
    accept: CoinAcceptance

    @field_validator("blur_kernel")
    @classmethod
    def _odd(cls, v: int) -> int:
        if v % 2 == 0:
            raise ValueError("blur_kernel must be odd")
        return v


class CalibrationParams(_Strict):
    max_tilt_deg: float = Field(gt=0, lt=60)
    # Frames averaged to estimate the coin tilt (see calibration.smoothed_coin_tilts); 1 = per frame.
    tilt_window_frames: int = Field(ge=1, le=15)
    warn_tilt_deg: float = Field(gt=0, lt=60)
    tilt_correction_min_deg: float = Field(ge=0, lt=60)
    tilt_rectification: bool
    diameter_edge_floor_px: float = Field(ge=0)
    require_coin_on_palm: bool
    custom_reference_uncertainty_mm: float = Field(ge=0)
    custom_reference_thickness_mm: float = Field(ge=0)


class CaptureParams(_Strict):
    frames_target: int = Field(ge=1)
    frames_min_accepted: int = Field(ge=1)
    max_frames_per_request: int = Field(ge=1)
    min_hand_length_fraction: float = Field(gt=0, lt=1)
    edge_margin_fraction: float = Field(ge=0, lt=0.5)
    max_finger_bend_deg: float = Field(gt=0, lt=180)
    max_finger_bend_deg_3d: float = Field(gt=0, lt=180)
    max_palm_tilt_deg_model: float = Field(gt=0, lt=90)
    brightness_range: tuple[float, float]
    max_landmark_jitter_fraction: float = Field(gt=0)
    min_camera_distance_mm: float = Field(ge=0)
    max_frame_rel_sd: float = Field(gt=0)


class LiveScanParams(_Strict):
    """The browser's scan loop (frontend/src/scan/scanController.ts). These only decide which frames
    the phone collects and how quickly a scan finishes; the server re-checks every frame."""

    min_frame_interval_ms: float = Field(ge=0)
    full_coin_search_every: int = Field(ge=1)
    track_min_confidence: float = Field(ge=0, le=1)
    palm_mask_grow: float | None = Field(default=None, ge=1)  # None: search the whole window
    mobile_frames_target: int = Field(ge=1)
    mobile_frames_min: int = Field(ge=1)
    timeout_s: float = Field(gt=0)
    early_stop_frames_mobile: int = Field(ge=1)
    early_stop_frames_desktop: int = Field(ge=1)
    early_stop_rel_sd: float = Field(gt=0)
    early_stop_after_s: float = Field(ge=0)
    # Guidance: after hint_after_s without a usable frame, name the most common problem over the
    # last issue_window_s seconds. Live (per-frame, rough) lengths drawn on the camera picture.
    hint_after_s: float = Field(ge=0)
    issue_window_s: float = Field(gt=0)
    show_live_measurements: bool
    # Live guidance is shown for the problem that dominates the last guidance_window_ms (at least
    # guidance_min_share of frames), kept for guidance_hold_ms, so the message does not flicker.
    guidance_window_ms: float = Field(gt=0)
    guidance_hold_ms: float = Field(ge=0)
    guidance_min_share: float = Field(gt=0, le=1)
    guidance_keep_share: float = Field(ge=0, le=1)
    guidance_switch_margin: float = Field(ge=0, le=1)  # a new problem must beat the shown one by this share
    # Camera exposure compensation (where the browser allows it): eased down while the coin is
    # blown out, up while the picture is dark, in steps no faster than exposure_hold_ms.
    auto_exposure: bool
    exposure_step_ev: float = Field(gt=0)
    exposure_min_ev: float
    exposure_max_ev: float
    exposure_hold_ms: float = Field(ge=0)
    exposure_min_share: float = Field(gt=0, le=1)


class UncertaintyParams(_Strict):
    landmark_model_input_px: float = Field(gt=0)
    landmark_sigma_model_px: float = Field(ge=0)
    landmark_roi_scale: float = Field(gt=0)
    perspective_rel_sigma: float = Field(ge=0)
    assumed_hfov_deg: tuple[float, float]
    tilt_estimate_sigma_deg: float = Field(ge=0)
    manual_measurement_sd_mm: float = Field(gt=0)
    tilt_pitch_coefficient: float = Field(ge=0)
    unstable_rel_sd: float = Field(gt=0)


class DepthModelParams(_Strict):
    """Corrects for the coin's top face and the landmark (joint-centre) layer lying at
    different distances from the camera; see docs/MEASUREMENT_METHODOLOGY.md."""

    enabled: bool
    landmark_layer_depth_mm: float = Field(ge=0, lt=40)
    landmark_layer_depth_sd_mm: float = Field(ge=0, lt=40)


class AcceptanceParams(_Strict):
    max_rel_u95_valid: float = Field(gt=0)
    max_rel_u95_low_confidence: float = Field(gt=0)


class MeasurementDef(_Strict):
    label: str
    landmarks: list[int] = Field(min_length=2)
    kind: Literal["straight", "polyline"]
    definition: str
    out_of_plane: bool = False
    plausible_range_mm: tuple[float, float]

    @field_validator("landmarks")
    @classmethod
    def _indices(cls, v: list[int]) -> list[int]:
        if any(i < 0 or i > 20 for i in v):
            raise ValueError("landmark indices must be in 0..20")
        return v


class MeasurementConfig(_Strict):
    schema_version: int
    coin_detection: CoinDetectionParams
    calibration: CalibrationParams
    capture: CaptureParams
    live_scan: LiveScanParams
    uncertainty: UncertaintyParams
    depth_model: DepthModelParams
    acceptance: AcceptanceParams
    measurements: dict[str, MeasurementDef]


# --------------------------------------------------------------------------- #
# Calibration fitted from reference measurements
# --------------------------------------------------------------------------- #


class CalibrationEntry(_Strict):
    scale: float = Field(gt=0.5, lt=1.5)
    offset_mm: float
    residual_sd_mm: float = Field(ge=0)


class DerivedModel(_Strict):
    """Linear model ``target = intercept + sum(coef * predictor)`` fitted on reference data."""

    predictors: dict[str, float]
    intercept_mm: float
    residual_sd_mm: float = Field(gt=0)
    n_participants: int = Field(ge=1)


# Held-out real participants required before a calibration may be signed off as validated
# (docs/VALIDATION_PLAN.md: >= 120 participants, half of them in the held-out test split).
MIN_VALIDATION_PARTICIPANTS = 60


class CalibrationValidation(_Strict):
    """Human sign-off that a fitted calibration met the agreed acceptance criteria on held-out,
    real-world reference measurements. No code in this repository writes this block: fitting
    produces ``status: calibrated`` with ``validation: null``, which is reported as "fitted, not
    validated" until a person adds the evidence below."""

    real_world: Literal[True]
    held_out_participants: int = Field(ge=MIN_VALIDATION_PARTICIPANTS)
    acceptance_criteria_met: Literal[True]
    report: str = Field(
        min_length=1, max_length=200, description="Identifier or path of the held-out evaluation report."
    )
    approved_by: str = Field(min_length=1, max_length=80, description="Role or staff ID of the reviewer.")
    approved_at: date


class MeasurementCalibration(_Strict):
    status: Literal["uncalibrated", "calibrated"]
    source: str
    fitted_at: str | None = None
    n_participants: int = 0
    measurements: dict[str, CalibrationEntry]
    derived: dict[str, DerivedModel | None] = Field(default_factory=dict)
    validation: CalibrationValidation | None = None

    @model_validator(mode="after")
    def _validation_needs_fit(self) -> MeasurementCalibration:
        if self.validation is not None and self.status != "calibrated":
            raise ValueError("an uncalibrated configuration cannot carry validation evidence")
        return self

    @property
    def validated(self) -> bool:
        """True only for a fitted calibration with human-approved, held-out real-world evidence."""
        return self.status == "calibrated" and self.validation is not None


# --------------------------------------------------------------------------- #
# Sizing charts
# --------------------------------------------------------------------------- #

Range = tuple[float | None, float | None]


class SizeBand(_Strict):
    label: str = Field(min_length=1, max_length=16)
    ranges: dict[str, Range]


class SizingRules(_Strict):
    measurements: list[str] = Field(min_length=1)
    combine: Literal["primary_only", "largest_size"]
    notes: str | None = None


class SizingChart(_Strict):
    chart_id: str
    is_demo: bool
    disclaimer: str | None = None
    manufacturer: str | None = None
    product_model: str | None = None
    units: Literal["mm"] = "mm"
    rules: SizingRules
    sizes: list[SizeBand] = Field(min_length=1)

    @model_validator(mode="after")
    def _validate_bands(self) -> SizingChart:
        if self.is_demo and not self.disclaimer:
            raise ValueError("demo charts must carry a disclaimer")
        labels = [s.label for s in self.sizes]
        if len(labels) != len(set(labels)):
            raise ValueError("duplicate size labels")
        for key in self.rules.measurements:
            prev_max: float | None = None
            for i, band in enumerate(self.sizes):
                if key not in band.ranges:
                    raise ValueError(f"size {band.label} lacks a range for {key}")
                lo, hi = band.ranges[key]
                if lo is None and i != 0:
                    raise ValueError(f"only the smallest size may have an open lower bound ({key})")
                if hi is None and i != len(self.sizes) - 1:
                    raise ValueError(f"only the largest size may have an open upper bound ({key})")
                if lo is not None and hi is not None and not lo < hi:
                    raise ValueError(f"empty range for {band.label} / {key}")
                if prev_max is not None and lo is not None and lo < prev_max:
                    raise ValueError(f"overlapping ranges at {band.label} / {key}")
                prev_max = hi
        return self


# --------------------------------------------------------------------------- #
# Loaders
# --------------------------------------------------------------------------- #


def _read(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def load_reference_objects() -> ReferenceObjectsConfig:
    return ReferenceObjectsConfig.model_validate(_read(config_dir() / "reference_objects.json"))


@lru_cache(maxsize=1)
def load_measurement_config() -> MeasurementConfig:
    return MeasurementConfig.model_validate(_read(config_dir() / "measurement.json"))


@lru_cache(maxsize=1)
def load_measurement_calibration() -> MeasurementCalibration:
    return MeasurementCalibration.model_validate(_read(config_dir() / "measurement_calibration.json"))


@lru_cache(maxsize=1)
def load_sizing_charts() -> dict[str, SizingChart]:
    charts: dict[str, SizingChart] = {}
    for path in sorted((config_dir() / "sizing_charts").glob("*.json")):
        chart = SizingChart.model_validate(_read(path))
        if chart.chart_id in charts:
            raise ValueError(f"duplicate chart_id {chart.chart_id} in {path.name}")
        charts[chart.chart_id] = chart
    if not charts:
        raise ValueError("no sizing charts configured")
    return charts


class AppConfig(_Strict):
    default_chart_id: str
    research_collection_enabled: bool = False
    research_retention_days: int = Field(default=365, ge=1, le=3650)
    validation_mode_enabled: bool = False
    # Two physical readings of the same hand further apart than this need a third reading
    # before the reference is treated as reliable (docs/PILOT_PROTOCOL.md).
    validation_reference_tolerance_mm: float = Field(default=2.0, gt=0, le=10)
    # Save each validation scan's per-frame numeric observations (never images) so that pilot
    # scans can be re-measured with a changed configuration.
    validation_store_frame_data: bool = True
    # Remote pilot (glovesize/remote_pilot.py): invited volunteers measure and scan their own hand.
    # Needs validation mode too; off unless switched on here or with GLOVESIZE_PILOT_REMOTE_ENABLED.
    pilot_remote_enabled: bool = False
    pilot_invite_days: int = Field(default=30, ge=1, le=180)
    pilot_max_submissions: int = Field(default=20, ge=1, le=100)
    pilot_coin_check_tolerance_mm: float = Field(default=1.5, gt=0, le=3)


@lru_cache(maxsize=1)
def load_app_config() -> AppConfig:
    cfg = AppConfig.model_validate(_read(config_dir() / "app.json"))
    env = os.environ.get("GLOVESIZE_RESEARCH_ENABLED")
    if env is not None:
        cfg = cfg.model_copy(update={"research_collection_enabled": env.lower() in {"1", "true", "yes"}})
    env = os.environ.get("GLOVESIZE_VALIDATION_ENABLED")
    if env is not None:
        cfg = cfg.model_copy(update={"validation_mode_enabled": env.lower() in {"1", "true", "yes"}})
    env = os.environ.get("GLOVESIZE_PILOT_REMOTE_ENABLED")
    if env is not None:
        cfg = cfg.model_copy(update={"pilot_remote_enabled": env.lower() in {"1", "true", "yes"}})
    return cfg


class PilotConsent(_Strict):
    """Consent text shown to remote pilot volunteers (config/pilot_consent.json). Invitations for
    real participants are refused until a person has reviewed the text and recorded it here."""

    version: str = Field(min_length=1, max_length=40)
    reviewed: bool
    reviewed_by: str | None = Field(default=None, max_length=80)
    reviewed_at: date | None = None
    title: str = Field(min_length=1, max_length=120)
    paragraphs: list[str] = Field(min_length=1, max_length=30)

    @model_validator(mode="after")
    def _review(self) -> PilotConsent:
        if self.reviewed:
            if not self.reviewed_by or self.reviewed_at is None:
                raise ValueError("a reviewed consent text needs reviewed_by and reviewed_at")
            text = " ".join(self.paragraphs)
            if "DRAFT" in text or "[" in text:
                raise ValueError("remove the draft notice and fill every [placeholder] before marking it reviewed")
        return self


@lru_cache(maxsize=1)
def load_pilot_consent() -> PilotConsent:
    return PilotConsent.model_validate(_read(config_dir() / "pilot_consent.json"))


def default_chart_id() -> str:
    charts = load_sizing_charts()
    chart_id = os.environ.get("GLOVESIZE_DEFAULT_CHART") or load_app_config().default_chart_id
    if chart_id not in charts:
        raise ValueError(f"default chart {chart_id!r} is not configured")
    return chart_id


def clear_caches() -> None:
    for fn in (
        load_reference_objects,
        load_measurement_config,
        load_measurement_calibration,
        load_sizing_charts,
        load_app_config,
        load_pilot_consent,
    ):
        fn.cache_clear()
