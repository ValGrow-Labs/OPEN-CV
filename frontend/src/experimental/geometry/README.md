# Camera geometry and metric scale for multi-view hand reconstruction

**EXPERIMENTAL. MODEL-BASED. UNVALIDATED.** Nothing in this folder is used by the customer flow, the scan, the coin
pipeline or the sizing, and nothing here changes a production setting or the calibration. Every number below is
arithmetic on stated assumptions, or the result of a test on a *synthetic* camera with known ground truth. **No physical
reference measurement has been made, so no real-world accuracy is claimed anywhere in this document.**

The production scale (`backend/glovesize/calibration.py`, `frontend/src/vision/liveChecks.ts`) is only *read* here
(assumed field of view `uncertainty.assumed_hfov_deg` = 55 to 80 degrees, the reference diameters and their allowances in
`config/reference_objects.json`, the 0.5 px edge floor `calibration.diameter_edge_floor_px`). A test keeps the copies of
those values equal to the config files.

| File | What it is |
|---|---|
| `camera.ts` | intrinsics from a field of view, radial distortion, projection, poses (compose, invert, Rodrigues, look-at), reprojection error, focal-length sensitivity |
| `coinScale.ts` | what a coin gives (scale, tilt, distance of its own plane) and what it cannot; the options for a full pose |
| `pnp.ts` | homography and camera pose from at least four coplanar points of known size |
| `uncertainty.ts` | the error budget for one length measured from one image |
| `resolution.ts` | pixels needed for a target mm/px; what the app's own video gives |
| `poseConsistency.ts` | whether the hand kept the same pose across views |
| `linalg.ts` | small matrix helpers and a seeded random generator for synthetic tests |

Convention (from `../common.ts`): world in millimetres, camera x right, y down, z forward; `Xc = R X + t`;
`u = fx x_d + cx`, `x = Xc.x / Xc.z`, `x_d = x (1 + k1 r^2 + k2 r^4)`.

---

## 1. What an ordinary phone browser knows about its camera

`getUserMedia` gives pixels and the track's width and height. It gives **no focal length, no principal point, no lens
distortion and no EXIF**. The app therefore assumes a horizontal field of view of 55 to 80 degrees (applied to the longer
image side, as `liveChecks.ts` does), square pixels, the principal point at the image centre and no distortion.
`intrinsicsFromHfov(width, height, fov, "long" | "width")`: `fx = (side / 2) / tan(fov / 2)`.

Two further facts matter for multi-view work: autofocus changes the focal length slightly ("focus breathing"), and the
video is compressed and may be cropped or digitally stabilised by the phone, which changes the effective intrinsics.

**What a wrong focal length costs** (`focalLengthSensitivity`). The in-plane scale at the coin, `D / major_px`, does *not*
depend on the focal length. The focal length enters through the distance, `Z = fx D / major_px`, and the distance is what
turns "the coin's plane" into "another plane" (the hand's thickness, a fingertip, another view). The scale at a plane `dz`
farther away is `mm/px * (Z + dz) / Z`. With a relative focal error `e`, the corrected scale is wrong by
`F(Z (1 + e)) / F(Z) - 1`, `F(z) = (z + dz) / z`.

Worked example: `e = +10 %`, `Z = 350 mm`, `dz = 15 mm`, `L = 190 mm`: the distance is wrong by 35 mm, the corrected
scale by **-0.375 %**, and the length by **about -0.71 mm**. With `dz = 0` it is exactly 0.

## 2. What one coin gives, and what it does not

`coinPlaneScale(ellipse, referenceDiameterMm)` re-expresses the existing detection (it never recomputes the production scale):

* `mmPerPxMajor = D / major_px`: the true in-plane scale along the ellipse's major axis.
* `tiltDeg = acos(minor / major)`; `mmPerPxMinorApparent = D / minor_px` is larger by `1 / cos(tilt)`.
* `distanceMm = fx D / major_px` (and a range for the assumed 55-80 degrees).

**Limits (stated in code as `LIMITS_OF_ONE_CIRCLE`):**

1. A circle gives the scale and tilt of **its own plane** only. A point `dz` farther away has a scale larger by `(Z + dz) / Z`.
2. The tilt is an angle without a sign: lean toward or away from the camera gives the same ellipse (tested: mirrored cameras image identical axes).
3. The turn of the coin about its own normal is invisible, so a circle gives **no in-plane orientation, hence no full camera pose**.
4. The distance needs the focal length, which is assumed.

So the coin is a **scale** reference for one plane. It cannot register several views to one another. `requiredReferenceForPose()` lists
what could: a printed planar marker grid, four or more coplanar points of known size (for example a sheet of paper's corners),
the coin plus the hand's landmarks (weak), a WebXR/ARCore session on Android (platform dependent), the gyroscope (rotation
only). **None of these exists in the product.**

## 3. Pose from known coplanar points (`pnp.ts`)

`poseFromPlanarPoints(K, worldPoints, imagePoints)`: normalised-DLT homography (Hartley and Zisserman, section 4.4), decomposition
with the known intrinsics (`r1 = lambda h1`, `r2 = lambda h2`, `r3 = r1 x r2`, nearest rotation by polar decomposition), then a
Levenberg-Marquardt refinement of the reprojection error, with distortion. Tested on synthetic cameras with known poses: exact
from noise-free points and from the minimum of four points; correct with known distortion; refuses too few or collinear points.

**Synthetic noise test (Gaussian pixel noise, 50 draws, camera 340 mm away, 70 degree field of view; synthetic only):**

| Target (7x7 or 4x4 grid) | Noise | Rotation error mean / max | Camera-position error mean / max |
|---|---|---|---|
| 60 mm across (4x4 at 20 mm) | 0.3 px | 0.39 / 1.08 degrees | 2.4 / 6.8 mm |
| 180 mm across (7x7 at 30 mm, sheet size) | 0.3 px | 0.07 / 0.13 degrees | 0.43 / 0.83 mm |
| 300 mm across (7x7 at 50 mm) | 0.3 px | 0.03 / 0.06 degrees | 0.19 / 0.41 mm |
| 180 mm across | 1.0 px | 0.22 / 0.42 degrees | 1.4 / 2.8 mm |

**The extent of the reference matters more than its point count**: a hand-sized (60 mm) target gives 8 times the position error
of a sheet-sized one for the same noise. A coin (24 mm) is far too small to carry a pose even if it could. When the plane is within
10 degrees of fronto-parallel two poses fit almost equally well and noise can flip the tilt (Collins and Bartoli 2014);
the result carries an `ambiguityWarning`. These numbers show that the *maths* works on ideal synthetic input; they say
nothing about marker detection on a real phone image, which adds its own error.

## 4. The error budget for one length (`estimateMeasurementUncertainty`)

All terms are one-sigma, in millimetres on the measured length `L`; a bounded allowance `+-a` becomes `a / sqrt(3)`
(uniform distribution, JCGM 100:2008 section 4.3.7); known-size systematic errors are added at full size (conservative);
terms combine by root-sum-square. Every term is marked `basis: "model"`.

| Term | Formula | Note |
|---|---|---|
| (a) coin edge | `L sqrt(2) sigma_edge / major_px` | both ends of the diameter; default 0.5 px = the production edge floor |
| (b) reference diameter | `L (u / sqrt(3)) / D` | `u` = the object's `diameter_uncertainty_mm` (an *assumed* allowance, not an official tolerance) |
| (c) plane offset | `L dz / Z` uncorrected; `L residual / Z` corrected | hand thicker than the coin's plane; default dz 15 mm |
| (d) tilt | `L (1 - cos tilt)` | a length leaning out of the image plane |
| (e) lens distortion | `L abs(k1) abs(r_meas^2 - r_coin^2) / sqrt(3)` | zero without a known k1 |
| (f) boundary | `sqrt(2) sigma_boundary_px mm/px` | one silhouette edge at each end of the length |
| (g) focal assumption | `L abs(F(Z(1+e)) / F(Z) - 1)`, `e` = half-range / sqrt(3) | only when the plane offset is *corrected* from the distance; the half-range of the app's 55-80 degree assumption is 0.234 |

**Plane offset in numbers** (relative scale error `dz / Z`, on a 190 mm length):

| dz | Z = 250 mm | Z = 350 mm | Z = 500 mm |
|---|---|---|---|
| 10 mm | 4.0 % = 7.6 mm | 2.9 % = 5.4 mm | 2.0 % = 3.8 mm |
| 25 mm | 10.0 % = 19.0 mm | 7.1 % = 13.6 mm | 5.0 % = 9.5 mm |

**Worked budgets** (hand length 190 mm; US quarter 24.26 mm +-0.05 mm; Z = 350 mm; one-sigma, model-based):

| Case | coin edge | diameter | plane offset | tilt | distortion | boundary | focal | **Combined** |
|---|---|---|---|---|---|---|---|---|
| A. 0.2 mm/px, dz 15 mm uncorrected | 1.11 | 0.23 | 8.14 | 0 | 0 | 0.28 | 0 | **8.2 mm (4.3 %)** |
| B. as A, offset corrected, residual 5 mm | 1.11 | 0.23 | 2.71 | 0 | 0 | 0.28 | 0.93 | **3.1 mm (1.6 %)** |
| C. as B, residual 2 mm, tilt 5 degrees, k1 = -0.05 | 1.11 | 0.23 | 1.09 | 0.72 | 1.32 | 0.28 | 0.93 | **2.4 mm (1.3 %)** |
| D. 0.1 mm/px (coin 242.6 px), uncorrected | 0.55 | 0.23 | 8.14 | 0 | 0 | 0.14 | 0 | **8.2 mm (4.3 %)** |
| E. 0.1 mm/px, offset corrected, residual 2 mm | 0.55 | 0.23 | 1.09 | 0 | 0 | 0.14 | 0.93 | **1.6 mm (0.8 %)** |
| F. as A with the length tilted 10 degrees | 1.11 | 0.23 | 8.14 | 2.89 | 0 | 0.28 | 0 | **8.7 mm (4.6 %)** |

The budget leaves out the soft tissue and pose variation of the hand itself, and the skin-boundary blur (which `boundary`
only represents as a sigma). It is a way to see **which error dominates**, not a prediction of accuracy.

## 5. Resolution: what 0.1 mm per pixel needs, and what the app has

`requiredResolutionForMmPerPx(target, distance, fov)`. The width of the scene on the hand is `2 d tan(fov / 2)` and does not
depend on the pixel count; the pixels needed are that width divided by the target; `fx = d / target`.

**For 0.1 mm per pixel on the hand (computed by `buildResolutionTable`):**

| Distance | Field of view (long side) | Field on the hand | fx needed | Image long side | 4:3 megapixels |
|---|---|---|---|---|---|
| 250 mm | 55 degrees | 260 mm | 2500 px | 2603 px | 5.1 |
| 250 mm | 69.4 | 346 mm | 2500 px | 3462 px | 9.0 |
| 250 mm | 80 | 420 mm | 2500 px | 4195 px | 13.2 |
| 350 mm | 55 | 364 mm | 3500 px | 3644 px | 10.0 |
| 350 mm | 69.4 | 485 mm | 3500 px | 4847 px | 17.6 |
| 350 mm | 80 | 587 mm | 3500 px | 5874 px | 25.9 |
| 500 mm | 55 | 521 mm | 5000 px | 5206 px | 20.3 |
| 500 mm | 69.4 | 692 mm | 5000 px | 6924 px | 36.0 |
| 500 mm | 80 | 839 mm | 5000 px | 8391 px | 52.8 |

(69.4 degrees is a typical main camera, about 26 mm in 35 mm terms.) Example from the brief: at 350 mm `fx = 3500 px`, so a
4032 px-wide still has a 403 mm field and exactly 0.1 mm/px.

**The app's own video** (phones ask for 1280 x 720, `src/camera/camera.ts`; assumed field of view 55 to 80 degrees):

| Distance | Field 55 / 80 degrees | mm per pixel | US quarter (24.26 mm) in pixels | Indian 2-rupee (23.00 mm) in pixels |
|---|---|---|---|---|
| 250 mm | 55 | 0.203 | 119 | 113 |
| 250 mm | 80 | 0.328 | 74 | 70 |
| 350 mm | 55 | 0.285 | 85 | 81 |
| 350 mm | 80 | 0.459 | 53 | 50 |
| 500 mm | 55 | 0.407 | 60 | 57 |
| 500 mm | 80 | 0.656 | 37 | 35 |

**A correction to a number in the brief.** The coin lies in the palm, so its scale *is* the scale of the hand's plane: the
quarter is **not** imaged finer than the hand. About 0.2 mm/px on the coin occurs only when the camera is as near as 250 mm *and*
the narrower assumed field of view is right; at a typical 350 mm the app's video gives **0.28 to 0.46 mm/px** on both. (The sample
photo used in the tests is a close-up and so reads about 0.2 mm/px.) Reaching 0.1 mm/px needs roughly 2 to 3 times the resolution
along each side, i.e. a phone's full-resolution still image, not the 1280 px video.

### Pixel resolution is not measurement accuracy

0.1 mm per pixel says how fine the grid is. It does not say where the edge is. The errors that do **not** shrink with pixel size:

* **Boundary position.** `+-1 px` is `+-0.1 mm` *only if* the edge were perfect. A skin edge is blurred over 2 to 5 pixels by optics, motion, hair, soft shadow and compression. A segmentation mask is typically wrong by one or more pixels along the boundary, and a finger gap closes up when it is narrower than a few pixels.
* **Plane offset.** A hand 15 mm thicker than the coin's plane at 350 mm changes the scale by 4.3 %, about **8 mm on 190 mm**: eighty times the "0.1 mm" target (case D above: halving the pixel size, 0.2 to 0.1 mm/px, moves the combined budget from 8.23 mm only to 8.17 mm).
* **Tilt.** A length 10 degrees out of the image plane is short by 1.5 %, about 2.9 mm.
* **The coin.** The diameter's own tolerance (0.05 mm on 24.26 mm is 0.2 %) and its edge position set the scale for everything.
* **Lens distortion and the assumed focal length** are not known on a browser camera.
* **The hand is soft.** Finger spread, pose and skin compression change a length by millimetres whatever the pixel size.

Even with the plane offset corrected and no tilt (case E), the budget is about 1.6 mm, **not** 0.1 mm.

## 6. Can the hand hold a consistent pose across views? (`poseConsistency`)

The comparison uses quantities that do not change when a hand is turned: bone lengths relative to the wrist-to-middle-knuckle
length, the bend at each finger joint, and how cupped the palm is. It needs **3D landmarks (MediaPipe world landmarks, a model
estimate)**. From 2D image landmarks, bone lengths foreshorten with the viewing direction, so differences could be the camera's,
not the hand's; such input is accepted but marked `reliable: false`.

Each view is compared with the median view (with two views, with the other view, so both are flagged together). Default
tolerances, stated assumptions of the order of MediaPipe's own noise, not validated limits: bone-length ratio 8 %, joint bend
20 degrees, palm cupping 6 % of hand size. Tests use an invented, flat, open hand (labelled synthetic): rotations and
sub-millimetre noise raise no flag; a bent finger, a finger 15 % longer, or a cupped palm in one view is flagged for the right
reason.

**Not known, and needing real captures:** how steady a real hand is across four views taken over tens of seconds, how much
MediaPipe's world landmarks wander between views of the same pose, and whether the tolerances separate "the hand moved" from
"the model is noisy".

## 7. Feature matching and pose from motion: an assessment (analysis, not an implementation)

**Why skin is a poor source of features.** The classical detectors (Harris and Stephens 1988; SIFT, Lowe 2004; ORB, Rublee et al. 2011;
learned ones such as SuperPoint, DeTone et al. 2018) need corners or blobs that look the same from another direction.
A hand is smooth, low contrast and nearly uniform in colour; the few skin features (palm creases, knuckle wrinkles, hair, freckles)
are small, change with viewpoint and finger bend, and are blurred by video compression. Skin is also *translucent and shiny*, so
highlights move across it as the camera moves and are matched as if they were fixed points. And a hand is *non-rigid*: if the hand
turns or a finger moves between views, matches on it violate the rigid-scene assumption that structure from motion relies on.

**Two ways to move.** *Camera moves around a still hand* (hand resting on a table): a rigid scene, but the poses must come from
something other than the skin, such as a textured sheet or a marker under the hand. *Hand turns in front of a still camera*: the
hand is the only moving thing, poses are unknown and non-rigid motion corrupts them; this is the harder case and is not
recommended as a basis for metric reconstruction.

**What a printed marker adds.** A planar marker grid (ArUco, Garrido-Jurado et al. 2014; AprilTag, Olson 2011) gives a full pose
per view in one metric frame, from the same plane-based pose maths as section 3, with scale from the printed size and robust
detection without any hand features. Its cost is practical: printing at exactly the right scale, flat placement, and enough extent
(section 3 shows that a sheet-sized target is about 8 times better than a hand-sized one). The bundled OpenCV.js build has not been
checked for a marker module.

**What ARCore and ARKit would add.** Visual-inertial tracking gives metric camera poses without any marker. ARCore (Android, via WebXR
`immersive-ar`) is reachable from Chrome on Android on supported phones; its depth is documented for roughly 0.5 m to 5 m, coarser
than a hand needs, and some devices add a time-of-flight sensor. ARKit scene depth (LiDAR) exists on some iPhones and iPads but is
**not exposed to web pages** (Safari has no WebXR AR), so it needs a native app. Raw camera frames are not available to a WebXR page
by default. None of this can be relied on for ordinary phones, and none of it can be tested without devices.

**What is realistic with only `getUserMedia` frames.** Pose from a printed planar target (section 3, plus detection); possibly pose from
a textured background with a coin for scale (structure from motion, Hartley and Zisserman 2003; Schonberger and Frahm 2016), which
needs a rigid, textured scene; rough rotation from the gyroscope (a permission prompt on iOS, drifts, no translation). The video is
compressed, may be rolling-shutter and auto-exposed, and the focal length is only assumed. Multi-view silhouette work needs
poses good to well under a degree and a millimetre: section 3 shows that is arithmetically possible with a sheet-sized target and
sub-pixel corners; whether a real phone image delivers that is open.

## 8. What needs real data to settle

1. The real field of view and distortion of the phones used (a calibration from a checkerboard per device model), and how much they
   change with focus.
2. The real error of marker or sheet-corner detection on phone video (pixel noise is *assumed* 0.3 to 1 px above).
3. The real plane offset between the coin and the outline of a hand (thickness at the palm edge, fingers, knuckles) on several
   hands, and how well a correction removes it.
4. The real edge blur of skin boundaries (it sets the boundary term in section 4).
5. The real consistency of a hand across views (section 6).
6. Every term of the budget, against a ruler or caliper on the same hands. Until then the budget is a model.

## 9. References

* Hartley, R., Zisserman, A. *Multiple View Geometry in Computer Vision*, 2nd ed., Cambridge University Press, 2003.
* Zhang, Z. A flexible new technique for camera calibration. *IEEE TPAMI* 22(11), 2000.
* Brown, D. C. Close-range camera calibration. *Photogrammetric Engineering* 37(8), 1971 (radial distortion).
* Collins, T., Bartoli, A. Infinitesimal plane-based pose estimation. *IJCV* 109, 2014.
* Lepetit, V., Moreno-Noguer, F., Fua, P. EPnP: an accurate O(n) solution to the PnP problem. *IJCV* 81, 2009.
* Garrido-Jurado, S. et al. Automatic generation and detection of highly reliable fiducial markers under occlusion. *Pattern Recognition* 47(6), 2014 (ArUco).
* Olson, E. AprilTag: a robust and flexible visual fiducial system. *ICRA* 2011.
* Harris, C., Stephens, M. A combined corner and edge detector. *Alvey Vision Conference* 1988.
* Lowe, D. G. Distinctive image features from scale-invariant keypoints. *IJCV* 60(2), 2004.
* Rublee, E. et al. ORB: an efficient alternative to SIFT or SURF. *ICCV* 2011.
* DeTone, D., Malisiewicz, T., Rabinovich, A. SuperPoint: self-supervised interest point detection and description. *CVPR Workshops* 2018.
* Schonberger, J. L., Frahm, J.-M. Structure-from-motion revisited. *CVPR* 2016.
* Zhang, F. et al. MediaPipe Hands: on-device real-time hand tracking. arXiv:2006.10214, 2020.
* JCGM 100:2008, *Evaluation of measurement data: Guide to the expression of uncertainty in measurement* (the uniform-distribution rule, section 4.3.7).
* W3C Immersive Web Working Group, *WebXR Device API* and *WebXR Depth Sensing Module*; Google, *ARCore Depth API* documentation (to be re-read for current supported devices and ranges).

## Running the tests

`npx vitest run --no-file-parallelism src/experimental/geometry` (from `frontend/`). All camera and landmark inputs in the tests are
synthetic; they check the arithmetic and the logic, not any real camera or hand.
