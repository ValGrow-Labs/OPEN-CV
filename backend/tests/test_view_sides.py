"""Each view must show the side of the hand it asks for: the back of the hand is the OTHER side to the
palm, and the side view shows the hand on its edge. Showing the palm again as the "back" (seen on a
phone) used to be accepted and measured.

All frames are SYNTHETIC; they show how the checks behave, not real-world accuracy. The thresholds
(config capture.hand_turn_min_abs, views[].max_hand_turn_abs) are provisional."""

import numpy as np
import pytest
from pydantic import ValidationError

from glovesize.config import CaptureParams, load_measurement_config
from glovesize.landmarks import hand_turn
from glovesize.pipeline import process_scan

from .conftest import make_frames, side_on, turn_over
from .test_api import client, scan_body  # noqa: F401  (the client fixture)
from .test_multi_view import back, codes, palm, request, side_frames, tag, use  # noqa: F401  (the `use` fixture)


def turn_of(frame: dict) -> float:
    return hand_turn(np.array([[p["x"], p["y"]] for p in frame["landmarks"]]))


# --- the measure ---------------------------------------------------------------------------------


def test_hand_turn_is_about_point_six_and_flips_when_the_hand_is_turned_over():
    f = make_frames(n=1)[0]
    t = turn_of(f)
    assert abs(t) == pytest.approx(0.6, abs=0.1)
    assert turn_of(turn_over([f])[0]) == pytest.approx(-t)
    assert turn_of(make_frames(n=1, mirror=True)[0]) == pytest.approx(-t, abs=0.02)  # the synthetic mirror agrees (landmark noise differs)


def test_hand_turn_does_not_depend_on_how_the_hand_is_rotated_in_the_picture():
    signs = {np.sign(turn_of(make_frames(n=1, rotation_deg=float(r))[0])) for r in (0, 40, 90, 180, 270)}
    assert len(signs) == 1


def test_a_side_on_hand_reads_a_small_turn():
    assert abs(turn_of(side_on(make_frames(n=1))[0])) < load_measurement_config().capture.views[-1].max_hand_turn_abs


# --- the back view must not be the palm again -----------------------------------------------------


def test_the_palm_shown_twice_is_not_a_back_view(use):
    use(("palm", "back"))
    same = tag(make_frames(n=24, seed=2), "back")  # not turned over
    rej = process_scan(request(palm() + same))
    assert rej.status == "rejected" and codes(rej) == ["view_shows_same_side"]


def test_a_hand_turned_over_is_accepted(use):
    use(("palm", "back"))
    resp = process_scan(request(palm() + back()))
    assert resp.status == "accepted", codes(resp)
    assert [v.used for v in resp.views] == [True, True]


def test_the_check_holds_for_a_mirrored_palm_too(use):
    """A left hand shown twice is as wrong as a right one: it is the same sign in both views, either way."""
    use(("palm", "back"))
    left_palm = tag(make_frames(n=24, seed=1, mirror=True), "palm")
    left_again = tag(make_frames(n=24, seed=2, mirror=True), "back")
    assert codes(process_scan(request(left_palm + left_again))) == ["view_shows_same_side"]
    left_back = tag(make_frames(n=24, seed=2), "back")  # the other side of a left hand
    assert process_scan(request(left_palm + left_back)).status == "accepted"


def test_one_odd_frame_does_not_decide_the_view(use):
    use(("palm", "back"))
    frames = back()
    frames[3] = tag(make_frames(n=1, seed=9), "back")[0]  # one frame that shows the palm
    assert process_scan(request(palm() + frames)).status == "accepted"


def test_an_optional_back_view_is_not_held_to_the_check(use):
    use(("palm", "back"), required=("palm",))
    same = tag(make_frames(n=24, seed=2), "back")
    assert "view_shows_same_side" not in codes(process_scan(request(palm() + same)))


def test_the_single_view_callers_are_not_held_to_the_check(use):
    use(("palm", "back"))
    same = tag(make_frames(n=24, seed=2), "back")
    resp = process_scan(request(palm() + same), require_extra_views=False)
    assert "view_shows_same_side" not in codes(resp)


def test_a_view_that_cannot_be_judged_is_not_rejected_by_the_check(use):
    """A hand seen edge-on (|turn| below hand_turn_min_abs) says nothing about its side: the view's own
    gates decide, not this check."""
    use(("palm", "back"))
    edge = side_on(back(), squash=0.02)
    assert abs(turn_of(edge[0])) < load_measurement_config().capture.hand_turn_min_abs
    assert "view_shows_same_side" not in codes(process_scan(request(palm() + tag(edge, "back"))))


# --- the side view shows the hand on its edge ------------------------------------------------------


def test_a_face_on_hand_is_not_a_side_view(use):
    use(("palm", "back", "side"))
    face_on = tag(make_frames(n=10, seed=3), "side")
    rej = process_scan(request(palm() + back() + face_on))
    assert rej.status == "rejected" and codes(rej) == ["view_not_side_on"]


def test_a_hand_on_its_edge_is_accepted_as_the_side_view(use):
    use(("palm", "back", "side"))
    assert process_scan(request(palm() + back() + side_frames())).status == "accepted"


def test_an_optional_side_view_is_not_held_to_the_check(use):
    use(("palm", "back", "side"), required=("palm", "back"))
    face_on = tag(make_frames(n=10, seed=3), "side")
    assert "view_not_side_on" not in codes(process_scan(request(palm() + back() + face_on)))


# --- configuration -----------------------------------------------------------------------------------


def test_production_configuration_has_the_side_checks():
    cap = load_measurement_config().capture
    views = {v.id: v for v in cap.views}
    assert cap.hand_turn_min_abs == 0.2
    assert views["palm"].opposite_of is None and views["palm"].max_hand_turn_abs is None
    assert views["back"].opposite_of == "palm"
    assert views["side"].max_hand_turn_abs == 0.55
    assert "wrong_side" in views["back"].messages


def test_opposite_of_must_name_an_earlier_view():
    cap = load_measurement_config().capture.model_dump()
    for bad in ("side", "back", "nope"):  # a later view, itself, an unknown view
        views = [dict(v) for v in cap["views"]]
        views[1]["opposite_of"] = bad
        with pytest.raises(ValidationError, match="opposite_of"):
            CaptureParams.model_validate({**cap, "views": views})
    views = [dict(v) for v in cap["views"]]
    views[2]["opposite_of"] = "palm"
    CaptureParams.model_validate({**cap, "views": views})  # an earlier one is fine


def test_the_turn_limits_are_bounded():
    cap = load_measurement_config().capture.model_dump()
    for key, val in (("hand_turn_min_abs", 0), ("hand_turn_min_abs", 1)):
        with pytest.raises(ValidationError):
            CaptureParams.model_validate({**cap, key: val})
    views = [dict(v) for v in cap["views"]]
    views[2]["max_hand_turn_abs"] = 1.5
    with pytest.raises(ValidationError):
        CaptureParams.model_validate({**cap, "views": views})


def test_the_api_gives_the_phone_the_side_settings(client):  # noqa: F811
    cap = client.get("/api/config").json()["capture"]
    assert cap["hand_turn_min_abs"] == 0.2
    views = {v["id"]: v for v in cap["views"]}
    assert views["back"]["opposite_of"] == "palm" and views["side"]["max_hand_turn_abs"] == 0.55
    assert "wrong_side" in views["back"]["messages"]


def test_the_api_rejects_the_palm_shown_as_the_back(use, client):  # noqa: F811
    use(("palm", "back", "side"))
    same = tag(make_frames(n=16, seed=2), "back")
    body = client.post("/api/scan", json=scan_body(palm(n=16) + same + side_frames(n=10))).json()
    assert body["status"] == "rejected" and body["issues"][0]["code"] == "view_shows_same_side"
    assert "Turn your hand over" in body["issues"][0]["message"]
