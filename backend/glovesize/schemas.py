"""API request/response models.

The browser sends only numeric observations (landmark coordinates, coin-ellipse
parameters and quality metrics). No image data is accepted by these models.
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _finite(v: float) -> float:
    if not math.isfinite(v):
        raise ValueError("must be a finite number")
    return v


class Point(_Model):
    x: float
    y: float
    z: float = 0.0

    _check = field_validator("x", "y", "z")(_finite)


class CoinObservation(_Model):
    center_x: float
    center_y: float
    major_axis_px: float = Field(gt=0, lt=10000)
    minor_axis_px: float = Field(gt=0, lt=10000)
    angle_deg: float
    edge_support: float = Field(ge=0, le=1)
    max_angular_gap_deg: float = Field(ge=0, le=360)
    fit_residual_px: float = Field(ge=0)
    edge_width_px: float = Field(ge=0)
    glare_fraction: float = Field(ge=0, le=1)
    contrast: float = Field(ge=0, le=1)
    n_edge_points: int = Field(ge=0)
    confidence: float = Field(ge=0, le=1)
    accepted: bool
    method: str = Field(default="", max_length=64)
    reasons: list[str] = Field(default_factory=list, max_length=16)

    _check = field_validator("center_x", "center_y", "angle_deg", "fit_residual_px", "edge_width_px")(_finite)

    @model_validator(mode="after")
    def _axes(self) -> CoinObservation:
        if self.minor_axis_px > self.major_axis_px * 1.001:
            raise ValueError("minor_axis_px must not exceed major_axis_px")
        return self


class FrameObservation(_Model):
    timestamp_ms: float = Field(ge=0)
    image_width: int = Field(ge=64, le=8192)
    image_height: int = Field(ge=64, le=8192)
    landmarks: list[Point] = Field(
        min_length=21, max_length=21, description="Image pixels; z is MediaPipe relative depth."
    )
    world_landmarks: list[Point] | None = Field(
        default=None, min_length=21, max_length=21, description="MediaPipe world landmarks (model estimate, metres)."
    )
    handedness: Literal["Left", "Right"] | None = None
    handedness_score: float | None = Field(default=None, ge=0, le=1)
    coin: CoinObservation | None = None
    brightness: float | None = Field(default=None, ge=0, le=255)
    view: str = Field(default="palm", pattern=r"^[a-z][a-z0-9_]{0,15}$", description="Capture view id (config capture.views).")


class ReferenceSelection(_Model):
    object_id: str | None = Field(default=None, max_length=64)
    custom_diameter_mm: float | None = Field(default=None, ge=10, le=60)
    custom_label: str | None = Field(default=None, max_length=80)
    confirmed: bool = Field(
        default=False,
        description="The customer or operator explicitly confirmed which reference object is in the image. "
        "Scans without confirmation are rejected: a circular object is never assumed to be a quarter.",
    )
    size_checked: bool = Field(
        default=False,
        description="The customer confirmed the coin's size, required for coins whose older series differ in size.",
    )

    @model_validator(mode="after")
    def _one_of(self) -> ReferenceSelection:
        if (self.object_id is None) == (self.custom_diameter_mm is None):
            raise ValueError("provide exactly one of object_id or custom_diameter_mm")
        return self


MANUAL_KEYS = ("hand_circumference_mm", "palm_breadth_mm", "hand_length_mm")


class ManualMeasurements(_Model):
    """Tape measurements entered by the customer. The allowed ranges are configuration
    (measurement.json manual_entry_range_mm), wide enough for every hand."""

    hand_circumference_mm: float | None = Field(default=None, gt=0, lt=1000)
    palm_breadth_mm: float | None = Field(default=None, gt=0, lt=1000)
    hand_length_mm: float | None = Field(default=None, gt=0, lt=1000)

    @model_validator(mode="after")
    def _in_range(self) -> ManualMeasurements:
        from .config import load_measurement_config  # late: config is loaded when first needed

        ranges = load_measurement_config().manual_entry_range_mm
        for key, (lo, hi) in ranges.items():
            v = getattr(self, key)
            if v is not None and not lo <= v <= hi:
                raise ValueError(f"{key} must be between {lo:g} and {hi:g} mm")
        return self


class CaptureContext(_Model):
    device_class: Literal["mobile", "desktop", "unknown"] = "unknown"
    camera_facing: Literal["user", "environment", "unknown"] = "unknown"


class ScanRequest(_Model):
    frames: list[FrameObservation] = Field(min_length=1, max_length=240)
    reference: ReferenceSelection
    chart_id: str | None = Field(default=None, max_length=64)
    manual_measurements: ManualMeasurements | None = None
    capture: CaptureContext | None = None

    @model_validator(mode="after")
    def _same_resolution_within_each_view(self) -> ScanRequest:
        """Frames of one view share one image size. Different views may differ: a phone can be
        rotated between views, and every frame carries its own size (measurement.measure_frame)."""
        sizes: dict[str, tuple[int, int]] = {}
        for f in self.frames:
            size = (f.image_width, f.image_height)
            if sizes.setdefault(f.view, size) != size:
                raise ValueError(f"all frames of the {f.view!r} view must have the same image size")
        return self


class Issue(_Model):
    code: str
    severity: Literal["error", "warning", "info"]
    message: str
    frames_affected: int | None = None


MeasurementStatus = Literal["valid", "low_confidence", "invalid", "not_measured", "user_entered"]
MeasurementSource = Literal["camera_landmarks", "camera_model_estimate", "user_entered", "not_available"]


class FingerBendOut(_Model):
    """How bent a finger looked over the scan (median of its accepted frames), against the limits."""

    bend_2d_deg: float = Field(description="Bend seen in the image.")
    bend_3d_deg: float | None = Field(description="Bend in the hand model's depth estimate (noisy, biased).")
    limit_2d_deg: float
    limit_3d_deg: float


class ViewSummary(_Model):
    id: str
    label: str
    frames_received: int
    frames_accepted: int
    used: bool = Field(description="Whether this view's frames went into the measurements.")
    hand_length_mm: float | None = Field(default=None, description="This view's own hand length (calibrated), before combining.")
    reason: str | None = Field(default=None, description="Why an unused view was left out (an issue code).")


class ViewAgreement(_Model):
    hand_length_diff_mm: float
    max_allowed_mm: float
    agree: bool


class MeasurementOut(_Model):
    key: str
    label: str
    value_mm: float | None
    uncertainty_mm: float | None = Field(description="One standard uncertainty (1 sigma), mm.")
    interval95_mm: tuple[float, float] | None
    status: MeasurementStatus
    source: MeasurementSource
    method: str
    definition: str
    calibrated: bool
    frames_used: int = 0
    uncertainty_components_mm: dict[str, float] = Field(default_factory=dict)
    reasons: list[str] = Field(default_factory=list)


class CalibrationOut(_Model):
    reference_label: str
    reference_diameter_mm: float
    custom_reference: bool
    coin_diameter_px: float
    px_per_mm: float
    px_per_mm_rel_uncertainty: float
    coin_tilt_deg: float
    tilt_corrected: bool
    depth_correction_factor: float
    estimated_camera_distance_mm: tuple[float, float]


class SizeByMeasurement(_Model):
    key: str
    value_mm: float
    uncertainty_mm: float
    size: str = Field(description="Size whose range contains the measured value.")
    plausible_sizes: list[str] = Field(description="Sizes overlapping the value +/- 2 sigma interval.")


class RecommendationOut(_Model):
    status: Literal["recommended", "borderline", "needs_more_data", "unavailable"]
    size: str | None
    alternative_size: str | None
    confidence_level: Literal["clear", "likely", "borderline", "uncertain"] | None
    chart_id: str
    manufacturer: str | None
    product_model: str | None
    is_demo_chart: bool
    disclaimer: str | None
    basis: list[str]
    explanation: list[str]
    needed_measurements: list[str]
    plausible_sizes: list[str] = Field(default_factory=list, description="Sizes overlapping the +/- 2 sigma interval.")
    closest_size: str | None = Field(
        default=None,
        description="Only when no single size is supported: the size whose range contains the reading. "
        "Not a recommendation (``size`` stays empty).",
    )
    closest_alternative: str | None = Field(
        default=None, description="With ``closest_size``: the neighbouring size the reading is closer to."
    )
    by_measurement: list[SizeByMeasurement]


class ScanResponse(_Model):
    status: Literal["accepted", "rejected"]
    issues: list[Issue]
    calibration: CalibrationOut | None
    measurements: list[MeasurementOut]
    proportions: dict[str, float]
    frames_received: int
    frames_accepted: int
    frame_rejection_counts: dict[str, int]
    landmarks_px_median: list[Point] | None
    coin_median: CoinObservation | None
    image_width: int
    image_height: int
    recommendation: RecommendationOut | None
    uncertainty_basis: Literal["prior_assumptions", "fitted_unvalidated", "validated"]
    limitations: list[str]
    finger_bends: dict[str, FingerBendOut] = Field(default_factory=dict)
    views: list[ViewSummary] = Field(default_factory=list)
    view_agreement: ViewAgreement | None = None


class MeasurementInput(_Model):
    key: str = Field(max_length=64)
    value_mm: float = Field(gt=0, lt=1000)
    uncertainty_mm: float = Field(ge=0, lt=200)
    status: MeasurementStatus = "valid"


class RecommendRequest(_Model):
    chart_id: str | None = Field(default=None, max_length=64)
    measurements: list[MeasurementInput] = Field(min_length=1, max_length=32)
