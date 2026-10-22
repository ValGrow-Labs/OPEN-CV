"""Regression tests for index finger measurement, palm breadth, circumference, and sizing protection."""

import math
import numpy as np
import pytest

from glovesize.config import (
    load_measurement_calibration,
    load_measurement_config,
    load_sizing_charts,
)
from glovesize.landmarks import path_length
from glovesize.measurement import aggregate_measurements, measure_frame
from glovesize.schemas import FrameObservation, ManualMeasurements
from glovesize.sizing import MeasuredValue, recommend
from glovesize.synthetic import CANONICAL_HAND_MM, synthetic_frame
from tests.conftest import QUARTER, frame_obs


@pytest.fixture
def cfg():
    return load_measurement_config()


@pytest.fixture
def calib():
    return load_measurement_calibration()


@pytest.fixture
def charts():
    return load_sizing_charts()


# ============================================================================
# Task 1: Index finger measurement pipeline
# ============================================================================


def test_index_finger_noise_tolerance_across_frames(cfg, calib):
    """If 2 out of 14 frames have minor landmark jitter or bend on index finger,

    aggregation across the remaining 12 clean frames must still produce a valid index length.
    """
    frames = []
    # 12 clean frames
    for _ in range(12):
        f = FrameObservation.model_validate(synthetic_frame(landmark_noise_px=0.5))
        frames.append(measure_frame(f, QUARTER, cfg))

    # 2 frames with bent index finger
    for _ in range(2):
        f_dict = synthetic_frame(landmark_noise_px=0.5)
        f_dict["landmarks"][8]["x"] += 60  # bend index fingertip
        f = FrameObservation.model_validate(f_dict)
        frames.append(measure_frame(f, QUARTER, cfg))

    agg = aggregate_measurements(frames, cfg, calib, None)
    idx = next(m for m in agg.measurements if m.key == "index_length_mm")

    assert idx.status in ("valid", "low_confidence"), f"Expected index finger to be valid, got {idx.status}"
    assert idx.value_mm is not None
    assert idx.frames_used == 12


def test_genuinely_bent_index_finger_rejected(cfg, calib):
    """When the index finger is genuinely bent across frames, it is rejected with reason finger_bent."""
    frames = []
    for _ in range(14):
        f_dict = synthetic_frame(landmark_noise_px=0.5)
        f_dict["landmarks"][8]["x"] += 60  # consistently bent
        f = FrameObservation.model_validate(f_dict)
        res = measure_frame(f, QUARTER, cfg)
        assert res.accepted  # Frame overall is acceptable (hand length is measurable)
        assert res.excluded.get("index_length_mm") == "finger_bent"
        frames.append(res)

    agg = aggregate_measurements(frames, cfg, calib, None)
    idx = next(m for m in agg.measurements if m.key == "index_length_mm")
    assert idx.status == "invalid"
    assert idx.value_mm is None
    assert "finger_bent" in idx.reasons


def test_obscured_index_finger_distinguished_from_bent(cfg, calib):
    """Collapsed or clipped index landmarks are classified as finger_obscured, not finger_bent."""
    # Collapsed segment: landmark 8 positioned right on landmark 7 (distance < 3 px)
    f_dict = synthetic_frame()
    f_dict["landmarks"][8]["x"] = f_dict["landmarks"][7]["x"]
    f_dict["landmarks"][8]["y"] = f_dict["landmarks"][7]["y"]
    f = FrameObservation.model_validate(f_dict)
    res = measure_frame(f, QUARTER, cfg)
    assert res.excluded.get("index_length_mm") == "finger_obscured"


def test_index_finger_not_substituted(cfg_nodepth, calib):
    """Index finger length must match index anatomical landmarks, not substituted with middle finger."""
    f = FrameObservation.model_validate(synthetic_frame(landmark_noise_px=0.0))
    res = measure_frame(f, QUARTER, cfg_nodepth)
    expected_index = path_length(CANONICAL_HAND_MM, [5, 6, 7, 8])
    expected_middle = path_length(CANONICAL_HAND_MM, [9, 10, 11, 12])
    assert abs(res.values["index_length_mm"] - expected_index) < 0.1
    assert abs(res.values["index_length_mm"] - expected_middle) > 5.0


# ============================================================================
# Task 2: Palm breadth (skin edge to skin edge)
# ============================================================================


def test_palm_breadth_not_measured_from_camera(cfg, calib):
    """Palm breadth (skin edge to skin edge) is not measurable from landmark points alone

    and must be explicitly marked 'not_measured' when no validated derived model exists.
    """
    frames = [measure_frame(FrameObservation.model_validate(synthetic_frame()), QUARTER, cfg) for _ in range(14)]
    agg = aggregate_measurements(frames, cfg, calib, None)
    pb = next(m for m in agg.measurements if m.key == "palm_breadth_mm")
    assert pb.status == "not_measured"
    assert pb.value_mm is None
    assert "requires_validated_model_or_manual_entry" in pb.reasons


def test_mcp_span_distinct_from_palm_breadth(cfg, calib):
    """MCP span represents internal knuckle-joint centre distance (landmarks 5 to 17),

    not skin-edge-to-skin-edge palm breadth.
    """
    frames = [measure_frame(FrameObservation.model_validate(synthetic_frame()), QUARTER, cfg) for _ in range(14)]
    agg = aggregate_measurements(frames, cfg, calib, None)
    mcp = next(m for m in agg.measurements if m.key == "mcp_span_mm")
    pb = next(m for m in agg.measurements if m.key == "palm_breadth_mm")
    assert mcp.key != pb.key
    assert mcp.status in ("valid", "low_confidence")
    assert pb.status == "not_measured"


def test_manual_palm_breadth_entry_accepted(cfg, calib):
    """When manual palm breadth is entered, it is reported with status 'user_entered'."""
    frames = [measure_frame(FrameObservation.model_validate(synthetic_frame()), QUARTER, cfg) for _ in range(14)]
    manual = ManualMeasurements(palm_breadth_mm=86.5)
    agg = aggregate_measurements(frames, cfg, calib, manual)
    pb = next(m for m in agg.measurements if m.key == "palm_breadth_mm")
    assert pb.status == "user_entered"
    assert pb.value_mm == 86.5
    assert pb.source == "user_entered"


# ============================================================================
# Task 3: Hand circumference around knuckles
# ============================================================================


def test_circumference_not_measured_without_model(cfg, calib):
    """Hand circumference cannot be measured from a single 2D camera view and must not be fabricated."""
    frames = [measure_frame(FrameObservation.model_validate(synthetic_frame()), QUARTER, cfg) for _ in range(14)]
    agg = aggregate_measurements(frames, cfg, calib, None)
    circ = next(m for m in agg.measurements if m.key == "hand_circumference_mm")
    assert circ.status == "not_measured"
    assert circ.value_mm is None


def test_manual_circumference_entry_accepted(cfg, calib):
    """Customer-entered hand circumference from flexible tape is preserved as user_entered."""
    frames = [measure_frame(FrameObservation.model_validate(synthetic_frame()), QUARTER, cfg) for _ in range(14)]
    manual = ManualMeasurements(hand_circumference_mm=215.0)
    agg = aggregate_measurements(frames, cfg, calib, manual)
    circ = next(m for m in agg.measurements if m.key == "hand_circumference_mm")
    assert circ.status == "user_entered"
    assert circ.value_mm == 215.0


# ============================================================================
# Task 4: Sizing chart protection
# ============================================================================


def test_sizing_chart_hand_length_only_explanation(charts):
    """When a chart uses only hand length (demo-length-v1), explanation clarifies that other

    measurements do not affect glove sizing.
    """
    chart = charts["demo-length-v1"]
    measured = {
        "hand_length_mm": MeasuredValue("hand_length_mm", 181.0, 2.0, "valid"),
        "hand_circumference_mm": MeasuredValue("hand_circumference_mm", 0.0, 0.0, "not_measured"),
    }
    rec = recommend(chart, measured)
    assert rec.status == "recommended"
    assert rec.size == "M"
    assert any("sized by hand length only" in exp for exp in rec.explanation)


def test_sizing_chart_requires_circumference_when_missing(charts):
    """When a chart requires circumference (demo-length-circumference-v1) and circumference

    is not measured, sizing engine returns needs_more_data instead of guessing or using 0.
    """
    chart = charts["demo-length-circumference-v1"]
    measured = {
        "hand_length_mm": MeasuredValue("hand_length_mm", 185.0, 3.0, "valid"),
        "hand_circumference_mm": MeasuredValue("hand_circumference_mm", 0.0, 0.0, "not_measured"),
    }
    rec = recommend(chart, measured)
    assert rec.status == "needs_more_data"
    assert rec.size is None
    assert "hand_circumference_mm" in rec.needed_measurements
    assert any("hand circumference" in exp for exp in rec.explanation)


def test_sizing_with_manual_circumference_succeeds(charts):
    """When manual circumference is provided, multi-dimension sizing succeeds."""
    chart = charts["demo-length-circumference-v1"]
    measured = {
        "hand_length_mm": MeasuredValue("hand_length_mm", 185.0, 3.0, "valid"),
        "hand_circumference_mm": MeasuredValue("hand_circumference_mm", 215.0, 4.0, "user_entered"),
    }
    rec = recommend(chart, measured)
    assert rec.status in ("recommended", "borderline")
    assert rec.size is not None
