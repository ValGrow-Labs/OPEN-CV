# Validation plan: smartphone 3D hand reconstruction and measurement

**Status: a plan. Nothing in it has been run.** No real-world validation of this project exists. Every number the 3D
research code produces today comes from synthetic geometry (arithmetic checks), not from people. This plan adds to, and
must stay consistent with, the existing documents; where they speak, they win:

* `docs/VALIDATION_PLAN.md` (study design, split, metrics, acceptance, sections 7 and 8),
* `docs/MEASUREMENT_METHODOLOGY.md`, `docs/PILOT_PROTOCOL.md` (HL-1, HT-1), `docs/RISKS_AND_CLIENT_INPUTS.md`,
* `docs/CONSENT_REVIEW.md`, `docs/DATA_COLLECTION_AND_PRIVACY.md`.

Rules carried over (not relaxed here): no invented data or reference measurements; no synthetic result described as real accuracy;
`config/measurement_calibration.json` is not marked validated by this work; `config/pilot_consent.json` stays `reviewed: false` until a person reviews it;
no volunteer invites, no public tunnel; **nothing from the 3D pipeline is used for sizing** until held-out real participants meet criteria the
client set in advance (existing section 7.5: at least 60 held-out participants, a signed report).

Pixel scale is not accuracy: an image scale of 0.1 mm per pixel does **not** mean 0.1 mm measurement accuracy. Boundary position, the coin scale's
plane, perspective, pose and soft tissue all add error. Never write "0.1 mm accuracy", "100% accurate" or similar from a pixel size.

## 1. What is being validated

| Output of the pipeline | Reference instrument | Direct or model-based |
|---|---|---|
| Hand mask (IoU, Dice, boundary error) | Hand-traced masks by trained annotators | A *segmentation* result; it is not a measurement accuracy |
| Hand length, palm breadth, finger lengths | Anthropometer / sliding caliper (existing protocol HL-1; breadth at the metacarpal heads) | Direct if taken from the mask or mesh; landmark-based values are model-based |
| Hand thickness at the knuckle line | Calipers, protocol HT-1 (existing proposal in `docs/VALIDATION_PLAN.md` 7.2; three readings, hand lifted between) | Direct from a valid side view or a mesh |
| Circumference at a defined cross-section | Non-stretch tape (the client's definition, see below) | **Model-based** unless a depth source covers the whole cross-section |
| Projected area | Reference mask area scaled by the plane's scale | Direct only where scale is valid across the hand |
| 3D surface area | A 3D reference scanner **if the study has one**; otherwise **not validated** (no hand-held instrument measures it) | Model-based, or direct with dense coverage |
| Mesh completeness, failed-reconstruction rate, processing time, device compatibility | Counts and timings from the pipeline | Operational, not accuracy |

## 2. Reference measurement standards and instruments

* **Body measurement definitions:** ISO 7250-1:2017, *Basic human body measurements for technological design, Part 1: Body measurement definitions and landmarks*
  (https://www.iso.org/standard/65246.html, read 2026-11-07; the 2008 edition is https://www.iso.org/standard/44152.html). The ISO page says it is also a basis for extracting
  one- and two-dimensional measurements from 3D scans, which ISO 20685 specifies. I did **not** read either standard's text, so the exact hand definitions are
  `UNVERIFIED` here; buy and read them before the protocol is frozen. The standard's title for ISO 20685 was not retrieved (`UNVERIFIED`).
* **Glove sizing:** the size scheme in use is EN ISO 21420:2020, which replaced EN 420:2003+A1:2009 (manufacturer pages report the same hand-size scheme carried over; the standard text was not read:
  `UNVERIFIED`). **The client's own measurement definitions govern** (`docs/RISKS_AND_CLIENT_INPUTS.md`, input 2): from which wrist crease, circumference open hand or fist,
  with or without the thumb, tape or caliper.
* **Instruments:** an anthropometer or large sliding caliper for lengths, a 0.1 mm caliper for breadth and thickness, a non-stretch tape for circumference (as in the existing plan),
  a gauge block or certified 100 mm reference checked daily (`docs/PILOT_PROTOCOL.md` section 1). A **3D reference scanner** (a hand-held or structured-light scanner with a
  documented accuracy) is optional but is the only way to validate surface area and completeness; its availability and certified accuracy are a client/study-owner input.
  Published scanner-versus-manual comparisons exist (for example the Minnesota 2020 papers, https://www.proc.3dbody.tech/papers/2020/2038bhuyan.pdf, read via search) and show circumference as the weak measurement; they do not replace this study.
* **Reference error floor:** report intra-rater and inter-rater SD for every reference measurement; the camera's error cannot be judged below that floor.

## 3. Measurement protocol

* Trained staff, **blind to the camera results**; one operator code per measurer (no names in data); the same measurer where possible; a **second measurer on a subset**
  (size fixed in advance) for inter-rater error.
* **Each reference taken at least twice** (three times for thickness, hand lifted and replaced), spread tolerance fixed before the first participant; agreed value = mean or median as in the existing plan.
* **Posture is part of the definition.** Fix and document: forearm support, wrist straight, finger spread, fist or open (client definition), caliper pressure ("touch, not indent").
  Hand posture and finger-spread effects on measurements: no primary source with numbers was found (`UNVERIFIED`), so the study must measure posture repeatability itself (section 6).
* Landmarks marked on the skin only if the participant consents, and removed before photos if they would be seen by the camera.

## 4. Stages and gates

| Stage | Data | What it can say | Gate to pass |
|---|---|---|---|
| **G0 synthetic** | Rendered or analytic shapes with known truth | The geometry code does the arithmetic it claims (areas, hull, projection) | Unit tests green. **Never reported as accuracy** |
| **G1 rigid phantoms** (real objects, hand-sized, with known dimensions measured by calipers: for example machined or 3D-printed hand-shaped blocks) | Real captures on real phones | Separates reconstruction error from posture and soft-tissue error; checks scale, intrinsics and pose handling | Defined before use; results labelled "phantom" |
| **G2 pilot** (10 to 15 volunteers, existing pilot protocol extended) | Real participants, consent signed | Descriptive only (existing wording: "cannot establish accuracy for the public") | None; no calibration change |
| **G3 full study** (at least 120 participants, 50/50 development and held-out, participants not scans as the unit) | As the existing section 1 | Held-out accuracy and repeatability, per group | Criteria pre-registered (section 8) |
| **G4 sign-off** | The G3 report | Whether any 3D output may be used for sizing | A person signs; at least 60 held-out participants meet the criteria (existing 7.5) |

## 5. Sample size reasoning (illustrative; recompute from the development split)

The existing plan fixes at least 120 participants (about 60 development, 60 held-out). Standard approximations (Bland and Altman, *Lancet* 1986) for the paired differences d = estimate minus reference with SD s:

* 95% confidence interval of the bias: ± 1.96 · s / √n.
* 95% limits of agreement: bias ± 1.96 · s; the 95% interval of each limit is approximately ± 1.96 · s · √(3/n).

Illustration only (s is **assumed**, not measured; do not quote it as a result): with s = 3 mm and n = 60 held-out participants, the bias interval is about ± 0.76 mm and each limit of agreement is uncertain by about ± 1.31 mm.
Proportions (rejection rate, exact-size accuracy) need their own calculation (a proportion near 90% carries about ± 8 percentage points at n = 60, as the existing plan notes). **Thickness, circumference, area and mask metrics have unknown error SD today:
the sample size for each must be recomputed from the development split**, exactly as `docs/VALIDATION_PLAN.md` 7.5 requires. State the **minimum number per stratum before recruiting**: a few participants per group tell nothing.

## 6. Stratification and repeatability

* **Strata (report per group, not only overall; existing section 8):** hand-size band, skin tone (recorded scale such as Monk or Fitzpatrick, assessed by the operator), sex and age, left and right hand, hand conditions that make a flat hand
  hard (stiff or arthritic fingers, scars, bandages), phone model and OS and browser, lens used, lighting (normal, dim, mixed, strong shadows), background (plain, patterned, skin-coloured), camera distance bands (existing bands), operators.
* **Repeatability design:** at least three complete captures per hand, hand lowered and replaced between captures (existing 7.3); within-session, between-session (another day), between-operator and between-device. Report the within-hand SD, the repeatability coefficient
  (1.96 · √2 · within-hand SD) and an ICC for each measurement, plus the **shift per condition** relative to the same hand's standard captures.
* **Pose consistency:** per hand, the drift of finger lengths and knuckle span between views; large drift means the views do not describe one rigid shape and the multi-view result is untrustworthy for that capture.

## 7. Metrics to report

Per measurement and per split (same set as `docs/VALIDATION_PLAN.md` section 3): **MAE, RMSE, bias, error SD, Bland-Altman limits of agreement, p50/p90/p95/max absolute error, 95%-interval coverage** (where an uncertainty is reported).
For the 3D pipeline add:

* **Segmentation:** IoU, Dice and boundary error (mean and 95th percentile distance, px and mm) against hand-traced masks; **inter-annotator IoU** on a subset as the ceiling. Reported as segmentation quality only.
* **Mesh completeness:** define before the study, for example the fraction of the reference surface within a stated distance of the mesh (needs a reference scan) or, without one, the share of surface patches seen by at least *k* views
  (a *coverage* number, not an accuracy). Say which one is reported.
* **Failed-reconstruction rate:** the share of captures rejected or below the quality gates, by reason, per group, as a **cost to customers** (existing practice: report refusals, not hide them).
* **Processing time:** per stage, on device and server, p50 and p95, per phone model, with thermal state noted.
* **Device compatibility:** the capability matrix per phone model (`DEVICE_COMPATIBILITY.md`) and the success rate per model.

## 8. Acceptance criteria (the client's to define)

The manufacturer must set them, before the held-out data are opened, from the size step of its own chart and its tolerance for a wrong or adjacent size (`docs/RISKS_AND_CLIENT_INPUTS.md`, input 4). They are **not** proposed here:
the error of a thickness, circumference or area method is unknown, and the hand-length targets in `docs/VALIDATION_PLAN.md` section 5 do **not** carry over.

Decision framework to fill in with the client:

1. For each measurement the product would use: the size step, the largest error that still gives the right or an acceptable adjacent size, and the acceptable rate of exceeding it.
2. Criteria **per group** (section 6), fixed in a dated pre-registration file whose hash is recorded, **before** looking at held-out data; held-out data analysed once.
3. If a group misses its criteria: the tool is not offered for it, or the tape measurement is the default for it, said plainly.
4. A 3D output reaches sizing only when at least 60 held-out participants meet the criteria and a person signs the report (existing 7.5). Until then the 3D hand is a visualisation.

## 9. Ethics, consent and privacy

* **Images, silhouettes, masks and meshes of a hand are personal data.** A palm or fingertip image can reveal friction ridges; a biometric-law assessment is already a required client input
  (`docs/RISKS_AND_CLIENT_INPUTS.md`, input 6). Do not assume the existing review covers added views or stored images (existing `docs/VALIDATION_PLAN.md` 7.3).
* **Consent:** a separate signed consent for an image study (the remote pilot text says no photos leave the phone and must **not** be reused: `docs/CONSENT_REVIEW.md` section 1). It states what is recorded (images or only masks and numbers),
  where processed, how long kept, who can access, how to withdraw. Contact details and deletion dates are placeholders for the study owner and are **not invented here**.
  `config/pilot_consent.json` stays `reviewed: false`.
* **Storage and handling:** offline processing on a study computer, encrypted disk, a study folder outside the repository, no cloud backup or sync on study phones, no messaging apps, transfer by USB cable only (the model of the comparison study),
  no faces, no names in data, a random participant code as the only key, the signed forms kept separately, access limited to named staff, retention limit and deletion date fixed by the study owner, deletion on request by participant code, deleted derived data (masks, meshes, features) included.
* **Data minimisation:** keep numbers (landmarks, ellipse, masks) where the question allows; images only for the segmentation and silhouette questions that need them.
* **Third-party models and datasets:** no public dataset with 3D hand ground truth is licensed for commercial use (`LICENSING.md`), so the study's own consented data is also the training and test set; keep a licence record for every model and annotation tool used.

## 10. Synthetic tests versus real validation

* Synthetic tests prove **arithmetic and code paths** (for example a known mesh gives the known area, a known camera projects as expected). They are labelled `data_origin: synthetic`, kept in separate files and folders from real data, and
  **reported in a separate section that says they are not accuracy**.
* Real results come only from `real_participant` (or labelled phantom) records with physical references, produced by the staged plan above. A report never mixes the two, never presents a synthetic success rate as a real one, and never fits and evaluates a method on the same participants
  (development and held-out are split by participant before analysis).

## 11. The report

Must contain: the pre-registration (hash), the instruments and their checks, rater error, the participant strata with counts, the metrics per group with intervals, the failure and refusal rates, processing times per device, the licence record, every deviation from the plan, and a plain statement of what was **not** shown.
