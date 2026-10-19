"""Validation dataset files (CSV) and their loading/consistency checks.

participants.csv
    participant_id, split (dev|test), ref_<measurement_key> columns in mm
    (e.g. ref_hand_length_mm, ref_palm_breadth_mm, ref_hand_circumference_mm),
    measured_by, tool
scans.csv (written by extract_from_images.py or exported from the app)
    participant_id, scan_id, status, frames_received, frames_accepted, rejection_codes,
    calibration_status, est_<key>, sd_<key>, status_<key> ...
fit_trials.csv (optional; physical try-on outcome per product)
    participant_id, chart_id, best_size, acceptable_sizes (semicolon-separated)
"""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path

SPLITS = ("dev", "test")


class DatasetError(ValueError):
    pass


@dataclass
class Participant:
    participant_id: str
    split: str
    reference: dict[str, float]


@dataclass
class Scan:
    participant_id: str
    scan_id: str
    accepted: bool
    calibration_status: str
    estimates: dict[str, float] = field(default_factory=dict)
    sigmas: dict[str, float] = field(default_factory=dict)
    statuses: dict[str, str] = field(default_factory=dict)
    rejection_codes: list[str] = field(default_factory=list)


@dataclass
class FitTrial:
    participant_id: str
    chart_id: str
    best_size: str
    acceptable_sizes: list[str]


def _float(v: str | None) -> float | None:
    if v is None or v.strip() == "":
        return None
    return float(v)


def load_participants(path: Path) -> dict[str, Participant]:
    out: dict[str, Participant] = {}
    with Path(path).open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            pid = row["participant_id"].strip()
            split = row["split"].strip().lower()
            if split not in SPLITS:
                raise DatasetError(f"participant {pid}: split must be one of {SPLITS}, got {split!r}")
            if pid in out:
                raise DatasetError(
                    f"participant {pid} listed more than once (a participant must be in exactly one split)"
                )
            ref = {}
            for k, v in row.items():
                if k.startswith("ref_") and (val := _float(v)) is not None:
                    ref[k[4:]] = val
            out[pid] = Participant(pid, split, ref)
    return out


def load_scans(path: Path) -> list[Scan]:
    scans = []
    with Path(path).open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            s = Scan(
                participant_id=row["participant_id"].strip(),
                scan_id=row["scan_id"].strip(),
                accepted=row["status"].strip() == "accepted",
                calibration_status=row.get("calibration_status", "").strip() or "unknown",
                rejection_codes=[c for c in (row.get("rejection_codes") or "").split(";") if c],
            )
            for k, v in row.items():
                if k.startswith("est_") and (val := _float(v)) is not None:
                    s.estimates[k[4:]] = val
                elif k.startswith("sd_") and (val := _float(v)) is not None:
                    s.sigmas[k[3:]] = val
                elif k.startswith("status_") and v:
                    s.statuses[k[7:]] = v.strip()
            scans.append(s)
    return scans


def load_fit_trials(path: Path | None) -> list[FitTrial]:
    if path is None or not Path(path).exists():
        return []
    out = []
    with Path(path).open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            out.append(
                FitTrial(
                    participant_id=row["participant_id"].strip(),
                    chart_id=row["chart_id"].strip(),
                    best_size=row["best_size"].strip(),
                    acceptable_sizes=[s.strip() for s in (row.get("acceptable_sizes") or "").split(";") if s.strip()],
                )
            )
    return out


def check_consistency(participants: dict[str, Participant], scans: list[Scan]) -> None:
    unknown = sorted({s.participant_id for s in scans} - set(participants))
    if unknown:
        raise DatasetError(f"scans reference unknown participants: {unknown[:5]}")
    ids = [(s.participant_id, s.scan_id) for s in scans]
    if len(ids) != len(set(ids)):
        raise DatasetError("duplicate (participant_id, scan_id) rows in scans")


def write_scans(path: Path, rows: list[dict]) -> None:
    keys: list[str] = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    with Path(path).open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)
