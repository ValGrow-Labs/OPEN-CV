"""Loading and validation of the JSON configuration in ``config/``.

All numeric thresholds, reference-object dimensions, measurement definitions
and sizing charts live in configuration files so that they can be changed
without touching measurement code.
"""

from __future__ import annotations

import json
import os
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
    accept: CoinAcceptance

    @field_validator("blur_kernel")
    @classmethod
    def _odd(cls, v: int) -> int:
        if v % 2 == 0:
            raise ValueError("blur_kernel must be odd")
        return v


class CalibrationParams(_Strict):
    max_tilt_deg: float = Field(gt=0, lt=60)
    warn_tilt_deg: float = Field(gt=0, lt=60)
    tilt_correction_min_deg: float = Field(ge=0, lt=60)
    diameter_edge_floor_px: float = Field(ge=0)
    require_coin_on_palm: bool


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


class UncertaintyParams(_Strict):
    landmark_model_input_px: float = Field(gt=0)
    landmark_sigma_model_px: float = Field(ge=0)
    perspective_rel_sigma: float = Field(ge=0)
    assumed_hfov_deg: tuple[float, float]
    tilt_estimate_sigma_deg: float = Field(ge=0)
    manual_measurement_sd_mm: float = Field(gt=0)


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


class MeasurementCalibration(_Strict):
    status: Literal["uncalibrated", "calibrated"]
    source: str
    fitted_at: str | None = None
    n_participants: int = 0
    measurements: dict[str, CalibrationEntry]
    derived: dict[str, DerivedModel | None] = Field(default_factory=dict)


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


@lru_cache(maxsize=1)
def load_app_config() -> AppConfig:
    cfg = AppConfig.model_validate(_read(config_dir() / "app.json"))
    env = os.environ.get("GLOVESIZE_RESEARCH_ENABLED")
    if env is not None:
        cfg = cfg.model_copy(update={"research_collection_enabled": env.lower() in {"1", "true", "yes"}})
    return cfg


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
    ):
        fn.cache_clear()
