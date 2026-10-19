"""End-to-end scan processing on synthetic frames (integration of measurement + sizing)."""

import pytest

from glovesize.calibration import frame_scale
from glovesize.config import CalibrationEntry, load_measurement_calibration
from glovesize.pipeline import UnknownChartError, process_scan
from glovesize.schemas import CoinObservation, ScanRequest
from glovesize.synthetic import synthetic_frame

from .conftest import QUARTER, make_frames


def request(frames, **kw):
    body = {"frames": frames, "reference": {"object_id": "us_quarter"}}
    body.update(kw)
    return ScanRequest.model_validate(body)


def test_accepted_scan(no_depth_config):
    r = process_scan(request(make_frames()))
    assert r.status == "accepted"
    assert r.frames_accepted == 24
    hl = next(m for m in r.measurements if m.key == "hand_length_mm")
    assert hl.value_mm == pytest.approx(185, abs=1.0)
    assert r.calibration.px_per_mm == pytest.approx(3.2, rel=1e-3)
    assert r.recommendation is not None and r.recommendation.is_demo_chart
    assert r.uncertainty_basis == "prior_assumptions"
    assert any(i.code == "uncertainty_unvalidated" for i in r.issues)
    assert len(r.landmarks_px_median) == 21 and r.coin_median is not None


def test_depth_model_recovers_true_size_when_coin_is_nearer(cfg):
    # Simulate the physical situation the depth model describes: the coin's top face is
    # nearer to the camera than the landmark layer, so the coin looks larger by 1/factor.
    probe = CoinObservation.model_validate(synthetic_frame()["coin"])
    factor = frame_scale(probe, QUARTER, 720, 1280, cfg).depth_factor
    for _ in range(3):  # factor depends weakly on coin size; iterate to a fixed point
        f = synthetic_frame(coin_scale_factor=1 / factor)
        factor = frame_scale(CoinObservation.model_validate(f["coin"]), QUARTER, 720, 1280, cfg).depth_factor
    r = process_scan(request(make_frames(coin_scale_factor=1 / factor)))
    hl = next(m for m in r.measurements if m.key == "hand_length_mm")
    assert hl.value_mm == pytest.approx(185, abs=1.0)


def test_insufficient_frames_rejected(no_depth_config):
    r = process_scan(request(make_frames(n=5)))
    assert r.status == "rejected"
    assert r.issues[0].code == "insufficient_frames"
    assert r.recommendation is None and r.measurements == []


def test_bad_frames_reported_with_counts(no_depth_config):
    frames = make_frames(n=20, tilt_deg=28)
    r = process_scan(request(frames))
    assert r.status == "rejected"
    assert r.frame_rejection_counts == {"coin_tilted": 20}
    assert any(i.code == "coin_tilted" and i.frames_affected == 20 for i in r.issues)


def test_mixed_frames_use_only_good_ones(no_depth_config):
    frames = make_frames(n=20) + make_frames(n=10, coin_overrides={"glare_fraction": 0.6})
    r = process_scan(request(frames))
    assert r.status == "accepted"
    assert r.frames_accepted == 20
    assert r.frame_rejection_counts.get("coin_glare") == 10


def test_unknown_chart():
    with pytest.raises(UnknownChartError):
        process_scan(request(make_frames(), chart_id="nope"))


def test_disabled_reference_rejected():
    req = ScanRequest.model_validate({"frames": make_frames(), "reference": {"object_id": "us_nickel"}})
    r = process_scan(req)
    assert r.status == "rejected" and r.issues[0].code == "reference_unavailable"


def test_custom_reference_flagged(no_depth_config):
    frames = make_frames(coin_diameter_mm=30.0)
    req = ScanRequest.model_validate({"frames": frames, "reference": {"custom_diameter_mm": 30.0}})
    r = process_scan(req)
    assert r.status == "accepted"
    assert any(i.code == "custom_reference" for i in r.issues)
    assert r.calibration.custom_reference


def test_circumference_chart_needs_manual_input(no_depth_config):
    r = process_scan(request(make_frames(), chart_id="demo-length-circumference-v1"))
    assert r.recommendation.status == "needs_more_data"
    assert r.recommendation.needed_measurements == ["hand_circumference_mm"]


def test_circumference_chart_with_manual_input(no_depth_config):
    r = process_scan(
        request(
            make_frames(), chart_id="demo-length-circumference-v1", manual_measurements={"hand_circumference_mm": 230}
        )
    )
    assert r.recommendation.size is not None
    assert {b.key for b in r.recommendation.by_measurement} == {"hand_circumference_mm", "hand_length_mm"}


def test_calibrated_system_reports_validated_basis(no_depth_config, monkeypatch):
    import glovesize.pipeline as pipeline

    base = load_measurement_calibration()
    entries = {k: CalibrationEntry(scale=1.0, offset_mm=0.0, residual_sd_mm=2.0) for k in base.measurements}
    calibrated = base.model_copy(update={"status": "calibrated", "measurements": entries})
    monkeypatch.setattr(pipeline, "load_measurement_calibration", lambda: calibrated)
    r = process_scan(request(make_frames()))
    assert r.uncertainty_basis == "validated"
    assert not any(i.code == "uncertainty_unvalidated" for i in r.issues)
    hl = next(m for m in r.measurements if m.key == "hand_length_mm")
    assert hl.uncertainty_mm == pytest.approx(2.0, abs=0.3)
    # 185 +/- 2 mm sits inside M (175-187) at 1 sigma; +2 sigma reaches L.
    assert r.recommendation.size == "M"
    assert r.recommendation.confidence_level in ("likely", "borderline")


def test_uncalibrated_recommendation_is_not_overconfident(no_depth_config):
    r = process_scan(request(make_frames(hand_length_mm=181.0)))
    assert r.recommendation.size == "M"
    assert r.recommendation.confidence_level != "clear"
