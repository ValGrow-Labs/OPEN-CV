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

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, research
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
        "calibration": cfg.calibration.model_dump(),
        "measurement_labels": {k: d.label for k, d in cfg.measurements.items()},
        "manual_measurement_sd_mm": cfg.uncertainty.manual_measurement_sd_mm,
        "calibration_status": calib.status,
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
    }


@app.post("/api/scan", response_model=ScanResponse)
def scan(req: ScanRequest) -> ScanResponse:
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


@app.post("/api/research/records", status_code=201)
def add_research_record(record: research.ResearchRecord) -> dict:
    app_cfg = load_app_config()
    if not app_cfg.research_collection_enabled:
        raise HTTPException(status_code=403, detail="research data collection is disabled")
    if record.consent.retention_days > app_cfg.research_retention_days:
        raise HTTPException(status_code=422, detail="retention_days exceeds the configured maximum")
    record_id = research.add_record(record)
    log.info("research record stored (measurements=%d)", len(record.estimated_measurements))
    return {"record_id": record_id}


@app.delete("/api/research/records/{participant_code}")
def delete_research_records(participant_code: str) -> dict:
    if not re.fullmatch(research.PARTICIPANT_PATTERN, participant_code):
        raise HTTPException(status_code=422, detail="invalid participant code")
    return {"deleted": research.delete_participant(participant_code)}


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
