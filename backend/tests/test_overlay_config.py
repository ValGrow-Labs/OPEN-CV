"""The 3D hand over the camera picture is configuration, not code: a kill switch and a drawing budget.

It only draws; nothing here (or anywhere in the server) depends on it, so these tests only pin the
configuration: validated bounds, the values that ship, and what the phone is told through /api/config."""

import pytest
from pydantic import ValidationError

from glovesize.config import LiveScanParams, Overlay3DParams, load_measurement_config

from .test_api import client  # noqa: F401  (the client fixture)

GOOD = {"enabled": True, "max_frame_ms": 40, "min_fps": 12, "fallback_after_slow_s": 3}


def test_the_shipped_configuration_turns_it_on_with_a_budget():
    o = load_measurement_config().live_scan.overlay_3d
    assert o.enabled is True
    assert o.max_frame_ms > 0 and o.min_fps > 0 and o.fallback_after_slow_s > 0


def test_enabled_defaults_to_on_and_can_be_switched_off():
    rest = {k: v for k, v in GOOD.items() if k != "enabled"}
    assert Overlay3DParams.model_validate(rest).enabled is True
    assert Overlay3DParams.model_validate({**GOOD, "enabled": False}).enabled is False


@pytest.mark.parametrize("key", ["max_frame_ms", "min_fps", "fallback_after_slow_s"])
@pytest.mark.parametrize("bad", [0, -1, "slow", None])
def test_the_budget_must_be_a_positive_number(key, bad):
    with pytest.raises(ValidationError):
        Overlay3DParams.model_validate({**GOOD, key: bad})


@pytest.mark.parametrize("key", ["max_frame_ms", "min_fps", "fallback_after_slow_s"])
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


def test_the_phone_is_told_the_switch_and_the_budget(client):  # noqa: F811
    live = client.get("/api/config").json()["live_scan"]
    assert live["overlay_3d"] == load_measurement_config().live_scan.overlay_3d.model_dump()
    assert set(live["overlay_3d"]) == {"enabled", "max_frame_ms", "min_fps", "fallback_after_slow_s"}
