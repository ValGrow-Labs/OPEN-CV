# Glove Size Finder

A camera-based hand measurement and glove-size recommendation prototype. The customer places a
US quarter on their open palm. The browser detects 21 hand landmarks (MediaPipe) and the coin
(OpenCV), uses the coin as a millimetre scale, and the server turns those numbers into hand
measurements with explicit uncertainty and a rules-based size recommendation.

> **Status: engineering prototype, not validated.** All accuracy evidence so far comes from
> synthetic tests and a pipeline smoke test. The bundled size charts are **synthetic demos**.
> See [docs/VALIDATION_PLAN.md](docs/VALIDATION_PLAN.md) before any customer use.

## Architecture

```
browser (React + TS)                                  server (FastAPI, Python)
camera ─► MediaPipe Hand Landmarker (WASM)            /api/scan   ─► per-frame gates (authoritative)
       ─► OpenCV.js coin detection (palm ROI)                     ─► coin calibration, tilt + depth correction
       ─► live quality checks, overlay                            ─► measurements + uncertainty (median of frames)
       ─► 24 good frames ──(numbers only, no pixels)──►           ─► sizing engine (config charts)
                                                       /api/config, /api/recommend, /api/research/* (off)
```

| Path | Contents |
|---|---|
| `config/` | Reference objects, measurement parameters, fitted calibration, sizing charts, app settings |
| `backend/glovesize/` | `coin_detection` (reference OpenCV detector), `calibration`, `measurement`, `sizing`, `pipeline`, `api`, `research`, `synthetic` (test scenes) |
| `backend/validation/` | Offline validation pipeline: extraction from images, calibration fitting (dev split), evaluation (test split) |
| `backend/scripts/` | Model download, parity fixtures, fake-camera videos |
| `frontend/src/` | `vision/` (coin detector port, MediaPipe wrapper, live checks, smoothing), `scan/` (frame loop), `screens/`, `api/` |
| `docs/` | [Methodology](docs/MEASUREMENT_METHODOLOGY.md), [validation plan](docs/VALIDATION_PLAN.md), [privacy](docs/DATA_COLLECTION_AND_PRIVACY.md), [risks and client inputs](docs/RISKS_AND_CLIENT_INPUTS.md) |

## Setup

Requirements: Python 3.11, Node 20+, Chrome or Edge (for the e2e tests).

```bash
# Backend
cd backend
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m scripts.download_models # MediaPipe hand_landmarker.task -> models/ (sha256-checked)

# Optional: offline validation tooling (MediaPipe for Python)
pip install -r requirements-validation.txt
pip install --no-deps mediapipe==0.10.35   # --no-deps avoids a second, conflicting OpenCV

# Frontend
cd ../frontend
npm install        # also copies the MediaPipe WASM, model and OpenCV.js into public/
```

## Run

**Development** (two terminals):

```bash
cd backend && .venv\Scripts\python -m uvicorn glovesize.api:app --port 8000 --reload
cd frontend && npm run dev            # http://localhost:5173 (proxies /api to :8000)
```

**Single process** (the production build is served by FastAPI):

```bash
cd frontend && npm run build
cd ../backend && .venv\Scripts\python -m uvicorn glovesize.api:app --host 0.0.0.0 --port 8000
```

**Testing on a phone.** Browsers expose cameras only over HTTPS (or on localhost). Use
`npm run dev:https` (self-signed certificate, LAN host), or deploy behind TLS.

The operator calibration screen is at `/#/calibration`.

## Configuration

* **Sizing charts:** add `config/sizing_charts/<product>.json` and set `default_chart_id` in
  `config/app.json`. Charts are validated at startup: ordered, non-overlapping ranges, and a
  disclaimer is required for demo charts. Both shipped charts are marked `is_demo` and contain
  invented boundaries.
* **Reference objects:** `config/reference_objects.json`. Only the US quarter (24.26 mm) is
  enabled. Customers or operators can pick another enabled object, or a caliper-verified custom
  diameter in operator mode.
* **Thresholds and uncertainty priors:** `config/measurement.json`.
* **Calibration:** `config/measurement_calibration.json` (currently `uncalibrated`). Replace it
  with the output of `validation/fit_calibration.py`.
* **Environment variables:** `GLOVESIZE_CONFIG_DIR`, `GLOVESIZE_DEFAULT_CHART`,
  `GLOVESIZE_RESEARCH_ENABLED`, `GLOVESIZE_RESEARCH_PATH`, `GLOVESIZE_CORS_ORIGINS`,
  `GLOVESIZE_LOG_LEVEL`.

## Tests

```bash
cd backend && .venv\Scripts\python -m pytest && .venv\Scripts\python -m ruff check .
cd frontend && npm test && npm run typecheck
cd frontend && npm run build && npm run e2e     # real Chrome with a fake camera
```

| Suite | What it covers |
|---|---|
| pytest (164) | Coin detection on synthetic scenes (6 diameters, tilt up to 30°, blur, glare, occlusion, noise, ROI, no coin), px/mm conversion, tilt rectification, depth model, landmark gates, measurement exactness, aggregation and uncertainty, calibration, sizing boundaries, ties, borderline and uncertain cases, multi-measurement rules, API validation (NaN, image payloads, sizes, 413), research consent and retention, validation metrics and split enforcement |
| Vitest (54) | Coin detector **parity with the Python reference** on shared fixtures, live checks, geometry, smoothing, camera permission and device errors, API client, screens (permission denied, insecure origin, rejected scan, results), storage fallbacks |
| Playwright (4) | Real Chrome with a fake camera: model loading, scanner guidance, in-browser coin calibration (within 1% of truth), and a **full scan** on a real hand photo with a synthetic coin. The browser hand length is within 2% of the Python pipeline, the size matches, and the request carries no image data. |

## Accuracy statement

No real-world accuracy has been measured. The system reports model-based uncertainty
(about ±6–7 mm 1σ for hand length before calibration), so it often recommends confirming with a
tape measure. It never displays a fit probability or a fit guarantee. The validation plan
describes how to measure and improve real accuracy.
