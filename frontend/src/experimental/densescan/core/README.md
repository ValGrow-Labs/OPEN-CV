# densescan/core: dense surface points over a segmented hand (EXPERIMENTAL)

Pure TypeScript, no DOM, no dependencies. It turns **one frozen RGB frame + its hand mask** (from
`../../segmentation`) into thousands of small surface points, validates them, and derives a point set, a point
cloud, a lattice mesh, measurements and a reproducible export. The page that animates it is built elsewhere.

**What this is not.** A 2D point grid over a photo is **not a 3D scan**. A point has physical depth only when a real
metric depth map was applied to it (`depth: "measured"`). MediaPipe's landmark z is a learned *relative* estimate
(`depth: "estimated"`, units "relative"), never millimetres. Nothing here has been compared with physical
measurements; no accuracy is claimed. All tests use **synthetic** masks and images.

## Pipeline (`buildPointSet`)

1. **Spacing** (`resolveSpacing`): a step in source pixels (default 4 px: about 2,500 points on a hand filling a
   640 px frame, about 10,000 at 1280 px). An optional millimetre target is converted with the coin scale and
   **clamped to at least 1 px**, with `limitedByResolution: true` and a note.
2. **Generation** (`generateSurfacePoints`): lattice nodes `(gx, gy)` at `(g + 0.5) * step`, optional seeded jitter
   (fraction of the step, max 0.45), kept **only on hand pixels** of the mask. Gap pixels between fingers are
   background, so no point can fall in a gap, even a 2 to 3 px one with a 1 px step (tested). Each point carries its
   distance to the mask edge from a two-pass 3-4 chamfer transform (`edt.ts`).
3. **Validation** (`validatePoints`), on the source frame, first failing reason wins:
   `outside_mask` (not on the given mask), `near_edge` (edge distance < `edgeMarginPx`, default 2 px),
   `overexposed` / `underexposed` (>= 50 % of a 5x5 window at luma >= 250 / <= 8), `blurred` (mean |Laplacian| in the
   window below max(1.0 grey level, 0.35 x the hand's median)). `quality` = edge factor x sharpness factor x exposure
   factor, in 0..1.
4. **Filtering** (`dedupeAndFilter`): `duplicate` (same lattice node, or closer than 0.25 x step), then `isolated`
   (fewer than 2 accepted 8-neighbours). Rejected points are **kept with their reason**; counts are always
   `generated = accepted + rejected`.
5. **Regions** (`labelRegions`): `wrist` below landmark 0 along the hand axis (0 to 9), `palm` inside the polygon
   0-1-5-9-13-17, else the finger with the nearest bone chain (thumb 1-4, index 5-8, ...), `unknown` beyond 60 % of the
   palm width. Distances only, so rotation, mirror and left/right give the same labels (tested at 0, 90, 200 degrees and
   mirrored).
6. **Depth labels**: `none` by default; `estimateRelativeDepth` (inverse-distance weighting of landmark z) sets
   `estimated`; `applyMeasuredDepth` is the **only** path to `measured`, from a metric depth map (finite, > 0, confidence
   >= 128 when a confidence image is given). Invalid samples leave the label unchanged; nothing is filled in.

## Outputs

* `buildPointCloud`: accepted points; x, y are the source-frame pixel positions unchanged. If any point is measured,
  only measured points, z in **mm**; else if estimated, z **relative**; else z = 0 with unit `null` (a flat grid).
* `meshFromLattice`: two triangles per lattice cell whose 4 corners are accepted **and** whose centre and edge midpoints
  are on hand pixels, so no triangle bridges a finger gap (tested on a 3 px gap). Components under 8 triangles are
  dropped. `completeness` = covered cell area / mask area. Without measured depth the mesh is **flat (z = 0)** and the
  note says it is not a 3D surface; x, y are mm only through the coin-plane scale (a model).
* `measureFromPoints` (`Quantity` with basis):
  * **direct**: `projected_area_px2` (mask pixels), `palm_breadth_px` (mask edge to edge along the knuckle line, moved
    toward the wrist if the joint-centre line misses the palm).
  * **model**: `hand_length_px` (from the wrist *landmark*, a joint estimate, to the mask's middle fingertip edge),
    finger lengths (knuckle joint centre to the mask tip), and every `_mm` value (coin scale, valid at the coin's plane).
  * **none**: `thickness_mm`, `circumference_mm`, `surface_area_3d_mm2`: one RGB frame has no metric depth, and a
    circumference also needs the back and sides.
* `exportPointSet`: JSON (`densescan.pointset/1`, config incl. seed, frame size, calibration metadata, counts, per point
  id/x/y/gx/gy/region/accepted/reject/quality/edgeDistPx/depth/z, numbers rounded to 0.001) and CSV. **No image pixels.**
  Same input and seed give byte-identical output (tested).
* `scanReducer`: the scan sequence, frame-rate independent (tested with 10 ms vs 30 ms ticks):
  waiting_hand, then (hand found and frame frozen) segmenting, then mask_ready sweeping (line from the mask's top to
  bottom over `sweepMs`; `revealed` counts the real points above the line), then validating, captured (needs at least
  `MIN_ACCEPTED_POINTS` = 300 accepted), processing, done. Hand lost, mask failed or too few points go to rejected with
  the reason.

## Pixel step versus measurement accuracy

The dot step is an **image sampling interval**. From `../../geometry/resolution.ts` and the consolidated findings:
the app's 1280 px video gives about **0.28 to 0.46 mm per pixel** at 350 mm (the coin lies in the hand's plane, so it
is not sharper than the hand). A 0.1 mm target is therefore clamped to 1 px (about 0.3 to 0.46 mm): finer dots would only
interpolate the same pixels. Even a true 0.1 mm/px image (10 to 26 megapixels at 350 mm) would not give 0.1 mm
accuracy: skin-edge localisation (blur over several pixels), the height of the hand above the coin's plane (the
dominant term: about 4 % for 15 mm at 350 mm), lens distortion, coin tolerance and hand posture all add more.

## Timing (Node, i7 laptop, NOT a phone)

640 x 480 synthetic hand: about 2,800 points generated, 2,700 accepted, generation + validation + filtering in about
11 to 12 ms. Phone speed is not measured.

## What real data must still prove

Thresholds (blur, exposure, edge margin, isolation, region distances) on real skin, real lighting and real phones;
segmentation quality on real masks; that accepted points really avoid motion blur; measured depth from a real device
(ARCore/WebXR) and its alignment with the frame; every millimetre value against calipers and tape on real people.

## Files

`types.ts` (types, defaults, thresholds), `edt.ts` (edge distance), `points.ts` (spacing, generation, validation,
filtering), `regions.ts` (regions, depth labels), `pointset.ts` (point set, point cloud), `mesh.ts`, `measure.ts`,
`export.ts`, `scan.ts` (sequence), `index.ts`, `core.test.ts` (28 synthetic tests).
