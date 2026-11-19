# Finger accuracy audit (thumb, index, middle, ring, little)

**Status: unvalidated prototype.** No caliper-measured finger exists anywhere in this repository, so the
real-world accuracy of every finger value is **unknown**. Every number below is labelled:

* **SIMULATED**: pinhole-camera simulation with exactly known 3D geometry (`backend/glovesize/simulation.py`),
  scored by the real engine. It says what the code does on made-up geometry.
* **REAL (model output)**: what the real MediaPipe model returned on the repository's two real flat-hand photos.
  There is no caliper truth, so it shows repeatability and the model's own errors on a flat hand, never accuracy.
* **ASSUMED**: a number nobody has measured (noise sizes, priors, thresholds).

Reproduce: `python -m scripts.finger_accuracy_study` and `python -m scripts.finger_real_photo_probe` (from `backend/`).
Phase 2 changes are "improved in simulation, not validated on real hands", and every one that alters a customer-visible
number is **default OFF** (`config/measurement.json`, `finger_accuracy`).

**Update (second round, section 8):** two owner decisions changed this. The outline fingertip is ON by default, and the result
page now shows every finger (sections 3 and 5 describe the state before that round; section 8 states what changed).

## 1. How a finger is measured today

| Step | What happens |
|---|---|
| Landmarks | MediaPipe 21 image landmarks. Joint-centre **chain** MCP to PIP to DIP to tip: index 5-6-7-8, middle 9-10-11-12, ring 13-14-15-16, little 17-18-19-20, thumb 2-3-4 (MCP to tip, `config/measurement.json`). A **polyline** (sum of segments), not the straight chord. (The on-camera live numbers use the straight MCP to tip chord and one frame, so they differ slightly from the result page.) |
| Scale | One scale per frame, from the coin's major axis at the coin's top face: `px_per_mm = major / 24.26`, times a constant depth factor `Z/(Z+Δ)`, Δ = coin thickness + an ASSUMED 10 mm joint depth, Z from an ASSUMED 55-80 deg field of view (`calibration.frame_scale`). The same factor is used for every landmark of every finger. No rectification (`tilt_rectification: false`). |
| Per-frame gating | Frame level (lose every value): `hand_out_of_frame` (2% margin), `hand_too_small` (<30% of the short side), `fingers_bent` (middle finger only), `palm_not_flat` (model palm tilt >45 deg; back view 62), brightness, every coin code, `coin_not_on_palm`, `coin_tilted` (>12 deg on the 7-frame average ellipse), `too_close`, `implausible_scale`. Finger level (that finger loses the frame): `finger_obscured` (NaN bend, any segment <3 px, chain outside the 2% margin), `finger_bent` (in-image bend >30 deg, or depth bend >90 deg = 1.5 x 60), `implausible_value` (outside the per-finger range). |
| Per-scan gating | A finger whose **median** in-image bend is >30 deg or median depth bend is >60 deg is hidden for the scan (`finger_bent`; for the middle finger the scan is rejected). A finger needs `min(8, max(4, accepted/2))` usable frames (8 of 16), else `too_few_frames` or its commonest exclusion. |
| Aggregation | Median of the frames after MAD rejection (3.5 MAD). `frame_variation = SD/sqrt(n)`. No per-frame weighting. |
| Views | Palm, back, side. Each size-used view is a separate scan; `combine_views` takes the **mean of the views' values** (one vote per view) and the **average** of each uncertainty component, plus `view_disagreement`. A finger measured in only one view is that view's value. The side view is captured but not used. |
| Calibration file | `measurement_calibration.json` is `uncalibrated`: scale 1, offset 0, and only a prior `residual_sd_mm` (thumb 6, fingers 4) that enters as `landmark_definition_prior`. Nothing is fitted. |

## 2. What the app reports per finger, and why

SIMULATED engine run, real-hand landmark shape scaled to 185 mm, 350 mm away, 16 frames, 2 px jitter (index finger 91 mm):
`frame_variation 0.19`, `landmark_localisation 4.29`, `coin_scale 0.43`, `tilt 0.0`, `depth_layer 1.24`,
`perspective 0.82`, `landmark_definition_prior 4.0` mm, root-sum-square sigma **6.1 mm**, 95% interval **±12.0 mm
(13% of the value) = "Low confidence"**. Thumb: sigma 7.2 mm, ±14.1 mm (24%). Two priors make up almost all of it (an
ASSUMED model error of 1.5 px at 224 px input x 2, scaled to the hand, about 10 px on an 800 px hand; and the 4 or 6 mm
definition prior). Consequences:

* **No finger can be "Estimated" (valid) today.** Valid needs 95% half-width <= 8% of the value, about 3.7 mm sigma for an
  index finger; the landmark term alone is 4.3 mm. Even a fitted calibration would need a residual SD below ~3.7 mm
  (index) or ~2.9 mm (little). The best a finger can show is "Low confidence". Only the hand length reaches valid.
* The repeatability of the real model is far smaller: **REAL (model output)**, 60 perturbed copies (rotation +-5 deg,
  scale +-8%, noise) of each of two photos: SD of finger chain / hand length is 0.8-1.2% of the chain, about 0.5-1.2 mm.
  Repeatability is not accuracy (it excludes the model's bias on a hand), so the 4 mm priors cannot be lowered without
  caliper data; the point is only that they are priors, not measurements.
* In every simulated condition the reported 95% interval covered the simulated error (100% of scans), because it is that wide.

## 3. Which values come back "Not measured" / excluded, and why (a good capture)

The results page writes "Not measured" in the value column for any value whose status is `invalid` (hidden) and for derived values
that the camera never measures.

| What the customer sees | Cause | On a good capture? |
|---|---|---|
| Palm breadth, hand circumference: "Not measured", "Needs a tape measure" | By design: status `not_measured`, `requires_validated_model_or_manual_entry` (`derived.* : null` in the calibration file). A single view cannot see them. | **Always** |
| Finger circumferences: five "Not measured" rows | By design (`ResultsScreen`: "Not measured by the camera"). **Finger widths are not measured by the production engine at all.** Only the experimental 3D board route has them (`docs/hand3d-research/MASTER_AUDIT.md`, stage 5: u_c 2.2-2.4 mm SIMULATED, 5 mm under ASSUMED phone conditions). | **Always** |
| Every finger "Low confidence" | Section 2: priors make 95% half-width 12-15% of the value; the limit for valid is 8%, for low confidence 22%. | **Always** |
| A finger hidden, `uncertainty_too_large` | `classify`: rel95 >22% and not (rel95 <=25% and u95 <=15 mm); thumb: rel95 >35% or u95 >16 mm. Absolute caps. SIMULATED (real landmark shape, engine sigma): hands of 130 mm and up show all five; at 110 mm and below the **thumb** is hidden; at 75 mm the little finger is hidden as well and index, middle and ring sit at 21-23% (the 4-6 mm priors do not shrink with the hand). | Adult hand: no. Small hand or child: yes |
| A finger hidden, `finger_bent` | Median in-image bend >30 deg or median depth bend >60 deg. **REAL (model output)**: on two flat hands the in-image bend medians were 1-8 deg and the depth bend medians 19-25 (index, middle, ring) and 35-38 deg (little); no frame exceeded either per-frame limit (0 of 120). The depth bend of a straight finger is the model's error (simulated world noise of 1.5 mm xy / 3 mm z reproduces these medians). Margin to 60: ~22 deg for the little finger. A naturally curved or relaxed little finger can still cross it; the middle finger then rejects the scan (`fingers_bent`). | Usually no; **untested on real phones** |
| A finger hidden, `too_few_frames` / `finger_obscured` | Fewer than 8 of 16 frames usable for that finger (noisy chain, segment <3 px, chain inside the 2% edge margin, outside the plausible range). No such case occurred in the real-photo probe. | Rare |
| A value shown but trimmed | `outlier_frame`: MAD rejection (3.5 MAD) drops stray frames (e.g. 1 of 16). Now visible in `frame_exclusions`. | Common, harmless |
| The whole scan refused | Frame-level codes above, `scan_unstable` (SD >2.5% of hand length), a failing required back view. Not finger specific. | Depends |

I cannot tell from the repository which of these the owner's phone showed: **the next phone test will show it** through the new
`frame_exclusions` (per finger: how many frames were left out and why) in the response, now also explained on the result page.

## 4. Error sources that apply to fingers

All SIMULATED unless marked. Hand = the model's landmark geometry on a real photo scaled to 185 mm (thumb 59, index 91, middle 102,
ring 93, little 75 mm); 350 mm; 16 frames; 100 scans per condition; error against the 3D joint-chain length. **The truth is the
simulated joint-centre chain, not skin.**

| Source | Finger size of the effect | Label |
|---|---|---|
| Per-frame landmark noise, 2 px, 16 frames | SD 0.2 mm (8 frames 0.3, 24 frames 0.2). Random error is not what matters. | SIMULATED, 2 px ASSUMED |
| Per-hand landmark bias 1.5 px (persists across frames) | SD 0.5-0.6 mm; averaging frames does not remove it | SIMULATED, 1.5 px ASSUMED |
| Coin scale / depth model right | bias +0.06 to +0.15 mm | SIMULATED |
| Joints really 15 mm deep (model assumes 10) | -0.7 (thumb) to -1.3 mm (middle), about -1.1 to -1.3% | SIMULATED |
| Hand rigidly tilted 6 deg (inside the 12 deg gate) | index +2.6, middle +3.1, ring +2.4, little +1.3 mm (+1.5 to +3.4%) | SIMULATED |
| Fingers lifted 10 / 20 deg towards the camera (no joint bend) | index +2.5 / +2.1, middle +3.4 / +3.5, ring +2.7 / +2.3, little +1.7 / +0.8 mm. Foreshortening shortens, getting nearer magnifies; the net is positive. | SIMULATED |
| Fingers curled 8 deg per joint | index +2.1, middle +3.1, ring +2.3, little +1.1 mm | SIMULATED |
| Thumb turned out of the palm plane 20 / 40 deg | thumb **-1.1 / -9.8 mm (-1.8% / -16.6%)** | SIMULATED. REAL (model output): the model reads the thumb chord 13 and 23 deg out of plane on the two flat photos (truth unknown) |
| Off-centre 25 mm + barrel distortion (k1 -0.08) | -0.1 to -0.4 mm | SIMULATED |
| 15% of frames with landmarks displaced 12 px (blur, mis-placed tip) | RMSE 0.23-0.28 mm (the median already copes) | SIMULATED |
| Tip landmark is not the skin tip; MCP is a joint centre, not the crease | Unknown offset; adds directly to the length (chain starts proximal to the crease, so it reads **longer** than crease to tip). Nothing in the repository measures it. | ASSUMED, **no data** |
| One coin scale for a finger above or below the coin plane | A point 20 mm above the coin plane reads +7.1% long at 300 mm without the depth model | SIMULATED (coin study, `MASTER_AUDIT.md` section 5) |
| Coin off-centre in the picture reads small | -2.35% half-way to the corner, -4.0% at 0.85 (coin wall in the outline); sign flips with lens distortion | SIMULATED (coin study); not changed |
| Image-edge perspective, lens distortion, motion blur | Not separately measurable here; they enter as landmark displacement above | SIMULATED only |
| Thumb reliability | Always "Low confidence" (`out_of_plane`); sigma 7.2 mm, prior 6 mm | by design |
| Few frames per finger | Needs 8 of 16 usable frames (section 3); random error is small | SIMULATED |

Reading: random error is 0.2-0.6 mm; geometric systematic error is 1-3.5 mm for tilted, lifted or curled fingers and up to 10 mm
for a thumb turned 40 deg; both are **inside the reported ±12 mm** only because that interval is made of priors. The real
error (tip and crease definitions, the model's bias on real hands) is unknown.

## 5. What was judged and done (Phase 2)

| Candidate | Verdict | Evidence |
|---|---|---|
| (a) Aggregation: mean of MAD inliers, 20% trimmed mean, Hodges-Lehmann, sigma weighting | **Not implemented.** Best rule lowers RMSE by 0.01-0.06 mm (e.g. index 0.28 to 0.25) and nothing with a persistent bias; the per-frame sigma is the same for every frame, so weighting has no information. | SIMULATED, same frames, 100 scans |
| (a) Reject tilted frames per finger | Folded into (c): the tilt term and flag (below). | |
| (b) Tip from the hand mask | **Not implemented.** The segmentation work has no ground-truth fingertips (its fingertip check allows 0.3 palm widths, about 20 mm), runs 0.65 s per capture in desktop Node and 2.2 s in desktop Chrome (phone unmeasured), and the scan sends only numbers, not pixels. Nothing shows it beats the landmark tip. | `experimental/segmentation/README.md` |
| (c) Relative world depth | **Implemented, default OFF** (`finger_accuracy.depth_aware_lengths`; thumb never corrected). SIMULATED: RMSE falls from 0.9-3.5 mm to 0.2-0.3 mm for fingers lifted 10-20 deg, 1.35-3.1 to 0.4-0.8 mm for a 6 deg hand tilt, 1.1-3.1 to 0.4-0.7 mm for an 8 deg curl; it **costs** +0.15-0.2 mm on a flat hand (RMSE 0.24-0.28 to 0.40-0.47, world noise matched to the real photos). **REAL (model output)** on the two flat photos it moved finger lengths by -1.1 to +2.1 mm (ideal 0, SD 0.5-1.6): the real depth error is as large as the benefit. **Not recommended to enable** before a phone test with known finger poses. Needs a correct world-z sign (smaller = nearer; the model's image z and world z correlated +0.72 / +0.83 on the photos, consistent with the documented convention) and a centred principal point. | SIMULATED + REAL (model output) |
| (d) Cross-check with the three views | **Already in production** (`combine_views`: mean of values, `view_disagreement`). SIMULATED, independent view biases (ASSUMED): two views cut finger RMSE from 0.5-1.0 to 0.4-0.9 mm (about -15 to -30%). The reported interval is unchanged (conservative); no shrink claimed. Nothing changed. | SIMULATED |
| (e) Definitions | **Implemented, always on**: `limitation` text on each finger and the thumb (joint-centre chain, not crease to tip, tip is not the skin tip, not calibrated); shown under "How it's measured". | additive field |
| (f) Per-finger uncertainty | **Implemented, default OFF** (`finger_accuracy.tilt_uncertainty`): component `finger_foreshortening` from the median world-landmark elevation of the finger chord (ASSUMED sigma 4 deg; real flat hands read 1-4 deg), and the reason `finger_tilted` above 12 deg. It never changes a value. Effect (SIMULATED): 95% half-width 12.2 to 14.6 mm for a middle finger lifted 20 deg, unchanged for flat fingers; it hides a thumb turned 40 deg (the existing 16 mm cap), and would hide the thumb of a large hand, since real thumbs read 13-23 deg. Always on: `frame_exclusions` and `finger_tilt_deg` (additive diagnostics). | SIMULATED |
| (g) UI | While a frame is fine the camera now says "Hold still, fingers straight, spread and flat"; the bent-finger message adds "and keep them flat"; the result page explains per finger which frames were left out and how to hold the hand. **No gate or threshold was touched.** | |

**"Not measuring" (owner's phone test): what can be improved without lowering a gate.** Nothing in the code or the simulation
hides a finger of an adult flat hand, so there is no gate-preserving fix to a bug I can show. Done: the exclusion counts and advice
above, so the cause is visible next time. Candidate changes that **need the owner's decision because they loosen a gate or
rest on invented numbers**: the absolute `u95 <= 15/16 mm` caps and the 4-6 mm priors (small hands and thumbs); judging the in-image bend
on the scan median instead of per frame (the scan-level median rule already exists, so this saves only borderline frames);
raising the depth-bend median limit (60 deg) for the little finger (margin ~22 deg on two photos); the valid limit (8%), which no
finger can reach until a calibration is fitted from caliper data.

## 6. Real-world accuracy per finger known today

**None.** There are no caliper fingers; the only validation records in the repository are `software_test` scans of a fake camera
with a hand length only (untracked, git-ignored). A caliper study of fingers is the only way to set the priors and to decide on
the options above.

## 7. Validation needed

Fold the fingers into the existing study (`docs/VALIDATION_PLAN.md`: at least 120 participants, half held out; reference by trained staff,
each value twice, report the reference's own SD). For each hand, with a sliding caliper:

1. **Datums**: finger length at two datums per finger, (a) palmar digital crease at the base of the finger to the skin tip (the glove-industry
   definition) and (b) dorsal knuckle (metacarpal head) to the skin tip, for the thumb the same from the thumb's MCP crease. The offset
   between the camera's MCP-to-tip chain and (a) is exactly what the camera cannot know.
2. **Poses**: flat and still (the scan as instructed), then fingers deliberately lifted about 15 deg and the thumb relaxed and
   abducted, so the tilt term and the optional depth-aware lengths can be tested against known poses. Keep the scan frames (they hold the world
   landmarks) so each option can be replayed offline.
3. **Compare** per finger on the held-out half: camera minus (caliper + offset fitted on the development half): bias, SD, RMSE, Bland-Altman
   95% limits, and the share of references inside the reported 95% interval; also by hand size, since the absolute caps hide small hands.

## Limits of this audit

One simulated hand shape (from one real hand); pinhole camera with a centred principal point; independent Gaussian noise (the real model's
errors are correlated and biased); the coin edge is noise-free in the simulation; the world noise is matched to two photos by depth bend only. The
two photos are of a flat hand with a drawn-on coin; the repository's real phone recordings are small screen recordings with overlays and were not used.

## 8. Second round: the real fingertip from the hand outline (A) and every finger shown (B)

The model's tip landmark sits inside the fingertip, so finger chains read short. The owner decided to measure the skin tip from
the hand outline (ON by default) and to stop hiding fingers on the result page. **Still an unvalidated prototype; nothing here is
real-world accuracy.**

### A. How the outline tip works

* **Where.** `frontend/src/vision/fingertip.ts` (pure typed-array code, no OpenCV needed), run in the coin worker (`coinWorker.ts`, message
  `tips`) so the page stays free; `scan/tipCapture.ts` cuts the crops and applies the result. The server never receives pixels.
* **When.** Small crops (about 3 distal segments wide) around the five fingertips are cut at each coin search from the same video frame
  as the landmarks; only the 4 sharpest crops of **accepted** frames per view are kept and measured **once, when the view completes** (time
  budget 2.5 s; on any failure or timeout the landmark tips are used). Side-view (capture-only) frames are not measured.
* **What.** For each finger (thumb: IP to tip): a skin colour model (median and MAD in CIE Lab) from pixels inside the finger's own
  distal segment; 5 parallel rays marched outward from the landmark tip along the DIP-to-tip axis; the boundary is the strongest colour step
  where the colour has left the model for 2.5 px in a row; median over the rays. **No clear boundary means the landmark tip is kept**, with a reason
  (`no_boundary`, `skin_model_unclear` for polish or a ring, `boundary_before_landmark`, `rays_disagree`, `outside_crop`, `frames_disagree`,
  `too_few_frames`). Combined over the kept frames (at least 2 frames and half of them, agreeing); the extension is a **fraction of the distal segment**
  and is applied to the tip of **every** frame of the view, so every frame's length gets it.
* **Cap.** The extension must be between 0 and **0.5 x the distal segment** (about 10 mm; `finger_accuracy.outline_tip_max_extension_frac`). Chosen from
  the two real photos: the extension was 0.23 to 0.36 of the segment (5.1 to 7.4 mm), so a first idea of 0.35 refused 1 finger in 10; 0.5 leaves
  about 1.4x headroom. It is not a quality gate and not a measured limit; it is a sanity bound, ASSUMED.
* **Server.** `FrameObservation.refined_tips` (optional, additive: `{x, y, extension_px, source, reason}` by tip landmark 4, 8, 12, 16, 20).
  `measurement.refined_tip` accepts one only if `source == "outline"`, it is in the frame, lies beyond the landmark tip along the distal segment by 0 to the cap,
  with at most a 0.1 segment sideways offset, and the finger is not obscured or bent. Else the landmark tip is used. The chain MCP to tip uses it; the **hand length,
  palm length and span are unchanged** (the hand length still ends on the landmark tip because it is the sizing input; it reads short for the same
  reason, which is a recommendation, not done). The MCP base is unchanged: still a joint centre, not the crease. The `limitation` text now says the tip is
  the outline tip when clear, else the landmark.
* **Reported per finger** (additive): `tip_source` (frames behind the length by `outline` / `landmark`) and `tip_extension_mm`.
* **Uncertainty.** Unchanged. No term was reduced: the localisation (4.3 mm) and definition-prior (4 mm) terms stay as they were (a test asserts it), because nothing has measured
  how much of them the tip was. If a caliper study shows the tip share was large, lowering it is a decision for then, labelled ASSUMED until validated.
* **Phone/server pairing.** `/api/config` has a new `finger_tip` block; the phone sends `refined_tips` only when it is `enabled`, so an old server (which would
  reject the unknown field) is never sent one. **The backend needs a restart to accept it.**

### A. Evaluation (a): rendered fingers with a known skin tip (SIMULATED)

756 rendered fingers (`fingertip.eval.test.ts`): 3 skin tones x 7 backgrounds x blur 0/1.5/3 px x noise 0/6 x nail polish no/yes x 3 placements; 2.8 px/mm, 17 mm
wide finger, landmark 2 to 6 mm inside the skin tip (ASSUMED), cap 0.5. The thresholds were tuned on these same scenes: **in-sample, optimistic**.
Error = estimated minus true extension.

| scenes | outline found | error mm mean (SD) | p95 abs mm | wrong by > 2 mm |
|---|---|---|---|---|
| white / grey / dark / green background, no polish (216) | **100%** (all skin tones, noise 0 and 6) | -0.21 to -0.35 (0.24-0.28) | 0.58-0.86 | 0 |
| blur sigma 0 / 1.5 / 3 px (clean backgrounds incl. wood, polish included) | 47% each | -0.21 / -0.26 / -0.36 | 0.49 / 0.54 / 0.86 | 0 |
| wood background | 33% (every non-polish failure is `no_boundary`: brown wood is close to medium and dark skin) | -0.16 | 0.75 | 0 |
| cluttered background | 49% (all but 1 of the non-polish ones) | -0.19 | 0.73 | 0 |
| **skin-coloured background** | **0%: always falls back** | n/a | n/a | 0 |
| **nail polish (red)** | **0%: always falls back** (`skin_model_unclear` / `boundary_before_landmark`) | n/a | n/a | 0 |
| all 756 | 40% | -0.26 (0.28) | 0.73 | **0 of 305 accepted** |

Reading: when it accepts a boundary it is 0.2-0.4 mm short on average and never wrong by 2 mm in this set (it stops just inside the edge); it gives up rather than guess
on skin-coloured or cluttered backgrounds and polish. Failure cases to expect on real phones: nails with polish, wooden or beige tables, strongly textured backgrounds, a
ring or glove, hands in shadow, and anything the renderer does not produce (specular highlights, a second finger touching the tip, compression blocks). **None of that is
tested on real phone video.**

### A. Evaluation (b): the two real photos, real MediaPipe landmarks, NO ground truth

`fingertip.realphoto.eval.test.ts` (opt-in, `FINGERTIP_REAL_DIR`; landmarks from `python -m scripts.finger_real_photo_probe --dump-landmarks DIR`), scale from each photo's
drawn coin. Overlay screenshots (red landmark tip, green outline tip, per finger, 4x crops): `frontend/e2e/.media/finger_tips/hand_tips_overlay.png` and
`hand_portrait_tips_overlay.png` (git-ignored, like the photos; `--overlay DIR` redraws them). Viewed: the green point sits on the visible tip outline in all ten fingers; the red
landmark sits well inside the pad.

| photo | finger | distal landmark segment mm | extension mm | chain mm before | chain mm after |
|---|---|---|---|---|---|
| hand | thumb / index / middle / ring / little | 25.2 / 21.8 / 24.2 / 20.9 / 17.9 | 5.5 / 5.1 / 6.4 / 7.4 / 5.7 | 56.6 / 89.2 / 98.8 / 89.7 / 73.0 | 62.1 / 94.3 / 105.2 / 97.1 / 78.7 |
| hand_portrait | thumb / index / middle / ring / little | 26.9 / 21.2 / 23.5 / 21.8 / 18.7 | 5.3 / 6.6 / 5.5 / 7.3 / 5.8 | 55.8 / 84.9 / 97.1 / 88.9 / 71.5 | 61.1 / 91.5 / 102.6 / 96.1 / 77.2 |

All ten fingers found a boundary (positive, 5.1 to 7.4 mm, 0.23 to 0.36 of the segment). **There is no ground truth**: this shows the sign and the size are plausible, not that the
numbers are right. These are back-of-hand photos on white (nails visible, no polish); a palm view has no nail edge.

### A. Evaluation (c): effect on the finger lengths

* **REAL photos (landmarks real, extension from the outline):** every finger chain gets longer by its extension: **+5.1 to +7.4 mm (about +6 to +9%)**, table above.
* **SIMULATED, backend (`tests/test_outline_tip.py`):** with an outline tip 20% of the segment beyond the landmark, each chain grows by exactly its reported
  `tip_extension_mm` (within 0.35 mm); the hand length, palm length and every uncertainty term are unchanged.
* **Not measured:** how far the new length is from a true crease-to-tip length, or whether the extra length is right on real hands. The finger values customers
  see rise by about 5 to 7 mm with the flag on (the default). To turn it off: `finger_accuracy.outline_tip: false`.

### B. Every finger is shown

* **Backend (additive, restart needed):** a thumb or finger the result would hide (status `invalid`: `uncertainty_too_large`, `finger_bent`, `too_few_frames`, ...)
  now also carries `info_value_mm`, `info_uncertainty_mm`, `info_interval95_mm`, `info_frames`, computed with the same formulas from the usable frames (including frames the
  per-finger bend and range checks excluded). **`value_mm`, `uncertainty_mm`, `status` and `reasons` are exactly what they were**, so `recommendation_from` and every
  "valid" rule see the same inputs (a test asserts the recommendation is identical with and without the info fields).
* **UI:** for a thumb or finger with status `invalid` and an info value, the result page shows the number, the 95% interval, a **"Very uncertain"** tag, the reason in plain words, and
  "Shown for information; not used for your glove size." "Not measured" stays only for what the camera truly cannot measure (palm breadth, hand circumference, finger circumferences) and for a
  finger with no number at all.
* The owner accepted loosening what the page hides. The numbers are as uncertain as ever: a "Very uncertain" finger has a 95% interval over 22% (thumb: over 35%) of its value.

### Exact changes to `config/measurement.json` (second round)

* `finger_accuracy.outline_tip`: **true** (new key; the owner's decision, ON by default).
* `finger_accuracy.outline_tip_max_extension_frac`: **0.5** (new key; a sanity bound on the refined tip, see above).
* `measurements.{thumb,index,middle,ring,little}_length_mm.limitation`: text updated (the tip may now come from the outline; "not validated").
* (First round, unchanged: `finger_accuracy.tilt_uncertainty` false, `depth_aware_lengths` false, `elevation_sigma_deg` 4.0, `flag_elevation_deg` 12.0,
  `max_elevation_deg` 30.0; the `limitation` keys.)
* **No threshold was lowered or loosened: no gate, no coin entry, no `measurement_calibration.json` change.** `outline_tip_max_extension_frac` bounds a new optional input; it is not a
  quality gate, and a refined tip that fails it is ignored.

### What still needs real hands

The outline tip against caliper tips (section 7's datum (b), and pad to nail edge), on palm and back views, several skin tones, nail polish, tables and lighting; the extension's
spread over frames; whether the extension (5 to 7 mm here) is the same fraction of the distal segment on other hands. The worker path was exercised in Node only (the same pure
functions), not in a browser on a phone.
