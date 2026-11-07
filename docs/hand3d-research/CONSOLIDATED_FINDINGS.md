# Consolidated findings: smartphone-only 3D hand measurement

Date of consolidation: **2026-11-07**. Inputs: four research and engineering passes (segmentation, camera geometry and
calibration, multi-view reconstruction and measurement, licensing/compatibility/validation research) plus my own checks.
Everything is **experimental and isolated** (`frontend/src/experimental/**`, `docs/hand3d-research/**`); no production
file, calibration setting, coin-pipeline code or deployment was changed.

**Reading rule for this whole document.** *Simulated* = computed on synthetic data with a known truth: it shows the
mathematics works and says **nothing** about real accuracy. *Real, unlabelled* = run on real pixels but with no ground
truth: visual inspection only. *Not yet measured* = needs physical reference measurements, which do not exist yet.
**No real-world 3D measurement accuracy is claimed anywhere.**

## 1. Segmentation approaches, identical test images

All three backends ran on the **same 26 composite scenes** (a real hand photo placed on synthetic backgrounds, skin tones,
lighting, blur, orientations and a mirror; the truth mask is known) plus 4 real frame crops. Numbers are working-image pixels
(512 px; source pixels are 2.5x larger). *Simulated composites from one hand photo: not real-world accuracy.*

| Backend | Mean IoU (worst) | Dice | Boundary mean / p95 | Accepted by gates | Median latency (desktop Chrome, no GPU) |
|---|---|---|---|---|---|
| **GrabCut seeded by landmarks** (OpenCV.js) | **0.952 (0.813)** | 0.975 | **1.0 / 2.5 px** | 25 of 26 | 2.2 s |
| MediaPipe interactive segmenter (`magic_touch`) | 0.832 (0.176) | 0.889 | 6.9 / 11.3 px | 21 of 26 | 1.3 s |
| Skin-colour baseline | 0.786 (0.326) | 0.851 | 6.1 / 1.7 px | 16 of 26 | 0.7 s |

* GrabCut: IoU 0.946 to 0.992 on every background, skin tone, lighting, orientation and the mirror; all 78 finger gaps stayed open.
  Weak on blur (sigma 9: 0.81, correctly rejected) and on small hands (40 % size: 0.81, **wrongly accepted**: the quality gate needs work).
* Interactive segmenter: fills finger gaps, and picked the wrong object at 30 and 250 degrees (IoU 0.18).
* Skin colour: fine on neutral backgrounds, about 0.4 IoU on dark, pale or recoloured skin and shifted lighting.
* DeepLab v3 has **no hand class** (it labelled the hand "chair"). The MediaPipe hand landmarker found **no hand** on the skin-coloured table and wood-stripe backgrounds.
* Real frames available are screen recordings with the app's own overlay drawn on a hand about 150 px wide: only one of four crops yielded landmarks.
  On that one, GrabCut was tight with correct tips and gaps (visual inspection only).

## 2. Best hand-outline method

**Carry GrabCut with landmark seeds forward** as the baseline silhouette, behind the quality gates (blur, occlusion/incomplete, merged fingers, no hand).
It is the most accurate here, keeps finger gaps, and uses an OpenCV function that the bundled build already exposes
(`typeof cv.grabCut` is "function", checked in real Chrome and Node).

* **Mobile performance is unproven.** About 2 s per mask on a GPU-less desktop browser is pessimistic, but no phone was timed. GrabCut suits a **per-capture** step
  (a few masks per scan, in a worker, at 480 to 640 px), **not** a per-frame overlay. The live overlay should keep using the landmark outline.
* **Failure modes to design for:** blur, small hands in the frame, and backgrounds on which the landmark detector itself fails (skin-coloured tables).
* **Next candidates** (not built): MobileSAM and SAM 2 (permissive weights, see section 7) as promptable refiners or offline labelling aids; a small network **trained on our own
  consented, hand-traced masks** is the clean long-term route and the only one tuned to hands. **A custom labelled dataset is required regardless**, because there is no real ground truth today.
* The 0.1 mm-per-pixel question: segmentation error is the dominant term, see section 4.

## 3. Camera poses across the four views

What exists in the toolbox (all simulated tests): camera model with radial distortion, pose maths, **pose from known coplanar points** (homography/PnP), reprojection error.

* **From a coin alone there is no pose.** One circle gives the scale and tilt of its *own plane* only: the tilt sign is unobservable and in-plane rotation is undefined.
  So a coin cannot align four views.
* **From a printed planar marker sheet there is.** Each view solves a pose from the sheet's known corner coordinates; all views share the **sheet frame** as the world frame, so alignment is
  by construction. Simulated accuracy with 0.3 px of corner noise: a **180 mm** sheet gives about **0.07 degrees and 0.43 mm** mean (0.13 degrees, 0.83 mm worst); a 60 mm hand-sized target is about 6x worse in position and 8x in worst case.
  *Simulated; real marker-detection error is not yet measured.*
* **Why pose accuracy is the make-or-break number** (simulated reconstruction): a 1 degree / 2 mm pose error moves a cross-section circumference by about **-23 mm** (rejected by the reprojection gate); 2 degrees / 4 mm collapses the mesh (fingers lost).
  A **2 % focal-length error passes every gate** yet shortens lengths by 1.5 to 3 mm: gates cannot see a *shared* systematic error. So intrinsics must be known or self-calibrated, not assumed.
* **Intrinsics:** a web page gets none (no focal length from `getUserMedia`; the app assumes a horizontal field of view of 55 to 80 degrees from config). Options: per-phone calibration for a supported-device list, or **self-calibration from the printed sheet in several views** (planar calibration needs at least three views of the plane).
* **Marker detection must be written, because the bundled OpenCV.js lacks the usual tools.** Checked in Node with the project's loader (`typeof cv.X`):
  * **Absent:** `aruco` / `ArucoDetector`, `findChessboardCorners`, `findCirclesGrid`, `cornerSubPix`, `calibrateCamera`, `triangulatePoints`, `findEssentialMat`, `recoverPose`, `findFundamentalMat`, `undistortPoints`, `estimateAffinePartial2D`, `StereoSGBM`.
  * **Present:** `solvePnP`, `solvePnPRansac`, `findHomography`, `Rodrigues`, `projectPoints`, `getPerspectiveTransform`, `warpPerspective`, `adaptiveThreshold`, `approxPolyDP`, `minAreaRect`, `moments`, `fitEllipse`, `HoughCircles`, `SimpleBlobDetector`, `QRCodeDetector`, `ORB`, `AKAZE`, `BFMatcher`, `calcOpticalFlowPyrLK`.
  * Consequence: build a square-fiducial detector from `adaptiveThreshold` + contours + `approxPolyDP` + our own ID decode and **own sub-pixel corner refinement** (no `cornerSubPix`), or use `QRCodeDetector` as the marker (present, gives four corners), or make a custom OpenCV.js build that includes the objdetect/aruco bindings (Apache-2.0). Planar self-calibration (Zhang) is also ours to write.
* **Hand pose consistency across views** is *measurable*: `poseConsistency` compares bone-length ratios, finger bend and palm cupping between views (reliable on 3D world landmarks, weaker on 2D). It flags views where the hand changed. *Simulated tests only.*
* **Capture geometry matters:** profile views (thumb side, little-finger side) see a flat sheet at a grazing angle, where marker corners are hard to detect. Plan for markers on a raised frame or a ring around the hand, or keep views above a minimum elevation. **Open design question, needs real trials.**

## 4. How the marker sheet and the coin jointly give metric reconstruction

| Role | Marker sheet | Coin on the palm |
|---|---|---|
| Camera pose per view | **Yes** (planar PnP) | No (one circle) |
| Metric scale | At the sheet plane, from the known printed size | At the coin's plane, from the coin's diameter |
| Self-calibration of focal length | Yes, from several views of the sheet | No |
| Independent cross-check | Coin vs sheet scale should agree after the height difference is accounted for | Same |
| Palm height above the sheet | Gives the sheet-plane scale s_sheet = f / Z_sheet | Gives s_coin = f / (Z_sheet - dz) |

* **Joint use (derived here, not tested on real data):** with both scales in the same image, the coin's height above the sheet is dz = f (1/s_sheet - 1/s_coin). That **estimates the plane offset between the palm and the sheet**, which the error budget identifies as the **dominant error**.
  In the simulated budget, a 15 mm offset on a 190 mm hand at 0.2 mm/px gives about **8.2 mm (4.3 %)** uncorrected, about **3.1 mm (1.6 %)** corrected to a 5 mm residual; at 0.1 mm/px the corrected budget is still about 1.6 mm. **0.1 mm/pixel is a scale, not an accuracy.**
* The coin also remains the **production** scale reference; this research does not alter it.
* Resolution reality (read from the app's config and the field-of-view range): the coin lies in the hand's plane, so it is **not** sharper than the hand. The 1280 px video gives **0.28 to 0.46 mm/px at 350 mm** (a quarter is 53 to 85 px across).
  0.1 mm/px at 350 mm needs roughly **10 to 26 megapixels** (a full still), not the live video. Boundary localisation on real skin edges, blur, distortion and soft tissue add errors that no pixel size removes.

## 5. Can the reconstruction recover palm, fingers, sides and finger gaps?

*Simulated, on a synthetic capsule hand with exact analytic truth. Real hands add concavities, soft tissue and pose drift that this model does not have.*

| Scenario (signed error, mm) | Length | Breadth | Thickness | Circumference | Fingers | Gates |
|---|---|---|---|---|---|---|
| 8 views, clean | -0.1 | +1.7 | +1.5 | +0.3 | -0.1 to -0.5 | pass |
| 4 views, clean | 0.0 | +1.7 | +1.5 | +4.6 | -0.2 to 0.0 | pass |
| 2 views (palm, back) | 0.0 | +1.7 | +28.5 | +56.3 | about 0 | rejected |
| 8 views, mask edge +-2 px | -0.5 | +0.1 | +1.5 | -1.6 | -0.5 to -1.7 | pass |
| 8 views, focal +2 % | -2.9 | -1.6 | +1.5 | -5.3 | -1.5 to -2.8 | pass |
| 8 views, pose 1 deg / 2 mm | -3.6 | -3.0 | -9.0 | -23.2 | -3.6 to -4.3 | rejected |

Surface area (8 clean views) is +2.8 % off the reference and 4 views +8 %. Reconstruction takes about 0.5 to 1.9 s in Node at 1 to 2 mm voxels (8 views, 256 px), about six times slower under load; **no phone or browser worker was timed**.

* **Palm and fingers:** recoverable from silhouettes when views include the palm/back and both profiles (4 views is the minimum that passes in simulation; 2 views fail on thickness).
* **Side surfaces:** recovered from the profile silhouettes (thickness and finger depth), provided their poses are accurate.
* **Finger gaps:** preserved only where a gap is visible as background in at least one silhouette (spread fingers in the palm/back views). **With fingers together the gap is closed in every view and a visual hull fills it** (the segmenter's `fingers_merged` gate exists for this).
* **Concavities:** a visual hull cannot recover them by definition (Laurentini 1994; Cremers and Kolev 2011, from search summaries): the palm hollow, the base of the thumb and grooves between knuckles. So a **circumference is an upper bound or a model estimate**, not a direct measurement, from RGB silhouettes alone.
* **A parametric prior** (our own capsule model) cut the 2-view thickness error from +28.5 to +1.5 mm, but only because its default thickness is near the synthetic truth: it substitutes a population guess for data. MANO-class models are blocked commercially (section 7).

## 6. Measured dimensions versus model-based estimates

Every experimental result carries a `Quantity.basis`: **direct** (geometry of the reconstruction), **model** (needs an assumed axis, landmark-defined plane or prior), **none** (not available, with the reason).

| Dimension | RGB only | With reliable metric depth (not generally available) |
|---|---|---|
| Hand length | **Direct** from mask/hull if the wrist crease is defined by a landmark (the crease is not a silhouette feature: partly *model*) | Direct |
| Palm breadth | **Direct** from the mask at the knuckle row (skin edge to skin edge); a landmark span is a *model* | Direct |
| Finger lengths | *Model* at the base (joint centres) and direct at the tip | Along-surface, direct |
| Hand thickness | **Direct** from a profile silhouette with a valid scale | Direct |
| Projected area | Direct in px; mm² only with a scale valid across the hand (the coin scale holds at the coin plane only) | Same |
| **Circumference** | **Model** (ellipse from breadth and thickness) or hull **upper bound**; the **definition** (open hand or fist) must come from the client | Direct only where the surface is covered all round |
| 3D surface area | *Model* only | Direct only with dense coverage of palm, back, fingers and sides |

`surfaceFromDepth` returns **null with a reason** when no real metric depth map is supplied and **refuses relative or MediaPipe depth**: depth is never invented from 2D coordinates.

## 7. Commercial licences, checked against primary sources

Not legal advice. The product is commercial, so non-commercial and research-only licences are **blockers**. Detail and all sources: `LICENSING.md`.

**Verified by me on 2026-11-07, fetching the primary source in this session**

| Item | Finding | Source |
|---|---|---|
| MediaPipe (code) | Apache-2.0 | github.com/google-ai-edge/mediapipe LICENSE |
| OpenCV (4.x branch) | Apache-2.0 | github.com/opencv/opencv 4.x LICENSE |
| three.js | MIT | github.com/mrdoob/three.js LICENSE |
| Open3D | MIT | github.com/isl-org/Open3D LICENSE |
| COLMAP | New BSD, "may be affected by its dependencies" | github.com/colmap/colmap LICENSE |
| MobileSAM | Code Apache-2.0; weights `dhkim2810/MobileSAM` licence tag MIT | github.com/ChaoningZhang/MobileSAM; huggingface.co/api/models/dhkim2810/MobileSAM |
| SAM 2 | Code Apache-2.0; weights `facebook/sam2.1-hiera-small` and `sam2-hiera-tiny` Apache-2.0 (other checkpoints not checked) | github.com/facebookresearch/sam2; huggingface.co/api/models |
| Depth Anything V2 **Small** | Apache-2.0 (README and Hugging Face agree) | github.com/DepthAnything/Depth-Anything-V2 README |
| Depth Anything V2 Base/Large/Giant | **CC-BY-NC-4.0: blocked** | same README; Hugging Face tag for Base |
| MANO | Non-commercial research only; "incorporation in a commercial product, use in a commercial service" prohibited: **blocked** | mano.is.tue.mpg.de/license.html |
| 3D Gaussian Splatting (Inria) | "THE USER CANNOT USE, EXPLOIT OR DISTRIBUTE THE SOFTWARE FOR COMMERCIAL PURPOSES": **blocked** | github.com/graphdeco-inria/gaussian-splatting LICENSE.md |
| EdgeSAM | S-Lab License 1.0, non-commercial: **blocked** | github.com/chongzhou96/EdgeSAM LICENSE |
| **GrabCut patent** | Google Patents record for US7660463B2 (Microsoft, "Foreground extraction using iterated graph cuts", priority 2004-06-03) shows **"Expired - Fee Related"**, expiry 2026-03-10. Other patents were **not searched**; OpenCV's licence does not grant patent rights; counsel should confirm | patents.google.com/patent/US7660463B2/en |

**Read from primary sources by the research pass (not re-read by me)**: MediaPipe model cards (HandLandmarker, `magic_touch`, multiclass segmenter: Apache-2.0), SAM code/weights wording, FastSAM and OpenMVS (AGPL-3.0: blocked for a closed product), Depth Pro weights (research only), FrankMocap (CC BY-NC), InterHand2.6M (CC BY-NC), HO-3D, DexYCB (CC BY-NC), COCO-WholeBody, instant-ngp, SMPL-X, HaMeR (needs MANO), Nerfstudio, AliceVision (MPL-2.0), OpenMVG (MPL-2.0), Open Images. See `LICENSING.md` for each URL.

**UNVERIFIED (needs legal or vendor confirmation; do not rely on these)**
* Training-data terms of the HandLandmarker and `magic_touch` models; the DeepLab v3, selfie and hair segmenter cards.
* The **contents of the bundled `opencv.js` binary** (which optional modules, and their licences). Its capability list is checked (section 3); its licence composition is not.
* SA-1B dataset licence text, FreiHAND and HGR1 (read only through search summaries), HaGRID (custom licence, share-alike likely), HaGRID mask extensions, EgoHands, GTEA.
* Weights for MiDaS, Depth Anything V1 and the V2 Metric variants, Metric3D, Marigold's model licence (RAIL++-M, use restrictions), ZoeDepth training data.
* ARCore and ARKit SDK terms. The ISO 7250-1, ISO 20685 and EN ISO 21420 texts (paywalled: the exact hand definitions are unread).
* Any patent other than US7660463B2.

**Blocked for commercial use:** MANO, SMPL-X (and HaMeR, which needs MANO), Depth Anything V2 Base/Large/Giant, Depth Pro weights, EdgeSAM, FrankMocap, 3D Gaussian Splatting, instant-ngp, FreiHAND, InterHand2.6M, HO-3D, DexYCB, COCO-WholeBody, HGR1; FastSAM and OpenMVS (AGPL).
**Consequence:** every public 3D-hand dataset checked is non-commercial, so the product needs its **own consented data**, which is also the only valid validation data.

**Clean stack today (subject to notices and the UNVERIFIED items):** MediaPipe HandLandmarker, OpenCV (including GrabCut), three.js, Open3D, COLMAP (offline), MobileSAM and SAM 2 weights, Depth Anything V2 Small as a *relative-depth* research baseline.

## 8. Android and iOS compatibility limits

Detail and sources: `DEVICE_COMPATIBILITY.md` (read 2026-11-07). Nothing was measured on a real phone.

| Capability | Android Chrome | iOS Safari |
|---|---|---|
| Live camera, `getUserMedia` | Yes | Yes |
| `ImageCapture.takePhoto` (full-resolution still) | Yes | **No**: video frames only |
| WebXR AR session | Partial | **No** |
| WebXR `depth-sensing` | Chrome 90+, limited availability | **No** |
| Camera intrinsics from the web | None found | None found |
| Hardware depth (ToF/LiDAR) | Only via WebXR depth on a supported phone | **No** (LiDAR needs a native app) |
| ARCore depth | Over 88 % of active devices support the Depth API (Google, May 2026); documented **best range is 0.5 m to about 5 m**, a hand at 25 to 40 cm is **below** it; **no hand-distance accuracy figure found** | n/a |

* **iPhone web users are RGB-only by construction.** If iPhone depth is required, a native app is a separate product decision.
* The **baseline everywhere is RGB-only**: that is what the product does today.
* Autofocus, exposure and lens choice are optional constraints a browser may ignore; support per phone is unverified. Which lens opens (main, ultra-wide, macro) varies and changes distortion.
* Performance on phones (WASM, WebGL, thermal throttling over a 10 to 30 s scan, two WebGL contexts) is **not measured**: the `?debug` panel now records tracker fps, 3D cost and WebGL events for every test phone.

## 9. Technical architecture and implementation plan

**Architecture (on-device, nothing uploaded by default):**
`camera frames -> hand landmarks (MediaPipe) -> coin + marker detection -> per-view segmentation (GrabCut in a worker) -> quality gates -> camera model + per-view pose (marker PnP) -> silhouette carving -> mesh -> measurement engine (each value tagged direct/model/none) -> viewer + local capture bundle`.
All new code lives in `frontend/src/experimental/` (`segmentation/`, `geometry/`, `reconstruction/`, `depth/`), with a capture prototype outside the production entry points. The production scan, sizing flow and calibration are not touched.

**Phased plan, each phase gated by evidence:**
1. **Decisions from the client** (blocking): the circumference definition (open hand or fist); whether a **printed marker sheet** is acceptable; which phones must work; whether iPhone depth (native app) is in scope; licence budget for a MANO-class model; accuracy targets (the client's to set; this team will not invent them).
2. **Capture prototype and data** (next, isolated): guided four-view capture, hand-and-coin quality checks, per-view stills with all metadata, local export. Collect **consented** controlled captures with physical caliper/tape measurements and hand-traced masks (this is the dataset licensing says we must own).
3. **Segmentation hardening:** tighten the GrabCut gates (small hands, blur), evaluate MobileSAM or SAM 2 as refiners and a small trained model, **on real masks**, with IoU, Dice and boundary error plus phone latency.
4. **Marker and pose:** write the marker detector and sub-pixel refinement, planar self-calibration, measure real pose error; decide capture geometry for the profile views.
5. **Reconstruction on real captures** against calipers: mean absolute error, RMSE, bias, completeness, repeatability, failure rate, processing time and device compatibility, per `VALIDATION_PLAN.md`.
6. **Depth sources** (ARCore, then a native iOS app only if the client needs it), measured against calipers at hand distance.
7. **Gate:** nothing enters the customer sizing flow until phase 5 passes the client's own acceptance criteria. Until then every output is labelled **experimental**.

## What is real, simulated, or not yet measured

| Item | Status |
|---|---|
| Segmentation comparison | **Composite real-hand-pixel scenes** with a known truth; one hand photo; no real ground truth; no phone timing |
| Marker/pose accuracy numbers | **Simulated** |
| Reconstruction and measurement errors | **Simulated** (capsule hand); gates, timings in Node only |
| Resolution, error-budget figures | **Arithmetic from stated assumptions**; not measured |
| Licence verdicts | Primary sources, see section 7; UNVERIFIED items listed |
| Anything on real phones or real people's hands | **Not yet measured** |
