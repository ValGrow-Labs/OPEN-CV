"""Finger accuracy: the always-on diagnostics and the optional (default-off) refinements.

Pinhole-camera simulation with exactly known 3D geometry (glovesize/simulation.py). SIMULATED: these tests show
what the code does on made-up geometry, not real-world accuracy (docs/FINGER_ACCURACY_AUDIT.md).
"""

from __future__ import annotations

import math
from dataclasses import replace

import numpy as np
import pytest

from glovesize.calibration import smoothed_coin_tilts
from glovesize.landmarks import chain_elevation_deg
from glovesize.measurement import (
    FrameResult,
    aggregate_camera,
    combine_views,
    finger_tilt_rel_sigma,
    measure_frame,
)
from glovesize.schemas import FrameObservation
from glovesize.simulation import (
    PHOTO_HAND_UNIT,
    Scene,
    simulate_frame,
    true_chain_lengths_mm,
    true_hand_length_mm,
)

from .conftest import QUARTER

FINGERS = ("index", "middle", "ring", "little")


def results_for(scene: Scene, cfg, n: int = 12, seed: int = 3) -> list[FrameResult]:
    rng = np.random.default_rng(seed)
    frames = [FrameObservation.model_validate(simulate_frame(replace(scene, seed=seed), rng)) for _ in range(n)]
    tilts = smoothed_coin_tilts([f.coin for f in frames], cfg.calibration.tilt_window_frames)
    return [measure_frame(f, QUARTER, cfg, tilt_deg=t) for f, t in zip(frames, tilts, strict=True)]


def with_flags(cfg, **flags):
    return cfg.model_copy(update={"finger_accuracy": cfg.finger_accuracy.model_copy(update=flags)})


def by_key(camera):
    return {m.key: m for m in camera.out}


def test_refinements_are_off_by_default(cfg):
    fa = cfg.finger_accuracy
    assert fa.tilt_uncertainty is False and fa.depth_aware_lengths is False


def test_simulation_additions_are_inert_by_default_and_truth_is_3d():
    s = Scene()
    assert true_hand_length_mm(s) == pytest.approx(185.0)
    flat = true_chain_lengths_mm(s)
    pitched = true_chain_lengths_mm(replace(s, finger_pitch_deg={"index": 20.0}))
    assert pitched["index"] == pytest.approx(flat["index"], rel=1e-6)  # a rigid pitch keeps the true length
    assert pitched["middle"] == pytest.approx(flat["middle"], rel=1e-6)
    # ... and moves the tip towards the camera (smaller depth)
    from glovesize.simulation import hand_points_3d

    lm, _, _ = hand_points_3d(replace(s, finger_pitch_deg={"index": 20.0}))
    assert lm[8][2] < lm[5][2] - 10
    # the photo shape keeps the requested hand length and is wider-spread, thumb longer than the canonical one
    p = Scene(hand_shape="photo")
    assert true_hand_length_mm(p) == pytest.approx(185.0)
    assert true_chain_lengths_mm(p)["thumb"] > flat["thumb"] + 10
    assert PHOTO_HAND_UNIT.shape == (21, 2)


def test_chain_elevation_deg():
    pts = np.zeros((21, 3))
    pts[8] = [0.0, -100.0, 0.0]
    assert chain_elevation_deg(pts, (5, 6, 7, 8)) == pytest.approx(0.0)
    pts[8] = [0.0, -100.0, 17.6327]  # tan(10 deg) * 100 in depth
    assert chain_elevation_deg(pts, (5, 6, 7, 8)) == pytest.approx(10.0, abs=0.01)
    pts[8] = [0.0, -100.0, -17.6327]  # nearer or farther: the same foreshortening
    assert chain_elevation_deg(pts, (5, 6, 7, 8)) == pytest.approx(10.0, abs=0.01)
    assert math.isnan(chain_elevation_deg(np.zeros((21, 3)), (5, 6, 7, 8)))


def test_diagnostics_are_always_on_and_change_nothing(cfg, calib):
    scene = Scene(hand_shape="photo")
    res = results_for(scene, cfg)
    cam = aggregate_camera(res, cfg, calib)
    m = by_key(cam)
    for f in ("thumb", *FINGERS):
        row = m[f"{f}_length_mm"]
        assert row.limitation
        assert row.finger_tilt_deg is not None and row.finger_tilt_deg < 1.0  # a flat simulated hand
    assert m["hand_length_mm"].limitation is None and m["hand_length_mm"].finger_tilt_deg is None
    # defaults: no extra uncertainty term, no tilt flag
    assert all("finger_foreshortening" not in x.uncertainty_components_mm for x in cam.out)
    assert all("finger_tilted" not in x.reasons for x in cam.out)


def test_frame_exclusions_name_the_frames_a_finger_lost(cfg, calib):
    res = results_for(Scene(hand_shape="photo"), cfg, n=12)
    for r in res[:3]:  # the ring finger is bent in the image in three frames
        r.excluded["ring_length_mm"] = "finger_bent"
        r.values.pop("ring_length_mm")
    cam = aggregate_camera(res, cfg, calib)
    ring = by_key(cam)["ring_length_mm"]
    assert ring.frame_exclusions == {"finger_bent": 3}
    assert ring.frames_used == 9
    # too few frames: the value is hidden, but the reason is explained by the counts
    for r in res[3:9]:
        r.excluded["ring_length_mm"] = "finger_obscured"
        r.values.pop("ring_length_mm")
    ring = by_key(aggregate_camera(res, cfg, calib))["ring_length_mm"]
    assert ring.status == "invalid" and ring.value_mm is None
    assert ring.frame_exclusions == {"finger_bent": 3, "finger_obscured": 6}


def test_rejected_outlier_frames_are_counted(cfg, calib):
    res = results_for(Scene(hand_shape="photo", landmark_noise_px=0.3), cfg, n=12)
    res[0].values["index_length_mm"] += 30.0
    index = by_key(aggregate_camera(res, cfg, calib))["index_length_mm"]
    assert index.frame_exclusions.get("outlier_frame") == 1 and index.frames_used == 11


def test_tilt_term_changes_only_the_uncertainty_and_flags_a_lifted_finger(cfg, calib):
    lifted = Scene(hand_shape="photo", finger_pitch_deg={f: 20.0 for f in FINGERS})
    flat = Scene(hand_shape="photo")
    on = with_flags(cfg, tilt_uncertainty=True)
    for scene, expect_flag in ((lifted, True), (flat, False)):
        res = results_for(scene, cfg)
        off = by_key(aggregate_camera(res, cfg, calib))
        new = by_key(aggregate_camera(res, on, calib))
        for f in FINGERS:
            a, b = off[f"{f}_length_mm"], new[f"{f}_length_mm"]
            assert a.value_mm == b.value_mm  # the value never moves
            assert b.uncertainty_mm >= a.uncertainty_mm
            assert ("finger_tilted" in b.reasons) is expect_flag
            assert "finger_tilted" not in a.reasons
        if expect_flag:
            mid = new["middle_length_mm"].uncertainty_components_mm["finger_foreshortening"]
            assert mid > 2.0  # about 6% of 100 mm, over sqrt(3) and the noise floor
        else:
            assert new["middle_length_mm"].uncertainty_components_mm["finger_foreshortening"] < 0.5


def test_tilt_term_formula():
    fa = type("FA", (), {"elevation_sigma_deg": 4.0, "max_elevation_deg": 30.0})()
    a, b, c = (finger_tilt_rel_sigma(t, fa, corrected=False) for t in (0.0, 10.0, 25.0))
    assert 0 < a < b < c
    assert finger_tilt_rel_sigma(25.0, fa, corrected=True) < c  # a corrected finger keeps only the correction's error
    assert finger_tilt_rel_sigma(0.0, fa, corrected=True) == pytest.approx(a)  # the noise floor is the same
    # the reading is clipped at max_elevation_deg
    assert finger_tilt_rel_sigma(80.0, fa, corrected=True) == finger_tilt_rel_sigma(30.0, fa, corrected=True)


def test_depth_aware_lengths_recover_lifted_fingers_in_simulation(cfg, calib):
    """SIMULATED, exact pinhole geometry and exact world depth: the optional lengths remove the error a single
    coin scale leaves on fingers lifted towards the camera, and change nothing on a flat hand. (Real world
    depth is noisy and biased; see docs/FINGER_ACCURACY_AUDIT.md for what real photos showed.)"""
    on = with_flags(cfg, depth_aware_lengths=True)
    lifted = Scene(hand_shape="photo", finger_pitch_deg={f: 10.0 for f in FINGERS})
    truth = true_chain_lengths_mm(lifted)
    res_off, res_on = results_for(lifted, cfg), results_for(lifted, on)
    for f in FINGERS:
        k = f"{f}_length_mm"
        err_off = abs(res_off[0].values[k] - truth[f])
        err_on = abs(res_on[0].values[k] - truth[f])
        assert err_off > 1.5 and err_on < 0.4, (f, err_off, err_on)
        # the thumb is never corrected
    assert res_on[0].values["thumb_length_mm"] == res_off[0].values["thumb_length_mm"]
    flat = Scene(hand_shape="photo")
    a, b = results_for(flat, cfg)[0], results_for(flat, on)[0]
    for f in FINGERS:
        assert abs(a.values[f"{f}_length_mm"] - b.values[f"{f}_length_mm"]) < 0.3


def test_depth_aware_lengths_need_world_landmarks(cfg):
    on = with_flags(cfg, depth_aware_lengths=True)
    d = simulate_frame(Scene(hand_shape="photo"))
    d["world_landmarks"] = None
    frame = FrameObservation.model_validate(d)
    a, b = measure_frame(frame, QUARTER, cfg), measure_frame(frame, QUARTER, on)
    assert a.accepted and b.accepted and a.values == b.values and b.elevations == {}


def test_combine_views_sums_exclusions_and_averages_tilt(cfg, calib):
    r1 = results_for(Scene(hand_shape="photo"), cfg, n=12, seed=1)
    r2 = results_for(Scene(hand_shape="photo"), cfg, n=12, seed=2)
    r1[0].excluded["index_length_mm"] = "finger_bent"
    r1[0].values.pop("index_length_mm")
    r2[0].excluded["index_length_mm"] = "finger_bent"
    r2[0].values.pop("index_length_mm")
    r2[1].excluded["index_length_mm"] = "finger_obscured"
    r2[1].values.pop("index_length_mm")
    cams = [aggregate_camera(r, cfg, calib) for r in (r1, r2)]
    both = by_key(combine_views(cams, cfg))["index_length_mm"]
    assert both.frame_exclusions == {"finger_bent": 2, "finger_obscured": 1}
    assert both.finger_tilt_deg is not None and both.limitation


def test_response_carries_the_additive_fields(client_scan_response):
    index = next(m for m in client_scan_response["measurements"] if m["key"] == "index_length_mm")
    assert index["limitation"] and "frame_exclusions" in index and "finger_tilt_deg" in index
    hand = next(m for m in client_scan_response["measurements"] if m["key"] == "hand_length_mm")
    assert hand["limitation"] is None


@pytest.fixture
def client_scan_response():
    from fastapi.testclient import TestClient

    from glovesize.api import app

    rng = np.random.default_rng(5)
    scene = Scene(hand_shape="photo", landmark_noise_px=1.0)
    frames = [simulate_frame(replace(scene, seed=1), rng) for _ in range(12)]
    for i, f in enumerate(frames):
        f["timestamp_ms"] = float(i * 50)
    body = {"frames": frames, "reference": {"object_id": "us_quarter", "confirmed": True, "size_checked": True}}
    r = TestClient(app).post("/api/scan", json=body)
    assert r.status_code == 200, r.text
    return r.json()
