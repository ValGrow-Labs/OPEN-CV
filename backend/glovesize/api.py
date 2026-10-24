"""FastAPI application.

Run: ``uvicorn glovesize.api:app --port 8000`` (from ``backend/``).
If ``frontend/dist`` exists it is served at ``/`` so the app runs as one process.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, operator_access, remote_pilot, research, validation_records
from .config import (
    REPO_ROOT,
    default_chart_id,
    load_app_config,
    load_measurement_calibration,
    load_measurement_config,
    load_reference_objects,
    load_sizing_charts,
)
from .pipeline import UnknownChartError, process_scan, recommend_only
from .schemas import RecommendationOut, RecommendRequest, ScanRequest, ScanResponse

logging.basicConfig(
    level=os.environ.get("GLOVESIZE_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
log = logging.getLogger("glovesize.api")

MAX_BODY_BYTES = 2_000_000


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Fail at startup, not on the first customer request, if any config file is invalid.
    load_reference_objects()
    load_measurement_config()
    load_measurement_calibration()
    load_sizing_charts()
    default_chart_id()
    operator_access.operator_token()  # a too-short token fails startup
    if load_app_config().research_collection_enabled:
        research.purge_expired()
    yield


app = FastAPI(title="Glove Size Measurement API", version=__version__, lifespan=lifespan)

origins = [o for o in os.environ.get("GLOVESIZE_CORS_ORIGINS", "").split(",") if o]
if origins:
    app.add_middleware(
        CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "DELETE"], allow_headers=["*"]
    )


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    # Never echo submitted values back (they may be non-finite numbers, which cannot be
    # JSON-encoded, and there is no reason to return customer data in error bodies).
    errors = [{"loc": list(e.get("loc", ())), "msg": e.get("msg", ""), "type": e.get("type", "")} for e in exc.errors()]
    return JSONResponse({"detail": errors}, status_code=422)


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    length = request.headers.get("content-length")
    if length is not None and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse({"detail": "request body too large"}, status_code=413)
    return await call_next(request)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "version": __version__}


@app.get("/api/config")
def public_config() -> dict:
    """Configuration needed by the browser (thresholds, reference objects, product charts)."""
    cfg = load_measurement_config()
    calib = load_measurement_calibration()
    charts = load_sizing_charts()
    refs = load_reference_objects()
    return {
        "reference_objects": {
            "default": refs.default,
            "objects": [o.model_dump() for o in refs.objects],
        },
        "coin_detection": cfg.coin_detection.model_dump(),
        "capture": cfg.capture.model_dump(),
        "live_scan": cfg.live_scan.model_dump(),
        "calibration": cfg.calibration.model_dump(),
        "measurement_labels": {k: d.label for k, d in cfg.measurements.items()},
        "manual_measurement_sd_mm": cfg.uncertainty.manual_measurement_sd_mm,
        "assumed_hfov_deg": list(cfg.uncertainty.assumed_hfov_deg),
        "calibration_status": calib.status,
        "calibration_validated": calib.validated,
        "charts": [
            {
                "chart_id": c.chart_id,
                "manufacturer": c.manufacturer,
                "product_model": c.product_model,
                "is_demo": c.is_demo,
                "disclaimer": c.disclaimer,
                "measurements": c.rules.measurements,
                "combine": c.rules.combine,
                "sizes": [s.label for s in c.sizes],
            }
            for c in charts.values()
        ],
        "default_chart_id": default_chart_id(),
        "research_collection_enabled": load_app_config().research_collection_enabled,
        "validation_mode_enabled": load_app_config().validation_mode_enabled,
        "validation_reference_tolerance_mm": load_app_config().validation_reference_tolerance_mm,
        "operator_access": operator_access.access_mode(),
        "pilot_remote_enabled": remote_pilot.enabled(),
    }


@app.post("/api/scan", response_model=ScanResponse)
def scan(req: ScanRequest) -> ScanResponse:
    obj = load_reference_objects().get(req.reference.object_id or "")
    if obj is not None and obj.availability == "pilot":
        raise HTTPException(status_code=422, detail="this reference object is only available in the pilot study")
    try:
        return process_scan(req)
    except UnknownChartError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None


@app.post("/api/recommend", response_model=RecommendationOut)
def recommend(req: RecommendRequest) -> RecommendationOut:
    try:
        return recommend_only(req)
    except UnknownChartError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None


# --------------------------------------------------------------------------- #
# Operator-only endpoints. The checks run as dependencies, before the request body is parsed.
# --------------------------------------------------------------------------- #


def _research_access(request: Request) -> None:
    if not load_app_config().research_collection_enabled:
        raise HTTPException(status_code=403, detail="research data collection is disabled")
    operator_access.require_operator(request)


def _validation_access(request: Request) -> None:
    if not validation_records.enabled():
        raise HTTPException(status_code=403, detail="validation mode is disabled")
    operator_access.require_operator(request)


@app.post("/api/research/records", status_code=201, dependencies=[Depends(_research_access)])
def add_research_record(record: research.ResearchRecord) -> dict:
    app_cfg = load_app_config()
    if record.consent.retention_days > app_cfg.research_retention_days:
        raise HTTPException(status_code=422, detail="retention_days exceeds the configured maximum")
    record_id = research.add_record(record)
    log.info("research record stored (measurements=%d)", len(record.estimated_measurements))
    return {"record_id": record_id}


# Deletion requests are processed by an operator; they stay possible when collection is off.
@app.delete("/api/research/records/{participant_code}", dependencies=[Depends(operator_access.require_operator)])
def delete_research_records(participant_code: str) -> dict:
    if not re.fullmatch(research.PARTICIPANT_PATTERN, participant_code):
        raise HTTPException(status_code=422, detail="invalid participant code")
    return {"deleted": research.delete_participant(participant_code)}


# --------------------------------------------------------------------------- #
# Developer validation mode (real camera scans vs. ruler/tape measurements)
# --------------------------------------------------------------------------- #


@app.post("/api/validation/scans", status_code=201, dependencies=[Depends(_validation_access)])
def validation_scan(req: validation_records.ValidationScanRequest) -> dict:
    try:
        record, scan_response = validation_records.run_validation_scan(req)
    except UnknownChartError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None
    log.info("validation record stored (%s, scan %s)", record.data_origin, record.scan_status)
    return {"record": record.model_dump(mode="json"), "scan": scan_response.model_dump(mode="json")}


@app.get("/api/validation/records", dependencies=[Depends(_validation_access)])
def validation_records_list() -> dict:
    records, unreadable = validation_records.read_store()
    return {
        "records": [r.model_dump(mode="json") for r in records],
        "summary": validation_records.summarize(records, unreadable),
    }


@app.delete("/api/validation/records/{record_id}", dependencies=[Depends(_validation_access)])
def validation_record_delete(record_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f-]{36}", record_id) or not validation_records.delete_record(record_id):
        raise HTTPException(status_code=404, detail="record not found")
    return {"deleted": record_id}


@app.get("/api/validation/records.csv", response_class=PlainTextResponse, dependencies=[Depends(_validation_access)])
def validation_records_csv() -> PlainTextResponse:
    records, unreadable = validation_records.read_store()
    flags = validation_records.summarize(records, unreadable)["record_flags"]
    return PlainTextResponse(
        validation_records.to_csv(records, flags),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="validation_records.csv"'},
    )


# --------------------------------------------------------------------------- #
# Remote pilot (glovesize/remote_pilot.py)
# --------------------------------------------------------------------------- #


def _pilot_enabled() -> None:
    if not remote_pilot.enabled():
        raise HTTPException(status_code=403, detail="the remote pilot is not running")


def _pilot_operator(request: Request) -> None:
    _pilot_enabled()
    operator_access.require_operator(request)


def _pilot_token(request: Request) -> str:
    """The volunteer's invite token. A custom header (never the URL) so that it stays out of
    access logs, and so that cross-site pages cannot send it without a CORS preflight."""
    _pilot_enabled()
    token = request.headers.get("x-pilot-token", "")
    if not 20 <= len(token) <= 100:
        raise HTTPException(status_code=401, detail="missing pilot link token")
    return token


def _pilot_call(fn, *args):
    try:
        return fn(*args)
    except remote_pilot.PilotError as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from None


@app.post("/api/pilot/invites", status_code=201, dependencies=[Depends(_pilot_operator)])
def pilot_invite_create(req: remote_pilot.InviteCreate) -> dict:
    invite, token = _pilot_call(remote_pilot.create_invite, req)
    log.info("pilot invite created (%s)", invite.purpose)
    # The token is returned once and never stored in clear text.
    return {"invite": next(i for i in remote_pilot.list_invites() if i["id"] == invite.id), "token": token}


@app.get("/api/pilot/invites", dependencies=[Depends(_pilot_operator)])
def pilot_invite_list() -> dict:
    return {"invites": remote_pilot.list_invites(), "consent_reviewed": remote_pilot.load_pilot_consent().reviewed}


@app.post("/api/pilot/invites/{invite_id}/revoke", dependencies=[Depends(_pilot_operator)])
def pilot_invite_revoke(invite_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f-]{36}", invite_id):
        raise HTTPException(status_code=404, detail="invite not found")
    _pilot_call(remote_pilot.revoke_invite, invite_id)
    return {"revoked": invite_id}


@app.get("/api/pilot/me")
def pilot_session(token: str = Depends(_pilot_token)) -> dict:
    return _pilot_call(remote_pilot.session, token)


@app.post("/api/pilot/me/enrol")
def pilot_enrol(req: remote_pilot.EnrolRequest, token: str = Depends(_pilot_token)) -> dict:
    _pilot_call(remote_pilot.enrol, token, req)
    return {"enrolled": True}


@app.post("/api/pilot/me/scans", status_code=201)
def pilot_scan(req: remote_pilot.PilotScanRequest, token: str = Depends(_pilot_token)) -> dict:
    result = _pilot_call(remote_pilot.submit_scan, token, req)
    log.info("pilot scan stored (scan %s)", result["scan_status"])
    return result


@app.delete("/api/pilot/me")
def pilot_withdraw(token: str = Depends(_pilot_token)) -> dict:
    return {"deleted_records": _pilot_call(remote_pilot.withdraw, token)}


# --------------------------------------------------------------------------- #
# Static frontend (production build)
# --------------------------------------------------------------------------- #

# Windows' registry-based MIME table may lack these; WebAssembly streaming needs application/wasm.
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")

DIST = Path(os.environ.get("GLOVESIZE_FRONTEND_DIST", REPO_ROOT / "frontend" / "dist"))
if DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        candidate = (DIST / path).resolve()
        if path and candidate.is_file() and DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
