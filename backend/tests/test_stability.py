"""A scan survives a few stray frames, and the back of the hand has its own flatness limit.

Seen on a phone recording of the back-of-hand view: the model's depth estimate of a flat back of hand
reads 28-43 degrees (close to the palm limit of 45), so most frames were refused as "not flat", and one
frame taken while the phone drifted measured the hand 20% short and failed the stability gate for the
whole scan. Now a view may carry its own flatness limit (config views[].max_palm_tilt_deg_model) and a few
stray hand-length frames are dropped (capture.frame_outlier_rel) before the stability gate.

All frames are SYNTHETIC; they show how the rules behave, not real-world accuracy."""

import math

import pytest
from pydantic import ValidationError

import glovesize.pipeline as pipeline
from glovesize.config import CaptureParams, load_measurement_config
from glovesize.pipeline import process_scan
from glovesize.synthetic import CANONICAL_HAND_MM

from .test_api import client  # noqa: F401  (the client fixture)
from .test_multi_view import back, codes, palm, request, use  # noqa: F401  (the `use` fixture)

HAND_LENGTH = "hand_length_mm"


def stray(frames: list[dict], indexes, scale: float) -> list[dict]:
    """Frames at ``indexes`` with the hand scaled about its centre (the coin unchanged): the phone drifted,
    so the hand came out ``scale`` times its length in millimetres."""
    out = [dict(f) for f in frames]
    for i in indexes:
        f = out[i]
        cx = sum(p["x"] for p in f["landmarks"]) / 21
        cy = sum(p["y"] for p in f["landmarks"]) / 21
        f["landmarks"] = [{**p, "x": cx + (p["x"] - cx) * scale, "y": cy + (p["y"] - cy) * scale} for p in f["landmarks"]]
    return out


def with_palm_tilt(frames: list[dict], tilt_deg: float) -> list[dict]:
    """Add depth ("world") landmarks whose palm plane is tilted ``tilt_deg`` from facing the camera."""
    t = math.radians(tilt_deg)
    world = [
        {"x": float(x) / 1000, "y": float(y) * math.cos(t) / 1000, "z": float(y) * math.sin(t) / 1000}
        for x, y in CANONICAL_HAND_MM
    ]
    return [{**f, "world_landmarks": world} for f in frames]


# --- stray frames are dropped, not fatal ------------------------------------------------------------


def test_two_stray_frames_in_the_back_view_do_not_fail_the_scan(use):
    use(("palm", "back"))
    second = stray(back(n=12), (3, 8), 0.8)
    resp = process_scan(request(palm(n=12) + second))
    assert resp.status == "accepted", codes(resp)
    assert resp.frame_rejection_counts.get("frame_outlier") == 2
    assert [v.used for v in resp.views] == [True, True]
    assert next(v for v in resp.views if v.id == "back").frames_accepted == 10


def test_the_stray_frames_would_have_failed_the_stability_gate_without_the_trim(use, monkeypatch):
    c = use(("palm", "back"))
    second = stray(back(n=12), (3, 8), 0.8)
    off = c.model_copy(update={"capture": c.capture.model_copy(update={"frame_outlier_rel": 0.99})})
    monkeypatch.setattr(pipeline, "load_measurement_config", lambda: off)
    rej = process_scan(request(palm(n=12) + second))
    assert rej.status == "rejected" and codes(rej)[0] == "required_view_failed" and "scan_unstable" in codes(rej)


def test_stray_frames_in_the_palm_view_are_dropped_too(use):
    use(("palm", "back"))
    first = stray(palm(n=12), (0, 5), 1.25)
    resp = process_scan(request(first + back(n=12)))
    assert resp.status == "accepted", codes(resp)
    assert resp.frame_rejection_counts.get("frame_outlier") == 2


def test_the_trimmed_frames_do_not_move_the_measurement(use):
    use(("palm", "back"))
    clean = process_scan(request(palm(n=12) + back(n=12)))
    strays = process_scan(request(palm(n=12) + stray(back(n=12), (3, 8), 0.8)))
    a = next(m for m in clean.measurements if m.key == HAND_LENGTH).value_mm
    b = next(m for m in strays.measurements if m.key == HAND_LENGTH).value_mm
    assert b == pytest.approx(a, rel=0.01)


def test_a_view_where_half_the_frames_disagree_is_still_unstable(use):
    use(("palm", "back"))
    second = stray(back(n=12), range(0, 12, 2), 1.25)  # every other frame
    rej = process_scan(request(palm(n=12) + second))
    assert rej.status == "rejected"
    assert codes(rej)[0] == "required_view_failed" and "scan_unstable" in codes(rej)
    assert "frame_outlier" not in rej.frame_rejection_counts  # nothing was trimmed


def test_too_few_frames_left_after_the_trim_is_insufficient_frames(use):
    use(("palm", "back"))
    # 10 frames, 3 strays: 7 are left, below the 8 a phone scan needs per view.
    second = stray(back(n=10), (1, 5, 8), 0.8)
    rej = process_scan(request(palm(n=12) + second, capture={"device_class": "mobile"}))
    assert rej.status == "rejected"
    assert codes(rej)[:2] == ["required_view_failed", "insufficient_frames"]
    assert "frame_outlier" in codes(rej)


# --- the back of the hand has its own flatness limit ------------------------------------------------


def test_a_back_of_hand_the_model_reads_tilted_55_degrees_is_accepted_in_the_back_view(use):
    use(("palm", "back"))
    resp = process_scan(request(palm(n=12) + with_palm_tilt(back(n=12), 55.0)))
    assert resp.status == "accepted", codes(resp)


def test_the_same_reading_is_refused_in_the_palm_view(use):
    use(("palm", "back"))
    rej = process_scan(request(with_palm_tilt(palm(n=12), 55.0) + back(n=12)))
    assert rej.status == "rejected"
    assert rej.frame_rejection_counts.get("palm_not_flat") == 12
    assert "insufficient_frames" in codes(rej)


def test_a_reading_of_70_degrees_is_refused_in_both_views(use):
    use(("palm", "back"))
    rej = process_scan(request(palm(n=12) + with_palm_tilt(back(n=12), 70.0)))
    assert rej.status == "rejected"
    assert codes(rej)[:2] == ["required_view_failed", "insufficient_frames"]
    assert rej.frame_rejection_counts.get("palm_not_flat") == 12
    both = process_scan(request(with_palm_tilt(palm(n=12), 70.0) + with_palm_tilt(back(n=12), 70.0)))
    assert both.status == "rejected" and "palm_not_flat" in both.frame_rejection_counts


# --- configuration ------------------------------------------------------------------------------------


def test_production_configuration_has_the_stability_settings():
    cap = load_measurement_config().capture
    views = {v.id: v for v in cap.views}
    assert cap.frame_outlier_rel == 0.08 and cap.hand_turn_window_frames == 5
    assert views["back"].max_palm_tilt_deg_model == 62.0
    assert views["palm"].max_palm_tilt_deg_model is None and views["side"].max_palm_tilt_deg_model is None
    assert views["back"].max_palm_tilt_deg_model > cap.max_palm_tilt_deg_model
    assert views["side"].max_hand_turn_abs == 0.55


def test_the_stability_settings_are_bounded():
    cap = load_measurement_config().capture.model_dump()
    for key, bad in (
        ("frame_outlier_rel", 0),
        ("frame_outlier_rel", 1),
        ("hand_turn_window_frames", 0),
        ("hand_turn_window_frames", 16),
    ):
        with pytest.raises(ValidationError):
            CaptureParams.model_validate({**cap, key: bad})
    for key, ok in (("frame_outlier_rel", 0.5), ("hand_turn_window_frames", 1), ("hand_turn_window_frames", 15)):
        CaptureParams.model_validate({**cap, key: ok})
    for bad in (0, 90, 120):
        views = [dict(v) for v in cap["views"]]
        views[1]["max_palm_tilt_deg_model"] = bad
        with pytest.raises(ValidationError):
            CaptureParams.model_validate({**cap, "views": views})
    views = [dict(v) for v in cap["views"]]
    views[1]["max_palm_tilt_deg_model"] = 89
    CaptureParams.model_validate({**cap, "views": views})


def test_the_api_gives_the_phone_the_stability_settings(client):  # noqa: F811
    cap = client.get("/api/config").json()["capture"]
    assert cap["frame_outlier_rel"] == 0.08 and cap["hand_turn_window_frames"] == 5
    views = {v["id"]: v for v in cap["views"]}
    assert views["back"]["max_palm_tilt_deg_model"] == 62.0
    assert views["side"]["max_hand_turn_abs"] == 0.55
