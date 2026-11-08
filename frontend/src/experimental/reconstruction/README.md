# Experimental multi-view hand reconstruction (`reconstruction/`, `depth/`)

> **EXPERIMENTAL AND UNVALIDATED.** Isolated from the customer flow, the scan, the coin pipeline and the sizing. Nothing
> in these folders has been compared with a physical measurement. Every number below comes from a **synthetic**
> capsule hand whose dimensions are known exactly; it shows the mathematics works and how errors in the inputs propagate.
> It says **nothing** about real hands, real phones, real segmentation or real accuracy, and must never be quoted as such.

## The pipeline

```
masks + camera poses ──► carveVisualHull ──► (optional capsule prior) ──► occupancyToField ──► extractMesh
        (BinaryMask, Intrinsics, CameraPose)         (carving.ts)            (prior.ts)         (meshing.ts)
                                                                                                   │
   measureHand ◄── reconstructionQuality (gates) ◄── vertexConfidence ◄── taubinSmooth + small-component removal
   (measure.ts)         (quality.ts)                    (quality.ts)              (meshing.ts)
```

`reconstructHand(views, bounds, options)` (pipeline.ts) runs the chain. **It assumes the camera poses and intrinsics are
known and correct.** Estimating them from real phone footage (hands are low-texture and not rigid) is *not* solved here:
see "What real captures must prove".

Depth side (`depth/`, `pointcloud.ts`): `detectDepthCapabilities`, `probeDepthSensing`, `surfaceFromDepth`,
`backprojectDepth`, `icp`, `fuseClouds`, `triangulateDepthGrid`.

## Conventions

* World: millimetres, right-handed. Camera: OpenCV style (x right, y down, z forward); `Xc = R * X + t`,
  `u = fx * Xc.x / Xc.z + cx` (pixel centres at +0.5; optional radial `k1`, `k2`). Types live in `../common.ts`.
* Hand frame (the synthetic hand and `HandFrame`): origin at the centre of the wrist plane, `+y` toward the fingers,
  `+z` out of the palm, `+x` toward the little finger.
* A `Quantity` is `{ value, unit, basis, note }`. `basis: "direct"` = geometry of the reconstruction given the hand frame;
  `"model"` = also rests on something that is not mesh geometry (a frame from a landmark detector, an assumed knuckle
  line); `"none"` = not available (the note says why). **"direct" never means accurate.**

## What each stage can and cannot do

| Stage | Can | Cannot |
|---|---|---|
| **Visual hull** (carving.ts) | Gives the largest shape consistent with all silhouettes, so it is never smaller than the hand (up to mask error). Needs only masks and poses. A tolerance `k` lets a voxel miss `k` silhouettes. | Recover concavities (the hollow of the palm, the web between thumb and index seen edge-on). Open a finger gap that no view looks through. Observe thickness from two opposite views (a prism the size of the search volume). Tell the thumb from the palm in a side view (phantom volume above the palm). Survive wrong poses: errors carve the hull away (see table). |
| **Meshing** (meshing.ts) | Marching tetrahedra (own code, no licence): watertight, sub-voxel surface from a blurred occupancy; Taubin smoothing without shrinkage; component removal; topology report (holes, non-manifold edges, Euler characteristic). | Add detail the grid does not have. Smoothing moves the surface by a fraction of a voxel. |
| **Point-cloud tools** (pointcloud.ts) | Back-project metric depth, align clouds (Horn/Kabsch for known correspondences, trimmed ICP otherwise), voxel fusion, depth-grid triangulation that skips depth jumps. | Fix a bad starting alignment (ICP needs one). See the grazing rim of a surface from one depth map. Use relative depth (it must be metric millimetres). |
| **Quality gates** (quality.ts) | Reject too few views, a gap around the hand axis, a surface that no contour observes, a non-watertight or fragmented mesh, a mesh that disagrees with its own input silhouettes. | Detect an error shared by all inputs (a wrong scale, a systematic pose offset): see the 2 % focal row. Passing the gates is **not** accuracy. |
| **Measurement** (measure.ts) | Hand length, palm breadth, thickness, circumference at an anatomical section, five finger lengths, surface area; each a `Quantity` with its basis. | Work without a hand frame (landmarks give one) or finger axes (landmarks give those). Give a hand length from a shape-only frame. Report a circumference unless the section is one closed loop. Report an area unless the gates passed. |
| **Capsule prior** (prior.ts) | Trim phantom volume where views are incomplete, with a licence-clean model fitted to the hull outline. | Represent a real person: whatever it supplies (e.g. thickness) is its default, not the customer's value. Add surface. Replace views. MANO and learned models are **not** used (licences under review elsewhere; they also need a fitting method). |
| **Depth** (depth/) | Report honestly what a web page can reach; refuse anything that is not metric depth; return null with a reason when no depth is supplied. | Reach ARKit/LiDAR from Safari (native only). Know whether WebXR depth works without a user-initiated session request. Run alongside the scan camera (an AR session takes the camera over). |

### Anatomical conventions of the measurement engine

* **Hand length**: wrist plane to the farthest mesh point along the hand axis (the middle fingertip on a normal hand).
* **Palm breadth**: extent across the palm of the section 8 mm proximal to the knuckle line (thumb excluded).
* **Palm thickness**: palm-to-back extent of that section over its central 60 % in width (so the thumb does not count).
* **Finger length**: from the finger-axis base point (the MCP joint centre when axes come from landmarks) to the farthest
  mesh point inside a narrow cylinder around the axis. Joint-centre to skin tip, **not** the palm-crease-to-tip length a
  tape gives.
* **Circumference**: the single closed loop of the same section ("around the knuckles", thumb excluded); `null` if the
  plane cuts the mesh in several loops or an open chain.
* **Surface area**: sum of triangle areas, only if the gates passed. A hull mesh is a smoothed upper bound, not the skin.
* Needs landmarks (MediaPipe's 21 points lifted into the mesh frame): the hand frame (`frameFromLandmarks`) and finger
  axes (`fingersFromLandmarks`). Without them: `frameFromPca` gives axes only (no wrist plane, so no hand length).

## SYNTHETIC results

Hand: a capsule hand (palm 100 x 85 x 24 mm, five capsule fingers, a wrist stub); exact truth from its parameters; surface
area from a fine reference mesh of the same shape (0.8 mm grid; 56,134 mm^2). Eight possible views on a ring around the hand
(palm, thumb side, little-finger side, back, and four 45-degree views), 256 x 256 silhouettes, voxel 1.5 mm, fixed seeds.
Each cell is the **signed error** (estimate minus exact truth), millimetres (area: mm^2; the 8-view clean area error is +1,577 mm^2, +2.8 %). Re-run with
`RUN_SYNTHETIC_GRID=1 npx vitest run --no-file-parallelism src/experimental/reconstruction/experiment.test.ts`.

|  scenario  | accepted  | length mm  | breadth mm  | thickness mm  | circumf. mm  | thumb mm  | index mm  | middle mm  | ring mm  | little mm  | area mm2  |
|---|---|---|---|---|---|---|---|---|---|---|---|
|  2 views (palm, back) / none  | no (too_few_views, views_do_not_surround_hand)  | +0.0  | +1.7  | +28.5  | +56.3  | +0.2  | -0.1  | +0.0  | +0.0  | -0.2  | +30675.3  |
|  2 views (palm, back) / mask edge +-1 px  | no (too_few_views, views_do_not_surround_hand)  | +0.0  | +1.7  | +28.5  | +56.3  | +0.2  | -0.7  | +0.0  | +0.0  | -0.2  | +30634.1  |
|  2 views (palm, back) / mask edge +-2 px  | no (too_few_views, views_do_not_surround_hand)  | +0.2  | +1.7  | +28.5  | +58.0  | -0.6  | -0.8  | +0.2  | +0.6  | -0.1  | +30740.2  |
|  2 views (palm, back) / focal +2 %  | no (too_few_views, views_do_not_surround_hand)  | -2.5  | -1.6  | +28.5  | +52.0  | -1.0  | -2.2  | -2.5  | -2.5  | -2.4  | +28225.3  |
|  2 views (palm, back) / pose 1 deg, 2 mm  | no (too_few_views, views_do_not_surround_hand)  | -1.3  | -0.2  | +28.5  | +53.3  | -0.4  | -0.5  | -1.3  | -1.7  | -2.4  | +29854.6  |
|  2 views (palm, back) / pose 2 deg, 4 mm  | no (too_few_views, views_do_not_surround_hand)  | -3.5  | -3.7  | +28.5  | +47.3  | -0.8  | -2.0  | -3.5  | -5.2  | -6.3  | +39106.9  |
|  2 views (palm, back) / all: 1 px, +2 %, 1 deg  | no (too_few_views, views_do_not_surround_hand)  | -3.5  | -1.7  | +28.5  | +49.3  | -1.6  | -3.5  | -3.5  | -4.3  | -4.5  | +27572.6  |
|  4 views (palm, thumb, little, back) / none  | yes  | +0.0  | +1.7  | +1.5  | +4.6  | -0.1  | -0.2  | +0.0  | -0.0  | -0.2  | +4526.6  |
|  4 views (palm, thumb, little, back) / mask edge +-1 px  | yes  | -0.2  | +0.5  | +2.0  | +3.5  | +0.1  | -0.2  | -0.2  | -0.0  | -0.7  | +4384.9  |
|  4 views (palm, thumb, little, back) / mask edge +-2 px  | yes  | -0.4  | +0.2  | +1.5  | +3.4  | -0.8  | -0.2  | -0.4  | -0.4  | -1.7  | +3981.5  |
|  4 views (palm, thumb, little, back) / focal +2 %  | yes  | -2.5  | -1.6  | +1.5  | -0.4  | -1.2  | -2.3  | -2.5  | -2.5  | -2.4  | +1885.8  |
|  4 views (palm, thumb, little, back) / pose 1 deg, 2 mm  | no (reprojection_mismatch)  | -2.1  | -2.1  | -9.0  | -15.5  | -3.6  | -2.1  | -2.1  | -2.5  | -2.7  | -8144.9  |
|  4 views (palm, thumb, little, back) / pose 2 deg, 4 mm  | no (reprojection_mismatch)  | -74.7  | -11.2  | -19.5  | -52.8  | -10.0  | n/a  | n/a  | -70.6  | -52.2  | -27526.7  |
|  4 views (palm, thumb, little, back) / all: 1 px, +2 %, 1 deg  | no (reprojection_mismatch)  | -5.4  | -5.5  | -9.0  | -24.7  | -4.3  | -4.5  | -5.5  | -4.7  | -5.7  | -10417.3  |
|  8 views (4 + 4 oblique) / none  | yes  | -0.1  | +1.7  | +1.5  | +0.3  | -0.4  | -0.5  | -0.1  | -0.2  | -0.5  | +1577.3  |
|  8 views (4 + 4 oblique) / mask edge +-1 px  | yes  | -0.4  | +0.5  | +2.0  | -0.1  | -0.1  | -0.6  | -0.4  | -0.1  | -1.2  | +1432.3  |
|  8 views (4 + 4 oblique) / mask edge +-2 px  | yes  | -0.5  | +0.1  | +1.5  | -1.6  | -1.0  | -0.8  | -0.5  | -1.1  | -1.7  | +923.2  |
|  8 views (4 + 4 oblique) / focal +2 %  | yes  | -2.9  | -1.6  | +1.5  | -5.3  | -1.5  | -2.5  | -2.8  | -2.6  | -2.7  | -756.6  |
|  8 views (4 + 4 oblique) / pose 1 deg, 2 mm  | no (reprojection_mismatch)  | -3.6  | -3.0  | -9.0  | -23.2  | -4.3  | -4.1  | -3.6  | -4.2  | -4.3  | -12264.9  |
|  8 views (4 + 4 oblique) / pose 2 deg, 4 mm  | no (reprojection_mismatch)  | -75.5  | -23.3  | -19.5  | -77.0  | -10.4  | n/a  | n/a  | -70.6  | n/a  | -33310.3  |
|  8 views (4 + 4 oblique) / all: 1 px, +2 %, 1 deg  | no (reprojection_mismatch)  | -6.6  | -6.3  | -9.0  | -31.3  | -4.8  | -6.1  | -6.7  | -6.8  | -6.9  | -14459.0  |
|  2 views (palm, back) + capsule prior / none  | no (too_few_views, views_do_not_surround_hand, surface_poorly_observed, surface_not_constrained)  | +0.0  | +1.7  | +1.5  | +4.2  | +0.0  | -0.1  | +0.0  | +0.0  | -0.2  | +4151.8  |
|  2 views (palm, back) + capsule prior / all: 1 px, +2 %, 1 deg  | no (too_few_views, views_do_not_surround_hand, surface_poorly_observed)  | -3.5  | -4.8  | +1.5  | -6.8  | -1.6  | -3.5  | -3.5  | -4.3  | -5.0  | +1183.6  |
|  4 views (palm, thumb, little, back) + capsule prior / none  | yes  | +0.0  | +1.7  | +1.5  | +3.2  | -0.1  | -0.2  | +0.0  | -0.0  | -0.2  | +2640.9  |
|  4 views (palm, thumb, little, back) + capsule prior / all: 1 px, +2 %, 1 deg  | no (reprojection_mismatch)  | -5.6  | -5.6  | -9.0  | -24.9  | -4.3  | -5.7  | -5.6  | -5.5  | -5.7  | -10811.5  |
|  8 views (4 + 4 oblique) / pose 1 deg, 2 mm / carving tolerance 1  | no (reprojection_mismatch)  | -2.1  | +1.1  | +17.3  | +7.7  | -2.6  | -1.8  | -2.2  | -2.4  | -2.7  | +6841.1  |
|  8 views (4 + 4 oblique) / pose 1 deg, 2 mm / carving tolerance 2  | no (reprojection_mismatch)  | -1.6  | +5.3  | +28.5  | +33.8  | -1.2  | -1.3  | -1.6  | +0.6  | +1.7  | +15327.7  |

What the synthetic runs show (and only that):

* With exact poses and clean masks, **eight views** recover hand and finger lengths to within about half a millimetre,
  palm breadth to about +1.7 mm (about one voxel of dilation: 1.5 mm grid plus blur), the section circumference to
  +0.3 mm, thickness to +1.5 mm. **Four views** are almost as good on lengths but over-measure the circumference (+4.6 mm)
  and the area (+4,527 mm^2, +8 %): the thumb and palm overlap from the side and leave phantom volume.
* **Two opposite views** cannot observe thickness at all: +28.5 mm, a prism the size of the search volume. The gates
  reject this (too few views, no view across the hand), and the surface area is withheld.
* **Boundary error** of 1 to 2 pixels on every mask costs under 2 mm on the lengths here (the hull's inflation and the
  mask error partly cancel; do not read this as a guarantee).
* **A 1 degree camera pose error** (with a 2 mm centre error) on every view shrinks and distorts the hull: lengths 2 to
  4 mm short, circumference 15 to 23 mm short. The reprojection check rejects it. At 2 degrees and 4 mm fingers
  vanish ("n/a") and the length is off by 75 mm.
* **A 2 % focal-length error** passes every gate and still makes every length 1.5 to 3 mm short (about 2 %). A shared systematic
  error is invisible to consistency checks. This is why the scale and camera calibration, not the carving, are the real
  risk of a real capture.
* A **carving tolerance** does not rescue wrong poses: it trades the shrinkage for phantom volume (thickness +17 to
  +28 mm).
* The **capsule prior** brings the two-view thickness from +28.5 mm to +1.5 mm and the four-view circumference from
  +4.6 to +3.2 mm, but only because its default thickness (22 mm in the test) happens to be near the synthetic truth
  (24 mm): it substitutes a population guess for data. With eight views it is not needed.

### Repeatability (synthetic)

`runRepeatability(scenario, n)` reconstructs the same synthetic hand `n` times with different noise seeds and reports mean, SD,
range and bias per metric. It measures the pipeline's sensitivity to the injected noise, nothing else. A real
repeatability study needs repeated captures of the same real hand (see the validation plan).

### Speed (Node, one thread; indicative)

Eight 256 x 256 silhouettes, whole pipeline (carve, mesh, smooth, gates, measure), best of three runs in Node on an
i7-13620H with the machine otherwise idle:

| voxel | grid | voxels | triangles | carve | mesh | gates | measure | total |
|---|---|---|---|---|---|---|---|---|
| 2.0 mm | 71 x 130 x 26 | 0.24 M | 121 k | 30 ms | 188 ms | 188 ms | 67 ms | 0.48 s |
| 1.5 mm | 95 x 173 x 35 | 0.58 M | 220 k | 38 ms | 235 ms | 333 ms | 51 ms | 0.73 s |
| 1.2 mm | 118 x 217 x 44 | 1.13 M | 346 k | 64 ms | 453 ms | 496 ms | 74 ms | 1.1 s |
| 1.0 mm | 142 x 260 x 52 | 1.92 M | 504 k | 112 ms | 832 ms | 814 ms | 76 ms | 1.9 s |

Carving a full 160 x 160 x 160 grid (4.1 M voxels) from eight views takes 0.27 s; meshing and the gates dominate and scale with the
surface. The same tests ran about six times slower while other processes were using the machine (an early run of the 1.5 mm
case took 4.6 s), so treat all of these as indicative: they were not repeated across machines and **nothing was timed on a
phone**. A browser worker would be slower than Node; it is untested.

## Viewer

`MeshViewer.tsx` (wrapper: states, buttons, legends, readouts) + lazy `MeshViewerGL.tsx` (three.js scene, its own chunk) +
`meshViewerModel.ts` (pure helpers: preset directions, colour tables, bounds, grid, landmark checks). No new dependency.

**Input** (all optional; wrong-length arrays are ignored, never applied to the wrong vertices):
`mesh` (positions + indices), `confidence` (per vertex, 0..1), `support` (per vertex, `quality.ts` `vertexSupport` codes),
`points` (a separate cloud) with `pointColors` (sRGB 0..1, 3 per point) and/or `pointLabels` (support codes), `landmarks`
(21 MediaPipe points, 21 triples or 63 numbers, same frame), `handFrame` (`{ origin, x: little finger, y: fingers, z: out of
the palm }`; `viewerFrameOf()` converts a `measure.ts` `HandFrame`), `label` (honesty caption, default "Experimental, not a
validated measurement"), `unit` (default `mm`), `defaultDisplay`, `defaultColour`, `onUnavailable`.

**Frame.** Millimetres in the board frame: +z up out of the board, +x roughly along the fingers, board plane z = 0.

**Controls.** Free rotation (TrackballControls: a full 360 degrees about any axis, no pole clamp, so the underside is
reachable), zoom, pan (right-drag / two fingers), **Reset view**; keyboard on the focused view: arrows turn 15 degrees, + / −
zoom, 0 resets. Presets with a hand frame: Top, Palm, Back, Thumb side, Little-finger side, Fingertips, Wrist; without one
the board axes (Top (+z), Underside (−z), ±x end, ±y side) and the panel says so. For a palm-down hand the Palm view (and the
Underside view when board-labelled vertices exist) shows "bounded by the board, not observed" on the stage, with a shortcut
to the support colours. Display: Surface / Wireframe / Point cloud (the separate cloud, else the mesh's vertices). Colour:
Plain / Support (legend: observed, implied, bounded by the board not observed, cut at the forearm, truncated, each with its
share) / Confidence (rose = weakly observed to blue = directly observed, with the share at 0.5 or more). The landmark
skeleton is a separate overlay, off by default, orange and drawn on top, labelled "Landmark skeleton (diagnostic)". A grid
(round step, e.g. 10 mm squares, darker every 50 mm) on the board plane, an axes gizmo, the bounding size (and the extents
along the hand frame, labelled "not measurements"), triangle / vertex / point counts. Loading, empty and WebGL-unavailable
states; buttons are real buttons with `aria-pressed`; controls sit under the stage so nothing covers the model at 390 px.

**Performance.** Geometry, colour buffers, skeleton and grid are built once per input; mode and colour toggles swap
materials, copy one precomputed colour array into one attribute, or flip visibility (the browser test checks the GPU
geometry count does not grow over a second pass through every mode). Rendering is on demand and pauses off screen; every
GPU resource is disposed on unmount (and the context released).

**Looked at in a browser.** `frontend/experiment/viewer/` is a dev-only demo page (not in `vite build`) that builds a
SIMULATED reconstruction in a worker: the synthetic capsule hand resting palm-down on a board, 13 simulated views (a ring
12 degrees above the board plus one from above, 224 px masks), 2 mm voxels, about 109k triangles, per-vertex support labels,
60k surface points, synthetic landmarks. Labelled "SIMULATED: synthetic capsule hand, not a real scan" everywhere. `?data=stress`
loads a procedural 501k-triangle / 200k-point shape (not a hand); `?frame=0` and `?cloud=0` drop the frame or the cloud.
`npx playwright test -c playwright.viewer.config.ts` (own Vite config `vite.viewer.config.ts`, port 5207, own dependency cache)
exercises every preset, mode, colour, the skeleton, mouse and keyboard rotation to the underside, phone width, the no-frame
fallback and the stress set, fails on any console error or failed request, and saves screenshots to
`test-results/viewer/`. Only headless desktop Chromium (software or desktop GPU) was used: **no phone GPU was tried**.

## What real captures must prove (none of it is shown here)

1. **Camera poses from real footage.** A hand is low-texture and not rigid, so feature-matching structure-from-motion is
   unreliable. A printed fiducial (e.g. a marker sheet beside or under the hand, with the coin on it) is the likely route;
   the coin alone (one circle) gives a plane and a scale but not a full pose.
2. **Scale.** A single coin pixels-per-mm is not a 3D calibration (the coin plane is not the hand's surface planes; see the
   2 % focal row for how a shared scale error shows up).
3. **A hand that holds still.** Guided rotation of the hand against a fixed camera moves the pose between views; the hull
   needs rigid consistency. Not tested.
4. **Real silhouettes.** Mask boundary error, finger gaps and the wrist boundary from a real segmentation model.
5. **Landmark frames.** The hand frame and finger axes from real MediaPipe landmarks lifted into the mesh frame.
6. **Physical agreement.** Mean absolute error, RMSE, bias, repeatability, failure rate and processing time against
   anthropometric instrument readings of the same hands (`stats.ts` computes these; it has no data).
7. **Real depth.** WebXR depth-sensing, native ARCore/ARKit/LiDAR, or metric multi-view geometry: none was available here.

## Run the tests

```
npx vitest run --no-file-parallelism src/experimental/reconstruction src/experimental/depth
npx tsc -b --noEmit
```

## Files

`linalg.ts` camera maths, Horn alignment · `rng.ts` seeded random · `synthetic.ts` capsule hand, rig, silhouette renderer,
noise · `carving.ts` visual hull, view coverage, unconstrained-surface heuristic · `meshing.ts` field, marching tetrahedra,
smoothing, topology · `pointcloud.ts` depth, ICP, fusion, triangulation · `measure.ts` frames, slicing, measurements ·
`quality.ts` confidence, completeness, silhouette IoU, gates · `stats.ts` validation statistics · `prior.ts` capsule prior ·
`pipeline.ts` the chain · `experiment.ts` synthetic grid and repeatability · `MeshViewer*.tsx`, `meshViewerModel.ts`, `meshViewer.css` viewer, `viewerDemo/` its SIMULATED demo page ·
`testSupport.ts` analytic test helpers · `../depth/` capability detection and metric-depth surfaces.
