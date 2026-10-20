"""Remote pilot: invites, volunteer enrolment, scans, limits and withdrawal.

All scans here are SYNTHETIC frames in a pytest temp directory; no real participant data.
"""

import json
from datetime import date

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from glovesize import remote_pilot as rp
from glovesize import validation_records as vr
from glovesize.api import app
from glovesize.config import PilotConsent, clear_caches, load_pilot_consent

from .conftest import make_frames

TUNNEL = {"host": "abc.trycloudflare.com", "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7"}


@pytest.fixture
def pilot(monkeypatch, tmp_path, no_depth_config):
    monkeypatch.setenv("GLOVESIZE_VALIDATION_ENABLED", "true")
    monkeypatch.setenv("GLOVESIZE_PILOT_REMOTE_ENABLED", "true")
    monkeypatch.setenv("GLOVESIZE_VALIDATION_PATH", str(tmp_path / "records.jsonl"))
    monkeypatch.delenv("GLOVESIZE_OPERATOR_TOKEN", raising=False)
    clear_caches()
    yield tmp_path
    clear_caches()


@pytest.fixture
def reviewed(monkeypatch):
    c = load_pilot_consent()
    ok = c.model_copy(update={"reviewed": True, "reviewed_by": "study owner", "reviewed_at": date(2026, 10, 20),
                              "paragraphs": ["Reviewed consent text."]})  # fmt: skip
    monkeypatch.setattr(rp, "load_pilot_consent", lambda: ok)
    return ok


@pytest.fixture
def volunteer():
    """A browser on a volunteer's phone, reaching the laptop through the tunnel."""
    return TestClient(app, base_url="https://abc.trycloudflare.com", client=("203.0.113.7", 5000), headers=TUNNEL)


def invite(operator_client, purpose="test", code=None):
    r = operator_client.post(
        "/api/pilot/invites", json={"purpose": purpose, **({"participant_code": code} if code else {})}
    )
    assert r.status_code == 201, r.text
    return r.json()


def enrol_body(consent_version, coin_mm=24.3, readings=(186.0, 187.0), coin="us_quarter"):
    return {
        "consent_version": consent_version, "consent_accepted": True, "hand": "right", "helper": "alone",
        "hand_length": [{"value": v, "unit": "mm"} for v in readings], "tool": "ruler",
        "coin_object_id": coin, "coin_check": {"value": coin_mm, "unit": "mm"}, "device": "test phone",
    }  # fmt: skip


def scan_body(condition="standard", coin="us_quarter", **over):
    return {"condition": condition, "lighting": "indoor_bright", "distance_cm": 38,
            "scan": {"frames": make_frames(), "reference": {"object_id": coin}}, **over}  # fmt: skip


def as_volunteer(client, token):
    client.headers["x-pilot-token"] = token
    return client


# --------------------------------------------------------------------------- #
# Switches and access
# --------------------------------------------------------------------------- #


def test_off_by_default(operator_client, volunteer):
    clear_caches()
    assert operator_client.get("/api/pilot/invites").status_code == 403
    assert as_volunteer(volunteer, "x" * 43).get("/api/pilot/me").status_code == 403
    assert operator_client.get("/api/config").json()["pilot_remote_enabled"] is False


def test_invites_are_operator_only_even_through_the_tunnel(pilot, volunteer):
    # The tunnel connects from 127.0.0.1, but its headers mark it as proxied.
    tunnelled = TestClient(app, base_url="https://abc.trycloudflare.com", client=("127.0.0.1", 5000), headers=TUNNEL)
    for c in (volunteer, tunnelled):
        assert c.get("/api/pilot/invites").status_code == 403
        assert (
            c.post("/api/pilot/invites", json={"purpose": "test"}, headers={"x-glovesize-operator": "1"}).status_code
            == 403
        )
        assert c.get("/api/validation/records").status_code == 403
    only_cf = TestClient(app, base_url="http://127.0.0.1:8080", client=("127.0.0.1", 5000), headers={"cf-ray": "abc"})
    assert only_cf.get("/api/pilot/invites").status_code == 403


def test_a_volunteer_token_opens_nothing_else(pilot, operator_client, volunteer):
    token = invite(operator_client)["token"]
    v = as_volunteer(volunteer, token)
    assert v.get("/api/validation/records").status_code == 403
    assert v.get("/api/validation/records.csv").status_code == 403
    assert v.get("/api/pilot/invites").status_code == 403


def test_unknown_or_missing_token(pilot, volunteer):
    assert volunteer.get("/api/pilot/me").status_code == 401
    assert as_volunteer(volunteer, "y" * 43).get("/api/pilot/me").status_code == 404


# --------------------------------------------------------------------------- #
# Invites and consent
# --------------------------------------------------------------------------- #


def test_real_invites_need_a_reviewed_consent_text(pilot, operator_client):
    r = operator_client.post("/api/pilot/invites", json={"purpose": "pilot"})
    assert r.status_code == 409 and "not been reviewed" in r.text
    assert operator_client.post("/api/pilot/invites", json={"purpose": "test"}).status_code == 201


def test_shipped_consent_is_an_unreviewed_draft():
    clear_caches()
    c = load_pilot_consent()
    assert c.reviewed is False and "DRAFT" in c.paragraphs[0]
    with pytest.raises(ValidationError, match="placeholder"):
        PilotConsent.model_validate({**c.model_dump(mode="json"), "reviewed": True, "reviewed_by": "x",
                                     "reviewed_at": "2026-10-20"})  # fmt: skip


def test_token_is_shown_once_and_stored_only_as_a_hash(pilot, operator_client, reviewed):
    out = invite(operator_client, purpose="pilot", code="P-ABC123")
    stored = (pilot / "pilot_invites.json").read_text(encoding="utf-8")
    assert out["token"] not in stored and rp._hash(out["token"]) in stored
    assert "token" not in json.dumps(operator_client.get("/api/pilot/invites").json()).replace("token_sha256", "")
    assert (
        operator_client.post(
            "/api/pilot/invites", json={"purpose": "pilot", "participant_code": "P-ABC123"}
        ).status_code
        == 409
    )


# --------------------------------------------------------------------------- #
# Enrolment
# --------------------------------------------------------------------------- #


def test_session_shows_plan_consent_and_coins(pilot, operator_client, volunteer):
    v = as_volunteer(volunteer, invite(operator_client)["token"])
    s = v.get("/api/pilot/me").json()
    assert s["scan_plan"] == ["standard"] * 3 + list(vr.CONDITIONS[1:]) and s["enrolment"] is None
    assert {c["id"] for c in s["coins"]} >= {"us_quarter", "inr_2_2019", "inr_1_2019"}
    assert s["consent"]["version"] == load_pilot_consent().version


def test_coin_size_check_catches_an_older_series(pilot, operator_client, volunteer):
    v = as_volunteer(volunteer, invite(operator_client)["token"])
    version = v.get("/api/pilot/me").json()["consent"]["version"]
    r = v.post("/api/pilot/me/enrol", json=enrol_body(version, coin="inr_2_2019", coin_mm=27.0))
    assert r.status_code == 422 and "older series" in r.text
    assert v.post("/api/pilot/me/enrol", json=enrol_body(version, coin="inr_2_2019", coin_mm=23.5)).status_code == 200


def test_enrolment_rules(pilot, operator_client, volunteer):
    v = as_volunteer(volunteer, invite(operator_client)["token"])
    version = v.get("/api/pilot/me").json()["consent"]["version"]
    assert v.post("/api/pilot/me/enrol", json=enrol_body("old-version")).status_code == 409
    assert v.post("/api/pilot/me/enrol", json=enrol_body(version, readings=(180.0, 186.0))).status_code == 422
    assert v.post("/api/pilot/me/enrol", json=enrol_body(version, readings=(186.0,))).status_code == 422  # two needed
    b = enrol_body(version)
    b["consent_accepted"] = False
    assert v.post("/api/pilot/me/enrol", json=b).status_code == 422
    assert v.post("/api/pilot/me/enrol", json=enrol_body(version)).status_code == 200
    assert v.post("/api/pilot/me/enrol", json=enrol_body(version)).status_code == 409  # only once
    assert v.get("/api/pilot/me").json()["enrolment"] == {"hand": "right", "coin_object_id": "us_quarter"}


# --------------------------------------------------------------------------- #
# Scans
# --------------------------------------------------------------------------- #


def enrolled(operator_client, volunteer, purpose="test"):
    v = as_volunteer(volunteer, invite(operator_client, purpose)["token"])
    v.post("/api/pilot/me/enrol", json=enrol_body(v.get("/api/pilot/me").json()["consent"]["version"]))
    return v


def test_scan_is_recorded_without_showing_the_estimate(pilot, operator_client, volunteer):
    v = enrolled(operator_client, volunteer)
    assert v.post("/api/pilot/me/scans", json=scan_body()).status_code == 201
    r = v.post("/api/pilot/me/scans", json=scan_body("distance_far"))
    body = r.json()
    assert body == {"scan_status": "accepted", "reasons": [], "submissions": 2, "max_submissions": 20}
    rec = vr.load_records()[-1]
    assert rec.data_origin == "software_test"  # a test invite never counts as a real participant
    assert (rec.trial.hand, rec.trial.condition) == ("right", "distance_far")
    assert (rec.reference.protocol, rec.reference.measured_by) == ("HL-1-self", "participant")
    assert rec.reference_summary.hand_length_mm == 186.5 and rec.frames_stored
    assert rec.remote.coin_check_mm == 24.3 and rec.remote.helper == "alone"
    assert [s["condition"] for s in v.get("/api/pilot/me").json()["scans"]] == ["standard", "distance_far"]


def test_pilot_invite_records_a_real_participant(pilot, operator_client, volunteer, reviewed):
    v = enrolled(operator_client, volunteer, purpose="pilot")
    v.post("/api/pilot/me/scans", json=scan_body())
    rec = vr.load_records()[-1]
    assert rec.data_origin == "real_participant" and rec.consent_confirmed
    assert rec.remote.consent_version == reviewed.version and rec.remote.consent_text_sha256 == rp.consent_sha256()
    s = vr.summarize(vr.load_records())["real_world"]
    assert s["by_reference_source"]["participant"]["scans"] == 1
    assert s["by_reference_source"]["operator"]["scans"] == 0


def test_scan_rules(pilot, operator_client, volunteer):
    v = as_volunteer(volunteer, invite(operator_client)["token"])
    assert v.post("/api/pilot/me/scans", json=scan_body()).status_code == 409  # not enrolled
    v.post("/api/pilot/me/enrol", json=enrol_body(v.get("/api/pilot/me").json()["consent"]["version"]))
    assert v.post("/api/pilot/me/scans", json=scan_body(coin="inr_2_2019")).status_code == 422
    b = scan_body()
    b["scan"]["manual_measurements"] = {"hand_length_mm": 180}
    assert v.post("/api/pilot/me/scans", json=b).status_code == 422
    for field in ("participant_code", "data_origin", "estimate_mm", "image"):
        assert v.post("/api/pilot/me/scans", json=scan_body(**{field: "x"})).status_code == 422


def test_submission_limit(monkeypatch, pilot, operator_client, volunteer):
    v = enrolled(operator_client, volunteer)
    inv = rp._load()[0]
    inv.max_submissions = 2
    rp._save([inv])
    assert v.post("/api/pilot/me/scans", json=scan_body()).status_code == 201
    assert v.post("/api/pilot/me/scans", json=scan_body()).status_code == 201
    assert v.post("/api/pilot/me/scans", json=scan_body()).status_code == 429


def test_withdrawal_deletes_everything(pilot, operator_client, volunteer):
    v = enrolled(operator_client, volunteer)
    for _ in range(2):
        v.post("/api/pilot/me/scans", json=scan_body())
    other = enrolled(operator_client, TestClient(app, base_url="https://abc.trycloudflare.com",
                                                 client=("203.0.113.8", 5000), headers=TUNNEL))  # fmt: skip
    other.post("/api/pilot/me/scans", json=scan_body())
    assert len(list((pilot / "frames").iterdir())) == 3
    assert v.delete("/api/pilot/me").json() == {"deleted_records": 2}
    assert len(vr.load_records()) == 1 and len(list((pilot / "frames").iterdir())) == 1
    assert v.get("/api/pilot/me").status_code == 410
    assert other.get("/api/pilot/me").status_code == 200


def test_revoked_and_expired_links_stop_working(pilot, operator_client, volunteer):
    out = invite(operator_client)
    v = as_volunteer(volunteer, out["token"])
    assert operator_client.post(f"/api/pilot/invites/{out['invite']['id']}/revoke").json() == {
        "revoked": out["invite"]["id"]
    }
    assert v.get("/api/pilot/me").status_code == 410
    out2 = invite(operator_client)
    invites = rp._load()
    invites[-1].expires_at = "2020-01-01T00:00:00+00:00"
    rp._save(invites)
    assert as_volunteer(volunteer, out2["token"]).get("/api/pilot/me").status_code == 410
    assert {i["status"] for i in operator_client.get("/api/pilot/invites").json()["invites"]} == {"revoked", "expired"}


# --------------------------------------------------------------------------- #
# Pilot-only coins
# --------------------------------------------------------------------------- #


def test_pilot_only_coins_are_refused_in_the_customer_flow(operator_client):
    clear_caches()
    body = {"frames": make_frames(), "reference": {"object_id": "inr_2_2019", "confirmed": True}}
    r = operator_client.post("/api/scan", json=body)
    assert r.status_code == 422 and "pilot study" in r.text
    objects = {o["id"]: o for o in operator_client.get("/api/config").json()["reference_objects"]["objects"]}
    assert objects["inr_2_2019"]["availability"] == "pilot" and objects["us_quarter"]["availability"] == "all"
    assert (objects["inr_2_2019"]["diameter_mm"], objects["inr_1_2019"]["diameter_mm"]) == (23.0, 20.0)
