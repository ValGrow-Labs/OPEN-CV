# EXPERIMENTAL: board-free reconstruction chain (`boardfree/`), stage 4

> **EXPERIMENTAL, research only, not validated.** Nothing here is used by the customer app, the production scan, the
> coin calibration or the sizing, and nothing here changes a production setting or `config/reference_objects.json`.
> Every number in this file is **SIMULATED**: rendered pictures of the synthetic capsule hand on a procedural table
> (`sfm/scene.ts`), without gloss, tone curve, rolling shutter, motion blur or video compression. **None of it is
> real-world accuracy.** No real capture has gone through this code. The coin's thickness (1.5 mm) is **UNVERIFIED**
> (not in the settings) and is an assumption in every run.

Question (stage 4 of `docs/hand3d-research/MASTER_AUDIT.md`): with no printed board, can the whole chain run from
pixels to a labelled metric mesh, a point cloud and measurements, like the board route's `recon/chain.test.ts`?

**Short answer (SIMULATED): yes, on a speckled table with a continuous video-like sweep and the coin beside the hand.**
The chain runs from the pictures alone (the landmarks and the coin outline come from detector stand-ins, below), passes
every existing quality gate unchanged, and measures the simulated hand as well as the board route does on the same hand:
length -0.4 mm, breadth +1.2, thickness +2.7, knuckle circumference (an upper bound) -0.2, worst-view reprojection IoU
0.962 (board route: +0.0 / +1.6 / +2.5 / +2.1, IoU 0.915). It refuses, with a named reason, a plain table, the board
capture's stills, and a coin hidden under the hand. Three findings matter more than the numbers:

1. **Segmentation without the board needs the table plane, not colour alone.** Plane consistency (table pixels agree
   with neighbouring sweep frames through the table-plane warp; the hand, above the plane, does not) combined with
   GrabCut gives mean IoU 0.965 to 0.972 over four skin tones; GrabCut seeded by the landmarks alone takes in the hand's
   cast shadow (mean 0.875 to 0.938, worst view 0.76).
2. **The quality gates do not catch a consistent segmentation error**: with the landmark-only GrabCut masks the hull is
   15 mm too wide and every gate passes. Passing the gates is consistency, not accuracy.
3. **The stage 3 gate failure was not the frame**: under the board route's forearm rule, the view along the forearm is
   checked on a few hundred fingertip pixels and sits at about 0.81 whatever the poses (0.813 with EXACT poses). A cut
   made consistent with what the views carved lifts it to about 0.98 with unchanged measurements; no threshold changed.

Everything here is SIMULATED on one capsule hand and one texture; none of it is validation or real-world accuracy.

## The chain

`chain.ts reconstructBoardFree(frames, options)`:

1. **Cheap refusals first**: fewer than 40 frames (`too_few_frames`: the board capture's 13 to 25 stills never register
   board-free, stage 3), frames of different sizes, the coin seen whole in no frame (`coin_missing`) or in fewer than 6
   (`coin_partial`).
2. **Camera geometry** (`sfmStage.ts`): stage 3's `runSfm` (focal length, k1, k2 self-calibrated; the coin fitted
   jointly in the bundle adjustment). The hand is left out of the features by a region built **from the landmarks
   only** (their convex hull grown by a quarter of its diagonal plus a strip from the wrist away from the fingers), never
   from a true mask. Refusals: `sfm_failed`, `sfm_partial_registration` (fewer than 90 % of the frames), `camera_geometry_poor`
   (feature RMS above 1.5 px), `coin_fit_poor` (joint coin outline RMS above 1.0 px).
3. **Table frame** (`tableFrame.ts`): the table plane fitted to the triangulated points, millimetres from the coin, the
   in-plane x axis from a least-squares line through the triangulated landmarks of the hand's middle line (wrist, middle
   MCP / PIP / DIP and the mean of the four finger bases; stage 3 used two landmarks). Refusals `no_table_plane`,
   `no_hand_landmarks`.
4. **Carving views**: the frames flagged as guided stills (top view + low ring every 22.5 degrees), or chosen from the
   poses; pictures halved to 640 x 360; the carving volume from the landmarks triangulated in the table frame (25 mm
   behind the wrist to 22 mm beyond the farthest landmark, 28 mm either side, table to 80 mm).
5. **Segmentation without the board** (`segment.ts`, method chosen by the caller; see below). A view is rejected with a
   named reason (`no_landmarks`, `landmarks_outside_mask`, `mask_empty`, `table_not_verified`, `opencv_missing`,
   `segmentation_failed: ...`); fewer than 12 usable views refuses (`segmentation_failed`).
6. **Carving** (`carve.ts`): the existing visual hull, mesh, quality gates and measurements (`reconstruction/pipeline.ts`
   `reconstructHand`, `quality.ts`, `measure.ts`, unchanged thresholds), the table as the support plane (-z face), the
   forearm cut (-x face) made consistent with the views (below), vertex labels (`vertexSupport`), the board route's
   measurement limits with "board" read as "table" (no hand surface area; circumference an upper bound).
7. **Point cloud** (`CloudPoint`): every mesh vertex with x, y, z (mm, table frame), `label` (`observed` = a silhouette
   contour passes through it, i.e. measured geometry; `implied` = inside every silhouette but no contour touches it;
   `support_plane` = on the table plane, bounded by it, not observed; `volume_cut`; `truncated`), `confidence` (0, 0.5,
   1: contours through it), `sourceViews` (the carving views whose contour passes within 1.5 px: which views observed it)
   and `seenBy` (how many views bounded it on a known pixel).

`segmentAndCarve` (steps 4 to 7 with any poses) is exported so the evaluation runs the SAME steps with the exact poses.

### What stage 5 gets (`BoardFreeResult.uncertainty`, `BoardFreeUncertaintyInputs`)

| field | what | how |
|---|---|---|
| `sfm.featureRmsPx / featureMedianPx / featureP95Px / observations / points` | bundle-adjustment reprojection residual statistics | recomputed from the final poses, points and camera |
| `sfm.perFrame[i]` | per frame: RMS residual, observations, `rotSigmaDeg`, `centreSigmaMm` | **conditional** 6-dof covariance of that frame's pose with points and intrinsics held fixed, scaled by the residual variance: a LOWER bound (it ignores the points' uncertainty and the gauge) |
| `sfm.focalRelSigma`, `sfm.k1Sigma` | intrinsics | conditional, poses and points fixed: lower bounds |
| `sfm.coin` | joint coin outline RMS (px), frames that saw it whole, per-frame RMS, post-hoc/joint radius difference | `coin/sceneScale.ts fitCoinCircle3D` on the final poses |
| `scale.components`, `scale.relSigma` | relative one-sigma scale components: `fit` (edge scatter), `reference_diameter` (config +-0.1 mm), `thickness` (ASSUMED +-0.5 mm) and their root-sum-square | `fitCoinCircle3D` rules; `coinThicknessVerified: false` always |
| `plane` | table-plane RANSAC inliers and RMS (mm) | |
| `views[]` | per carving view: plane-consistency agreement share, unknown share, reprojection IoU, rejection reasons | |
| `BoardFreeResult.intrinsics`, `tablePoses`, `frame` | the self-calibrated camera, every frame's pose (table mm), the frame definition (plane, scale, axes, cut x) | |

Full bundle-adjustment covariance (with the points eliminated) is NOT computed: `sfm/bundle.ts` does not expose its
normal equations; the conditional figures above are lower bounds and should be treated as such.

## Segmentation without the board (`segment.ts`)

* **(a) `grabcut`**: stage 2a's method (GrabCut, OpenCV.js) with stage 2a's landmark seed geometry
  (`segmentation/seeds.ts` rules: thick bones and the shrunken palm sure hand, the grown hull probable hand, a wider band
  probable background). Two changes for views that are not palm-facing: the size unit is max(palm width, 0.6 x
  wrist-to-middle-knuckle) because the palm width collapses in a view along the knuckle line, and the forearm strip is in
  the probable-background band so the band's edge does not cut the forearm. No wrist cut (the carving's forearm rule
  handles what lies beyond the volume). `segmentation/analyseHand` itself was not used per view: its wrist cut and its
  gates assume a palm-facing picture, and a 2D wrist cut that differs from view to view would carve the wrist.
* **(b) `plane`** (new, board-free): every pixel's ray is intersected with the table plane of the SfM table frame and the
  table point looked up in up to 4 neighbouring sweep frames within 26 degrees (the plane homography with distortion,
  from the SfM poses). A pixel is table when, for at least one neighbour, the zero-mean normalised cross-correlation of
  the BAND-PASSED grey pictures (grey minus a 2 px Gaussian) over a 5 x 5 window reaches 0.6 (best of the windows that
  contain the pixel, so the hand's outline is not fattened), both windows carry 2D texture (smallest structure-tensor
  eigenvalue >= 4: an edge shifted along itself by the parallax still correlates, the aperture problem; the fingers'
  outlines run along the ring's parallax) and the pixel's own colour is within 22 of the warped one. Hand = the
  never-agreeing region inside the projected volume, connected to the landmark skeleton. Pixels whose ray misses the
  table, or meets it beyond the distance up to which this view confirmed any table at all (95th percentile), are
  UNKNOWN. Why band-pass and 2D texture: without them the hand's smooth shading "agreed" with the hand seen through the
  plane in a neighbour that also hides the table point (first try: mean IoU 0.28; band-pass 0.79; plus 2D texture and
  the verifiable radius 0.92).
* **(c) `combined`**: GrabCut seeded by the plane evidence: table-confirmed pixels at least 3 px from anything
  unconfirmed are sure background (the hand's near-table rim agrees too and must not teach the background model skin),
  the landmark skeleton is sure hand, the grown landmark hull and the forearm strip up to the cut are probable hand, the
  rest of the projected volume probable background, outside it sure background.

The landmarks used for seeds are the multi-view triangulation projected into each view (a view whose detector failed
still gets seeds). Rejections per view: `no_landmarks`, `landmarks_outside_mask` (fewer than 18 of 21 inside the mask or
unknown), `mask_empty`, `table_not_verified` (under 30 % of the table around the hand confirmed), `opencv_missing`.

IoU with the renderer's masks inside the projected carving volume (the only pixels the carving uses), 17 carving views
at 640 x 360, the chain's own SfM poses for each capture, speckle sweep, 4 skin tones (`multiview/scene.ts` SKIN_TONES,
illustrative values). Grid block `seg`, SIMULATED:

| skin | method | mean IoU | min IoU | views rejected | hand px unknown | IoU per view (top, e12-000 ... e12-338) |
|---|---|---|---|---|---|---|
| light | grabcut | 0.875 | 0.762 | none | 0.0 % | 0.84 0.76 0.78 0.86 0.90 0.92 0.93 0.94 0.97 0.87 0.92 0.94 0.89 0.88 0.86 0.82 0.80 |
| light | plane | 0.918 | 0.874 | none | 0.7 % | 0.87 0.91 0.93 0.92 0.90 0.91 0.92 0.94 0.97 0.96 0.95 0.93 0.89 0.90 0.90 0.92 0.90 |
| light | combined | **0.972** | **0.940** | none | 0.0 % | 0.94 0.94 0.98 0.98 0.98 0.98 0.98 0.99 0.94 0.98 0.98 0.98 0.97 0.98 0.97 0.97 0.97 |
| medium | grabcut | 0.884 | 0.772 | none | 0.0 % | 0.84 0.77 0.81 0.85 0.92 0.94 0.94 0.95 0.97 0.87 0.97 0.92 0.89 0.88 0.86 0.83 0.80 |
| medium | plane | 0.921 | 0.881 | none | 0.7 % | 0.88 0.93 0.95 0.92 0.91 0.91 0.92 0.93 0.97 0.96 0.95 0.93 0.90 0.90 0.90 0.91 0.90 |
| medium | combined | **0.969** | **0.916** | none | 0.0 % | 0.94 0.95 0.97 0.98 0.97 0.98 0.97 0.98 0.92 0.98 0.98 0.98 0.97 0.98 0.97 0.97 0.97 |
| dark | grabcut | 0.919 | 0.787 | none | 0.0 % | 0.92 0.79 0.81 0.87 0.94 0.96 0.96 0.98 0.99 0.88 0.97 0.98 0.98 0.99 0.94 0.84 0.80 |
| dark | plane | 0.913 | 0.867 | none | 0.6 % | 0.88 0.92 0.96 0.92 0.88 0.89 0.91 0.93 0.97 0.96 0.95 0.91 0.88 0.89 0.87 0.89 0.92 |
| dark | combined | **0.967** | **0.943** | none | 0.0 % | 0.94 0.97 0.98 0.97 0.97 0.98 0.96 0.94 0.96 0.99 0.98 0.97 0.97 0.97 0.96 0.96 0.97 |
| veryDark | grabcut | 0.938 | 0.787 | none | 0.0 % | 0.94 0.79 0.81 0.98 0.98 0.99 0.98 0.99 0.99 0.88 0.97 0.99 0.98 0.99 0.98 0.89 0.81 |
| veryDark | plane | 0.909 | 0.866 | none | 0.6 % | 0.87 0.91 0.95 0.91 0.88 0.89 0.91 0.92 0.97 0.96 0.95 0.91 0.87 0.88 0.87 0.89 0.92 |
| veryDark | combined | **0.965** | **0.943** | none | 0.0 % | 0.94 0.97 0.98 0.96 0.96 0.98 0.95 0.97 0.95 0.99 0.98 0.97 0.96 0.97 0.95 0.96 0.97 |

* GrabCut alone confuses the cast shadow (darker table) with skin; its mean IoU rises as the skin darkens (0.875 light to
  0.938 very dark) and it is worst in the views facing the fingertips (e12-000, e12-338: 0.76 to 0.81). Its errors
  are consistent across views, which is why the carving's gates do not see them (results table).
* Plane consistency is nearly skin-independent (0.909 to 0.921: it does not look at colour), loses the near-table rim
  (no parallax within a millimetre or two of the plane) and thin structures, and leaves 0.6 to 0.7 % of the hand
  unknown. On its own it fails the carving gates (it refuses rather than measuring wrongly).
* Combined is best for every tone (mean 0.965 to 0.972, worst view 0.916 to 0.943) and is the chain's recommended
  method. Time: about 1 to 2 s per view at 640 x 360 on a desktop (plane evidence with 4 neighbours ~0.8 s, GrabCut the
  rest); phones several times slower.
* Not tested: other textures (plane consistency needs the same rich texture the SfM needs), real shadows, specular skin,
  real video frames.

## The forearm cut: the stage 3 gate failure, its cause and the fix

Stage 3 carved with the board route's rule (`multiview/reconstruct.ts`): a HAND pixel whose ray crosses the box beyond
the cut (x below the cut, the volume's whole y range, table to 80 mm) is unknown. Its worst view, the one looking along
the forearm, scored 0.791 against the 0.80 gate and stage 3 attributed it to the frame's 0.18 degree yaw. Looking at the
pixels of that view (diagnostic renders made during this stage) shows the real cause: **seen from behind the forearm,
every ray to the hand crosses that box, so the whole hand except the thumb tip is unknown**; the check is then decided
by about 480 known hand pixels against the one-pixel over-fill of the hull along the fingers' outline (35 false-positive
pixels), so ANY small perturbation tips it. With the exact poses it was 0.813; the yaw only moved a marginal number.

Fix (`carve.ts`, cut policy `"forearm"`, the default): a first carving with the board rule finds the hull's cross-section
at the cut; the region beyond the cut is that cross-section plus 3 mm, prolonged backward (where the forearm really
continues, as the views carved it). Hand pixels whose rays cross THAT region, and any pixel whose ray meets it before the
volume (its classification belongs to the forearm), are unknown. Fingers seen OVER the forearm stay known. The carved
hull and the reprojection check see the cut the same way, whatever the frame's in-plane rotation. No threshold changed.
Also, the frame's x axis now comes from a least-squares line through five triangulated landmarks of the hand's middle
line instead of two (`tableFrame.ts`, method `"silhouette"`, named for the hand's outline line; it uses landmarks).

SIMULATED, speckle sweep, exact masks, 17 carving views, voxel 1.5 mm (IoU of the views looking along the forearm;
"-" = fewer than 200 known hand pixels, not checkable; every other view 0.97 to 0.99 in every row):

| poses / frame | frame yaw vs truth | cut policy | e12-158 | e12-180 | e12-202 | gates | length | breadth | thickness | circ. |
|---|---|---|---|---|---|---|---|---|---|---|
| SfM, two-landmark frame (stage 3) | 0.211 deg | box (stage 3) | 0.953 | - | 0.813 | pass (marginal) | -0.0 | +1.4 | +1.7 | +0.4 |
| SfM, two-landmark frame | 0.211 deg | beyond-cut (whole box, first hit) | 0.967 | - | 0.881 | pass | -0.0 | +1.5 | +2.3 | +1.0 |
| SfM, two-landmark frame | 0.211 deg | **forearm** | 0.983 | 0.965 | 0.978 | pass | -0.0 | +1.4 | +1.7 | +0.4 |
| SfM, hand-line frame | -0.029 deg | box | 0.942 | - | 0.829 | pass (marginal) | -0.1 | +1.3 | +1.7 | +0.4 |
| SfM, hand-line frame | -0.029 deg | **forearm** (stage 4 default) | 0.982 | 0.967 | 0.979 | pass | -0.1 | +1.3 | +1.7 | +0.4 |
| exact poses | 0 | box | 0.944 | - | 0.813 | pass (marginal) | -0.1 | +1.3 | +1.8 | +0.3 |
| exact poses | 0 | **forearm** | 0.982 | 0.965 | 0.980 | pass | -0.1 | +1.3 | +1.8 | +0.3 |

(This run's SfM is not stage 3's run: the hand is now left out of the features by the landmark region, not the true
mask, and its 0.211 degree frame passed at 0.813 where stage 3's failed at 0.791. That is the point: under the box rule
the worst view sits at about 0.81 whatever the poses.) The forearm policy lifts the worst along-arm view from about 0.81
to about 0.98, makes e12-180 checkable at all, and leaves every measurement unchanged; the whole-box "first hit" variant
also passes but loses background evidence above the forearm (thickness +0.5 mm). The hand-line frame cuts the yaw from
0.21 to 0.03 degrees on this run (one run; not a statistic). The default suite checks the policy on a small exact-mask
carving (`boardfree.test.ts`).

## Refusals (named, tested)

| case | where | reason (SIMULATED run) | test |
|---|---|---|---|
| speckle sweep, coin beside the hand | | **accepted**, gates passed, IoU 0.962 to 0.989 | `e2e.test.ts` |
| plain table, the same sweep | SfM | `sfm_failed` (too_few_views_registered) | `e2e.test.ts` |
| the board capture's 17 stills, no board | frame count | `too_few_frames` (17, needs 40); with that rule off the SfM refuses too: `sfm_failed` (no_matches) | `e2e.test.ts`, `boardfree.test.ts` |
| coin partly under the palm | before any geometry | `coin_missing` (no frame showed the whole coin) | `e2e.test.ts` |
| coin whole in only 3 frames | before any geometry | `coin_partial` | `boardfree.test.ts` |
| no coin | before any geometry | `coin_missing` | `boardfree.test.ts` |
| frames of different sizes | before any geometry | `pictures_differ_in_size` | `boardfree.test.ts` |
| partial registration (wood grain, plaid, frames 10+ degrees apart in stage 3) | SfM | `sfm_partial_registration` | stage 3 grid |
| large feature or coin residual | SfM | `camera_geometry_poor`, `coin_fit_poor` | not exercised |
| no plane / no landmarks / too few carving views | frame | `no_table_plane`, `no_hand_landmarks`, `too_few_carving_views` | not exercised |
| fewer than 12 carving views segmented | segmentation | `segmentation_failed` (with the per-view reasons) | not exercised |
| reconstructed but a gate fails | carving | not refused; `accepted: false` with the gate reasons (as the board route), e.g. the plane-only segmentation | `grid.test.ts results` |

Every refusal carries plain words (`BOARD_FREE_REFUSAL_WORDS`) and the numbers behind it (`refusalDetail`).

## Results: board-free vs exact poses vs the board route (SIMULATED, the same capsule hand)

Speckled table, continuous sweep (57 frames, 7.5 degrees apart on the low ring + an arc to the top), coin beside the
palm (23.00 mm, thickness ASSUMED 1.5 mm = rendered), medium skin, 1280 x 720, hfov 64 deg, k1 -0.06, k2 0.02 (unknown to
the chain), carving the 17 stills at 640 x 360, voxel 1.5 mm. The board route renders the same hand on the printed board
with the board capture's 17 stills and the same lens (`recon/chain.ts`, unchanged). Measured minus true, mm. Times:
desktop Node.js on a shared machine, renders excluded (grid block `results`).

| route | gates passed | length | breadth | thickness | knuckle circ. (upper bound) | min / mean IoU | time s |
|---|---|---|---|---|---|---|---|
| exact poses and intrinsics, EXACT masks | yes | -0.1 | +1.3 | +1.8 | +0.3 | 0.965 / 0.981 | carve 1.9 |
| exact poses and intrinsics, grabcut segmentation | yes | -0.5 | **+14.4** | +3.2 | **+21.6** | 0.842 / 0.917 | segment 9.0, carve 1.7 |
| exact poses and intrinsics, plane segmentation | no [surface_poorly_observed, fragmented_mesh, reprojection_mismatch, hull_truncated_by_volume] | -1.9 | +0.2 | +1.4 | n/a | 0.719 / 0.921 | segment 4.4, carve 2.5 |
| exact poses and intrinsics, combined segmentation | yes | -0.5 | +1.4 | +2.9 | -0.3 | 0.959 / 0.974 | segment 8.0, carve 1.5 |
| board-free SfM poses, EXACT masks | yes | -0.1 | +1.3 | +1.7 | +0.4 | 0.967 / 0.980 | sfm 25.6, carve 1.7 |
| board-free SfM poses, grabcut segmentation | yes | -0.4 | **+14.8** | +3.0 | **+22.4** | 0.829 / 0.918 | sfm 26.1, segment 6.9, carve 1.8 |
| board-free SfM poses, plane segmentation | no [surface_poorly_observed, fragmented_mesh, reprojection_mismatch] | -1.9 | +0.1 | +1.4 | n/a | 0.683 / 0.917 | sfm 27.0, segment 4.7, carve 2.5 |
| **board-free chain (SfM poses, combined segmentation)** | **yes** | **-0.4** | **+1.2** | **+2.7** | **-0.2** | 0.962 / 0.974 | sfm 27.5, segment 9.3, carve 1.6; total 38.5 |
| board route (markers, self-calibration, board segmentation) | yes | +0.0 | +1.6 | +2.5 | +2.1 | 0.915 / 0.971 | detect 0.4, calibrate 0.1, reconstruct 3.5; total 4.0 |

Camera geometry of the board-free run: focal length +0.017 %, k1 -0.0597 (true -0.06), 57 / 57 frames, feature RMS
0.53 px (median 0.28, p95 1.10), coin outline RMS 0.27 px over the 25 frames that saw it whole, table plane RMS 0.37 mm
(8321 inliers). Stage-5 inputs of that run: conditional pose sigmas at most 0.016 deg / 0.12 mm, focal 0.0014 % (lower
bounds); scale components fit 0.016 %, reference diameter 0.251 %, **thickness 1.101 %** (the assumed +-0.5 mm), RSS
1.13 %: the unverified coin thickness dominates the scale uncertainty.

Reading:
* With the combined segmentation the board-free chain passes every gate and measures this simulated hand as well as the
  board route (within 0.5 mm on length and breadth, thickness +2.7 vs +2.5, circumference -0.2 vs +2.1). Its geometry
  (SfM) costs about 27 s on a desktop vs 0.5 s for the markers: phones will be several times slower.
* **The gates do not catch a CONSISTENT segmentation error.** GrabCut seeded only by the landmarks includes the hand's
  cast shadow on the table in the low views; the hull is then 14 to 15 mm too wide and the circumference 22 mm too large,
  and every gate still passes (each view's mask agrees with a hull built from the same biased masks). The gates check
  consistency, not truth. The plane test sees the shadow as table (it lies on the plane), which is what the combined
  method adds.
* Plane consistency alone fails the gates (fragmented mesh, reprojection mismatch): the near-table rim of the fingers
  agrees with the table (within a millimetre or two of the plane there is no parallax) and thin fingers break. It refuses
  rather than measuring wrongly.
* Repeat runs differ slightly (GrabCut's k-means state, RANSAC): the e2e run of the same chain gave -0.4 / +1.2 / +2.7 /
  -0.0 mm and worst IoU 0.962.
* Thickness is +1.7 to +2.9 mm in every route including exact poses and exact masks: the visual hull's over-fill with 17
  views (an upper bound), not the poses.

## Photo-consistency refinement for concavities (investigated, not shipped)

What a visual hull cannot recover here: the palm side rests on the table (its hollow is never seen: no method using these
pictures can refine it; the table plane bounds it and the points are labelled `support_plane`), and the finger gaps no
view looks straight through. Space carving / voxel colouring would remove surface voxels whose colour disagrees across
the views that see them.

Quick experiment (`photo.ts`, grid block `photo`; SIMULATED, exact poses and exact masks so only the colour signal is
tested; 17 views at 640 x 360, voxel 1.5 mm; visibility by marching through the hull): of the hull's voxels 4.3 % lie
outside the true hand. Over 6 783 classified surface voxels (5 652 within a voxel of the true surface, 1 131 more than a
voxel outside), the grey-level spread across the views that see a voxel (about 5 views on average) has median 1.2 for
true-surface voxels and 3.8 for over-fill voxels; the probability that an over-fill voxel is less consistent than a true
one is 0.72 (0.5 = no signal). A threshold at the true voxels' 95th percentile would remove 480 of the 1 131 over-fill
voxels (42 %) and 283 true-surface voxels (5 %, i.e. it would also cut into the hand). One pass took 80 ms on a desktop.

Assessment:
* **The signal exists but is weak, and this simulation flatters it**: the renderer's skin is Lambertian and uniform with
  2.5 grey levels of noise, so a true surface point looks the same from every view. Real skin is glossy (view-dependent
  highlights), translucent and changes exposure between video frames: the true voxels' spread grows and the separation
  (already only 0.72) shrinks. On uniform skin the over-fill between two fingers is often seen as skin of one finger or
  the other: consistent colour, so it stays.
* **What it could improve**: finger gaps seen obliquely, the thumb web. Not the palm hollow (never seen), not the length
  (fingertips are silhouette-bounded), little for breadth and circumference (silhouette-bounded at the knuckle section:
  breadth +1.2 and circumference -0.2 mm here already). Thickness over-fill (+1.7 to +2.9 mm in every route) comes from
  too few low views, which photo-consistency on smooth skin cannot fix; more low views (the sweep has 48) could.
* **Cost on a phone**: one consistency pass is cheap (80 ms desktop, perhaps 0.5 s on a phone), but space carving
  iterates (visibility changes as voxels go): typically 10 to 50 passes, i.e. seconds to tens of seconds on a phone in
  JavaScript; a WebGL / WebGPU version would be needed. Memory is small (the hull grid, 17 half-size pictures).
* **Recommendation**: not worth shipping before real captures show the hull's over-fill matters for the sizes being
  measured; if pursued, use more sweep frames as silhouettes first (free), then a robust (not threshold) photo term with
  a smoothness prior, evaluated on real hands with physical references.

## Files and API

| File | What |
|---|---|
| `chain.ts` | `reconstructBoardFree` (the chain, refusals with `BOARD_FREE_REFUSAL_WORDS`), `segmentAndCarve`, `neighbourFrames`, `autoCarveViews`. |
| `sfmStage.ts` | `runSfmStage` (stage 3 SfM driven from the frames), `handExclusionMask` (landmark region), `sfmUncertainty`. |
| `tableFrame.ts` | `fitTablePlane`, `buildTableFrame` (`"landmarks"`: stage 3's two landmarks; `"silhouette"`: the hand's middle line), `carveInputs`, `volumeFromLandmarks`. |
| `segment.ts` | `planeEvidence`, `segmentView` (`grabcut`, `plane`, `combined`), `landmarkSeeds`, `halveImage`, `scoreAgainstTruth`. |
| `carve.ts` | `carveBoardFree` (carving, labels, point cloud, gates, measurements), cut policies `box` / `beyond-cut` / `forearm`, `forearmBeyond`, `buildPointCloud`, `tableLimits`. |
| `types.ts` | `BoardFreeFrame`, `ViewSegmentation`, `BoardFreeFrameDef`, `CarveInput`. |
| `simulate.ts` | Test support: `SimCache`, `simulateCapture` (renders, detector stand-ins, truth kept apart). |
| `evaluate.ts` | Test support: `runChain`, `runExactPoses`, `runBoardRoute` (imports `recon/chain.ts` unchanged), table rows. |
| `photo.ts` | The photo-consistency feasibility experiment. |
| `boardfree.test.ts` | Default suite (~15 s): exclusion region, plane evidence on 320 x 180 renders, the forearm cut policy on a small exact-mask carving, point-cloud labels, view selection, refusals that need no SfM. |
| `e2e.test.ts` | Opt in `RUN_BOARDFREE_E2E=1` (minutes): speckle sweep accepted; plain table, stills and a coin under the hand refused. |
| `grid.test.ts` | Opt in `RUN_BOARDFREE_GRID=seg,results,photo` (or `all`; about an hour): the tables of this file. |

```powershell
cd C:\Users\pc\Downloads\OPEN-CV\frontend
npx vitest run --no-file-parallelism src/experimental/boardfree
$env:RUN_BOARDFREE_E2E = "1"; npx vitest run --no-file-parallelism src/experimental/boardfree/e2e.test.ts
$env:RUN_BOARDFREE_GRID = "all"; $env:BOARDFREE_RENDER_CACHE = "$env:TEMP\bf-cache"; npx vitest run --no-file-parallelism src/experimental/boardfree/grid.test.ts
```

## What the chain is given (and what stands in for a detector)

The pictures, all one size, and the capture guide's approximate direction per frame (used only to pick which pairs to
match). Two detector **stand-ins**, as the board route's own test does: the 21 landmarks are the synthetic landmarks
projected with the TRUE camera plus 2 px noise (MediaPipe stand-in), and the coin's outline edge points come from the
renderer's coin label (`sfm/coinEdges.ts`; the coin detector `coin/measureCoin.ts` needs OpenCV.js and its board-free
use is another stage's work). Nothing else: no focal length, no distortion, no pose, no mask.

## Limitations

* Everything is SIMULATED: Lambertian procedural textures, a capsule hand, a perfectly flat table, a still hand, a
  global-shutter camera with exactly radial k1/k2 and a centred principal point, no motion blur or compression, no
  auto-exposure or refocus. The coin outline and the landmarks are stand-ins (above).
* The coin thickness is UNVERIFIED: 0.5 mm wrong moves the scale by about -1.5 / +1.9 % (stage 3).
* Plane consistency needs a richly textured table, the same condition the SfM already needs; it was tested only on the
  speckle texture.
* The forearm cut assumes a forearm that continues straight back from the cut with the cross-section the views carved
  there (3 mm margin); a bent wrist or an arm lifted off the table is not modelled.
* The conditional pose / intrinsics sigmas are lower bounds; no full covariance.
* Timings are desktop Node.js on a shared machine; phones are several times slower; nothing ran on a phone.
