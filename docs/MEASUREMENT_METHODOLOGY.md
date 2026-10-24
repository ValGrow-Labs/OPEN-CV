# Measurement methodology and limitations

This document defines exactly what the system measures, how it does so, and what it cannot
measure. It describes the implementation in `backend/glovesize/` (reference) and
`frontend/src/vision/` (browser port). All thresholds quoted here are in
`config/measurement.json`.

**Status.** No real-world reference measurements have been collected yet
(`config/measurement_calibration.json` is `uncalibrated`). Every accuracy figure in this
repository comes from synthetic software tests or from the pinhole-camera simulation in
`docs/CALIBRATION_STUDY.md`. Neither is evidence of real-world accuracy.

## 1. Capture

The customer holds an open hand, palm towards the camera, with a US quarter lying flat on the
centre of the palm.

1. **Reference confirmation.** Before the camera starts, the customer confirms which coin they
   are holding ("Which coin are you holding?"; the dialog shows its diameter). The confirmation
   is sent with the scan as `reference.confirmed`. The server rejects unconfirmed scans
   (`reference_unconfirmed`). The system does **not** assume that any circular object is a
   quarter: image analysis cannot tell a quarter from a nickel or a button of similar colour.
2. **MediaPipe Hand Landmarker** (pretrained, `hand_landmarker.task`, float16 v1) returns 21
   image landmarks (pixels) and 21 *world* landmarks. World landmarks are the model's own metric
   3D estimate. They are used only for plausibility gates and are never reported as
   measurements.
3. A **coin search window** is placed around the palm centre (mean of landmarks 0, 5, 9, 13, 17).
   Its half-size is `0.75 × palm length`, and the coin diameter must be between `0.12` and
   `0.7 × palm length`.
4. **Coin detection** (§2) runs on that window only.
5. **Live checks** mirror the server gates and give immediate guidance (move back, flatten the
   hand, uncover the coin, and so on; §1.1). Frames that pass every check are collected, at most
   one every `live_scan.min_frame_interval_ms` (50 ms), until the target
   (`capture.frames_target`, 24; `live_scan.mobile_frames_target`, 16, on phones) or until the
   frames agree closely enough to stop early (`live_scan.early_stop_*`). After
   `live_scan.timeout_s` (45 s) the scan finishes with what it has, or says why it could not.
6. Only numbers are sent to `/api/scan`: landmarks, the coin ellipse with its quality metrics,
   and brightness. **No pixels leave the device.** The server re-applies every gate
   authoritatively.

### 1.1 Live guidance, layout and exposure

The per-frame checks decide which frames are *usable*. What the customer is *told* is a separate,
steadier signal. Neither changes a gate or a threshold.

* **Steady messages.** Frame by frame the checks flip (a flat coin reads "tilted" now and "fine" a
  moment later), and a message that changes every few hundred milliseconds cannot be acted on.
  `scan/guidance.ts` shows the problem that dominates the last `live_scan.guidance_window_ms`
  (1200 ms), provided it covers at least `guidance_min_share` (35%) of those frames and the window
  holds at least a third of its length in frames. A message is kept for at least
  `guidance_hold_ms` (1000 ms), and afterwards while it still covers `guidance_keep_share` (20%).
  A different problem replaces it only when its share exceeds the shown one's by
  `guidance_switch_margin` (15 points), so two problems of similar weight do not take turns.
  "No hand" is shown at once and restarts the window. Frames are still collected only when the
  *per-frame* result is fine, so the steady message never lets an unusable frame through.
* **Main problem.** After `live_scan.hint_after_s` (6 s) without enough frames, the screen names
  the most frequent per-frame problem over the last `issue_window_s` (4 s), and the timeout
  message names it with its share of camera frames. This is a count, not a judgement of cause.
* **Fixed layout.** The live hand-length row and the "main problem" row keep their space even
  when empty (the hint row has a fixed height and shows at most two lines), so the camera
  picture does not change size while the scan runs.
* **Live lengths** (`live_scan.show_live_measurements`) are single-frame landmark distances
  scaled by that frame's coin. They only show that measuring is happening; the reported values
  come from the server, which combines all frames, and they are labelled as such.
* **Automatic exposure** (`live_scan.auto_exposure`). A phone camera exposes for the whole
  picture; a dark background can make it brighten the scene until the coin is blown out and
  refused for glare (`coin_glare`: more than `max_glare_fraction` = 20% of the coin's pixels at
  or above `glare_level` = 250). Where the browser exposes `exposureCompensation` on the camera
  track (Chrome on Android does; Safari on iOS does not), the exposure is eased down by
  `exposure_step_ev` (0.5 EV) while glare or `too_bright` dominates (at least
  `exposure_min_share` = 40% of the main-problem window), and up while the picture is too dark,
  no faster than once per `exposure_hold_ms` (1500 ms) and within `exposure_min_ev` /
  `exposure_max_ev` (−2 / +1 EV) and the camera's own range. A camera that refuses the request
  is left alone for the rest of the scan. This is untested on real phones. After each step the
  decision uses only the camera frames taken since that step (the earlier ones describe the old
  picture), so a step is not repeated on stale readings. The glare gate and the brightness gate
  are unchanged and still apply.

The `?debug=1` panel shows, for the current frame, the coin's tilt as read from this frame alone
and as averaged (§3.1), the coin's glare percentage, the exposure setting if it can be
controlled, and the main problem with its share.

## 2. Coin detection

The reference implementation is `coin_detection.py`. The browser port is `coinDetector.ts`; a
parity test checks it against fixtures generated by the Python reference
(`src/vision/__fixtures__/coin_scenes.json`).

| Step | Method |
|---|---|
| Colour channel | Signed warm-chroma channel `c = (R − B) / (R + G + B + 30)`, mapped to `clip(3c·127.5 + 128, 0, 255)`. Cupronickel coins sit near 128; skin sits above. Because the channel is signed, it does not clip under cool white balance (see below). |
| Candidate generation (compared) | (a) **Chroma segmentation**: Otsu threshold. (b) **Contours**: Canny, then closing, convex-hull circularity ≥ 0.72, then `fitEllipse`. (c) **Hough**: `HoughCircles`. Duplicates are merged and the source methods recorded. Candidates outside 0.8–1.1× the expected size are dropped. |
| Refinement | 144 rays from each candidate centre. Along each ray, the strongest outward rise of the smoothed chroma channel is located to sub-pixel precision (parabolic interpolation). An ellipse is fitted to these points with MAD outlier rejection. A second, narrower (±8%) pass follows. |
| Quality metrics | Edge support (fraction of rays with a consistent edge), largest angular gap, RMS fit residual, edge width (blur proxy), glare fraction (pixels ≥ 250 inside the coin), coin/skin contrast |
| Acceptance | Hard gates on every metric (`coin_detection.accept`), plus a heuristic quality score ≥ 0.6. The score is the geometric mean of linear ramps whose ends are in `coin_detection.score`. **It is a detection-quality heuristic, not a probability.** |
| Ambiguity | If another circle elsewhere in the window also passes every gate and scores at least 0.8× the best one, the frame is rejected as `coin_ambiguous` instead of guessing which circle is the coin. |
| Size | Coins smaller than 40 px across are rejected (`coin_too_small`). At that size, a 0.5 px edge error is already 1.25% of scale. |

**Why the chroma channel.** On scenes where the quarter's raised rim is brighter than the skin,
grayscale edge detection locks onto the rim's inner edge. For an 80 px coin that gives about
74 px, a 7.5% scale error. Skin of every tone is warm (R > B) and cupronickel is achromatic, so
the chroma step sits at the coin's outer boundary. **Only silver-coloured references are
supported**: a copper penny would not work.

**Signed channel (Phase 2 fix).** The earlier channel clipped at 0 for neutral and cool
pixels. Under a cool white balance (simulated: blue ×1.2, red ×0.85), skin chroma fell close
to the coin's, and the detector *accepted* a coin with a 1.35% diameter error. The signed
channel keeps the step: the same 80 px scene now measures 80.21 px, which is the synthetic
renderer's anti-aliasing bias.

**Tested on synthetic scenes** (`tests/test_coin_detection.py`):

* Accepted within tolerance: rotation of the whole image, cool and warm white balance, under-
  and over-exposure, low contrast.
* Rejected: partial occlusion, strong glare, heavy blur, coins under 40 px, no coin, a warm
  (copper-coloured) disc, and two similar coins in the window (`coin_ambiguous`).

These are synthetic renders. Real coins have embossing, wear, specular highlights and shadows
that the synthetic renderer only approximates.

## 3. Calibration: from the coin to the hand

`pixels_per_mm_at_coin = coin_major_axis_px / 24.26`

This establishes scale **only at the coin's top face**, at the centre of the palm. Applying it
to the landmarks needs further assumptions. `docs/CALIBRATION_STUDY.md` compares four methods
on simulated pinhole geometry:

| Method | Description | Status |
|---|---|---|
| A | Coin scale applied directly to all landmarks | Biased low by about 3% at 350 mm in the simulation |
| B | A + affine rectification of the palm plane from the coin ellipse | **Off** (`tilt_rectification: false`): over-corrects under real perspective |
| C | A + coin-thickness depth offset | Removes about 0.5% of the bias |
| D | C + *assumed* 10 ± 5 mm joint-centre depth (default) | Near zero bias **only if** the assumption holds; ±1.5% if the joints are 5 or 15 mm deep |

A second view, a depth camera or known camera intrinsics would let some of these effects be
measured rather than assumed. The prototype has none of them, so **perspective is not
corrected**. It is limited by gates and represented in the uncertainty.

### 3.1 Tilt

A circle viewed at tilt τ appears as an ellipse with `minor/major ≈ cos τ`. Under real
perspective, however, the ellipse's apparent tilt is itself distorted. In the simulation, a
true ±10° pitch read as 7.0° or 13.8°, depending on direction. Therefore:

* τ > 12° → frame rejected (`coin_tilted`). τ is the tilt estimated as in §3.1.1.
* 8° ≤ τ ≤ 12° → accepted with a warning to hold the hand flatter.
* No rectification is applied by default. The foreshortening residual
  `0.23 · sin τ / √3` (a uniform distribution over the possible tilt axes, with the coefficient
  from the simulation) is added to the relative uncertainty.

Rectification can be enabled for experiments (`calibration.tilt_rectification: true`). In the
simulation it over-corrected an 18° pitch by +2.5% and a 25° pitch by +5.5%.

#### 3.1.1 Estimating the tilt from several frames

One frame's tilt is `acos(minor / major)`. For a coin lying flat the true ratio is 1, and edge
noise can only pull a measured ratio *below* 1 (the long axis is always the larger one), so a
single frame reads a spurious tilt that averaging the angles cannot remove. The angle is also
very sensitive near 1: a 1% error in the ratio reads as about 8°, and 2% as about 11.5°. The
12° gate therefore sits inside the noise of a single frame.

The tilt used for the gate, for the choice of tilt handling and for the tilt term of the
uncertainty (§5) is instead taken from the **average ellipse of neighbouring frames**. Each
coin ellipse is written as a 2 × 2 shape matrix

    Σ = (major / 2)² · u uᵀ + (minor / 2)² · v vᵀ      (u: unit vector along the long axis, v ⟂ u)

the matrices of the frames in the window are averaged, and the tilt is
`acos(√(λmin / λmax))` of the average. Noise has no preferred direction, so the average shape
converges to a circle for a flat coin, while a really tilted coin keeps one consistent direction
and keeps its tilt. The window is `calibration.tilt_window_frames` (7).

* **Server** (`calibration.smoothed_coin_tilts`, used in `pipeline.process_scan`): a window
  centred on each submitted frame, shorter at the ends and skipping frames without a coin.
  `measure_frame` and `frame_scale` receive the result as `tilt_deg`; without it they fall back
  to the frame's own tilt.
* **Phone** (`vision/coinTilt.ts`, used in `scan/scanController.ts`): the last 7 coin results
  that were found and either accepted or at least `live_scan.track_min_confidence` confident,
  cleared when the coin is lost or the hand goes. The window is causal, not centred, so near the
  limit a frame the phone passes can still be refused by the server.
* The two implementations give the same numbers on the same input: `frontend/src/vision/coinTilt.test.ts`
  asserts the values the Python code produced for two fixed sets of seven ellipses
  (5.300297645880132° and 19.802423221423975°). The Python side is covered by
  `backend/tests/test_tilt_smoothing.py`.

*Synthetic evidence only.* Ellipses of a coin of 60 px with axis-ratio noise σ and a random
direction (`tests/test_tilt_smoothing.py` and the experiment behind it; these numbers describe
the estimator on made-up data, **not real-world accuracy**):

| flat coin, noise σ on the axis ratio | frames over 12°, one frame | frames over 12°, window 7 |
|---|---|---|
| 0.010 | 1.8% | 0.0% |
| 0.015 | 12.8% | 0.0% |
| 0.020 | 25.5% | 0.0% |
| 0.030 | 45.0% | 2.2% |

| true tilt (one direction, σ = 0.02) | frames flagged, one frame | frames flagged, window 7 |
|---|---|---|
| 10° (inside the limit) | 36.0% | 18.2% |
| 15° | 73.8% | 97.2% |
| 20° | 97.2% | 100% |

A second synthetic model describes the noise more faithfully: every frame's shape matrix gets
an error with no preferred direction (σ = 14 px² on a 30 px radius, so a flat coin is over 12°
in 13% of single frames), while a real tilt keeps its direction. The window-7 average is then
unbiased (a true 14° reads 14.0° on average) and the gate becomes a sharp step:

| true tilt | frames over 12°, one frame | frames over 12°, window 7 |
|---|---|---|
| 0° (flat) | 12.6% | 0.0% |
| 6° | 17.4% | 0.0% |
| 10° | 37.6% | 7.1% |
| 12° | 59.1% | 50.3% |
| 14° | 82.7% | 98.1% |
| 16° | 95.6% | 100% |

Averaging therefore removes most false rejections of a flat coin and makes a really tilted coin
easier to flag, but a coin whose true tilt is just inside the limit is still refused fairly
often (18% of frames at 10°, σ = 0.02). In a separate synthetic test, rendered flat coins with
heavy blur and noise (σ_blur 2 px, σ_noise 5) read a median of 10.7° at 45 px diameter, with 29%
of frames over 12°. The average ellipse is also sensitive to a single bad ellipse: one coin
with axis ratio 0.85 among seven flat ones lifts the average to about 11.5° for all seven
frames.

**The 12° gate itself is unchanged and unvalidated.** Nothing here shows that 12° (or 8°, or
the uncertainty coefficient 0.23) is the right limit for real hands; the change only makes the
estimate of the tilt less noisy, which also removes a spurious tilt term from the uncertainty
of a flat coin.

**What a real recording showed.** In a phone screen recording of 2026-10-24 (about 15 s, 0 of
16 frames collected, "keep your palm and the coin flat" the commonest message), the coin
ellipse the app drew read about 20° tilt (median axis ratio about 0.94, measured on the drawn
ring in 118 frames) in about 95% of the frames. A compressed screen recording cannot show
whether that is a really tilted palm and phone or estimator noise (the ring was only about 26 px
across). The debug panel now shows the single-frame and averaged tilt, the glare percentage and
the exposure, to settle that on the next phone test.

### 3.2 Depth layers

The coin's silhouette is its top face, about 1.75 mm in front of the palm skin. MediaPipe
landmarks approximate joint centres, which sit behind the skin. Points farther from the camera
look smaller, so:

`px_per_mm_at_landmarks = px_per_mm_at_coin × Z / (Z + Δ)`, with `Δ = coin thickness + landmark layer depth`.

* `Z` (camera-to-coin distance) is inferred from the coin's pixel size and an *assumed*
  horizontal field of view of 55–80° (on the long image side). Browsers do not expose camera
  intrinsics.
* The layer depth (10 ± 5 mm) is an **assumption**, not a measurement. Its ±5 mm and the Z
  range both enter the uncertainty.
* This is described as an assumption-based adjustment, not as a correction of perspective. It
  can be switched off (`depth_model.enabled`) so that the validation study can test it.

Close range magnifies these effects. Scans where the coin implies a camera distance below
250 mm (geometric mean of the Z range) are rejected (`too_close`). Because the true FOV is
unknown, a narrow (telephoto) lens at a normal distance can trigger this prompt. That is a
conservative false alarm, not a wrong measurement.

### 3.3 Remaining perspective, non-planarity and lens distortion

Fingertips and wrist are not exactly in the coin's plane, and lens distortion grows towards the
image edges. These are covered by a 1% relative term (`perspective_rel_sigma`) and by gates:

* the hand must stay within the frame margins (2%);
* the hand must occupy at least 30% of the shorter image side;
* 2D finger bend must be ≤ 25°;
* MediaPipe's 3D estimates must show finger bend ≤ 35° and palm tilt ≤ 30°;
* the hand length must be stable across the accepted frames (relative SD ≤ 2.5%,
  `scan_unstable` otherwise).

These terms are **not** physically measured. A single RGB view cannot recover them, so the
validation study must quantify the remaining error.

## 4. Measurement definitions

All lengths are in millimetres. Each value is the median over accepted frames after MAD outlier
rejection. Two terms are used below:

* **Physical**: a distance between two image points, scaled by the coin. It is still subject to
  the landmark-to-anatomy offset.
* **Estimate**: inferred from other measurements by a model. No such model is fitted yet.

Assumptions shared by every camera measurement:

1. The coin is a genuine 24.26 mm quarter (confirmed by the customer), lying flat on the palm.
2. The hand is flat and roughly parallel to the image plane (tilt ≤ 12°).
3. The joint centres are 10 ± 5 mm behind the skin, and the camera FOV is 55–80°.
4. Before calibration, the offset between landmarks and anatomical points is zero, with a prior
   SD from `measurement_calibration.json`.

### Hand length (`hand_length_mm`): sizing input

* **Anatomical definition:** distal wrist crease → tip of the middle finger (glove-industry
  definition).
* **Camera measures:** straight line from landmark 0 (wrist) to landmark 12 (middle
  fingertip).
* **Calculation:** `|p12 − p0|` in pixels, divided by `px_per_mm_at_landmarks`.
* **Physical or estimate:** physical length between two *model-predicted* points. Landmark 0 is
  not the wrist crease, and landmark 12 is near (not at) the fingertip skin edge. The mean offset
  must be fitted from tape measurements; until then it is an assumed 0 ± 5 mm.
* **Main error sources:** landmark-to-crease offset (person-dependent); joint-depth assumption
  (±1.5% in the simulation); tilt; finger curl (+1.6% at 8° per joint in the simulation); coin
  edge (0.5 px).

### Palm length (`palm_length_mm`)

* **Anatomical:** distal wrist crease → middle-finger MCP (knuckle) joint.
* **Camera:** landmark 0 → landmark 9 (MCP joint centre), straight line.
* **Physical**, with the same landmark-offset caveat (prior 0 ± 4 mm).
* **Error sources:** as for hand length. Less sensitive to finger curl.

### Knuckle span (`mcp_span_mm`)

* **Camera:** landmark 5 (index MCP) → landmark 17 (little-finger MCP) joint centres.
* **Physical** distance between joint centres. It is **narrower than palm breadth** because it
  excludes the soft tissue on both sides.
* **Error sources:** landmark placement across the knuckles, and hand rotation about its long
  axis.

### Palm breadth (`palm_breadth_mm`)

* **Anatomical:** skin edge to skin edge across the metacarpal heads.
* **Camera:** not measured. It would be an **estimate** from `mcp_span_mm` via a linear model
  fitted on reference data. That model does not exist yet (`derived.palm_breadth_mm: null`).
* Available today only as a customer tape entry.

### Hand circumference (`hand_circumference_mm`)

* **Anatomical:** around the knuckles (metacarpal heads), excluding the thumb.
* **Camera:** **not measurable from a single front-facing image**, which shows neither palm
  thickness nor cross-section shape. No model is fitted. It is used only when the customer
  enters it from a tape (±4 mm assumed).

### Finger lengths (`index/middle/ring/little_length_mm`) and thumb

* **Camera:** joint chain MCP → PIP → DIP → tip, as a sum of segments (thumb: 2 → 3 → 4).
* **Physical** along the joint chain. It starts at the joint centre, which is proximal to the
  palmar finger crease used in anthropometry, so the camera value is systematically longer than
  a crease-to-tip measurement.
* **Error sources:** finger curl, and fingertip landmark placement. The thumb rotates out of the
  palm plane, so its length is never better than "low confidence".
* **When a finger counts as bent.** Each long finger has two bend readings: the bend seen *in the
  image* (angles between its joint segments in pixels; accurate) and the bend in the hand model's
  *depth estimate* (the same angles on the model's world landmarks; noisy and biased).
  * The in-image bend is judged on every frame: over `capture.max_finger_bend_deg` (30°) the
    finger is left out of that frame (the middle finger rejects the frame, since hand length runs
    to its tip).
  * The depth bend is judged on the **median over the scan**: a finger whose median is over
    `capture.max_finger_bend_deg_3d` (60°) is "not straight enough" for the whole scan (for the
    middle finger the scan is rejected, `fingers_bent`). A single frame is dropped for it only
    beyond `finger_bend_3d_frame_factor` (1.5) times that limit.
  * Why: on two photos of real hands with straight fingers, perturbed 60 times each (rotation ±5°,
    scale ±8%, noise), the in-image bend read 1–7° but the depth bend read 19–33° for the index,
    middle and ring fingers and 35–41° for the little finger (medians). The depth bend of a
    straight finger is therefore far from 0 and close to the old per-frame limit of 50°, so
    straight fingers lost frames at random and could be left with too few. These are two photos
    of two hands, not a validation.
  * Why 60°: a finger with a total bend of 60° over its two joints has a straight-line tip
    distance about 4.5% shorter than its length (sin(B/2)/(B/2)), inside the 8% uncertainty
    already reported for finger lengths. The limit is provisional and unvalidated, like the
    others (`docs/VALIDATION_PLAN.md`).
  * The response lists each finger's median bends against the limits (`finger_bends`), and a finger
    that is refused shows them, so a refusal can be checked against real numbers.

### Proportions

Ratios of raw landmark distances. They do not depend on the coin scale. They are diagnostic
only and are not used for sizing.

Values outside plausible human ranges are rejected. An implausible hand length usually means
the wrong coin was confirmed.

## 5. Uncertainty model

Each measurement reports a 1σ uncertainty and a 95% interval. Before calibration, the
components are combined in quadrature:

| Component | Source |
|---|---|
| Frame variation | SD across frames ÷ √n (random) |
| Landmark localisation | 1.5 px at the model's 224 px input × 2.0 (MediaPipe's crop is about twice the hand's bounding box), scaled to the hand's image size, ×√2 for a distance. Systematic: not reduced by averaging. |
| Coin scale | `hypot(0.5 px edge floor, coin tolerance) / coin diameter` |
| Tilt | `0.23 · sin τ / √3` (no rectification) |
| Depth layer | Uncertainty of Z (FOV range) and of the joint depth (±5 mm) |
| Perspective & flatness | 1% of the value |
| Anatomical definition prior | Unknown landmark-to-anatomy offset (hand length: 5 mm). **A prior, not a measurement.** |

After calibration (`measurement_calibration.json` with `status: calibrated`), the uncertainty
becomes `hypot(fitted residual SD, frame variation)`. A fitted file is reported as
`fitted_unvalidated`. The basis becomes "validated" only when a person adds a `validation` block
recording held-out real-world evidence (at least 60 held-out participants, acceptance criteria
met, the report and the approver). No script writes that block, and passing tests or collecting
pilot records cannot set it.

Status is **valid** if the 95% interval is within ±8% of the value, **low confidence** if
within ±14%, and **invalid** otherwise (the value is hidden).

The "quality score" shown for the coin and the measurement statuses are heuristics about the
inputs. **None of them is a probability that the measurement or the glove size is correct.**

## 6. Sizing

`glovesize/sizing.py` applies the manufacturer's chart (`config/sizing_charts/*.json`) as rules:

* Each size has `[min, max)` ranges per measurement. A value exactly on a boundary goes to the
  larger size, as does a value in a gap.
* The `primary_only` rule uses the first measurement. The `largest_size` rule computes a size
  per measurement and takes the largest.
* Levels:
  * `clear`: ±2σ lies inside one size.
  * `likely`: ±1σ lies inside one size, but ±2σ reaches a neighbour, which is named as the
    alternative.
  * `borderline`: ±1σ spans two sizes. The size containing the value is recommended, and the
    nearer neighbour is named.
  * `uncertain`: ±2σ spans three or more sizes. **No size is returned.** The response lists
    `plausible_sizes` and `needed_measurements`, with instructions for measuring by tape.
* Tape values (`user_entered`) are never `uncertain`. Size charts are written for tape
  measurements, so a tape value's ±4 mm can make a result `borderline` at most.
* A missing or invalid required measurement returns `needs_more_data`, with instructions.

**Consequence today.** Uncalibrated, hand length has σ of about 7–8 mm, while the demo chart's
size steps are 12 mm. The camera alone therefore usually yields `uncertain`. The customer sees
which sizes are still possible and is asked for a tape measurement of hand length. This is
deliberate: the recommendation should become decisive only once a validation study shows that
the real error is smaller.

These levels describe **measurement uncertainty only**. They are not probabilities that a glove
fits, and no percentage is displayed.

## 7. Known limitations

1. A single RGB view cannot measure circumference or palm thickness, or reliably measure
   anything out of the palm plane.
2. Landmarks are joint centres predicted by a neural network. Their offsets from skin creases
   and fingertip edges differ between people. Calibration removes the mean offset; the
   person-to-person spread remains in the residual.
3. The depth adjustment relies on an assumed FOV range and an assumed joint depth. Perspective
   and lens distortion are limited by gates, not corrected.
4. The 3D flatness gates use MediaPipe's *estimated* world landmarks. On a relaxed sample hand
   photo they gave a 34° palm tilt and 25–35° finger bends, while 2D bends were under 6°. The
   thresholds (30°/35°) are provisional and may over-reject real users. Tune them on pilot data
   by watching the rejection rate.
5. Only silver-coloured references are supported. Coin identity is confirmed by the customer;
   an implausible implied hand size is rejected.
6. All quoted error figures come from synthetic tests or the simulation. **None of them is a
   real-world accuracy result.**
7. The tilt gate (12°) has not been checked on real hands, and the averaging in §3.1.1 does not
   say whether a phone recording's consistent 20° reading is real tilt or noise. Automatic
   exposure (§1.1) has not been tried on a real phone.
