"""The 3D hand over the camera picture is configuration, not code: a kill switch and a drawing budget.

It only draws; nothing here (or anywhere in the server) depends on it, so these tests only pin the
configuration: validated bounds, the values that ship, and what the phone is told through /api/config."""

import pytest
from pydantic import ValidationError

from glovesize.config import LiveScanParams, Overlay3DParams, load_measurement_config

from .test_api import client  # noqa: F401  (the client fixture)

GOOD = {
    "enabled": True,
    "max_frame_ms": 40,
    "min_fps": 12,
    "fallback_after_slow_s": 3,
    "focus_mask": True,
    "focus_mask_max_px": 480,
    "focus_margin": 0.06,
    "focus_feather": 0.05,
    "focus_fade_in_ms": 350,
    "focus_fade_out_ms": 200,
    "focus_alpha": 0.97,
    "tone_hold_ms": 300,
}
BUDGET = ["max_frame_ms", "min_fps", "fallback_after_slow_s"]
FOCUS = ["focus_margin", "focus_feather", "focus_fade_in_ms", "focus_fade_out_ms", "focus_alpha", "tone_hold_ms"]


def test_the_shipped_configuration_turns_it_on_with_a_budget():
    o = load_measurement_config().live_scan.overlay_3d
    assert o.enabled is True
    assert o.max_frame_ms > 0 and o.min_fps > 0 and o.fallback_after_slow_s > 0


def test_enabled_defaults_to_on_and_can_be_switched_off():
    rest = {k: v for k, v in GOOD.items() if k != "enabled"}
    assert Overlay3DParams.model_validate(rest).enabled is True
    assert Overlay3DParams.model_validate({**GOOD, "enabled": False}).enabled is False


def test_the_black_background_defaults_to_on_and_can_be_switched_off():
    rest = {k: v for k, v in GOOD.items() if k != "focus_mask"}
    assert Overlay3DParams.model_validate(rest).focus_mask is True
    assert Overlay3DParams.model_validate({**GOOD, "focus_mask": False}).focus_mask is False


def test_the_mask_canvas_size_defaults_to_480_and_is_bounded():
    rest = {k: v for k, v in GOOD.items() if k != "focus_mask_max_px"}
    assert Overlay3DParams.model_validate(rest).focus_mask_max_px == 480
    assert Overlay3DParams.model_validate({**GOOD, "focus_mask_max_px": 64}).focus_mask_max_px == 64
    assert Overlay3DParams.model_validate({**GOOD, "focus_mask_max_px": 2048}).focus_mask_max_px == 2048


@pytest.mark.parametrize("bad", [0, 63, 2049, -480, 480.5, "big", None])
def test_the_mask_canvas_size_is_a_whole_number_of_pixels_in_range(bad):
    with pytest.raises(ValidationError):
        Overlay3DParams.model_validate({**GOOD, "focus_mask_max_px": bad})


def test_the_shipped_focus_mask_is_off_but_ready_with_sensible_numbers():
    o = load_measurement_config().live_scan.overlay_3d
    assert o.focus_mask is False  # the live picture stays whole; the black is an opt-in display setting
    assert o.focus_mask_max_px == 480
    assert (o.focus_margin, o.focus_feather) == (0.02, 0.04)
    assert (o.focus_fade_in_ms, o.focus_fade_out_ms) == (350, 200)
    assert o.focus_alpha == 0.97 and o.tone_hold_ms == 300


@pytest.mark.parametrize("key", ["focus_margin", "focus_feather"])
@pytest.mark.parametrize("bad", [-0.01, 0.51, "wide", None])
def test_the_clear_window_is_a_fraction_of_the_hand_length(key, bad):
    with pytest.raises(ValidationError):
        Overlay3DParams.model_validate({**GOOD, key: bad})


@pytest.mark.parametrize("key", ["focus_fade_in_ms", "focus_fade_out_ms", "tone_hold_ms"])
@pytest.mark.parametrize("bad", [-1, "slow", None])
def test_the_times_are_not_negative_numbers(key, bad):
    with pytest.raises(ValidationError):
        Overlay3DParams.model_validate({**GOOD, key: bad})


@pytest.mark.parametrize("key", ["focus_fade_in_ms", "focus_fade_out_ms", "tone_hold_ms"])
def test_zero_means_no_fade_and_no_hold(key):
    assert getattr(Overlay3DParams.model_validate({**GOOD, key: 0}), key) == 0


@pytest.mark.parametrize("bad", [0, -0.1, 1.01, "black", None])
def test_the_blackness_is_above_zero_and_at_most_one(bad):
    with pytest.raises(ValidationError):
        Overlay3DParams.model_validate({**GOOD, "focus_alpha": bad})


@pytest.mark.parametrize("key", FOCUS)
def test_every_focus_value_is_required(key):
    rest = {k: v for k, v in GOOD.items() if k != key}
    with pytest.raises(ValidationError):
        Overlay3DParams.model_validate(rest)


@pytest.mark.parametrize("key", BUDGET)
@pytest.mark.parametrize("bad", [0, -1, "slow", None])
def test_the_budget_must_be_a_positive_number(key, bad):
    with pytest.raises(ValidationError):
        Overlay3DParams.model_validate({**GOOD, key: bad})


@pytest.mark.parametrize("key", BUDGET)
def test_every_budget_value_is_required(key):
    rest = {k: v for k, v in GOOD.items() if k != key}
    with pytest.raises(ValidationError):
        Overlay3DParams.model_validate(rest)


def test_unknown_keys_are_refused():
    with pytest.raises(ValidationError):
        Overlay3DParams.model_validate({**GOOD, "point_count": 9000})  # the scene owns its own point counts


def test_the_live_scan_block_requires_it():
    shipped = load_measurement_config().live_scan.model_dump()
    assert "overlay_3d" in shipped
    del shipped["overlay_3d"]
    with pytest.raises(ValidationError):
        LiveScanParams.model_validate(shipped)


def test_the_phone_is_told_the_switches_the_budget_and_the_mask(client):  # noqa: F811
    live = client.get("/api/config").json()["live_scan"]
    assert live["overlay_3d"] == load_measurement_config().live_scan.overlay_3d.model_dump()
    assert set(live["overlay_3d"]) == {"enabled", *BUDGET, "focus_mask", "focus_mask_max_px", *FOCUS}
