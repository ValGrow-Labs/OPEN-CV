# Technical audit for the coin-based full 3D hand measurement engine (2026-11-08)

Scope: the computer-vision and 3D measurement engine only (no e-commerce work). Status words: **functional** = runs on
real inputs today; **simulated** = works on rendered/synthetic data, never run on a real capture; **assumed** = rests on a
value nobody measured; **incomplete** = missing parts. Earlier detail: `AUDIT_3D_STATUS.md`, `CONSOLIDATED_FINDINGS.md`.

## 1. Component status

| Component | Where | Status | Evidence / gap |
|---|---|---|---|
| Coin detection (OpenCV.js, production) | `src/vision/coinDetector.ts`, `coinEngine.ts` | **Functional** on real phones (live video), reason codes, quality score | Real Android recording 2026-11-08: coin not accepted then (US quarter selected; now the experiment defaults to the 2019 Rs 2 coin). No accuracy validation; production calibration is **not validated** |
| Coin reference (Rs 2, 2019, 23.00 mm) | `config/reference_objects.json` (`inr_2_2019`) | Functional config entry, source cited (G.S.R. 184(E), 2019) | **Thickness not in the settings** (the board coin check assumes 1.5 mm: assumed) |
| Coin-plane scale and tilt from an ellipse | `experimental/geometry/coinScale.ts` | Simulated | One circle: scale and tilt of its own plane only; no camera pose (`LIMITS_OF_ONE_CIRCLE`) |
| MediaPipe hand landmarks (21) | `src/vision/handTracker.ts` | **Functional** on real phones | Model output (relative z), not measurement; found the synthetic hand only from above |
| Hand segmentation, generic (GrabCut seeded by landmarks) | `experimental/segmentation/` | Composite images (real hand pixels on synthetic backgrounds): mean IoU 0.952; quality gates | One real hand photo; **no real ground-truth masks**; no per-finger part labels; phone latency unmeasured |
| Hand segmentation, board-based | `experimental/multiview/segment.ts` | Simulated (IoU 0.98 to 0.998, five skin tones) | Needs the printed board |
| Finger separation, fingertips, gaps | `experimental/segmentation/fingers.ts` (merged-finger gate), densescan regions (landmark-based) | Incomplete | No per-finger mask labels, no gap map, no per-pixel confidence |
| Dense point generation | `experimental/densescan/` | Functional on real frames, but **2D** | Image-space dots; z empty or MediaPipe relative; must never be called 3D |
| Camera intrinsics | production: assumed field of view 55 to 80 degrees; `experimental/board/calibrate.ts` (Zhang from the board) | Production **assumed**; board calibration simulated (focal error 0.1 %) | Web pages get no intrinsics; no board-free calibration exists |
| Camera pose per view | `experimental/board/pose.ts`, `recon/chain.ts` | Simulated (0.14 degrees worst) | **Needs the printed board.** No feature-based (markerless) pose, no visual odometry |
| Multi-view reconstruction | `experimental/reconstruction/` (visual hull, mesh, gates, support labels), `multiview/reconstruct.ts` | Simulated end to end from pixels | Visual hull only (no multi-view stereo / photo-consistency): concavities filled; palm side bounded by the board |
| Synthetic hand experiments | `reconstruction/synthetic.ts`, `multiview/scene.ts` | Simulated by definition | Capsule hand, not anatomical |
| Measurement extraction | `reconstruction/measure.ts`, `multiview/reconstruct.ts` (`boardLimits`) | Simulated | Basis direct/model/none and a note per value; **no numeric uncertainty per value**; finger widths only in the validation tool (in progress); circumference an upper bound; surface area withheld for board captures |
| Measurement resolution | `experimental/geometry/resolution.ts`, `CONSOLIDATED_FINDINGS.md` section 4 | Arithmetic | 1280 px video: 0.28 to 0.46 mm/px at 350 mm; 0.1 mm/px needs 10 to 26 MP; not yet combined with measured boundary error into a defensible increment |
| 3D viewer | `reconstruction/MeshViewer*.tsx` | Functional (headless Chrome screenshots) | Not tried on a phone GPU |
| Capture page | `experimental/recon/page/`, `/experiment/recon/` | Browser-tested with a simulated fake camera | Never run on a phone or a real print |
| Physical validation | `docs/hand3d-research/validation/`, tooling in progress | Protocols only | No phantom, no data |
| Phone performance | `?debug` panels, device log (in progress) | None measured for 3D | iPhone: no WebXR depth; Android: untested |
| Test suites | `npx vitest run src/experimental` | 513 passing (2026-11-08) | Synthetic and composite data only |

## 2. What the new brief changes

1. **No printed board** in the target workflow: the coin is the only physical reference. Today's 3D chain takes its camera
   intrinsics, every camera pose, the support plane and its segmentation from the board. Without the board those must come
   from the images themselves (structure from motion on background texture, the coin, the hand) — not built, untested.
2. **Segmentation** must be board-independent, label the five fingers, fingertips and gaps, and give confidence and
   boundary metrics.
3. **Every measurement needs a numeric uncertainty**, a definition, a method and a data source.
4. **0.1 mm**: needs an evidence-based smallest defensible increment.

## 3. What a coin can and cannot do (unchanged physics)

* A single coin gives a known length **at its own plane** and the tilt of that plane (up to a sign), not the camera pose,
  not depth elsewhere. A global pixels-per-millimetre ratio is wrong for any part of the hand at another height.
* In a **multi-view** reconstruction the coin can fix the one unknown scale of the whole scene: structure from motion
  gives the scene up to scale; the coin's rim, triangulated in 3D (or its diameter in the reconstructed table plane), sets
  that scale. That is one scalar for a 3D scene, which is correct, unlike a 2D ratio.
* Self-calibration of the focal length without a board must then come from the structure-from-motion bundle adjustment;
  a shared focal error is invisible to consistency checks (SIMULATED: +2 % focal passes every gate yet shortens lengths
  about 2 %), so it is the main risk of a board-free design.

## 4. Plan (stages, each tested before the next)

| Stage | Work | Exit evidence |
|---|---|---|
| 1 | This audit | done |
| 2a | Segmentation module, board-independent: GrabCut + landmarks (existing) with per-finger part labels, fingertips, gap map, per-pixel confidence, boundary metrics, gates (blur, partial occlusion, incomplete, merged fingers), skin-tone and lighting tests; architecture comparison with licences | composite and simulated test tables; real-mask evaluation stays pending (no labelled real masks) |
| 2b | Coin calibration study: production detector read-only, ellipse fit, pixel diameter, visibility/orientation checks, confidence, px-to-mm at the coin plane with propagated uncertainty; sensitivity to position, tilt, perspective, distance, thickness, edge error; the coin as the 3D scale of a multi-view scene | simulated sensitivity tables; coin thickness from an official source or marked UNVERIFIED |
| 3 | Board-free multi-view geometry feasibility: features on the table/background, matching, robust two-view geometry, incremental structure from motion, bundle adjustment with focal self-calibration, table-plane fit, coin-based scale; compare with the board route on the same simulated scenes; failure modes (plain table, no texture) | pose and scale errors vs truth; a go/no-go with evidence |
| 4 | Board-free reconstruction: plane-consistency segmentation (the table seen from several views), carving, support plane from the table fit, labelled mesh, point cloud with confidence and source views; photo-consistency refinement investigated for concavities | end-to-end SIMULATED from pixels, like `recon/chain.test.ts` |
| 5 | Measurement engine with numeric uncertainty per value (propagated from calibration, pose, mask boundary, voxel size), finger widths, definitions; the 0.1 mm question answered with evidence | per-value uncertainty tables |
| 6 | Physical phantom validation, then the consent-approved human study design; phone performance on real devices | real data only (`validation/`) |

The board route stays as the reference implementation: it is the accuracy benchmark the board-free route is compared with
on identical simulated scenes, and the fallback if the board-free route fails its exit evidence.

## 5. Stage 2b findings that concern the PRODUCTION scanner (reported, nothing changed)

From `frontend/src/experimental/coin/README.md` (SIMULATED rendered coins, 23.00 mm x assumed 1.5 mm, 1280 x 720, 300 mm):

* **Off-centre coins read small with the production diameter (D / major axis):** -2.35 % halfway to the image corner,
  -4.0 % at 0.85 of the way, because the coin's wall joins its outline when seen obliquely (a 0.02 mm "coin" measures
  exactly there). With lens distortion the sign flips (+3.3 %). A 3D fit with known intrinsics and the thickness modelled
  brings these to +0.05 to +0.26 %, but production has no intrinsics.
* **Production detector limit:** coins tilted beyond about 41 degrees are not accepted (`min_axis_ratio` 0.75); at 45
  degrees the diameter is 23 % off when forced.
* **A coin on white paper with a contact shadow** read -2.9 % with the refined fit and no gate caught it (on skin, as in
  production, this case does not arise).
* **One global pixels-per-millimetre ratio** (what a single-image coin scale is): points 20 mm above the coin's plane read
  +7.1 % long at 300 mm (+11 % at 200 mm), 40 mm above +15.4 %.
* **Coin thickness is UNVERIFIED:** the 2019 Coinage Rules (G.S.R. 184(E), read via two reproductions) give 23 mm, 4.07 g,
  ferritic stainless steel, but no thickness and no diameter tolerance; only a secondary catalogue gives 1.5 mm. Needs a
  caliper study (10 or more coins).

Possible production actions (need the owner's approval; not done): guide the coin toward the image centre; record the
coin's position in the frame with each scan so the bias can be studied on real data; measure real coins' thickness.

## 6. Stage 5: measurement engine with numeric uncertainty (2026-11-08, SIMULATED)

Code: `frontend/src/experimental/measure/` (README there has the full tables). Hooked into the board route additively:
`reconstructFromBoardViews` returns a new optional `measurementReport` (option `uncertainty`, default the SIMULATED board
inputs; `null` skips); `recon/chain.ts` feeds the calibration's own focal covariance when it exceeds the floor. Existing
`measurements` are unchanged. The input struct (`CaptureUncertainty`) does not refer to the board, so the board-free route
can feed it (`boardFreeUncertainty`: the caller must state focal, pose, boundary and landmark sigmas; coin scale default
0.34 %, SIMULATED).

* **Every value** (hand length, palm breadth and thickness, knuckle circumference, five finger lengths, **finger widths of
  each finger at two stations**: 15 mm from the tip and 25 % from the MCP, surface area) carries definition, method, data
  source (views, mesh region, landmarks and how they were obtained), basis, an upper-bound flag and a numeric uncertainty
  (u_c and U = 2 u_c) with one component per input (focal, pose, scale, mask boundary, voxel, landmarks). Every input
  sigma is labelled SIMULATED (test cited), ASSUMED, EXACT or RUNTIME. Rules kept: no surface area on a board capture;
  circumference basis model, UPPER BOUND. New withholding: merged, open or not finger-sized width sections; no uncertainty
  when the gates fail.
* **Method:** analytic first-order budget with the shape sensitivities read on the actual mesh (offset and sliding
  sections), compared with a Monte Carlo that re-runs the whole board reconstruction under drawn errors (17 rendered
  views, exact masks, capsule hand). With the SIMULATED inputs (focal 0.1 %, pose 0.14 deg / 1.56 mm, boundary 0.6 px,
  landmarks 2 px): analytic u_c 1.5 mm on lengths, 2.2 to 2.4 mm on finger widths, 1.2 mm thickness, 2.3 mm breadth,
  6.2 mm circumference; Monte Carlo rms 0.8 to 1.2, 0.6 to 1.7, 0.8, 1.1 and 3.9 mm. The analytic budget is conservative in
  spread but misses a **negative bias** from pose errors (misregistered views carve the hull smaller: about -0.9 mm on
  lengths, -3.5 mm on the circumference); 37 % of the combined trials were rejected by the gates.
* **ASSUMED phone conditions** (pose 0.5 deg / 3 mm, boundary 1.25 px, landmarks 5 px, print scale 0.74 %): **every**
  perturbed reconstruction (20/20) failed the reprojection gate; ungated, u_c would be 3.5 mm on lengths, 5 mm on widths,
  14 mm on the circumference. Pose accuracy is the dominant input for the board route.
* **The 0.1 mm question:** a 0.1 mm increment needs u_c below 0.2 mm. Carving masks give 0.54 to 0.75 mm per pixel at the
  hand. The defensible increment is **1 mm for lengths and finger widths (0.5 mm at best in clean simulation), 2 mm for
  palm breadth, 5 mm for the circumference upper bound**. 0.1 mm would need outlines to about 0.1 px, poses to about
  0.02 deg, a 0.25 mm voxel grid, landmark datums to 0.1 mm and scale to 0.05 %: **not defensible for any value**.
* **Limits:** one capsule hand, exact masks, a pessimistic independent-pose model, a uniform outline-offset model; the
  interval excludes the hull's one-sided bias, definition gaps and soft tissue. Every ASSUMED sigma needs the Stage 6
  phantom study. Nothing here is real-world accuracy.

## 7. Stage 3: board-free camera geometry (2026-11-08, SIMULATED)

Code: `frontend/src/experimental/sfm/` (README there has every table). Pure TypeScript structure from motion: features
with the hand excluded, matching, RANSAC two-view geometry, incremental registration (P3P), bundle adjustment with focal
length and k1/k2 self-calibration, table-plane fit, the coin's 3D circle fitted **jointly** in the bundle adjustment.

* **Verdict: conditional GO.** Works only with a **continuous sweep** (frames at most about 7.5 degrees apart on the low
  ring, then an arc up to the top view, about 57 frames) over a **richly textured, non-repetitive surface** (a printed
  random-speckle mat would do; nothing on it is measured), the coin fitted jointly, and **the coin's thickness known**.
* Best condition (speckle, 7.5 degree steps): 57/57 views registered; focal +0.13 %; rotation 0.27 degrees worst in the
  table frame; camera centres 1.85 mm worst; scale +0.11 % (joint coin). Carving with these poses: within 0.4 mm of
  carving with the exact poses. The board route on the same path: focal +0.096 %, 0.142 degrees, 1.56 mm.
* **No-go conditions:** the board capture's 13 to 25 stills (0 views registered on every texture: matching fails beyond
  about 10 to 15 degrees between views); 10 or 15 degree steps; wood grain; weak or plain tables (0 registered); plaid
  (registered 10/57 with a low 0.40 px residual but **false geometry**: a low residual is not a safe acceptance test);
  newspaper marginal (0.56 to 0.70 degrees, fails).
* **Coin thickness drives scale:** assuming 1.0 or 2.0 mm for a 1.5 mm coin shifts the scale by -1.47 % / +1.89 %. The
  thickness is UNVERIFIED, so the 0.5 % scale requirement is **not met today**; a caliper study of real coins is needed.
* Open: segmentation without the board (exact masks used here), one reprojection gate failing narrowly (IoU 0.791 vs
  0.80) from the landmark-built forearm cut, no real detector error on the coin edge, no rolling shutter, compression or
  motion blur, no phone timings. Stage 4 (section 8) addressed the first two.

## 8. Stage 4: board-free reconstruction (2026-11-08, SIMULATED)

Code: `frontend/src/experimental/boardfree/` (README there has every table). End to end from pixels like
`recon/chain.test.ts`: 57-frame sweep, `runSfm` with the coin fitted jointly, table frame, board-free segmentation,
carving with the table as support plane, labelled mesh, point cloud (mm, confidence, source views), the existing gates and
measurement code. Landmarks and coin outline are detector stand-ins (as in the board route's test); coin thickness 1.5 mm
UNVERIFIED in every run.

| Route (same synthetic hand), mm measured - true | Gates | Length | Breadth | Thickness | Circ. (upper bound) |
|---|---|---|---|---|---|
| exact poses, exact masks | pass | -0.1 | +1.3 | +1.8 | +0.3 |
| **board-free chain** (SfM + combined segmentation) | **pass** | **-0.4** | **+1.2** | **+2.7** | **-0.2** |
| board-free, GrabCut-only segmentation | pass (wrongly) | -0.4 | +14.8 | +3.0 | +22.4 |
| board route (`recon/chain.ts`) | pass | +0.0 | +1.6 | +2.5 | +2.1 |

* **Segmentation without the board:** new plane-consistency test (a table pixel agrees with its neighbours through the
  table plane, a hand pixel does not) used to seed GrabCut. Mean IoU 0.965 to 0.972 over four simulated skin tones (GrabCut
  alone 0.875 to 0.938; plane alone 0.909 to 0.921, nearly independent of skin tone).
* **Gate blind spot found:** GrabCut alone took in the hand's cast shadow in every view, so the hull was 15 mm too wide
  and **every gate still passed** (consistent errors across views agree with each other). Consistency gates cannot catch a
  shared segmentation bias; real-mask evaluation is required.
* **Stage 3 gate failure fixed without changing thresholds:** a "forearm" cut policy (the hull's cross-section at the cut,
  prolonged backward, is treated as beyond the cut) and a five-landmark hand axis: worst along-arm view 0.81 -> 0.98.
* **Thickness +1.7 to +2.9 mm on every route, even with exact poses and masks:** visual-hull over-fill with 17 views,
  not pose error.
* **Refusals with named reasons:** plain table (`sfm_failed`), the stills (`too_few_frames`), coin under the hand
  (`coin_missing`), also `coin_partial`, no coin, mixed picture sizes.
* **Photo-consistency refinement:** weak signal (an over-fill voxel looks less consistent than a true one 72 % of the
  time), cannot reach the palm hollow, does not fix thickness; not recommended before real captures.
* Time: about 38 s on a desktop (SfM 27.5 s); the board route takes 4 s. No phone timing.
* Open: the board-free result is not yet fed into the Stage 5 uncertainty engine (`BoardFreeResult.uncertainty` holds the
  inputs; full bundle-adjustment covariance not exposed); no real detector, shadows, gloss or captures.
