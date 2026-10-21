"""Remote pilot: invited volunteers measure their own hand and scan it with their own phone.

The operator creates one invite per volunteer in validation mode (operator-only, see
operator_access) and sends the link, for example by WhatsApp. The link carries a random token
in the URL fragment (``#/pilot/<token>``), which browsers never send to servers or proxies. The
token is the volunteer's only credential. With it they can:

* read their own progress and the consent text;
* enrol once: consent, which hand, their ruler readings, the coin and its measured diameter;
* submit scans of that hand, up to ``pilot_max_submissions``;
* withdraw, which deletes every record and frame file they submitted.

They cannot see other volunteers' data, any record contents, or the camera estimates (which
also keeps the estimate from influencing what they report). The server, not the browser,
decides the participant code, the record type (``real_participant`` only for ``pilot`` invites)
and the physical reference used for every scan.

Invites are stored in ``pilot_invites.json`` next to the validation records. Only the SHA-256
of each token is stored, so a copy of the file cannot be used to submit data. Real-participant
invites are refused until config/pilot_consent.json has been reviewed by a person.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import threading
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from . import validation_records as vr
from .config import load_app_config, load_pilot_consent, load_reference_objects
from .research import PARTICIPANT_PATTERN
from .schemas import ScanRequest

_lock = threading.Lock()
# The scan plan shown to volunteers (docs/PILOT_PROTOCOL.md): three standard scans, then one per condition.
SCAN_PLAN: list[str] = ["standard", "standard", "standard", *vr.CONDITIONS[1:]]


class PilotError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Enrolment(_Model):
    consent_version: str
    consent_text_sha256: str
    consented_at: str
    hand: Literal["left", "right"]
    helper: Literal["alone", "with_helper"]
    reference: vr.ReferenceInput
    coin_object_id: str
    coin_check_mm: float
    device: str


class Invite(_Model):
    id: str
    token_sha256: str
    participant_code: str
    purpose: Literal["pilot", "test"]
    created_at: str
    expires_at: str
    max_submissions: int
    submissions: int = 0
    revoked: bool = False
    withdrawn: bool = False
    enrolment: Enrolment | None = None


class EnrolRequest(_Model):
    consent_version: str = Field(max_length=40)
    consent_accepted: Literal[True]
    hand: Literal["left", "right"]
    helper: Literal["alone", "with_helper"]
    hand_length: list[vr.Reading] = Field(min_length=2, max_length=3)
    tool: Literal["ruler", "tape", "calipers", "other"]
    coin_object_id: str = Field(max_length=64)
    coin_check: vr.Reading
    device: str = Field(min_length=1, max_length=80)


class PilotScanRequest(_Model):
    condition: vr.Condition
    lighting: Literal["daylight", "indoor_bright", "indoor_dim", "mixed", "other"]
    distance_cm: float | None = Field(default=None, ge=5, le=200)
    scan: ScanRequest


class InviteCreate(_Model):
    purpose: Literal["pilot", "test"]
    participant_code: str | None = Field(default=None, pattern=PARTICIPANT_PATTERN)


# --------------------------------------------------------------------------- #
# Storage
# --------------------------------------------------------------------------- #


def enabled() -> bool:
    app = load_app_config()
    return app.pilot_remote_enabled and app.validation_mode_enabled


def invites_path() -> Path:
    return vr.store_path().parent / "pilot_invites.json"


def _load() -> list[Invite]:
    path = invites_path()
    if not path.exists():
        return []
    return [Invite.model_validate(d) for d in json.loads(path.read_text(encoding="utf-8"))]


def _save(invites: list[Invite]) -> None:
    vr._write_atomic(invites_path(), json.dumps([i.model_dump(mode="json") for i in invites], indent=2) + "\n")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


def consent_sha256() -> str:
    c = load_pilot_consent()
    return hashlib.sha256(json.dumps([c.version, c.title, c.paragraphs], ensure_ascii=False).encode()).hexdigest()


def pilot_coins() -> list:
    """Coins a remote volunteer may use: every enabled circular reference."""
    return [o for o in load_reference_objects().objects if o.enabled]


# --------------------------------------------------------------------------- #
# Operator actions
# --------------------------------------------------------------------------- #


def create_invite(req: InviteCreate) -> tuple[Invite, str]:
    if req.purpose == "pilot" and not load_pilot_consent().reviewed:
        raise PilotError(409, "the consent text in config/pilot_consent.json has not been reviewed yet; "
                              "only test invites can be created")  # fmt: skip
    app = load_app_config()
    token = secrets.token_urlsafe(32)
    code = req.participant_code or "P-" + secrets.token_hex(3).upper()
    now = _now()
    invite = Invite(
        id=str(uuid.uuid4()), token_sha256=_hash(token), participant_code=code, purpose=req.purpose,
        created_at=now.isoformat(timespec="seconds"),
        expires_at=(now + timedelta(days=app.pilot_invite_days)).isoformat(timespec="seconds"),
        max_submissions=app.pilot_max_submissions,
    )  # fmt: skip
    with _lock:
        invites = _load()
        if any(i.participant_code == code and not i.withdrawn for i in invites):
            raise PilotError(409, f"participant code {code} already has an invite")
        invites.append(invite)
        _save(invites)
    return invite, token


def list_invites() -> list[dict]:
    now = _now()
    return [
        {
            "id": i.id,
            "participant_code": i.participant_code,
            "purpose": i.purpose,
            "created_at": i.created_at,
            "expires_at": i.expires_at,
            "submissions": i.submissions,
            "max_submissions": i.max_submissions,
            "enrolled": i.enrolment is not None,
            "status": _status(i, now),
        }  # fmt: skip
        for i in _load()
    ]


def revoke_invite(invite_id: str) -> None:
    with _lock:
        invites = _load()
        inv = next((i for i in invites if i.id == invite_id), None)
        if inv is None:
            raise PilotError(404, "invite not found")
        inv.revoked = True
        _save(invites)


def _status(i: Invite, now: datetime) -> str:
    if i.withdrawn:
        return "withdrawn"
    if i.revoked:
        return "revoked"
    if now >= datetime.fromisoformat(i.expires_at):
        return "expired"
    if i.submissions >= i.max_submissions:
        return "complete"
    return "open"


# --------------------------------------------------------------------------- #
# Volunteer actions (authenticated by the invite token)
# --------------------------------------------------------------------------- #


def _find(token: str, invites: list[Invite]) -> Invite:
    h = _hash(token or "")
    inv = next((i for i in invites if secrets.compare_digest(i.token_sha256, h)), None)
    if inv is None:
        raise PilotError(404, "this link is not valid")
    status = _status(inv, _now())
    if status in ("withdrawn", "revoked", "expired"):
        raise PilotError(410, f"this link is no longer active ({status})")
    return inv


def session(token: str) -> dict:
    inv = _find(token, _load())
    consent = load_pilot_consent()
    done = [
        {"condition": r.trial.condition, "scan_status": r.scan_status, "reasons": r.scan_rejection_reasons}
        for r in vr.load_records()
        if r.remote and r.remote.invite_id == inv.id
    ]
    e = inv.enrolment
    return {
        "participant_code": inv.participant_code,
        "purpose": inv.purpose,
        "consent": {
            "version": consent.version,
            "title": consent.title,
            "paragraphs": consent.paragraphs,
            "reviewed": consent.reviewed,
        },  # fmt: skip
        "coins": [{"id": o.id, "label": o.label, "diameter_mm": o.diameter_mm} for o in pilot_coins()],
        "coin_check_tolerance_mm": load_app_config().pilot_coin_check_tolerance_mm,
        "enrolment": None if e is None else {"hand": e.hand, "coin_object_id": e.coin_object_id},
        "scan_plan": SCAN_PLAN,
        "scans": done,
        "submissions": inv.submissions,
        "max_submissions": inv.max_submissions,
        "expires_at": inv.expires_at,
    }


def enrol(token: str, req: EnrolRequest) -> None:
    consent = load_pilot_consent()
    if req.consent_version != consent.version:
        raise PilotError(409, "the consent text has changed; reload the page and read it again")
    coin = next((o for o in pilot_coins() if o.id == req.coin_object_id), None)
    if coin is None:
        raise PilotError(422, "unknown coin")
    tol = load_app_config().pilot_coin_check_tolerance_mm
    if abs(req.coin_check.mm - coin.diameter_mm) > tol:
        raise PilotError(422, f"you measured the coin as {req.coin_check.mm:.1f} mm, but {coin.label} is "
                              f"{coin.diameter_mm:g} mm across. It may be a different coin or an older series; "
                              "check the coin and measure again")  # fmt: skip
    reference = vr.ReferenceInput(
        protocol="HL-1-self", hand_length=req.hand_length, tool=req.tool, measured_by="participant"
    )
    ref_summary = vr.summarize_reference(reference, load_app_config().validation_reference_tolerance_mm)
    if ref_summary.reliability != "agreed":
        raise PilotError(
            422, f"your readings differ by {ref_summary.spread_mm:.1f} mm; measure again and add a third reading"
        )
    with _lock:
        invites = _load()
        inv = _find(token, invites)
        if inv.enrolment is not None:
            raise PilotError(409, "you have already entered your measurements")
        inv.enrolment = Enrolment(
            consent_version=consent.version, consent_text_sha256=consent_sha256(),
            consented_at=_now().isoformat(timespec="seconds"), hand=req.hand, helper=req.helper,
            reference=reference, coin_object_id=coin.id, coin_check_mm=round(req.coin_check.mm, 2),
            device=req.device.strip(),
        )  # fmt: skip
        _save(invites)


def submit_scan(token: str, req: PilotScanRequest) -> dict:
    with _lock:
        invites = _load()
        inv = _find(token, invites)
        e = inv.enrolment
        if e is None:
            raise PilotError(409, "enter your measurements before scanning")
        if inv.submissions >= inv.max_submissions:
            raise PilotError(429, "the maximum number of scans for this link has been reached")
        if req.scan.reference.object_id != e.coin_object_id or req.scan.reference.custom_diameter_mm is not None:
            raise PilotError(422, "the scan must use the coin you selected when you enrolled")
        if req.scan.manual_measurements is not None:
            raise PilotError(422, "manual measurements are not accepted in pilot scans")
        inv.submissions += 1  # counted before processing, so failures cannot be retried without limit
        _save(invites)
    scan = req.scan.model_copy(
        update={"reference": req.scan.reference.model_copy(update={"confirmed": True, "size_checked": True})}
    )
    vreq = vr.ValidationScanRequest(
        data_origin="real_participant" if inv.purpose == "pilot" else "software_test",
        consent_confirmed=True,
        participant_code=inv.participant_code,
        reference=e.reference,
        trial=vr.Trial(hand=e.hand, condition=req.condition),
        conditions=vr.CaptureConditions(device=e.device, lighting=req.lighting, distance_cm=req.distance_cm),
        scan=scan,
    )
    remote = vr.RemoteInfo(
        invite_id=inv.id, consent_version=e.consent_version, consent_text_sha256=e.consent_text_sha256,
        consented_at=e.consented_at, helper=e.helper, coin_object_id=e.coin_object_id, coin_check_mm=e.coin_check_mm,
    )  # fmt: skip
    record, _ = vr.run_validation_scan(vreq, remote)
    # Deliberately no camera estimate in the reply (see module docstring).
    return {
        "scan_status": record.scan_status,
        "reasons": record.scan_rejection_reasons,
        "submissions": inv.submissions,
        "max_submissions": inv.max_submissions,
    }


def withdraw(token: str) -> int:
    """Delete every record (and its frames) this volunteer submitted and close the invite."""
    with _lock:
        invites = _load()
        inv = _find(token, invites)
        ids = [r.id for r in vr.load_records() if r.remote and r.remote.invite_id == inv.id]
        for rid in ids:
            vr.delete_record(rid)
        inv.withdrawn, inv.enrolment = True, None
        _save(invites)
    return len(ids)
