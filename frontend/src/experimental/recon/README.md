# EXPERIMENTAL: 3D hand from a printed marker board (`recon/`)

> **EXPERIMENTAL, dev only, not validated.** Nothing here is used by the customer app, the production scan, the coin
> calibration or the sizing. No result of this page has ever been compared with a physical measurement. Every number in
> this file is **SIMULATED** (rendered pictures of a synthetic capsule hand) unless it says otherwise.

* `chain.ts`: `reconstructFromImages(views, opts)`: pictures (+ optional MediaPipe landmarks in pixels) in; marker
  detection, camera self-calibration, board poses, known-board segmentation, landmark triangulation, carving, labelled
  mesh and measurements out, or a refusal in words. `opts.onProgress` (added for the page) is told when each stage starts.
* `page/`: the phone page at `/experiment/recon/` (`frontend/experiment/recon/index.html`): a guide, live capture with a
  coverage guide and automatic capture, the reconstruction in a Web Worker, the result and a local export.
* `boardFlatness.ts`: is the printed sheet flat? Judged from the per-marker pose residuals of every view (below).
  `curledBoardRender.ts` is its test support: renders of a cylindrically bent sheet by per-pixel ray casting.

`vite build` builds only `frontend/index.html`, so this page and its code never reach `dist` or the deployed site.
Nothing links to it.

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

Then open <http://localhost:5173/experiment/recon/> (add `?debug` for the live timings panel and the device log, and
`?validation` for a physical-validation capture: `/experiment/recon/?validation&debug`). A laptop webcam works for
trying the flow (the board must be printed); the page asks for the rear camera and falls back to whatever exists.

## Test it on an Android phone (Chrome, HTTPS on the same Wi-Fi)

A phone browser opens the camera only on a secure page: `https://`, or `localhost`.

1. On the PC, window 1, the backend (as above, port 8010).
2. On the PC, window 2, the dev server over HTTPS (self-signed certificate) on the network:

   ```powershell
   cd C:\Users\pc\Downloads\OPEN-CV\frontend
   $env:GLOVESIZE_API_URL = "http://127.0.0.1:8010"
   npm run dev:https
   ```

   Windows must allow inbound connections to port 5173; in an administrator PowerShell:
   `New-NetFirewallRule -DisplayName "OPEN-CV recon 5173" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Public,Private`
   and afterwards `Remove-NetFirewallRule -DisplayName "OPEN-CV recon 5173"` (see `docs/PHONE_TESTING.md`). If this PC is
   on the phone's own hotspot, leave the hotspot on.
3. Find the PC's Wi-Fi address: `ipconfig | Select-String "IPv4"`.
4. On the phone: same Wi-Fi (mobile data off), Chrome, `https://<PC address>:5173/experiment/recon/?debug`.
5. Chrome warns that the certificate is not trusted (self-signed): **Advanced**, then **Proceed to ... (unsafe)**.
6. **Download the board**, print it (see below), lay it flat, put the coin on its target, rest the hand, then
   **Start camera (rear)** and **Allow** the camera.
7. Follow the line under the picture and the dial. Note the `?debug` panel's figures (detection time, frame rate, heap)
   with the phone model.
8. After **Build 3D hand**: the viewer, tables and timings of THIS phone. **Download ZIP** saves to the phone's Downloads.

If it does not work: the page does not load (firewall must allow Node.js on Private networks, the Wi-Fi must be a Private
network in Windows, guest Wi-Fi often isolates clients); "Secure connection required" (use `https://` and
`npm run dev:https`); "Camera access is blocked" (the icon left of the address, **Permissions**, **Camera**, **Allow**; or
Android Settings, Apps, Chrome, Permissions, Camera); "The camera is busy" (close other camera apps). Without the
certificate warning: USB debugging, `npm run dev`, `adb reverse tcp:5173 tcp:5173`, then
`http://localhost:5173/experiment/recon/?debug` on the phone (localhost counts as secure).

## How to capture

1. **Print the board** (`board/svg.ts`, the page's download button): A4 landscape at **100 % / "Actual size"**, never
   "Fit to page". **Check with a ruler: each black square must measure 30.0 mm.** Lay it flat on a matte table.
2. **The coin** between the four grey ticks: the coin and its diameter come from the served settings (GET /api/config,
   `config/reference_objects.json`), preferring `inr_2_2019` (the 23 mm 2019 Indian 2-rupee coin) when it is enabled, or
   `?coin=<id>` (`densescan/page/coin.ts`). Nothing about the coin is hard-coded. It is used only for the print-scale check.
3. **The hand** palm-down on the white middle: the wrist at the open left edge (no markers there; the forearm leaves the
   sheet), fingers slightly apart toward +x, fingertips short of the coin, the whole hand inside the hand area. Keep it
   **completely still** until every view is taken (someone else holds the phone, or use the other hand). Plain
   background, even light, no glare.
4. **The views**, guided by the dial (radius = height above the board, angle = direction round the hand, as the sheet
   lies): one **top view** (60 degrees or more above the board), then the **low ring**, about level with the fingertips
   (8 to 22 degrees), in **12 sectors of 30 degrees** all round. An optional middle ring (25 to 45 degrees, 6 sectors) is
   captured when the phone passes through it and holds still. **Build 3D hand** is enabled only with the top view and all
   12 low sectors; until then the page lists what is missing. Keep the phone the same way round for every view: if the
   picture size changes (rotation, another camera), the views are cleared with a notice, because they must share one
   calibration.
5. **Automatic capture** of a still when: the phone is in an unfilled bin; at least 4 consistent markers are found; the
   picture is sharp (`frameMetrics.laplacianSharpness` >= 0.7 on a half-size grey copy); and the phone is steady (over 3
   analysed frames, less than 1 degree of turn and 5 mm of movement). **Take this view** uses the same checks and shows
   the reason when blocked. The live angles use an **assumed** focal length (guidance only).

What is stored per view: the full frame at the video's size (RGBA, not mirrored; the exact frame the markers were found
in), MediaPipe's 21 landmarks found on that frame in its pixels, and the live marker count, elevation, azimuth and
sharpness. Live analysis (in `page/liveWorker.ts`): `detectMarkers(img, { decimate: 2 })`, the markers that agree on one
plane (`consistentMarkers`), `estimateBoardPose(assumedIntrinsics(w, h))`, sharpness; a few frames per second (at most
one in flight, at least 150 ms apart).

## The reconstruction and the result

**Build 3D hand** stops the camera and transfers the pixel buffers to `page/reconWorker.ts`, which runs
`reconstructFromImages(views, { reconstruct: { voxelMm: 1.5 } })` (with a progress line per stage) and then
`checkCoinScale` on the top view with the calibrated intrinsics and that view's pose (principal point shifted half a pixel
to the coin check's pixel convention; the coin's thickness is passed when the settings have it). The buffers come back so
the photos can still be exported.

The result shows: the `MeshViewer` (mesh, confidence, support labels, point cloud, the triangulated 21 landmarks as the
optional skeleton when all 21 exist, the hand frame), captioned "EXPERIMENTAL: a visual-hull reconstruction from N photos.
The palm side rests on the board and is not observed. Not validated against physical measurements."; the measurement
table (hand length, palm breadth, palm thickness, knuckle circumference, five finger lengths, surface area) with each
value's basis in words (direct / model / not available + the note; "not available" is never a number); the quality
verdict with every reason in words (`page/format.ts` `REASON_WORDS`; a unit test greps the code for every reason code so
none can go unworded); a refusal in the chain's own words (no mesh, no numbers); the camera calibration (focal length,
k1, RMS, method, a warning when assumed); a per-view table (markers, elevation, azimuth, used or why not, the hand-moved
check); the coin print-scale check (measured diameter, implied print scale; beyond 2 % off: "The board was probably not
printed at 100 %; every millimetre is scaled wrongly." and the numbers are withheld); support shares; timings and the JS
heap where the browser exposes it.

**Export (this device only)**: a ZIP (`capture/zip.ts`) with `reconstruction.json` (calibration, poses, per-view
reports, measurements with basis, quality, reasons in words, timings, board version, the coin entry from the settings, the
coin check, and the validation fields listed above), `mesh.ply` (ASCII, board mm, per-vertex confidence and support
label), `points.csv`, `device.json`, `README.txt`, and the photos (PNG) **only** if "Include the photos of my hand" is
ticked (off by default).

## Validation mode (`?validation`): the first physical validation with a rigid phantom

Everything below is in memory only (nothing is written to localStorage, sessionStorage, IndexedDB or Cache Storage) and
leaves the device only in the ZIP the operator downloads. The page still makes one request: `GET /api/config`.

**1. Board print check (in the guide; required before Start camera with `?validation`, optional and folded away
otherwise; `page/boardCheck.ts`).** The operator types four ruler readings: one marker's black square, width and height;
the outer span of the top row (left edge of its first marker to the right edge of its last); the outer span of the right
column (top edge of its upper marker to the bottom edge of its lower). The expected values are computed from the layout
(`board/spec.ts`): 30.0, 270.0 and 70.0 mm for board v1. **Provisional tolerances:** square ± 0.3 mm, spans ± 0.5 %, and
the across scale (top-row span) and down scale (right-column span) within 0.5 % of each other (a printer that scales one
direction only). Otherwise: "Reprint at 100 % / actual size", with every failed reading named; the camera stays locked.
(Read to 0.5 mm, the 70 mm column alone is uncertain by about 0.7 %: read it between the ticks or with calipers.) The
checklist: plain matte paper, not glossy; lying flat (taped at the corners or on a clipboard), no curl, no folds; no glare
spot on the markers. The "flat" line is waived when the run is tagged `board_curl`, the "no glare" line when tagged
`glare` (those runs break them on purpose).

**2. Test-run details (`page/runDetails.ts`, required with `?validation`).** Phantom id, session id, capture index (starts
at 1 and goes up by one after each export, in memory), operator CODE (2 to 12 letters, digits, `-` or `_` with at least one
digit, so a plain name is refused; never a name), condition tags (baseline, glare, shadow, board_curl, partial_markers,
far, near, low_light, other; at least one) and free notes (500 characters).

**3. Board flatness from the pictures (`boardFlatness.ts`).** `chain.ts` now keeps each view's per-marker residuals from
`board/pose.ts` (`ViewCamera.markerResiduals: { id, rmsPx, used }[]`, the calibrated camera; markers dropped from the pose
as outliers included). Per marker the median over every view with a pose (views the chain left out for a large pose
residual included: they are the evidence), then the median and the worst of that map. **Provisional limits** (px for a
1280 px long side, scaled with the picture): pass when the median is at most 1.2 px and the worst at most 2.0 px; fail
when the median exceeds 1.5 px or the worst 3.0 px; "may not be flat" in between. Fewer than 3 views with a pose, fewer
than 6 markers seen, or an assumed focal length give "not checked". A failed or unchecked flatness makes the capture **not
valid for validation**: the result says so in words above the measurement table and tags every number "not valid" (the
numbers stay visible). The edge-versus-centre ratio (the four corner markers, the ends of the long rows, over the middle
markers of those rows) is reported but does not decide: see the simulation below.
**Live warning:** after each capture from the third on, `page/flatnessWorker.ts` calibrates the camera and poses the views
from the markers the live analysis found on the captured frames (`chain.ts camerasFromMarkers`, the chain's own code) and
shows the same verdict beside the dial ("Sheet flatness so far").

**4. Validity (`page/validity.ts`).** Valid for validation means only "taken under the conditions the plan asks for"
(never "accurate"): ruler check passed, checklist complete (or waived), flatness passed or "may not be flat", the coin did
not say the print scale is wrong, the reconstruction measured something, and (with `?validation`) the run details are
complete. Every unmet condition is listed.

**5. Device performance log (`page/deviceLog.ts`, shown under `?debug`, exported as `device.json`).** Capture duration
(the first Start camera of the capture to Build pressed), build duration (the worker, wall clock), export duration (the
time to prepare every other file of the ZIP: device.json is written last), JS heap every 2 s (Chrome's coarse
`performance.memory`; null where the browser has none) and its peak, `navigator.deviceMemory`, `hardwareConcurrency`, the
user agent, the screen size and devicePixelRatio, the camera track's settings (without `deviceId` and `groupId`), uncaught
errors and unhandled rejections (window listeners; messages only, paths and URLs replaced, no stack traces), WebGL context
losses (capture-phase listener: the viewer's canvas), worker failures (live analysis, flatness, reconstruction) and
whether the export was prepared. A page cannot confirm the download itself.

**6. The measurement table** says in the table, not only behind "why": "Hand surface area" is not available from a board
capture (the palm side rests on the board and is not observed; `multiview/reconstruct.ts boardLimits`), and the knuckle
circumference carries an "upper bound" tag and "UPPER BOUND: the palm side of this loop is the board plane (not observed)
and the visual hull fills the hollows, so the hand's real circumference is at most this value, probably less."

### Export fields added for the offline report tool (`src/experimental/validation/`; do not rename)

`reconstruction.json` (every earlier field kept, including `coin_print_scale_check`):

```
validation_mode: boolean
run: { phantom_id, session_id, capture_index, operator_code, conditions: string[], notes }      (nulls and [] without ?validation)
board_check: {
  ruler: { square_x_mm, square_y_mm, long_span_mm, short_span_mm,
           expected: { square_mm, long_span_mm, short_span_mm }, verdict: "pass" | "reprint" | "not_entered", reasons: string[],
           scale_x, scale_y, checklist: { matte, flat, no_glare } | null },
  flatness: { verdict: "pass" | "warn" | "fail" | "not_checked", worst_marker_rms_px, median_marker_rms_px,
              edge_vs_centre_ratio, reasons: string[],
              per_marker: [{ id, median_rms_px, max_rms_px, views, group }], limits_px, views_used, views_rejected_for_residual },
  coin: <the coin check, the same object as coin_print_scale_check>,
  valid_for_validation: boolean, not_valid_reasons: string[] }
views[i].marker_residuals: [{ id, rms_px, used }]                                              ([] for a view without a pose)
hand_frame: { source: "triangulated" | "one_view" | null, origin: [x,y,z], axis_x, axis_y, axis_z, knuckle_y_mm }   (board mm; all null without a frame)
finger_axes: [{ name, base: [x,y,z], dir: [x,y,z] }]                                           (board mm; [] without a frame)
```

`hand_frame.source` is "one_view" when the reasons include `hand_frame_from_one_view`, else "triangulated".

`device.json` (exactly these keys, in this order): `user_agent, screen { width, height, device_pixel_ratio },
device_memory_gb, hardware_concurrency, camera { width, height, settings }, capture_ms, build_ms, export_ms,
heap_samples_mb, peak_heap_mb, errors, webgl_context_lost, export_ok, started_at, finished_at`.

### SIMULATED flatness results (`boardFlatness.test.ts`)

Renders 1280 x 720, true horizontal field of view 64 degrees, k1 -0.06, k2 0.02, blur 0.7 px, noise 2.5 grey levels; one
view from 78 degrees above, six low views (12 degrees, 15 at azimuth 195) round the hand area; the sheet bent as a
cylinder (arc length preserved). Through `estimateCameras` (detection, self-calibration, poses: the chain's own code) and
through the live check (half-size live detection, first three views only). Console output on this desktop, 2026-11-08:

| sheet | after the build: verdict, median / worst marker residual | corner/middle ratio | views left out for pose residual | calibration RMS, fx (true 1024.2) | live (3 views) |
|---|---|---|---|---|---|
| flat | pass, 0.10 / 0.19 px | 1.78 (at noise level) | 0 / 7 | 0.20 px, 1024.2 | pass, 0.10 / 0.28 px |
| long edges lifted 3 mm | **fail**, 2.10 / 3.36 px | 1.13 | 6 / 7 | 2.39 px, 1026.6 | **fail**, 2.10 / 3.73 px |
| long edges lifted 5 mm | **fail**, 3.40 / 5.61 px | 1.04 | 6 / 7 | 3.93 px, 1029.2 | **fail**, 3.52 / 6.24 px |
| short edges lifted 3 mm | **fail**, 2.38 / 3.77 px | 1.40 | 6 / 7 | 2.38 px, 1032.4 | **fail**, 1.91 / 4.31 px |
| short edges lifted 5 mm | **fail**, 3.83 / 6.02 px | 1.27 | 6 / 7 | 3.97 px, 1037.3 | **fail**, 2.94 / 7.21 px |
| flat, `multiview/scene.ts` (the hand on it, shading, 9 views) | pass, 0.81 / 0.99 px | 0.99 | | | |

Earlier exploration (ideal renders, no blur or noise, 13 views): a 1 mm bend gave a median of 0.73 to 0.86 px (pass), 2 mm
1.4 to 1.7 px (warn or fail). What this shows: at 3 mm and more the chain itself refuses (`camera_calibration_poor`,
calibration RMS over 1.5 px, and most views left out), and the flatness check names the cause in words; a 1 mm bend
passes and shifts the self-calibrated focal length by 0.1 to 0.3 %. The corner/middle ratio rose only for the bend lifting
the short edges and stayed near 1 when the long edges lifted (the pose's plane fit spreads the error; the right-hand
column stood out instead), so it does not decide the verdict. The flat render of the chain's own scene sits at 0.8 px:
the pass limit leaves little room above real detection noise, which nobody has measured on a real print. **The first
phantom session must record the flat-board residuals and re-set these limits.** Real paper curls unevenly; real phones add
compression and rolling shutter; none of that is simulated.

## What is real, what is estimated, what is missing

| | |
|---|---|
| **Measured from the pictures** | The marker corners; the camera's focal length and lens distortion (self-calibration from all the views: nothing is assumed, else the chain refuses); every camera pose; the hand's outline in each view (segmentation against the KNOWN board print); the visual hull carved from those outlines in board millimetres. |
| **Estimated** | The hand frame and finger axes come from MediaPipe's landmarks, triangulated from several views; when MediaPipe finds the hand in only one view looking down (60 degrees or more, usually the top view), its landmarks are **lifted onto the mesh** instead, each joint assumed at half the local hand height above the board (reason `hand_frame_from_one_view`, worded on the page). Either way, measurements that depend on them are labelled **model**. The live angles during capture use an assumed focal length (guidance only, never measured with). |
| **Missing / bounded, not observed** | It is a **visual hull**: concavities (the palm hollow, the web of the thumb) are filled, finger gaps close where no view looks through them, the hull is an upper bound of the hand, never the skin. The **palm side rests on the board**: it is bounded by the board plane (labelled `support_plane`), **not observed**; the forearm end is a cut. Without usable landmarks (none in several views and none in a view looking down) there is no hand frame, so no lengths, breadth, thickness or circumference. No real photo has been through this page's reconstruction in a test; **no accuracy is claimed**. |

## SIMULATED results

### `chain.test.ts` (the chain alone, Node)

From pixels only (the chain is told no focal length, no distortion, no pose): 17 rendered views of the capsule hand at
1280 x 720 (one from above, 16 at 12 degrees; true horizontal field of view 64 degrees, k1 -0.06, k2 0.02). Console output
of `npx vitest run --no-file-parallelism src/experimental/recon/chain.test.ts` on this desktop, 2026-11-08:

```
SIMULATED pixels-only chain, 17 views 1280x720:
  calibration zhang, focal error 0.096 %, k1 est -0.0635 (true -0.06), rms 0.78 px
  views with pose: 16/17; markers per view 15,9,12,12,10,9,10,8,5,2,5,7,9,9,11,12,11
  pose error over the 16 views used: rotation max 0.142 deg, camera centre max 1.56 mm
  views left out: e12-180 (only 2 consistent marker(s) (needs 3); inconsistent markers 4,10)
  accepted true []
  length +0.0, breadth +1.6, thickness +2.5, knuckle circ +2.1 mm
  fingers thumb -0.7, index +0.7, middle -0.2, ring +0.2, little +0.8
  support share {"observed":0.6546684974495396,"implied":0.0769473867747622,"support_plane":0.22910945468821747,"volume_cut":0.03927466108713371,"truncated":0}
  timings detect 3.6 s, calibrate 715 ms, pose 233 ms, reconstruct 26.1 s
```

A second run later the same day (after `onProgress` was added to `chain.ts`) printed the same numbers to the last digit
except the timings (detect 1.4 s, calibrate 281 ms, pose 100 ms, reconstruct 10.9 s): the first run shared a busy machine.

(The test's landmarks are the synthetic hand's own points projected with 2 px noise, not MediaPipe output.) The view
straight along the forearm (azimuth 180) saw only 2 markers; the page's sectors therefore have a boundary at 180 degrees,
so the two sectors beside the open edge are filled from about 165 and 195 degrees, where more markers show.

### The page in a browser (`e2e/experiment-recon.spec.ts`)

Chrome's fake camera plays `e2e/.media/recon-orbit.y4m` (made by `e2e/recon-media.ts`): the capsule hand on the board,
1280 x 720 at 5 frames per second, true horizontal field of view 64 degrees (fx 1024.2 px), k1 -0.06, k2 0.02, a 23 x 1.5 mm
coin on the target (23 mm is the served settings' coin; the 1.5 mm thickness is assumed for the simulation). The camera
holds about 1.4 s straight above, then at the middle of each 30-degree sector of the low ring 340 mm from the hand area
(12 degrees above the board, 15 degrees at 165 and 195 degrees beside the open edge), with two in-between frames per move.
Nobody touches the page after **Start camera**. Four runs on this desktop (headless Chrome, software WebGL), 2026-11-08,
gave the same result each time:

* **Capture**: all 13 required views taken automatically (no middle-ring view: the moves are not held), 4 to 15 markers
  each; live analysis about 4.8 to 5 frames per second (the camera's rate), marker detection median 30 to 47 ms per
  1280 x 720 frame in the worker. The live elevation (assumed focal length) read 13.4 to 13.8 degrees for the 12-degree
  stations and 16.6 to 16.8 for the 15-degree ones (the live reference point is the board, the camera aims 10 mm above it).
* **MediaPipe found the synthetic hand in 1 of the 13 views** (the top view) and in none of the low views, so no landmark
  could be triangulated. The page then **lifts the top view's landmarks onto the mesh** (reason `hand_frame_from_one_view`,
  worded on the page) and shows the lengths, breadth and thickness as **model** estimates; the knuckle circumference was
  "not available" in this run. These browser numbers come from MediaPipe's own landmarks on a non-anatomical capsule
  hand, so they are **not comparable** with the capsule hand's exact dimensions; the comparable SIMULATED figures are
  `chain.test.ts`'s (with landmarks in the top view only: length -4.8, breadth +0.9, thickness +2.5, knuckle
  circumference +0.5 mm). The page also uses the top view's landmarks to name the thumb side. With real hands MediaPipe
  may find the hand in more views: untested.
* **Calibration** from the 13 pictures: Zhang, fx 1025.6 px (true 1024.2: +0.14 %), k1 -0.0815, k2 0.0503 (true -0.06,
  0.02; the pair trades off), RMS 0.81 px; 13 of 13 views with a pose.
* **Reconstruction**: accepted by its own surface gates; 182,396 triangles at 1.5 mm voxels; bounding box
  202 x 129 x 35.8 mm; surface 52.1 % observed, 19.9 % implied, 24.0 % bounded by the board, 4.0 % forearm cut, 0 %
  truncated; outline overlap 0.967 to 0.981 per view; hull surface above the board 32,946 mm².
* **Coin check** on the top view (75.5 degrees above the coin): 23.24 mm in board millimetres, implied print scale 99.0 %
  (-1.0 %): within 2 %, so no warning. The plain circle fit over-reads because the settings give no thickness (the raised
  edge); the page says so. An earlier run with the scene's default 23.25 x 2.33 mm coin read 23.71 mm (97.0 %) and the page
  then withheld the numbers with the print-scale warning: the check is sensitive to an unmodelled coin thickness.
* **Timings in the worker**: markers 1.0 to 1.2 s, calibration 110 to 160 ms, poses 30 to 50 ms, reconstruction 8.0 to
  8.4 s (outlines 5.8 s), whole build 9.4 to 10.0 s; page JS heap 70 to 90 MB (Chrome's `performance.memory`). On a busy
  machine the same build took 23 s. Nothing was timed on a phone.
* Export: `README.txt`, `reconstruction.json`, `mesh.ply`, `points.csv`, no photos (box unticked by default). Requests: only
  the page's own static files and `GET /api/config`; nothing in localStorage, sessionStorage, IndexedDB, Cache Storage or
  a service worker; no page errors; nothing pushed past the right edge at 360, 390, 844 and 1280 px.

**Validation mode in the browser test** (the spec now opens `?debug&validation`; four runs on this desktop, 2026-11-08,
the same results each time apart from timings): Start camera stays disabled until the ruler readings, the checklist and
the run details are complete; a 97 % print (29.1 / 29.1 / 261.9 / 67.9 mm) gives "Reprint at 100 % / actual size"; a name
as the operator code is refused. The SIMULATED print is exact, so the layout's own lengths are typed in. The live flatness
check ran on the captured views: pass, median 0.66 to 0.67 px, worst 0.78 to 0.85 px; after the build: pass, median 0.67 px,
worst 0.76 px over 13 views, corner/middle ratio 0.89; valid for validation. The ZIP then holds `device.json` too, with
the agreed keys: capture 29.3 to 47.1 s, build 5.4 to 33.8 s (the 33.8 s run shared a busy machine), export 150 to 726 ms,
23 to 48 heap samples (peak 84 to 109 MB), no errors, no WebGL context lost. MediaPipe found the hand in the top view only,
so the knuckle circumference was "not available" in these runs and the "upper bound" tag was not exercised in the browser
(it is in `page/ReconResult.test.tsx` and `page/format.test.ts`). Requests: still only `GET /api/config` and the page's own
files (the flatness worker is one of them); nothing stored in the browser.

Screenshots: `frontend/test-results/recon/` (guide, live, all views, building, result at 360, 390 and 1280 px, the viewer;
with `?validation`: `01-guide-*` empty, `01b-ruler-reprint-phone-390`, `01c-guide-filled-*`, `07-result-debug-phone-390`).
Not tested in a browser: the refusal and the wrong-print paths (unit-tested in jsdom), a real camera, a phone.

## Files

| file | what it does |
|---|---|
| `page/ReconPage.tsx`, `page/recon.css`, `page/main.tsx` | the page: guide, live stage, dial, thumbnails, building, debug panel; `window.__RECON__` (a read-only summary, no pixels) for the browser test |
| `page/useReconCapture.ts` | config, camera (`src/camera/camera.ts` `openCamera("environment")`), the live loop, the capture (MediaPipe via `src/vision/handTracker.ts` on the captured frame), the build, the export, the board download |
| `page/coverage.ts` | bins, guidance wording, capture gate, what is missing |
| `page/frameMetrics.ts` | sharpness, pose change, pixel to board plane, which edge the thumb points to (names the sides) |
| `page/CoverageDial.tsx` | the dial |
| `page/liveWorker.ts`, `page/reconWorker.ts`, `page/workers.ts` | the two workers and their clients (pixel buffers transferred both ways) |
| `page/ReconResult.tsx`, `page/format.ts` | the result and every word and number in it |
| `page/exportZip.ts` | the ZIP (reconstruction.json, mesh.ply, points.csv, device.json, README.txt, photos only when ticked) |
| `boardFlatness.ts`, `curledBoardRender.ts` | the flatness verdict from the per-marker residuals; the bent-sheet renderer for its SIMULATED test |
| `page/boardCheck.ts`, `page/runDetails.ts`, `page/validity.ts`, `page/deviceLog.ts` | the ruler check and checklist, the test-run details, the validity for validation, the device performance log |
| `page/ValidationPanels.tsx`, `page/flatnessWorker.ts` | their panels on the page; the live flatness check in a worker |
| `page/types.ts`, `page/testFixtures.ts` | shared types; hand-made outcomes for the unit tests |
| `../../../e2e/experiment-recon.spec.ts`, `../../../e2e/recon-media.ts`, `../../../playwright.recon.config.ts`, `../../../vite.recon.config.ts` | the browser test, its SIMULATED fake-camera video (`e2e/.media/recon-orbit.y4m`, gitignored) and its own servers (ports 5231 and 8831) |

## Privacy

The photos stay in this tab's memory. The only network request is `GET /api/config`; the browser test records every
request and checks it (`capture/privacy.ts`). Nothing is written to localStorage, sessionStorage, IndexedDB or Cache
Storage, and no service worker is registered (the browser test enumerates all five). The ZIP is saved only when asked, and
contains the photos only when ticked. Closing the tab discards everything.

## Tests

```powershell
cd C:\Users\pc\Downloads\OPEN-CV\frontend
npx vitest run --no-file-parallelism src/experimental/recon
npx playwright test -c playwright.recon.config.ts     # first run renders the fake-camera video (a few minutes)
npx tsc -b --noEmit
```
