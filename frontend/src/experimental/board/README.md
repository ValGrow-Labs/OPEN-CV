# Printed marker board: camera geometry for the multi-view hand reconstruction (EXPERIMENTAL)

Isolated research code. Nothing in the customer flow, the production scan, the coin calibration (`config/`) or
`vision/` imports this folder, and nothing here changes a production setting. **Every number in the results section is
SIMULATED**: it comes from rendered images with known truth (`render.ts`) and says nothing about real phones, real
lenses, real prints or real coins. No real photo has been through this code yet.

Why the board exists: a coin alone gives a scale but no camera pose (one circle leaves the tilt sign and the in-plane
rotation undetermined; `docs/hand3d-research/CONSOLIDATED_FINDINGS.md` section 3), and the bundled OpenCV.js has no
`aruco`, `findChessboardCorners`, `cornerSubPix` or `calibrateCamera`. A printed sheet with known square markers gives a
camera pose per view in one shared world frame, and several views of it give the camera's focal length and lens
distortion. The capture it serves: the hand rests palm-down on the sheet; one view from straight above, then a LOW ring
of views all round the hand (about 10 to 15 degrees above the sheet), optionally a second ring at 30 to 40 degrees. A
simulation (`reconstruction/captureGeometry.test.ts`) showed the low ring is required to bound the hand's thickness, so
**marker detection at grazing angles is the make-or-break requirement**.

## The board (`spec.ts`, `dictionary.ts`, `svg.ts`)

* A4 landscape (297 x 210 mm), 16 square markers of 30 mm: 7 along the top edge, 7 along the bottom edge, 2 on the
  right edge. The left short edge is open so the forearm can come onto the sheet. 8 mm print margin, 10 mm gaps.
* Each marker is 6 x 6 cells of 5 mm: a one-cell black border round 4 x 4 data bits (1 = white). The codes are this
  project's own dictionary (every code at least 4 bits from its own rotations, every pair at least 5 bits apart under
  every rotation, so up to 2 misread bits are corrected).
* Board frame (millimetres, right-handed): origin at the bottom-left corner of the printed page, +x to the right along
  the long edge, +y up the page, +z out of the paper. A hand on the board has z > 0. This is the world frame of every
  pose and reconstruction made with the board.
* Corner order everywhere: top-left, top-right, bottom-right, bottom-left of the upright page (`markerCorners`).
* Four short light-grey radial ticks (from 20 to 24 mm out, at 0, 90, 180 and 270 degrees) mark where the coin goes,
  right of the fingertips. **Changed after the tables below were made:** the first draft printed a 23 mm ring at the
  coin's edge; proposal 1 (below) showed the ring biases the coin check, so it was replaced by the ticks before anything
  was printed. Table 6's "spec 23 mm ring" rows describe that old draft; the "no outline" rows are the closest to the
  ticks, which lie outside the coin-edge search band (it ends at 16.7 mm).

### Printing it

1. Get the SVG from `boardSvg()` (`svg.ts`; it is drawn in real millimetres, `width="297mm" height="210mm"`). Until an
   experiment page offers a download, run `npm run dev` and in the browser console:
   `const m = await import('/src/experimental/board/svg.ts'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([m.boardSvg()], { type: 'image/svg+xml' })); a.download = 'board.svg'; a.click();`
2. Print on A4, landscape, at **100 % / "Actual size"**. Do **not** use "Fit to page" or "Shrink to printable area":
   those scale the sheet by typically 94 to 97 %, and every length measured with the board inherits that factor.
3. Check with a ruler: **a black marker square must measure 30.0 mm** edge to edge (a 1 % error is 0.3 mm, about the
   width of a ruler's tick). If it reads 28.2 to 29.1 mm the printer scaled it; reprint at actual size.
4. Lay it flat on a matte, non-reflective table (a curled or glossy sheet breaks the flat-plane assumption and causes
   glare at low angles). The coin check (below) catches a scaled print when you forget step 3.

## The modules (all pure TypeScript: no DOM, no OpenCV; they run in Node and in a Web Worker)

| file | what it does |
|---|---|
| `image.ts` | `RgbaImage` / `GrayImage`, luma, bilinear sampling (pixel centres on integer coordinates, as OpenCV), 2x downsampling, Gaussian blur. |
| `detect.ts` | Marker detector: adaptive threshold (integral image) -> 8-connected components -> Moore contour -> convex hull -> quad (no aspect-ratio limit) -> **sub-pixel corners before decoding** -> 6 x 6 grid sampling through the quad homography (several samples per cell, Otsu threshold over the cells) -> border check -> `identify()` -> corners in printed order -> duplicate ids resolved. Every rejected candidate keeps a reason. |
| `pose.ts` | Board pose from all detected corners through `geometry/pnp.ts` (homography, plane pose, Levenberg-Marquardt with the lens model); outlier markers dropped by residual; reprojection RMS, per-marker residuals, ambiguity warning; the camera's elevation above the board and azimuth around the hand centre, for coverage guidance. |
| `calibrate.ts` | Zhang (2000) planar self-calibration: closed form from the homographies, then a joint Levenberg-Marquardt over focal length (fx = fy unless asked), optional principal point, k1 (and k2 when an F-test and its own standard deviation justify it) and every view's pose; RMS, per-view RMS, Gauss-Newton standard deviations, degeneracy checks; falls back to an **assumed** field of view, flagged `assumed: true`. |
| `coinCheck.ts` | Print-scale check: the coin on the printed target measured in board millimetres from a rectified (8 px/mm) patch, step edges along rays, robust circle fit, a model of the coin's raised top face, quality gates; returns the print scale `s = reference diameter / measured diameter` (the reference diameter is an input). |
| `render.ts` | Test support (may be imported by other experiments): renders the board as a camera with intrinsics (k1, k2) at a pose would see it, with adaptive supersampling, paper / table / background, lighting gradient and vignette, Gaussian blur, motion blur, sensor noise, skin-coloured ellipsoids standing in for a hand, a cylinder coin with an optional contact shadow, and a print scale. Seeded and deterministic. |

### Exported API

```ts
// detect.ts
detectMarkers(img: RgbaImage | GrayImage, opts?: DetectOptions): DetectResult
//   DetectOptions { layout?, codes?, windowPx?, thresholdOffset? (7), minSidePx? (8), maxBorderErrors? (2),
//                   minCellContrast? (12), refine? (true), intrinsics?, decimate?: 1 | 2, maxRejected? (200) }
//   DetectResult  { width, height, markers: MarkerDetection[], rejected: RejectedCandidate[], rejectedCounts,
//                   stats: { components, quadCandidates, windowPx }, timingsMs: { gray, threshold, components, quads, refineDecode, total } }
//   MarkerDetection { id, corners: [TL, TR, BR, BL] (refined), rawCorners, bitErrors, borderErrors, rotation,
//                     edgeContrast, cellContrast, edgeFitRmsPx, refined, areaPx }
//   RejectedCandidate { reason: "too_small" | "too_large" | "touches_image_edge" | "not_quad" | "low_contrast"
//                       | "border_bits" | "unknown_code" | "id_not_on_board" | "duplicate_id", bbox, corners?, detail? }
adaptiveThreshold(g, windowPx, offset): Uint8Array;  connectedComponents(mask, W, H);  traceContour(...);  convexHull(pts);  polygonArea(poly)

// pose.ts
estimateBoardPose(K: Intrinsics, markers: readonly MarkerDetection[], opts?: BoardPoseOptions): BoardPoseResult
//   BoardPoseOptions { layout?, outlierPx? (2), outlierFactor? (4), minMarkers? (1), reference? (hand-area centre) }
//   ok: { pose, reprojRmsPx, markersUsed, residuals: { id, rmsPx, used }[], droppedIds, cameraCenter,
//         elevationDeg, azimuthDeg (0 = right / fingertip side, 90 = top, 180 = left / open edge, 270 = bottom),
//         distanceMm, planeTiltDeg, ambiguityWarning, spreadFraction }   |  { ok: false, reason: "too_few_markers" | "pose_failed" }
viewAngles(pose: CameraPose, reference: { x, y }): { elevationDeg, azimuthDeg, distanceMm, center }

// calibrate.ts
calibrateCamera(views: readonly PlanarView[], width: number, height: number, opts?: CalibrationOptions): CalibrationResult
//   CalibrationOptions { aspect?: "square" | "free", principalPoint?: "center" | "estimate", distortion?: "none" | "k1" | "k1k2" | "auto",
//                        fallbackHfovDeg? (67.5), maxIterations? (60) }
//   ZhangCalibration   { method: "zhang", assumed: false, intrinsics, model, rmsPx, perViewRmsPx, poses,
//                        std: { fx, fy, cx, cy, k1, k2 }, closedFormFocalPx, closedFormGeneral, degeneracy, iterations, warnings }
//   AssumedCalibration { method: "assumed_hfov", assumed: true, intrinsics, hfovDeg, focalRangePx, reason, closedFormFocalPx, degeneracy }
viewFromDetections(markers, layout?): PlanarView        // { world: Pt[] (board mm), image: Pt[] }
assumedIntrinsics(width, height, hfovDeg?, reason?): AssumedCalibration
closedFormFocal(views, width, height): number | null;   closedFormGeneral(views, width, height)

// coinCheck.ts
checkCoinScale(img, K: Intrinsics, boardPose: CameraPose, opts: CoinCheckOptions): CoinCheckResult
//   CoinCheckOptions { referenceDiameterMm (required), coinThicknessMm?, layout?, pxPerMm? (8), searchRange? ([0.65, 1.45]),
//                      minElevationDeg? (45), rays? (180), maxResidualMm? (0.25), minEdgeContrast? (4), minFillContrast? (6), keepRectified? }
//   ok: { diameterMm, circleDiameterMm, printScale, residualMm, center, centerOffsetMm, edgePoints, edgePointsUsed,
//         polarity, edgeContrast, fillContrast, elevationDeg, cameraHeightMm, thicknessEffectMm, rectified?, edgePointsMm? }
//   | { ok: false, reason: "view_too_oblique" | "outside_image" | "no_edge" | "fit_failed" | "poor_fit" | "low_contrast" | "not_a_disc" | "implausible_size", detail }
fitCircleAlgebraic(pts);  sdTwoDiscHull(p, a, r1, b, r2)

// render.ts (test support)
renderBoardView(K: Intrinsics, physicalPose: CameraPose, opts?: RenderOptions): RgbaImage
orbitPose(target, distanceMm, elevationDeg, azimuthDeg): CameraPose;  toBoardUnits(pose, printScale): CameraPose
handOccluders(dx?, dy?): Ellipsoid[];  projectedMarkerCorners(K, boardPose, layout?);  occludedFromCamera(pose, boardPt, occluders, printScale?)
makeBoardSampler(layout?, outlineDiameterMm?)
```

### Design notes worth knowing

* **Sub-pixel edges by the centroid of the derivative, not its peak.** A pixel-integrated step read through bilinear
  interpolation has a flat-topped derivative; its peak snaps to half pixels (0.2 to 0.3 px corner errors in the first
  version). The centroid of the derivative lobe is exact for that case; in development runs it brought the corner RMS
  on rendered views from 0.2 to 0.36 px down to 0.05 to 0.07 px.
* **Refine before decoding.** At 10 to 15 degrees a cell is 2 to 4 px tall; sampling the grid through the integer
  contour quad (off by about 1 px) misreads bits, so the corners are refined first and the grid is read through them.
* **No aspect-ratio limit; quad tolerance scales with the quad.** A marker at 10 degrees is a long thin quad whose
  thresholded corners are rounded in proportion to both its length and thickness.
* **Coin thickness.** The coin's top face is about 1.5 mm above the paper. Rectifying with the plane's homography
  projects the top edge onto z = 0 from the camera: it appears enlarged by k = Zc / (Zc - h) (Zc = camera height) and
  shifted away from the camera, and the side wall facing the camera joins the silhouette. A plain circle fitted to that
  outline over-reads the diameter (see the coin table). With `coinThicknessMm`, the fit uses the convex hull of the base
  circle and the projected top circle (an "uneven capsule" signed distance) with the camera centre from the pose, and
  reports the base diameter. Views below 45 degrees are refused.

## Results (ALL SIMULATED)

Every table below is **SIMULATED**: rendered images with known truth from `render.ts`, an ideal flat matte sheet, a
perfect pinhole-plus-radial lens, Gaussian blur and noise, ellipsoids for the hand and a cylinder for the coin. They say
**nothing** about real phones, real lenses, real prints, glare, paper curl, rolling shutter, JPEG or real coins.
Reproduce with `RUN_BOARD_SWEEP=1 npx vitest run --no-file-parallelism src/experimental/board/sweep.test.ts` from
`frontend/` (about 36 minutes on this machine; the numbers below are from that run, 2026-11-08).

Columns: *visible / view* = markers wholly in the frame (and not hidden by the hand) per view; *detected* = share of
those found with the right id and every corner within 3 px; *false* = detections more than 3 px from the truth (a
wrong id or a corner pulled off; they went into the pose, whose outlier test and accuracy columns show the effect);
*views with pose* = views where at least two
markers gave a pose; *rot. err.* = angle between the estimated and the true camera rotation; *camera-centre err.* in mm.
The pose uses the true intrinsics (calibration has its own table). Elevation is the camera's angle above the board seen
from the hand-area centre (124.5, 105); 8 azimuths per row, all round the board. At 250 mm straight above, some
16:9 frames contain fewer than two whole markers, hence "6/8" and "fewest markers used 0" there.

### 1. Detection and pose vs elevation, distance and resolution (no hand)

**SIMULATED (rendered images with known truth; says nothing about real phones or real prints).** Detection and pose, 1280 x 720, hfov 65 deg, k1 -0.08, k2 0.02, blur sigma 0.8 px, noise sigma 3 grey levels, light gradient +-15 % and vignette 20 %, no hand. 8 azimuths per row (camera looking at the hand-area centre); pose with the true intrinsics.

| elev (deg) | dist (mm) | visible / view | detected | corner RMS (px) | worst corner (px) | false | views with pose | fewest markers used | rot. err. median / max (deg) | camera-centre err. median / max (mm) | detect (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 90 | 250 | 5.5 | 100 % | 0.10 | 0.19 | 0 | 6/8 | 0 | 0.004 / 0.007 | 0.06 / 0.06 | 45 |
| 60 | 250 | 8.8 | 100 % | 0.08 | 0.19 | 0 | 8/8 | 8 | 0.004 / 0.006 | 0.05 / 0.05 | 82 |
| 45 | 250 | 10.5 | 100 % | 0.07 | 0.24 | 0 | 8/8 | 8 | 0.003 / 0.008 | 0.04 / 0.05 | 103 |
| 30 | 250 | 12.3 | 100 % | 0.09 | 0.28 | 0 | 8/8 | 9 | 0.003 / 0.005 | 0.04 / 0.04 | 112 |
| 20 | 250 | 12.5 | 100 % | 0.10 | 0.34 | 0 | 8/8 | 10 | 0.004 / 0.006 | 0.03 / 0.04 | 68 |
| 15 | 250 | 12.8 | 97 % | 0.20 | 0.96 | 0 | 8/8 | 10 | 0.004 / 0.008 | 0.03 / 0.04 | 82 |
| 12 | 250 | 12.8 | 92 % | 0.37 | 1.69 | 0 | 8/8 | 8 | 0.005 / 0.015 | 0.03 / 0.06 | 83 |
| 10 | 250 | 13.0 | 90 % | 0.53 | 2.98 | 1 | 8/8 | 8 | 0.009 / 0.016 | 0.05 / 0.10 | 98 |
| 90 | 350 | 12.5 | 100 % | 0.06 | 0.16 | 0 | 8/8 | 11 | 0.005 / 0.007 | 0.05 / 0.07 | 91 |
| 60 | 350 | 13.8 | 100 % | 0.06 | 0.14 | 0 | 8/8 | 10 | 0.002 / 0.003 | 0.04 / 0.04 | 97 |
| 45 | 350 | 14.5 | 100 % | 0.06 | 0.15 | 0 | 8/8 | 12 | 0.002 / 0.003 | 0.03 / 0.04 | 81 |
| 30 | 350 | 15.0 | 100 % | 0.07 | 0.24 | 0 | 8/8 | 12 | 0.003 / 0.003 | 0.03 / 0.04 | 130 |
| 20 | 350 | 16.0 | 98 % | 0.11 | 0.45 | 0 | 8/8 | 15 | 0.002 / 0.003 | 0.02 / 0.04 | 177 |
| 15 | 350 | 16.0 | 96 % | 0.21 | 0.93 | 0 | 8/8 | 14 | 0.003 / 0.009 | 0.02 / 0.04 | 129 |
| 12 | 350 | 16.0 | 93 % | 0.37 | 1.83 | 1 | 8/8 | 11 | 0.007 / 0.012 | 0.04 / 0.09 | 120 |
| 10 | 350 | 16.0 | 79 % | 0.53 | 2.00 | 1 | 8/8 | 7 | 0.012 / 0.027 | 0.08 / 0.16 | 141 |
| 90 | 450 | 14.5 | 100 % | 0.06 | 0.15 | 0 | 8/8 | 12 | 0.007 / 0.009 | 0.06 / 0.08 | 113 |
| 60 | 450 | 15.0 | 100 % | 0.05 | 0.13 | 0 | 8/8 | 12 | 0.003 / 0.006 | 0.04 / 0.06 | 100 |
| 45 | 450 | 15.8 | 100 % | 0.06 | 0.14 | 0 | 8/8 | 15 | 0.002 / 0.005 | 0.03 / 0.04 | 118 |
| 30 | 450 | 16.0 | 100 % | 0.07 | 0.27 | 0 | 8/8 | 16 | 0.002 / 0.005 | 0.04 / 0.04 | 155 |
| 20 | 450 | 16.0 | 99 % | 0.13 | 0.58 | 0 | 8/8 | 15 | 0.003 / 0.008 | 0.02 / 0.06 | 133 |
| 15 | 450 | 16.0 | 95 % | 0.28 | 1.36 | 1 | 8/8 | 11 | 0.006 / 0.015 | 0.05 / 0.11 | 98 |
| 12 | 450 | 16.0 | 87 % | 0.43 | 1.78 | 2 | 8/8 | 10 | 0.014 / 0.031 | 0.11 / 0.21 | 79 |
| 10 | 450 | 16.0 | 74 % | 0.59 | 2.10 | 1 | 8/8 | 8 | 0.038 / 0.075 | 0.24 / 0.50 | 95 |

**SIMULATED (rendered images with known truth; says nothing about real phones or real prints).** Detection and pose, 1920 x 1080, hfov 65 deg, k1 -0.08, k2 0.02, blur sigma 0.8 px, noise sigma 3 grey levels, light gradient +-15 % and vignette 20 %, no hand. 8 azimuths per row (camera looking at the hand-area centre); pose with the true intrinsics.

| elev (deg) | dist (mm) | visible / view | detected | corner RMS (px) | worst corner (px) | false | views with pose | fewest markers used | rot. err. median / max (deg) | camera-centre err. median / max (mm) | detect (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 90 | 250 | 5.5 | 100 % | 0.13 | 0.20 | 0 | 6/8 | 0 | 0.002 / 0.008 | 0.06 / 0.06 | 125 |
| 60 | 250 | 8.8 | 100 % | 0.11 | 0.28 | 0 | 8/8 | 8 | 0.003 / 0.004 | 0.05 / 0.05 | 160 |
| 45 | 250 | 10.5 | 100 % | 0.09 | 0.28 | 0 | 8/8 | 8 | 0.002 / 0.006 | 0.04 / 0.04 | 173 |
| 30 | 250 | 12.3 | 100 % | 0.11 | 0.32 | 0 | 8/8 | 9 | 0.002 / 0.003 | 0.03 / 0.05 | 226 |
| 20 | 250 | 12.5 | 97 % | 0.11 | 0.39 | 0 | 8/8 | 10 | 0.004 / 0.005 | 0.03 / 0.04 | 241 |
| 15 | 250 | 12.8 | 96 % | 0.12 | 0.42 | 0 | 8/8 | 9 | 0.003 / 0.004 | 0.03 / 0.04 | 245 |
| 12 | 250 | 12.8 | 94 % | 0.17 | 0.70 | 0 | 8/8 | 9 | 0.004 / 0.005 | 0.03 / 0.04 | 205 |
| 10 | 250 | 13.0 | 98 % | 0.31 | 1.31 | 0 | 8/8 | 11 | 0.004 / 0.010 | 0.03 / 0.06 | 215 |
| 90 | 350 | 12.5 | 100 % | 0.07 | 0.18 | 0 | 8/8 | 11 | 0.003 / 0.006 | 0.05 / 0.06 | 217 |
| 60 | 350 | 13.8 | 100 % | 0.07 | 0.17 | 0 | 8/8 | 10 | 0.002 / 0.002 | 0.04 / 0.04 | 225 |
| 45 | 350 | 14.5 | 100 % | 0.07 | 0.18 | 0 | 8/8 | 12 | 0.002 / 0.004 | 0.03 / 0.04 | 235 |
| 30 | 350 | 15.0 | 100 % | 0.07 | 0.23 | 0 | 8/8 | 12 | 0.002 / 0.002 | 0.03 / 0.03 | 356 |
| 20 | 350 | 16.0 | 98 % | 0.08 | 0.26 | 0 | 8/8 | 14 | 0.002 / 0.003 | 0.02 / 0.03 | 299 |
| 15 | 350 | 16.0 | 98 % | 0.10 | 0.35 | 0 | 8/8 | 15 | 0.002 / 0.003 | 0.02 / 0.03 | 262 |
| 12 | 350 | 16.0 | 98 % | 0.17 | 0.86 | 0 | 8/8 | 14 | 0.002 / 0.005 | 0.03 / 0.04 | 238 |
| 10 | 350 | 16.0 | 96 % | 0.29 | 1.47 | 0 | 8/8 | 14 | 0.003 / 0.005 | 0.03 / 0.03 | 173 |
| 90 | 450 | 14.5 | 100 % | 0.06 | 0.15 | 0 | 8/8 | 12 | 0.004 / 0.008 | 0.04 / 0.07 | 201 |
| 60 | 450 | 15.0 | 100 % | 0.05 | 0.13 | 0 | 8/8 | 12 | 0.002 / 0.003 | 0.03 / 0.04 | 190 |
| 45 | 450 | 15.8 | 100 % | 0.05 | 0.16 | 0 | 8/8 | 15 | 0.002 / 0.003 | 0.03 / 0.05 | 188 |
| 30 | 450 | 16.0 | 100 % | 0.06 | 0.14 | 0 | 8/8 | 16 | 0.001 / 0.002 | 0.02 / 0.03 | 260 |
| 20 | 450 | 16.0 | 100 % | 0.07 | 0.26 | 0 | 8/8 | 16 | 0.002 / 0.005 | 0.03 / 0.03 | 276 |
| 15 | 450 | 16.0 | 98 % | 0.12 | 0.50 | 0 | 8/8 | 15 | 0.002 / 0.003 | 0.02 / 0.03 | 254 |
| 12 | 450 | 16.0 | 95 % | 0.21 | 1.02 | 0 | 8/8 | 14 | 0.003 / 0.005 | 0.03 / 0.03 | 155 |
| 10 | 450 | 16.0 | 92 % | 0.39 | 1.91 | 0 | 8/8 | 8 | 0.006 / 0.013 | 0.07 / 0.11 | 50 |

### 2. Where detection stops: projected cell size

**SIMULATED.** Share of visible markers detected, by the marker's projected cell size (its shortest image side / 6), pooled over both resolutions, all distances, elevations and azimuths above.

| cell size (px) | markers | detected |
|---|---|---|
| 0 to 1.5 | 16 | 0 % |
| 1.5 to 2 | 52 | 44 % |
| 2 to 2.5 | 86 | 74 % |
| 2.5 to 3 | 110 | 85 % |
| 3 to 4 | 218 | 94 % |
| 4 to 6 | 520 | 94 % |
| 6 to more | 4326 | 99 % |

A marker is read reliably (94 % or more) when its cells are at least about 3 px across in the foreshortened direction,
about three times in four at 2 to 2.5 px, and rarely below 2 px. The cell size is roughly
`f * 5 mm * sin(viewing angle) / distance`: at 1280 x 720 (f about 1005 px for 65 degrees) a far marker about 500 mm
away seen at about 8 degrees has cells under 1.5 px, which is why the 450 mm / 10 degree rows lose a quarter of the
markers (the far side of the board).

### 3. With the hand on the board (the real capture situation), standard and hard imaging

**SIMULATED.** With a crude hand (7 ellipsoids, up to 36 mm high) resting palm-down; 1280 x 720, blur sigma 0.8 px, noise 3, light +-15 %. "visible" excludes markers the hand hides (any corner or the centre). 8 azimuths per row.

| elev (deg) | dist (mm) | visible / view | detected | corner RMS (px) | worst corner (px) | false | views with pose | fewest markers used | rot. err. median / max (deg) | camera-centre err. median / max (mm) | detect (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 90 | 350 | 11.5 | 100 % | 0.06 | 0.16 | 0 | 8/8 | 10 | 0.004 / 0.007 | 0.05 / 0.06 | 19 |
| 60 | 350 | 13.3 | 99 % | 0.06 | 0.14 | 0 | 8/8 | 9 | 0.003 / 0.003 | 0.04 / 0.04 | 29 |
| 45 | 350 | 13.9 | 99 % | 0.06 | 0.17 | 0 | 8/8 | 11 | 0.002 / 0.003 | 0.03 / 0.04 | 102 |
| 30 | 350 | 12.4 | 100 % | 0.08 | 0.57 | 3 | 8/8 | 11 | 0.004 / 0.005 | 0.03 / 0.05 | 122 |
| 20 | 350 | 11.9 | 100 % | 0.11 | 0.42 | 1 | 8/8 | 10 | 0.003 / 0.012 | 0.04 / 0.06 | 61 |
| 15 | 350 | 11.3 | 98 % | 0.20 | 1.16 | 0 | 8/8 | 9 | 0.005 / 0.018 | 0.03 / 0.17 | 63 |
| 12 | 350 | 10.5 | 96 % | 0.25 | 1.66 | 1 | 8/8 | 8 | 0.007 / 0.018 | 0.05 / 0.08 | 105 |
| 10 | 350 | 10.4 | 92 % | 0.39 | 2.33 | 0 | 8/8 | 7 | 0.016 / 0.034 | 0.08 / 0.26 | 113 |
| 90 | 450 | 13.5 | 100 % | 0.06 | 0.14 | 0 | 8/8 | 11 | 0.006 / 0.010 | 0.05 / 0.08 | 136 |
| 60 | 450 | 14.6 | 99 % | 0.06 | 0.14 | 0 | 8/8 | 11 | 0.003 / 0.005 | 0.04 / 0.05 | 115 |
| 45 | 450 | 15.1 | 99 % | 0.06 | 0.16 | 0 | 8/8 | 14 | 0.002 / 0.004 | 0.03 / 0.04 | 127 |
| 30 | 450 | 13.6 | 100 % | 0.15 | 2.50 | 2 | 8/8 | 13 | 0.005 / 0.023 | 0.04 / 0.25 | 159 |
| 20 | 450 | 12.3 | 99 % | 0.16 | 1.09 | 2 | 8/8 | 10 | 0.005 / 0.015 | 0.03 / 0.10 | 56 |
| 15 | 450 | 11.5 | 97 % | 0.23 | 1.05 | 2 | 8/8 | 9 | 0.005 / 0.021 | 0.04 / 0.26 | 97 |
| 12 | 450 | 10.6 | 95 % | 0.34 | 1.55 | 1 | 8/8 | 8 | 0.018 / 0.063 | 0.12 / 0.76 | 113 |
| 10 | 450 | 10.5 | 83 % | 0.42 | 1.64 | 2 | 8/8 | 6 | 0.037 / 0.079 | 0.26 / 0.52 | 88 |

**SIMULATED.** With a crude hand (7 ellipsoids, up to 36 mm high) resting palm-down; 1280 x 720, HARD: blur sigma 1.5 px + 4 px motion blur, noise sigma 6, light +-30 % / +-15 %, vignette 30 %, exposure 85 %. "visible" excludes markers the hand hides (any corner or the centre). 8 azimuths per row.

| elev (deg) | dist (mm) | visible / view | detected | corner RMS (px) | worst corner (px) | false | views with pose | fewest markers used | rot. err. median / max (deg) | camera-centre err. median / max (mm) | detect (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 90 | 350 | 11.5 | 100 % | 0.13 | 0.67 | 0 | 8/8 | 11 | 0.009 / 0.013 | 0.07 / 0.09 | 122 |
| 60 | 350 | 13.3 | 99 % | 0.11 | 0.27 | 1 | 8/8 | 9 | 0.005 / 0.008 | 0.04 / 0.07 | 116 |
| 45 | 350 | 13.9 | 99 % | 0.12 | 0.42 | 1 | 8/8 | 11 | 0.005 / 0.009 | 0.04 / 0.06 | 139 |
| 30 | 350 | 12.4 | 100 % | 0.25 | 1.05 | 2 | 8/8 | 11 | 0.010 / 0.011 | 0.05 / 0.09 | 127 |
| 20 | 350 | 11.9 | 93 % | 0.45 | 2.50 | 0 | 8/8 | 9 | 0.018 / 0.033 | 0.08 / 0.30 | 144 |
| 15 | 350 | 11.3 | 79 % | 0.54 | 2.29 | 0 | 8/8 | 5 | 0.030 / 0.085 | 0.17 / 0.26 | 116 |
| 12 | 350 | 10.5 | 74 % | 0.65 | 2.54 | 0 | 8/8 | 5 | 0.052 / 0.094 | 0.26 / 0.43 | 116 |
| 10 | 350 | 10.4 | 64 % | 0.83 | 2.64 | 0 | 8/8 | 4 | 0.091 / 0.155 | 0.41 / 0.59 | 86 |
| 90 | 450 | 13.5 | 100 % | 0.12 | 0.86 | 0 | 8/8 | 11 | 0.012 / 0.029 | 0.10 / 0.24 | 139 |
| 60 | 450 | 14.6 | 99 % | 0.12 | 1.16 | 0 | 8/8 | 11 | 0.009 / 0.010 | 0.08 / 0.09 | 115 |
| 45 | 450 | 15.1 | 99 % | 0.15 | 0.62 | 0 | 8/8 | 14 | 0.007 / 0.013 | 0.05 / 0.10 | 121 |
| 30 | 450 | 13.6 | 99 % | 0.33 | 1.88 | 3 | 8/8 | 13 | 0.010 / 0.018 | 0.07 / 0.19 | 146 |
| 20 | 450 | 12.3 | 78 % | 0.43 | 1.66 | 2 | 8/8 | 6 | 0.053 / 0.150 | 0.35 / 0.72 | 87 |
| 15 | 450 | 11.5 | 71 % | 0.66 | 2.56 | 1 | 8/8 | 5 | 0.083 / 0.239 | 0.71 / 1.45 | 108 |
| 12 | 450 | 10.6 | 60 % | 0.83 | 2.43 | 0 | 8/8 | 3 | 0.136 / 0.493 | 0.94 / 3.17 | 146 |
| 10 | 450 | 10.5 | 36 % | 1.00 | 2.68 | 1 | 6/8 | 1 | 0.277 / 0.413 | 1.92 / 2.75 | 85 |

### 4. Board-change evidence: larger markers

**SIMULATED.** Alternative layouts (same A4 sheet, same dictionary, same margins) with the hand, 1280 x 720, standard imaging, 8 azimuths. Hand-area width (y extent): v1 114 mm, 36 mm markers 102 mm, 40 mm markers 98 mm.

| layout | elev (deg) | dist (mm) | visible / view | detected | views with pose | fewest markers used | rot. err. median / max (deg) | camera-centre err. median / max (mm) |
|---|---|---|---|---|---|---|---|---|
| v1 (spec): 16 x 30 mm, gap 10 | 15 | 350 | 11.3 | 97 % | 8/8 | 9 | 0.005 / 0.007 | 0.04 / 0.10 |
| v1 (spec): 16 x 30 mm, gap 10 | 12 | 350 | 10.5 | 98 % | 8/8 | 8 | 0.010 / 0.021 | 0.05 / 0.17 |
| v1 (spec): 16 x 30 mm, gap 10 | 10 | 350 | 10.4 | 90 % | 8/8 | 7 | 0.010 / 0.066 | 0.06 / 0.45 |
| v1 (spec): 16 x 30 mm, gap 10 | 15 | 450 | 11.5 | 98 % | 8/8 | 10 | 0.009 / 0.022 | 0.06 / 0.29 |
| v1 (spec): 16 x 30 mm, gap 10 | 12 | 450 | 10.6 | 93 % | 8/8 | 8 | 0.012 / 0.066 | 0.08 / 0.73 |
| v1 (spec): 16 x 30 mm, gap 10 | 10 | 450 | 10.5 | 82 % | 8/8 | 6 | 0.074 / 0.112 | 0.49 / 0.81 |
| 36 mm, 6 per row + 2, gap 9 | 15 | 350 | 9.5 | 95 % | 8/8 | 7 | 0.008 / 0.022 | 0.05 / 0.15 |
| 36 mm, 6 per row + 2, gap 9 | 12 | 350 | 9.1 | 93 % | 8/8 | 6 | 0.005 / 0.020 | 0.04 / 0.10 |
| 36 mm, 6 per row + 2, gap 9 | 10 | 350 | 9.0 | 96 % | 8/8 | 6 | 0.007 / 0.038 | 0.07 / 0.28 |
| 36 mm, 6 per row + 2, gap 9 | 15 | 450 | 9.9 | 99 % | 8/8 | 8 | 0.008 / 0.022 | 0.04 / 0.22 |
| 36 mm, 6 per row + 2, gap 9 | 12 | 450 | 9.1 | 97 % | 8/8 | 7 | 0.005 / 0.032 | 0.04 / 0.17 |
| 36 mm, 6 per row + 2, gap 9 | 10 | 450 | 9.0 | 92 % | 8/8 | 5 | 0.035 / 0.056 | 0.24 / 0.62 |
| 40 mm, 6 per row + 2, gap 8 | 15 | 350 | 9.0 | 99 % | 8/8 | 7 | 0.006 / 0.007 | 0.04 / 0.07 |
| 40 mm, 6 per row + 2, gap 8 | 12 | 350 | 9.0 | 99 % | 8/8 | 7 | 0.005 / 0.012 | 0.05 / 0.09 |
| 40 mm, 6 per row + 2, gap 8 | 10 | 350 | 8.6 | 97 % | 8/8 | 5 | 0.017 / 0.022 | 0.10 / 0.17 |
| 40 mm, 6 per row + 2, gap 8 | 15 | 450 | 9.1 | 100 % | 8/8 | 8 | 0.005 / 0.032 | 0.04 / 0.34 |
| 40 mm, 6 per row + 2, gap 8 | 12 | 450 | 9.0 | 96 % | 8/8 | 7 | 0.010 / 0.026 | 0.07 / 0.18 |
| 40 mm, 6 per row + 2, gap 8 | 10 | 450 | 8.9 | 89 % | 8/8 | 6 | 0.024 / 0.041 | 0.17 / 0.32 |

### 5. Calibration error vs number of views

**SIMULATED.** Zhang self-calibration from rendered views through the detector (1280 x 720, true hfov 65 deg so fx = 1004.6 px, k1 -0.08, k2 0.02, standard imaging, no hand). Square pixels, principal point fixed at the centre (true), k2 automatic. 3 random view sets per N.

| views | view set | |focal error| mean / max (%) | focal sd reported, mean (%) | k1 error mean / max | k2 used | RMS (px) | fell back to assumed hfov | time (ms) |
|---|---|---|---|---|---|---|---|---|
| 3 | random, 30 to 70 deg | 0.022 / 0.027 | 0.013 | 0.0003 / 0.0005 | 3/3 | 0.051 | 0/3 | 63 |
| 5 | random, 30 to 70 deg | 0.025 / 0.033 | 0.010 | 0.0002 / 0.0004 | 3/3 | 0.049 | 0/3 | 47 |
| 10 | random, 30 to 70 deg | 0.021 / 0.025 | 0.006 | 0.0001 / 0.0002 | 3/3 | 0.051 | 0/3 | 78 |
| 20 | random, 30 to 70 deg | 0.020 / 0.023 | 0.004 | 0.0001 / 0.0001 | 3/3 | 0.050 | 0/3 | 235 |
| 3 | capture-like: 1 top + ring at 12 to 15 deg | 0.023 / 0.041 | 0.046 | 0.0070 / 0.0075 | 0/3 | 0.271 | 0/3 | 54 |
| 5 | capture-like: 1 top + ring at 12 to 15 deg | 0.032 / 0.044 | 0.046 | 0.0067 / 0.0075 | 0/3 | 0.389 | 0/3 | 75 |
| 10 | capture-like: 1 top + ring at 12 to 15 deg | 0.031 / 0.054 | 0.030 | 0.0069 / 0.0073 | 0/3 | 0.418 | 0/3 | 67 |
| 20 | capture-like: 1 top + ring at 12 to 15 deg | 0.048 / 0.065 | 0.021 | 0.0072 / 0.0073 | 0/3 | 0.430 | 0/3 | 211 |

The "capture-like" sets use only views the scan takes anyway (one from above plus the low ring). Their corners are less
accurate (RMS 0.3 to 0.4 px against 0.05 px) and the automatic k2 test never accepted k2, so k1 absorbs the true k2
(k1 off by 0.007); the focal length still lands within 0.07 %. The reported standard deviation can under-state the
error (3 random views: 0.013 % reported, 0.022 % actual): the Gauss-Newton covariance ignores the detector's small
systematic corner bias, so treat it as a lower bound. No set fell back to the assumed field of view.

### 6. Coin print-scale check

**SIMULATED.** Coin print-scale check: a 23 mm x 1.5 mm cylinder coin (face grey 176, side wall 122, paper 226) on the target, the crude hand on the board, standard imaging, camera 350 mm from the hand centre at azimuth 250 deg, pose from the detected markers. Scale error = measured / true print scale - 1. 'plain circle' = the same edge points fitted by a circle without the thickness model.

| resolution | printed outline | true print scale | elev (deg) | measured scale | error (%) | plain-circle error (%) | edge residual (mm) | check (ms) |
|---|---|---|---|---|---|---|---|---|
| 1280 x 720 | spec 23 mm ring | 1 | 90 | 0.9905 | -0.95 | -2.41 | 0.078 | 227 |
| 1280 x 720 | spec 23 mm ring | 1 | 75 | 0.9923 | -0.77 | -2.87 | 0.097 | 123 |
| 1280 x 720 | spec 23 mm ring | 1 | 60 | 0.9962 | -0.38 | -3.78 | 0.109 | 90 |
| 1280 x 720 | spec 23 mm ring | 1 | 45 | refused: view_too_oblique | | | | |
| 1280 x 720 | spec 23 mm ring | 0.97 | 90 | 0.9670 | -0.31 | -1.73 | 0.077 | 94 |
| 1280 x 720 | spec 23 mm ring | 0.97 | 75 | 0.9670 | -0.31 | -2.45 | 0.092 | 116 |
| 1280 x 720 | spec 23 mm ring | 0.97 | 60 | 0.9670 | -0.30 | -3.62 | 0.103 | 89 |
| 1280 x 720 | spec 23 mm ring | 0.97 | 45 | refused: view_too_oblique | | | | |
| 1280 x 720 | spec 23 mm ring | 0.94 | 90 | 0.9358 | -0.44 | -1.79 | 0.094 | 115 |
| 1280 x 720 | spec 23 mm ring | 0.94 | 75 | 0.9365 | -0.37 | -2.50 | 0.109 | 94 |
| 1280 x 720 | spec 23 mm ring | 0.94 | 60 | 0.9389 | -0.12 | -3.40 | 0.130 | 84 |
| 1280 x 720 | spec 23 mm ring | 0.94 | 45 | refused: view_too_oblique | | | | |
| 1280 x 720 | none | 1 | 90 | 0.9964 | -0.36 | -1.81 | 0.087 | 78 |
| 1280 x 720 | none | 1 | 75 | 0.9964 | -0.36 | -2.55 | 0.081 | 88 |
| 1280 x 720 | none | 1 | 60 | 0.9988 | -0.12 | -3.52 | 0.094 | 86 |
| 1280 x 720 | none | 1 | 45 | refused: view_too_oblique | | | | |
| 1280 x 720 | none | 0.97 | 90 | 0.9655 | -0.46 | -1.90 | 0.074 | 84 |
| 1280 x 720 | none | 0.97 | 75 | 0.9661 | -0.40 | -2.52 | 0.082 | 176 |
| 1280 x 720 | none | 0.97 | 60 | 0.9676 | -0.25 | -3.54 | 0.103 | 91 |
| 1280 x 720 | none | 0.97 | 45 | refused: view_too_oblique | | | | |
| 1280 x 720 | none | 0.94 | 90 | 0.9363 | -0.39 | -1.77 | 0.084 | 71 |
| 1280 x 720 | none | 0.94 | 75 | 0.9362 | -0.41 | -2.56 | 0.105 | 88 |
| 1280 x 720 | none | 0.94 | 60 | 0.9387 | -0.14 | -3.40 | 0.117 | 94 |
| 1280 x 720 | none | 0.94 | 45 | refused: view_too_oblique | | | | |
| 1920 x 1080 | spec 23 mm ring | 1 | 90 | 0.9934 | -0.66 | -2.13 | 0.072 | 112 |
| 1920 x 1080 | spec 23 mm ring | 1 | 75 | 0.9947 | -0.53 | -2.68 | 0.077 | 77 |
| 1920 x 1080 | spec 23 mm ring | 1 | 60 | 0.9964 | -0.36 | -3.74 | 0.077 | 75 |
| 1920 x 1080 | spec 23 mm ring | 1 | 45 | refused: view_too_oblique | | | | |
| 1920 x 1080 | spec 23 mm ring | 0.97 | 90 | 0.9674 | -0.27 | -1.68 | 0.056 | 86 |
| 1920 x 1080 | spec 23 mm ring | 0.97 | 75 | 0.9681 | -0.20 | -2.33 | 0.058 | 100 |
| 1920 x 1080 | spec 23 mm ring | 0.97 | 60 | 0.9698 | -0.02 | -3.40 | 0.074 | 96 |
| 1920 x 1080 | spec 23 mm ring | 0.97 | 45 | refused: view_too_oblique | | | | |
| 1920 x 1080 | spec 23 mm ring | 0.94 | 90 | 0.9376 | -0.26 | -1.62 | 0.049 | 106 |
| 1920 x 1080 | spec 23 mm ring | 0.94 | 75 | 0.9381 | -0.20 | -2.28 | 0.062 | 88 |
| 1920 x 1080 | spec 23 mm ring | 0.94 | 60 | 0.9406 | 0.06 | -3.19 | 0.072 | 99 |
| 1920 x 1080 | spec 23 mm ring | 0.94 | 45 | refused: view_too_oblique | | | | |
| 1920 x 1080 | none | 1 | 90 | 0.9974 | -0.26 | -1.74 | 0.049 | 88 |
| 1920 x 1080 | none | 1 | 75 | 0.9984 | -0.16 | -2.32 | 0.062 | 94 |
| 1920 x 1080 | none | 1 | 60 | 0.9996 | -0.04 | -3.40 | 0.060 | 74 |
| 1920 x 1080 | none | 1 | 45 | refused: view_too_oblique | | | | |
| 1920 x 1080 | none | 0.97 | 90 | 0.9667 | -0.34 | -1.76 | 0.050 | 89 |
| 1920 x 1080 | none | 0.97 | 75 | 0.9687 | -0.13 | -2.27 | 0.058 | 107 |
| 1920 x 1080 | none | 0.97 | 60 | 0.9708 | 0.08 | -3.33 | 0.063 | 105 |
| 1920 x 1080 | none | 0.97 | 45 | refused: view_too_oblique | | | | |
| 1920 x 1080 | none | 0.94 | 90 | 0.9372 | -0.29 | -1.67 | 0.053 | 79 |
| 1920 x 1080 | none | 0.94 | 75 | 0.9392 | -0.09 | -2.22 | 0.063 | 84 |
| 1920 x 1080 | none | 0.94 | 60 | 0.9403 | 0.03 | -3.27 | 0.072 | 68 |
| 1920 x 1080 | none | 0.94 | 45 | refused: view_too_oblique | | | | |

* The raised top face matters: a plain circle reads the scale 1.6 to 3.8 % low (the coin looks 0.4 to 0.9 mm too
  large), more from lower views. The thickness model brings it within 1 % everywhere, within 0.5 % without the printed
  ring.
* The printed 23 mm outline biases the measurement when the print scale is close to 1: the grey ring then peeks out just
  outside the coin's edge (ring and silver coin have nearly the same grey), adding up to 0.6 % (0.95 % vs 0.36 % at
  1280 x 720 from straight above). At 94 % and 97 % the ring is hidden under the coin and has no effect.
* A "fit to page" print (94 %, 97 %) is clearly separated from 100 %: the worst error is 0.95 % against a 3 to 6 %
  effect. A sensible rule (untested on real coins): warn when the measured scale is below 0.98 or above 1.02.
* An empty target, or only the printed ring, is refused (`not_a_disc`); so is a pale coin whose rim matches the paper
  (`poor_fit`), see `coinCheck.test.ts`. Views below 45 degrees are refused by design.

### 7. Timings (Node, single thread, this machine)

**SIMULATED images; timings in Node on this machine, single thread (median of 8 views at 45 deg, 350 mm, standard imaging).**

| step | 1280 x 720 | 1920 x 1080 |
|---|---|---|
| render | 1551 ms | 2952 ms |
| detect (full res) | 92 ms | 167 ms |
| detect (decimate 2) | 51 ms | 70 ms |
| pose | 4.7 ms | 4.4 ms |

Detection of a 1280 x 720 frame took 19 to 177 ms per row average over the sweep (92 ms median in the timing table;
51 ms with `decimate: 2`, which finds candidates on a half-size image and refines at full resolution; unit-tested to
give the same markers on a 1080p view). 1920 x 1080: 167 ms (70 ms decimated). That is enough for live coverage
guidance in a Web Worker at a few frames per second, not at 30 fps. Calibration of 20 views: about 0.2 s. Coin check:
about 0.1 s. Pose: about 5 ms. The renderer is test support only; its times here were inflated by other jobs running on
the machine during the sweep (0.3 to 0.8 s per 720p frame when idle).

## What works at which elevation (SIMULATED)

| elevation | 1280 x 720 | 1920 x 1080 |
|---|---|---|
| 90 to 30 deg | 99 to 100 % of visible markers, corners 0.05 to 0.1 px RMS, pose to 0.01 deg / 0.1 mm. | same |
| 20 deg | 98 to 100 %, corners about 0.1 px. | 97 to 100 % |
| 15 deg | 95 to 98 %, corners 0.2 to 0.3 px; pose 0.02 deg / 0.3 mm worst. | 96 to 98 %, corners 0.1 px |
| 12 deg | 87 to 96 %, corners 0.25 to 0.45 px; with the hand at 450 mm the worst view is off by 0.06 deg / 0.8 mm. | 94 to 98 % |
| 10 deg | 74 to 92 %; 6 to 8 markers per view still give 0.04 deg / 0.26 mm median, 0.08 deg / 0.8 mm worst. | 92 to 98 % |
| 10 to 15 deg, HARD imaging (blur 1.5 px + 4 px motion blur, noise 6) | 15 deg: 71 to 79 %; 12 deg: 60 to 74 %; **10 deg at 450 mm: 36 %, no pose in 2 of 8 views**, up to 0.5 deg / 3 mm error in views that have one. | not run |

Plainly: on clean simulated images the current board works down to 10 degrees, with pose errors far below the
1 degree / 2 mm level the reconstruction simulation showed to be harmful. It **stops working** when the low ring is
both far (450 mm) and degraded (blur, motion, noise) at 10 to 12 degrees on 720p video, because the far markers' cells
fall below about 2 px and the near markers' corners get noisy. The margin at 10 degrees is thin, and real images will be
worse than these renders.

## Proposed board changes

1. **DONE (2026-11-08): replace the 23 mm coin outline by four short ticks at a radius of 20 mm or more** (outside the edge search band,
   which ends at 1.45 x the coin radius = 16.7 mm). Evidence: table 6, ring present vs absent at scale 1: 0.95 % vs
   0.36 % (720p), 0.66 % vs 0.26 % (1080p). A ring drawn just *outside* the coin is worse: in a development render with
   a 30 mm ring the edge search locked onto the ring and read the scale 15 to 18 % low (a scratch experiment, not a
   table here), so the ticks must stay outside the search band.
2. **If real low-ring trials show markers with cells below about 2.5 px, enlarge the markers to 36 to 40 mm** (6 per
   long edge + 2 on the right). Evidence, table 4: at 10 degrees and 350 mm, 40 mm markers are detected 97 % vs 90 %
   and the worst camera-centre error falls from 0.45 to 0.17 mm; at 450 mm, 89 % vs 82 % and 0.32 vs 0.81 mm. Cost:
   the hand area narrows from 114 mm to 98 mm (a large palm with the thumb spread may not fit) and fewer markers are
   visible per view. Under standard imaging the current 30 mm board is already adequate, so this is conditional on
   real data (the hard-imaging case was not run with the larger markers).
3. **Capture guidance first (no board change):** keep the low ring at 12 degrees or more and within 350 mm on 720p video,
   or use 1080p (table 1: 92 to 98 % detection at 10 degrees). `estimateBoardPose` reports elevation and azimuth to
   drive that guidance.

## Known limitations

* **Simulated only.** No real phone frame has been through the detector. Real failure modes not modelled: specular glare
  on the paper at grazing angles (likely the biggest risk for the low ring), paper curl, grey rather than black ink,
  rolling-shutter skew, video compression, autofocus breathing, exposure changes between frames, real hand shadows.
* **Partially covered markers are lost** (a finger over a corner breaks the quad); a hand blob touching a marker merges
  with it in the threshold and the marker is rejected (`not_quad`). Adjacent markers seen along a row at very low
  elevation can merge the same way when the 10 mm gap foreshortens to a few pixels.
* **Corner accuracy degrades at grazing angles** (0.4 to 0.6 px RMS at 10 degrees on 720p): the foreshortened border
  cell leaves little room for the edge profile.
* **Lens distortion bends the sides**; lines are fitted straight unless `intrinsics` are passed (then in undistorted
  coordinates).
* **Calibration**: principal point at the centre and square pixels by default (the renders had exactly that); a real
  phone's offset principal point biases f slightly unless `principalPoint: "estimate"` is used with varied tilts. The
  standard deviations ignore systematic corner bias. Focus changes or electronic stabilisation change the intrinsics
  between frames, which this model cannot represent.
* **Coin check**: an ideal cylinder with a dark side wall was rendered; real coins have relief, rounded or reeded rims,
  highlights and a contact shadow. The near-side wall still leaves a +0.3 to +0.5 % diameter bias from straight above.
  The coin's thickness is an input; without it no thickness model is applied.
* **Pose from one marker** is allowed (`minMarkers: 1`) but weak; coverage logic should prefer views with several
  markers spread across the image (`spreadFraction`).
* The opt-in sweep can end with a harmless Vitest RPC warning ("Timeout calling onTaskUpdate") after all tests pass,
  because each table is one long test.
