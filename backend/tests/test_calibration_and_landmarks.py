import math

import numpy as np
import pytest

from glovesize import landmarks as L
from glovesize.calibration import (
    camera_distance_range_mm,
    coin_tilt_deg,
    frame_scale,
    resolve_reference,
)
from glovesize.schemas import CoinObservation, ReferenceSelection
from glovesize.synthetic import CANONICAL_HAND_MM

from .conftest import QUARTER


def coin(major=80.0, minor=80.0, angle=0.0, **kw):
    base = dict(center_x=300, center_y=400, major_axis_px=major, minor_axis_px=minor, angle_deg=angle,
                edge_support=0.95, max_angular_gap_deg=10, fit_residual_px=0.3, edge_width_px=2.3,
                glare_fraction=0.0, contrast=0.3, n_edge_points=136, confidence=0.95, accepted=True)  # fmt: skip
    base.update(kw)
    return CoinObservation(**base)


@pytest.mark.parametrize("diameter_px", [40.0, 77.6, 150.0])
def test_pixels_per_mm_formula(cfg_nodepth, diameter_px):
    s = frame_scale(coin(diameter_px, diameter_px), QUARTER, 720, 1280, cfg_nodepth)
    assert s.px_per_mm == pytest.approx(diameter_px / 24.26)
    assert s.depth_factor == 1.0
    assert not s.tilt_corrected


def test_tilt_from_axis_ratio():
    c = coin(80, 80 * math.cos(math.radians(20)))
    assert coin_tilt_deg(c) == pytest.approx(20, abs=1e-6)


def test_rectification_is_off_by_default(cfg_nodepth):
    # Affine rectification is only valid under weak perspective (docs/CALIBRATION_STUDY.md).
    c = coin(80, 80 * math.cos(math.radians(11)), 30)
    s = frame_scale(c, QUARTER, 720, 1280, cfg_nodepth)
    assert not s.tilt_corrected
    assert np.allclose(s.rectification, np.eye(2))
    assert s.rel_sigma_tilt == pytest.approx(0.23 * math.sin(math.radians(11)) / math.sqrt(3), rel=1e-3)


def test_small_tilt_not_corrected_but_in_uncertainty(cfg_nodepth):
    c = coin(80, 80 * math.cos(math.radians(5)))
    s = frame_scale(c, QUARTER, 720, 1280, cfg_nodepth)
    assert not s.tilt_corrected
    assert s.rel_sigma_tilt > 0
    assert np.allclose(s.rectification, np.eye(2))


@pytest.mark.parametrize("axis_deg", [0, 37, 90, 151])
def test_rectification_undoes_foreshortening(cfg_rectify, axis_deg):
    tilt = 18.0
    c = coin(80, 80 * math.cos(math.radians(tilt)), axis_deg)
    s = frame_scale(c, QUARTER, 720, 1280, cfg_rectify)
    assert s.tilt_corrected
    a = math.radians(axis_deg)
    u = np.array([math.cos(a), math.sin(a)])
    v = np.array([-math.sin(a), math.cos(a)])
    centre = np.array([300.0, 400.0])
    # A 100 px vector in the minor-axis direction appears shortened by cos(tilt).
    pts = np.array([centre, centre + v * 100 * math.cos(math.radians(tilt)), centre + u * 100])
    r = s.rectify(pts)
    assert np.linalg.norm(r[1] - r[0]) == pytest.approx(100, rel=1e-6)
    assert np.linalg.norm(r[2] - r[0]) == pytest.approx(100, rel=1e-6)


def test_depth_correction_reduces_landmark_scale(cfg):
    s = frame_scale(coin(80, 80), QUARTER, 720, 1280, cfg)
    assert 0.9 < s.depth_factor < 1.0
    assert s.px_per_mm == pytest.approx(s.px_per_mm_coin * s.depth_factor)
    assert s.rel_sigma_depth > 0
    lo, hi = s.distance_range_mm
    assert 100 < lo < hi < 1000


def test_camera_distance_scales_inversely_with_coin_size():
    near = camera_distance_range_mm(160, 24.26, 720, 1280, (55, 80))
    far = camera_distance_range_mm(80, 24.26, 720, 1280, (55, 80))
    assert far[0] == pytest.approx(2 * near[0])


def test_reference_resolution(refs):
    q = resolve_reference(ReferenceSelection(object_id="us_quarter"), refs)
    assert q is not None and q.diameter_mm == 24.26 and not q.custom
    assert resolve_reference(ReferenceSelection(object_id="us_nickel"), refs) is None  # disabled
    assert resolve_reference(ReferenceSelection(object_id="unknown"), refs) is None
    custom = resolve_reference(ReferenceSelection(custom_diameter_mm=30.0, custom_label="Token"), refs)
    assert custom is not None and custom.custom and custom.diameter_mm == 30.0


def test_reference_selection_requires_exactly_one():
    with pytest.raises(ValueError):
        ReferenceSelection()
    with pytest.raises(ValueError):
        ReferenceSelection(object_id="us_quarter", custom_diameter_mm=24.26)


# --------------------------------------------------------------------------- #
# Landmark helpers
# --------------------------------------------------------------------------- #


def test_canonical_hand_is_straight():
    for chain in L.LONG_FINGERS.values():
        assert L.chain_bend_deg(CANONICAL_HAND_MM, chain) < 5


def test_bend_detection():
    pts = CANONICAL_HAND_MM.copy()
    pts[12] = pts[11] + np.array([25.0, 0.0])  # fold the middle fingertip sideways by 90 deg
    assert L.chain_bend_deg(pts, L.LONG_FINGERS["middle"]) > 80


def test_degenerate_chain_is_nan():
    pts = CANONICAL_HAND_MM.copy()
    pts[10] = pts[9]
    assert math.isnan(L.chain_bend_deg(pts, L.LONG_FINGERS["middle"]))


def test_palm_tilt_from_world_landmarks():
    flat = np.column_stack([CANONICAL_HAND_MM / 1000, np.zeros(21)])
    assert L.palm_tilt_deg(flat) == pytest.approx(0, abs=1e-6)
    t = math.radians(40)
    rot = np.array([[1, 0, 0], [0, math.cos(t), -math.sin(t)], [0, math.sin(t), math.cos(t)]])
    assert L.palm_tilt_deg(flat @ rot.T) == pytest.approx(40, abs=1e-6)


def test_point_in_palm_polygon():
    poly = L.palm_polygon(CANONICAL_HAND_MM)
    centre = CANONICAL_HAND_MM[[0, 5, 9, 13, 17]].mean(axis=0)
    assert L.point_in_polygon(tuple(centre), poly)
    assert not L.point_in_polygon((0.0, -170.0), poly)


def test_as_array_validates_shape():
    with pytest.raises(ValueError):
        L.as_array(np.zeros((20, 2)))
    assert L.as_array(np.zeros((21, 3))).shape == (21, 2)


def test_inside_frame():
    pts = np.array([[10.0, 10.0]] * 21)
    assert L.inside_frame(pts, 100, 100, 0.05)
    assert not L.inside_frame(pts, 100, 100, 0.2)
