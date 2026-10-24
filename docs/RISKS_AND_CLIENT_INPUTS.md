# Remaining risks, known limitations and required client inputs

## Required client inputs

| # | Input | Why | Where it goes |
|---|---|---|---|
| 1 | **Official sizing chart per product**: size labels, the measurement(s) each size is based on, boundaries in mm, and the rule when measurements disagree | The shipped charts are synthetic demos | `config/sizing_charts/<product>.json` (schema validated at startup); set `default_chart_id` in `config/app.json` |
| 2 | The **measurement definitions** used to build those charts (e.g. hand length from which wrist crease; circumference with or without the thumb) | Camera definitions must match the chart's | `docs/MEASUREMENT_METHODOLOGY.md`, calibration targets |
| 3 | A **validation study** (people, reference measurements, try-on outcomes) | Real accuracy is unknown until measured | `docs/VALIDATION_PLAN.md` |
| 4 | Acceptance targets (MAE, adjacent-size accuracy, rejection rate) | Defines when the tool can go live | Validation report |
| 5 | Supported reference objects beyond the quarter (verify each in the study before enabling) | Coin identity cannot be checked from images | `config/reference_objects.json` |
| 6 | Privacy and legal review: consent text, retention, biometric-law assessment | Required before collecting research data | `docs/DATA_COLLECTION_AND_PRIVACY.md` |
| 7 | Branding: logo, colours, product names and hosting domain (HTTPS is required for cameras) | The UI currently uses neutral placeholders | `frontend/src/styles.css`, `index.html` |

### Placeholder charts now, the client's chart later

Until the client's chart arrives the app ships three **demonstration** charts, each labelled as such
on the welcome page and on every result. The default is `demo-everyday-v1`: three coarse sizes
(S below 165 mm, M 165-196 mm, L from 196 mm, by hand length). Its boundaries are invented. They
are wide on purpose: at the camera's present uncertainty (about ±7.7 mm, mostly stored prior
allowances, see `docs/MEASUREMENT_METHODOLOGY.md`) a chart of 12 mm sizes cannot be answered from
the camera alone, whereas this one can, so a demo can run end to end. It says nothing about how any
glove fits. `demo-length-v1` (six 12 mm sizes) and `demo-length-circumference-v1` remain selectable.

**What to ask the client for** (one chart per product):

1. Size labels in the order they sell them (S/M/L, 7/8/9, ...), and which sizes exist.
2. The measurement each size is based on (hand length, palm breadth, hand circumference) and its
   exact **definition** (from which wrist crease, with or without the thumb, tape or caliper).
3. The boundaries in millimetres (convert inches ourselves; say which edge belongs to which size).
4. The rule when two measurements point to different sizes (take the larger? the primary only?).
5. The product and manufacturer names to show, and the wording of the disclaimer they want.
6. Ideally try-on outcomes (size worn, fit rating) to check the chart against real fit.

**How to add it** (no code change):

1. Copy `config/sizing_charts/demo_everyday_chart.json` to `config/sizing_charts/<product>.json`.
2. Set `chart_id`, `manufacturer`, `product_model`, the `rules` (`measurements`, `combine`) and the
   `sizes` bands (`[lower, upper]` in mm, `null` for the open ends of the smallest/largest size).
3. Set `"is_demo": false` and remove the placeholder disclaimer **only** for a chart the client has
   signed off. The server refuses a demo chart without a disclaimer and checks that the bands do not
   overlap and that only the end sizes are open.
4. Set `default_chart_id` in `config/app.json` to the new `chart_id`.
5. Run the backend tests. Narrow bands may make the camera answer "most likely size" instead of a
   single size; that is the honest result until the validation study (`docs/VALIDATION_PLAN.md`)
   replaces the prior allowances with measured ones. Do not edit the calibration file to make a chart
   "pass".

## Risks and limitations

| Risk | Impact | Mitigation in place | Still needed |
|---|---|---|---|
| Landmark offsets (joint centres vs. creases and tips) | Systematic error of several mm | Prior uncertainty; calibration pipeline (dev split) | Real calibration data |
| Depth and perspective (coin above the palm, joints below the skin, unknown FOV) | Scale bias of about 2–5% without adjustment (simulation) | Assumption-based depth adjustment with uncertainty; tilt gate (12°) and distance gate (250 mm); rectification off because it over-corrects | Measure the real bias; A/B test the depth adjustment; a second view or depth sensor to measure it |
| Circumference not observable | Sizes for circumference-based charts | Tape entry; derived model only if validated | Study data to test a model |
| Provisional 3D (world-landmark) gates | Possible over-rejection of real users | Configurable thresholds; rejection reasons shown | Tune on pilot data |
| Unvalidated uncertainty model | The confidence shown may be over- or under-stated | Labelled "model-based, not validated"; conservative priors | Check 95% interval coverage |
| Uncalibrated system reports wide intervals | The camera alone usually gives no size; customers are asked for a tape length | Plausible sizes listed; tape entry in the flow | Calibration will narrow them if the data allow |
| Wrong coin selected or used | Large scale error (a nickel read as a quarter: +14%) | Coin confirmation before the camera starts; unconfirmed scans rejected; implausible-hand rejection; rival circles rejected as ambiguous | Possibly a two-coin check |
| Non-silver references (pennies), shiny or worn coins, glare | Detection failure | Chroma-based detection with glare, occlusion and blur gates; clear messages | Field data across lighting |
| Device variety (wide-angle lenses, low light, older phones) | Accuracy and speed differences | Frame gates; GPU with CPU fallback; resolution hints | Per-device validation |
| Very small or very large hands, skin-tone variation | Possible bias | Wide plausibility ranges | Stratified validation results |
| Browser support (camera APIs need HTTPS; iOS Safari specifics) | The scan cannot start | Specific error messages per failure | Test on target devices |
| Not tested with a physical camera or real hands | Unknown live behaviour and accuracy | Fake-camera e2e tests, real hand photo smoke test, pinhole simulation | Manual device testing; validation-mode pilot; full study |
| Study endpoints reachable from the network | Records written, read or deleted by others | Off by default; localhost-only (loopback address, local Host header, no proxy headers) unless `GLOVESIZE_OPERATOR_TOKEN` is set; CSRF header on writes | Per-user login and roles before any shared deployment |
| Pilot results over-read | Small-sample figures taken as accuracy | Real vs software-test records separated; per-hand statistics; sample-size caveats; no confidence intervals; calibration cannot become validated without held-out evidence and sign-off | Full held-out study |
| Tilt gate over-rejects | A true ~10° palm tilt reads about 14° through perspective (simulation) and is rejected at the 12° gate | Rejection reasons recorded | Check the pilot's rejection rate and reasons; retune on data |

## Engineering notes

* The coin detector exists in Python (reference, offline validation) and in TypeScript (live
  browser). Any change must update both, regenerate the fixtures
  (`python -m scripts.make_parity_fixtures`) and pass the parity tests.
* Public config (`/api/config`) is the single source of thresholds for both frontend and
  backend.
* The research and validation endpoints are operator-only (`glovesize/operator_access.py`):
  localhost by default, bearer token otherwise. There are no user accounts or roles.
* `docs/CALIBRATION_STUDY.md` is generated by `scripts/calibration_study.py`. Regenerate it after
  changing the calibration or depth config.
