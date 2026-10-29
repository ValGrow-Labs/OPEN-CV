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
from glovesize.pipeline import process_scan
from glovesize.schemas import FrameObservation, ManualMeasurements, ScanRequest
from glovesize.sizing import MeasuredValue, recommend
from glovesize.synthetic import CANONICAL_HAND_MM, synthetic_frame
from tests.conftest import QUARTER, frame_obs, make_frames, single_view


@pytest.fixture
def cfg():
    return single_view(load_measurement_config())  # one palm scan; the production views: test_multi_view.py


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


# ============================================================================
# Priority 3 & 4: SPLNTD specifications & API health/timeout guards
# ============================================================================


def test_splntd_reference_specifications_context(cfg_nodepth):
    """Verify that canonical finger lengths are anatomically close to the SPLNTD reference standards:

    - Index: 75 mm (canonical ~82 mm)
    - Middle: 90 mm (canonical ~90 mm)
    - Ring: 75 mm (canonical ~83 mm)
    - Little: 60 mm (canonical ~67 mm)
    - Thumb: 60 mm (canonical ~62 mm)
    And circumferences are NOT fabricated from lengths.
    """
    f = FrameObservation.model_validate(synthetic_frame(landmark_noise_px=0.0))
    res = measure_frame(f, QUARTER, cfg_nodepth)

    # Middle finger in canonical geometry (from knuckle joint center 9 to tip 12) is ~99.8 mm
    # (about 10 mm longer than palmar crease measurement of 90 mm)
    assert 85.0 <= res.values["middle_length_mm"] <= 105.0
    # Index finger is ~82 mm (within realistic adult range of SPLNTD 75 mm)
    assert 70.0 <= res.values["index_length_mm"] <= 90.0
    # Little finger is ~67 mm (within realistic range of SPLNTD 60 mm)
    assert 55.0 <= res.values["little_length_mm"] <= 75.0
    # Thumb length (MCP 2 to tip 4) is ~42 mm; full thumb to CMC is ~60 mm
    assert 35.0 <= res.values["thumb_length_mm"] <= 75.0

    # Ensure circumferences are not fabricated inside frame values
    for circ_key in ("hand_circumference_mm", "index_circumference_mm", "base_circumference_mm"):
        assert circ_key not in res.values


def test_api_health_endpoint():
    """Verify FastAPI health check endpoint for pre-warming deployed containers."""
    from fastapi.testclient import TestClient
    from glovesize.api import app

    client = TestClient(app)
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json().get("status") == "ok"


# ============================================================================
# Section 5: Post-scan validation and measurement-to-sizing pipeline tests
# ============================================================================


def _scan_request(frames, **kw):
    body = {"frames": frames, "reference": {"object_id": "us_quarter", "confirmed": True}}
    body.update(kw)
    return ScanRequest.model_validate(body)


def test_ten_of_ten_valid_frames_accepted(no_depth_config):
    """10 of 10 valid frames must be accepted and successfully produce measurements & sizing output."""
    r = process_scan(_scan_request(make_frames(n=10)))
    assert r.status == "accepted"
    assert r.frames_accepted == 10
    assert r.frames_received == 10
    hl = next(m for m in r.measurements if m.key == "hand_length_mm")
    assert hl.status == "valid"
    assert hl.value_mm == pytest.approx(185.0, abs=1.5)
    assert r.recommendation is not None
    assert r.recommendation.is_demo_chart is True
    # Plausible sizes covers S, M, L honestly
    assert "M" in r.recommendation.plausible_sizes


def test_eight_of_eight_mobile_frames_accepted(no_depth_config):
    """8 of 8 valid frames on mobile must be accepted without contradictory rejection."""
    r = process_scan(_scan_request(make_frames(n=8), capture={"device_class": "mobile"}))
    assert r.status == "accepted"
    assert r.frames_accepted == 8
    assert r.frames_received == 8
    hl = next(m for m in r.measurements if m.key == "hand_length_mm")
    assert hl.status == "valid"
    assert hl.value_mm == pytest.approx(185.0, abs=1.5)
    assert r.recommendation is not None
    assert "M" in r.recommendation.plausible_sizes


def test_calibrated_scan_produces_recommended_size(charts):
    """When measurements have calibrated uncertainty, sizing engine recommends the size."""
    chart = charts["demo-length-v1"]
    # Hand length 181 mm with 1.5 mm uncertainty lies clearly inside M (175-187 mm)
    rec = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 181.0, 1.5, "valid")})
    assert rec.status == "recommended"
    assert rec.size == "M"
    assert rec.confidence_level == "clear"


def test_insufficient_frames_rejection_reports_frame_counts(no_depth_config):
    """Fewer than minimum required frames (e.g. 5 frames) is rejected honestly."""
    r = process_scan(_scan_request(make_frames(n=5)))
    assert r.status == "rejected"
    assert r.frames_accepted == 5
    assert r.frames_received == 5
    assert r.issues[0].code == "insufficient_frames"


def test_sizing_chart_boundary_classification(charts):
    """Test every size boundary on the configured demo-length-v1 chart."""
    chart = charts["demo-length-v1"]
    # XS < 163
    rec_xs = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 160.0, 1.0, "valid")})
    assert rec_xs.size == "XS"

    # S 163-175
    rec_s = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 169.0, 1.0, "valid")})
    assert rec_s.size == "S"

    # M 175-187
    rec_m = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 181.0, 1.0, "valid")})
    assert rec_m.size == "M"

    # L 187-199
    rec_l = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 193.0, 1.0, "valid")})
    assert rec_l.size == "L"

    # XL 199-211
    rec_xl = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 205.0, 1.0, "valid")})
    assert rec_xl.size == "XL"

    # XXL >= 211
    rec_xxl = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 215.0, 1.0, "valid")})
    assert rec_xxl.size == "XXL"


def test_sizing_near_boundary_borderline(charts):
    """A measurement right on a size boundary (e.g. 175.0 mm between S and M) reports borderline and alternative."""
    chart = charts["demo-length-v1"]
    rec = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 175.0, 1.5, "valid")})
    assert rec.status == "borderline"
    assert rec.size == "M"
    assert rec.alternative_size == "S"


def test_sizing_large_uncertainty_needs_more_data(charts):
    """When uncertainty spans 3+ sizes, recommendation returns needs_more_data instead of guessing."""
    chart = charts["demo-length-v1"]
    rec = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 180.0, 15.0, "valid")})
    assert rec.status == "needs_more_data"
    assert rec.size is None
    assert rec.confidence_level == "uncertain"
    assert len(rec.plausible_sizes) >= 3


def test_uncertain_scan_names_the_closest_size_without_recommending_it(charts):
    """The video case: 174 mm +/- 7.7 mm on a chart of 12 mm sizes. No size is recommended, but the
    customer is told which size the reading falls in and which neighbour it is closer to."""
    chart = charts["demo-length-v1"]
    rec = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 174.0, 7.7, "low_confidence")})
    assert rec.status == "needs_more_data"
    assert rec.size is None and rec.alternative_size is None  # still not a recommendation
    assert rec.confidence_level == "uncertain"
    assert rec.plausible_sizes == ["XS", "S", "M", "L"]
    assert rec.closest_size == "S"  # 163-175 mm
    assert rec.closest_alternative == "M"  # 174 is 1 mm from the S/M boundary at 175

    lower = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 165.0, 7.7, "low_confidence")})
    assert lower.closest_size == "S" and lower.closest_alternative == "XS"


def test_closest_size_is_only_set_when_no_size_is_supported(charts):
    chart = charts["demo-length-v1"]
    rec = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 181.0, 2.0, "valid")})
    assert rec.size == "M" and rec.closest_size is None and rec.closest_alternative is None
    missing = recommend(chart, {})
    assert missing.closest_size is None


def test_missing_hand_length_measurement_explains_reason(charts):
    """When hand_length_mm is invalid with reasons, sizing explains the camera failure honestly."""
    chart = charts["demo-length-v1"]
    rec = recommend(
        chart,
        {"hand_length_mm": MeasuredValue("hand_length_mm", 0.0, 0.0, "invalid", reasons=("finger_bent",))},
    )
    assert rec.status == "needs_more_data"
    assert rec.size is None
    assert any("not straight enough" in exp for exp in rec.explanation)


def test_circumference_and_palm_breadth_unavailable_without_validated_model(no_depth_config):
    """Hand circumference and palm breadth remain 'not_measured' and 'not_available' without validated model."""
    r = process_scan(_scan_request(make_frames(n=10)))
    circ = next(m for m in r.measurements if m.key == "hand_circumference_mm")
    assert circ.status == "not_measured"
    assert circ.source == "not_available"
    assert circ.value_mm is None

    breadth = next(m for m in r.measurements if m.key == "palm_breadth_mm")
    assert breadth.status == "not_measured"
    assert breadth.source == "not_available"
    assert breadth.value_mm is None


