# Repeated capture experiment (phantom), design

Purpose: measure how the reconstruction behaves on a real phone, a real print and a rigid phantom, including **whether
its gates reject the captures they should**. Pre-register this design (conditions, repeats, analysis) before the first
capture; changes after seeing data are recorded as deviations.

## 1. Fixed set-up

* One verified board (`BOARD_VERIFICATION.md`), mounted flat; one phantom with its reference file
  (`PHANTOM_PROTOCOL.md`); the 2019 two-rupee coin between the ticks.
* Phantom placed palm-down, wrist at the open left edge, fingertips short of the coin ticks, inside the marker rows. Its
  outline is traced lightly in pencil on a sheet of tracing paper laid over the board for re-placement (removed before
  the capture).
* Page: `https://<PC address>:5173/experiment/recon/?validation&debug` (see `frontend/src/experimental/recon/README.md`),
  rear camera, the page's default resolution, no zoom. Fill in the run details (phantom id, session id, operator code,
  condition tags) for every capture; export every capture, accepted or not.
* Each phone: the model, Android and Chrome versions, battery level, power-saving off.

## 2. Camera positions and angles

The coverage guide already demands one top view (60 degrees or more) and the low ring (8 to 22 degrees, 12 sectors);
the optional middle ring (25 to 45 degrees) is added in half of the baseline captures to measure its effect. Distances are
varied as conditions (section 3): near (about 250 mm), normal (about 350 mm), far (about 450 mm).

## 3. Conditions and repeats (per phone)

| Condition | Tag | How | Captures | Expected outcome |
|---|---|---|---|---|
| Baseline | baseline | diffuse daylight or a large soft light, normal distance | **3 sessions x 5** (different days; phantom removed and replaced every capture; board re-checked each session) | accepted; these give accuracy and repeatability |
| Middle ring added | baseline + note | as baseline, middle ring filled too | 5 (within the sessions above) | accepted; compare with/without |
| Near / far | near, far | about 250 mm / 450 mm | 5 + 5 | far: more lost markers in low views; accepted or rejected with reasons |
| Glare | glare | a small bright lamp low on the far side, so its reflection crosses the markers in some low views | 5 | markers lost in some views; views rejected with reasons; never a silently wrong pose |
| Hard shadow | shadow | one strong directional light, the phantom's shadow over the board | 5 | segmentation must not take the shadow as hand (thickness, breadth unchanged within repeatability) or the capture is rejected |
| Low light | low_light | dim room | 5 | blur/sharpness gate holds captures back; accepted views as baseline |
| Partial markers | partial_markers | cover 4, then 8 markers with matte paper strips | 5 + 5 | fewer markers per view, poses still good or views rejected |
| **Board curl (fault)** | board_curl | lift one long edge with a 1 mm, then a 3 mm shim | 5 + 5 | **should be rejected** by the flatness check or the reprojection gates; an accepted capture with a shifted result is a gate failure |
| **Wrong print scale (fault)** | other ("fit_to_page") | a second board printed with "Fit to page" | 5 | **should be caught** by the ruler check (before capture) and by the coin check |
| **Calibration fault** | other ("no_low_ring") | only the top view and the middle ring, no low ring (the page must not allow Build: record that it refuses) | 3 | refused or gate `sides_not_observed` |
| **Phantom moved (fault)** | other ("moved") | nudge the phantom about 5 mm halfway through the sweep | 5 | hand-moved check names views or the reprojection gate rejects |

About 100 captures per phone at 2 to 3 minutes each.

## 4. Recorded per capture (all in the export)

`run` (ids, conditions), `board_check` (ruler, flatness, coin), calibration (method, focal length and SD, RMS), per view
(markers, inconsistent markers, per-marker residuals, pose RMS, elevation, azimuth, used or why not), quality verdict and
every reason, support shares (observed / implied / board / forearm cut / truncated), measurements with basis and note,
landmark source (triangulated or one view), timings, and `device.json` (durations, heap, errors, export success).
Rejected captures are kept and counted; nothing is deleted after the fact.

## 5. Analysis (`frontend/scripts/phantom-report.ts`)

* Accuracy against the agreed caliper values, **baseline captures only**: per dimension n, MAE, RMSE, signed bias,
  maximum absolute error, SD, limits of agreement; like-for-like dimensions scored, "definition differs" ones shown apart.
* Repeatability: within-session SD and repeatability coefficient (2.77 x SD), between-session spread.
* Gate behaviour per fault condition: share rejected (expected 100 %), and for any accepted fault capture its error
  (a **false accept**). Per benign condition: share rejected (false rejects) and error vs baseline.
* Mesh completeness and support shares; surface distance where a reference mesh exists (observed vertices only).
* Processing times (median, p90) per phone.
* One phantom, captures not independent participants: no population statistics, no confidence statement about people.

## 6. Acceptance

Tolerances are **the client's to set** before the data are seen (`VALIDATION_PLAN.md` section 8). This experiment reports
numbers; it does not decide that the system is validated, and its results may not be quoted as human-hand accuracy.
