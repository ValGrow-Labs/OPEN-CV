"""Automated regression tests for accuracy, scaling, uncertainty, and performance.

Covers:
1. Pixel-to-millimetre conversion and coin calibration.
2. Depth-layer correction and thickness fallback.
3. Landmark coordinate scaling and aspect ratio handling.
4. Shorter anatomical feature uncertainty handling (palm width, fingers, thumb).
5. Invalid measurements and uncertainty budget validation.
6. Size classification boundaries and guard rails.
"""

import math
import numpy as np
import pytest

from glovesize.calibration import (
    ReferenceSpec,
    camera_distance_range_mm,
    coin_tilt_deg,
    frame_scale,
    resolve_reference,
)
from glovesize.config import (
    load_measurement_calibration,
    load_measurement_config,
    load_reference_objects,
    load_sizing_charts,
)
from glovesize.landmarks import chain_bend_deg, inside_frame, path_length
from glovesize.measurement import (
    Z95,
    aggregate_measurements,
    classify,
    measure_frame,
)
from glovesize.schemas import CoinObservation, FrameObservation, ReferenceSelection
from glovesize.sizing import MeasuredValue, band_index, recommend
from glovesize.synthetic import CANONICAL_HAND_MM, synthetic_frame
from tests.conftest import QUARTER, frame_obs


@pytest.fixture
def cfg():
    return load_measurement_config()


@pytest.fixture
def calib():
    return load_measurement_calibration()


@pytest.fixture
def refs():
    return load_reference_objects()


# --------------------------------------------------------------------------- #
# 1. Pixel-to-millimetre conversion and resolution invariance
# --------------------------------------------------------------------------- #


def test_px_to_mm_conversion_across_resolutions(cfg):
    """A hand of the same physical size at the same distance must yield identical millimetres
    regardless of camera resolution (e.g. 640x480 vs 1280x720 vs 1920x1080)."""
    # Suppose a 185 mm hand at 350 mm distance.
    # At 720p: coin is 77.6 px (px_per_mm_coin = 3.20)
    # At 1080p: coin is 116.4 px (px_per_mm_coin = 4.80)
    # At 480p: coin is 51.7 px (px_per_mm_coin = 2.13)
    mms = []
    for w, h, coin_px, hand_len_px in [
        (640, 480, 50.0, 381.28),
        (1280, 720, 100.0, 762.57),
        (1920, 1080, 150.0, 1143.85),
    ]:
        coin = CoinObservation(
            center_x=w / 2,
            center_y=h / 2,
            major_axis_px=coin_px,
            minor_axis_px=coin_px,
            angle_deg=0.0,
            edge_support=0.95,
            max_angular_gap_deg=10.0,
            fit_residual_px=0.3,
            edge_width_px=2.0,
            glare_fraction=0.01,
            contrast=0.1,
            n_edge_points=120,
            confidence=0.9,
            accepted=True,
            method="test",
            reasons=[],
        )
        scale = frame_scale(coin, QUARTER, w, h, cfg)
        mm = hand_len_px / scale.px_per_mm
        mms.append(mm)

    # All resolutions must reconstruct the exact same physical dimension
    assert mms[0] == pytest.approx(mms[1], rel=1e-3)
    assert mms[1] == pytest.approx(mms[2], rel=1e-3)


def test_orientation_aspect_ratio_invariance(cfg):
    """Switching between landscape (1280x720) and portrait (720x1280) on mobile
    must estimate the same distance and scale for a centered coin."""
    coin_px = 80.0
    d_landscape = camera_distance_range_mm(coin_px, QUARTER.diameter_mm, 1280, 720, cfg.uncertainty.assumed_hfov_deg)
    d_portrait = camera_distance_range_mm(coin_px, QUARTER.diameter_mm, 720, 1280, cfg.uncertainty.assumed_hfov_deg)
    assert d_landscape == pytest.approx(d_portrait)


# --------------------------------------------------------------------------- #
# 2. Coin calibration and thickness fallback
# --------------------------------------------------------------------------- #


def test_coin_thickness_fallback_for_inr_coin(refs, cfg):
    """When a reference spec has thickness_mm: None (e.g. INR 2 coin),
    resolve_reference must apply the documented custom_reference_thickness_mm."""
    inr_sel = ReferenceSelection(object_id="inr_2_2019", confirmed=True)
    spec = resolve_reference(inr_sel, refs, cfg.calibration)
    assert spec is not None
    assert spec.diameter_mm == 23.0
    assert spec.thickness_mm == cfg.calibration.custom_reference_thickness_mm
    assert spec.thickness_mm > 0


def test_coin_tilt_computation():
    """Verify coin tilt angle from minor/major axis ratio."""
    # Flat coin
    assert coin_tilt_deg(CoinObservation(
        center_x=0, center_y=0, major_axis_px=100.0, minor_axis_px=100.0,
        angle_deg=0, edge_support=1, max_angular_gap_deg=0, fit_residual_px=0,
        edge_width_px=0, glare_fraction=0, contrast=0, n_edge_points=100,
        confidence=1, accepted=True, method="", reasons=[],
    )) == pytest.approx(0.0)

    # 15 degree tilt: cos(15 deg) ≈ 0.9659
    assert coin_tilt_deg(CoinObservation(
        center_x=0, center_y=0, major_axis_px=100.0, minor_axis_px=96.59258,
        angle_deg=0, edge_support=1, max_angular_gap_deg=0, fit_residual_px=0,
        edge_width_px=0, glare_fraction=0, contrast=0, n_edge_points=100,
        confidence=1, accepted=True, method="", reasons=[],
    )) == pytest.approx(15.0, abs=0.05)


# --------------------------------------------------------------------------- #
# 3. Landmark coordinate scaling and margin checks
# --------------------------------------------------------------------------- #


def test_inside_frame_margin_boundary():
    """Landmarks must stay within the configured frame margin fraction."""
    w, h = 1000, 1000
    margin = 0.02  # 20 px margin
    pts = np.array([[21, 21], [500, 500], [979, 979]], dtype=np.float64)
    assert inside_frame(pts, w, h, margin)

    pts_edge = np.array([[19, 500], [500, 500]], dtype=np.float64)
    assert not inside_frame(pts_edge, w, h, margin)


def test_chain_bend_natural_vs_bent():
    """Verify cumulative joint bend angles across natural human extension vs curled finger."""
    # Perfectly collinear points: 0 degrees
    collinear = np.array([[0, 0], [0, 30], [0, 60], [0, 90]], dtype=np.float64)
    assert chain_bend_deg(collinear, (0, 1, 2, 3)) == pytest.approx(0.0)

    # Natural curvature (12 deg at joint 1, 14 deg at joint 2 = 26 deg total):
    # This must be under max_finger_bend_deg (30.0 deg)
    theta1 = math.radians(12)
    theta2 = math.radians(26)
    p0 = np.array([0.0, 0.0])
    p1 = p0 + np.array([0.0, 30.0])
    p2 = p1 + np.array([30.0 * math.sin(theta1), 30.0 * math.cos(theta1)])
    p3 = p2 + np.array([30.0 * math.sin(theta2), 30.0 * math.cos(theta2)])
    pts_natural = np.array([p0, p1, p2, p3])
    b_nat = chain_bend_deg(pts_natural, (0, 1, 2, 3))
    assert b_nat == pytest.approx(26.0, abs=0.1)
    assert b_nat <= 30.0  # Pass natural curvature

    # Curled finger (35 deg at joint 1, 35 deg at joint 2 = 70 deg total)
    theta1 = math.radians(35)
    theta2 = math.radians(70)
    p2 = p1 + np.array([30.0 * math.sin(theta1), 30.0 * math.cos(theta1)])
    p3 = p2 + np.array([30.0 * math.sin(theta2), 30.0 * math.cos(theta2)])
    pts_curled = np.array([p0, p1, p2, p3])
    b_curled = chain_bend_deg(pts_curled, (0, 1, 2, 3))
    assert b_curled > 30.0  # Properly reject curled finger


# --------------------------------------------------------------------------- #
# 4. Uncertainty handling and shorter feature acceptance
# --------------------------------------------------------------------------- #


def test_classify_shorter_features_accepted_with_low_confidence(cfg):
    """Palm width (~68 mm) and fingers (~65-85 mm) with standard millimeter uncertainty
    (sigma ~4.5-6.5 mm) must be classified as low_confidence, NOT invalid/hidden."""
    # Palm width: 68 mm, sigma 4.8 mm -> rel95 = 1.96 * 4.8 / 68 = 13.8%
    assert classify(68.0, 4.8, cfg) == "low_confidence"

    # Little finger: 65 mm, sigma 5.5 mm -> rel95 = 1.96 * 5.5 / 65 = 16.6%
    assert classify(65.0, 5.5, cfg) == "low_confidence"

    # Thumb: 45 mm, sigma 6.5 mm (out_of_plane) -> u95 = 12.7 mm <= 16 mm, rel95 = 28.3% <= 35%
    assert classify(45.0, 6.5, cfg, out_of_plane=True) == "low_confidence"

    # Truly excessive uncertainty must still be rejected as invalid:
    assert classify(45.0, 12.0, cfg, out_of_plane=True) == "invalid"
    assert classify(65.0, 15.0, cfg) == "invalid"


def test_all_hand_measurements_reported_in_aggregate(cfg, calib):
    """Ensure that across 24 standard frames, palm width, fingers, and thumb all produce
    real numeric value_mm and uncertainty_mm without dropping to None / n/a."""
    obs = FrameObservation.model_validate(frame_obs())
    results = [measure_frame(obs, QUARTER, cfg) for _ in range(24)]
    agg = aggregate_measurements(results, cfg, calib, None)

    by_key = {m.key: m for m in agg.measurements}
    expected_keys = [
        "hand_length_mm",
        "palm_length_mm",
        "mcp_span_mm",
        "thumb_length_mm",
        "index_length_mm",
        "middle_length_mm",
        "ring_length_mm",
        "little_length_mm",
    ]
    for key in expected_keys:
        m = by_key[key]
        assert m.value_mm is not None, f"{key} should not be None"
        assert m.uncertainty_mm is not None, f"{key} uncertainty should not be None"
        assert m.status in ("valid", "low_confidence"), f"{key} status {m.status} unexpected"
        assert m.interval95_mm[0] < m.value_mm < m.interval95_mm[1]


# --------------------------------------------------------------------------- #
# 5. Sizing recommendation boundary protection
# --------------------------------------------------------------------------- #


def test_sizing_clamped_xs_downgraded_from_clear():
    """An adult hand measuring < 155 mm clamped to size XS must not report false 'clear' confidence."""
    chart = load_sizing_charts()["demo-length-v1"]
    # Value 148 mm: inside XS (< 163), but near/below bottom edge of adult chart
    m = {"hand_length_mm": MeasuredValue("hand_length_mm", 148.0, 4.0, "valid")}
    r = recommend(chart, m)
    assert r.size == "XS"
    # Must be downgraded from 'clear' to 'likely'
    assert r.confidence_level in ("likely", "borderline")
    assert any("lower boundary" in exp for exp in r.explanation)
