"""Optional, consent-based research records for future validation and model improvement.

* Disabled unless ``research_collection_enabled`` (config/app.json or env
  ``GLOVESIZE_RESEARCH_ENABLED``) is true.
* Numeric data only. This endpoint never accepts images; research images are collected
  only in supervised studies with signed consent (docs/DATA_COLLECTION_AND_PRIVACY.md).
* Participants are identified by a random, non-identifying code that the participant can
  use to request deletion.
* Records past their retention period are purged on every write.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

from .config import REPO_ROOT
from .schemas import CaptureContext, MeasurementInput

PARTICIPANT_PATTERN = r"^[A-Za-z0-9_-]{6,40}$"
_lock = threading.Lock()


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Consent(_Model):
    consent_version: str = Field(min_length=1, max_length=32)
    consented_at: AwareDatetime
    measurements: Literal[True] = Field(description="Consent to store the numeric measurements in this record.")
    images: Literal[False] = Field(
        default=False, description="Images are never accepted by this endpoint; must be false."
    )
    retention_days: int = Field(ge=1, le=3650)


class ReferenceMeasurement(_Model):
    key: str = Field(max_length=64)
    value_mm: float = Field(gt=0, lt=1000)
    measured_by: Literal["self", "staff"]
    tool: str = Field(max_length=64)


class FitOutcome(_Model):
    size_worn: str = Field(max_length=16)
    fit: Literal["too_small", "good", "too_large"]
    product_chart_id: str = Field(max_length=64)


class ResearchRecord(_Model):
    participant_code: str = Field(pattern=PARTICIPANT_PATTERN)
    consent: Consent
    estimated_measurements: list[MeasurementInput] = Field(default_factory=list, max_length=32)
    reference_measurements: list[ReferenceMeasurement] = Field(default_factory=list, max_length=32)
    capture: CaptureContext | None = None
    reference_object_id: str | None = Field(default=None, max_length=64)
    chart_id: str | None = Field(default=None, max_length=64)
    recommended_size: str | None = Field(default=None, max_length=16)
    fit_outcome: FitOutcome | None = None

    @field_validator("participant_code")
    @classmethod
    def _not_email(cls, v: str) -> str:
        if "@" in v:
            raise ValueError("participant_code must not contain personal identifiers")
        return v


def store_path() -> Path:
    return Path(os.environ.get("GLOVESIZE_RESEARCH_PATH", REPO_ROOT / "data" / "research" / "records.jsonl"))


def _read_all(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def _write_all(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    tmp.replace(path)


def _expired(row: dict, now: datetime) -> bool:
    stored = datetime.fromisoformat(row["stored_at"])
    return now > stored + timedelta(days=int(row["record"]["consent"]["retention_days"]))


def add_record(record: ResearchRecord, now: datetime | None = None) -> str:
    now = now or datetime.now(UTC)
    record_id = str(uuid.uuid4())
    path = store_path()
    with _lock:
        rows = [r for r in _read_all(path) if not _expired(r, now)]
        rows.append({"record_id": record_id, "stored_at": now.isoformat(), "record": record.model_dump(mode="json")})
        _write_all(path, rows)
    return record_id


def delete_participant(participant_code: str) -> int:
    path = store_path()
    with _lock:
        rows = _read_all(path)
        kept = [r for r in rows if r["record"]["participant_code"] != participant_code]
        if len(kept) != len(rows):
            _write_all(path, kept)
    return len(rows) - len(kept)


def purge_expired(now: datetime | None = None) -> int:
    now = now or datetime.now(UTC)
    path = store_path()
    with _lock:
        rows = _read_all(path)
        kept = [r for r in rows if not _expired(r, now)]
        if len(kept) != len(rows):
            _write_all(path, kept)
    return len(rows) - len(kept)
