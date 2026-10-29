"""Several capture views (palm, back of hand, side view) of the same hand in one scan.

All frames here are SYNTHETIC; they show how the combining and gating rules behave, not real-world
accuracy. A second view is an independent re-measurement used as a cross-check. These tests also pin
down what is *not* claimed: combining views does not shrink any uncertainty term, and the side view
is required but does not enter the size.

Production configuration: palm, back and side are all required. Tests choose which views exist and
which are required through the ``use`` fixture; everywhere else the autouse fixture in conftest.py
reduces the configuration to the palm.
"""

import math

import pytest

import glovesize.pipeline as pipeline
from glovesize import calibration as cal_mod
from glovesize.config import load_measurement_config
from glovesize.pipeline import process_scan
from glovesize.schemas import ScanRequest

from .conftest import make_frames
from .test_api import client, scan_body  # noqa: F401  (the client fixture)

HL = "hand_length_mm"


@pytest.fixture
def use(monkeypatch):
    """Choose the views the pipeline knows (first = primary) and which of them are required."""
    base = load_measurement_config()

    def _use(views=("palm", "back"), required=None, depth=False):
        req = set(views) if required is None else set(required)
        vs = [v.model_copy(update={"required": v.id in req}) for v in base.capture.views if v.id in views]
        c = base.model_copy(update={"capture": base.capture.model_copy(update={"views": vs})})
        if not depth:
            c = c.model_copy(update={"depth_model": c.depth_model.model_copy(update={"enabled": False})})
        monkeypatch.setattr(pipeline, "load_measurement_config", lambda: c)
        return c

    return _use


def tag(frames, view):
    return [{**f, "view": view} for f in frames]


def request(frames, **kw):
    body = {"frames": frames, "reference": {"object_id": "us_quarter", "confirmed": True}}
    body.update(kw)
    return ScanRequest.model_validate(body)


def palm(n=24, **kw):
    return tag(make_frames(n=n, seed=1, **kw), "palm")


def back(n=24, **kw):
    return tag(make_frames(n=n, seed=2, **kw), "back")


def side_frames(n=10, **kw):
    """Frames of an angled hand: nothing like a flat palm (tilted, a finger bent, a coin foreshortened)."""
    frames = tag(make_frames(n=n, seed=3, tilt_deg=40, hand_length_mm=150.0, **kw), "side")
    for f in frames:
        f["landmarks"][12]["x"] += 80  # middle fingertip far off: this would fail every size gate
    return frames


def by_key(resp, key=HL):
    return next(m for m in resp.measurements if m.key == key)


def codes(resp):
    return [i.code for i in resp.issues]


# --- one view -------------------------------------------------------------------------------------


def test_single_view_is_identical_with_or_without_view_tags(use):
    use(("palm",))
    plain = process_scan(request(make_frames()))
    tagged = process_scan(request(palm(n=24)))
    assert plain.model_dump() == tagged.model_dump()
    assert [v.id for v in plain.views] == ["palm"] and plain.views[0].used
    assert plain.view_agreement is None


# --- two views ------------------------------------------------------------------------------------


def test_two_agreeing_views_are_both_used_and_averaged(use):
    use(("palm", "back"))
    palm_only = process_scan(request(make_frames(n=24, seed=1, px_per_mm=3.2)), require_extra_views=False)
    resp = process_scan(request(palm() + back(px_per_mm=3.2 * 1.02)))
    assert resp.status == "accepted"
    assert [(v.id, v.used) for v in resp.views] == [("palm", True), ("back", True)]
    assert resp.view_agreement and resp.view_agreement.agree
    assert resp.frames_received == 48 and resp.frames_accepted == 48
    v_palm, v_back = (v.hand_length_mm for v in resp.views)
    hl = by_key(resp)
    assert hl.value_mm == pytest.approx((v_palm + v_back) / 2, abs=0.1)  # one vote per view
    assert hl.frames_used == 48
    # Combining views claims NO reduction of any term: each component is the average of the views'.
    single = by_key(palm_only)
    assert (
        hl.uncertainty_components_mm["landmark_definition_prior"]
        == single.uncertainty_components_mm["landmark_definition_prior"]
    )
    assert "view_disagreement" in hl.uncertainty_components_mm
    assert hl.uncertainty_mm >= single.uncertainty_mm - 0.15  # never below the single-view sigma
    assert resp.limitations[0].startswith("Measurements come from several camera views")
    assert palm_only.limitations[0].startswith("Measurements come from a single camera view")


def test_disagreeing_views_are_flagged_and_widen_the_uncertainty(use):
    use(("palm", "back"))
    agree = process_scan(request(palm() + back(px_per_mm=3.2 * 1.02)))
    bad = process_scan(request(palm() + back(hand_length_mm=185.0 * 1.2)))
    assert "views_disagree" in codes(bad)
    assert bad.view_agreement and not bad.view_agreement.agree
    assert bad.view_agreement.hand_length_diff_mm == pytest.approx(185 * 0.2, abs=2.0)
    hl_bad, hl_ok = by_key(bad), by_key(agree)
    comp_bad = hl_bad.uncertainty_components_mm["view_disagreement"]
    comp_ok = hl_ok.uncertainty_components_mm["view_disagreement"]
    assert comp_bad > 10 * comp_ok
    assert comp_bad == pytest.approx(185 * 0.2 / 2, abs=1.5)  # |a - b| / 2 for two views
    assert hl_bad.uncertainty_mm > hl_ok.uncertainty_mm
    assert "views_disagree" not in codes(agree)


def test_a_failing_primary_view_rejects_the_scan_even_with_a_good_second_view(use):
    use(("palm", "back"))
    rej = process_scan(request(palm(n=3) + back()))
    assert rej.status == "rejected" and rej.issues[0].code == "insufficient_frames"


def test_a_finger_curled_in_the_second_view_only_is_measured_from_the_other_view(use):
    use(("palm", "back"))
    second = back()
    for f in second:
        f["landmarks"][8]["x"] += 50  # index fingertip bent sideways in the back view only
    resp = process_scan(request(palm() + second))
    assert resp.status == "accepted"
    index = by_key(resp, "index_length_mm")
    palm_only = process_scan(request(make_frames(n=24, seed=1)), require_extra_views=False)
    assert index.value_mm is not None  # measured from the palm view alone
    assert index.model_dump() == by_key(palm_only, "index_length_mm").model_dump()
    assert "view_disagreement" not in index.uncertainty_components_mm


def test_tilt_smoothing_does_not_leak_across_views(use, monkeypatch):
    use(("palm", "back"))
    seen = []
    real = cal_mod.smoothed_coin_tilts

    def spy(coins, window):
        seen.append(len(coins))
        return real(coins, window)

    monkeypatch.setattr(pipeline, "smoothed_coin_tilts", spy)
    process_scan(request(palm() + back(n=12)))
    assert seen == [24, 12]  # one smoothing pass per view, over that view's own frames


# --- optional views are dropped, required views are not ------------------------------------------


def test_an_optional_view_with_too_few_good_frames_is_dropped_not_rejected(use):
    use(("palm", "back"), required=("palm",))
    primary_only = process_scan(request(palm()))
    resp = process_scan(request(palm() + back(n=3)))
    assert resp.status == "accepted"
    second = next(v for v in resp.views if v.id == "back")
    assert not second.used and second.reason == "insufficient_frames"
    assert "view_dropped" in codes(resp)
    assert resp.view_agreement is None
    # The measurements are exactly the palm-only ones.
    assert [m.model_dump() for m in resp.measurements] == [m.model_dump() for m in primary_only.measurements]


def test_an_optional_view_may_be_missing(use):
    use(("palm", "back"), required=("palm",))
    assert process_scan(request(palm())).status == "accepted"


def test_a_required_view_with_too_few_good_frames_rejects_the_scan(use):
    use(("palm", "back"))
    rej = process_scan(request(palm() + back(n=3)))
    assert rej.status == "rejected"
    assert codes(rej)[:2] == ["required_view_failed", "insufficient_frames"]
    assert rej.measurements == [] and rej.recommendation is None


@pytest.mark.parametrize("failing", ["fingers_bent", "scan_unstable"])
def test_a_required_view_that_fails_any_gate_rejects_the_scan(use, failing):
    use(("palm", "back"))
    second = back()
    if failing == "fingers_bent":
        for f in second:
            f["landmarks"][12]["x"] += 80  # middle fingertip far off in the back view
    else:
        for i, f in enumerate(second):  # the hand length jumps between frames
            scale = 1.0 if i % 2 else 1.25
            for p in f["landmarks"]:
                p["y"] = 640 + (p["y"] - 640) * scale
    rej = process_scan(request(palm() + second))
    assert rej.status == "rejected"
    assert codes(rej)[0] == "required_view_failed" and failing in codes(rej)  # with the gate's own guidance


def test_a_missing_required_view_rejects_the_scan(use):
    use(("palm", "back", "side"))
    assert codes(process_scan(request(palm()))) == ["required_view_missing"]
    assert codes(process_scan(request(palm() + side_frames()))) == ["required_view_missing"]  # back missing
    assert codes(process_scan(request(palm() + back()))) == ["required_view_missing"]  # side missing


def test_unknown_view_is_rejected(use):
    use(("palm", "back"))
    rej = process_scan(request(palm() + tag(make_frames(n=8), "sideways")))
    assert rej.status == "rejected" and codes(rej) == ["unknown_view"]


def test_back_frames_without_palm_frames_are_rejected(use):
    use(("palm", "back"))
    rej = process_scan(request(back()))
    assert rej.status == "rejected" and codes(rej) == ["primary_view_missing"]


# --- the side view: required, captured, never used for size --------------------------------------


def test_all_three_views_are_accepted_and_give_the_palm_and_back_result(use):
    use(("palm", "back", "side"))
    three = process_scan(request(palm() + back() + side_frames()))
    use(("palm", "back"))
    two = process_scan(request(palm() + back()))
    assert three.status == "accepted"
    assert [(v.id, v.used) for v in three.views] == [("palm", True), ("back", True), ("side", False)]
    assert [m.model_dump() for m in three.measurements] == [m.model_dump() for m in two.measurements]
    assert three.calibration == two.calibration and three.recommendation == two.recommendation
    assert three.frames_received == two.frames_received == 48  # totals cover size-used views only
    assert codes(three) == codes(two)


def test_the_side_view_is_summarised_and_never_used(use):
    use(("palm", "back", "side"))
    frames = palm() + back() + side_frames(n=10)
    frames[-1]["coin"] = None  # the coin is optional in a capture-only view: the frame still counts
    resp = process_scan(request(frames))
    assert resp.status == "accepted"
    side = next(v for v in resp.views if v.id == "side")
    assert (side.frames_received, side.frames_accepted) == (10, 10)
    assert side.used is False and side.hand_length_mm is None and side.reason == "not_used_for_size"


def test_a_required_side_view_needs_enough_usable_frames_but_not_a_coin(use):
    use(("palm", "back", "side"))
    few = process_scan(request(palm() + back() + side_frames(n=5)))
    assert few.status == "rejected" and codes(few) == ["required_view_failed"]
    # A coin seen edge-on (or not at all) must not hold a customer up: the view is only captured.
    no_coin = side_frames(n=10)
    for f in no_coin:
        f["coin"] = None
    assert process_scan(request(palm() + back() + no_coin)).status == "accepted"
    enough = process_scan(request(palm() + back() + side_frames(n=8)))
    assert enough.status == "accepted"  # 8 = min(frames_min_accepted, 8) usable frames


def test_the_side_view_has_no_size_gates_even_when_required(use):
    use(("palm", "back", "side"))
    resp = process_scan(request(palm() + back() + side_frames()))  # tilted, a bent finger, a short hand
    assert resp.status == "accepted"
    assert resp.finger_bends and resp.frame_rejection_counts == {}


def test_side_frames_do_not_change_any_measurement(use):
    use(("palm", "side"), required=("palm",))
    without = process_scan(request(palm()))
    with_side = process_scan(request(palm() + side_frames()))
    assert with_side.status == "accepted"
    assert [m.model_dump() for m in with_side.measurements] == [m.model_dump() for m in without.measurements]
    assert with_side.calibration == without.calibration
    assert with_side.recommendation == without.recommendation
    assert with_side.finger_bends == without.finger_bends
    assert with_side.frame_rejection_counts == without.frame_rejection_counts
    assert with_side.view_agreement is None
    assert codes(with_side) == codes(without)  # no warning, no drop
    assert with_side.frames_received == 24 and with_side.frames_accepted == 24


def test_an_optional_side_view_with_few_frames_is_not_an_error(use):
    use(("palm", "back", "side"), required=("palm", "back"))
    assert process_scan(request(palm() + back() + side_frames(n=2))).status == "accepted"
    assert process_scan(request(palm() + back())).status == "accepted"


def test_side_frames_alone_are_rejected_for_the_missing_primary_view(use):
    use(("palm", "side"), required=("palm",))
    rej = process_scan(request(side_frames()))
    assert rej.status == "rejected" and codes(rej) == ["primary_view_missing"]
    assert rej.frames_received == 0


def test_an_unknown_view_is_still_rejected_next_to_a_side_view(use):
    use(("palm", "side"), required=("palm",))
    rej = process_scan(request(palm() + side_frames() + tag(make_frames(n=8), "sideways")))
    assert rej.status == "rejected" and codes(rej) == ["unknown_view"]


# --- configuration and the single-view callers ---------------------------------------------------


def test_a_primary_view_must_be_required_and_used_for_size(cfg_all):
    from pydantic import ValidationError

    for field in ("required", "used_for_size"):
        views = [v.model_copy(update={field: False}) if i == 0 else v for i, v in enumerate(cfg_all.capture.views)]
        with pytest.raises(ValidationError):
            type(cfg_all.capture).model_validate({**cfg_all.capture.model_dump(), "views": [v.model_dump() for v in views]})


@pytest.fixture
def cfg_all():
    return load_measurement_config()


def test_production_configuration_requires_all_three_views(cfg_all):
    assert [(v.id, v.required, v.used_for_size) for v in cfg_all.capture.views] == [
        ("palm", True, True),
        ("back", True, True),
        ("side", True, False),
    ]


def test_the_single_view_callers_still_work_on_palm_only_scans(use):
    use(("palm", "back", "side"))  # the production views
    one_palm = request(make_frames())
    assert codes(process_scan(one_palm)) == ["required_view_missing"]  # a customer scan needs every view
    ok = process_scan(one_palm, require_extra_views=False)  # the validation study, the pilot, re-measuring
    assert ok.status == "accepted" and [v.id for v in ok.views] == ["palm"]


def test_the_validation_study_records_palm_only_scans_under_the_production_views(use, operator_client, monkeypatch, tmp_path):
    from glovesize import validation_records as vr
    from glovesize.config import clear_caches
    from .test_validation_mode import body

    monkeypatch.setenv("GLOVESIZE_VALIDATION_ENABLED", "true")
    monkeypatch.setenv("GLOVESIZE_VALIDATION_PATH", str(tmp_path / "records.jsonl"))
    clear_caches()
    use(("palm", "back", "side"))
    r = operator_client.post("/api/validation/scans", json=body())
    assert r.status_code in (200, 201), r.text
    assert r.json()["record"]["scan_status"] == "accepted"
    rid = r.json()["record"]["id"]
    assert vr.remeasure(rid).status == "accepted"  # re-measuring a stored palm-only scan too


def test_the_api_requires_every_view_for_a_customer_scan(use, client):
    use(("palm", "back", "side"))
    body = client.post("/api/scan", json=scan_body(palm(n=16))).json()
    assert body["status"] == "rejected" and body["issues"][0]["code"] == "required_view_missing"
    frames = palm(n=16) + back(n=16) + side_frames(n=10)
    ok = client.post("/api/scan", json=scan_body(frames)).json()
    assert ok["status"] == "accepted"
    assert [(v["id"], v["used"]) for v in ok["views"]] == [("palm", True), ("back", True), ("side", False)]
    assert ok["view_agreement"]["agree"] is True
    bad = client.post("/api/scan", json=scan_body(palm(n=16) + tag(make_frames(n=16, seed=2), "nope"))).json()
    assert bad["issues"][0]["code"] == "unknown_view"
    badly_tagged = [{**f, "view": "Bad View!"} for f in make_frames(n=8)]
    assert client.post("/api/scan", json=scan_body(badly_tagged)).status_code == 422


# --- a phone can be rotated between views: image sizes may differ between views, not within one -------


def sized(frames, size):
    return [{**f, "image_width": size[0], "image_height": size[1]} for f in frames]


def test_views_with_different_image_sizes_are_accepted_and_change_nothing(use):
    use(("palm", "back", "side"))
    same = process_scan(request(palm() + back() + side_frames()))
    # synthetic_frame centres the hand in the image: build each view for its own size
    mixed_frames = (
        palm(image_size=(720, 1280)) + back(image_size=(810, 1440)) + sized(side_frames(), (1080, 1920))
    )
    mixed = process_scan(request(mixed_frames))
    assert mixed.status == "accepted"
    assert [m.model_dump() for m in mixed.measurements] == [m.model_dump() for m in same.measurements]
    assert mixed.calibration == same.calibration
    assert [(v.id, v.used) for v in mixed.views] == [("palm", True), ("back", True), ("side", False)]


def test_the_response_reports_the_primary_views_image_size(use):
    use(("palm", "back"))
    frames = back(image_size=(810, 1440)) + palm(image_size=(720, 1280))  # the back frames come first
    resp = process_scan(request(frames))
    assert resp.status == "accepted"
    assert (resp.image_width, resp.image_height) == (720, 1280)
    rejected = process_scan(request(back(image_size=(810, 1440)) + palm(n=3, image_size=(720, 1280))))
    assert rejected.status == "rejected" and (rejected.image_width, rejected.image_height) == (720, 1280)


def test_frames_of_one_view_must_share_one_image_size(use):
    from pydantic import ValidationError

    use(("palm", "back"))
    mixed_back = back(n=10)
    mixed_back[3] = sized([mixed_back[3]], (810, 1440))[0]
    with pytest.raises(ValidationError, match="'back' view must have the same image size"):
        request(palm() + mixed_back)
    mixed_palm = palm(n=10)
    mixed_palm[0] = sized([mixed_palm[0]], (640, 1136))[0]
    with pytest.raises(ValidationError):
        request(mixed_palm)


def test_the_api_accepts_rotated_views_and_refuses_mixed_sizes_in_one_view(use, client):
    use(("palm", "back", "side"))
    frames = palm(n=16) + back(n=16, image_size=(810, 1440)) + sized(side_frames(n=16), (1080, 1920))
    assert client.post("/api/scan", json=scan_body(frames)).json()["status"] == "accepted"
    mixed = palm(n=16) + back(n=16) + side_frames(n=16)
    mixed[20] = sized([mixed[20]], (810, 1440))[0]  # one back frame at another size
    assert client.post("/api/scan", json=scan_body(mixed)).status_code == 422


def test_three_views_of_sixteen_mobile_frames_fit_the_request_limits(use, client):
    use(("palm", "back", "side"))
    frames = palm(n=16) + back(n=16) + side_frames(n=16)
    assert len(frames) == 48
    r = client.post("/api/scan", json=scan_body(frames, capture={"device_class": "mobile", "camera_facing": "environment"}))
    assert r.status_code == 200 and r.json()["status"] == "accepted"
    cfg_max = load_measurement_config().capture.max_frames_per_request
    assert 3 * 16 <= cfg_max and cfg_max * 1 <= 240  # three views of 16 frames, well inside both limits
    assert client.post("/api/scan", json=scan_body(make_frames(n=8) * 31)).status_code == 422  # 248 frames > 240


# --- a coin resting on the domed back of the hand ------------------------------------------------


def domed_back(tilt_deg: float, n=24):
    """Back-of-hand frames whose COIN is tilted (it rests on the curve of the back of the hand) while
    the hand itself lies flat to the camera. Seen in a phone recording: the coin's axis ratio was
    about 0.94 (about 20 degrees) in most frames, with a consistent direction."""
    major = 24.26 * 3.2  # the synthetic coin's major axis in px
    minor = major * math.cos(math.radians(tilt_deg))
    return tag(make_frames(n=n, seed=2, coin_overrides={"minor_axis_px": minor, "angle_deg": 35.0}), "back")


def test_a_coin_on_the_domed_back_of_the_hand_is_not_refused_for_its_tilt(use):
    cfg = use(("palm", "back"))
    assert [v.max_coin_tilt_deg for v in cfg.capture.views] == [None, 25.0]  # palm keeps the 12 degree limit
    resp = process_scan(request(palm() + domed_back(20.0)))
    assert resp.status == "accepted", codes(resp)
    assert [v.used for v in resp.views] == [True, True]
    assert "coin_tilted" not in resp.frame_rejection_counts
    assert resp.view_agreement and resp.view_agreement.agree


def test_that_scan_was_refused_when_the_back_view_had_the_palm_limit(use, monkeypatch):
    """The recording: with the palm's 12 degree limit every back-view frame is refused for 'coin_tilted'
    and the scan can never complete; the customer cannot flatten a coin on a curved surface."""
    cfg = use(("palm", "back"))
    unlimited = [v.model_copy(update={"max_coin_tilt_deg": None}) for v in cfg.capture.views]
    c = cfg.model_copy(update={"capture": cfg.capture.model_copy(update={"views": unlimited})})
    monkeypatch.setattr(pipeline, "load_measurement_config", lambda: c)
    resp = process_scan(request(palm() + domed_back(20.0)))
    assert resp.status == "rejected"
    assert codes(resp)[0] == "required_view_failed"
    assert resp.frame_rejection_counts.get("coin_tilted", 0) > 0


def test_the_palm_keeps_its_own_tighter_tilt_limit(use):
    use(("palm", "back"))
    tilted_palm = tag(make_frames(n=24, seed=1, coin_overrides={"minor_axis_px": 24.26 * 3.2 * math.cos(math.radians(20)), "angle_deg": 35.0}), "palm")
    resp = process_scan(request(tilted_palm + back()))
    assert resp.status == "rejected"  # a coin tilted 20 degrees on the palm is still refused (limit 12)


def test_a_coin_tilted_beyond_the_back_views_limit_is_still_refused(use):
    use(("palm", "back"))
    resp = process_scan(request(palm() + domed_back(32.0)))
    assert resp.status == "rejected" and codes(resp)[0] == "required_view_failed"
    assert resp.frame_rejection_counts.get("coin_tilted", 0) > 0
