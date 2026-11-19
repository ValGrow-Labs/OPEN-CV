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

## 9. Repeatability: why the same hand read differently, and the fix (third round)

The owner scanned the same hand twice and the numbers differed. **Nothing in the repository can reproduce that scan** (no records of it), so this is
a quantification of the possible causes, not a post-mortem of one scan. Every table is labelled SIMULATED or REAL (model output, no truth).

### What varies between two scans of one hand (SIMULATED, `scripts/repeatability_study.py`)

Each simulated scan has its own landmark jitter (2 px) and per-scan landmark bias (1.5 px), a slightly different pose (fingers lifted 4 +- 4 deg, the thumb
turned out of the palm plane 20 +- 8 deg, hand tilt up to ~3 deg), camera distance 330-420 mm and hand position +-15 mm, 16 frames through the real engine and the
real MAD median. **All these sizes are ASSUMED**; the outline fingertip is found per finger with probability p (ASSUMED; the rendered-finger evaluation found it
on 100% of clean backgrounds and 0% on skin-coloured ones, and no real phone data exist). The true extensions are the ones of the two real photos.

Scan-to-scan **SD of the finger length, mm** (100 scans per row; thumb / index / middle / ring / little; hand length is 1.5-1.65 in every row and untouched):

| p(found) | tip rule | thumb | index | middle | ring | little |
|---|---|---|---|---|---|---|
| any | **landmark tips only** (outline off) | 2.1-2.2 | 1.4-1.5 | 1.9 | 1.4 | 1.1 |
| 1.0 | first version (a found finger uses its outline, else the landmark) | 2.23 | 1.65 | 2.07 | 1.63 | 1.31 |
| 0.8 | first version | **3.27** | **2.95** | **3.43** | **3.90** | **2.69** |
| 0.6 | first version | **3.61** | **3.42** | **3.71** | **4.12** | **3.21** |
| 0.4 | first version | 3.47 | 3.41 | 3.55 | 4.06 | 3.00 |
| 0.8 | **per-hand rule (now)** | 2.40 | 1.59 | 2.07 | 1.89 | 1.36 |
| 0.6 | **per-hand rule (now)** | 2.51 | 1.67 | 2.08 | 1.84 | 1.37 |
| 0.4 | **per-hand rule (now)** | 2.47 | 1.73 | 2.07 | 1.89 | 1.35 |
| 0.2 | **per-hand rule (now)** | 2.53 | 1.74 | 2.15 | 1.71 | 1.39 |

* **The prime suspect is confirmed in simulation:** a finger that is found on one scan and not on the next flips by its whole extension (5 to 7 mm), which lifts the
  scan-to-scan SD of a finger from 1.1-2.2 mm to 2.7-4.1 mm whenever the outline is found only sometimes.
* **What was not the cause (SIMULATED):** the median over frames, the MAD trimming, the coin position and tilt, the 4-sharpest-frame choice: with every tip method
  fixed the SD is 1.1-2.2 mm, and most of that comes from the pose changes assumed above (the thumb is the most variable). Frame jitter alone gives about 0.2 mm.
* **Not simulated:** a different tip method in different views of the same scan (the three views are averaged, so a palm view with outline tips and a back view
  with landmark tips would shift a finger by about half the extension). The fix below prevents it by carrying the hand's extension from the first view to the next.

### The fix: one tip method for the whole hand (`vision/handTips.ts`, `scan/tipCapture.ts`, `scanController`)

* A finger whose outline was found keeps its own measured extension (it is real information and repeatable to about 0.3 mm).
* The hand's extension is the median over the found fingers (at least 2, agreeing); every finger without a clear outline uses it, sent as `source: "estimated"`
  (an estimate, not a measurement; counted apart in `tip_source`).
* With fewer than two found fingers, the extension of an **earlier view of the same scan** is used, and failing that an **ASSUMED prior** of **0.27 of the distal segment**
  (`finger_accuracy.outline_tip_prior_frac`; the mean of the two real photos, one hand, **not a population value**; `null` makes such a scan use landmark tips for every finger).
  A scan therefore never switches method finger by finger, and never switches because of a lucky or unlucky frame.
* Compared in the same simulation: also tried "all fingers use the hand's extension" and "no measurement at all, always the prior": SD at most 0.3 mm lower than the
  chosen rule, but they discard the per-finger information (e.g. ring 0.345 vs thumb 0.21), so the per-finger values stay measured where found.
* **Bias against the simulated length to the TRUE skin tip** (SIMULATED, p = 0.6, bias / RMSE mm, thumb / index / middle / ring / little): landmark tips -7.7 / -5.3 / -4.8 / -6.5 / -5.0 (RMSE 8.0 / 5.5 / 5.1 / 6.7 / 5.1);
  first version -4.6 / -1.7 / -1.5 / -2.3 / -1.9 (RMSE 5.8 / 3.8 / 3.9 / 4.7 / 3.7); **per-hand rule** -1.2 / +0.6 / +1.8 / +0.3 / +0.4 (RMSE 2.8 / 1.8 / 2.7 / 1.9 / 1.4).
  For a hand whose true extensions are 0.6x or 1.4x those of the photos (a hand unlike them) the per-hand rule's RMSE stays 1.6-3.0 mm (landmark tips 2.9-9.9 mm).
* **REAL perturbed photos, many frame subsets** (`fingertip.repeat.eval.test.ts`, 40 perturbed copies of each of the two photos with real MediaPipe landmarks, a "scan" = 4 random
  frames, 400 scans, NO ground truth; the outline was found on 100% of the crops of these clean white-background back-of-hand photos, so no flip occurs here): scan-to-scan **SD of the tip
  extension, mm**, thumb / index / middle / ring / little: photo `hand` first version 0.53 / 0.38 / 0.24 / 0.41 / 0.31, per-hand rule 0.36 / 0.38 / 0.24 / 0.41 / 0.31; photo `hand_portrait`
  0.25 / 0.34 / 0.67 / 0.39 / 0.29 and 0.25 / 0.34 / 0.57 / 0.39 / 0.29. Frame-to-frame SD of the measured ratio is 0.02-0.04 of the distal segment (0.4-0.9 mm). So when the outline
  is found every time it is repeatable to a few tenths of a millimetre; the repeatability problem is the finding/not finding, which the rule removes. (A first version of the per-hand rule trusted a found finger
  only within 0.12 of the hand's extension; on `hand_portrait` that flipped the thumb between its own value and the hand's, SD 1.78 mm, so the limit was widened to 0.25.)
* **Judgement.** The per-hand rule is the one that brings the scan-to-scan SD back to the landmark-tip level (1.1-2.5 mm, dominated by pose changes) while keeping most of the 5-7 mm correction. If
  the owner prefers repeatability above all and distrusts the prior, `finger_accuracy.outline_tip: false` gives landmark tips (lengths then read 5-7 mm shorter than the skin tip on the photos).
* **Honesty hint on the page:** the simple results page says in one line where the fingertips came from, e.g. "Fingertips: found on the hand outline for 3, estimated for 2." (from the new
  `tip_source` counts), so a rescan that differs can be compared.

## 10. Thumb accuracy (third round)

* **Fused three-view 3D thumb length: not used.** The fitted 3D hand (`millimesh/fitHand.ts`) is built from MediaPipe's world landmarks, whose chain **lengths** are not reliable: on the two real flat
  hands the world chain length divided by the image chain length was 0.81-0.98 for index, middle, ring and little (a flat finger cannot be 16% shorter in depth) and 1.07 for the thumb. A thumb length
  taken from that pose would inherit up to +-15% model error, which is worse than the foreshortening it would remove. No depth was invented.
* **Optional depth-aware thumb, default OFF** (`finger_accuracy.thumb_depth_aware`, believes depth up to `thumb_max_elevation_deg` 45): the thumb's lateral length from the image and coin scale, its depth difference from
  the world landmarks' relative z (the same method as `depth_aware_lengths`; palm and back view both go through it and are averaged). **SIMULATED** thumb length error, bias / SD / RMSE mm, 100 scans, world depth noise
  matched to the photos' depth bend:

| thumb pose | production | depth-aware thumb (optional) |
|---|---|---|
| in plane (0 deg) | +0.10 / 0.21 / 0.23 | +0.22 / 0.27 / 0.35 |
| 10 deg out of plane | +0.41 / 0.21 / 0.46 | +0.20 / 0.23 / 0.31 |
| 20 deg | -1.08 / 0.21 / 1.10 | +0.05 / 0.36 / 0.36 |
| 30 deg | -4.47 / 0.22 / 4.47 | +0.02 / 0.59 / 0.58 |
| 40 deg | -9.76 / 0.22 / 9.77 | +0.06 / 0.78 / 0.78 |
| 20 deg, world depth noise x2 (6 mm) | -1.07 / 0.22 / 1.10 | +0.17 / 0.70 / 0.72 |
| 20 deg, hand tilted 6 deg | -2.73 / 0.22 / 2.74 | -0.14 / 0.46 / 0.48 |

  **REAL check, not supportive:** on the two real flat-hand photos the depth-aware thumb changed the length by only -0.4 mm (SD 0.2-0.6), although the model reads the thumb 13 and 23 degrees out of plane. The
  simulation uses zero-mean depth noise; the real model's depth also has a systematic error (palm tilt 26-29 degrees on a flat hand), so nothing shows the correction is right on real thumbs. It stays OFF until a phone test with
  a known thumb pose; **the thumb's reported sigma (about 7 mm, dominated by the 6 mm definition prior) was not reduced**: nothing measures that prior.
* **Guidance (always on, advice only):** while the frames are otherwise fine and the thumb chord's elevation (world landmarks, median of the last 9 frames) is above 30 degrees (ASSUMED; the two real photos read 13 and 23 for
  a relaxed thumb), the camera says "Spread your thumb out flat" in place of the usual hold-still line. It never blocks a frame, loosens or tightens a gate. **"Prefer in-plane frames" was not done:** choosing frames by the model's noisy thumb depth is a selection rule nobody has validated.

## 11. The simple results page (third round)

After the three scans an accepted scan lands on `millimesh/SimpleResults.tsx` (dark MILLIMESH look, 390 x 844 viewed in the e2e screenshots): the fitted 3D hand (the existing `ReconScene`, no capture markers or legend)
with **Point Cloud | Solid | Wireframe** (that order, Point Cloud first) and "Drag to rotate" (only when 3D can be drawn; without WebGL the flat drawing and its note take its place), then one card: **Hand length** and **Hand width** in cm side by
side, one row per finger in mm with "≈", the suggested size as one small chip (the existing recommendation, unchanged), the unvalidated-prototype line, **More details** (opens the current measurements page, which is kept) and
Scan again. A refused scan still goes straight to the page that says what to correct.

* **Width is knuckle to knuckle** (`mcp_span_mm`, index to little-finger MCP joint centres) and says so in a caption; the palm breadth is not shown as measured.
* **Finger length is knuckle (MCP joint centre) to fingertip**, captioned "Finger length is from the knuckle joint to the fingertip." **No crease offset was invented**; the sample page's crease-to-tip numbers are about 30 to 40 mm shorter than ours.
* Fingers are shown as whole millimetres (the sample's decimals would be false precision beside an uncertainty of about +-12 mm, stated in a caption). A finger the server hides shows its `info_value_mm` with a **"Very uncertain"** tag and "not used for your size".
* The fingertip line states where the tips came from (see section 9).

### Exact `config/measurement.json` changes (third round; earlier rounds unchanged)

* `finger_accuracy.outline_tip_prior_frac`: **0.27** (new, ASSUMED; the mean extension of the two real photos; `null` = a scan with no found fingers uses landmark tips).
* `finger_accuracy.thumb_depth_aware`: **false** (new, default OFF) and `finger_accuracy.thumb_max_elevation_deg`: **45.0** (new, used only when it is on).
* `/api/config` `finger_tip` also carries `prior_frac`. No threshold was lowered or loosened; no gate, coin entry or `measurement_calibration.json` touched. `RefinedTip.source` also accepts `"estimated"` (additive).

## 12. Crease-to-tip finger length: an ESTIMATE next to the knuckle-to-tip length (fourth round)

The glove industry (EN ISO 21420 sizing, the founders' sample page) measures a finger from the palmar digital crease at its base to the tip. The camera has **no crease
landmark**: its finger length runs from the knuckle (MCP joint centre) to the tip. The owner asked for the crease-to-tip length as an estimate beside ours. **It is an estimate
resting on an ASSUMED proportion, not validated, and no real-world accuracy is claimed.**

### Definition and where the proportion comes from

`crease_to_tip = (knuckle-to-tip length) - t x |MCP to PIP|` per finger (the thumb: MCP to IP). The crease is taken at `MCP + t x (PIP - MCP)`. Config: `finger_accuracy.crease_t`.

Sources actually read (Buffa et al. 2007) and what could **not** be verified:
* **Buffa R, Marini E, Cabras S, Scalas G, Floris G. "Patterns of Hand Variation - New Data on a Sardinian Sample", Coll. Antropol. 31 (2007) 1: 325-330** (read in full; 63 men and 83 women, 21-31 years,
  sliding caliper). Finger length = *proximal metacarpo-phalangeal flexion crease to fingertip* (the glove definition). Palm length = distal wrist crease to the 3rd interdigital space. Right-hand means, mm
  (men / women): palm 105.3 / 96.1; thumb 63.0 / 56.9; index 71.4 / 66.4; middle 78.9 / 73.2; ring 73.3 / 67.8; little 60.1 / 55.2.
* Hand length (wrist crease to middle fingertip) is not in that table; it is **approximated as palm + middle finger** (184.2 / 169.2 mm; **ASSUMED**: the interdigital space is not exactly at the crease). The
  resulting finger-to-hand proportions are almost the same in both sexes: thumb .342 / .336, index .388 / .392, middle .429 / .432, ring .398 / .401, little .327 / .326 (mean **.339 / .390 / .430 / .399 / .326**).
* Not read directly (a search summary only, not the paper's table): Lolli et al. 2017, Proc R Soc B, 154 men / 262 women, crease-to-tip index 73.8 / 67.8 mm and ring 75.3 / 68.3 (right hand), which is within
  2-3 mm of Buffa's values; ANSUR II median hand length 193 mm men / 180 mm women (a third-party chart). A radiographic study of 53 hands (PubMed 8222413, abstract seen only through a search summary) reports the proximal digital crease
  14-20 mm distal to the MCP joint (line). ISO 7250-1 and the ANSUR II per-digit tables could not be fetched, so **no claim is made about their wording**.

### Deriving t, and what it is worth

`t` per finger is the value that makes the estimated crease-to-tip equal the published proportion x the hand's landmark hand length, on the **real MediaPipe landmarks of the two real photos** (with the outline tip, the
tip the product now uses). Implied t, photo `hand` / photo `hand_portrait`: thumb 0.05 / 0.05; index 0.59 / 0.59; middle 0.63 / 0.61; ring 0.62 / 0.66; little 0.60 / 0.62. **Chosen (ASSUMED, rounded): thumb 0.05, index 0.59, middle 0.62, ring 0.64, little 0.61.**
Spread across the two photos is +-0.03; across hands unknown (both photos look like the same hand).

* **This is in-sample:** the same photos supply the landmarks that t is fitted to, so the check below is a fit, not a test. On the photo landmark shape the estimate reproduces the published proportions to within 0.5 mm at hand lengths 169 and 184 mm
  (thumb +0.5 / -0.4, index -0.4 / +0.4, middle -0.4 / +0.4, ring -0.3 / +0.2, little 0.0 / -0.1 mm).
* **It inherits the landmark chain's proportions:** the same t on the simulation's synthetic canonical hand (whose landmark chains are 10-30% shorter than the model's chains on the photos; not a real hand) gives -8 to -18 mm for thumb, index, ring and little (middle -0.4 to -1.0).
  So on a hand whose landmarks sit differently relative to its crease, the estimate is off by that much; this is the main reason for the large uncertainty below.
* **Anatomy cross-check (disagrees):** a crease 14-20 mm distal to the MCP joint line is 0.33-0.45 of a 42-47 mm proximal phalanx, below the fitted 0.59-0.64. The MediaPipe MCP landmark is a knuckle (joint centre) that sits proximal of that joint line, so the fitted t also absorbs
  that offset; using the anatomical t would give crease-to-tip values 8-10 mm longer. The +-20% position uncertainty below spans about half of that gap, not all of it.
* **Plausibility only (not a target):** the founders' sample (hand 167 mm): thumb 55.0 (.329), index 56.3 (.337), middle 69.0 (.413), ring 66.2 (.396). Published proportions .339 / .390 / .430 / .399. Thumb, middle and ring agree; the sample's index is much shorter than the population proportion.
* **Outline off:** t was derived with the outline tip (5-7 mm beyond the landmark). With `outline_tip: false` the estimate reads that much shorter.

### What the server adds (additive fields; no existing value, status, uncertainty or recommendation changes: tests assert it)

Per thumb and finger: `crease_to_tip_mm`, `crease_uncertainty_mm`, `crease_interval95_mm`, `crease_status`, `crease_t`. Per frame it is the chain length minus t x |MCP to PIP|, aggregated with the **same frames and outlier handling** as the value, with all the
value's uncertainty terms plus **`crease_position`** (the crease may lie +-0.2 of the MCP-to-PIP segment, uniform: 0.2 x segment / sqrt 3, about 5 mm; ASSUMED) in quadrature. Its status uses the limits every length uses, so most
crease estimates read "Very uncertain" (about +-15 mm on 55-75 mm). A finger the value hides still gets a crease estimate (information). Views are combined like the values.

| finger | t (ASSUMED) | implied t, 2 photos | published crease-to-tip proportion of hand length | crease estimate on the photo landmarks, hand 178 mm (mm) |
|---|---|---|---|---|
| thumb | 0.05 | 0.05 / 0.05 | .339 | 60.5 |
| index | 0.59 | 0.59 / 0.59 | .390 | 69.5 |
| middle | 0.62 | 0.63 / 0.61 | .430 | 76.8 |
| ring | 0.64 | 0.62 / 0.66 | .399 | 71.2 |
| little | 0.61 | 0.60 / 0.62 | .326 | 58.2 |

(The last column equals the published proportion by construction: it is the fit, not an independent check.)

### Scan-to-scan repeatability of the crease values (SIMULATED, `scripts/repeatability_study.py`, 100 scans, the section 9 variation: jitter, per-scan bias, pose, distance, position; ASSUMED sizes)

SD of the crease-to-tip estimate, mm (thumb / index / middle / ring / little): landmark tips 2.16 / 1.36 / 1.57 / 1.24 / 0.92; per-hand tip rule (now), outline found p = 1.0: 2.28 / 1.58 / 1.75 / 1.53 / 1.12, p = 0.6: 2.60 / 1.57 / 1.82 / 1.70 / 1.22;
the first per-finger rule at p = 0.6: 3.60 / 3.29 / 3.42 / 4.01 / 3.16. The crease estimate is as repeatable as the knuckle-to-tip value (its SD is 0.03-0.23 mm lower: the MCP-to-PIP segment partly cancels); the fixed t adds no scan-to-scan variation.

### UI

The simple results page defaults to **Crease to tip (est.)**, tagged "estimate" with the caption "Finger length from the crease at the base of the finger to the tip, estimated from your knuckle joint with a standard hand proportion; not validated."; **Knuckle to tip** keeps today's numbers
(with their own uncertainty). The detailed page adds a "Crease to tip (estimate): ≈ NN mm ±S (95%: a to b)" line under each finger and explains the proportion (ASSUMED, not validated) in "How it's measured". The live labels stay knuckle to tip; their note says "Live estimate, knuckle to tip".

### Validating it

The caliper protocol of section 7 already lists the palmar-crease-to-tip datum. For this estimate: measure it on every participant, **fit t on the development half and evaluate on the held-out half, never on the same people**; report bias, SD and RMSE of
crease-to-tip per finger, by hand size and sex, with the outline tip on and off; then replace the ASSUMED `crease_t` and `crease_position_halfwidth_frac` with fitted values and their residual SD.

### Exact `config/measurement.json` changes (fourth round)

`finger_accuracy.crease_estimate`: **true** (additive fields only); `finger_accuracy.crease_t`: `{thumb 0.05, index 0.59, middle 0.62, ring 0.64, little 0.61}` (ASSUMED, sources above); `finger_accuracy.crease_position_halfwidth_frac`: **0.2** (ASSUMED).
Nothing else; no threshold lowered or loosened; calibration file and coin entries untouched. A backend restart is needed for the new response fields.

## 13. Thumb: why it changes most between scans, and what was done (fifth round)

The owner scanned the same hand again and the **thumb** changed clearly. Everything below is SIMULATED (`scripts/thumb_repeat_study.py`: pinhole camera, the real engine, the model's landmark hand shape from the two real photos, world-landmark noise
matched to those photos' depth bend) unless marked REAL (model output on the two photos, no ground truth).

### Why: the thumb's own pose changes between scans (foreshortening)

A relaxed thumb sits 10 to 40 degrees out of the palm plane and its chain reads shorter by 1 - cos(angle): 10 deg 1.5% (0.9 mm of a 59 mm thumb), 20 deg 6% (3.6 mm), 30 deg 13% (7.9 mm), 40 deg 23% (13.8 mm). One coin scale cannot see that, and the angle is
different every time the hand is put down. Simulated scan-to-scan SD of the thumb length, mm, 60 scans per row (jitter 2 px, per-scan landmark bias 1.5 px, distance, position, fingers' pose, the outline tip found per finger with p = 0.8, all ASSUMED), thumb pitch ~ N(20, sigma) degrees:

| thumb pose variation between scans (sigma) | now (before) | own thumb tip rule | flattest-half frames | **depth-aware thumb (now ON)** | depth + flattest half | all three |
|---|---|---|---|---|---|---|
| 0 deg | 0.89 | 0.76 | 0.97 | 0.89 | 0.90 | 0.73 |
| 5 deg | 1.61 | 1.53 | 1.69 | **0.95** | 1.16 | 0.99 |
| 10 deg | 2.92 | 2.88 | 2.97 | **1.12** | 1.51 | 1.36 |
| 15 deg | 3.89 | 3.89 | 3.90 | **1.19** | 1.65 | 1.53 |
| 10 deg + 4 deg drift between frames of a scan | 2.98 | 2.95 | 2.77 | **1.09** | 1.40 | 1.29 |

(At sigma 10 the thumb's crease-to-tip estimate has the same SD as its value: 2.85 now, 1.07 with the depth-aware thumb.) The other fingers, whose pose varies little, read 1.1-2.2 mm in the same setting (section 9): the thumb is the least repeatable value because its pose is.
Bias of the thumb against the true skin-tip length (mm, same rows): -1.30 / -1.72 / -2.56 / -3.50 before, -0.54 / -0.62 / -0.78 / -0.96 with the depth-aware thumb.

### What each suspect gave

* **(a) Natural pose change: the cause**, confirmed by the table (SD 0.89 with no pose change, 3.89 with +-15 degrees).
* **(b) The thumb's tip handling in the per-hand rule:** letting the thumb use its own found extension, else its own prior (0.21 of its distal segment, ASSUMED from the two photos), changes the SD by at most 0.2 mm (2.92 -> 2.88) and adds an assumed thumb number that is wrong for a hand with a different thumb (true extensions x 1.4: bias -2.95 instead of -2.36). **Not adopted.**
* **(c) Frames chosen by low thumb elevation within a scan:** a ranking in the model's world landmarks cancels a constant depth bias (with an 8 degree world-frame bias the flattest-half rule gives bias +0.04 mm), but it does not reduce the scan-to-scan SD (2.97 against 2.92) because the pose is the same in every frame of a scan, and it hurts the depth-aware thumb (1.51 against 1.12: fewer frames, more noise). Only with drift between frames does it help a little (2.98 -> 2.77). Left as an option, **off** (`finger_accuracy.thumb_best_frames_frac` 1.0, counted in `frame_exclusions` as `thumb_not_flattest` when on).
* **(d) Palm and back combine:** unchanged (mean of the views' values; each view's thumb goes through the same correction).
* **(e) Crease-to-tip thumb (t 0.05):** inherits the thumb value's SD; nothing separate.
* **What worked: the depth-aware thumb** (`finger_accuracy.thumb_depth_aware`, now **true** by the owner's decision). The thumb's lateral length from the image and the coin scale, its depth difference from the model's relative world z (section 5, believed up to 45 degrees). It cuts the scan-to-scan SD by 62-69% at +-10 to +-15 degrees (2.92 -> 1.12, 3.89 -> 1.19) and the foreshortening bias with it.

### What is and is not known about it on real thumbs

* It relies on the model's depth being **consistent between scans**. With a constant 8 degree error of the model's whole depth frame (ASSUMED, a rigid pitch of the world landmarks) the thumb stays repeatable (SD 0.97 / 1.05 mm) but reads +1.1 / +0.9 mm too long (over-corrected); a random depth error between scans adds noise instead.
* **REAL (model output):** on the two flat photos the model's thumb elevation varied 2.6-3.7 degrees (SD) between perturbed copies, and the depth-aware thumb length varied only 0.2-0.6 mm (SD) and moved -0.4 mm on average, so the model's random depth noise adds well under 1 mm. Those photos cannot show pose variation or whether the corrected number is right. No caliper thumb exists.
* The thumb's uncertainty is **not reduced** (sigma about 7 mm, dominated by its 6 mm definition prior): nothing measures that prior. The thumb stays "Low confidence" by construction.
* **Switching it off** (`thumb_depth_aware: false`) returns the plain 2D thumb: 2-4 mm of scan-to-scan variation under realistic pose change, and 1-14 mm too short at 10-40 degrees.

### Guidance (advice only, no gate touched)

* **Live:** "Spread your thumb out flat" appears while the frames are otherwise fine and the thumb chord's elevation (median of the last 9 frames) is at or above **35 degrees** (was 30; ASSUMED). A relaxed open thumb read 13 and 23 degrees on the two real flat photos and **about 30 degrees in the e2e video of the sample hand**, which fired the hint when it was 25: an ordinary open hand must not be told off, so the limit now sits above that reading. 35 degrees is 18% foreshortening (10 mm).
* **On the results page:** when the response's median thumb elevation (`finger_tilt_deg` of the thumb) is at least 35 degrees (the same ASSUMED limit): "Your thumb was turned about N° out of the palm plane in this scan (a rough depth estimate), which makes the thumb reading less reliable. Spread it flat and scan again." (N rounded to 5.)

### Exact `config/measurement.json` changes (fifth round)

`finger_accuracy.thumb_depth_aware`: **true** (was false; changes the thumb value customers see; switch back to false to undo). `thumb_best_frames_frac` is a code default 1.0 (off), not in the JSON. No threshold lowered or loosened; calibration file and coin entries untouched. The simulation gained `Scene.world_pitch_bias_deg`. **A backend restart is needed** for the new thumb default.

## 14. Next steps on the simple results page (fifth round)

Between the finger card and "More details": a numbered list of 3 or 4 plain steps that adapt to the scan: (1) the existing recommendation in one sentence, never firmer than it is ("estimated size M (not a firm size)", "close to L (borderline...)", "closest size S ... too uncertain to pick one", "cannot pick a size for this chart"); (2) only when the recommendation says it needs a measurement:
the soft-tape knuckle circumference or a ruler hand length, entered under More details; (3) scan again with the hand flat, fingers spread, thumb out and the whole coin visible, two scans agreeing within a few millimetres; (4) More details shows how each value was measured. A **Copy results** button puts a plain-text summary (hand length and width, the five finger lengths in the chosen definition,
the size chip, the date, "estimate, not validated") on the clipboard and shows "Copied"; without the clipboard API it uses the selection trick, and if that also fails it shows the text in a box to copy by hand. No shop integration, no firm size.
