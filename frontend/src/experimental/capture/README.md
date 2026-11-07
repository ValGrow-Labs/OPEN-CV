# Guided multi-view capture prototype (EXPERIMENTAL)

A research tool, **not the customer app**. It is a dev-only page that collects multi-view captures of a hand with a coin, runs the
experimental hand segmentation on them, and exports a local bundle. It does not give a glove size, is not connected to the sizing
service, and nothing in it has been validated against physical measurements. Read
[`docs/hand3d-research/CONSOLIDATED_FINDINGS.md`](../../../../docs/hand3d-research/CONSOLIDATED_FINDINGS.md) first: it is the agreed basis.

## What it does

* **Guided capture** of four required views in order (open palm, thumb-side profile, little-finger-side profile, back of hand) and two
  optional 45-degree views (a toggle). Each view says what it is for.
* **Live checks** per view, all visible as chips with the reasons in words: hand found, whole hand in the picture, coin found and
  accepted (required in the palm and back views by default; the list is `coinViews` in `views.ts`), posture (palm face-on, profiles
  edge-on, back = the other side of the hand from the palm, judged with the production hand-turn rule and the config's own limits),
  steadiness (landmark jitter, `capture.max_landmark_jitter_fraction`) and sharpness (variance of the Laplacian of the hand region,
  `MIN_SHARPNESS`, **provisional**). A capture fires by itself after `AUTO_CAPTURE_FRAMES` consecutive good frames, or by the button;
  a view taken by the button while a check fails is **kept and marked "checks not passed"** with the reasons. Nothing is passed for you.
* **Per captured view, in memory only:** the full frame, the optional full-resolution still from `ImageCapture.takePhoto()` when the
  browser has it, image and world landmarks, handedness, the coin detection, timestamps, stream settings and `getCapabilities()`, device
  info, and the config values used.
* **Analysis on this device:** the experimental GrabCut hand segmentation (`src/experimental/segmentation`) in a Web Worker (falls back to
  the page, which then pauses, and says so), drawn over the still with mask, outline, fingertips, wrist line and coin; the projected pixel
  area; the quality gates and reject reasons in words; the coin-plane scale, a model uncertainty and the area in mm² from
  `src/experimental/geometry`, **only when an accepted coin exists** and always labelled a model estimate.
* **Pose consistency** across the captured views (`poseConsistency`, on 3D world landmarks), naming the flagged views.
* **Depth capability** of this device (`detectDepthCapabilities`), with a "Try an AR depth session" button that only acts on a tap.
  iPhone and iPad Safari cannot give a web page any depth; the RGB camera is the baseline everywhere.
* **Export:** "Download capture bundle (this device only)" builds an uncompressed ZIP in the browser (own ZIP writer, no dependency):
  `manifest.json` (versioned schema `glovesize-experimental-capture/1`, everything except the pixels), `views/NN-<view>.png`,
  `masks/NN-<view>.png`, optional `highres/…`, and a `README.txt` that calls the images personal data. "Clear all captures" empties memory.
* **SIMULATED reconstruction:** a separate section that runs `src/experimental/reconstruction` on its synthetic capsule hand and shows the
  mesh and a truth-versus-estimate table. Every part of it says SIMULATED and that it proves the mathematics only.

## What it does NOT do

* **No marker-sheet camera poses.** The OpenCV.js bundled in the app has no `aruco`, `findChessboardCorners`, `cornerSubPix` or
  `calibrateCamera`, and a coin (one circle) gives a scale and a tilt of its own plane, not a camera pose. So **real captures cannot be
  reconstructed in 3D yet**; the manifest says `marker.implemented: false` and records no pose. None is invented.
* **No real 3D reconstruction** of the captured views, and no glove size.
* **No validation.** There are no physical reference measurements yet. Every millimetre figure is a model estimate, and the hand's surface
  lies above the coin's plane, so such figures are biased. Segmentation numbers shown are from the experimental module's own quality gates,
  not accuracy.
* It does not tell which edge (thumb or little finger) an edge-on view shows, and the first view cannot tell palm from back.

## Privacy

Images and hand landmarks are personal data. The page sends nothing anywhere: the only network requests are static assets of this site
and `GET /api/config` (the same public settings the app reads). `privacy.ts` holds the rule as a function, and the browser test records
every request the page makes and asserts there is no violation. Captured views live only in memory and vanish when the page is reloaded or
cleared. The exported ZIP is a download to the device; what happens to it afterwards is the person's and the study's responsibility
(`docs/hand3d-research/VALIDATION_PLAN.md`, `docs/CONSENT_REVIEW.md`, `docs/DATA_COLLECTION_AND_PRIVACY.md`). The camera track's label is
stored in the manifest because it identifies the lens.

## Isolation

* `frontend/experiment/index.html` is a second HTML page. `vite build` builds only `frontend/index.html` (`vite.config.ts` sets no
  `build.rollupOptions.input`), so this page and its code **never reach `dist` or the deployed site**. Nothing links to it.
* Production files are only **read** (camera, hand tracker, coin engine, config client, geometry helpers, colour tokens). The coin
  pipeline, the calibration and the sizing flow are untouched.

## Run it

Backend (port 8000 is taken on the development PC, so use another):

```powershell
cd backend
.venv\Scripts\python -m uvicorn glovesize.api:app --host 127.0.0.1 --port 8010
```

Desktop (the dev server serves the page at `/experiment/`):

```powershell
cd frontend
$env:GLOVESIZE_API_URL = "http://127.0.0.1:8010"
npm run dev
# open http://localhost:5173/experiment/
```

Phone over HTTPS on the same Wi-Fi (the camera needs a secure origin; the certificate is self-signed, so accept the warning):

```powershell
cd frontend
$env:GLOVESIZE_API_URL = "http://127.0.0.1:8010"
npm run dev:https
# vite prints "Network: https://<PC address>:5173/"; open https://<PC address>:5173/experiment/ on the phone
```

If the phone cannot connect, allow Node on Private networks in the Windows firewall and check that the router does not isolate clients
(see `docs/PHONE_TESTING.md`). The dev server is **not** the production build: its speed is not representative of a deployed app.

## Tests

* Unit tests (`views`, `metrics`, `zip`, `manifest`, `privacy`, `analysis`; 55 tests): `npx vitest run --no-file-parallelism src/experimental/capture`
* Browser test, its own config (dev server on port 5199, the existing backend on 8776 for `GET /api/config`):
  `node e2e/prepare.mjs` then `npx playwright test -c playwright.experiment.config.ts`
  It uses Chrome's fake camera (a photo played as a video) and the turned, squeezed and mirrored stand-in pictures of `e2e/views.ts`.
  It checks the live statuses, the segmentation, the ZIP, the SIMULATED section, no uploads, a clean console, and no sideways
  scrolling at 360, 390 and 1280 px. It cannot say anything about real phones or real hands.

## Unverified

Real phones (camera, autofocus, GPU, speed), real hands and skin tones, the sharpness and steadiness thresholds on real cameras,
`ImageCapture.takePhoto()` behaviour per browser, and every accuracy question.
