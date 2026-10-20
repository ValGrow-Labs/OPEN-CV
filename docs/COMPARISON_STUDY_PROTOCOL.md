# Comparison study protocol: coin on palm vs hand flat on paper

**Version:** draft 1 (not yet approved). **Status:** ready for review; collection blocked until
the items in section 13 are cleared.

Both methods are **experimental**. This study compares them against physical caliper
measurements under controlled conditions. It does not validate either method for customers, it
does not change the production app or its calibration (`config/measurement_calibration.json`
stays `uncalibrated`), and no simulation result is used to choose a method.

Related: consent and data-protection review `docs/CONSENT_REVIEW.md`; tools
`backend/validation/comparison.py`; methods `docs/MEASUREMENT_METHODOLOGY.md` (coin) and
`docs/PAPER_METHOD_EVALUATION.md` (paper).

## 1. Objectives

* **Primary:** compare the hand-length accuracy of the two methods against a blinded caliper
  reference, within the same participants.
* **Secondary:**
  * bias, MAE, RMSE and limits of agreement per method;
  * repeatability;
  * rejection and retake rates;
  * time to a successful capture;
  * ease of use;
  * self-capture success and accuracy;
  * hand breadth accuracy (paper method only; the coin method does not measure skin-to-skin
    breadth).

## 2. Design

* Single site, **within-participant crossover** with **randomised method order**: permuted blocks
  of 4, half coin-first and half paper-first.
* **Two phases:**
  * **Feasibility:** the first 10–15 participants (section 8).
  * **Confirmatory:** a separate set of participants, recruited after the freeze in section 8.
    The sample size is in section 9.
* One phone model for all captures. The model and OS version are recorded.

## 3. Roles and blinding

| Role | Does | Must not see |
|---|---|---|
| **Measurer** | Takes the caliper reference measurements, in a separate area, before any scan. Writes them on the paper case-report form (CRF). | Any camera output. Does not run scans. |
| **Scan operator** | Runs both methods following the allocation. Validation screen in **Blinded session** mode. Paper photos are processed in-session with `process-paper`, which prints only accepted/rejected. | Camera estimates, errors, summaries, the attempts files, the reference values in the CRF. |
| **Data manager** | Generates and holds the allocation list (sealed seed), transcribes the CRF (double entry), runs imports and analyses, holds the data. | Shares no outcome data with the operator or measurer during the study. |
| **Study owner** | Approves the protocol, the consent text and the minimum important difference; makes the final decision after the analysis. | Unblinded interim efficacy results (none are planned). |

**Retake rule (both methods):** a slot is retaken only when the *app* rejects the capture (coin:
the scan is rejected; paper: `process-paper` reports "rejected"), up to 3 tries per slot. Never
because a value looks wrong; the operator cannot see values.

## 4. Participants

* Adults (18+) who give written consent, with no hand injury, deformity, cast or bandage, and
  able to lay the hand flat and hold it up open.
* Recruit across hand sizes, sexes and skin tones. Record only anonymous strata (age band, sex,
  skin-tone band), never identity.
* **Hand:** the right hand, unless it cannot be used; the same hand for every measurement.
  Rings, watches and bracelets removed; sleeves above the wrist. Record "fingernail beyond the
  fingertip pad: yes/no", which affects the paper outline.

## 5. Reference measurements (blinded measurer)

**Tools.** Rulers are **not** acceptable references in this study.

* **Hand length:** an anthropometer or a large sliding caliper with a range of at least 300 mm
  and flat jaws, read to 0.5 mm or better.
* **Hand breadth:** a sliding caliper (digital or vernier, at least 150 mm, 0.1 mm resolution)
  with jaws deep enough to span the palm.
* **Daily check:** zero, and a known length (a gauge block or a certified 100 mm reference),
  logged on the CRF. A tool that is off by more than 0.2 mm is not used.

**Definitions** (the same for both methods):

* **Hand length (HL-2):** palm up, forearm resting on the table, wrist straight, fingers
  extended and together. Straight-line distance, **parallel to the long axis of the hand**, from
  the midpoint of the **distal wrist crease** to the **tip of the middle finger** (the most distal
  point of the fingertip pad, not the nail). The caliper beam is held above the hand, not resting
  on it. One jaw is at the crease, the other at the fingertip.
* **Hand breadth (MB-1):** palm down, flat, fingers together, thumb spread away. Straight-line
  distance from the radial side of the 2nd metacarpal head to the ulnar side of the 5th
  metacarpal head, perpendicular to the long axis. Jaws just touching the skin, without
  compressing it.

**Repeats:** two readings of each, with the hand lifted and repositioned in between. A third
reading if they differ by more than 2 mm. Reference = the mean of two agreeing readings, or the
median of three when it agrees with another reading within 2 mm. Otherwise the participant has
no usable reference and is excluded from the accuracy analyses (counted in the report).

**Inter-measurer check (feasibility phase):** a second trained measurer repeats the
measurements on the feasibility participants. Report the technical error of measurement, which
sets the reference error SD used in section 9.

## 6. Capture conditions (both methods)

| Item | Setting |
|---|---|
| Room | The same room for everyone. Diffuse overhead light, no direct sun; note the light (and lux, if a meter is available). |
| Table | Matte, dark, non-patterned (needed for paper detection; also used for the coin method) |
| Phone | One model. Default camera app for paper photos; the validation screen in the phone browser for the coin method (section 13 lists the HTTPS/token requirement). |
| Coin method | The site's coin, confirmed in the app, flat in the centre of the palm. Camera about 35–40 cm away, following the app's on-screen guidance. |
| Paper method | New A4 80 g/m² sheet (or US Letter, selected accordingly), flat, on the dark table. Wrist crease aligned with the sheet's short edge by the operator, palm down, fingers together, thumb spread. Phone held directly above at about 30–40 cm, whole sheet in frame. Cloud backup and location tagging are off on the phone. |

## 7. Session sequence

1. Consent (the final reviewed form; `docs/CONSENT_REVIEW.md`) and eligibility.
2. Reference measurements by the measurer (section 5). The CRF stays with the measurer.
3. Open the next allocation row: coin-first or paper-first.
4. **Method A**, then **method B**, each:
   * **slots 1, 2, 3:** operator-assisted standard captures, with the hand repositioned between
     slots;
   * **slot "self":** the participant captures alone after one demonstration;
   * the stopwatch runs from the start instruction to the first accepted capture of slot 1;
   * after the method: "How easy was this?" on a 1–7 scale.
5. **Naming and processing:**
   * Coin attempts are recorded in validation mode (record type *Real participant*, condition
     *Standard*, blinded session).
   * Paper photos are named `<code>_paper_<slot>_t<try>.jpg`, copied by USB cable to
     `C:\study\incoming`, and processed at once:
     `python -m validation.comparison process-paper C:\study\incoming --paper a4 --out C:\study\paper_attempts.csv --append --delete-processed`.
     The photo is deleted from the computer as soon as its numbers are extracted. The operator
     deletes it from the phone, including any "recently deleted" album.
6. End of session: the data manager checks that no photo remains on the phone or computer, and
   logs this (section 10 of `docs/CONSENT_REVIEW.md`).

## 8. Feasibility phase (first 10–15 participants)

**Purpose:**
* check the procedures, timings, data flow and photo deletion;
* estimate nuisance parameters for section 9: SD of the paired difference, error SDs,
  rejection rates and reference measurement error.

**Rules:**
* Feasibility participants are **never** part of the confirmatory analysis, whatever happens
  after them.
* Anything may be changed after feasibility: instructions, thresholds, algorithms, the paper
  method's assumptions, even this protocol. Every change is logged with its date and reason.
* Before the first confirmatory participant, everything is **frozen**:
  * the git commit of the code;
  * the coin method's configuration fingerprint (shown in validation mode);
  * the SHA-256 of `backend/experimental/paper_method/config.json`;
  * the minimum important difference (section 9).

  These are written into the protocol. No change after the freeze.
* Feasibility results are reported separately as exploratory and are never cited as
  confirmation.

## 9. Sample size

**Primary outcome scale.** For participant *i*: D*i* = |coin error| − |paper error| for the
slot-1 capture (section 11). The sample size depends on the **SD of D**, not on the SD of either
method's individual errors.

* The individual-error SD of each method (σ_coin, σ_paper) includes everything that makes a
  capture differ from the reference.
* Both methods are compared with the **same** reference measurement, so the reference's own
  error is shared. In the signed difference e_coin − e_paper it cancels:
  SD = √(σ²_coin + σ²_paper − 2ρσ_coinσ_paper).
* The primary outcome uses **absolute** errors. Their difference has no simple closed form, so
  its SD is simulated (`python -m validation.comparison sample-size`).
* Using an individual-error SD in place of SD(D) gives the wrong n: too large in some
  scenarios, too small in others.

**Planning assumptions** (to be replaced by feasibility estimates):
* method error SDs of 3–6 mm, with no bias;
* reference error SD 1 mm;
* two-sided α 0.05, power 80%.

The numbers below are planning figures from the simulation, **not results**:

| SD coin | SD paper | SD of D | n for δ = 1.5 mm | n for δ = 1.0 mm |
|---|---|---|---|---|
| 3 | 3 | 2.7 | 28 | 59 |
| 4 | 3 | 3.1 | 37 | 79 |
| 4 | 4 | 3.5 | 45 | 99 |
| 5 | 4 | 4.0 | 57 | 125 |
| 5 | 5 | 4.4 | 68 | 151 |
| 6 | 5 | 4.8 | 82 | 182 |
| 6 | 6 | 5.2 | 96 | 214 |

* **Minimum important difference (δ):** to be agreed in writing with the client **before** the
  feasibility results are analysed. A sensible starting point is a fraction of the chart's size
  step; for example δ = 1.5 mm against a 12 mm step. It is then fixed.
* **Planned confirmatory n:** 60 (power ≥ 80% for δ = 1.5 mm when SD(D) ≤ 4.0 mm).
  **Maximum:** 120.
* **Re-assessment (once, after feasibility, blinded):**
  * The data manager runs `python -m validation.comparison nuisance … --delta δ --planned-n 60 --max-n 120`.
  * It reports only spreads and rates, never a mean, bias or MAE, and gives
    n = min(max, max(planned, required)).
  * The sample size can only stay or grow, never shrink because a method looks better.
  * δ, α, the power and the primary outcome are not changed. Nobody looks at mean differences
    before the confirmatory analysis.
* **No interim efficacy analysis and no early stopping for benefit.** Stopping for safety, or for
  a data-protection failure, is allowed and documented.

## 10. Data collected

| Data | Where | Content |
|---|---|---|
| Allocation | `allocation.csv` (data manager) | slot number → order |
| Participants | `participants.csv` | code, phase, order, site, device, coin, paper size |
| Reference | paper CRF, then `reference.csv` (double entry) | code, hand, measurer code, tools, length and breadth readings |
| Coin attempts | validation mode `records.jsonl` (+ `frames/`, `configs/`), then `import-coin` | numbers only; no images |
| Paper attempts | `paper_attempts.csv` from `process-paper` | numbers only; photos deleted after processing |
| Usability | `usability.csv` | code, method, seconds to first accepted capture, ease 1–7 |

Templates: `backend/validation/templates/comparison_*.csv`.

## 11. Statistical analysis plan (fixed before collection)

**Populations:**
* **Confirmatory set:** confirmatory-phase participants with a usable reference and an accepted
  slot-1 capture for both methods (complete pairs).
* Exclusions are counted by reason.
* The feasibility set is analysed separately and labelled exploratory.

**Primary outcome and analysis:**
* Outcome: D*i* = |e_coin,i| − |e_paper,i|, with e = (slot-1 accepted hand-length estimate) −
  reference. A positive D favours paper.
* Estimate: the mean D with its 95% CI from the paired t distribution.
* Sensitivity analyses, which must agree in direction: a bootstrap 95% CI (5000 resamples) and
  the Wilcoxon signed-rank test.
* `python -m validation.comparison analyse … --phase confirmatory --delta-mid δ`

**Pre-specified decision criteria (evaluated by the study team, not chosen by software):**
* **Paper more accurate:** the 95% CI lower bound > 0 and mean D ≥ δ.
* **Coin more accurate:** the 95% CI upper bound < 0 and −mean D ≥ δ.
* Otherwise: **no demonstrated accuracy difference.**
* Whatever the result, a method is recommended for further development only if its rejection
  rate and self-capture success meet thresholds agreed with the client beforehand. Neither
  method is validated for customers by this study.

**Secondary outcomes** (reported with estimates and CIs; no claims from p-values):
* Per method: bias (mean signed error), MAE, RMSE, SD and 95% limits of agreement for slot 1.
* **Repeatability:** pooled within-participant SD over slots 1–3 and the repeatability
  coefficient (2.77 × SD). Reported **separately from accuracy**, because a method can be
  consistently wrong.
* **Rejections and retakes:** rejected tries / all tries, per method; retakes per slot.
* **Self-capture:** success (accepted within 3 tries) and accuracy.
* **Breadth:** paper method vs caliper breadth; descriptive, single-method.
* **Usability:** median ease and seconds to the first accepted capture, per method; paired
  Wilcoxon for ease.

**Missing data:** the primary analysis uses complete pairs. Every participant missing a method's
slot-1 capture after 3 tries is reported, together with each method's failure count. A failure
is an outcome of its own, never imputed as an accuracy value.

**Subgroups** (descriptive only, no inference):
* hand-length tertile;
* skin-tone band;
* fingernail overhang;
* coin-first vs paper-first (also a check for a period effect).

## 12. What the study can and cannot conclude

* It can show whether one capture method is more accurate than the other for hand length,
  **on this site's participants, phone, coin, paper and protocol**.
* It cannot validate either method for customers, establish glove-size accuracy (that needs the
  manufacturer's chart and fit outcomes), or replace the held-out study in `VALIDATION_PLAN.md`.

## 13. Readiness: what is blocking collection

| Item | Status |
|---|---|
| Final consent text matching this workflow (photos on a computer) | **Blocked:** draft only, needs review (`docs/CONSENT_REVIEW.md`) |
| Ethics / legal approval as required for the site | **Blocked:** study owner |
| Minimum important difference δ, decision thresholds, sample cap | **Blocked:** client and study owner |
| Calipers and gauge block | **Blocked:** procurement |
| Coin method on the study phone: the validation screen needs HTTPS when opened on a phone, i.e. a token behind HTTPS (README, Security) | **Open:** set up locally for the study (not a public tunnel), or run the coin method on a laptop with a webcam |
| Coin at non-US sites: the validation screen offers only customer coins (US quarter) | **Open:** run at a US site, or add pilot-coin selection (with the ruler check) to validation mode before the study |
| Blinded session, randomisation, in-session paper processing, imports, analysis, re-estimation | Ready (tested) |
| Paper method | Ready as an experiment (synthetic tests only) |
