# EXPERIMENTAL dense hand-surface scan page

A dev-only page that scans one camera frame of a hand into a dense lattice of surface points: live camera, the real hand
outline (GrabCut segmentation), a scan line that sweeps the hand while dots appear inside the real mask, per-dot checks,
then a frozen snapshot with regions, a point cloud, a lattice mesh, measurements and a local export.

It is **not the customer app**. `vite build` builds only `frontend/index.html`, so this page (`frontend/experiment/dense/`)
and its code never reach `dist` or the deployed site. Nothing links to it. It uploads nothing.

The computation is the densescan core (`../core`, its own README). This folder only wires the existing pieces together and
draws: the camera and quality checks of the capture prototype (`../../capture/live.ts`, which reuses `src/camera` and
`src/vision` read-only, including the existing Indian-coin detection and its calibration, unchanged), its segmentation
worker (`../../capture/segmentClient.ts`), its ZIP writer, and the experimental `MeshViewer`.

## Open it on a desktop

```powershell
# window 1: the backend (only GET /api/config is used). Port 8000 is taken on this PC, so 8010 is used.
cd C:\Users\pc\Downloads\OPEN-CV\backend
.\.venv\Scripts\python.exe -m uvicorn glovesize.api:app --host 127.0.0.1 --port 8010

# window 2: the Vite dev server, told where the backend is (read when the dev server starts)
cd C:\Users\pc\Downloads\OPEN-CV\frontend
$env:GLOVESIZE_API_URL = "http://127.0.0.1:8010"
npm run dev
```

Then open <http://localhost:5173/experiment/dense/> (add `?debug` for the timings panel). Click **Start camera**, rest
the coin flat on the open palm, hold still. The scan starts by itself once every live check (hand in the picture, coin
accepted, steady, sharp) has passed for 8 frames, or press **Scan** (without an accepted coin the scan still runs, but no
millimetre values are shown).

## Test it on an Android phone (Chrome, HTTPS on the same Wi-Fi)

A phone browser opens the camera only on a secure page: `https://`, or `localhost`. Plain `http://<PC address>` is not
secure, and the page then says so and keeps **Start camera** disabled.

1. On the PC, window 1, the backend (as above, port 8010).
2. On the PC, window 2, the dev server over HTTPS (self-signed certificate) on the network:

   ```powershell
   cd C:\Users\pc\Downloads\OPEN-CV\frontend
   $env:GLOVESIZE_API_URL = "http://127.0.0.1:8010"
   npm run dev:https
   ```

   If this PC is connected to the phone's own hotspot, leave the hotspot on (the phone is then the Wi-Fi). Windows must
   allow inbound connections to port 5173; in an administrator PowerShell:
   `New-NetFirewallRule -DisplayName "OPEN-CV dense 5173" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Public,Private`
   and afterwards `Remove-NetFirewallRule -DisplayName "OPEN-CV dense 5173"` (see `docs/PHONE_TESTING.md`).

3. Find the PC's Wi-Fi address: `ipconfig | Select-String "IPv4"`.
4. On the phone: same Wi-Fi (switch mobile data off), open Chrome, go to
   `https://<PC address>:5173/experiment/dense/?debug`.
5. Chrome warns that the certificate is not trusted (it is self-signed): **Advanced**, then **Proceed to ... (unsafe)**.
6. Check the coin panel: by default the Indian 2-rupee coin, 2019 series (23 mm) when the server's settings enable it
   (or add `&coin=<id>` to the address). For the 2-rupee coin, tick "My coin is the 23 mm one" (older 2-rupee coins
   are 27 mm). Keep **Camera: Back (rear) camera** (the default on a phone) or pick the front camera, press
   **Start camera** and **Allow** the camera.
7. Rest the coin flat on the open palm, hand inside the picture, plain background, good light. The chips show hand,
   coin, steadiness and sharpness; the scan starts by itself after 8 good frames (or press **Scan**).
8. Hold the phone upright (portrait) or sideways (landscape): the page uses the frame as the camera delivers it.
   Rotating the phone after a scan redraws the dots for the new size.
9. When the frame is taken, the camera turns off (the frozen frame is processed; hand tracking would only keep the
   phone busy); **Scan again** turns it back on.
10. After the scan: the counters, the dot map, the 3D preview, the measurement table, and under **Debug timings** the
   per-stage times, frame rate, long tasks and JS heap of THIS phone. Note them with the phone model.
11. **Download point set (this device only)** saves the ZIP in the phone's Downloads.

If it does not work:

- Page does not load: Windows firewall must allow Node.js on Private networks, the Wi-Fi must be a Private network in
  Windows, and the router must not isolate clients (guest Wi-Fi usually does). `docs/PHONE_TESTING.md` has the firewall
  rule (it names port 4173 for the preview build; use 5173 for this dev server).
- "This page is not secure": the address starts with `http://`; use `https://` and `npm run dev:https`.
- "Camera access is blocked": tap the icon left of the address, **Permissions**, **Camera**, **Allow**, then
  **Try the camera again**. If Chrome itself has no camera permission: Android Settings, Apps, Chrome, Permissions,
  Camera.
- "The camera is busy": close other apps using the camera.
- No certificate warning wanted: USB debugging on, phone connected, `npm run dev` (plain http), `adb reverse tcp:5173
  tcp:5173`, then open `http://localhost:5173/experiment/dense/?debug` on the phone (localhost counts as secure; see
  `docs/PHONE_TESTING.md`, "over USB").

On a phone screen the full lattice (about 8,000 dots, 4 px apart in the camera frame) is finer than the screen can show,
so the page DRAWS every k-th dot of a coarser display lattice and says "showing 1 in N dots on this screen; all ... are
kept for processing and export". The counts, the processing and the export always use every dot.

## The coin, and when a scan may start

- **Which coin.** Everything about the coin comes from the served settings (GET /api/config, which the backend reads
  from `config/reference_objects.json`): label, diameter, the ± allowance (an assumed allowance, so labelled), the source
  citation and the customer hint. Nothing is hard-coded. This experiment PREFERS the 2019 silver 2-rupee coin
  (`inr_2_2019`, 23 mm) when the served settings enable it, otherwise the settings' default (the production default is not
  changed). `?coin=<id>` in the address picks another enabled coin; an unknown or disabled id is ignored with a note.
- **Size check.** A coin with `size_check` (the 2-rupee coin: older 2-rupee coins are 27 mm) needs the tick "My coin is
  the 23 mm one: ..." before any scan. It is kept in memory only.
- **One value everywhere.** The selected entry's diameter is used for the coin-plane scale (mm per px), the production
  plausibility check (`implausibleScale` against `hand_length_plausible_mm`), the measurements and the export's
  calibration block (id, label, diameter, allowance, source, size check confirmed). The coin DETECTOR does not take a
  diameter: it looks for a coin-sized circle on the palm in pixels (config coin_detection), whatever the denomination.
- **Four groups of reasons**, each OK / Waiting / Failed, with the detectors' own codes in words:
  hand detection (no hand, out of the picture, too small, posture, moving, not sharp), coin detection (the coin engine's
  codes: not found, too small, partly hidden, edge not round, blurred, glare, low contrast, low confidence, more than one
  coin), calibration (no accepted coin yet, size not confirmed, implausible scale), segmentation (segmentHand's reasons).
- **Gating.** The scan (automatic or the Scan button) starts only when hand, coin and calibration all pass on the current
  frame; the frame taken is checked once more and dropped (with the reason) if it fails. The automatic start keeps the
  existing run of 8 good frames. There is no way to scan without an accepted coin. While only the coin is missing, the
  camera picture shows "Waiting for coin acceptance" with the coin engine's reason and where to put the coin.

## What is real, what is estimated, what is missing

| | |
|---|---|
| **Real** (from this frame) | The camera frame; the hand landmarks; the coin detection; the steadiness and sharpness checks; the hand mask and outline (GrabCut); every dot (generated inside the mask) and its check (edge distance, local sharpness, exposure, duplicates, isolated dots); all counts; the regions (from landmarks); the lattice mesh's coverage of the visible hand. |
| **Estimated** | Depth: MediaPipe's relative z interpolated onto the dots, labelled "Estimated relative depth (MediaPipe), not a measured 3D scan". Millimetres: the coin-plane scale, a model that is exact only at the coin's plane. |
| **Missing** | Measured depth (no depth sensor is used, so no point is ever "measured"); the back and sides of the hand; thickness, circumference, 3D surface area (shown as "not available"); any check against physical reference measurements, so **no accuracy is claimed**. |

The mesh is flat (z = 0): a coverage map of the visible hand, not a 3D surface. Gaps between fingers stay open; missing
surface is reported (the completeness), never filled. The 3D preview's caption always says which of these it shows.

About 0.1 mm: the spacing panel shows the dot step in pixels and in mm at the coin's plane. A 0.1 mm step needs at least
10 pixels per millimetre at the hand; a phone frame of a whole hand has far fewer, so the step is clamped to 1 px. A dot
spacing is a sampling step, not an accuracy.

## Privacy

- The camera frame stays in this browser tab's memory. The only network request is `GET /api/config` (the public
  settings). The browser test checks that nothing else is requested and that no request carries a body.
- **Download point set (this device only)** saves a ZIP on this device: `points.json`, `points.csv` (every dot, accepted
  or rejected with its reason, in source pixels), `README.txt`, with the camera settings, the coin calibration metadata and
  the settings including the seed. The photo is included only when **Include the photo of my hand** is ticked (off by
  default).
- Nothing is written to localStorage, sessionStorage, IndexedDB or Cache Storage, and no service worker is registered
  (the browser test enumerates all five during and after a scan).
- Closing the tab discards everything.

## Files

- `useDenseScan.ts`: camera, segmentation and core wiring; the animation (core scan reducer in a ref, `tick` per
  animation frame, React updated at most every 100 ms and on every phase change); export; the `window.__DENSE_SCAN__`
  debug hook the browser test reads.
- `denseWorker.ts` / `denseClient.ts`: the dots (core generation, validation, filtering, regions, depth labels) and the
  processing (core point cloud, lattice mesh, measurements) in a Web Worker, so the page keeps drawing; on the page
  (after yielding) only if a worker cannot start. The segmentation already runs in its own worker
  (`../../capture/segmentWorker.ts`).
- `drawScan.ts`: the canvases (frozen still at the frame's size; live landmarks; the dot layer and the outline layer at
  the DISPLAYED size x devicePixelRatio, drawing in frame coordinates, so they are crisp and line up with the still in
  portrait and landscape; the dot layer draws only newly passed dots each frame, and a coarser display lattice when the
  full one is too fine to read; the outline is drawn over the dots with a dark halo).
- `perfProbe.ts`: long tasks (PerformanceObserver "longtask"), idle frame sampling, JS heap (performance.memory, Chrome
  only).
- `staged.ts`: the core's `buildPointSet` run stage by stage for the timings (a unit test checks it equals the core).
- `helpers.ts`: counters, quality grade, honest captions, viewer transforms, mask checks, gap probes.
- `DenseScanPage.tsx`, `dense.css`, `main.tsx`; the HTML entry is `frontend/experiment/dense/index.html`.

## Tests

```powershell
cd C:\Users\pc\Downloads\OPEN-CV\frontend
npx vitest run --no-file-parallelism src/experimental/densescan/page
node e2e/prepare.mjs            # once: the fake-camera video and the relaxed config copy
npx playwright test -c playwright.dense.config.ts
```

The browser test plays the sample hand photo as Chrome's fake camera (ports 5198 and 8786), in two projects:
`landscape` (e2e/.media/hand.y4m, 1280 x 720) and `portrait` (the same video turned 90 degrees clockwise into 720 x 1280,
made by playwright.dense.config.ts on first use as e2e/.media/dense_portrait_cw90.y4m, gitignored). It proves the flow,
the quality gates (a blurred or shaking picture does not start a scan), the frame dimensions, the honesty of the labels,
the export, the insecure-page and blocked-camera messages, and that nothing is uploaded or stored, on that photo; it
proves nothing about real phones, real hands or accuracy. Its costs are a desktop's (software WebGL; runs with the CPU
slowed 4x and 6x as phone stand-ins), not a phone's.
