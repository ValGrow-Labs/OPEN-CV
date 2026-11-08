# Coin calibration study (stage 2b, EXPERIMENTAL)

What a coin gives as a metric reference for the smartphone hand-measurement engine, how wrong it can be, and how it
fixes the scale of a multi-view 3D scene. Research code: nothing in the customer flow, the scan or the production
calibration imports this folder. **Every accuracy figure below is SIMULATED** (rendered ideal coins, analytic outlines).
None of it is real-world accuracy; no real coin or phone image has been measured with it.

Reference coin: the Indian 2019-series 2-rupee coin, `config/reference_objects.json` entry `inr_2_2019`
(diameter 23.0 mm, allowance +-0.1 mm, `thickness_mm: null`). The code reads these values from the config files; none is
hard-coded in the logic. Production code (`src/vision/coinDetector.ts`, `coinEngine.ts`, `frameAnalysis.ts`) and the config
are only read.

## Files and API

| File | What |
|---|---|
| `conic.ts` | Ellipse and conic maths: `ellipseToConic`, `conicToEllipse`, `sampsonDistance`, robust geometric ellipse fit `fitEllipseRobust` (Levenberg-Marquardt on Sampson distances, MAD trimming, covariance), `circlePosesFromConic` (the two 3D circles behind one ellipse, known intrinsics), `projectCircleConic` (the image conic of a 3D circle), `eigenSymmetric3`, `levenbergMarquardt`. |
| `measureCoin.ts` | `coinReferenceFromConfig(referenceObjectsJson, id, assumedThicknessMm)` and `measureCoin(cv, image, { params, reference, intrinsics?, assumedHfovDeg?, frame?, fallbackSeed?, edgeBiasAllowancePx?, maxRelSigma? })`. |
| `sceneScale.ts` | `fitCoinCircle3D(views, { diameterMm, diameterAllowanceMm, thicknessMm, thicknessAllowanceMm, model, fixedRadiusMm? })`: the coin's 3D circle and `mmPerUnit` of an up-to-scale scene. |
| `renderCoin.ts` | Test renderer: a cylinder coin on skin / paper / wood, finger capsules, glare, contact shadow, lens distortion, blur, noise; crops of large frames. |
| `sensitivity.ts` | The single-image study (`studyScenarios`, `runScenario`, `runSensitivityStudy`, `sensitivityTable`) and the 3D consequence (`globalScaleErrorTable`, `tiltedViewErrorMap`). |
| `sceneScaleStudy.ts` | The multi-view Monte Carlo study (`sceneCases`, `runSceneCase`, `sceneTable`, `silhouettePoints`, `orbitCamera`). |

### `measureCoin`

1. Runs the **production** `detectCoin` (unchanged) with the production `coin_detection` parameters passed in. Its ellipse
   is the start. Its own verdict is reported in `production` and `warnings`, but it does not gate the result. A
   caller-given `fallbackSeed` is used only when production finds nothing.
2. **Edge points.** The colour image is smoothed (0.7 px) and projected on the colour direction from the coin face (median
   of an inner ring) to its surroundings (an outer ring). That is a chroma step on skin and a brightness step on paper.
   On 360 radial profiles it takes the strongest rising step, with parabolic sub-pixel peaks. A profile that leaves the
   picture marks the ray as outside.
3. With `intrinsics` (k1, k2), the edge points are **undistorted** before fitting.
4. **Robust ellipse fit** in two passes (wide, then narrow), with outliers trimmed by MAD (`outlier_mad_k` from the config).
5. **Visibility**:
   - `rimInsideImage` and `minMarginPx`;
   - `outsideShare`;
   - `occludedShare` (in-picture rays with no inlier edge);
   - `maxGapDeg`;
   - `glareShare`: face pixels at or above the production `glare_level`;
   - `edgeWidthPx`.
6. **Orientation**:
   - `tiltDeg = acos(minor/major)` with `tiltSign: "ambiguous"`;
   - `tiltDegThicknessCorrected`: a first-order removal of the coin wall from the minor axis, refused below about 15 degrees;
   - `imageAngleDeg`: the major axis, which is the tilt axis;
   - with intrinsics, `poses`: the two exact circle poses;
   - with intrinsics, `outlineFit`: the 3D outline fit (cylinder model when the wall shows, see below). Its
     `wallSuggestsSign` is a hint only.
7. **Scale** (mm per px):
   - `mmPerPxMajor = D / major`, at the coin's top face, uncorrected;
   - `mmPerPxCone`: the perspective-exact `Z_top / f` from the ellipse's viewing cone;
   - `mmPerPxCorrected`: the same, from the 3D outline fit when intrinsics are known (it models the wall);
   - `mmPerPxSupport`: moved to the surface the coin lies on (palm or table) with the thickness, `(Z + h |n_z|) / Z`.

   Without intrinsics the focal length comes from the app's assumed 55 to 80 degree field of view (`geometry/camera.ts`
   `ASSUMED_HFOV_DEG`, kept equal to the config by a test).
8. **Uncertainty**: relative one-sigma components combined by root-sum-square. Each component states its rule.

   | Component | Rule |
   |---|---|
   | `edge_fit` | Fit covariance |
   | `edge_bias` | Assumed +-0.25 px per edge, uniform |
   | `reference_diameter` | Config allowance / sqrt 3 / D |
   | `perspective` | Two-pose spread, or the spread over the assumed field of view |
   | `lens_distortion` | Corrected with the given model; not included without intrinsics |
   | `thickness` | Thickness allowance and distance uncertainty |

9. **Gates** (`reasons`):

   | Reason | Rule |
   |---|---|
   | `coin_not_found` | No coin found |
   | `too_small` | Below `min_diameter_px` |
   | `rim_outside_image` | Part of the rim is outside the picture |
   | `rim_occluded` | Below `accept.min_edge_support`, or a gap above `accept.max_angular_gap_deg` |
   | `glare` | Above `accept.max_glare_fraction` |
   | `poor_fit` | Residual above the production residual limit |
   | `blurry` | Edge width above `accept.max_edge_width_px` |
   | `uncertain_scale` | Relative sigma above 3 % (assumed) |

   `confidence` uses the production score ramps for image quality, plus the relative uncertainty and the inside-picture check.

### `fitCoinCircle3D` (the coin as the scale of a 3D scene)

Inputs are views with intrinsics, world-to-camera poses whose translations may be in arbitrary units (structure from
motion), and either edge points or an ellipse per view.

1. Per view, the two unit-radius circle poses. Pick the world normals that agree across views.
2. Triangulate the centre rays in least squares. The radius in scene units is the distance along each ray.
3. Levenberg-Marquardt on every edge point of every view. Parameters: the centre, a tangent-plane normal and log r.
   Residual: the Sampson distance to the projected circle (`top`), or to the union of the projected top and bottom rims
   (`cylinder`, thickness/diameter from the config). `auto` keeps the model with the smaller residual.
4. Result: `mmPerUnit = D / (2 r)` and its uncertainty:
   - `fit`: the covariance of log r;
   - `reference_diameter`;
   - `thickness`: refit with the thickness changed.

   **Pose errors are not in the covariance.**

Rim points cannot be triangulated directly: a featureless rim has no correspondences, and an epipolar line meets the other
ellipse twice. Cone fitting avoids that. **One view cannot give the scale**: r at distance Z looks like k r at k Z, so
`too_few_views` is returned. With a metric pose (`fixedRadiusMm`), the same fit gives the coin's 3D pose from one view.

## What a coin can and cannot do

* **Can:** give a known length **at its own plane**, the plane's tilt angle, and with intrinsics, its distance and the two
  candidate normals. In a multi-view scene with up-to-scale poses it fixes the one missing scalar: a single number that is
  correct for the whole 3D scene.
* **Cannot:**
  - give the camera pose: a circle has no in-plane orientation, and the tilt sign is ambiguous;
  - give depth anywhere else;
  - give the scale of any point at another height. A single global pixels-per-millimetre ratio is wrong for a 3D hand
    (tables below).
* **Tilt sign from the wall:** a coin's visible wall breaks the two-pose symmetry in principle. For an exact outline at
  300 mm and 1280 px, though, the wrong pose fits only about 0.07 px RMS worse. SIMULATED: the hint was right on skin at
  20 to 40 degrees and off-axis, but **wrong on paper at 30 degrees** (an edge bias of a few hundredths of a pixel reversed
  it). Treat it as a hint, never as a pose.

## Single-image sensitivity (SIMULATED)

**Setup.** `COIN_STUDY=full COIN_SEEDS=3 npx vitest run --no-file-parallelism src/experimental/coin/sensitivity.test.ts`.
3 seeds each; signed relative scale errors in %, mean over the seeds.

**Baseline:** 1280 x 720 (the app's phone video), 69.4 degree field of view across the long side, coin base 300 mm away,
image centre, coin parallel to the image, light skin, contact shadow (1 mm, 25 %), blur 0.8 px, noise 3 grey levels.
Coin: 23.0 mm, assumed 1.5 mm thick (see Thickness).

**Truth:**
- `s_top = Z_top / f` for the production, refined, undistorted, cone and 3D-fit columns;
- `s_surface = Z_base / f` for the surface column.

**Columns:**
- "cone, known K": the ellipse's cone with the true intrinsics.
- "cone, assumed FOV": the raw ellipse with a 67.5 degree assumed field of view and the principal point at the centre, as
  production would have it.
- "3D outline fit": the cylinder/top model with known K.
- "claimed sigma": measureCoin's combined one-sigma.

**Tilt columns:** the true angle to the viewing ray, then the axis-ratio estimate, the wall-corrected estimate, and the
3D-fit estimate.

**Wall sign hint:** the mean over seeds of 1 (right), 0.5 (no hint) and 0 (wrong).

| Scenario | coin px | prod. det. found/acc. | production D/major % | refined D/major % | undistorted % | cone, known K % | cone, assumed FOV % | 3D outline fit, known K % | surface scale % | claimed sigma % | tilt: true / ratio / wall-corr. / 3D fit (deg) | wall sign hint | reasons |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1280x720, 300 mm, centre, flat, skin | 71 | 1.0 / 1.0 | -0.41 | -0.12 | -0.12 | -0.12 | -0.12 | -0.11 | -0.11 | 0.40 | 0.0 / 2.6 / n/a / 2.5 | 0.50 | - |
| pos 0.25 to corner, k1 0 | 71 | 1.0 / 1.0 | -1.13 | -0.83 | -0.83 | -0.07 | -0.07 | +0.02 | +0.02 | 0.39 | 11.3 / 7.0 / n/a / 12.3 | 0.83 | - |
| pos 0.50 to corner, k1 0 | 71 | 1.0 / 1.0 | -2.35 | -1.99 | -1.99 | -0.25 | -0.25 | +0.05 | +0.05 | 0.39 | 21.8 / 10.7 / n/a / 22.5 | 1.00 | - |
| pos 0.75 to corner, k1 0 | 71 | 1.0 / 1.0 | -3.53 | -3.47 | -3.47 | -0.24 | -0.24 | +0.28 | +0.28 | 0.39 | 30.9 / 14.6 / n/a / 30.9 | 1.00 | - |
| pos 0.85 to corner, k1 0 | 71 | 1.0 / 1.0 | -4.04 | -4.20 | -4.20 | -0.34 | -0.34 | +0.26 | +0.26 | 0.39 | 34.2 / 15.9 / 20.1 / 34.0 | 1.00 | - |
| pos 0.25 to corner, k1 -0.08 | 71 | 1.0 / 1.0 | -0.21 | +0.20 | -0.77 | -0.01 | +0.32 | -0.01 | -0.02 | 0.39 | 11.3 / 7.1 / n/a / 8.9 | 0.50 | - |
| pos 0.50 to corner, k1 -0.08 | 71 | 1.0 / 1.0 | +0.87 | +1.17 | -1.98 | -0.14 | +1.19 | -0.05 | -0.05 | 0.39 | 22.0 / 11.0 / n/a / 20.3 | 0.67 | - |
| pos 0.75 to corner, k1 -0.08 | 71 | 1.0 / 1.0 | +2.44 | +2.80 | -3.46 | -0.31 | +2.83 | +0.05 | +0.05 | 0.39 | 31.7 / 14.4 / n/a / 30.8 | 0.83 | - |
| pos 0.85 to corner, k1 -0.08 | 71 | 1.0 / 1.0 | +3.29 | +3.67 | -4.29 | -0.44 | +3.70 | +0.22 | +0.22 | 0.39 | 35.2 / 15.9 / 20.1 / 35.2 | 1.00 | - |
| pos 0.97 (rim leaves the frame) | 71 | 1.0 / 0.0 | +0.48 | -1.06 | -1.06 | +1.02 | +1.01 | +1.05 | +0.68 | 2.19 | 37.8 / 13.1 / 22.4 / 36.4 | 0.50 | rim_outside_image rim_occluded uncertain_scale |
| tilt 10 deg | 71 | 1.0 / 1.0 | -0.36 | -0.08 | -0.08 | -0.08 | -0.08 | -0.05 | -0.05 | 0.40 | 10.0 / 7.9 / n/a / 9.0 | 0.50 | - |
| tilt 20 deg | 71 | 1.0 / 1.0 | -0.42 | -0.19 | -0.19 | -0.19 | -0.19 | +0.12 | +0.12 | 0.39 | 20.1 / 17.7 / 21.8 / 21.1 | 0.83 | - |
| tilt 30 deg | 71 | 1.0 / 1.0 | -0.66 | -0.31 | -0.31 | -0.29 | -0.29 | +0.08 | +0.09 | 0.39 | 30.1 / 27.1 / 31.1 / 29.5 | 0.83 | - |
| tilt 40 deg | 71 | 1.0 / 1.0 | -0.97 | -0.49 | -0.49 | -0.46 | -0.46 | +0.41 | +0.41 | 0.39 | 40.2 / 36.6 / 40.5 / 40.0 | 1.00 | - |
| tilt 45 deg | 71 | 1.0 / 0.0 | -22.99 | -23.05 | -23.05 | -23.00 | -23.01 | -22.76 | -22.62 | 0.59 | 45.2 / 31.7 / 35.7 / 34.0 | 0.50 | rim_occluded |
| 200 mm | 107 | 1.0 / 1.0 | -0.25 | -0.05 | -0.05 | -0.05 | -0.05 | -0.05 | -0.05 | 0.35 | 0.0 / 2.2 / n/a / 2.2 | 0.50 | - |
| 400 mm | 53 | 1.0 / 1.0 | -0.39 | -0.13 | -0.13 | -0.12 | -0.12 | -0.08 | -0.08 | 0.47 | 0.0 / 3.3 / n/a / 7.0 | 0.50 | - |
| 500 mm | 43 | 1.0 / 1.0 | -0.56 | -0.27 | -0.27 | -0.27 | -0.27 | -0.19 | -0.19 | 0.55 | 0.0 / 4.1 / n/a / 7.9 | 0.50 | - |
| 1920x1080 | 107 | 1.0 / 1.0 | -0.31 | -0.09 | -0.09 | -0.09 | -0.09 | -0.09 | -0.09 | 0.33 | 0.0 / 2.1 / n/a / 2.3 | 0.50 | - |
| 4000x3000 (12 MP still) | 223 | 1.0 / 1.0 | -0.14 | -0.06 | -0.06 | -0.06 | -0.06 | -0.06 | -0.06 | 0.28 | 0.0 / 1.8 / n/a / 1.8 | 0.50 | - |
| blur sigma 0 px | 71 | 1.0 / 1.0 | -0.21 | -0.09 | -0.09 | -0.09 | -0.09 | -0.09 | -0.09 | 0.39 | 0.0 / 2.1 / n/a / 2.2 | 0.50 | - |
| blur sigma 2 px | 71 | 1.0 / 1.0 | -0.76 | -0.42 | -0.42 | -0.42 | -0.42 | -0.37 | -0.37 | 0.41 | 0.0 / 6.6 / n/a / 10.1 | 0.50 | - |
| blur sigma 3.5 px | 71 | 1.0 / 0.0 | -1.24 | -0.11 | -0.11 | -0.11 | -0.11 | -0.05 | -0.06 | 0.50 | 0.0 / 7.5 / n/a / 11.1 | 0.50 | poor_fit blurry |
| noise sigma 0 | 71 | 1.0 / 1.0 | -0.37 | -0.06 | -0.06 | -0.06 | -0.06 | -0.06 | -0.06 | 0.39 | 0.0 / 1.2 / n/a / 1.2 | 0.50 | - |
| noise sigma 8 | 71 | 1.0 / 1.0 | -0.49 | -0.21 | -0.21 | -0.21 | -0.21 | -0.20 | -0.20 | 0.40 | 0.0 / 4.2 / n/a / 6.1 | 0.50 | - |
| noise sigma 16 | 71 | 1.0 / 1.0 | -0.66 | -0.41 | -0.41 | -0.41 | -0.41 | -0.39 | -0.40 | 0.41 | 0.0 / 6.4 / n/a / 9.0 | 0.50 | - |
| glare on the face | 71 | 1.0 / 1.0 | -0.38 | +0.16 | +0.16 | +0.16 | +0.16 | +0.16 | +0.16 | 0.40 | 0.0 / 1.7 / n/a / 1.8 | 0.50 | - |
| glare reaching the rim | 71 | 1.0 / 1.0 | -0.47 | +0.02 | +0.02 | +0.02 | +0.02 | +0.03 | +0.03 | 0.40 | 0.0 / 2.2 / n/a / 2.7 | 0.50 | - |
| finger over 10 % of the rim | 71 | 1.0 / 1.0 | -0.38 | -0.02 | -0.02 | -0.02 | -0.02 | -0.02 | -0.02 | 0.40 | 0.0 / 3.0 / n/a / 3.1 | 0.50 | - |
| finger over 25 % of the rim | 71 | 1.0 / 0.0 | -0.54 | -0.20 | -0.20 | -0.20 | -0.20 | -0.16 | -0.16 | 0.40 | 0.0 / 3.0 / n/a / 3.9 | 0.50 | rim_occluded |
| finger over 40 % of the rim | 71 | 1.0 / 0.0 | -17.21 | -20.52 | -20.52 | -20.46 | -20.46 | -19.63 | -19.66 | 0.82 | 0.0 / 40.8 / 44.7 / 41.4 | 0.50 | rim_occluded poor_fit |
| skinDark, flat | 71 | 1.0 / 1.0 | -1.30 | +0.15 | +0.15 | +0.15 | +0.15 | +0.15 | +0.15 | 0.39 | 0.0 / 1.9 / n/a / 1.9 | 0.50 | - |
| paper, flat | 71 | 1.0 / 1.0 | -0.40 | -2.94 | -2.94 | -2.94 | -2.94 | -2.94 | -2.92 | 0.39 | 0.0 / 2.1 / n/a / 2.7 | 0.50 | - |
| wood, flat | 71 | 1.0 / 1.0 | -0.90 | +0.21 | +0.21 | +0.21 | +0.21 | +0.21 | +0.21 | 0.40 | 0.0 / 2.1 / n/a / 2.7 | 0.50 | - |
| skin, tilt 30 | 71 | 1.0 / 1.0 | -0.66 | -0.31 | -0.31 | -0.29 | -0.29 | +0.08 | +0.09 | 0.39 | 30.1 / 27.1 / 31.1 / 29.5 | 0.83 | - |
| skinDark, tilt 30 | 71 | 1.0 / 1.0 | -1.63 | -0.15 | -0.15 | -0.13 | -0.13 | -0.13 | -0.13 | 0.39 | 30.1 / 29.6 / 33.6 / 29.6 | 0.50 | - |
| paper, tilt 30 | 71 | 1.0 / 1.0 | -0.28 | -2.68 | -2.68 | -2.66 | -2.66 | -2.66 | -2.64 | 0.39 | 30.1 / 28.6 / 32.6 / 28.6 | 0.50 | - |
| wood, tilt 30 | 71 | 1.0 / 1.0 | -1.19 | -0.04 | -0.04 | -0.02 | -0.02 | -0.02 | -0.02 | 0.39 | 30.1 / 29.7 / 33.7 / 29.8 | 0.50 | - |
| skin, no contact shadow | 71 | 1.0 / 1.0 | -0.21 | -0.05 | -0.05 | -0.05 | -0.05 | -0.05 | -0.05 | 0.40 | 0.0 / 2.8 / n/a / 2.8 | 0.50 | - |
| paper, no contact shadow | 71 | 1.0 / 1.0 | -0.21 | +0.07 | +0.07 | +0.07 | +0.07 | +0.08 | +0.08 | 0.40 | 0.0 / 2.1 / n/a / 2.2 | 0.50 | - |
| paper, no contact shadow, tilt 30 | 71 | 1.0 / 1.0 | -0.08 | -1.10 | -1.10 | -1.08 | -1.08 | -0.52 | -0.52 | 0.39 | 30.1 / 27.0 / 31.0 / 30.2 | 0.00 (wrong) | - |

Main findings (SIMULATED):

1. **Centre, flat, good light:** the refined ellipse is within 0.15 % of the truth at 1280 px. The production detector
   reads 0.2 to 0.6 % small (its edge sits slightly outward), and 1.3 to 1.6 % small on dark skin. Error falls with
   resolution: -0.12 % at 1280 px, -0.09 % at 1920 px, -0.06 % at 12 MP. Error grows with distance: -0.05 % at 200 mm,
   -0.27 % at 500 mm (43 px).
2. **Position in the frame is the largest single-image error, and the coin's thickness causes it.** Seen obliquely
   (11 to 35 degrees off-axis), the 1.5 mm wall joins the silhouette and lengthens the major axis. D / major then reads
   -0.8 % at a quarter of the way to the corner and -4.2 % at 0.85 of the way. A 0.02 mm "coin" at the same place is
   exact (test).

   The perspective-exact cone fixes most of it: -0.07 to -0.34 %. The 3D cylinder outline fit with known intrinsics
   brings it within 0.3 %, and it also recovers the tilt to within about 1 degree. The same cone correction with the
   app's assumed field of view does as well as with the true one here (the correction depends little on f).
3. **Lens distortion** (k1 = -0.08, an assumed moderate barrel): uncorrected, the raw ellipse is up to +3.7 % off at
   the corner. Undistorting with a known model removes it. Without intrinsics there is no correction, so put the coin
   near the image centre.
4. **Tilt:**
   - The major-axis scale holds to -0.5 % up to 40 degrees. The 3D fit holds to +0.4 %.
   - The axis-ratio tilt reads 2.1 to 3.6 degrees low (the wall again). The wall-corrected tilt is within 1.7 degrees
     (from 20 degrees up), and the 3D-fit tilt within 1.0 degree.
   - At 0 degrees, edge noise alone reads 1 to 7 degrees of spurious tilt from the axis ratio, and up to 11 degrees from
     the 3D fit under blur (production smooths tilt over frames for this reason).
   - **At 45 degrees the production detector fails**: its `min_axis_ratio` of 0.75 allows at most about 41 degrees, and it
     returned a wrong ellipse. The refinement then fails its gates (`rim_occluded`).
5. **Blur and noise:**
   - Blur sigma 2 px gives -0.4 %; noise sigma 16 gives -0.4 %.
   - At blur sigma 3.5 px the gates refuse it (`blurry`, `poor_fit`).
6. **Glare:** a highlight on the face does not move the rim edge (+0.2 %). A highlight reaching the rim is +0.02 % on
   skin. The production glare gate was not triggered by these highlights.
7. **Occlusion:**
   - A finger over 10 % of the rim is harmless (-0.02 %).
   - At 25 % the result is still good (-0.2 %), but the gate refuses it: one 90-degree gap exceeds
     `max_angular_gap_deg` (60) from the config.
   - At 40 % the fit locks onto the finger: about -20 %, refused.
   - Measured occluded share = truth within 0.05.
8. **Surface:**
   - On skin and on wood the refined scale is within 0.25 %.
   - **On white paper with a contact shadow the edge moves outward by about 1 px: -2.9 %**, and the gates do not catch it.
     Without the shadow it is +0.07 %. On paper at 30 degrees without a shadow it is -1.1 % (-0.5 % with the 3D fit),
     because the dark wall band against bright paper biases the wall-side edge.
   - The production detector, which uses chroma, does better on paper with a shadow (-0.4 %). It is designed for a coin on
     skin.

   The shadow model (1 mm, 25 %) is an assumption, so the size of the paper effect is uncertain. Its direction is not.
9. **Claimed versus actual:** the claimed one-sigma (about 0.4 %) covers the errors that pass the gates, except paper with
   a shadow and the uncorrected off-axis / distortion cases. Those biases are not in the budget, so use the corrected
   scales and the capture rules below.

## The 3D consequence: one global pixels-per-mm ratio is wrong for a hand (exact pinhole maths)

A camera straight above a coin on the table at distance Z magnifies a fronto-parallel length at height dz by
f / (Z - dz). The coin's ratio assumes f / Z, so lengths there read too long by Z / (Z - dz) - 1 (negative dz: below the
coin, too short). Tested against projected pixels.

| Z (mm) | dz = -20 | -10 | +5 | +10 | +20 | +30 | +40 |
|---|---|---|---|---|---|---|---|
| 200 | -9.09 % | -4.76 % | +2.56 % | +5.26 % | +11.11 % | +17.65 % | +25.00 % |
| 300 | -6.25 % | -3.23 % | +1.69 % | +3.45 % | +7.14 % | +11.11 % | +15.38 % |
| 400 | -4.76 % | -2.44 % | +1.27 % | +2.56 % | +5.26 % | +8.11 % | +11.11 % |
| 500 | -3.85 % | -1.96 % | +1.01 % | +2.04 % | +4.17 % | +6.38 % | +8.70 % |

The same in millimetres, at Z = 300 mm:

| Length | dz = +20 mm (back of hand, coin on table) | dz = +30 mm | dz = +40 mm | dz = -10 mm (fingertip below a palm coin) |
|---|---|---|---|---|
| 85 mm palm breadth | +6.07 mm | +9.44 mm | +13.08 mm | -2.74 mm |
| 190 mm hand length | +13.57 mm | +21.11 mm | +29.23 mm | -6.13 mm |
| 18 mm finger width | +1.29 mm | +2.00 mm | +2.77 mm | -0.58 mm |

Tilted views are worse. With the camera 300 mm from the coin, error of using the coin's ratio at table points 100 mm
nearer to (y = -100) or farther from (y = +100) the camera:

| View | y = -100 | -50 | 0 (coin) | +50 | +100 |
|---|---|---|---|---|---|
| overhead (90 degrees), table plane | 0 | 0 | 0 | 0 | 0 |
| overhead, 30 mm above the table | +11.1 % | +11.1 % | +11.1 % | +11.1 % | +11.1 % |
| 60 degrees, table plane | +20.0 % | +9.1 % | 0 | -7.7 % | -14.3 % |
| 60 degrees, 30 mm above the table | +33.9 % | +20.5 % | +9.5 % | +0.3 % | -7.4 % |
| 45 degrees, table plane | +30.8 % | +13.4 % | 0 | -10.5 % | -19.1 % |

So a 2D coin ratio is only right at the coin's own depth. A hand is 20 to 40 mm thick and spans 200 mm: its scale differs
by several to tens of percent from point to point. Metric 3D needs depth per point (multi-view geometry) with the coin
fixing one global scale of that 3D scene.

## The coin as the scale of a multi-view scene (SIMULATED)

**Setup.** `COIN_STUDY=full COIN_TRIALS=20 npx vitest run --no-file-parallelism src/experimental/coin/sceneScale.test.ts --testTimeout=1800000`.

- **Scene:** coin on a table, cameras on an orbit at 300 mm, 1280 x 720, 69.4 degrees.
- **Unknown scale:** the given translations multiplied by 0.0371 scene units per mm.
- **Outline points:** 180 per rim on the exact cylinder silhouette, with Gaussian noise along the normal.
- **Baseline:** 4 views, 60 degree elevation, 90 degree azimuth span, 0.3 px edge noise, `auto` model.
- **Reported:** the error of mm-per-unit against 1 / s, over 20 trials.

| Case | trials (failed) | mean err % | sd % | worst abs % | claimed fit sigma % | claimed total sigma % | model chosen |
|---|---|---|---|---|---|---|---|
| baseline: 4 views, 60 deg up, 90 deg span, 0.3 px | 20 (0) | +0.010 | 0.044 | 0.091 | 0.047 | 0.342 | cylinder 20 |
| 2 views | 20 (0) | +0.021 | 0.063 | 0.127 | 0.062 | 0.375 | cylinder 20 |
| 3 views | 20 (0) | +0.011 | 0.052 | 0.118 | 0.053 | 0.351 | cylinder 20 |
| 6 views | 20 (0) | +0.015 | 0.038 | 0.103 | 0.039 | 0.334 | cylinder 20 |
| 8 views | 20 (0) | +0.013 | 0.035 | 0.079 | 0.034 | 0.331 | cylinder 20 |
| 8 views all round (360 deg) | 20 (0) | +0.009 | 0.023 | 0.067 | 0.023 | 0.485 | cylinder 20 |
| azimuth span 10 deg | 20 (0) | +0.004 | 0.059 | 0.127 | 0.074 | 0.306 | cylinder 20 |
| azimuth span 30 deg | 20 (0) | +0.008 | 0.050 | 0.101 | 0.054 | 0.306 | cylinder 20 |
| azimuth span 180 deg | 20 (0) | +0.008 | 0.030 | 0.060 | 0.036 | 0.450 | cylinder 20 |
| elevation 85 deg (nearly overhead) | 20 (0) | -0.017 | 0.060 | 0.147 | 0.050 | 0.261 | cylinder 18, top 2 |
| elevation 40 deg (low) | 20 (0) | +0.006 | 0.041 | 0.084 | 0.047 | 0.461 | cylinder 20 |
| elevations 45 and 80 mixed | 20 (0) | +0.016 | 0.037 | 0.078 | 0.039 | 0.304 | cylinder 20 |
| edge noise 0.1 px | 20 (0) | +0.001 | 0.015 | 0.032 | 0.016 | 0.339 | cylinder 20 |
| edge noise 0.5 px | 20 (0) | +0.027 | 0.073 | 0.142 | 0.079 | 0.348 | cylinder 20 |
| edge noise 1 px | 20 (0) | +0.049 | 0.335 | 1.241 | 0.157 | 0.371 | cylinder 19, top 1 |
| model top only (wall ignored) | 20 (0) | **-1.162** | 0.043 | 1.267 | 0.060 | 0.258 | top 20 |
| model cylinder | 20 (0) | +0.010 | 0.044 | 0.091 | 0.047 | 0.342 | cylinder 20 |
| pose noise 0.1 deg / 0.5 mm | 20 (0) | +0.198 | 0.274 | 0.709 | 0.217 | 0.406 | cylinder 20 |
| pose noise 0.3 deg / 1 mm | 20 (0) | **+0.776** | 0.821 | 2.022 | 0.495 | 0.602 | cylinder 18, top 2 |
| pose noise 0.3 deg / 1 mm, 8 views 360 | 20 (0) | **+1.218** | 0.719 | 2.693 | 0.284 | 0.564 | cylinder 19, top 1 |

**End to end from pixels.** Four rendered views of the coin on a wooden table go through the production detector,
measureCoin and fitCoinCircle3D, with the poses scaled by the unknown factor. The recovered scale was -0.26 % off
(claimed 0.25 %), with the `top` model chosen: on wood the wall barely contrasts with the table. The test bound is 0.5 %.

Findings (SIMULATED):

* With exact poses, edge noise and the number of views hardly matter. The scatter is 0.02 to 0.07 % for 2 to 8 views and
  10 to 360 degrees of azimuth, and the fit covariance predicts it well (claimed fit sigma close to the observed sd).
* The total claimed sigma, about 0.3 to 0.5 %, is dominated by assumptions: the +-0.1 mm diameter allowance (0.25 %) and
  the +-0.5 mm assumed thickness allowance.
* **Ignoring the coin's wall biases the scale by about -1.2 % at 60 degrees elevation.** Model it (cylinder), which needs
  the thickness.
* **Pose error dominates.**
  - At 0.3 degrees and 1 mm per camera, the scale is biased by +0.8 to +1.2 % with 0.7 to 0.8 % scatter, and more views
    did not remove the bias.
  - The fit covariance does not include pose error: it claims 0.3 to 0.5 % where the worst case was 2.7 %.
  - Stage 3 (board-free structure from motion) must therefore deliver sub-0.1-degree poses, or the coin must enter the
    bundle adjustment jointly (rims as observations) rather than be fitted after it.

## Recommended capture rules for the coin

| Rule | Why (SIMULATED evidence above) |
|---|---|
| **3D / multi-view route: coin flat on the table beside the hand**, fully visible, in every view | Rigid with the scene (a palm coin moves with the hand between views, which breaks structure from motion); flat on the support plane, which also gives the table plane; never covered by fingers; seen from many angles, so its 3D circle is well determined. |
| **Single-image route (production today): coin flat on the palm** | Its plane is then the palm's plane, so the single-image scale is right there (but still not at the knuckles or fingertips, see the 3D tables); the skin background suits the production chroma detector. |
| Coin near the **image centre**, at least 3 mm from the frame | Off-axis, the coin wall inflates the major axis (-0.8 to -4.2 % at 0.25 to 0.85 of the way to the corner); uncorrected lens distortion adds up to about 4 %; `rim_outside_image` gate. |
| Phone roughly **parallel** to the coin (tilt below about 30 degrees; never above 40) | The production detector cannot see coins tilted beyond about 41 degrees (`min_axis_ratio`); axis-ratio tilts are biased by the wall. |
| **No fingers on the rim** (less than 10 %) | A single gap over 60 degrees (about 17 % of the rim) or more than 30 % missing is refused; the fit locks onto a finger at 40 %. |
| **Avoid plain white paper under harsh light**: prefer skin, wood or a mid-tone surface, with diffuse light | A contact shadow on bright paper moved the edge outward: -2.9 % that no gate caught. |
| Coin **at least 70 px across** (about 300 mm or nearer for 1280 px video; a 12 MP still for finer work) | The error grows from -0.05 % at 107 px to -0.27 % at 43 px; production refuses below 40 px. |
| **Sharp** image (edge width below 6 px) | `blurry` gate; blur sigma 2 px already costs about 0.4 %. |
| Use **the same physical coin type** that the config describes; reject older 27 mm coins (the config has `size_check`) | A wrong coin is a 17 % scale error that no image check can see. |

## Coin thickness (finding)

**UNVERIFIED.** No primary official source that could be read states the thickness of the 2019-series 2-rupee coin. All
sources below were read on 2026-11-08.

* **Gazette notification G.S.R. 184(E), 6 March 2019** ("Coinage of One Rupee, Two Rupees, Five Rupees, Ten Rupees and
  Twenty Rupees Rules, 2019", Ministry of Finance, Department of Economic Affairs).
  - The official e-Gazette PDF could not be fetched: egazette was not reachable in search, and indiacode.nic.in and
    pib.gov.in refused automated access.
  - Two independent reproductions of the text agree word for word:
    https://taxguru.in/rbi/notification-nog-s-r184edated06-03-2019.html and
    https://www.legitquest.com/act/coinage-of-one-rupee-two-rupees-five-rupees-ten-rupees-and-twenty-rupees-rules-2019/9080
  - What they state for the 2-rupee coin: "Circular 23 Milli-meters"; "50 wider serrations on edge"; ferritic stainless
    steel (iron 83 %, chromium 17 %, chromium remedy 16 to 18 %); standard weight 4.07 g with a remedy of +-1/25
    (3.91 to 4.23 g).
  - **No thickness and no diameter tolerance.** The schedule has no thickness column.
* **Reserve Bank of India** (primary): none of these pages gives a thickness or covers the 2019 coin's thickness.
  - The coins page https://www.rbi.org.in/commonman/English/Currency/scripts/AllCoins.aspx lists only an older 27 mm
    2-rupee coin and has no thickness column.
  - The FAQ https://www.rbi.org.in/commonman/Upload/English/FAQs/PDFs/INDIANCURRENCY15042025.pdf gives no dimensions.
  - The 2011-series press release https://rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=24773 has no thickness.
* **SPMCIL / India Government Mint** (primary): no thickness field.
  - https://spmcil.com/wp-content/uploads/2024/05/Re-1-Till-AKAM-Series-2022.pdf covers only 1-rupee coins: metal,
    weight, shape and size.
  - https://igmhyderabad.spmcil.com/en/information/ has no diameter or thickness column and no 2019 entry.
* **Secondary only:** Numista #161817 / KM #512 (as repeated by https://www.stashofcoins.com/coin/17081-india-2-rupees-2019)
  gives 1.5 mm. The Numista and UCoin pages themselves could not be opened (HTTP 403). Wikipedia gives no thickness.

**Consequences:**
* The config is correct to keep `thickness_mm: null`. It was not edited.
* This study uses production's documented assumption `calibration.custom_reference_thickness_mm` (1.5 mm) with an
  assumed +-0.5 mm allowance, labelled `thicknessSource: "assumed"`.
* The thickness matters: it sets the top-face to surface correction (about 0.5 % at 300 mm) and the cylinder outline
  model (about 1.2 % if ignored in oblique multi-view).

**How to measure it** (before any field use): measure 10 or more circulating 2019 coins from different years and mints
with a calibrated digital caliper (0.01 mm resolution, zeroed, checked on a gauge block).
* Thickness at the **rim**, at 3 positions 120 degrees apart: the raised rim is what forms the silhouette. Also measure
  the outside diameter at 3 angles.
* Report the mean, standard deviation and range per year, and enter the value and its spread in the config with the
  measurement record as its source.

## Limitations

* **All numbers are SIMULATED.** The renderer is an ideal flat-faced cylinder, with:
  - no edge serrations (the real coin has 50), no rim bevel and no real relief;
  - procedural skin, paper and wood;
  - a simple contact shadow and a Gaussian highlight;
  - no JPEG, tone curve, sharpening, rolling shutter, defocus variation or real lens.

  Real edges will be worse. Serrations and the rim bevel in particular are not modelled.
* The `edge_bias` (+-0.25 px), `uncertain_scale` (3 %) and thickness (+-0.5 mm) allowances are assumptions. The paper
  shadow bias and uncorrected off-axis or distortion effects are outside the budget.
* The production detector was run on crops around the coin, the way production uses a region of interest. Full-frame
  detection behaviour, including false coins elsewhere, was not studied.
* With intrinsics, the lens model's own error is not propagated. Browsers give no intrinsics. The assumed field of view
  serves for the small perspective correction, but not for undistortion.
* `fitCoinCircle3D` takes poses as exact. Its covariance ignores pose error, which the study shows dominates. Joint
  bundle adjustment with the rim is the next step (stage 3).
* The tilt-sign hint from the wall is unreliable (wrong on paper in simulation).
* Not run in a browser or on a phone; no timing on devices. In Node one scenario (render plus measureCoin on a crop of
  about 300 px, including the 3D outline fit) took roughly 0.1 to 0.5 s; this was not profiled.
