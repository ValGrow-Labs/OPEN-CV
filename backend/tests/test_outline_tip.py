"""Outline fingertip (refined_tips) and the information value of a hidden finger.

Pinhole-camera simulation (glovesize/simulation.py): SIMULATED, exact geometry. They show what the code does with a
refined tip and when it ignores one; they say nothing about how well the browser finds a real fingertip.
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from glovesize.api import app
from glovesize.calibration import smoothed_coin_tilts
from glovesize.measurement import aggregate_camera, combine_views, measure_frame, refined_tip
from glovesize.schemas import FrameObservation, RefinedTip
from glovesize.simulation import Scene, simulate_frame

from .conftest import QUARTER

TIPS = {"thumb": (3, 4), "index": (7, 8), "middle": (11, 12), "ring": (15, 16), "little": (19, 20)}


def frames_for(scene: Scene, n: int = 12, seed: int = 4, ratio: float | None = None, source: str = "outline") -> list[FrameObservation]:
    """Simulated frames; with ``ratio`` every finger's tip is moved outward along its distal segment by that fraction."""
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        d = simulate_frame(replace(scene, seed=seed), rng)
        if ratio is not None:
            tips = {}
            for dip, tip in TIPS.values():
                t, p = d["landmarks"][tip], d["landmarks"][dip]
                dx, dy = t["x"] - p["x"], t["y"] - p["y"]
                tips[str(tip)] = {
                    "x": t["x"] + ratio * dx, "y": t["y"] + ratio * dy,
                    "extension_px": abs(ratio) * float(np.hypot(dx, dy)), "source": source,
                }  # fmt: skip
            d["refined_tips"] = tips
        out.append(FrameObservation.model_validate(d))
    return out


def results(frames, cfg):
    tilts = smoothed_coin_tilts([f.coin for f in frames], cfg.calibration.tilt_window_frames)
    return [measure_frame(f, QUARTER, cfg, tilt_deg=t) for f, t in zip(frames, tilts, strict=True)]


def with_fa(cfg, **kw):
    return cfg.model_copy(update={"finger_accuracy": cfg.finger_accuracy.model_copy(update=kw)})


SC = Scene(hand_shape="photo")


def test_outline_tip_is_on_by_default(cfg):
    assert cfg.finger_accuracy.outline_tip is True
    assert 0 < cfg.finger_accuracy.outline_tip_max_extension_frac <= 1


def test_refined_tip_lengthens_each_finger_by_its_extension_and_not_the_hand(cfg):
    base = results(frames_for(SC), cfg)[0]
    new = results(frames_for(SC, ratio=0.2), cfg)[0]
    assert base.accepted and new.accepted
    for name in TIPS:
        key = f"{name}_length_mm"
        assert new.tip_sources[key] == "outline" and base.tip_sources[key] == "landmark"
        assert new.tip_ext_mm[key] > 2.0  # 20% of a distal segment of ~20 mm
        # the whole extension is added to the chain (the chain is nearly straight at the tip)
        assert new.values[key] - base.values[key] == pytest.approx(new.tip_ext_mm[key], abs=0.35)
    # the hand length (the size input) still ends on the landmark tip
    assert new.values["hand_length_mm"] == pytest.approx(base.values["hand_length_mm"])
    assert new.values["palm_length_mm"] == pytest.approx(base.values["palm_length_mm"])


def test_flag_off_or_landmark_source_gives_the_landmark_tip(cfg):
    base = results(frames_for(SC), cfg)[0]
    off = results(frames_for(SC, ratio=0.2), with_fa(cfg, outline_tip=False))[0]
    lm = results(frames_for(SC, ratio=0.2, source="landmark"), cfg)[0]
    for r in (off, lm):
        assert r.values["index_length_mm"] == pytest.approx(base.values["index_length_mm"])
        assert r.tip_sources["index_length_mm"] == "landmark"


@pytest.mark.parametrize("ratio", [0.8, -0.1])
def test_a_refined_tip_beyond_the_cap_or_behind_the_landmark_is_ignored(cfg, ratio):
    base = results(frames_for(SC), cfg)[0]
    r = results(frames_for(SC, ratio=ratio), cfg)[0]
    assert r.values["index_length_mm"] == pytest.approx(base.values["index_length_mm"])
    assert r.tip_sources["index_length_mm"] == "landmark"


def test_refined_tip_sanity_checks(cfg):
    fa = cfg.finger_accuracy
    lm = np.zeros((21, 2))
    lm[7], lm[8] = (100.0, 200.0), (100.0, 150.0)  # a distal segment of 50 px pointing up
    chain = [5, 6, 7, 8]

    def entry(x, y, source="outline"):
        return RefinedTip(x=x, y=y, extension_px=abs(150 - y), source=source)

    assert refined_tip(entry(100, 140), lm, chain, fa, 640, 480, 0.02) is not None  # 10 px beyond: fine
    assert refined_tip(entry(100, 140, "landmark"), lm, chain, fa, 640, 480, 0.02) is None
    assert refined_tip(entry(100, 120), lm, chain, fa, 640, 480, 0.02) is None  # 30 px > 0.5 x 50
    assert refined_tip(entry(100, 160), lm, chain, fa, 640, 480, 0.02) is None  # behind the landmark tip
    assert refined_tip(entry(115, 145), lm, chain, fa, 640, 480, 0.02) is None  # sideways off the finger axis
    assert refined_tip(entry(100, 140), lm, chain, fa, 640, 140, 0.02) is None  # outside the frame
    assert refined_tip(None, lm, chain, fa, 640, 480, 0.02) is None


def test_tip_source_counts_and_extension_are_reported_and_combined(cfg, calib):
    f_out = frames_for(SC, n=8, ratio=0.2, seed=1)
    f_lm = frames_for(SC, n=4, seed=1)
    cam = aggregate_camera(results(f_out + f_lm, cfg), cfg, calib)
    index = next(m for m in cam.out if m.key == "index_length_mm")
    assert index.tip_source == {"outline": 8, "landmark": 4}
    assert index.tip_extension_mm is not None and index.tip_extension_mm > 2.0
    hand = next(m for m in cam.out if m.key == "hand_length_mm")
    assert hand.tip_source == {} and hand.tip_extension_mm is None
    cam2 = aggregate_camera(results(frames_for(SC, n=12, ratio=0.2, seed=2), cfg), cfg, calib)
    both = next(m for m in combine_views([cam, cam2], cfg).out if m.key == "index_length_mm")
    assert both.tip_source == {"outline": 20, "landmark": 4}


def test_uncertainty_terms_are_not_reduced_by_an_outline_tip(cfg, calib):
    a = aggregate_camera(results(frames_for(SC), cfg), cfg, calib)
    b = aggregate_camera(results(frames_for(SC, ratio=0.2), cfg), cfg, calib)
    ia, ib = (next(m for m in c.out if m.key == "middle_length_mm") for c in (a, b))
    for k in ("landmark_localisation", "landmark_definition_prior"):
        assert ia.uncertainty_components_mm[k] == pytest.approx(ib.uncertainty_components_mm[k], abs=0.05)


def test_a_hidden_finger_still_carries_its_number_as_information(cfg, calib):
    small = replace(SC, hand_length_mm=100.0, distance_mm=350.0 * 150 / 185)  # the thumb's interval is too wide to show
    cam = aggregate_camera(results(frames_for(small), cfg), cfg, calib)
    thumb = next(m for m in cam.out if m.key == "thumb_length_mm")
    assert thumb.status == "invalid" and thumb.value_mm is None and thumb.uncertainty_mm is None
    assert thumb.reasons == ["uncertainty_too_large"]  # status and reason are exactly what they were
    assert thumb.info_value_mm is not None and thumb.info_uncertainty_mm > 0
    lo, hi = thumb.info_interval95_mm
    assert lo < thumb.info_value_mm < hi
    assert thumb.info_value_mm == pytest.approx(59.0 * 100 / 185, abs=2.5)
    assert "thumb_length_mm" not in cam.kept_values  # nothing for the size to use
    # a shown value carries no information copy
    index = next(m for m in cam.out if m.key == "index_length_mm")
    assert index.value_mm is not None and index.info_value_mm is None


def test_a_finger_hidden_as_bent_still_carries_its_number(cfg, calib):
    cam = aggregate_camera(results(frames_for(SC), cfg), cfg, calib, bent_fingers={"ring"})
    ring = next(m for m in cam.out if m.key == "ring_length_mm")
    assert ring.status == "invalid" and ring.value_mm is None and ring.reasons == ["finger_bent"]
    assert ring.info_value_mm == pytest.approx(93.3, abs=2.0) and ring.info_frames == 12
    assert "ring_length_mm" not in cam.kept_values


def test_only_thumb_and_fingers_get_information_values(cfg, calib):
    cam = aggregate_camera(results(frames_for(replace(SC, hand_length_mm=90.0, distance_mm=350.0 * 150 / 185)), cfg), cfg, calib)
    for m in cam.out:
        if m.key.split("_")[0] not in ("thumb", "index", "middle", "ring", "little"):
            assert m.info_value_mm is None


def test_the_recommendation_ignores_information_values(cfg, calib):
    from glovesize.pipeline import recommendation_from

    small = replace(SC, distance_mm=350.0)
    cam = aggregate_camera(results(frames_for(small), cfg), cfg, calib, bent_fingers={"index"})
    with_info = recommendation_from(cam.out, None)
    stripped = [m.model_copy(update=dict(info_value_mm=None, info_uncertainty_mm=None, info_interval95_mm=None, info_frames=None)) for m in cam.out]
    assert with_info.model_dump() == recommendation_from(stripped, None).model_dump()


def test_schema_accepts_refined_tips_and_rejects_bad_ones():
    d = simulate_frame(SC)
    d["refined_tips"] = {"8": {"x": 1.0, "y": 2.0, "extension_px": 3.0, "source": "outline"}}
    assert FrameObservation.model_validate(d).refined_tips["8"].source == "outline"
    for bad in ({"9": {"x": 1, "y": 2, "extension_px": 3, "source": "outline"}},
                {"8": {"x": 1, "y": 2, "extension_px": -3, "source": "outline"}},
                {"8": {"x": 1, "y": 2, "extension_px": 3, "source": "guess"}},
                {"8": {"x": float("nan"), "y": 2, "extension_px": 3, "source": "outline"}}):
        with pytest.raises(ValidationError):
            FrameObservation.model_validate({**d, "refined_tips": bad})


def test_public_config_tells_the_phone_about_the_outline_tip():
    cfg = TestClient(app).get("/api/config").json()
    assert cfg["finger_tip"] == {"enabled": True, "max_extension_frac": 0.5}


def test_a_scan_with_refined_tips_goes_through_the_api():
    rng = np.random.default_rng(9)
    frames = []
    for i in range(12):
        d = simulate_frame(replace(SC, seed=2, landmark_noise_px=1.0), rng)
        d["timestamp_ms"] = float(i * 50)
        t, p = d["landmarks"][8], d["landmarks"][7]
        d["refined_tips"] = {"8": {"x": t["x"] + 0.2 * (t["x"] - p["x"]), "y": t["y"] + 0.2 * (t["y"] - p["y"]), "extension_px": 8.0, "source": "outline"}}
        frames.append(d)
    body = {"frames": frames, "reference": {"object_id": "us_quarter", "confirmed": True, "size_checked": True}}
    r = TestClient(app).post("/api/scan", json=body)
    assert r.status_code == 200, r.text
    index = next(m for m in r.json()["measurements"] if m["key"] == "index_length_mm")
    assert index["tip_source"].get("outline", 0) >= 10
    assert index["tip_extension_mm"] and index["tip_extension_mm"] > 1.0
