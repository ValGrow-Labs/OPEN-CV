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

1. **Depth correction on vs. off** (`depth_model.enabled`): keep it only if it reduces test
   error.
2. **Gate tuning**: rejection rate vs. error as the world-landmark thresholds vary
   (`max_palm_tilt_deg_model`, `max_finger_bend_deg_3d`). They are currently provisional.
3. **Circumference / breadth models** (`fit_calibration.py` fits linear models from
   `mcp_span_mm` and `hand_length_mm`). Use them only if the test-split residual is small
   relative to the chart's size step. Otherwise keep requiring tape entry.
4. **Machine learning.** Consider a learned correction (e.g. gradient boosting on landmark
   features) only if it beats the linear calibration on the **test** split, with participants
   cross-validated on dev.
5. **Capture distance**: check whether error depends on the estimated camera distance. If so,
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

* Algorithm correctness on synthetic geometry (pytest: coin diameters, tilt, occlusion, blur,
  glare, rectification, depth model, aggregation, sizing rules).
* Parity between the browser and Python implementations (Vitest fixtures; Playwright
  cross-check on a real hand photo).
* The end-to-end pipeline in a real browser with a fake camera.

None of these measure real-world accuracy.
