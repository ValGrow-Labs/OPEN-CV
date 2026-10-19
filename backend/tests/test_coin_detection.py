"""Coin detection on synthetic scenes with exactly known geometry.

These tests check that the algorithm recovers known geometry and rejects degraded
inputs. They are not evidence of real-world accuracy.
"""

import cv2
import numpy as np
import pytest

from glovesize import coin_detection as cd
from glovesize.synthetic import SKIN_BGR, render_coin_scene


@pytest.fixture
def p(cfg):
    return cfg.coin_detection


def _diameter_tol(d):
    # The synthetic renderer's anti-aliasing adds ~0.25 px; allow that plus 0.75 %.
    return 0.35 + 0.0075 * d


@pytest.mark.parametrize("diameter", [32.0, 48.0, 63.7, 80.0, 120.0, 180.0])
def test_known_diameters(p, diameter):
    img, truth = render_coin_scene(width=max(320, int(diameter * 3)), height=max(320, int(diameter * 3)),
                                   center=(diameter * 1.5 + 0.3, diameter * 1.5 - 0.4), diameter_px=diameter, seed=3)  # fmt: skip
    det = cd.detect_coin(img, p)
    assert det.accepted, det.reasons
    assert abs(det.major_axis_px - truth.major_axis_px) < _diameter_tol(diameter)
    assert abs(det.minor_axis_px - truth.minor_axis_px) < _diameter_tol(diameter)
    assert abs(det.center_x - truth.center_x) < 0.3
    assert abs(det.center_y - truth.center_y) < 0.3


@pytest.mark.parametrize("tilt,axis", [(10, 0), (15, 45), (20, 120), (25, 170), (30, 75)])
def test_tilted_coin_axes_and_orientation(p, tilt, axis):
    img, truth = render_coin_scene(diameter_px=90, tilt_deg=tilt, major_angle_deg=axis, seed=tilt)
    det = cd.detect_coin(img, p)
    assert det.accepted, det.reasons
    assert abs(det.major_axis_px - truth.major_axis_px) < _diameter_tol(90)
    assert det.axis_ratio == pytest.approx(truth.minor_axis_px / truth.major_axis_px, abs=0.01)
    diff = abs((det.angle_deg - truth.angle_deg + 90) % 180 - 90)
    assert diff < 3.0


@pytest.mark.parametrize("seed", range(5))
def test_relief_and_crease_rotation_variants(p, seed):
    # Different random relief/crease layouts act as arbitrary in-plane rotations of the scene.
    img, truth = render_coin_scene(diameter_px=70, seed=100 + seed)
    det = cd.detect_coin(img, p)
    assert det.accepted
    assert abs(det.major_axis_px - truth.major_axis_px) < _diameter_tol(70)


def test_outer_edge_found_despite_bright_rim(p):
    # In grayscale the coin's raised rim is the strongest circle; the chroma channel must
    # still put the boundary at the coin's outer edge.
    img, truth = render_coin_scene(diameter_px=80)
    det = cd.detect_coin(img, p)
    assert abs(det.major_axis_px - 80) < _diameter_tol(80)
    gray = cd.detect_coin(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), p)
    assert gray.major_axis_px < 78  # documents the grayscale limitation


def test_roi_returns_full_image_coordinates(p):
    img, truth = render_coin_scene(width=640, height=480, center=(400.5, 300.25), diameter_px=60)
    det = cd.detect_coin(img, p, roi=(300, 200, 200, 200))
    assert det.accepted
    assert det.center_x == pytest.approx(400.5, abs=0.3)
    assert det.center_y == pytest.approx(300.25, abs=0.3)


def test_diameter_range_excludes_coin(p):
    img, _ = render_coin_scene(diameter_px=60)
    det = cd.detect_coin(img, p, diameter_range_px=(100, 200))
    assert not det.accepted


def test_mild_blur_and_noise_accepted(p):
    for kwargs in ({"blur_sigma": 1.0}, {"noise_sigma": 6.0}):
        img, truth = render_coin_scene(diameter_px=80, **kwargs)
        det = cd.detect_coin(img, p)
        assert det.accepted, (kwargs, det.reasons)
        assert abs(det.major_axis_px - 80) < 1.0


def test_heavy_blur_rejected_as_blurry(p):
    img, _ = render_coin_scene(diameter_px=80, blur_sigma=3.0)
    det = cd.detect_coin(img, p)
    assert not det.accepted
    assert cd.BLURRY in det.reasons


def test_strong_glare_rejected(p):
    img, _ = render_coin_scene(diameter_px=80, glare_fraction_of_radius=0.6)
    det = cd.detect_coin(img, p)
    assert not det.accepted
    assert cd.GLARE in det.reasons


def test_small_glare_tolerated(p):
    img, _ = render_coin_scene(diameter_px=80, glare_fraction_of_radius=0.2)
    det = cd.detect_coin(img, p)
    assert det.accepted
    assert 0 < det.glare_fraction < p.accept.max_glare_fraction


@pytest.mark.parametrize("depth,side", [(0.1, 0), (0.25, 90), (0.4, 200)])
def test_partial_occlusion_rejected(p, depth, side):
    img, _ = render_coin_scene(diameter_px=80, occlusion_depth_fraction=depth, occlusion_side_deg=side)
    det = cd.detect_coin(img, p)
    assert not det.accepted
    assert cd.OCCLUDED in det.reasons


def test_no_coin(p):
    rng = np.random.default_rng(0)
    img = np.clip(np.full((300, 300, 3), SKIN_BGR, np.float64) + rng.normal(0, 3, (300, 300, 3)), 0, 255).astype(
        np.uint8
    )
    det = cd.detect_coin(img, p)
    # Noise may yield spurious candidates, but none may pass the quality gates.
    assert not det.accepted
    assert det.confidence < p.accept.min_confidence


def test_coin_below_minimum_size(p):
    img, _ = render_coin_scene(width=200, height=200, center=(100, 100), diameter_px=20)
    det = cd.detect_coin(img, p)
    assert not det.accepted


def test_methods_are_compared(p):
    img, _ = render_coin_scene(diameter_px=80)
    det = cd.detect_coin(img, p)
    methods = det.method.split("+")
    assert {"segmentation", "contour", "hough"} & set(methods)
    assert det.candidates and all("diameter_px" in c for c in det.candidates)


def test_confidence_bounds_and_ramp():
    assert cd.ramp(5, good=10, bad=0) == pytest.approx(0.5)
    assert cd.ramp(-1, good=10, bad=0) == 0
    assert cd.ramp(0.1, good=0.0, bad=1.0) == pytest.approx(0.9)


def test_ellipse_radius_function():
    phi = np.array([0.0, np.pi / 2])
    r = cd.ellipse_radius(phi, 100, 50, 0)
    assert r == pytest.approx([50, 25])
    r = cd.ellipse_radius(phi, 100, 50, 90)
    assert r == pytest.approx([25, 50])
