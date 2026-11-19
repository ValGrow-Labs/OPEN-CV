"""Crease-to-tip finger length ESTIMATE (additive fields next to the knuckle-to-tip value).

SIMULATED pinhole geometry (glovesize/simulation.py): these tests show what the code computes (chain length minus an ASSUMED share
of the MCP-to-PIP segment), not that the share is right for real hands (docs/FINGER_ACCURACY_AUDIT.md, section 12).
"""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from glovesize.api import app
from glovesize.measurement import aggregate_camera, combine_views
from glovesize.pipeline import recommendation_from
from glovesize.simulation import ALL_CHAINS, Scene, hand_points_3d, true_chain_lengths_mm

from .test_outline_tip import SC, frames_for, results, with_fa

NAMES = ("thumb", "index", "middle", "ring", "little")


def by_key(cam):
    return {m.key: m for m in cam.out}


def prox_mm(scene):
    lm, _, _ = hand_points_3d(scene)
    return {n: float(np.linalg.norm(lm[ALL_CHAINS[n][1]] - lm[ALL_CHAINS[n][0]])) for n in NAMES}


def test_the_estimate_is_on_by_default_and_the_t_table_is_the_documented_one(cfg):
    fa = cfg.finger_accuracy
    assert fa.crease_estimate is True
    assert fa.crease_t == {"thumb": 0.05, "index": 0.59, "middle": 0.62, "ring": 0.64, "little": 0.61}
    assert fa.crease_position_halfwidth_frac == pytest.approx(0.2)


def test_crease_to_tip_is_the_chain_minus_t_times_the_mcp_to_pip_segment(cfg, calib):
    m = by_key(aggregate_camera(results(frames_for(SC), cfg), cfg, calib))
    truth, prox = true_chain_lengths_mm(SC), prox_mm(SC)
    for n in NAMES:
        row = m[f"{n}_length_mm"]
        expect = truth[n] - cfg.finger_accuracy.crease_t[n] * prox[n]
        assert row.crease_to_tip_mm == pytest.approx(expect, abs=0.5), n
        assert row.crease_to_tip_mm < row.value_mm
        assert row.crease_t == cfg.finger_accuracy.crease_t[n]
        lo, hi = row.crease_interval95_mm
        assert lo < row.crease_to_tip_mm < hi
    # only thumb and fingers carry it
    for k in ("hand_length_mm", "palm_length_mm", "mcp_span_mm"):
        assert m[k].crease_to_tip_mm is None


def test_the_position_of_the_crease_is_an_extra_uncertainty_term(cfg, calib):
    on = by_key(aggregate_camera(results(frames_for(SC), cfg), cfg, calib))["middle_length_mm"]
    # +-0.2 of a ~46 mm segment, uniform: about 5.3 mm in quadrature on top of the terms of the value
    assert on.crease_uncertainty_mm > on.uncertainty_mm
    assert on.crease_uncertainty_mm == pytest.approx(np.hypot(on.uncertainty_mm, 0.2 * prox_mm(SC)["middle"] / np.sqrt(3)), abs=0.5)
    narrow = with_fa(cfg, crease_position_halfwidth_frac=0.0)
    off = by_key(aggregate_camera(results(frames_for(SC), narrow), narrow, calib))["middle_length_mm"]
    assert off.crease_uncertainty_mm == pytest.approx(on.uncertainty_mm, abs=0.3)


def test_nothing_that_existed_changes_and_the_recommendation_is_identical(cfg, calib):
    off_cfg = with_fa(cfg, crease_estimate=False)
    res_on, res_off = results(frames_for(SC), cfg), results(frames_for(SC), off_cfg)
    on, off = aggregate_camera(res_on, cfg, calib), aggregate_camera(res_off, off_cfg, calib)
    strip = {"crease_to_tip_mm", "crease_uncertainty_mm", "crease_interval95_mm", "crease_status", "crease_t"}
    for a, b in zip(on.out, off.out, strict=True):
        assert a.model_dump(exclude=strip) == b.model_dump(exclude=strip)
        assert b.crease_to_tip_mm is None and b.crease_status is None
    assert recommendation_from(on.out, None).model_dump() == recommendation_from(off.out, None).model_dump()
    assert on.kept_values == off.kept_values and on.kept_sigma == off.kept_sigma


def test_the_outline_tip_lengthens_the_crease_estimate_too(cfg, calib):
    base = by_key(aggregate_camera(results(frames_for(SC), cfg), cfg, calib))["index_length_mm"]
    tip = by_key(aggregate_camera(results(frames_for(SC, ratio=0.25), cfg), cfg, calib))["index_length_mm"]
    assert tip.crease_to_tip_mm - base.crease_to_tip_mm == pytest.approx(tip.value_mm - base.value_mm, abs=0.3)
    assert tip.crease_to_tip_mm - base.crease_to_tip_mm > 3.0


def test_a_hidden_finger_still_has_a_crease_estimate_and_keeps_its_status(cfg, calib):
    cam = aggregate_camera(results(frames_for(SC), cfg), cfg, calib, bent_fingers={"ring"})
    ring = by_key(cam)["ring_length_mm"]
    assert ring.status == "invalid" and ring.value_mm is None and ring.reasons == ["finger_bent"]
    assert ring.crease_to_tip_mm == pytest.approx(true_chain_lengths_mm(SC)["ring"] - 0.64 * prox_mm(SC)["ring"], abs=0.6)
    assert ring.crease_status in ("valid", "low_confidence", "invalid")
    assert "ring_length_mm" not in cam.kept_values  # still nothing for the size


def test_views_are_combined_like_the_values(cfg, calib):
    a = aggregate_camera(results(frames_for(SC, seed=1), cfg), cfg, calib)
    b = aggregate_camera(results(frames_for(SC, seed=2), cfg), cfg, calib)
    both = by_key(combine_views([a, b], cfg))["index_length_mm"]
    va, vb = (by_key(x)["index_length_mm"].crease_to_tip_mm for x in (a, b))
    assert both.crease_to_tip_mm == pytest.approx((va + vb) / 2, abs=0.1)
    assert both.crease_uncertainty_mm >= by_key(a)["index_length_mm"].crease_uncertainty_mm - 0.1


def test_it_is_as_repeatable_as_the_value(cfg, calib):
    """Same frames, same outlier handling: the scan-to-scan spread of the estimate is that of the value (+- the position term, which is fixed)."""
    vals, creases = [], []
    for seed in range(1, 25):
        sc = Scene(hand_shape="photo", landmark_noise_px=2.0, landmark_bias_px=1.5, seed=seed)
        m = by_key(aggregate_camera(results(frames_for(sc, seed=seed), cfg), cfg, calib))["index_length_mm"]
        vals.append(m.value_mm)
        creases.append(m.crease_to_tip_mm)
    assert np.std(creases, ddof=1) == pytest.approx(np.std(vals, ddof=1), rel=0.35)


def test_the_response_carries_the_crease_fields():
    rng = np.random.default_rng(3)
    from dataclasses import replace

    from glovesize.simulation import simulate_frame

    frames = []
    for i in range(12):
        d = simulate_frame(replace(SC, seed=2, landmark_noise_px=1.0), rng)
        d["timestamp_ms"] = float(i * 50)
        frames.append(d)
    body = {"frames": frames, "reference": {"object_id": "us_quarter", "confirmed": True, "size_checked": True}}
    r = TestClient(app).post("/api/scan", json=body)
    assert r.status_code == 200, r.text
    ms = {m["key"]: m for m in r.json()["measurements"]}
    for n in NAMES:
        m = ms[f"{n}_length_mm"]
        assert m["crease_to_tip_mm"] is not None and m["crease_interval95_mm"] and m["crease_status"] and m["crease_t"] is not None
    assert ms["hand_length_mm"]["crease_to_tip_mm"] is None
