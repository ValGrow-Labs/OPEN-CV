import json
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from glovesize import research
from glovesize.api import app
from glovesize.config import clear_caches

from .conftest import make_frames


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def scan_body(frames=None, **kw):
    body = {"frames": frames if frames is not None else make_frames(), "reference": {"object_id": "us_quarter"}}
    body.update(kw)
    return body


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_public_config(client):
    cfg = client.get("/api/config").json()
    assert cfg["reference_objects"]["default"] == "us_quarter"
    assert cfg["default_chart_id"] == "demo-length-v1"
    assert all(c["is_demo"] for c in cfg["charts"])
    assert cfg["coin_detection"]["accept"]["min_confidence"] > 0
    assert cfg["calibration_status"] == "uncalibrated"
    assert cfg["research_collection_enabled"] is False


def test_scan_ok(client):
    r = client.post("/api/scan", json=scan_body())
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "accepted"
    assert body["recommendation"]["chart_id"] == "demo-length-v1"


def test_scan_rejects_wrong_landmark_count(client):
    frames = make_frames(n=3)
    frames[0]["landmarks"] = frames[0]["landmarks"][:20]
    assert client.post("/api/scan", json=scan_body(frames)).status_code == 422


def test_scan_rejects_non_finite_values(client):
    frames = make_frames(n=3)
    payload = json.dumps(scan_body(frames)).replace('"x": ' + json.dumps(frames[0]["landmarks"][0]["x"]), '"x": NaN', 1)
    r = client.post("/api/scan", content=payload, headers={"content-type": "application/json"})
    assert r.status_code == 422
    assert "input" not in r.text  # submitted values are not echoed back


def test_scan_rejects_image_payloads(client):
    body = scan_body(make_frames(n=3))
    body["frames"][0]["image"] = "data:image/png;base64,AAAA"
    assert client.post("/api/scan", json=body).status_code == 422


def test_scan_rejects_inconsistent_frame_sizes(client):
    frames = make_frames(n=3)
    frames[1]["image_width"] = 640
    assert client.post("/api/scan", json=scan_body(frames)).status_code == 422


def test_scan_rejects_invalid_coin(client):
    frames = make_frames(n=3)
    frames[0]["coin"]["minor_axis_px"] = frames[0]["coin"]["major_axis_px"] * 1.2
    assert client.post("/api/scan", json=scan_body(frames)).status_code == 422


def test_scan_rejects_ambiguous_reference(client):
    body = scan_body(make_frames(n=3), reference={"object_id": "us_quarter", "custom_diameter_mm": 24.26})
    assert client.post("/api/scan", json=body).status_code == 422


def test_scan_rejects_empty_frames(client):
    assert client.post("/api/scan", json=scan_body([])).status_code == 422


def test_scan_unknown_chart(client):
    assert client.post("/api/scan", json=scan_body(chart_id="missing")).status_code == 404


def test_body_size_limit(client):
    r = client.post("/api/scan", content=b"x" * 2_100_000, headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_recommend_endpoint(client):
    r = client.post(
        "/api/recommend", json={"measurements": [{"key": "hand_length_mm", "value_mm": 181, "uncertainty_mm": 1.5}]}
    )
    assert r.status_code == 200
    assert r.json()["size"] == "M"


def test_recommend_validation(client):
    r = client.post(
        "/api/recommend", json={"measurements": [{"key": "hand_length_mm", "value_mm": -5, "uncertainty_mm": 1}]}
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# Research records
# --------------------------------------------------------------------------- #


def record(code="P-7f3a9c", **over):
    rec = {
        "participant_code": code,
        "consent": {
            "consent_version": "2026-10",
            "consented_at": datetime.now(UTC).isoformat(),
            "measurements": True,
            "retention_days": 30,
        },
        "estimated_measurements": [{"key": "hand_length_mm", "value_mm": 185.2, "uncertainty_mm": 6.0}],
        "reference_measurements": [
            {"key": "hand_length_mm", "value_mm": 183.0, "measured_by": "staff", "tool": "anthropometer"}
        ],
    }
    rec.update(over)
    return rec


@pytest.fixture
def research_enabled(monkeypatch, tmp_path):
    monkeypatch.setenv("GLOVESIZE_RESEARCH_ENABLED", "true")
    monkeypatch.setenv("GLOVESIZE_RESEARCH_PATH", str(tmp_path / "records.jsonl"))
    clear_caches()
    return tmp_path / "records.jsonl"


def test_research_disabled_by_default(client):
    assert client.post("/api/research/records", json=record()).status_code == 403


def test_research_store_and_delete(client, research_enabled):
    r = client.post("/api/research/records", json=record())
    assert r.status_code == 201
    stored = research_enabled.read_text()
    assert "P-7f3a9c" in stored and "image" not in stored.replace('"images": false', "")
    assert client.delete("/api/research/records/P-7f3a9c").json() == {"deleted": 1}
    assert research_enabled.read_text() == ""


def test_research_requires_measurement_consent(client, research_enabled):
    rec = record()
    rec["consent"]["measurements"] = False
    assert client.post("/api/research/records", json=rec).status_code == 422


def test_research_never_accepts_images(client, research_enabled):
    rec = record()
    rec["consent"]["images"] = True
    assert client.post("/api/research/records", json=rec).status_code == 422
    rec = record()
    rec["image"] = "AAAA"
    assert client.post("/api/research/records", json=rec).status_code == 422


def test_research_rejects_identifying_codes(client, research_enabled):
    assert client.post("/api/research/records", json=record(code="jane@example.com")).status_code == 422


def test_research_retention_limit(client, research_enabled):
    rec = record()
    rec["consent"]["retention_days"] = 5000
    assert client.post("/api/research/records", json=rec).status_code == 422


def test_research_expired_records_purged(research_enabled):
    rec = research.ResearchRecord.model_validate(record())
    old = datetime.now(UTC) - timedelta(days=31)
    research.add_record(rec, now=old)
    assert research.purge_expired() == 1
