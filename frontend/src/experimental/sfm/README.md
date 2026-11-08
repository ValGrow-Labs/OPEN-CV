# EXPERIMENTAL: board-free multi-view camera geometry (`sfm/`), stage 3

> **EXPERIMENTAL, research only, not validated.** Nothing here is used by the customer app, the production scan, the
> coin calibration or the sizing, and nothing here changes a production setting. Every number in this file is
> **SIMULATED**: rendered pictures of the synthetic capsule hand (`multiview/scene.ts`) on procedural table textures,
> without gloss, tone curve, rolling shutter, motion blur or video compression. **None of it is real-world accuracy.**
> No real capture has gone through this code.

Question (stage 3 of `docs/hand3d-research/MASTER_AUDIT.md`): with a phone and one coin (2019 Rs 2, 23.00 mm,
`config/reference_objects.json` `inr_2_2019`) and **no printed board**, can the camera geometry the 3D chain needs
(intrinsics, every camera pose, the support plane, the metric scale) come from the pictures themselves, with the
accuracy the visual hull needs (poses better than about 0.5 degrees, focal length better than 0.5 %, scale better than
0.5 %)?

**Short answer (SIMULATED): yes, but only with a continuous video-like sweep (frames at most about 7.5 degrees apart)
over a richly textured, non-repetitive surface, with the coin fitted jointly in the bundle adjustment and its thickness
known; no with the board capture's 13 to 25 stills (nothing registers), and no on a plain, weakly textured, striped or
repetitive table.** In the best condition the board-free poses match the board route's accuracy and carve the hand to
within 0.4 mm of a carving with the exact poses. Details, numbers and conditions below.

## Files and API

| File | What |
|---|---|
| `sfm.ts` | `runSfm(views, opts): SfmResult`: features (hand excluded), pairwise matching and RANSAC verification, tracks, initial pair (homography decomposition for a planar table, essential matrix otherwise, focal length from the field-of-view prior), incremental registration (P3P + RANSAC + refinement), triangulation, bundle adjustments with focal length and k1/k2 self-calibration, outlier removal, the coin fitted post hoc and jointly. `candidatePairs` (which pairs to match, from the capture guide's approximate directions). |
| `features.ts` | `detectFeatures` (Shi-Tomasi corners, sub-pixel, 2-level pyramid, bucketing, exclusion mask; orientation by intensity centroid or upright), 256-bit BRIEF-style descriptors, `matchFeatures` (Hamming, ratio test, mutual). |
| `geometry.ts` | Camera model (`Cam`: shared f, centred principal point, k1/k2), `undistort`, `projectPx`, normalised 8-point `fundamental8`, `ransacFundamental`, `homographyDLT`, `ransacHomography`, `decomposeHomography`, `bougnouxFocal`, `poseFromEssential` (cheirality), `triangulate`, `p3p` (Grunert), `pnpRansac`, `refinePose`. Written here because the bundled OpenCV.js lacks findFundamentalMat, findEssentialMat, recoverPose, triangulatePoints. |
| `bundle.ts` | `bundleAdjust(problem, opts)`: Levenberg-Marquardt, Huber loss, analytic Jacobians, Schur complement on the points, dense Cholesky on the cameras; shared f, k1, k2; optional **joint coin**: the coin's 3D circle (centre, normal, log radius) as six more parameters and its outline edge points as residuals (`coin/sceneScale.ts` `outlineResiduals`, cylinder model: top and bottom rim). |
| `frame.ts` | `fitPlaneRansac` (table plane), `makeTableFrame` / `poseToTable` (metric table frame: z = 0 on the table, +z to the cameras, millimetres from the coin, in-plane axes from the triangulated wrist and middle-knuckle landmarks, the board frame's convention so `multiview/reconstruct.ts` can carve with it), `triangulatePixels`, `similarityAlign`, `rigidOnly`, `poseErrors` (evaluation). |
| `mat.ts` | Small dense linear algebra (3x3 SVD, null vectors, Cholesky, Rodrigues, polynomial roots). |
| `scene.ts`, `textures.ts`, `coinEdges.ts` | Test support: the hand on a table with no board (own renderer; imports the capsule hand, placement, landmarks and camera rig of `multiview/scene.ts`, which is not edited), seeded procedural textures (speckle, wood, fabric/plaid, newspaper, weak, plain) anti-aliased with ray differentials, the coin (beside the hand, beyond the fingertips, or on the back of the hand), and the coin outline edge points (from the renderer's coin label, standing in for the coin detector; partly hidden coins rejected). |
| `evaluate.ts` | `runCondition` (render, SfM, table frame, errors against the truth), `carveWithPoses` (the existing carving with the board-free poses), `RenderCache`, table rows. |
| `geometry.test.ts`, `matching.test.ts` | Default suite (about 10 s): exact synthetic correspondences (F, H, P3P, triangulation, Bougnoux, bundle adjustment of a planar ring scene, joint coin) and the matching-distance test on three renders. |
| `e2e.test.ts` | Opt in (`RUN_SFM_E2E=1`, a few minutes): one full board-free run with assertions. |
| `grid.test.ts` | Opt in (`RUN_SFM_GRID=all` or a list of blocks: `match, board, carve, thick, noise, hand, coin, fov, step, sweep, stills`; `SFM_RENDER_CACHE=<dir>` keeps renders on disk, about 12 MB each). Prints the tables below. |

```powershell
cd C:\Users\pc\Downloads\OPEN-CV\frontend
npx vitest run --no-file-parallelism src/experimental/sfm                      # default: ~10 s
$env:RUN_SFM_E2E = "1"; npx vitest run --no-file-parallelism src/experimental/sfm/e2e.test.ts
$env:RUN_SFM_GRID = "all"; npx vitest run --no-file-parallelism src/experimental/sfm/grid.test.ts   # ~1 h
```

## The simulated capture

Same camera path and camera as the board capture (`multiview/scene.ts` `boardRig`): 1280 x 720, horizontal field of
view 64 degrees unless stated (55 and 78 tried), k1 = -0.06, k2 = 0.02 (unknown to the SfM), one top view at 400 mm, a
low ring at 12 degrees at 340 mm, optionally a ring at 35 degrees. No board: the hand rests on a table; the coin (23.00 x
1.5 mm; **the thickness is UNVERIFIED**, not in the settings) lies flat on the table beside the palm unless stated.
Blur 0.7 px and noise 2.5 grey levels unless stated. Landmarks for the table frame: the synthetic 21 landmarks projected
with 2 px noise (a MediaPipe stand-in, as `recon/chain.test.ts`).

Two capture kinds are compared:
* **stills**: exactly the board capture's pictures (13 = top + 12 low, 17 = top + 16 low, 25 = + 8 at 35 degrees);
* **sweep**: what a slow video pass would give: low-ring frames every 7.5 degrees (48 frames; 5, 10, 15 tried) plus an
  arc of 8 frames from the ring up to the top view (elevations 18, 24, 30, 36, 45, 55, 65, 75 at one azimuth) and the
  top view; 57 frames. The 13 or 17 stills are among its frames and are what the carving uses.

The SfM is told nothing about the camera except a field-of-view prior (67.5 degrees, the middle of the production
assumption 55 to 80) for the first two views, and, to choose which pairs to match, the approximate direction the capture
guide asked for (elevation and azimuth sector), which a guided capture knows.

## Results (all SIMULATED)

Column meanings: **registered** views (and "(refused)" when fewer than 90 % registered, see below); **rms px** the final
bundle-adjustment reprojection RMS; **focal err** the self-calibrated focal length against the true one; **k1** estimated
(true); **sim** columns: per-view rotation and camera-centre errors after a 7-dof similarity alignment of the camera
centres with the truth (the up-to-scale quality); **plane deg**: the fitted table plane's normal against the true one
after that alignment; **scale err**: the coin's millimetres-per-unit against the similarity's scale, post hoc
(`coin/sceneScale.ts` `fitCoinCircle3D` on the final SfM poses) and joint (coin inside the bundle adjustment); **metric,
rigid**: the metric poses (coin scale) after a 6-dof rigid alignment (no scale: a scale error shows up); **table frame**:
the metric poses in the table frame built from the SfM alone (plane fit, coin scale, wrist and middle-knuckle landmarks)
against the truth with NO alignment, which is what the carving receives; **time**: the SfM (features to final bundle
adjustment and coin), desktop Node.js, renders excluded.

### 1. Matching: how far apart two views can be (grid block `match`; the default `matching.test.ts` checks 5 vs 30 degrees)

Correct = the matched corner's table point, reprojected with the true cameras, lands within 3 px of the match.

| from | to | change | matches | geometrically correct |
|---|---|---|---|---|
| 12 deg, az 0 | 12 deg, az 5 | azimuth 5 deg | 1027 | 978 |
| 12 deg, az 0 | 12 deg, az 7.5 | azimuth 7.5 deg | 523 | 430 |
| 12 deg, az 0 | 12 deg, az 10 | azimuth 10 deg | 255 | 124 |
| 12 deg, az 0 | 12 deg, az 15 | azimuth 15 deg | 152 | 13 |
| 12 deg, az 0 | 12 deg, az 22.5 | azimuth 22.5 deg | 152 | 2 |
| 12 deg, az 0 | 12 deg, az 30 | azimuth 30 deg | 141 | 0 |
| 35 deg, az 0 | 35 deg, az 10 | azimuth 10 deg | 1245 | 1195 |
| 35 deg, az 0 | 35 deg, az 15 | azimuth 15 deg | 387 | 273 |
| 35 deg, az 0 | 35 deg, az 20 | azimuth 20 deg | 211 | 49 |
| 35 deg, az 0 | 35 deg, az 30 | azimuth 30 deg | 164 | 1 |
| 12 deg, az 0 | 18 deg, az 0 | elevation 6 deg | 353 | 264 |
| 12 deg, az 0 | 20 deg, az 0 | elevation 8 deg | 203 | 83 |
| 12 deg, az 0 | 25 deg, az 0 | elevation 13 deg | 141 | 12 |
| 20 deg, az 0 | 35 deg, az 0 | elevation 15 deg | 265 | 130 |
| 35 deg, az 0 | 50 deg, az 0 | elevation 15 deg | 889 | 812 |
| 50 deg, az 0 | 65 deg, az 0 | elevation 15 deg | 1410 | 1363 |
| 65 deg, az 0 | 90 deg, az 0 | elevation 25 deg | 973 | 904 |
| 75 deg, az 0 | 90 deg, az 0 | elevation 15 deg | 1215 | 1161 |

At 12 degrees the table is seen nearly edge-on: turning 15 degrees round the hand shears its foreshortened texture far
beyond what a corner descriptor tolerates. The board capture's stills are 22.5 to 30 degrees apart: **no** correct
matches. The marker board does not have this problem because its markers are decoded, not matched.

### 2. Stills only: the board capture's pictures without the board (grid block `stills`)

| texture | capture (views) | registered | result |
|---|---|---|---|
| speckle, newspaper, wood | 13, 17, 25 stills | 0 in every case | no pair verified (failure `no_matches` or `too_few_views_registered`) |

All nine runs (times 4.7 to 17 s) registered nothing. **The board capture's pictures cannot be reused board-free.**

### 3. Continuous sweep, by table texture (grid block `sweep`)

| texture | capture (views) | hand feats | coin | blur | noise | registered | rms px | focal err | k1 (true) | rot max deg (sim) | centre max mm (sim) | plane deg | scale err post-hoc | scale err joint | rot max deg (metric, rigid) | centre max mm (metric, rigid) | rot max deg (table frame) | centre max mm (table frame) | time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| speckle | sweep 7.5 deg (57) | out | table-side | 0.7 | 2.5 | 57/57 | 0.56 | +0.13 % | -0.058 (-0.06) | 0.103 | 0.68 | 0.036 | +0.19 % | +0.11 % | 0.103 | 0.95 | 0.273 | 1.85 | 35.0 |
| newspaper | sweep 7.5 deg (57) | out | table-side | 0.7 | 2.5 | 57/57 | 0.65 | +0.09 % | -0.051 (-0.06) | 0.471 | 2.32 | 0.047 | +0.43 % | +0.26 % | 0.471 | 3.05 | 0.697 | 5.02 | 33.3 |
| wood | sweep 7.5 deg (57) | out | table-side | 0.7 | 2.5 | 8/57 (refused) | 0.71 | -0.53 % | -0.011 (-0.06) | 1.794 | 0.69 | 1.044 | +0.09 % | -0.10 % | 1.794 | 0.70 | 0.505 | 2.92 | 22.9 |
| fabric | sweep 7.5 deg (57) | out | table-side | 0.7 | 2.5 | 10/57 (refused) | 0.40 | +0.56 % | -0.052 (-0.06) | 16.662 | 38.42 | 12.802 | -2.02 % | -2.02 % | 16.662 | 40.68 | 1.105 | 57.42 | 28.2 |
| weak | sweep 7.5 deg (57) | out | table-side | 0.7 | 2.5 | 0/57 (failed) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | 21.0 |
| plain | sweep 7.5 deg (57) | out | table-side | 0.7 | 2.5 | 0/57 (failed) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | 21.0 |

(The "(refused)" / "(failed)" marks were added by the refusal rule introduced after this run: fewer than 90 % of the views
registered; the numbers are the run's.) Note the plaid cloth: 10 views registered with a **low RMS (0.40 px) but a false
geometry** (16.7 degrees, 38 mm off): a repetitive pattern can produce a self-consistent wrong reconstruction. Wood grain
(stripes along one direction) registers only the top and the arc. A weakly textured or plain table gives nothing.

### 4. Sweep frame spacing (grid block `step`, speckle)

| texture | capture (views) | registered | rms px | focal err | k1 (true) | rot max deg (sim) | centre max mm (sim) | plane deg | scale err post-hoc | scale err joint | rot max deg (metric, rigid) | centre max mm (metric, rigid) | rot max deg (table frame) | centre max mm (table frame) | time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| speckle | sweep 5 deg (81) | 81/81 | 0.72 | -0.11 % | -0.056 (-0.06) | 0.123 | 0.95 | 0.008 | +0.04 % | -0.04 % | 0.123 | 0.96 | 0.139 | 0.98 | 43.5 |
| speckle | sweep 7.5 deg (57) | 57/57 | 0.56 | +0.13 % | -0.058 (-0.06) | 0.103 | 0.68 | 0.036 | +0.19 % | +0.11 % | 0.103 | 0.95 | 0.273 | 1.85 | 35.0 |
| speckle | sweep 10 deg (45) | 26/45 (refused) | 0.59 | +0.42 % | -0.067 (-0.06) | 0.636 | 3.38 | 0.186 | +1.59 % | +0.70 % | 0.636 | 3.40 | 0.686 | 3.89 | 26.3 |
| speckle | sweep 15 deg (33) | 10/33 (refused) | 0.59 | +0.43 % | -0.065 (-0.06) | 0.142 | 0.29 | 0.085 | +0.52 % | +0.52 % | 0.142 | 1.62 | 0.531 | 3.78 | 19.7 |

### 5. Blur, noise, hand features, coin, field of view (speckle sweep 7.5 degrees unless stated)

| variant | registered | rms px | focal err | k1 (true) | rot max deg (sim) | centre max mm (sim) | plane deg | scale err post-hoc | scale err joint | rot max deg (metric, rigid) | centre max mm (metric, rigid) | rot max deg (table frame) | centre max mm (table frame) | time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline (blur 0.7 px, noise 2.5) | 57/57 | 0.56 | +0.13 % | -0.058 (-0.06) | 0.103 | 0.68 | 0.036 | +0.19 % | +0.11 % | 0.103 | 0.95 | 0.273 | 1.85 | 35.0 |
| blur 1.5 px | 57/57 | 0.59 | +0.13 % | -0.057 (-0.06) | 0.244 | 1.22 | 0.013 | +0.11 % | +0.05 % | 0.244 | 1.20 | 0.292 | 2.14 | 23.9 |
| blur 2.5 px | 57/57 | 0.64 | +0.23 % | -0.057 (-0.06) | 0.300 | 1.13 | 0.015 | +0.17 % | +0.14 % | 0.300 | 1.35 | 0.264 | 2.13 | 23.8 |
| noise 6 | 57/57 | 0.56 | +0.10 % | -0.060 (-0.06) | 0.235 | 1.21 | 0.041 | +0.17 % | +0.10 % | 0.235 | 1.20 | 0.366 | 1.88 | 25.9 |
| noise 12 | 57/57 | 0.58 | +0.09 % | -0.062 (-0.06) | 0.201 | 1.29 | 0.015 | +0.24 % | +0.03 % | 0.201 | 1.26 | 0.294 | 1.84 | 28.1 |
| newspaper, blur 1.5 px | 57/57 | 0.69 | -0.24 % | -0.060 (-0.06) | 0.446 | 2.32 | 0.016 | -0.77 % | -0.22 % | 0.446 | 3.04 | 0.558 | 3.97 | 24.7 |
| hand features INCLUDED (still hand) | 57/57 | 0.59 | +0.23 % | -0.061 (-0.06) | 0.208 | 0.89 | 0.033 | +0.25 % | +0.19 % | 0.208 | 1.34 | 0.285 | 1.88 | 24.4 |
| weak texture, hand features included | 0/57 (failed) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | 14.7 |
| coin beyond the fingertips | 57/57 | 0.56 | +0.11 % | -0.059 (-0.06) | 0.133 | 1.00 | 0.037 | +0.22 % | +0.02 % | 0.133 | 1.04 | 0.260 | 1.62 | 24.4 |
| coin on the back of the hand | 57/57 | 0.56 | +0.05 % | -0.059 (-0.06) | 0.090 | 0.48 | 0.019 | +0.32 % | +0.03 % | 0.090 | 0.52 | 0.237 | 1.59 | 24.9 |
| coin edges + 0.5 px noise | 57/57 | 0.56 | +0.10 % | -0.058 (-0.06) | 0.099 | 0.70 | 0.040 | +0.26 % | +0.19 % | 0.099 | 1.20 | 0.273 | 1.98 | 24.8 |
| field of view 55 deg (prior 67.5) | 57/57 | 0.55 | -0.06 % | -0.058 (-0.06) | 0.121 | 0.69 | 0.009 | -0.07 % | -0.13 % | 0.121 | 0.85 | 0.240 | 1.75 | 24.4 |
| field of view 78 deg (prior 67.5) | 57/57 | 0.56 | +0.22 % | -0.063 (-0.06) | 0.191 | 0.80 | 0.018 | +0.37 % | +0.03 % | 0.191 | 0.76 | 0.422 | 2.60 | 24.0 |
| stronger distortion k1 -0.12, k2 0.04 | 57/57 | 0.56 | -0.00 % | -0.117 (-0.12) | 0.311 | 1.16 | 0.011 | +0.17 % | +0.06 % | 0.311 | 1.14 | 0.260 | 1.65 | 24.3 |
| coin thickness ASSUMED 1.0 mm (rendered 1.5) | 57/57 | 0.56 | +0.16 % | -0.057 (-0.06) | 0.253 | 1.35 | 0.026 | -1.51 % | -1.47 % | 0.253 | 5.92 | 0.381 | 7.26 | 256.8 |
| coin thickness ASSUMED 2.0 mm (rendered 1.5) | 57/57 | 0.56 | +0.08 % | -0.059 (-0.06) | 0.251 | 1.40 | 0.056 | +2.09 % | +1.89 % | 0.251 | 7.06 | 0.428 | 8.80 | 254.1 |

The two thickness rows come from a later run (grid block `thick`) on a busier machine (hence the times). **A 0.5 mm
error in the assumed coin thickness moves the scale by -1.5 % / +1.9 %**: the low views see the coin's wall, which the
cylinder model places from the thickness. The Rs 2 coin's thickness is UNVERIFIED (not in the settings): it must be
measured (to about 0.1 mm for 0.3 %) or the scale must come only from views steep enough to hide the wall.

In the coin-on-the-hand case the hand does not move; a real hand would carry the coin with it if it moved (the coin
then no longer belongs to the rigid table scene).

### 6. The coin: post hoc vs joint (the coordinator's question)

* Synthetic tracks (`geometry.test.ts`, 12 views, 0.4 px feature noise, 0.3 px edge noise): a post-hoc fit on poses
  perturbed by about 0.3 degrees / 1 mm gave **+1.05 %** (the coin stage's finding: pose error biases the scale and is
  not in the fit's own uncertainty); after a bundle adjustment of the features the post-hoc fit gave **+0.054 %**, the
  joint fit **+0.054 %**. With good SfM poses the two agree; the bias came from the poses, not from fitting post hoc.
* Rendered sweeps (tables above, SfM's own poses, the coin thickness right): post hoc **-0.77 to +0.43 %**, joint
  **-0.22 to +0.26 %** over every accepted run; joint was the smaller error in 13 of the 15 accepted runs of the first grid (one tie, 5-degree sweep +0.04 / -0.04 %; one worse, field of view 55: -0.07 / -0.13 %). The joint fit also refines the poses toward one
  consistent circle. **Use the joint fit.** The scale's error budget must include the coin thickness (next table) and the
  coin detector's real edge error (not modelled: the edges here are the renderer's labels).

### 7. Carving the 17 stills with the board-free poses (grid block `carve`; best condition: speckle sweep 7.5 degrees)

Exact hand masks (the board segmentation needs the board), landmarks with 2 px noise, voxel 1.5 mm, half resolution,
the carving volume built from the landmarks triangulated with the given poses. Measured minus true, mm.

| poses | gates passed | length | breadth | thickness | knuckle circ. (upper bound) | fingers T / I / M / R / L |
|---|---|---|---|---|---|---|
| truth: exact poses and intrinsics | yes [] | -0.1 | +1.3 | +1.8 | +0.3 | -0.3 / -0.4 / -0.4 / +0.2 / -0.2 |
| SfM + coin, joint bundle adjustment | no [reprojection_mismatch] | -0.1 | +1.3 | +1.7 | +0.5 | -0.3 / -0.6 / -0.4 / +0.2 / +0.2 |
| SfM + coin, post-hoc coin fit | no [reprojection_mismatch] | -0.0 | +1.4 | +1.7 | +0.7 | -0.2 / -0.2 / -0.4 / +0.2 / +0.5 |
| SfM + coin (joint), frame rigidly aligned to the truth | yes [] | -0.1 | +1.3 | +1.6 | +0.6 | -0.4 / -0.4 / -0.4 / +0.3 / -0.1 |

Reprojection IoU per view (the gate needs mean >= 0.9 and min >= 0.8): the one view looking along the forearm is
0.813 with the exact poses, **0.791** with the board-free poses and 0.807 with the board-free poses in the true frame. The
table frame built from the landmarks is off by 0.18 degrees of yaw and 0.45 mm (`table frame vs truth` line of the
block): the forearm cut face (the volume's -x face) is placed by that frame, and in the view along the arm a small turn of
it moves the forearm-cut boundary. **The joint-fit poses carve the hand as well as the exact poses (every measurement
within 0.4 mm of the exact-pose carving; post-hoc poses within 0.9 mm); the gate failure is the frame definition, a
stage 4 item.**

### 8. Comparison with the board route on the same camera path (grid block `board`, `recon/chain.ts` `camerasFromMarkers`)

| route | capture | registered | focal err | k1 (true -0.06) | rot max deg | centre max mm | scale | time s |
|---|---|---|---|---|---|---|---|---|
| board | 13 stills, hfov 64 | 13/13 | 0.299 % | -0.095 | 0.204 | 1.88 | the printed board (assumed printed at 100 %) | 0.5 (detect + calibrate + pose) |
| board | 17 stills, hfov 64 | 16/17 | 0.096 % | -0.063 | 0.142 | 1.56 | board | 0.4 |
| board | 25 stills, hfov 64 | 24/25 | 0.027 % | -0.062 | 0.149 | 1.46 | board | 0.5 |
| board | 17 stills, hfov 55 | 17/17 | 0.121 % | -0.066 | 0.127 | 1.34 | board | 0.3 |
| board | 17 stills, hfov 78 | 16/17 | 0.189 % | -0.070 | 0.201 | 2.05 | board | 0.3 |
| SfM + coin | 13 / 17 / 25 stills, any texture | 0 | n/a | n/a | n/a | n/a | n/a | 5 to 17 |
| SfM + coin | speckle sweep 7.5 deg, 57 frames | 57/57 | +0.13 % | -0.058 | 0.273 (table frame; 0.103 rigid) | 1.85 (table frame; 0.95 rigid) | coin, joint: +0.11 % | 35 |
| SfM + coin | speckle sweep 5 deg, 81 frames | 81/81 | -0.11 % | -0.056 | 0.139 (table frame; 0.123 rigid) | 0.98 (table frame; 0.96 rigid) | coin, joint: -0.04 % | 43.5 |
| SfM + coin | newspaper sweep 7.5 deg | 57/57 | +0.09 % | -0.051 | 0.697 (table frame; 0.471 rigid) | 5.02 (3.05 rigid) | coin, joint: +0.26 % | 33 |

The board route's errors are against the board frame, which is the truth frame, so they compare with the "table
frame" column. On a speckled surface with a dense sweep the board-free geometry is as good as the board's (SIMULATED);
on the board-capture stills it does not exist.

### Other findings

* **Focal length from two views is not available here.** Bougnoux's formula is degenerate when the optical axes meet
  (every camera of this capture aims at the hand): 114 instead of 1000 in `geometry.test.ts` (1000.0 once the axes are 8
  degrees apart). And with the hand excluded the matched points lie on one plane, where the fundamental matrix is not
  determined at all: the initial pair is decomposed from a homography with the field-of-view prior. The focal length is
  then self-calibrated by the bundle adjustment from the whole sweep (a ring round a point on a plane determines it:
  synthetic planar ring, 8 % wrong start, recovered to 0.015 % in `geometry.test.ts`; rendered: -0.11 to +0.23 % over
  every accepted speckle run, priors 55 to 78 degrees all converging from 67.5).
* **Hand features**: with a still hand, including them changes little (focal +0.23 % vs +0.13 %, rotation 0.21 vs 0.10
  degrees) and does not rescue a weak table (0/57). A real hand moves: exclude it.
* **Time** (desktop Node.js, shared machine, renders excluded): 24 to 35 s for 57 frames, 43.5 s for 81 (181 to 257 s for the
  same work when the shared machine was busy). Split from the e2e test (57 frames, 1280 x 720): features 13.5 s, matching 6.1 s, initial
  pair 0.1 s, incremental registration 3.1 s, final bundle adjustments 1.8 s, coin fits 0.6 s; total 25.2 s; 13 409 points;
  the fitted table plane 0.03 mm from the true one at the hand; the coin seen whole in 25 frames. Phones are several
  times slower; not measured.
* **Rendered plane**: table plane normal within 0.008 to 0.056 degrees of the truth over the accepted runs.

## Go / no-go

Requirements: poses better than 0.5 degrees (the visual hull's gates fail beyond, `multiview/README.md`), focal length
better than 0.5 % (a shared focal error passes every gate yet scales every length, `reconstruction/README.md`), scale
better than 0.5 %.

**GO for stage 4, conditionally (SIMULATED evidence only).** Board-free geometry met all three requirements, in the
table frame the carving receives, when ALL of these held:

| condition | evidence (SIMULATED) |
|---|---|
| a **continuous sweep**: low-ring frames at most **7.5 degrees** apart (5 is better) and an arc of frames up to the top view, about 57 to 81 frames | 7.5 deg: 57/57, focal +0.13 %, rotation 0.27 deg (table frame), scale +0.11 %; 5 deg: 81/81, -0.11 %, 0.14 deg, -0.04 %; 10 deg: 26/45 refused; 15 deg: 10/33 refused; stills (13, 17, 25): 0 registered |
| a **richly textured, non-repetitive surface** under and around the hand (granite-like speckle, a random-pattern mat) | speckle: every variant accepted, rotation <= 0.43 deg (table frame), focal -0.11 to +0.23 %; newspaper: registered but 0.56 to 0.70 deg in the table frame (fails); wood grain 8/57, plaid cloth 10/57 with a FALSE geometry, weak and plain: 0 |
| the **coin flat and fully visible** in many frames (on the table beside the hand, beyond the fingertips, or on the back of a still hand), fitted **jointly** in the bundle adjustment | joint scale -0.13 to +0.19 % on the speckle sweeps (with the right thickness) |
| the coin's **thickness known** to about 0.1 mm | a 0.5 mm error gives -1.5 % / +1.9 % scale: currently UNVERIFIED, so this condition is NOT met today |
| ordinary blur and noise | blur up to 2.5 px, noise up to 12 grey levels: all accepted, rotation <= 0.37 deg (table frame) |
| the focal length unknown within the production range | hfov 55 and 78 from a 67.5 prior: -0.06 % and +0.22 % |

**NO-GO** (refuse, never measure) for: the board capture's stills reused without the board (0 registered on every
texture), frames more than about 7.5 degrees apart on the low ring, plain or weakly textured tables (0 registered, with
or without features on the hand), striped or repetitive surfaces (wood grain, plaid cloth, and newsprint is marginal),
and an unverified coin thickness (the scale cannot be trusted to better than about 1.5 %). The code refuses a run with
fewer than 90 % of the frames registered (`SfmResult.accepted`): in the grid every partial registration was also wrong,
one of them (plaid) with a low reprojection RMS, so a low RMS alone is not a safe acceptance test.

Capture rules this implies (to be validated on real phones, which this study did not do):
1. Put a **textured, non-repetitive mat** under the hand (a printed random-speckle sheet would do; it is not a
   calibration board: nothing on it is measured, it only has to be textured and flat). A plain table or a newspaper is
   not enough on this evidence.
2. Record a **slow continuous video sweep** (frames used every 7.5 degrees or less),
   low round the hand, then up an arc to straight above; not a handful of stills.
3. The **coin flat on the mat** beside the hand, never hidden by the hand in many frames, near the middle of the picture;
   its thickness from an official source or measured.
4. The **hand still** throughout (features on the hand are excluded anyway; a moving hand breaks the carving).
5. Lock focus and zoom if the browser allows (the model assumes one focal length for every frame).

What stage 4 still needs before any of this is a measurement: board-free segmentation (the carving here used exact
masks), a better definition of the forearm cut than two landmarks (the carving gate failed by 0.01 IoU in the view along
the arm because of the frame's 0.18 degree yaw), a video pipeline on the phone (frame selection, tracking, timing), and
real captures with physical references.

## Limitations

* Everything is SIMULATED: Lambertian procedural textures, a capsule hand, a perfectly flat rigid table, a still hand, a
  global-shutter pinhole camera with exactly radial k1/k2 distortion and a centred principal point, no motion blur, no
  video compression, no auto-exposure or auto-focus changes (a focus change changes the focal length between frames,
  which this model does not allow). Real tables are not flat everywhere, real cloth moves, real video frames are
  compressed and motion-blurred, and phones refocus. None of that is tested.
* The coin outline comes from the renderer's labels (+-0.5 px quantisation), not from the coin detector
  (`coin/measureCoin.ts` needs OpenCV.js and is another stage); partly hidden coins are rejected as a detector would.
* The carving uses the EXACT hand masks: the existing segmentation (`multiview/segment.ts`) needs the printed board.
  Board-free segmentation is stage 2a / 4.
* The table frame's in-plane axes come from two triangulated landmarks; that frame definition (not the poses) is what
  fails the carving's reprojection gate in the one view along the forearm (see the carving table). Stage 4 must define the
  forearm cut better (more landmarks, or the forearm's own silhouette).
* Feature tracking is descriptor matching between frames; a real video pipeline would track (KLT) between consecutive
  frames, which tolerates even less motion per frame but is cheaper.
* Timings are desktop Node.js on a shared machine (renders excluded); phones are several times slower. Nothing was run
  on a phone.
