# Validation plan

Goal: measure, honestly and on held-out people, how close camera estimates are to physical
hand measurements and how often the recommended glove size is right. Then calibrate the
system so that the uncertainty it reports reflects that measured performance.

No real-world validation has been performed yet. Every accuracy figure in this project to
date comes from synthetic tests that verify geometry, not accuracy.

## 1. Study design

| Item | Plan |
|---|---|
| Participants | ≥ 120 adults; see §5 for the sizing rationale. Recruit across hand sizes (all chart sizes), sexes, skin tones (Fitzpatrick I–VI) and ages. Record these as anonymous strata only. |
| Split | Assign participants (not scans) at random to **development (≈50%)** and **held-out test (≈50%)** before any analysis, stratified by reference hand length. A participant is never in both splits. `validation/dataset.py` enforces this. |
| Reference measurements | Trained staff using an anthropometer or sliding calipers (hand length: distal wrist crease to tip of the middle finger; palm breadth at the metacarpal heads) and a non-stretch tape (circumference around the knuckles, excluding the thumb). Take **each measurement twice** and use the mean; report the inter-measurement SD as the reference error floor. |
| Fit outcome | For each product chart, a try-on of adjacent sizes; record `best_size` and `acceptable_sizes` (`fit_trials.csv`). |
| Captures | Per participant: ≥ 3 scans on ≥ 2 devices (iPhone, Android, laptop webcam), front and rear cameras, normal and dim lighting, both hands. Save the full frame sequence (images) under signed research consent (see `DATA_COLLECTION_AND_PRIVACY.md`). |
| Blinding | The staff taking reference measurements do not see camera results. |

## 2. Pipeline

```
dataset/
  participants.csv     participant_id, split, ref_hand_length_mm, ref_palm_breadth_mm, ref_hand_circumference_mm, ...
  fit_trials.csv       participant_id, chart_id, best_size, acceptable_sizes
  captures/<participant_id>/<scan_id>/*.jpg
```

Templates: `backend/validation/templates/`.

```bash
cd backend
# 1. Raw (uncalibrated) estimates for every scan, using the same pipeline as the browser
python -m validation.extract_from_images ../dataset --chart <client-chart-id>
# 2. Fit offsets/scales and derived models on the DEVELOPMENT split only
python -m validation.fit_calibration ../dataset/participants.csv ../dataset/scans.csv --out ../dataset/measurement_calibration.json
# 3. Evaluate on the held-out TEST split (dev results are reported separately as diagnostics)
python -m validation.evaluate ../dataset/participants.csv ../dataset/scans.csv \
    --calibration ../dataset/measurement_calibration.json \
    --fit-trials ../dataset/fit_trials.csv --chart <client-chart-id> --out ../dataset/report
```

Copy the fitted calibration to `config/measurement_calibration.json` only after reviewing the
test-split report.

### 2.1 In-app validation mode (pilot data, no images)

Before the full image study, a pilot of 10–15 volunteers can be run with the developer-only
validation screen at `#/validation`. The step-by-step procedure, including the physical
measurement protocol HL-1, is in **`docs/PILOT_PROTOCOL.md`**. Validation mode is off by default
and answers only local requests, unless an operator token is configured (README, Security).

Each record holds:

* **Record type:** `real_participant` (the operator confirms consent) or `software_test`. Only
  real-participant records are counted.
* **Identity and trial:** a random participant code, the hand scanned (left or right), and the
  capture condition (standard, closer, further, coin off-centre, different lighting, hand
  rotated, fingers slightly bent).
* **Physical reference:**
  * every reading as entered, with its unit, converted to mm by the server;
  * the agreed reference value (mean of two readings within 2 mm, or the median of three);
  * whether the readings were repeated, their spread, and a reliability label (`agreed`,
    `single_reading` or `discrepant`);
  * the protocol, tool, who measured, and an operator code.
* **Camera estimate**, computed by the server from the scan: value and 1σ uncertainty, signed,
  absolute and % error, and whether the reference lies inside the reported 95% interval.
* **Scan and calibration:**
  * scan status and rejection reasons;
  * frame rejections;
  * coin frames and confidence, px/mm, coin tilt, depth factor and the coin-implied camera
    distance;
  * image size and detected handedness.
* **Conditions:** device, lighting, the distance measured by the operator, and notes.
* **Per-frame numeric observations**, saved in `frames/<record id>.json` (never images), so
  pilot scans can be re-measured under a changed configuration
  (`validation_records.remeasure`). Each configuration version is saved once in
  `configs/<fingerprint>.json`, and the file is checked against its fingerprint when read.
* **Integrity:**
  * configuration fingerprint and calibration status;
  * a `static_frames` flag when the landmarks do not move between frames (a still image, not
    a live camera);
  * a `reference_mismatch` flag when one hand carries different references in different
    records.

The summary on the screen and `python -m scripts.validation_report` report real-participant
results only:

* scans, rejected scans (count and %) with reasons;
* hand-length bias (mean signed error), MAE, RMSE, median and maximum absolute error, and the
  error distribution, both per scan and per hand;
* within-95%-interval counts;
* one row per participant and hand: scans, rejections, and the mean error, MAE and error range
  of its standard scans;
* errors by camera-distance band (under 30, 30–40, 40–50, 50+ cm), both operator-measured and
  coin-implied. Each hand counts once per band, and bands with fewer than 3 hands are listed but
  not interpreted;
* repeatability (pooled within-hand SD and the repeatability coefficient) and the shift of each
  condition from the same hand's standard scans.

Records are excluded from all statistics when they are software tests, carry an integrity
flag, or were made with a different configuration. Accuracy uses only standard-condition scans
with agreed references. The figures are descriptive. Below 30 hands, the screen and report say
so, and no confidence intervals are given.

What it is not:

* It stores numbers, not images, so scans cannot be reprocessed later with a changed algorithm.
  The full image study (§1–2) remains the basis for fitting and for held-out claims.
* Nothing in validation mode can change `config/measurement_calibration.json`. A calibration is
  reported as validated only when a person adds a `validation` block with held-out real-world
  evidence (≥ 60 held-out participants, acceptance criteria met, report reference and approver).
  `fit_calibration.py` never writes that block and refuses to write into `config/`.

## 3. Reported metrics (`evaluate.py`)

Per measurement, per split:

* MAE and RMSE (mm);
* bias (mean of estimate − reference);
* error SD, Bland–Altman 95% limits of agreement;
* |error| percentiles (p50/p90/p95/max) and an error histogram (2 mm bins);
* **95% interval coverage**: the fraction of references inside the reported interval. It
  should be close to 95%, which shows whether the uncertainty model is honest.

Sizing, against try-on `best_size`:

* exact-size accuracy;
* adjacent-size accuracy (within ±1 size);
* "recommended or alternative" accuracy;
* rate of no recommendation.

Operational:

* scan rejection rate;
* first-scan rejection rate (the share of participants who needed a rescan).

Break down all metrics by device, lighting, camera facing, skin tone stratum and hand-size band.

## 4. Experiments to run on the development split

1. **Depth adjustment on vs. off** (`depth_model.enabled`), and the assumed joint depth
   (`landmark_layer_depth_mm`): keep the adjustment only if it reduces test error. The
   simulation (`docs/CALIBRATION_STUDY.md`) predicts that it helps, but only as much as the
   assumed depth matches real hands.
2. **Tilt rectification** (`calibration.tilt_rectification`): off by default because it
   over-corrects in the simulation. Re-test on real scans only if tilted scans show a
   consistent bias.
3. **Gate tuning**: rejection rate vs. error as the world-landmark thresholds vary
   (`max_palm_tilt_deg_model`, `max_finger_bend_deg_3d`). They are currently provisional.
4. **Circumference / breadth models** (`fit_calibration.py` fits linear models from
   `mcp_span_mm` and `hand_length_mm`). Use them only if the test-split residual is small
   relative to the chart's size step. Otherwise keep requiring tape entry.
5. **Machine learning.** Consider a learned correction (e.g. gradient boosting on landmark
   features) only if it beats the linear calibration on the **test** split, with participants
   cross-validated on dev.
6. **Capture distance**: check whether error depends on the estimated camera distance. If so,
   tighten the hand-size gate.
7. **Multi-view and hand thickness**: collection protocol and the rule for using any of it in
   §7. None of it is validated or used for sizing.

## 5. Acceptance criteria (to agree with the client)

Set targets from the size step of the client's chart. For a chart with 11–12 mm steps in hand
length, suggested targets on the test split:

* hand length MAE ≤ 3 mm, |bias| ≤ 1 mm, p95 |error| ≤ 6 mm;
* 95% interval coverage between 90% and 98%;
* adjacent-size accuracy ≥ 98% and exact-size accuracy reported, not presumed;
* first-scan rejection rate ≤ 25%.

With 60 test participants, a 95% CI on MAE is roughly ±0.5 mm (assuming an error SD of about
3 mm). Proportions near 90% carry about ±8 percentage points, so use ≥ 120 test scans for
size-accuracy claims. Do not claim 95%, 99% or 100% accuracy without these data.

## 6. What can be validated right now, without data

* Algorithm correctness on synthetic geometry (pytest: coin diameters, rotation, white balance,
  exposure, contrast, tilt, occlusion, blur, glare, rival circles, depth model, aggregation,
  sizing rules).
* Systematic error of each calibration method under simulated pinhole geometry
  (`scripts/calibration_study.py` → `docs/CALIBRATION_STUDY.md`). This shows which biases exist
  and how they depend on assumptions. It does not show their real size on real hands.
* Parity between the browser and Python implementations (Vitest fixtures; Playwright
  cross-check on a real hand photo).
* The end-to-end pipeline, including validation mode, in a real browser with a fake camera.

None of these measure real-world accuracy.

## 7. Multi-view and hand thickness (data collection for a future method)

**Status: collection protocol only. Nothing in this section has been run, nothing in it is
validated, and no result from it is used for sizing or for the reported uncertainty.**

The guided scan captures up to three views of the hand, each with the coin on the hand: the palm,
the back of the hand and the side of the hand (`capture.views` in `config/measurement.json`).
Today:

* the **back view** is a second, independent reading of hand length, used as a cross-check between
  views (`view_max_rel_diff`, 6%, provisional and unvalidated);
* the **side view** is captured and checked for a hand and a coin only. It is **not used for
  size** (`used_for_size: false`), because no method turns it into a measurement. An informal look
  at the client's two sample photos (one back of hand, one angled view; two images, not a
  validation) gave about 175 mm for the back view and about 143 mm for the angled view of what
  looks like the same hand, and the hand model's depth values did not close that gap (see the
  "Several views" section of `docs/MEASUREMENT_METHODOLOGY.md`, once the multi-view change is in).

This section specifies what to collect so that a side-view method can be built and then judged on
held-out people. It does not say such a method will work.

### 7.1 Questions

1. **View agreement.** Do the palm and back views of the same hand agree on hand length, and does
   the disagreement flag fire when one of them is wrong?
2. **Hand thickness.** Can the dorsal-to-palmar thickness of the hand at the knuckle line be
   estimated from the side view, and how far is it from a caliper reading? (No such method exists
   yet. This question applies only once one does.)
3. **Circumference.** Can the circumference around the knuckles (thumb excluded) be estimated from
   breadth and thickness, and how far is it from a tape reading? The ellipse model in §7.4 is a
   hypothesis to test, not a result.

### 7.2 Reference measurements per participant

These are in addition to the hand length (protocol HL-1) and palm breadth already taken in §1 and
`docs/PILOT_PROTOCOL.md` §2. Hand breadth is unchanged.

| Measurement | Tool | Readings | Notes |
|---|---|---|---|
| **Hand thickness at the knuckle line** (protocol HT-1, proposed) | Spreading or sliding calipers, flat or rounded tips, 0.1 mm resolution | **3** per hand, the hand lifted and put back between readings | See the definition below. Reference = the median of the three; the spread is recorded. |
| Circumference around the knuckles, thumb excluded (optional) | Non-stretch tape | 2, as in §1 | Reference for question 3 only. Snug, not compressing the skin, at the level of the metacarpal heads. |

**HT-1 definition (a proposal; the exact landmark must be agreed with the client's own definitions
before collection, as for any chart input, see `docs/RISKS_AND_CLIENT_INPUTS.md`, input 2).** The
distance between the dorsal skin directly over the head of the third metacarpal (the knuckle at
the base of the middle finger) and the palmar skin directly opposite. The participant sits with
the forearm on a table and the relaxed hand supported so that both surfaces at the knuckle line
are free for the tips. The wrist is straight, the fingers together and the thumb alongside. Close
the tips until they just touch the skin; do not indent it. Read to 0.1 mm.

* **Units.** Enter every reading with its unit (mm, cm or in), as for HL-1. The server converts
  to mm, so do not convert by hand. Until the record has a thickness field (§7.6), write the
  readings on the paper sheet with the participant code.
* **Who measures.** Trained staff, **blind to the camera results** (§1). One operator code per
  measurer, not a name. The same measurer for all participants where possible. A subset of
  participants is measured by a second trained measurer; its size is fixed in the pre-registration
  file (§7.5). The inter-measurer SD is reported as the reference error floor for thickness.
* **Spread.** The agreement tolerance between the three readings is fixed in the pre-registration
  file before the first participant. The 2 mm used for hand length is not assumed to transfer,
  because thickness is a much smaller quantity.
* **Instrument check.** The gauge-block check of `docs/PILOT_PROTOCOL.md` §1, each day.

### 7.3 Views captured per participant

* Three views per complete scan, in the app's order: palm, back of hand, side of hand. The coin
  is on the hand in each: flat in the middle of the palm; flat in the middle of the back of the
  hand; resting flat on the side of the hand, thumb side up, facing the camera.
* About **10 usable frames per view** (the app stops early when the frames agree). **Numbers
  only**: landmarks, the hand model's world landmarks, the coin ellipse and its quality metrics,
  brightness, handedness and the view tag. No images.
* At least **3 complete three-view scans per hand**, the hand lowered and repositioned between
  scans, standard conditions; one device per participant, with its model noted. Which hand is
  scanned, the lighting and the measured camera distance are recorded as in `docs/PILOT_PROTOCOL.md` §3.
* The reference measurements of §7.2 are taken from the scanned hand, and the same references
  stay attached to every scan of that hand.

**Limit of numbers-only data.** A thickness method based on the hand's silhouette needs images,
and the in-app records hold none. Numbers-only records can answer question 1 and give landmark and
coin numbers for the side view. They cannot be used to develop or re-run a silhouette method.
That needs the image study of §1 (frame sequences saved under signed research consent, see
`docs/DATA_COLLECTION_AND_PRIVACY.md`) with the side view added, after its own privacy and legal
review. Do not assume the existing review covers the added views.

### 7.4 Analyses

Participants, not scans, are the unit; repeated scans of a hand are not independent people.

* **A1. View agreement.** Per hand, the difference between the hand length of the back view and of
  the palm view (the `view_agreement` the server reports), and each view's error against the HL-1
  reference. Bias, MAE, limits of agreement, and the share of hands flagged by `view_max_rel_diff`.
  Whether the flag coincides with a large error in one view. The cross-check can catch a coin that
  was mis-detected in one view. It cannot catch a wrong coin type chosen in the app, because both
  views use the same nominal diameter.
* **A2. Thickness against caliper**, for whatever thickness method the team builds (none exists
  today): bias, MAE, RMSE, limits of agreement and the p95 absolute error against the HT-1 median,
  repeatability within a hand, and breakdowns as in §3 (device, lighting, skin tone stratum, hand
  size).
* **A3. Circumference against tape.** The hypothesis is an elliptical cross-section with axes equal to
  the breadth and the thickness, `C ≈ π [3(a + b) − √((3a + b)(a + 3b))]` with `a` = breadth / 2 and
  `b` = thickness / 2. The real cross-section is not an ellipse and the tape follows the knuckle
  contour, so a fitted correction may be needed (fitted on the development split only, as in
  §4, item 4). Test it **first with the caliper breadth and the caliper thickness as inputs** to
  separate the model's error from the camera's, and only then with camera-derived inputs. If it
  fails with caliper inputs, camera inputs cannot rescue it.

### 7.5 Rule: nothing is used for sizing until it passes held-out participants

Before any camera result of this study is compared with a reference, a dated file
`multiview_preregistration.md` is written in the study folder (not in the repository), and its
hash is recorded. It holds:

* the analyses A1–A3 exactly as planned, and the exclusion rules;
* the **acceptance criteria**, set from the size step of the client's chart and the client's
  tolerance, as in §5, **not from the data**. They are not proposed here because the error of a
  thickness or circumference method is unknown, and they are not changed after the held-out data
  are opened;
* the split assignment (participants, stratified, random seed), the HT-1 spread tolerance and the
  size of the second-measurer subset.

A method, a measurement, or the `used_for_size` switch of the side view is **not** used for sizing,
for the reported size, or to reduce the uncertainty, until **at least 60 held-out participants**
(the same bar as `CalibrationValidation` in `backend/glovesize/config.py`) meet those criteria, and
a person signs off the report. With the 50/50 split of §1 this means at least 120 participants in
all. Methods are built and tuned only on the development split, and the held-out split is analysed
once. A pilot of 10–15 volunteers cannot meet this and is descriptive only.

The sample size for thickness or circumference claims must be recomputed from the development
split's error SD, as §5 does for hand length (it does not carry over from the hand-length figures).

### 7.6 What the existing validation records store about views

| Item | Stored today? | Notes |
|---|---|---|
| Per-frame numeric observations (landmarks, world landmarks, coin metrics, brightness, handedness), `frames/<record id>.json`, as submitted | **Yes** | Never images. |
| A `view` tag on each frame | **Only once the multi-view scan change is in the app** | The tag is a field of the scan request. When present, it is kept as submitted. The baseline this document was written against has no tag, so palm, back and side frames of one record could not be told apart. Check before collecting. |
| Per-view summary and `view_agreement` | **Computed by the server per scan; not stored as separate record fields** | They can be recomputed from the stored frames with `validation_records.remeasure` (it re-runs the scan pipeline on the stored frames). |
| Reference hand length (HL-1), palm breadth, circumference | **Yes** | `reference.hand_length`, `palm_breadth`, `hand_circumference`, each with its unit. |
| Caliper hand thickness | **No** | New fields needed (below). |
| Guided back and side views in the in-app validation screen and the remote pilot link | **No, they scan the palm only** | The multi-view flow is in the customer flow. |

**TODO for the team (future code changes, none made here):**

1. Add the reference fields: `thickness_reference_mm` (the agreed value, in mm), `thickness_tool`
   (calipers, ruler or other) and `thickness_readings` (up to three readings, each with its unit,
   like `hand_length`), with the unit-aware plausibility check the other readings have, and add
   them to the CSV export and the summary.
2. Let the validation screen and the remote pilot use the guided views, and keep the per-view
   summary and the view agreement in each record.
3. Update the pilot consent text and have it reviewed (`docs/PILOT_PROTOCOL.md` §7).
4. Add the side view to the image study of §1 if a silhouette method is to be developed.

## 8. Coverage across hands (every hand has to work)

The product is meant for every customer, so the validation sample must be built to show whether it
works for every hand, not only for an average one. This is a **requirement on the study design**, not
a result.

* **Recruit across hand size** (hand length from the smallest to the largest the product is sold
  for, and children if it has child sizes), **skin tone** (a recorded scale such as the Monk or
  Fitzpatrick scale, assessed by the operator, not asked of the participant unless consented),
  **sex and age**, **left and right hands**, and hand conditions that make a flat open hand hard
  (stiff or arthritic fingers, scars, bandages), each in enough numbers to say something: a few
  participants per group tell nothing, so state the minimum per group before recruiting.
* **Report the results per group**, not only overall: the error, the share of scans refused, the share that
  needed the tape fallback and the time to a size, for every group. A good overall error that hides a
  poor result for a group is a failure of this requirement.
* **Acceptance criteria per group** are fixed before looking at the data (section 7.3 applies): the tool is
  not declared ready for a group whose held-out participants miss the criteria; it can still be
  offered with the tape measurement as the default for that group, said plainly.
* The tape fallback must be tested as a path in its own right (time, errors on entry, the size it gives).
