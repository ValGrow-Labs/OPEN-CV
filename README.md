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
| `docs/` | [Methodology](docs/MEASUREMENT_METHODOLOGY.md), [validation plan](docs/VALIDATION_PLAN.md), [pilot protocol](docs/PILOT_PROTOCOL.md), [calibration study](docs/CALIBRATION_STUDY.md), [experimental paper method](docs/PAPER_METHOD_EVALUATION.md), [comparison study protocol](docs/COMPARISON_STUDY_PROTOCOL.md), [consent review](docs/CONSENT_REVIEW.md), [privacy](docs/DATA_COLLECTION_AND_PRIVACY.md), [risks and client inputs](docs/RISKS_AND_CLIENT_INPUTS.md) |

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

**Developer validation mode** (`/#/validation`) collects pilot data: real scans compared with
physical ruler or tape readings, taken by the protocol in `docs/PILOT_PROTOCOL.md`. The server
converts units, computes every error and a summary (bias, MAE, RMSE, median error, rejection
rate, repeatability), and counts only records marked as real participants. It is off by
default:

```bash
set GLOVESIZE_VALIDATION_ENABLED=true                  # PowerShell: $env:GLOVESIZE_VALIDATION_ENABLED="true"
set GLOVESIZE_VALIDATION_PATH=C:\pilot\records.jsonl     # default: data/validation/records.jsonl (git-ignored)
```

Each scan's per-frame numbers (never images) are saved in `frames/` next to the records file,
and each configuration version in `configs/`, so pilot scans can be re-measured after a
configuration change. Report with three separate parts (real measurements, synthetic tests,
simulated camera), including per-participant errors and errors by camera distance:
`cd backend && .venv\Scripts\python -m scripts.validation_report` (writes `data/validation/report.md`).

**Remote pilot** (volunteers in other places, invited by WhatsApp; `docs/PILOT_PROTOCOL.md` §5):

```powershell
winget install --id Cloudflare.cloudflared            # once
cd backend
$env:GLOVESIZE_VALIDATION_ENABLED = "true"
$env:GLOVESIZE_PILOT_REMOTE_ENABLED = "true"
$env:GLOVESIZE_VALIDATION_PATH = "C:\pilot\records.jsonl"
.venv\Scripts\python -m uvicorn glovesize.api:app --host 127.0.0.1 --port 8080
# second terminal:
cloudflared tunnel --url http://127.0.0.1:8080
```

Create invites on `http://127.0.0.1:8080/#/validation` (this laptop only). Volunteer invites stay
locked until `config/pilot_consent.json` has been reviewed.

### Security of operator endpoints

Validation mode and the research endpoints (`/api/validation/*`, `/api/research/*`) store or
delete study data. Turning them on is not enough to reach them
(`backend/glovesize/operator_access.py`):

* **Default: localhost only.** A request is served only if it comes from a loopback address,
  its `Host` header names `localhost`, `127.0.0.1` or `[::1]` (blocking DNS rebinding), and it
  carries no proxy headers. Behind a reverse proxy every client looks local, so forwarded
  requests are refused.
* **Remote access needs a token.** Set `GLOVESIZE_OPERATOR_TOKEN` (at least 32 random
  characters; shorter tokens stop the server from starting). Every request must then send
  `Authorization: Bearer <token>`, local ones included. The validation screen asks for the
  token and keeps it in memory only. Use this only behind HTTPS.
* **State-changing requests** must send `X-Glovesize-Operator: 1`, which a cross-site page cannot
  add without a CORS preflight that the server does not grant.
* The single-process command above binds `0.0.0.0` for phone testing on a LAN. Operator
  endpoints still refuse those remote requests unless a token is set. For the pilot, bind
  `--host 127.0.0.1`.
* **Remote pilot endpoints** (`/api/pilot/me…`) are the only study endpoints meant to be reached
  through the tunnel. Each request needs a volunteer's personal invite token
  (`X-Pilot-Token` header, taken from the link's `#fragment`, which never reaches a server log).
  Tokens are stored only as SHA-256 hashes. With a token a volunteer can enrol, submit their own
  scans (up to a limit) and withdraw. They cannot read any record, estimate or other volunteer's
  data. Creating and revoking invites is operator-only.
* The token is a shared secret, not per-user accounts or roles. A public deployment of study
  features needs a proper login and authorization layer, which is not built.

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
  `GLOVESIZE_RESEARCH_ENABLED`, `GLOVESIZE_RESEARCH_PATH`, `GLOVESIZE_VALIDATION_ENABLED`,
  `GLOVESIZE_VALIDATION_PATH`, `GLOVESIZE_OPERATOR_TOKEN`, `GLOVESIZE_CORS_ORIGINS`, `GLOVESIZE_LOG_LEVEL`.
* **Calibration study:** `cd backend && .venv\Scripts\python -m scripts.calibration_study`
  regenerates `docs/CALIBRATION_STUDY.md` (simulated pinhole geometry, not real accuracy).

## Tests

```bash
cd backend && .venv\Scripts\python -m pytest && .venv\Scripts\python -m ruff check .
cd frontend && npm test && npm run typecheck
cd frontend && npm run build && npm run e2e     # real Chrome with a fake camera
```

| Suite | What it covers |
|---|---|
| pytest (228) | Coin detection on synthetic scenes (6 diameters, tilt up to 30°, rotation, white balance, exposure, low contrast, blur, glare, occlusion, noise, ROI, no coin, warm disc, rival coins), px/mm conversion, opt-in tilt rectification, depth model, simulated pinhole perspective, distance and stability gates, coin confirmation, landmark gates, measurement exactness, aggregation and uncertainty, calibration, sizing boundaries, ties, adjacent sizes, borderline and uncertain cases (no size given), tape entries, multi-measurement rules, API validation (NaN, image payloads, sizes, 413), research consent and retention, validation metrics and split enforcement, fitted calibrations never reported as validated without sign-off, validation mode (localhost/token/CSRF access control, unit conversion, repeated-reading rule, server-computed errors, exact MAE/RMSE/bias/median/histogram, per-hand aggregation, repeatability, real vs software-test separation, still-image and reference-mismatch flags, CSV export, report) |
| Vitest (82) | Coin detector **parity with the Python reference** on shared fixtures, live checks, geometry, smoothing, camera permission and device errors, API client, screens (permission denied, insecure origin, rejected scan, results), coin confirmation, distance and ambiguity checks, tape entry and unit conversion, no-size results, validation screen (consent, hand, repeated readings, units, token mode), pilot helpers, storage fallbacks |
| Playwright (10) | Real Chrome with a fake camera: model loading, scanner guidance, in-browser coin calibration (within 1% of truth), layouts from 320 px to 1280 px, and a **full scan** on a real hand photo with a synthetic coin (desktop and phone). The browser hand length is within 2% of the Python pipeline, the request carries no image data, the camera alone gives no size (as in Python), and a tape entry then gives one. Also the validation-mode flow, recorded as a software test and shown as not counted. |

## Experimental: hand flat on paper

`backend/experimental/paper_method/` is an isolated alternative method: the hand lies flat on an A4 or
US Letter sheet and is photographed from above. It is not used by the app. It has been evaluated on
synthetic images only (`docs/PAPER_METHOD_EVALUATION.md`, `docs/PAPER_METHOD_STUDY.md`):

```bash
cd backend
.venv\Scripts\python -m scripts.paper_measure photo.jpg --paper a4   # local only, stores nothing
.venv\Scripts\python -m scripts.paper_method_study                   # regenerate the synthetic study
```

## Accuracy statement

This is an **unvalidated prototype**. No real-world accuracy has been measured: no scan has yet
been compared with a physical measurement of a real hand (the pilot in `docs/PILOT_PROTOCOL.md`
is ready to run). The system reports model-based uncertainty (about ±7–8 mm 1σ for
hand length before calibration). Against 12 mm size steps, the camera alone therefore usually
gives no size: it lists the sizes still possible and asks for a tape measurement. It never displays a fit probability or a fit guarantee. The validation plan
describes how to measure and improve real accuracy.
