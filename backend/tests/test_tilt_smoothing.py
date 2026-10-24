"""Coin tilt is judged on the average ellipse of neighbouring frames (calibration.smoothed_coin_tilts).

A coin lying flat has axis ratio 1, and edge noise can only pull a single frame's ratio below 1, so
one frame reads a spurious tilt. These tests use synthetic coin ellipses; they show how the
estimator behaves, not real-world accuracy.
"""

import math

import numpy as np
import pytest

from glovesize.calibration import coin_tilt_deg, smoothed_coin_tilts
from glovesize.measurement import measure_frame
from glovesize.schemas import CoinObservation, FrameObservation
from glovesize.synthetic import synthetic_frame

from .conftest import QUARTER


def coin(major=60.0, ratio=1.0, angle=0.0) -> CoinObservation:
    return CoinObservation(
        center_x=360, center_y=700, major_axis_px=major, minor_axis_px=major * ratio, angle_deg=angle,
        edge_support=0.97, max_angular_gap_deg=8, fit_residual_px=0.3, edge_width_px=2.0,
        glare_fraction=0.0, contrast=0.2, n_edge_points=144, confidence=0.95, accepted=True,
    )  # fmt: skip


def noisy_flat_coins(n=60, sigma=0.02, seed=1):
    """A flat coin: every frame's ellipse is a circle plus noise with no preferred direction."""
    rng = np.random.default_rng(seed)
    return [coin(ratio=1.0 - abs(rng.normal(0, sigma)), angle=rng.uniform(0, 180)) for _ in range(n)]


def test_window_of_one_is_the_per_frame_tilt():
    coins = [coin(ratio=0.97, angle=10), coin(ratio=0.9, angle=70)]
    got = smoothed_coin_tilts(coins, 1)
    assert got == pytest.approx([coin_tilt_deg(c) for c in coins], abs=1e-9)


def test_a_flat_coin_with_edge_noise_no_longer_reads_as_tilted():
    coins = noisy_flat_coins()
    raw = np.array([coin_tilt_deg(c) for c in coins])
    smooth = np.array(smoothed_coin_tilts(coins, 7))
    # Without averaging, many frames of a perfectly flat coin exceed the 12 degree limit ...
    assert (raw > 12).mean() > 0.15
    # ... with it none do: the worst frames, which are what block a scan, shrink the most.
    assert smooth.max() < 12
    assert np.percentile(smooth, 90) < 0.7 * np.percentile(raw, 90)


def test_a_really_tilted_coin_keeps_its_tilt():
    rng = np.random.default_rng(2)
    true = 20.0
    coins = [coin(ratio=math.cos(math.radians(true)) + rng.normal(0, 0.006), angle=35 + rng.normal(0, 3)) for _ in range(40)]
    smooth = np.array(smoothed_coin_tilts(coins, 7))
    assert smooth.mean() == pytest.approx(true, abs=1.5)
    assert smooth.min() > 12  # still over the limit in every frame


def test_a_tilted_coin_is_not_hidden_by_neighbours_with_other_directions():
    # Tilt direction is part of the shape: frames tilted about different axes do not cancel
    # into a flat coin only because they share a magnitude by chance in one pair of frames.
    coins = [coin(ratio=0.94, angle=0), coin(ratio=0.94, angle=90)]
    assert smoothed_coin_tilts(coins, 3)[0] < coin_tilt_deg(coins[0])  # different axes do average out
    same = [coin(ratio=0.94, angle=20), coin(ratio=0.94, angle=20)]
    assert smoothed_coin_tilts(same, 3)[0] == pytest.approx(coin_tilt_deg(same[0]), abs=1e-6)


def test_frames_without_a_coin_are_skipped():
    coins = [coin(ratio=1.0), None, coin(ratio=1.0)]
    out = smoothed_coin_tilts(coins, 3)
    assert out[1] is None
    assert out[0] == pytest.approx(0, abs=1e-6) and out[2] == pytest.approx(0, abs=1e-6)


def _frame_with_ratio(cfg_ratio, angle=0.0):
    f = synthetic_frame()
    f["coin"]["minor_axis_px"] = f["coin"]["major_axis_px"] * cfg_ratio
    f["coin"]["angle_deg"] = angle
    return FrameObservation.model_validate(f)


def test_measure_frame_uses_the_smoothed_tilt(cfg_nodepth):
    f = _frame_with_ratio(0.96)  # a single frame reading 16 degrees
    assert "coin_tilted" in measure_frame(f, QUARTER, cfg_nodepth).codes
    assert "coin_tilted" not in measure_frame(f, QUARTER, cfg_nodepth, tilt_deg=4.0).codes
    assert "coin_tilted" in measure_frame(f, QUARTER, cfg_nodepth, tilt_deg=15.0).codes
