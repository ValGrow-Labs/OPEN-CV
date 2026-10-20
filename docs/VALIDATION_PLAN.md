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
