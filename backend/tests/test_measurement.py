"""Measurement engine on synthetic landmark geometry with exactly known dimensions."""

import math

import numpy as np
import pytest

from glovesize.landmarks import path_length
from glovesize.measurement import aggregate_measurements, measure_frame, robust_inliers
from glovesize.schemas import FrameObservation, ManualMeasurements
from glovesize.synthetic import CANONICAL_HAND_MM, synthetic_frame

from .conftest import QUARTER, frame_obs

EXPECTED_185 = {
    "hand_length_mm": 185.0,
    "palm_length_mm": float(np.linalg.norm(CANONICAL_HAND_MM[0] - CANONICAL_HAND_MM[9])),
    "mcp_span_mm": float(np.linalg.norm(CANONICAL_HAND_MM[5] - CANONICAL_HAND_MM[17])),
}


def test_exact_geometry_recovered(cfg_nodepth):
    r = measure_frame(frame_obs(), QUARTER, cfg_nodepth)
    assert r.accepted, r.codes
    for key, expected in EXPECTED_185.items():
        assert r.values[key] == pytest.approx(expected, abs=0.05)
    assert r.values["middle_length_mm"] == pytest.approx(path_length(CANONICAL_HAND_MM, [9, 10, 11, 12]), abs=0.05)


@pytest.mark.parametrize("length", [150.0, 170.0, 200.0, 225.0])
@pytest.mark.parametrize("px_per_mm", [2.6, 3.4])
def test_scale_invariance(cfg_nodepth, length, px_per_mm):
    r = measure_frame(frame_obs(hand_length_mm=length, px_per_mm=px_per_mm), QUARTER, cfg_nodepth)
    assert r.accepted, r.codes
    assert r.values["hand_length_mm"] == pytest.approx(length, rel=1e-4)


@pytest.mark.parametrize("tilt,axis,rotation", [(10, 0, 0), (15, 30, 20), (19, 100, -25), (12, 160, 10)])
def test_tilt_rectification(cfg_rectify, tilt, axis, rotation):
    # Weak-perspective synthetic frames: the opt-in affine rectification is exact here.
    r = measure_frame(frame_obs(tilt_deg=tilt, tilt_axis_deg=axis, rotation_deg=rotation), QUARTER, cfg_rectify)
    assert r.accepted, r.codes
    assert r.scale.tilt_corrected
    for key, expected in EXPECTED_185.items():
        assert r.values[key] == pytest.approx(expected, rel=1e-3)


def test_left_and_right_hands(cfg_nodepth):
    right = measure_frame(frame_obs(), QUARTER, cfg_nodepth)
    left = measure_frame(frame_obs(mirror=True), QUARTER, cfg_nodepth)
    assert left.accepted and right.accepted
    for key in EXPECTED_185:
        assert left.values[key] == pytest.approx(right.values[key], rel=1e-9)


def test_excessive_tilt_rejected(cfg_nodepth):
    r = measure_frame(frame_obs(tilt_deg=13), QUARTER, cfg_nodepth)
    assert not r.accepted and "coin_tilted" in r.codes


def test_coin_must_be_on_palm(cfg_nodepth):
    f = synthetic_frame()
    f["coin"]["center_y"] -= 400  # move the coin up beyond the fingertips
    r = measure_frame(FrameObservation.model_validate(f), QUARTER, cfg_nodepth)
    assert "coin_not_on_palm" in r.codes


def test_missing_coin(cfg_nodepth):
    f = synthetic_frame()
    f["coin"] = None
    r = measure_frame(FrameObservation.model_validate(f), QUARTER, cfg_nodepth)
    assert r.codes == ["coin_missing"]


def test_hand_out_of_frame(cfg_nodepth):
    r = measure_frame(frame_obs(px_per_mm=6.5), QUARTER, cfg_nodepth)
    assert "hand_out_of_frame" in r.codes


def test_hand_too_small(cfg_nodepth):
    r = measure_frame(frame_obs(px_per_mm=1.0), QUARTER, cfg_nodepth)
    assert "hand_too_small" in r.codes


def test_bent_middle_finger_rejects_frame(cfg_nodepth):
    f = synthetic_frame()
    lm = f["landmarks"]
    lm[12]["x"] += 60  # bend the middle fingertip sideways
    r = measure_frame(FrameObservation.model_validate(f), QUARTER, cfg_nodepth)
    assert "fingers_bent" in r.codes


def test_bent_index_finger_excludes_only_that_finger(cfg_nodepth):
    f = synthetic_frame()
    f["landmarks"][8]["x"] += 50
    r = measure_frame(FrameObservation.model_validate(f), QUARTER, cfg_nodepth)
    assert r.accepted
    assert r.excluded["index_length_mm"] == "finger_bent"
    assert "hand_length_mm" in r.values


def test_server_rechecks_client_coin_quality(cfg_nodepth):
    # A client claiming "accepted" with poor metrics must still be rejected.
    f = synthetic_frame(coin_overrides={"edge_support": 0.4, "max_angular_gap_deg": 120})
    r = measure_frame(FrameObservation.model_validate(f), QUARTER, cfg_nodepth)
    assert "coin_occluded" in r.codes


@pytest.mark.parametrize(
    "override,code",
    [
        ({"edge_width_px": 7.0}, "coin_blurry"),
        ({"glare_fraction": 0.5}, "coin_glare"),
        ({"contrast": 0.01}, "coin_low_contrast"),
    ],
)
def test_coin_quality_codes(cfg_nodepth, override, code):
    r = measure_frame(frame_obs(coin_overrides=override), QUARTER, cfg_nodepth)
    assert code in r.codes


def test_wrong_coin_type_detected_as_implausible(cfg_nodepth):
    # A coin 0.6x the size a quarter should be implies a ~308 mm hand.
    r = measure_frame(frame_obs(coin_scale_factor=0.6), QUARTER, cfg_nodepth)
    assert r.codes == ["implausible_scale"]


def test_palm_not_flat_from_world_landmarks(cfg_nodepth):
    f = synthetic_frame()
    t = math.radians(45)
    world = np.column_stack([CANONICAL_HAND_MM / 1000, np.zeros(21)])
    rot = np.array([[1, 0, 0], [0, math.cos(t), -math.sin(t)], [0, math.sin(t), math.cos(t)]])
    f["world_landmarks"] = [{"x": x, "y": y, "z": z} for x, y, z in world @ rot.T]
    r = measure_frame(FrameObservation.model_validate(f), QUARTER, cfg_nodepth)
    assert "palm_not_flat" in r.codes


def test_lighting_codes(cfg_nodepth):
    f = synthetic_frame()
    f["brightness"] = 20
    assert "too_dark" in measure_frame(FrameObservation.model_validate(f), QUARTER, cfg_nodepth).codes
    f["brightness"] = 250
    assert "too_bright" in measure_frame(FrameObservation.model_validate(f), QUARTER, cfg_nodepth).codes


def test_robust_inliers_drops_outlier():
    v = np.array([100.0, 100.5, 99.5, 100.2, 99.8, 130.0])
    assert robust_inliers(v).tolist() == [True] * 5 + [False]
    assert robust_inliers(np.full(5, 3.0)).all()


def _aggregate(cfg, calib, n=24, noise=1.0, manual=None, **kw):
    rng = np.random.default_rng(7)
    results = [
        measure_frame(
            FrameObservation.model_validate(synthetic_frame(landmark_noise_px=noise, rng=rng, **kw)), QUARTER, cfg
        )
        for _ in range(n)
    ]
    return aggregate_measurements(results, cfg, calib, manual)


def test_aggregation_values_and_uncertainty(cfg_nodepth, calib):
    agg = _aggregate(cfg_nodepth, calib)
    by = {m.key: m for m in agg.measurements}
    hl = by["hand_length_mm"]
    assert hl.status in ("valid", "low_confidence")
    assert hl.value_mm == pytest.approx(185.0, abs=1.0)
    assert hl.uncertainty_mm > 0
    assert hl.interval95_mm[0] < hl.value_mm < hl.interval95_mm[1]
    assert set(hl.uncertainty_components_mm) >= {
        "frame_variation",
        "landmark_localisation",
        "coin_scale",
        "landmark_definition_prior",
    }
    assert not hl.calibrated
    assert hl.frames_used >= 20


def test_thumb_is_never_better_than_low_confidence(cfg_nodepth, calib):
    agg = _aggregate(cfg_nodepth, calib)
    thumb = next(m for m in agg.measurements if m.key == "thumb_length_mm")
    assert thumb.status in ("low_confidence", "invalid")


def test_circumference_not_measured_without_model_or_manual(cfg_nodepth, calib):
    agg = _aggregate(cfg_nodepth, calib)
    circ = next(m for m in agg.measurements if m.key == "hand_circumference_mm")
    assert circ.status == "not_measured" and circ.value_mm is None


def test_manual_circumference_is_user_entered(cfg_nodepth, calib):
    agg = _aggregate(cfg_nodepth, calib, manual=ManualMeasurements(hand_circumference_mm=210))
    circ = next(m for m in agg.measurements if m.key == "hand_circumference_mm")
    assert circ.status == "user_entered" and circ.source == "user_entered" and circ.value_mm == 210


def test_derived_model_used_when_calibrated(cfg_nodepth, calib):
    from glovesize.config import CalibrationEntry, DerivedModel

    model = DerivedModel(predictors={"mcp_span_mm": 1.0}, intercept_mm=18.0, residual_sd_mm=2.5, n_participants=40)
    entries = dict(calib.measurements)
    entries["mcp_span_mm"] = CalibrationEntry(scale=1.0, offset_mm=0.0, residual_sd_mm=2.0)
    calib2 = calib.model_copy(
        update={"status": "calibrated", "measurements": entries, "derived": {"palm_breadth_mm": model}}
    )
    agg = _aggregate(cfg_nodepth, calib2)
    pb = next(m for m in agg.measurements if m.key == "palm_breadth_mm")
    assert pb.source == "camera_model_estimate"
    assert pb.value_mm == pytest.approx(EXPECTED_185["mcp_span_mm"] + 18.0, abs=1.0)


def test_calibration_offsets_applied(cfg_nodepth, calib):
    from glovesize.config import CalibrationEntry

    entries = dict(calib.measurements)
    entries["hand_length_mm"] = CalibrationEntry(scale=1.0, offset_mm=6.0, residual_sd_mm=3.0)
    calib2 = calib.model_copy(update={"status": "calibrated", "measurements": entries})
    agg = _aggregate(cfg_nodepth, calib2)
    hl = next(m for m in agg.measurements if m.key == "hand_length_mm")
    assert hl.value_mm == pytest.approx(191.0, abs=1.0)
    assert hl.calibrated
    assert set(hl.uncertainty_components_mm) == {"calibration_residual", "frame_variation"}


def test_unstable_frames_flagged(cfg_nodepth, calib):
    agg = _aggregate(cfg_nodepth, calib, noise=10.0)
    assert agg.unstable


def test_proportions_are_scale_free(cfg_nodepth, calib):
    a = _aggregate(cfg_nodepth, calib, noise=0.0, px_per_mm=2.8).proportions
    b = _aggregate(cfg_nodepth, calib, noise=0.0, px_per_mm=3.6).proportions
    assert a["palm_length_to_hand_length"] == pytest.approx(EXPECTED_185["palm_length_mm"] / 185.0, abs=0.002)
    assert a == b
