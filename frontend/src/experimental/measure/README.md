# Measurement engine with numeric uncertainty (`measure/`, Stage 5, EXPERIMENTAL)

> **EXPERIMENTAL AND UNVALIDATED.** Not used by the customer app. Every number in this file is **SIMULATED** (rendered
> capsule hand on the printed board, exact masks, Node) or rests on a sigma labelled **ASSUMED**. None of it is a
> real-hand, real-phone or real-print accuracy, and no value has been compared with a physical measurement.

## What it does

Every value the reconstruction reports becomes a `MeasuredValue`:

| field | content |
|---|---|
| `value`, `unit` | millimetres (mm^2 for an area); `null` when withheld |
| `definition` | what is measured and from which datums (landmarks, sections, stations) |
| `method` | how it is computed (which function, which mesh operation) |
| `dataSource` | the views whose silhouettes carved the mesh, the mesh region read, the landmark indices and how they were obtained (triangulated / lifted from one view / given / none) |
| `basis` | `direct` (observed geometry given an exact frame), `model` (rests on landmarks, a model, or a board-bounded surface), `none` (withheld; `basisNote` says why) |
| `upperBound` | the value is an upper bound (visual-hull extents and loops; on a board capture the circumference keeps its "UPPER BOUND" note and basis `model`) |
| `uncertainty` | standard uncertainty `u_c`, expanded `U = 2 u_c` (about 95 % if normal), the interval, one component per input factor (focal, pose, scale, boundary, voxel, landmarks) with its sensitivity rule and the **origin of its input sigma**, the dominant factor, and what the interval excludes |
| `reportingIncrementMm`, `reported` | the smallest defensible reporting step (1-2-5 step at or below `u_c`) and the value rounded to it |

Values: hand length, palm breadth, palm thickness, knuckle circumference, five finger lengths (the existing definitions of
`reconstruction/measure.ts`, unchanged), **finger widths per finger at two stations** (`tip15`: 15 mm proximal to the
fingertip, the caliper protocol's station; `base25`: 25 % of the way from the MCP joint centre to the tip, on the
proximal phalanx, an ASSUMED proportion), surface area.

Withholding (basis `none`, reason given): no hand frame; surface area on a support-bounded capture (palm side not observed);
a width section that is open, holds another finger (merged: no view looked through the gap), has fewer than 3 observed
points, or is not finger-sized (wider than 1.5 x the same finger's `tip15` width or 40 mm: it reaches into the palm, as the
thumb's `base25` station does on the board scene; bounds ASSUMED). No uncertainty is stated (values kept, note given) when
the reconstruction failed its gates (its errors are then not described by the stated sigmas) or there is no scale reference.

## Files and API

| file | what |
|---|---|
| `types.ts` | `CaptureUncertainty` (route-independent input sigmas), `StatedSigma` (`value`, `origin`: SIMULATED / ASSUMED / EXACT / RUNTIME, `source`), `MeasuredValue`, `MeasurementReport` |
| `inputs.ts` | `BOARD_ROUTE_SIMULATED`, `PHONE_BOARD_ASSUMED`, `boardFreeUncertainty({...})` (for the board-free route: the caller must state focal, pose, boundary and landmark sigmas; the coin scale defaults to the SIMULATED coin fit), `boardRouteFromCalibration(cal)` (the capture's own focal covariance when larger than the floor) |
| `definitions.ts` | definition, method, mesh region and landmarks of every value; `WIDTH_STATIONS` |
| `sections.ts` | `fingerTips`, `fingerWidthAt` (labelled sections, merged-finger check; identical to `validation/meshDimensions.ts` at 15 mm, tested), `offsetMesh`, `vertexNormals` |
| `engine.ts` | `measureWithUncertainty(input)`: values, shape sensitivities read on the actual mesh, analytic budget, reporting increment; `extractValues`, `camerasForScale`, `resolutionSummary`, `withMonteCarlo` |
| `monteCarlo.ts` | pipeline-agnostic Monte Carlo: `drawPerturbation`, `runMonteCarlo(cap, nViews, voxel, nominal, runner, {trials, factors})`, `summarise` |
| `boardMc.ts` | the board-route runner: re-runs `multiview/reconstruct.ts` (triangulation, carving, meshing, gates, labels, boardLimits) and the engine's extraction under each perturbation |

**Hook (additive).** `reconstructFromBoardViews` takes a new option `uncertainty?: CaptureUncertainty | null` (default
`BOARD_ROUTE_SIMULATED`; `null` skips) and returns a new optional field `measurementReport`. The existing `measurements`,
`measurementBasis` and every other field are unchanged. When the hand frame was lifted from one view, the 3D landmark sigma
is replaced by `LIFTED_LANDMARK_SIGMA` (3 mm, ASSUMED). `recon/chain.ts` passes `boardRouteFromCalibration(calibration)`
unless the caller gives `uncertainty`. The page is not changed (the field travels with the chain result).

**Board-free input.** Nothing in `CaptureUncertainty` refers to the board: a structure-from-motion route fills
`focalRel` / `poseRotDeg` / `poseCentreMm` from its bundle adjustment, `scaleRel` from the coin fit (`scaleReference:
"coin"`), `maskBoundaryPx` from its segmentation, and passes its table-plane normal as `up` and `supportBounded: true`
when the palm rests on the table. `measureWithUncertainty` needs only a mesh, optional labels, a frame, finger axes, the
existing measurements, the cameras (fx of the carving masks, depth of the hand) and the voxel size.

## Method

**Analytic first-order budget** (fast, shape-aware). For a value V:

| factor | component | sensitivity source |
|---|---|---|
| focal | k \|V\| sigma_f (k = 1 lengths, 2 areas) | closed form; SIMULATED evidence: +2 % focal gives about -2 % on every length (`reconstruction/README.md`) |
| scale | k \|V\| sigma_s | closed form (every length is linear in the scene scale) |
| boundary | \|dV/d offset\| x sigma_b x mm/px (+ station slide for widths) | dV/d offset **read on the mesh**: observed surface offset by +-0.5 mm along the normals and re-measured (support-plane and cut vertices fixed). Lengths: 1 (closed form) |
| pose | \|dV/d offset\| x d_pose / sqrt 2, d_pose = sqrt(2/3) hypot(D theta, C) | first-order misregistration of two independent views; it ignores the hull's shrinkage bias (the Monte Carlo shows it) |
| voxel | \|dV/d offset\| x v / sqrt 12 (/ sqrt 2 for two sides) | ASSUMED rule (uniform quantisation); checked by the voxel-phase Monte Carlo |
| landmarks | hand length, finger lengths: sigma_lm3d; sections: \|dV/dy\| sigma_lm3d / 2 (knuckle line = mean of 4 MCPs; the wrist origin cancels); widths: \|dV/ds\| x the landmark share of the station (0 for `tip15`) | dV/dy and dV/ds **read on the mesh** (section slid +-2 mm) |

`u_c` = root-sum-square of the components; `U = 2 u_c`.

**Monte Carlo through the pipeline** (`monteCarlo.ts` + `boardMc.ts`). Each trial draws a shared focal factor, a shared
scale factor, an independent pose error per view (rotation about the camera centre and centre shift, isotropic, RMS =
the stated sigma), an independent outline offset per view (threshold of the signed distance of the exact mask), landmark
pixel noise (re-projected from the true 3D landmarks, then triangulated by the pipeline), and a random voxel-grid phase;
then re-runs the board reconstruction and the extraction. Statistics are taken against the unperturbed run.
Scale is applied to the outputs exactly (a hull of a scene scaled by s is the hull scaled by s). Not perturbed: the
segmentation itself (its measured boundary error is the input instead), lens distortion, the hand's shape.

## Input sigmas and their origin

| sigma | `BOARD_ROUTE_SIMULATED` | origin and source | `PHONE_BOARD_ASSUMED` | origin and source |
|---|---|---|---|---|
| focal (relative) | 0.10 % | SIMULATED: `recon/chain.test.ts` run in `recon/README.md` (0.096 %, one run); `board/README.md` section 5 (capture-like sets max 0.065 %) | 0.10 % | SIMULATED (same) |
| pose rotation (RMS angle per view) | 0.14 deg | SIMULATED: chain run, max 0.142 deg over 16 views (max used as RMS) | 0.5 deg | SIMULATED: `board/README.md` HARD imaging (blur + motion blur + noise), "up to 0.5 deg" |
| pose centre (RMS per view) | 1.56 mm | SIMULATED: chain run, max 1.56 mm | 3 mm | SIMULATED: `board/README.md` HARD imaging, "up to 3 mm" |
| scale (relative) | 0 | EXACT: the printed board is exact in a rendered scene | 0.74 % | SIMULATED: `board/README.md` section 6, coin print-scale check errors -0.95 / -0.77 / -0.38 % (RMS): how well the coin verifies a 100 % print |
| mask boundary (carving masks) | 0.6 px | SIMULATED: `multiview/segment.test.ts` boundary mean 0.29 to 0.55 px at 640 px; 0.46 / 0.8 (half-normal) | 1.25 px | ASSUMED: no real-photo board segmentation scored; composite GrabCut mean 1.0 px (`segmentation/README.md`) / 0.8 |
| 2D landmarks (Monte Carlo) | 2 px | ASSUMED: the noise the chain test injects; not a MediaPipe measurement | 5 px | ASSUMED: "several pixels" (`multiview/README.md`) |
| 3D landmarks (analytic) | 0.9 mm | SIMULATED: `multiview/landmarks.test.ts`, RMS < 0.7 mm at 1.5 px over 17 views, scaled to 2 px | 2.3 mm | ASSUMED: scaled to 5 px |
| voxel | 1.5 mm | setting; the v / sqrt 12 rule is ASSUMED (checked by the voxel-phase Monte Carlo) | 1.5 mm | same |

A lifted hand frame (landmarks of one view, `hand_frame_from_one_view`) uses 3 mm for the 3D landmarks (ASSUMED). For the
board-free route `boardFreeUncertainty` defaults the coin scale to 0.34 % (SIMULATED, `coin/README.md` multi-view coin fit
baseline with exact poses; 0.3 deg pose noise added a +0.8 % bias that is NOT in that figure).

## SIMULATED results

Scene: `multiview/scene.ts` capsule hand on the board, 17 views at 640 x 360 (the chain's carving size: it halves
1280 x 720), one from 400 mm above and 16 at 12 degrees from 340 mm, hfov 62 deg, k1 0.02; **exact masks**, true poses,
voxel 1.5 mm. Millimetres per carving-mask pixel at the hand: **median 0.651** (0.541 to 0.746). Truth: the capsule's
exact dimensions (finger widths = capsule diameter, constant along the finger; no thumb-width truth: the board clips the
lifted thumb). Monte Carlo statistics are against the unperturbed run, over ALL trials (including gate-rejected ones).
Console output of `RUN_MEASURE_MC=1 npx vitest run --no-file-parallelism src/experimental/measure/boardMc.test.ts`, Node,
2026-11-08, 515 s (vitest printed one "Timeout calling onTaskUpdate" worker warning, because one test blocks the event
loop for minutes, and exited 1 for it; all four tests passed). All values mm.

### Table 1. SIMULATED inputs: analytic budget vs Monte Carlo through the pipeline (30 trials, all factors)

Gate acceptance over the 30 perturbed trials: **63 %** (pose errors trip the reprojection check in the others).
"error" = nominal (exact masks, true poses) minus truth: the method's own bias on this scene.

| value | value | truth | error | analytic u_c | MC sd | MC mean shift | MC 95 % of (value - nominal) | MC rms | increment (analytic) | increment (MC rms) |
|---|---|---|---|---|---|---|---|---|---|---|
| hand length | 177.3 | 177.5 | -0.1 | 1.49 | 0.70 | -0.95 | [-2.39, +0.14] | 1.18 | 1 | 1 |
| palm breadth (hull upper bound) | 85.4 | 85.0 | +0.4 | 2.28 | 1.03 | +0.42 | [-1.50, +2.45] | 1.09 | 2 | 1 |
| palm thickness (hull upper bound) | 25.7 | 24.0 | +1.7 | 1.18 | 0.75 | +0.25 | [-1.18, +1.49] | 0.78 | 1 | 0.5 |
| knuckle circumference (UPPER BOUND, model) | 204.2 | 204.3 | -0.0 | 6.22 | 1.60 | -3.51 | [-5.94, -0.06] | 3.85 | 5 | 2 |
| finger length thumb | 62.2 | 62.5 | -0.3 | 1.48 | 0.62 | -0.92 | [-1.85, +0.30] | 1.10 | 1 | 1 |
| finger length index | 70.8 | 71.0 | -0.2 | 1.49 | 0.76 | -0.22 | [-1.74, +1.07] | 0.78 | 1 | 0.5 |
| finger length middle | 77.4 | 77.5 | -0.1 | 1.49 | 0.59 | -0.88 | [-1.72, +0.12] | 1.06 | 1 | 1 |
| finger length ring | 72.9 | 73.0 | -0.1 | 1.49 | 0.68 | -0.78 | [-1.88, +0.44] | 1.02 | 1 | 1 |
| finger length little | 55.5 | 56.0 | -0.5 | 1.48 | 0.78 | -0.01 | [-1.54, +1.34] | 0.77 | 1 | 0.5 |
| width thumb tip15 | 22.2 | - | - | 2.17 | 0.92 | -0.96 | [-2.84, +0.58] | 1.32 | 2 | 1 |
| width thumb base25 | withheld | | | | | | not finger-sized: the section is the palm | | | |
| width index tip15 | 18.0 | 18.0 | +0.0 | 2.19 | 0.99 | -0.78 | [-2.67, +0.87] | 1.24 | 2 | 1 |
| width index base25 | 18.3 | 18.0 | +0.3 | 2.27 | 0.62 | -0.02 | [-1.08, +1.12] | 0.61 | 2 | 0.5 |
| width middle tip15 | 19.5 | 19.0 | +0.5 | 2.28 | 0.90 | -1.44 | [-3.46, +0.08] | 1.69 | 2 | 1 |
| width middle base25 | 19.3 | 19.0 | +0.3 | 2.24 | 0.51 | +0.29 | [-0.72, +1.23] | 0.58 | 2 | 0.5 |
| width ring tip15 | 18.2 | 18.0 | +0.2 | 2.44 | 0.70 | -0.49 | [-1.87, +0.91] | 0.85 | 2 | 0.5 |
| width ring base25 | 18.5 | 18.0 | +0.5 | 2.24 | 0.62 | +0.50 | [-0.73, +1.37] | 0.78 | 2 | 0.5 |
| width little tip15 | 15.9 | 16.0 | -0.1 | 2.27 | 0.92 | +0.11 | [-2.00, +1.78] | 0.91 | 2 | 0.5 |
| width little base25 | 16.8 | 16.0 | +0.8 | 2.24 | 0.82 | +0.34 | [-1.00, +1.89] | 0.88 | 2 | 0.5 |
| surface area | withheld | | | | | | palm side on the board, not observed | | | |

### Table 2. SIMULATED inputs, one factor at a time: analytic component / MC sd (MC mean shift), 10 trials each

Scale is EXACT (0) in this set. Gate acceptance: focal, boundary, landmarks, voxel 100 %; pose 80 %. Ten trials give an
sd to about +-25 %; the rows not shown are in the console output.

| value | focal | pose | boundary | landmarks | voxel |
|---|---|---|---|---|---|
| hand length | 0.18 / 0.12 (+0.07) | 1.03 / 0.45 (-0.90) | 0.39 / 0.47 (-0.40) | 0.90 / 0.36 (+0.02) | 0.43 / 0.26 (-0.22) |
| palm breadth | 0.09 / 0.13 (+0.05) | 2.05 / 0.87 (+0.19) | 0.78 / 0.48 (-0.04) | 0.04 / 0.02 (+0.01) | 0.61 / 0.37 (+0.61) |
| palm thickness | 0.03 / 0.00 (+0.00) | 1.05 / 0.43 (+0.18) | 0.40 / 0.26 (+0.09) | 0.11 / 0.10 (+0.11) | 0.31 / 0.04 (-0.02) |
| knuckle circumference | 0.20 / 0.17 (+0.09) | 5.59 / 1.22 (-3.90) | 2.13 / 0.99 (-1.03) | 0.30 / 0.13 (+0.01) | 1.67 / 0.28 (+0.20) |
| finger length index | 0.07 / 0.18 (+0.21) | 1.03 / 0.43 (-0.62) | 0.39 / 0.41 (-0.24) | 0.90 / 0.28 (-0.04) | 0.43 / 0.14 (+0.10) |
| finger length middle | 0.08 / 0.05 (+0.01) | 1.03 / 0.44 (-0.85) | 0.39 / 0.47 (-0.40) | 0.90 / 0.69 (+0.16) | 0.43 / 0.25 (-0.22) |
| width index tip15 | 0.02 / 0.02 (-0.02) | 1.97 / 1.03 (-1.49) | 0.75 / 0.76 (-0.69) | 0.00 / 0.01 (-0.00) | 0.59 / 0.17 (-0.09) |
| width middle tip15 | 0.02 / 0.00 (+0.00) | 2.05 / 1.03 (-1.70) | 0.78 / 1.17 (-1.09) | 0.00 / 0.00 (-0.00) | 0.61 / 0.37 (-0.80) |
| width ring tip15 | 0.02 / 0.01 (+0.01) | 2.20 / 0.64 (-0.79) | 0.84 / 1.03 (-0.72) | 0.00 / 0.03 (+0.01) | 0.66 / 0.29 (+0.01) |
| width little tip15 | 0.02 / 0.16 (+0.30) | 2.05 / 0.43 (+0.04) | 0.78 / 0.72 (-0.45) | 0.00 / 0.00 (+0.00) | 0.61 / 0.24 (+0.14) |
| width middle base25 | 0.02 / 0.01 (+0.01) | 2.01 / 0.73 (+0.41) | 0.77 / 0.62 (-0.64) | 0.22 / 0.19 (+0.04) | 0.60 / 0.44 (+0.58) |
| width ring base25 | 0.02 / 0.05 (+0.10) | 2.01 / 0.32 (+0.37) | 0.77 / 0.37 (-0.25) | 0.16 / 0.08 (+0.02) | 0.60 / 0.33 (+0.68) |

What the comparison shows (SIMULATED, this scene only):

* **Boundary**: the analytic term (offset gain read on the mesh x 0.6 px x 0.65 mm/px) matches the Monte Carlo sd for
  lengths and widths within the 10-trial scatter (0.39 vs 0.34 to 0.47; 0.75 to 0.84 vs 0.72 to 1.17) and over-states the
  circumference (2.13 vs 0.99: the board half of the loop does not move). The Monte Carlo adds a NEGATIVE shift (-0.2 to
  -1.1 mm): an outline offset per view is not symmetric for an intersection of views (the most inward view wins).
* **Pose**: the analytic term is 2 to 5 times the Monte Carlo sd, but it misses the **bias**: misregistered views carve the
  hull SMALLER (-0.6 to -0.9 mm on lengths, -1.5 to -1.7 mm on two finger widths, -3.9 mm on the circumference); 20 % of
  the pose-only trials were rejected by the gates. The first-order rule is conservative in spread, wrong in centre.
* **Voxel**: the 1 / sqrt 12 rule over-states the spread about 2 times (the blurred iso-surface is sub-voxel), but the grid
  phase shifts some widths by up to +0.7 mm on average.
* **Landmarks**: 0.9 mm analytic against 0.2 to 0.7 mm observed on lengths (2 px injected noise, 17 views); sections and
  widths barely depend on them on a capsule (constant widths along a finger).
* **Focal** (0.1 %): about 0.1 to 0.2 mm, as predicted.
* **Combined**: the analytic u_c (1.5 mm lengths, 2.2 to 2.4 mm widths, 6.2 mm circumference) exceeds the Monte Carlo rms
  deviation (0.8 to 1.2, 0.6 to 1.7, 3.9 mm) for every value: conservative, but the Monte Carlo is NOT centred on the
  nominal value (shifts up to -1.4 mm on a width, -3.5 mm on the circumference). Input errors mostly SHRINK a hull, while
  the hull itself is LARGER than the hand (nominal thickness +1.7 mm): the two biases are not corrected and partly cancel
  only by accident.

### Table 3. ASSUMED phone-condition inputs on the same SIMULATED scene (20 trials, all factors including scale)

**Gate acceptance: 0 of 20.** With 0.5 deg / 3 mm pose errors per view every reconstruction failed the reprojection check:
the board route would REFUSE these captures, and the engine then states no uncertainty (values kept, note given). The
figures are what an ungated pipeline would report (research only):

| value | analytic u_c | MC sd | MC mean shift | MC rms | increment (MC rms) |
|---|---|---|---|---|---|
| hand length | 3.73 | 2.07 | -2.79 | 3.44 | 2 |
| palm breadth | 5.27 | 2.12 | -2.00 | 2.88 | 2 |
| palm thickness | 2.70 | 1.33 | -1.04 | 1.66 | 1 |
| knuckle circumference | 14.33 | 8.05 | -10.71 | 13.27 | 10 |
| finger lengths (5) | 3.52 to 3.54 | 1.49 to 2.67 | -2.65 to -3.88 | 3.30 to 4.50 | 2 |
| finger widths tip15 (5) | 4.98 to 5.60 | 1.98 to 2.85 | -2.76 to -3.66 | 3.75 to 4.31 | 2 |
| finger widths base25 (4) | 5.14 to 5.21 | 1.48 to 2.80 | -0.89 to -2.27 | 1.84 to 3.54 | 1 to 2 |

Analytic components (ASSUMED set): pose dominates every value (2.5 mm lengths, 4.7 to 5.3 mm widths, 13.4 mm
circumference), then the landmarks on lengths (2.3 mm), the scale (1.3 mm on the hand length) and the boundary (0.8 mm on
lengths, 1.6 mm on widths).

## The 0.1 mm question

**Resolution (pixel size at the hand).** The board chain carves on masks halved to 640 px wide: **0.54 to 0.75 mm per
pixel** at the hand in the simulated rig (median 0.65). At the full 1280 px it would be about 0.33 mm/px; 0.1 mm/px needs
roughly 10 to 26 MP stills (`geometry/resolution.ts`). Pixel size is resolution, not accuracy.

**Rule.** The smallest defensible reporting increment is the 1-2-5 step at or below the standard uncertainty u_c (rounding
to it adds at most step / sqrt 12 <= 0.29 u_c in quadrature). A 0.1 mm increment therefore needs **u_c < 0.2 mm**.

**Evidence (SIMULATED best case: rendered scene, exact masks, board).**

| value | analytic u_c | MC rms | defensible increment |
|---|---|---|---|
| hand length, finger lengths | 1.5 mm | 0.8 to 1.2 mm | **0.5 to 1 mm** |
| palm breadth | 2.3 mm | 1.1 mm | **1 to 2 mm** |
| palm thickness | 1.2 mm | 0.8 mm | **0.5 to 1 mm** |
| knuckle circumference (upper bound) | 6.2 mm | 3.9 mm | **2 to 5 mm** |
| finger widths | 2.2 to 2.4 mm | 0.6 to 1.7 mm | **0.5 to 2 mm** |

Under the ASSUMED phone conditions the increments become 2 mm (lengths, widths) and 10 mm (circumference), and the gates
reject those captures outright.

**Inverse budget** (`boardMc.test.ts`, default suite): the input sigma that ALONE would use a 0.1 mm standard uncertainty,
at 0.651 mm/px (present inputs: focal 0.10 %, boundary 0.6 px, pose displacement 1.45 mm per view, voxel 1.5 mm, 3D
landmarks 0.9 mm). All columns together must fit in 0.2 mm.

| value | u_c now | focal or scale | mask boundary | pose (per-view displacement) | voxel | 3D landmarks |
|---|---|---|---|---|---|---|
| hand length | 1.49 | 0.056 % | 0.15 px (0.10 mm) | 0.14 mm | 0.35 mm | 0.10 mm |
| finger length middle | 1.49 | 0.13 % | 0.15 px (0.10 mm) | 0.14 mm | 0.35 mm | 0.10 mm |
| palm breadth | 2.28 | 0.12 % | 0.08 px (0.05 mm) | 0.07 mm | 0.24 mm | 2.0 mm |
| palm thickness | 1.18 | 0.39 % | 0.15 px (0.10 mm) | 0.14 mm | 0.48 mm | 0.82 mm |
| knuckle circumference | 6.22 | 0.049 % | 0.03 px (0.02 mm) | 0.03 mm | 0.09 mm | 0.30 mm |
| finger width middle tip15 | 2.28 | 0.51 % | 0.08 px (0.05 mm) | 0.07 mm | 0.24 mm | - |
| finger width ring base25 | 2.24 | 0.54 % | 0.08 px (0.05 mm) | 0.07 mm | 0.25 mm | 0.57 mm |

**Conclusion.** **0.1 mm is not defensible for any value** of this engine, even in the clean simulation. It would need
outline errors below about 0.1 px at 640 px (0.2 px at full resolution), pose displacements below about 0.1 mm per view
(about 0.02 deg at 340 mm), a voxel grid near 0.25 mm (216 times the voxels of the 1.5 mm grid), 3D landmark datums to
0.1 mm (a MediaPipe joint centre is a model estimate; its anatomical definition alone differs from a tape's by
millimetres), and a board print or coin scale to about 0.05 %. The defensible increment is **1 mm for lengths and finger
widths (0.5 mm at best in clean simulation), 2 mm for the palm breadth and 5 mm for the knuckle-circumference upper
bound**. These are SIMULATED floors, not real-world figures; a real capture can only be worse until measured. A page may
print more digits only as resolution, never as accuracy.

## Limits

* All figures come from one synthetic capsule hand on a rendered board with exact masks. A capsule has no concavities, no
  skin texture and no soft tissue; its widths are constant along a finger, so the station slopes are near zero and the
  landmark term of the widths is unrealistically small.
* The pose model (independent rotation about the camera centre plus centre shift per view) is a pessimistic stand-in for
  marker PnP errors, which are correlated so the board plane still reprojects well. The chain's own pose errors were not
  re-sampled (one SIMULATED run, maxima used as RMS).
* The boundary model is a uniform offset of each view's outline; real segmentation errors vary along the outline
  (fingertips, shadows, the wrist) and are correlated with skin tone and light.
* The interval covers the stated inputs only: the visual hull's one-sided bias (concavities, unseen gaps), the definition
  gap between landmark datums and anatomical or tape definitions, and soft tissue are NOT in it.
* Every ASSUMED sigma must be replaced by a measurement (phantom study, Stage 6) before any figure here is quoted.

Run: `npx vitest run --no-file-parallelism src/experimental/measure` (default: unit tests, the hook on the board scene, the
inverse budget, a 2-trial Monte Carlo smoke); the full study: `RUN_MEASURE_MC=1 npx vitest run --no-file-parallelism
src/experimental/measure/boardMc.test.ts`.
