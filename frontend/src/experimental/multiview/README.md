# Experimental multi-view reconstruction on the printed board (`multiview/`)

> **EXPERIMENTAL, ISOLATED, SIMULATED ONLY.** Nothing here is used by the customer flow, the scan, the coin pipeline or
> the sizing. Every number in this file comes from **SIMULATED** photos of a **synthetic capsule hand** rendered by
> `scene.ts`, with the **true** camera intrinsics and board poses (or deliberately perturbed ones). It shows that the
> chain works and how input errors propagate. It says **nothing** about real hands, real phones, real segmentation or
> real accuracy, and must never be quoted as such.

## The chain

```
per view: RGBA picture + intrinsics + board pose ─► segmentBoardView ─► mask + known      (segment.ts)
          MediaPipe 21 landmarks (px)            ─► triangulateLandmarks ─► 21 points in board mm,
                                                     residuals, hand-moved check            (landmarks.ts)
all views ─► reconstructHand in a board-frame volume (cut faces: board "-z", forearm end "-x")
          ─► vertexSupport labels ─► measureHand in the landmark hand frame                (reconstruct.ts)
```

`reconstructFromBoardViews(views, { voxelMm })` runs it. **Camera intrinsics and board-to-camera poses are inputs**: the
marker detection, board pose and self-calibration are built separately in `../board/`. Z comes only from the
multi-view geometry; nothing is filled in.

## Files

| File | What it does |
|---|---|
| `scene.ts` | SIMULATED photo renderer for tests: the capsule hand of `reconstruction/synthetic.ts` placed palm-down on the board, a coin on the coin target, the printed board (`boardIsBlack`, `onCoinOutline`), a table and a room, Lambertian skin with ambient light and a configurable skin colour, a soft cast shadow, smooth illumination variation, vignetting, radial distortion, Gaussian blur, sensor noise, seeded. Returns the RGBA picture, the exact hand mask and what each pixel saw. Also the 21 synthetic landmarks in board mm, the hand-to-board transform, the exact dimensions, a capture rig (one view from above, rings at 12 and 35 degrees) and reference surface areas. |
| `segment.ts` | Hand mask per view from the KNOWN board: predicted print per pixel, local paper white, chroma / brightness tests (shadow vs skin, skin over ink), an off-paper colour model learned in the same view, boundary unmixing, clean-up; returns `mask` and `known`. Also `scoreMask` (IoU, boundary error, dangerous misses) for SIMULATED reports. |
| `landmarks.ts` | DLT + Levenberg-Marquardt triangulation of the 21 landmarks with outlier dropping; per-landmark and per-view residuals; the hand-moved check; the hand frame and finger axes for `measureHand`. |
| `reconstruct.ts` | `reconstructFromBoardViews`, `boardVolume`, `forearmBox`: the whole chain and a report a viewer can use. |
| `image.ts` | RGBA type, sRGB tables, per-pixel rays with undistortion, ray-box test, blur and box filters. |
| `testFixtures.ts` | Cached SIMULATED captures for the tests (not used by the chain). |
| `*.test.ts` | Unit tests, the SIMULATED segmentation table and the SIMULATED end-to-end runs. |

Changes outside this folder (minimal, backward compatible; the whole `reconstruction/` suite stays green):
`reconstruction/carving.ts` (`CarveView.known?`: a voxel projecting onto an unknown pixel is not carved by that view;
`Occupancy.abstained?`), `reconstruction/quality.ts` (`vertexConfidence` ignores contours on or next to unknown pixels;
`silhouetteIoU(a, b, known?)` skips unknown pixels and does not hold a view with fewer than 200 known hand pixels
against the reconstruction; `QualityInput.handAxis?` for the azimuth-gap gate), `reconstruction/pipeline.ts` (passes
`planeNormal`, `handAxis`, `outsideImage` through; `planeNormal` was already used there but not declared).

## Conventions

* **Board frame** (world): millimetres; origin at the paper's bottom-left corner (A4 landscape, upright), +x right,
  +y up the page, +z out of the paper. The board plane is z = 0.
* **Camera**: OpenCV (x right, y down, z forward); `Xc = R X_board + t`; pixel centres at +0.5; radial `k1`, `k2` on
  normalised coordinates (the same model as `reconstruction/linalg.projectPoint`). A picture's size must equal its
  intrinsics' `width` x `height`; landmarks are in pixels of that same picture (not mirrored).
* **Hand frame** (`synthetic.ts`, `measure.ts`): origin at the wrist-plane centre, +y toward the fingers, +z out of
  the palm, +x toward the little finger. On the board (palm down, fingers toward +x): hand +y = board +x, hand +x =
  board +y, hand +z = board -z; the palm plane z = palmThickness / 2 lies on z = 0. (With this hand frame the capsule
  hand is geometrically a left hand; a right hand is its mirror image and changes nothing here.)
* **Landmark frame** (`frameFromLandmarks`): origin = wrist (0); +y = wrist to middle MCP (9); +x = index MCP (5) to
  little MCP (17) made orthogonal; +z = x cross y (out of the palm); knuckle line = mean of the four MCPs along +y.
  Finger axes: MCP to tip (thumb: 2 to 4). On the synthetic hand the WRIST landmark is placed on the axis through the
  middle MCP, so the landmark frame equals the exact frame (MediaPipe's wrist is roughly there on a real hand).
* **Carving volume** (`boardVolume()`): x from 0 (the open left edge, where the forearm leaves: cut face "-x") to 5 mm
  short of the coin, y = the hand area +- 15 mm, z from 0 (the board: support face "-z") to 80 mm.
* **Per-vertex labels** (`vertexSupport`): `observed` (a silhouette contour passes through it), `implied` (inside every
  silhouette, no contour touches it), `support_plane` (on the board: bounded by the board, NOT observed), `volume_cut`
  (the forearm cut), `truncated` (an undeclared face of the volume: a failure).
* **Unknown pixels** (`known` = 0): the coin and its surroundings; off-paper pixels whose colour the per-view colour
  model cannot decide; ink pixels too dark to measure chroma; fragments removed by the clean-up; and, in
  `reconstruct.ts`, hand pixels whose rays cross the forearm box (they may show the forearm, which the volume cannot
  contain). An unknown pixel never carves.

## SIMULATED results

Setup of every run below: the capsule hand of `synthetic.ts` (palm 100 x 85 x 24 mm, wrist stub lengthened to 100 mm
so the forearm runs off the open edge) on the board with its wrist-plane centre at (25, 122) mm; 640 x 360 pictures,
horizontal field of view 62 degrees, `k1` = 0.02; one view from 400 mm above the hand and a ring of 16 views at 12
degrees, 340 mm from the middle of the hand (optionally 8 more at 35 degrees); Lambertian shading, a light from the upper
left about 55 degrees high, ambient 0.3, soft shadow, 15 % illumination variation, vignetting, blur sigma 0.7 px, noise
sigma 2.5 grey levels; masks from `segmentBoardView` (never the exact masks); landmarks = the exact synthetic landmarks
projected with Gaussian noise sigma 1.5 px; TRUE intrinsics and poses unless stated. Node 22, one thread, on a shared,
busy desktop (other processes were running): treat timings as indicative only. Nothing was timed on a phone.

### Segmentation (`segment.test.ts`, full mode)

`RUN_MULTIVIEW_E2E=1 npx vitest run --no-file-parallelism src/experimental/multiview/segment.test.ts`. Scores over the
pixels whose rays cross the carving volume (the only pixels the carving uses), averaged over the views of each
elevation. "Known-but-missed" = true hand pixels marked KNOWN background (they carve real hand away: the dangerous
error); "false hand" = background marked hand (adds volume, less harmful).

| skin | elevation | views | IoU | IoU (known px) | boundary mean px | boundary p95 px (max) | true hand px known | known-but-missed hand px (max/view) | false hand px (max/view) | unknown share of volume px |
|---|---|---|---|---|---|---|---|---|---|---|
| light | top (90) | 1 | 0.985 | 0.985 | 0.36 | 1.0 | 100.0 % | 92 | 397 | 0.9 % |
| light | 12 deg | 16 | 0.985 | 0.988 | 0.47 | 3.0 | 99.7 % | 49 | 462 | 0.4 % |
| light | 35 deg | 8 | 0.988 | 0.989 | 0.48 | 3.0 | 99.9 % | 112 | 562 | 0.6 % |
| medium | top (90) | 1 | 0.988 | 0.988 | 0.29 | 1.0 | 100.0 % | 75 | 319 | 0.9 % |
| medium | 12 deg | 16 | 0.985 | 0.989 | 0.46 | 3.0 | 99.7 % | 59 | 463 | 0.4 % |
| medium | 35 deg | 8 | 0.988 | 0.989 | 0.52 | 4.1 | 99.9 % | 50 | 660 | 0.5 % |
| tan | top (90) | 1 | 0.992 | 0.992 | 0.19 | 1.0 | 100.0 % | 75 | 207 | 0.9 % |
| tan | 12 deg | 16 | 0.985 | 0.990 | 0.47 | 2.8 | 99.5 % | 62 | 400 | 0.5 % |
| tan | 35 deg | 8 | 0.990 | 0.991 | 0.43 | 2.2 | 99.8 % | 52 | 569 | 0.5 % |
| dark | top (90) | 1 | 0.995 | 0.997 | 0.11 | 1.0 | 99.8 % | 8 | 78 | 0.9 % |
| dark | 12 deg | 16 | 0.982 | 0.992 | 0.55 | 3.0 | 98.9 % | 53 | 326 | 0.7 % |
| dark | 35 deg | 8 | 0.990 | 0.992 | 0.36 | 2.0 | 99.7 % | 29 | 428 | 0.6 % |
| veryDark | top (90) | 1 | 0.998 | 0.998 | 0.05 | 0.0 | 99.9 % | 11 | 63 | 0.9 % |
| veryDark | 12 deg | 16 | 0.990 | 0.993 | 0.35 | 2.2 | 99.2 % | 65 | 291 | 0.6 % |
| veryDark | 35 deg | 8 | 0.992 | 0.994 | 0.27 | 1.4 | 99.8 % | 39 | 336 | 0.6 % |

A **skin-coloured table** (3 views at 12 degrees, medium skin on a table of the same colour): IoU 0.462 over all volume
pixels but 0.965 over the known ones; 38.9 % of the volume pixels and 52.6 % of the true hand pixels are UNKNOWN (the
colour model cannot decide off the paper), and at most 217 hand pixels per view are wrongly known background. **Pose
error** in the top view (1 degree / 2 mm): IoU 0.987 against 0.988 with the true pose (the hand lies on plain paper away
from the markers in that view, so the misplaced print prediction costs almost nothing there).

Two defects were found and fixed during development: a smoothed-chroma threshold put the boundary of very dark skin
about 1 px inside the hand (blur mixes it with the bright paper); the boundary unmixing step removes that bias (very dark
skin, top view: IoU 0.961 -> 0.998). And when the forearm covers most of the predicted paper (a view along the forearm),
the paper tint must come from near-neutral pixels only, else skin is taken for paper (that view: IoU 0.004 -> 0.979).

### Landmarks and the hand-moved check (`landmarks.test.ts`)

Exact landmarks triangulate to better than 1e-4 mm (distortion included). With 1.5 px noise over 17 views the 21
points are within 1.5 mm (RMS below 0.7 mm). A view whose hand moved 5 mm is named and left out; a view with a 2-degree
pose error is named the same way (the check cannot tell a moved hand from a wrong pose or a failed detection).
Sensitivity, 17 views, one view's hand moved along the hand axis (board +x), 6 trials per cell:

| landmark noise px | hand moved mm | moved view named | other views named (false alarms) |
|---|---|---|---|
| 1 | 2 | 4/6 | 0 |
| 1 | 5 | 5/6 | 0 |
| 1 | 10 | 6/6 | 0 |
| 2 | 2 | 3/6 | 0 |
| 2 | 5 | 5/6 | 0 |
| 2 | 10 | 5/6 | 0 |
| 3 | 2 | 0/6 | 0 |
| 3 | 5 | 4/6 | 0 |
| 3 | 10 | 5/6 | 0 |
| 5 | 2 | 0/6 | 0 |
| 5 | 5 | 3/6 | 0 |
| 5 | 10 | 4/6 | 0 |

The misses include views that look ALONG the movement (e12-000: a movement along the line of sight barely moves the
landmarks in that view). Real MediaPipe errors are several pixels and correlated within a view; the real sensitivity is
unknown.

### End to end (`endToEnd.test.ts`)

`RUN_MULTIVIEW_E2E=1 npx vitest run --no-file-parallelism src/experimental/multiview/endToEnd.test.ts` (the first two
rows also run in the default suite). Signed errors, estimate minus exact (mm); voxel 1.5 mm unless stated; measurements
are reported even when the gates failed (`ignoreGate`, research only). Exact free surface (the hand's own surface above
the board inside the volume) 35,755 mm^2; with the flat faces on the board and at the forearm cut, 46,547 mm^2.

| scenario | accepted (reasons) | length | breadth | thickness | knuckle circ. | thumb | index | middle | ring | little | free area vs exact | views named by the hand-moved check | landmark RMS px (median view) | total s | rss MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 17 views (top + 16 at 12 deg), true poses | yes | -0.2 | +0.4 | +1.8 | +0.8 | -0.4 | +0.5 | -0.2 | +0.3 | +0.9 | -2587.8 mm2 (-7.2 %) | none | 2.10 | 12.4 | 190 |
| 17 views, hand moved 5 mm in view e12-090 | yes (views_disagree) | -0.1 | +0.4 | +1.8 | +0.8 | -0.4 | +0.5 | -0.3 | +0.8 | +0.7 | -2578.6 mm2 (-7.2 %) | e12-090 | 2.08 | 11.3 | 199 |
| 25 views (+8 at 35 deg), true poses | yes | -0.2 | +0.3 | +1.7 | +0.1 | -0.8 | -0.3 | -0.4 | -0.3 | +0.1 | -2767.2 mm2 (-7.7 %) | none | 2.03 | 17.0 | 243 |
| 17 views, pose error 0.5 deg / 1 mm | no (reprojection_mismatch) | -1.9 | +1.8 | +2.4 | -0.5 | -1.2 | -0.7 | -1.8 | -0.9 | +1.0 | -3345.5 mm2 (-9.4 %) | none | 3.70 | 12.4 | 214 |
| 17 views, pose error 0.5 deg / 2 mm | no (reprojection_mismatch) | -2.4 | +2.0 | +1.8 | -1.5 | -1.5 | -1.4 | -2.4 | -1.6 | -0.3 | -3578.0 mm2 (-10.0 %) | none | 4.35 | 12.1 | 225 |
| 17 views, pose error 1 deg / 1 mm | no (reprojection_mismatch) | -4.1 | +1.5 | +1.5 | -5.1 | -2.6 | -2.7 | -3.9 | -3.1 | -3.4 | -4099.5 mm2 (-11.5 %) | none | 6.47 | 11.2 | 230 |
| 17 views, pose error 1 deg / 2 mm | no (reprojection_mismatch) | -4.1 | +1.6 | +1.6 | -5.3 | -3.2 | -2.8 | -3.9 | -3.7 | -4.6 | -4082.6 mm2 (-11.4 %) | none | 6.35 | 8.8 | 204 |
| 17 views, pose error 1 deg / 2 mm, carving tolerance 1 | no (reprojection_mismatch) | -2.9 | +12.6 | +2.8 | +13.5 | -1.7 | -0.1 | -2.6 | -1.9 | -2.2 | -4222.3 mm2 (-11.8 %) | none | 6.35 | 8.9 | 260 |
| 17 views, light skin | yes | -0.2 | +0.9 | +1.8 | +0.9 | -0.4 | +0.3 | -0.2 | +0.2 | +0.7 | -2636.7 mm2 (-7.4 %) | none | 2.10 | 10.4 | 264 |
| 17 views, veryDark skin | yes | -0.2 | +0.4 | +1.8 | +0.4 | -0.4 | +0.4 | -0.2 | +0.2 | +0.7 | -1885.6 mm2 (-5.3 %) | none | 2.10 | 7.7 | 319 |
| 17 views, skin-coloured table | no (surface_poorly_observed, reprojection_mismatch) | -0.7 | -0.2 | +28.6 | n/a | -1.8 | -1.3 | -0.8 | -0.0 | +0.5 | +41250.0 mm2 (+115.4 %) | none | 2.10 | 12.5 | 333 |
| 17 views, voxel 1.0 mm | yes | -0.4 | +1.3 | +2.0 | +2.4 | -0.1 | +1.0 | -0.4 | +0.4 | +1.4 | -970.0 mm2 (-2.7 %) | none | 2.10 | 13.4 | 344 |
| 17 views, voxel 2.0 mm | yes | -0.7 | +0.8 | +2.0 | +0.2 | -1.3 | +0.1 | -0.7 | +0.1 | +0.4 | -3973.0 mm2 (-11.1 %) | none | 2.10 | 9.0 | 303 |

Timings per stage, same runs:

| scenario | views | segment s | triangulate ms | carve ms | mesh ms | gates ms | measure ms | total s |
|---|---|---|---|---|---|---|---|---|
| 17 views (top + 16 at 12 deg), true poses | 17 | 8.7 | 230 | 404 | 856 | 1801 | 303 | 12.4 |
| 25 views (+8 at 35 deg), true poses | 25 | 12.5 | 78 | 564 | 817 | 2621 | 227 | 17.0 |
| 17 views, voxel 1.0 mm | 17 | 6.9 | 31 | 967 | 1728 | 3434 | 279 | 13.4 |
| 17 views, voxel 2.0 mm | 17 | 7.4 | 52 | 117 | 216 | 1073 | 105 | 9.0 |

`rss MB` is `process.memoryUsage().rss` after each run, in a test process that keeps every rendered capture cached.
Rendering one SIMULATED 640 x 360 picture takes about 0.2 s. Segmentation (about 0.3 to 0.7 s per view) dominates; the
gates (silhouette rasterising and contour distances per view) come second.

What these SIMULATED runs show, and only that:

* With **true poses and segmented masks**, the board capture (top + 16 views at 12 degrees) recovers the capsule hand's
  hand and finger lengths within 1 mm, palm breadth and knuckle circumference within about 1 mm, and the thickness about
  2 mm too large (the hull over-fills next to the palm's rounded edges and the board). Light and very dark skin give the
  same numbers here. Eight extra 35-degree views change little.
* **Pose errors** shrink the hull (lengths 2 to 4 mm short at 0.5 to 1 degree) and the reprojection gate rejects every
  perturbed run. A carving tolerance trades the shrinkage for phantom volume (breadth +12.6 mm). Board poses must be
  better than about half a degree for millimetre results here. Under a pose error shared by all views the hand-moved
  check names no view (it only flags views that stand out from the others); the reprojection gate catches it.
* **A moved hand** in one view (5 mm) is named, left out, and the rest reconstructs as if it had not happened.
* **A skin-coloured table** leaves the upper contours of the low views unknown: the thickness is not bounded
  (+28.6 mm), and the gates reject it (surface poorly observed, reprojection mismatch). Nothing is filled in.
* **Free surface area** comes out 3 to 12 % low: under the fingers (3 mm above the paper on this hand) the hull reaches
  the board, so that underside is counted as board contact. Finer voxels move it toward the exact value (-2.7 % at
  1.0 mm).

## Limitations (plainly)

* **Visual hull**: concavities (the palm hollow, the web between thumb and index) are filled; finger gaps close where
  no view looks through them; the hull is an upper bound of the hand, never the skin.
* **The palm side is bounded by the board, not observed** (labelled `support_plane`); the forearm end is a cut
  (`volume_cut`). The underside of a finger that does not touch the paper is not recovered either.
* **The synthetic capsule hand is not a real hand**, the renderer is not a real camera (no sub-surface scattering,
  specular highlights, texture, hair, nails, tone curves, compression, motion blur), and the landmarks are exact points
  with Gaussian noise, not MediaPipe output. None of the numbers above is a real accuracy.
* **Segmentation** assumes a neutral ambient and direct light (shadows stay achromatic), a flat matte printed board and
  a background whose colour differs from skin; anything else becomes unknown at best and wrong at worst.
* **Poses and intrinsics are inputs** and their errors are the dominant risk (see the pose rows); a shared scale or focal
  error passes every consistency check (reconstruction/README.md).
* **The hand-moved check** only sees movement that shifts landmarks across the image in some view, needs landmark errors
  well below the movement, and cannot tell a moved hand from a wrong pose or a failed detection.
* **Timings** are from Node on a busy desktop; nothing was run in a browser worker or on a phone. The full grids each
  block the test worker for minutes; on this machine vitest reported one "Timeout calling onTaskUpdate" RPC error at
  the end of each full-grid run although every test passed (the default suite does not show it).

## Run the tests

```
npx vitest run --no-file-parallelism src/experimental/multiview src/experimental/reconstruction
RUN_MULTIVIEW_E2E=1 npx vitest run --no-file-parallelism src/experimental/multiview   # full SIMULATED grids, several minutes
npx tsc -b --noEmit
```
