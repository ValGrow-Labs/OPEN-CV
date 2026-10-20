"""Developer validation mode: real camera scans compared with physical ruler / tape measurements.

The operator measures the participant's hand by the written protocol (docs/PILOT_PROTOCOL.md),
enters the readings with their unit, and scans. The server converts every reading to mm, decides
whether the readings agree, runs the normal measurement pipeline on the submitted scan
observations and computes all errors itself. Camera estimates in a record therefore always come
from a scan; there is no way to type one in.

Integrity rules:

* Each record states its ``data_origin``. Only ``real_participant`` records (consent confirmed by
  the operator) enter the real-world statistics. ``software_test`` records (pytest, browser e2e
  with a fake camera, demos) are stored and listed but excluded from every statistic.
* Scans whose landmarks do not move at all between frames (a still image or replayed data, not a
  live camera) are flagged and excluded.
* Only records made with the current measurement configuration are pooled.
* Accuracy uses only references whose repeated readings agree within the tolerance.

Synthetic software tests (pytest) and simulated camera experiments (docs/CALIBRATION_STUDY.md)
never write here. Nothing in this module can change measurement_calibration.json.

Disabled unless ``validation_mode_enabled`` (config/app.json) or
``GLOVESIZE_VALIDATION_ENABLED=true``; access is further limited by ``operator_access``.

Storage, next to the records file (default ``data/validation/records.jsonl``, override with
``GLOVESIZE_VALIDATION_PATH``):

* ``records.jsonl``: one record per scan.
* ``frames/<record id>.json``: the scan's per-frame numeric observations exactly as submitted
  (landmark coordinates, coin ellipse metrics, brightness), so a pilot scan can be re-measured
  later with a changed configuration. Switch off with ``validation_store_frame_data: false``.
  Deleting a record deletes its frames.
* ``configs/<fingerprint>.json``: the full measurement configuration, calibration and reference
  objects a record was measured with, written once per configuration version.

Numbers only. No image, pixel or video field exists in any request model (unknown fields are
refused), so validation mode cannot store images. Images are collected only in the supervised
image study (docs/DATA_COLLECTION_AND_PRIVACY.md), never through this API.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import threading
import uuid
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from . import __version__, pipeline
from .config import REPO_ROOT, load_app_config
from .research import PARTICIPANT_PATTERN
from .schemas import ScanRequest, ScanResponse

FRAME_DATA_VERSION = 1

_lock = threading.Lock()
Z95 = 1.959964
PROTOCOL = "HL-1"  # docs/PILOT_PROTOCOL.md
MM_PER_UNIT = {"mm": 1.0, "cm": 10.0, "in": 25.4}
RANGES_MM = {
    "hand_length_mm": (100.0, 260.0),
    "palm_breadth_mm": (50.0, 150.0),
    "hand_circumference_mm": (100.0, 400.0),
}
# A live camera always shows sensor noise and hand tremor; MediaPipe jitter is 1-3 px. Landmarks
# that move less than this across the whole scan came from a still image or replayed data.
STATIC_MOTION_PX = 0.05
CONDITIONS = (
    "standard",
    "distance_near",
    "distance_far",
    "coin_off_centre",
    "lighting_changed",
    "hand_rotated",
    "fingers_slightly_bent",
)
Condition = Literal[
    "standard",
    "distance_near",
    "distance_far",
    "coin_off_centre",
    "lighting_changed",
    "hand_rotated",
    "fingers_slightly_bent",
]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Reading(_Model):
    """One physical reading as entered, with its unit. Converted to mm on the server."""

    value: float = Field(gt=0, lt=1000)
    unit: Literal["mm", "cm", "in"]

    @property
    def mm(self) -> float:
        return self.value * MM_PER_UNIT[self.unit]


class ReferenceInput(_Model):
    protocol: Literal["HL-1", "HL-1-self"] = Field(
        description="Physical measurement protocol, docs/PILOT_PROTOCOL.md (HL-1-self: remote self-measurement)."
    )
    hand_length: list[Reading] = Field(
        min_length=1,
        max_length=3,
        description="Distal wrist crease to tip of the middle finger; hand repositioned between readings.",
    )
    palm_breadth: Reading | None = None
    hand_circumference: Reading | None = None
    tool: Literal["ruler", "tape", "calipers", "anthropometer", "other"]
    measured_by: Literal["operator", "participant"]
    operator_code: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,16}$")

    @model_validator(mode="after")
    def _plausible(self) -> ReferenceInput:
        checks = [("hand_length_mm", r) for r in self.hand_length]
        checks += [
            (k, r)
            for k, r in (("palm_breadth_mm", self.palm_breadth), ("hand_circumference_mm", self.hand_circumference))
            if r
        ]
        for key, r in checks:
            lo, hi = RANGES_MM[key]
            if not lo <= r.mm <= hi:
                raise ValueError(
                    f"{key.removesuffix('_mm').replace('_', ' ')} reading {r.value:g} {r.unit} = {r.mm:.1f} mm "
                    f"is outside {lo:.0f}-{hi:.0f} mm; check the value and the unit"
                )
        return self


class CaptureConditions(_Model):
    device: str = Field(min_length=1, max_length=80, description="e.g. 'Pixel 8, rear camera'")
    lighting: Literal["daylight", "indoor_bright", "indoor_dim", "mixed", "other"]
    distance_cm: float | None = Field(default=None, ge=5, le=200, description="Lens to palm, measured by the operator.")
    background: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=280)


class Trial(_Model):
    hand: Literal["left", "right"]
    condition: Condition


class ValidationScanRequest(_Model):
    data_origin: Literal["real_participant", "software_test"]
    consent_confirmed: bool = False
    participant_code: str = Field(pattern=PARTICIPANT_PATTERN)
    reference: ReferenceInput
    trial: Trial
    conditions: CaptureConditions
    scan: ScanRequest

    @model_validator(mode="after")
    def _consent(self) -> ValidationScanRequest:
        if self.data_origin == "real_participant" and not self.consent_confirmed:
            raise ValueError("a real-participant record requires the participant's confirmed consent")
        if "@" in self.participant_code:
            raise ValueError("participant_code must not contain personal identifiers")
        return self


class ReferenceSummary(_Model):
    hand_length_mm: float
    readings_mm: list[float]
    spread_mm: float
    repeated: bool
    reliability: Literal["agreed", "single_reading", "discrepant"]
    tolerance_mm: float


class CaptureInfo(_Model):
    """Coin detection and calibration as observed in this scan (server-derived)."""

    coin_accepted_frames: int
    coin_confidence_median: float | None
    coin_diameter_px: float | None
    px_per_mm: float | None
    coin_tilt_deg: float | None
    depth_correction_factor: float | None
    estimated_camera_distance_mm: tuple[float, float] | None
    image_width: int
    image_height: int
    detected_handedness: Literal["Left", "Right"] | None
    landmark_motion_px: float | None = Field(description="Largest per-landmark SD across the submitted frames.")


class Comparison(_Model):
    key: str
    reference_mm: float
    estimate_mm: float | None
    uncertainty_mm: float | None = Field(description="Camera 1-sigma uncertainty, mm.")
    status: str
    abs_error_mm: float | None
    pct_error: float | None
    signed_error_mm: float | None = Field(description="Camera estimate minus physical reference, mm.")
    within_95: bool | None


class RemoteInfo(_Model):
    """How a remote pilot scan was collected (glovesize/remote_pilot.py)."""

    invite_id: str
    consent_version: str
    consent_text_sha256: str
    consented_at: str
    helper: Literal["alone", "with_helper"]
    coin_object_id: str
    coin_check_mm: float = Field(description="Coin diameter measured by the volunteer with the ruler.")


class ValidationRecord(_Model):
    schema_version: Literal[2] = 2
    id: str
    created_at: str
    data_origin: Literal["real_participant", "software_test"]
    consent_confirmed: bool
    participant_code: str
    trial: Trial
    calibration_status: str
    calibration_validated: bool
    config_fingerprint: str
    app_version: str
    scan_status: Literal["accepted", "rejected"]
    quality_passed: bool
    frames_received: int
    frames_accepted: int
    scan_rejection_reasons: list[str] = Field(description="Why the scan as a whole was rejected (empty if accepted).")
    frame_rejection_counts: dict[str, int] = Field(description="Individual frames dropped during the scan, by reason.")
    reference: ReferenceInput
    reference_summary: ReferenceSummary
    conditions: CaptureConditions
    capture: CaptureInfo
    comparisons: list[Comparison]
    recorded_only: dict[str, float] = Field(
        default_factory=dict,
        description="Reference values (mm) with no camera estimate, kept for future model fitting.",
    )
    integrity_flags: list[str] = Field(default_factory=list)
    frames_stored: bool = Field(default=False, description="Per-frame numeric observations saved in frames/<id>.json.")
    remote: RemoteInfo | None = Field(default=None, description="Set for remote self-measured pilot scans.")


class FrameData(_Model):
    """The numeric observations of one validation scan, exactly as the server measured them."""

    frame_data_version: Literal[1] = FRAME_DATA_VERSION
    record_id: str
    config_fingerprint: str
    scan: ScanRequest


class ConfigSnapshot(_Model):
    """Everything that determines how a scan is measured, identified by its fingerprint."""

    fingerprint: str
    app_version: str
    first_used_at: str
    measurement: dict
    calibration: dict
    reference_objects: dict


def enabled() -> bool:
    return load_app_config().validation_mode_enabled


def store_path() -> Path:
    return Path(os.environ.get("GLOVESIZE_VALIDATION_PATH", REPO_ROOT / "data" / "validation" / "records.jsonl"))


def _config_parts() -> dict:
    # Read through the pipeline module, so the fingerprint describes the configuration that
    # process_scan actually uses.
    return {
        "measurement": pipeline.load_measurement_config().model_dump(mode="json"),
        "calibration": pipeline.load_measurement_calibration().model_dump(mode="json"),
        "reference_objects": pipeline.load_reference_objects().model_dump(mode="json"),
    }


def _fingerprint(parts: dict) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]


def config_fingerprint() -> str:
    """Short hash of everything that changes how a scan is measured, so that records made with
    different thresholds or calibrations are never pooled."""
    return _fingerprint(_config_parts())


def frames_dir() -> Path:
    return store_path().parent / "frames"


def configs_dir() -> Path:
    return store_path().parent / "configs"


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def save_config_snapshot(now: datetime | None = None) -> str:
    """Write the current configuration under its fingerprint (once) and return the fingerprint."""
    parts = _config_parts()
    fp = _fingerprint(parts)
    path = configs_dir() / f"{fp}.json"
    if not path.exists():
        snap = ConfigSnapshot(
            fingerprint=fp, app_version=__version__,
            first_used_at=(now or datetime.now(UTC)).isoformat(timespec="seconds"), **parts,
        )  # fmt: skip
        _write_atomic(path, snap.model_dump_json(indent=2) + "\n")
    return fp


def load_config_snapshot(fingerprint: str) -> ConfigSnapshot | None:
    """The stored configuration for a fingerprint, or None. Raises if the file was altered."""
    path = configs_dir() / f"{fingerprint}.json"
    if not path.exists():
        return None
    snap = ConfigSnapshot.model_validate_json(path.read_text(encoding="utf-8"))
    parts = {
        "measurement": snap.measurement,
        "calibration": snap.calibration,
        "reference_objects": snap.reference_objects,
    }
    if snap.fingerprint != fingerprint or _fingerprint(parts) != fingerprint:
        raise ValueError(f"config snapshot {path.name} does not match its fingerprint")
    return snap


def load_frames(record_id: str) -> FrameData | None:
    path = frames_dir() / f"{record_id}.json"
    if not path.exists():
        return None
    return FrameData.model_validate_json(path.read_text(encoding="utf-8"))


def summarize_reference(ref: ReferenceInput, tolerance_mm: float) -> ReferenceSummary:
    """Median-of-readings rule: two readings must agree within the tolerance; if they do not, a
    third reading is taken and the median is used when it agrees with one of the others."""
    mm = [round(r.mm, 2) for r in ref.hand_length]
    s = sorted(mm)
    tol = tolerance_mm + 1e-9
    if len(s) == 1:
        value, reliability = s[0], "single_reading"
    elif len(s) == 2:
        value, reliability = (s[0] + s[1]) / 2, "agreed" if s[1] - s[0] <= tol else "discrepant"
    else:
        value, reliability = s[1], "agreed" if min(s[1] - s[0], s[2] - s[1]) <= tol else "discrepant"
    return ReferenceSummary(
        hand_length_mm=round(value, 2), readings_mm=mm, spread_mm=round(s[-1] - s[0], 2), repeated=len(s) > 1,
        reliability=reliability, tolerance_mm=tolerance_mm,
    )  # fmt: skip


def _capture_info(req: ValidationScanRequest, resp: ScanResponse) -> CaptureInfo:
    frames = req.scan.frames
    coins = [f.coin for f in frames if f.coin is not None and f.coin.accepted]
    motion = None
    if len(frames) >= 2:
        pts = np.array([[(p.x, p.y) for p in f.landmarks] for f in frames], dtype=float)
        motion = round(float(pts.std(axis=0).max()), 4)
    hands = Counter(f.handedness for f in frames if f.handedness)
    cal = resp.calibration
    return CaptureInfo(
        coin_accepted_frames=len(coins),
        coin_confidence_median=round(float(np.median([c.confidence for c in coins])), 3) if coins else None,
        coin_diameter_px=cal.coin_diameter_px if cal else None,
        px_per_mm=cal.px_per_mm if cal else None,
        coin_tilt_deg=cal.coin_tilt_deg if cal else None,
        depth_correction_factor=cal.depth_correction_factor if cal else None,
        estimated_camera_distance_mm=cal.estimated_camera_distance_mm if cal else None,
        image_width=resp.image_width,
        image_height=resp.image_height,
        detected_handedness=hands.most_common(1)[0][0] if hands else None,
        landmark_motion_px=motion,
    )


def _compare(key: str, ref_mm: float, est) -> Comparison:
    if est is None:
        return Comparison(key=key, reference_mm=ref_mm, estimate_mm=None, uncertainty_mm=None, status="invalid",
                          abs_error_mm=None, pct_error=None, signed_error_mm=None, within_95=None)  # fmt: skip
    err = est.value_mm - ref_mm
    return Comparison(
        key=key,
        reference_mm=ref_mm,
        estimate_mm=est.value_mm,
        uncertainty_mm=est.uncertainty_mm,
        status=est.status,
        abs_error_mm=round(abs(err), 2),
        pct_error=round(100 * err / ref_mm, 2),
        signed_error_mm=round(err, 2),
        within_95=abs(err) <= Z95 * est.uncertainty_mm if est.uncertainty_mm else None,
    )


def build_record(req: ValidationScanRequest, resp: ScanResponse, now: datetime | None = None) -> ValidationRecord:
    calib = pipeline.load_measurement_calibration()
    ref_summary = summarize_reference(req.reference, load_app_config().validation_reference_tolerance_mm)
    estimates = {
        m.key: m
        for m in resp.measurements
        if m.source in ("camera_landmarks", "camera_model_estimate") and m.value_mm is not None
    }
    references = {"hand_length_mm": ref_summary.hand_length_mm}
    for key, reading in (
        ("palm_breadth_mm", req.reference.palm_breadth),
        ("hand_circumference_mm", req.reference.hand_circumference),
    ):
        if reading is not None:
            references[key] = round(reading.mm, 2)
    comparisons: list[Comparison] = []
    recorded_only: dict[str, float] = {}
    for key, ref_mm in references.items():
        if key in estimates:
            comparisons.append(_compare(key, ref_mm, estimates[key]))
        elif key == "hand_length_mm" and resp.status == "accepted":
            # Accepted scan whose hand length was not reliable enough to report: still a result.
            comparisons.append(_compare(key, ref_mm, None))
        elif key != "hand_length_mm":
            recorded_only[key] = ref_mm
    capture = _capture_info(req, resp)
    flags = []
    if capture.landmark_motion_px is not None and capture.landmark_motion_px < STATIC_MOTION_PX:
        flags.append("static_frames")
    return ValidationRecord(
        id=str(uuid.uuid4()),
        created_at=(now or datetime.now(UTC)).isoformat(timespec="seconds"),
        data_origin=req.data_origin,
        consent_confirmed=req.consent_confirmed,
        participant_code=req.participant_code,
        trial=req.trial,
        calibration_status=calib.status,
        calibration_validated=calib.validated,
        config_fingerprint=config_fingerprint(),
        app_version=__version__,
        scan_status=resp.status,
        quality_passed=resp.status == "accepted",
        frames_received=resp.frames_received,
        frames_accepted=resp.frames_accepted,
        scan_rejection_reasons=sorted({i.code for i in resp.issues if i.severity == "error"}),
        frame_rejection_counts=resp.frame_rejection_counts,
        reference=req.reference,
        reference_summary=ref_summary,
        conditions=req.conditions,
        capture=capture,
        comparisons=comparisons,
        recorded_only=recorded_only,
        integrity_flags=flags,
    )


def run_validation_scan(
    req: ValidationScanRequest, remote: RemoteInfo | None = None
) -> tuple[ValidationRecord, ScanResponse]:
    resp = pipeline.process_scan(req.scan)
    record = build_record(req, resp)
    record.remote = remote
    store_frames = load_app_config().validation_store_frame_data
    record.frames_stored = store_frames
    path = store_path()
    with _lock:
        save_config_snapshot()
        if store_frames:
            # Frames first: a record never points at frame data that was not written.
            data = FrameData(record_id=record.id, config_fingerprint=record.config_fingerprint, scan=req.scan)
            _write_atomic(frames_dir() / f"{record.id}.json", data.model_dump_json() + "\n")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(record.model_dump_json() + "\n")
    return record, resp


def remeasure(record_id: str) -> ScanResponse:
    """Run a stored scan through the pipeline again with the current configuration. Compare the
    result with the record (or with the record's config snapshot) to study a configuration change
    on the same scans, without new participants."""
    data = load_frames(record_id)
    if data is None:
        raise FileNotFoundError(f"no frame data stored for record {record_id}")
    return pipeline.process_scan(data.scan)


def read_store() -> tuple[list[ValidationRecord], int]:
    """All readable records, plus the number of lines that could not be read (corrupted or an
    older format). Unreadable lines are reported, never silently dropped or guessed at."""
    path = store_path()
    if not path.exists():
        return [], 0
    records, bad = [], 0
    with path.open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                records.append(ValidationRecord.model_validate_json(line))
            except ValidationError:
                bad += 1
    return records, bad


def load_records() -> list[ValidationRecord]:
    return read_store()[0]


def delete_record(record_id: str) -> bool:
    path = store_path()
    with _lock:
        if not path.exists():
            return False
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        kept = []
        for line in lines:
            try:
                rid = json.loads(line).get("id")
            except (json.JSONDecodeError, AttributeError):
                rid = None
            if rid != record_id:
                kept.append(line)  # unreadable lines are kept verbatim
        if len(kept) == len(lines):
            return False
        tmp = path.with_suffix(".tmp")
        tmp.write_text("".join(kept), encoding="utf-8")
        tmp.replace(path)
        (frames_dir() / f"{record_id}.json").unlink(missing_ok=True)
    return True


# --------------------------------------------------------------------------- #
# Statistics (descriptive; see summarize)
# --------------------------------------------------------------------------- #

HIST_EDGES_MM = [float(e) for e in range(-20, 21, 2)]


def describe_errors(errors: list[float]) -> dict:
    """Descriptive statistics of signed errors (camera minus reference, mm)."""
    e = np.asarray(errors, dtype=float)
    n = int(e.size)
    if n == 0:
        return {"n": 0}
    a = np.abs(e)
    counts, _ = np.histogram(e[(e >= -20) & (e < 20)], bins=HIST_EDGES_MM)
    return {
        "n": n,
        "mean_signed_error_mm": float(e.mean()),
        "mae_mm": float(a.mean()),
        "rmse_mm": float(math.sqrt(float(np.mean(e**2)))),
        "median_abs_error_mm": float(np.median(a)),
        "max_abs_error_mm": float(a.max()),
        "error_sd_mm": float(e.std(ddof=1)) if n > 1 else None,
        "histogram": {
            "bin_edges_mm": HIST_EDGES_MM,
            "counts": counts.tolist(),
            "below": int((e < -20).sum()),
            "above": int((e >= 20).sum()),
        },  # fmt: skip
        "errors_mm": sorted(round(float(x), 2) for x in e),
    }


def sample_note(n_hands: int) -> str:
    if n_hands == 0:
        return "No real-participant results yet: no real-world accuracy can be reported."
    if n_hands < 10:
        return (f"Only {n_hands} hand(s): read the individual results. The summary figures describe these few "
                "people only and do not estimate accuracy for anyone else.")  # fmt: skip
    if n_hands < 30:
        return (f"Pilot sample of {n_hands} hands: the figures describe this sample only. They are not an accuracy "
                "claim, and no confidence interval is given because the sample cannot support one.")  # fmt: skip
    return ("Descriptive figures for this sample. Accuracy claims require the held-out study in "
            "docs/VALIDATION_PLAN.md, with participants not used for any tuning.")  # fmt: skip


def _hand_key(r: ValidationRecord) -> tuple[str, str]:
    return (r.participant_code, r.trial.hand)


def _hl(r: ValidationRecord) -> Comparison | None:
    c = next((c for c in r.comparisons if c.key == "hand_length_mm"), None)
    return c if c is not None and c.estimate_mm is not None else None


def repeatability(records: list[ValidationRecord]) -> dict:
    """Scan-to-scan agreement of the camera estimate for the same hand. Says nothing about
    accuracy: a system can repeat the same wrong value."""
    by_hand: dict[tuple[str, str], dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for r in records:
        c = _hl(r)
        if r.quality_passed and c is not None:
            by_hand[_hand_key(r)][r.trial.condition].append(c.estimate_mm)
    per_hand, ss, dof = [], 0.0, 0
    for (code, hand), conds in sorted(by_hand.items()):
        std = conds.get("standard", [])
        if len(std) >= 2:
            v = np.asarray(std)
            ss += float(((v - v.mean()) ** 2).sum())
            dof += len(v) - 1
            per_hand.append({"participant_code": code, "hand": hand, "n": len(v), "mean_mm": float(v.mean()),
                             "sd_mm": float(v.std(ddof=1)), "range_mm": float(v.max() - v.min())})  # fmt: skip
    within_sd = math.sqrt(ss / dof) if dof else None
    rc = 2.77 * within_sd if within_sd is not None else None
    shifts = {}
    for cond in CONDITIONS[1:]:
        diffs = [
            float(np.mean(c[cond]) - np.mean(c["standard"]))
            for c in by_hand.values()
            if c.get(cond) and c.get("standard")
        ]
        if diffs:
            mean_shift = float(np.mean(diffs))
            shifts[cond] = {
                "n_hands": len(diffs),
                "mean_shift_mm": mean_shift,
                "max_abs_shift_mm": float(np.max(np.abs(diffs))),
                "exceeds_repeatability": abs(mean_shift) > rc if rc is not None else None,
            }
    return {
        "hands_with_repeats": len(per_hand),
        "within_hand_sd_mm": within_sd,
        "repeatability_coefficient_mm": rc,
        "per_hand": per_hand,
        "condition_shifts": shifts,
        "note": "Repeatability is not accuracy: the same wrong value can be repeated consistently.",
    }


def _scored(r: ValidationRecord) -> bool:
    """A scan whose error can be scored: it passed quality checks, reported a hand length, and its
    physical reference readings agreed."""
    return r.quality_passed and _hl(r) is not None and r.reference_summary.reliability == "agreed"


def by_participant(real: list[ValidationRecord]) -> list[dict]:
    """One row per participant and hand. Errors use that hand's standard-condition scans; the
    hand, not the scan, is the unit when comparing people."""
    groups: dict[tuple[str, str], list[ValidationRecord]] = defaultdict(list)
    for r in real:
        groups[_hand_key(r)].append(r)
    rows = []
    for (code, hand), rs in sorted(groups.items()):
        std = [_hl(r).signed_error_mm for r in rs if r.trial.condition == "standard" and _scored(r)]
        other = [_hl(r).signed_error_mm for r in rs if r.trial.condition != "standard" and _scored(r)]
        refs = {r.reference_summary.hand_length_mm for r in rs}
        rows.append({
            "participant_code": code,
            "hand": hand,
            "reference_mm": refs.pop() if len(refs) == 1 else None,
            "reference_reliability": rs[-1].reference_summary.reliability,
            "scans": len(rs),
            "rejected": sum(not r.quality_passed for r in rs),
            "standard_scored": len(std),
            "standard_mean_signed_error_mm": float(np.mean(std)) if std else None,
            "standard_mae_mm": float(np.mean(np.abs(std))) if std else None,
            "standard_error_range_mm": [min(std), max(std)] if std else None,
            "other_conditions_scored": len(other),
            "other_conditions_mean_signed_error_mm": float(np.mean(other)) if other else None,
        })  # fmt: skip
    return rows


# Camera-to-palm distance bands (cm). The supported range starts at about 25 cm (too_close gate).
DISTANCE_BANDS_CM = ((None, 30.0), (30.0, 40.0), (40.0, 50.0), (50.0, None))
MIN_HANDS_PER_GROUP = 3


def _band(cm: float | None) -> str | None:
    if cm is None:
        return None
    for lo, hi in DISTANCE_BANDS_CM:
        if (lo is None or cm >= lo) and (hi is None or cm < hi):
            return (
                f"under {hi:.0f} cm"
                if lo is None
                else f"{lo:.0f} cm and over"
                if hi is None
                else f"{lo:.0f}-{hi:.0f} cm"
            )
    return None


def _band_labels() -> list[str]:
    return [_band(lo if lo is not None else hi - 1) for lo, hi in DISTANCE_BANDS_CM]


def _coin_distance_cm(r: ValidationRecord) -> float | None:
    d = r.capture.estimated_camera_distance_mm
    return math.sqrt(d[0] * d[1]) / 10 if d else None


def _distance_rows(real: list[ValidationRecord], distance_cm) -> list[dict]:
    rows = []
    for label in _band_labels():
        rs = [r for r in real if _band(distance_cm(r)) == label]
        per_hand: dict[tuple[str, str], list[float]] = defaultdict(list)
        for r in rs:
            if _scored(r):
                per_hand[_hand_key(r)].append(_hl(r).signed_error_mm)
        means = [float(np.mean(v)) for v in per_hand.values()]
        rows.append({
            "band": label,
            "scans": len(rs),
            "rejected": sum(not r.quality_passed for r in rs),
            "scans_scored": sum(len(v) for v in per_hand.values()),
            "hands_scored": len(means),
            "mean_signed_error_mm": float(np.mean(means)) if means else None,
            "mae_mm": float(np.mean(np.abs(means))) if means else None,
            "sufficient": len(means) >= MIN_HANDS_PER_GROUP,
        })  # fmt: skip
    return rows


def by_distance(real: list[ValidationRecord]) -> dict:
    """Errors by camera-to-palm distance band, all conditions. Within a band each hand counts
    once (mean of its scans there)."""
    return {
        "scope": "real-participant scans of all conditions; scored scans need agreed physical readings",
        "min_hands_per_band": MIN_HANDS_PER_GROUP,
        "operator_measured": {
            "rows": _distance_rows(real, lambda r: r.conditions.distance_cm),
            "without_distance": sum(r.conditions.distance_cm is None for r in real),
            "note": "Lens-to-palm distance measured by the operator, when entered.",
        },
        "coin_implied": {
            "rows": _distance_rows(real, _coin_distance_cm),
            "without_distance": sum(_coin_distance_cm(r) is None for r in real),
            "note": "Inferred from the coin's size and the assumed 55-80 deg field of view, so it is itself an "
            "estimate. Rejected scans usually have no coin-implied distance.",
        },
    }


def by_reference_source(real: list[ValidationRecord]) -> dict:
    """Accuracy per hand, split by who took the physical readings. Self-measured references are
    less reliable, so they are reported next to, never mixed with, operator-measured ones."""
    out = {}
    for source in ("operator", "participant"):
        per_hand: dict[tuple[str, str], list[float]] = defaultdict(list)
        rs = [r for r in real if r.reference.measured_by == source]
        for r in rs:
            if r.trial.condition == "standard" and _scored(r):
                per_hand[_hand_key(r)].append(_hl(r).signed_error_mm)
        stats = describe_errors([float(np.mean(v)) for v in per_hand.values()])
        stats.pop("histogram", None)
        out[source] = {"scans": len(rs), "hands_scored": len(per_hand), "by_hand": stats}
    return out


def summarize(records: list[ValidationRecord], unreadable_lines: int = 0) -> dict:
    """Separate real-participant results from everything else and describe them. Software test
    records are counted only as excluded; they never enter a statistic."""
    fingerprint = config_fingerprint()
    calib = pipeline.load_measurement_calibration()
    tol = load_app_config().validation_reference_tolerance_mm

    # Cross-record check: one hand must have one physical reference across all its records.
    refs: dict[tuple[str, str], list[float]] = defaultdict(list)
    for r in records:
        if r.data_origin == "real_participant":
            refs[_hand_key(r)].append(r.reference_summary.hand_length_mm)
    record_flags: dict[str, list[str]] = {}
    for r in records:
        flags = list(r.integrity_flags)
        if r.data_origin == "real_participant" and max(refs[_hand_key(r)]) - min(refs[_hand_key(r)]) > tol + 1e-9:
            flags.append("reference_mismatch")
        if r.config_fingerprint != fingerprint:
            flags.append("other_configuration")
        if flags:
            record_flags[r.id] = flags

    excluded = Counter()
    real: list[ValidationRecord] = []
    for r in records:
        if r.data_origin != "real_participant":
            excluded["software_test"] += 1
        elif "other_configuration" in record_flags.get(r.id, []):
            excluded["other_configuration"] += 1
        elif r.id in record_flags:
            excluded["integrity_flag"] += 1
        else:
            real.append(r)
    excluded["unreadable_lines"] = unreadable_lines

    rejected = [r for r in real if not r.quality_passed]
    standard = [r for r in real if r.trial.condition == "standard"]
    scored = [r for r in standard if _scored(r)]
    by_hand: dict[tuple[str, str], list[float]] = defaultdict(list)
    for r in scored:
        by_hand[_hand_key(r)].append(_hl(r).signed_error_mm)
    within = [c.within_95 for r in scored if (c := _hl(r)).within_95 is not None]

    conditions = {}
    for cond in CONDITIONS:
        rs = [r for r in real if r.trial.condition == cond]
        if not rs:
            continue
        errs = [
            _hl(r).signed_error_mm
            for r in rs
            if r.quality_passed and _hl(r) and r.reference_summary.reliability == "agreed"
        ]
        conditions[cond] = {
            "scans": len(rs),
            "rejected": sum(not r.quality_passed for r in rs),
            "scored": len(errs),
            "mean_signed_error_mm": float(np.mean(errs)) if errs else None,
            "mae_mm": float(np.mean(np.abs(errs))) if errs else None,
        }

    return {
        "config_fingerprint": fingerprint,
        "calibration": {"status": calib.status, "validated": calib.validated},
        "real_world": {
            "label": "Real participants, physical reference measurements",
            "participants": len({r.participant_code for r in real}),
            "hands": len({_hand_key(r) for r in real}),
            "scans": {
                "total": len(real),
                "accepted": len(real) - len(rejected),
                "rejected": len(rejected),
                "rejected_pct": 100 * len(rejected) / len(real) if real else None,
                "rejection_reasons": dict(Counter(code for r in rejected for code in r.scan_rejection_reasons)),
                "accepted_without_estimate": sum(r.quality_passed and _hl(r) is None for r in real),
            },
            "references": dict(Counter(r.reference_summary.reliability for r in real)),
            "accuracy": {
                "measurement": "hand_length_mm",
                "scope": "standard-condition scans that passed quality checks, with agreed repeated physical readings",
                "by_scan": describe_errors([_hl(r).signed_error_mm for r in scored]),
                "by_hand": describe_errors([float(np.mean(v)) for v in by_hand.values()]),
                "n_hands": len(by_hand),
                "within_reported_95_interval": {"count": sum(within), "of": len(within)},
                "sample_note": sample_note(len(by_hand)),
            },
            "conditions": conditions,
            "by_participant": by_participant(real),
            "by_reference_source": by_reference_source(real),
            "by_distance": by_distance(real),
            "repeatability": repeatability(real),
        },
        "excluded": dict(excluded),
        "record_flags": record_flags,
    }


# --------------------------------------------------------------------------- #
# CSV export
# --------------------------------------------------------------------------- #

CSV_COLUMNS = [
    "record_id", "created_at", "data_origin", "consent_confirmed", "participant_code", "hand", "condition",
    "protocol", "readings_as_entered", "readings_mm", "reference_mm", "reference_reliability", "reading_spread_mm",
    "measurement", "estimate_mm", "uncertainty_1sd_mm", "signed_error_mm", "abs_error_mm", "pct_error",
    "within_95", "estimate_status", "scan_status", "scan_rejection_reasons", "frames_accepted", "frames_received",
    "coin_accepted_frames", "coin_confidence_median", "px_per_mm", "coin_tilt_deg", "est_camera_distance_mm",
    "operator_distance_cm", "device", "lighting", "image_size", "tool", "measured_by", "operator_code",
    "calibration_status", "calibration_validated", "config_fingerprint", "integrity_flags", "frames_stored", "collection", "consent_version", "coin_object",
    "coin_check_mm", "helper", "notes",
]  # fmt: skip


def _cell(v) -> str:
    """Stringify, and defuse spreadsheet formulas in free text (CSV injection)."""
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") and not _is_number(s) else s


def _is_number(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


def to_csv(records: list[ValidationRecord], record_flags: dict[str, list[str]] | None = None) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLUMNS)
    for r in records:
        rs, cap = r.reference_summary, r.capture
        dist = cap.estimated_camera_distance_mm
        flags = (record_flags or {}).get(r.id, r.integrity_flags)
        for c in r.comparisons or [None]:
            w.writerow([_cell(v) for v in [
                r.id, r.created_at, r.data_origin, r.consent_confirmed, r.participant_code, r.trial.hand,
                r.trial.condition, r.reference.protocol, "; ".join(f"{x.value:g} {x.unit}" for x in r.reference.hand_length),
                "; ".join(f"{x:.2f}" for x in rs.readings_mm), rs.hand_length_mm, rs.reliability, rs.spread_mm,
                c.key if c else "", c.estimate_mm if c else "", c.uncertainty_mm if c else "",
                c.signed_error_mm if c else "", c.abs_error_mm if c else "", c.pct_error if c else "",
                c.within_95 if c else "", c.status if c else "", r.scan_status, ";".join(r.scan_rejection_reasons),
                r.frames_accepted, r.frames_received, cap.coin_accepted_frames, cap.coin_confidence_median,
                cap.px_per_mm, cap.coin_tilt_deg, f"{dist[0]:.0f}-{dist[1]:.0f}" if dist else "",
                r.conditions.distance_cm, r.conditions.device, r.conditions.lighting,
                f"{cap.image_width}x{cap.image_height}", r.reference.tool, r.reference.measured_by,
                r.reference.operator_code, r.calibration_status, r.calibration_validated, r.config_fingerprint,
                ";".join(flags), r.frames_stored, "remote_self" if r.remote else "operator",
                r.remote.consent_version if r.remote else "", r.remote.coin_object_id if r.remote else "",
                r.remote.coin_check_mm if r.remote else "", r.remote.helper if r.remote else "", r.conditions.notes,
            ]])  # fmt: skip
    return buf.getvalue()
