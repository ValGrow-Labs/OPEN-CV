# Accuracy study: quick start

**Why this is needed.** The app cannot get more accurate on its own, and no amount of extra scans fixes that: a scan
only tells the app its own guess. To improve accuracy, and to state an honest accuracy figure, every scan has to be paired
with a real measurement of the same hand, taken with a caliper. Earlier rounds of work (`FINGER_ACCURACY_AUDIT.md`) took
the measuring method as far as it can go without such measurements: the random error is already small (0.2–0.6 mm); what
is still unknown is the app's systematic error on real hands (where the real fingertip and finger crease are, and how the
hand tracker is biased), and only measured hands can show it.

**What the study gives.** For each finger and the hand length: the app's average error (bias), how much it varies, and
how often the truth falls inside the app's reported range. Every scan's raw numbers are stored, so once there is data,
each setting the app has (depth-aware lengths, the outline fingertip, the crease position, and so on) can be replayed on
the same scans and the best one chosen on evidence. Nothing is fitted or switched automatically.

This quick start covers an **in-person session**: a trained person measures each participant with a caliper and runs the
scans. The full rules are in `PILOT_PROTOCOL.md` (sections 1–4, including finger lengths, section 2a). The remote pilot
(volunteers measuring themselves) is a separate mode and stays off.

## 1. Before the first session (once)

1. **Consent.** Prepare a written consent form for participants that says what is recorded: a random code, which hand,
   the caliper readings, the app's estimates and capture details. No images, names or contact details are stored by the
   app. Keep signed forms on paper or in a separate system, never in the app. `DATA_COLLECTION_AND_PRIVACY.md` and
   `CONSENT_REVIEW.md` list what the form must cover; it is your decision and, where required, a reviewer's, and nothing in
   the app marks it as reviewed.
2. **Equipment.** A sliding caliper (at least 150 mm, read to 0.5 mm) for fingers, a large caliper or anthropometer (at
   least 300 mm) for hand length, the coin you scan with, and one phone used for the whole study.
3. **Switch on validation mode on the Coolify app** (`ocv.valgrowlabs.com`):
   * **Persistent Storage:** add a volume mounted at **`/data`**, so records survive redeploys.
   * **Environment Variables:**

     | Name | Value |
     |---|---|
     | `GLOVESIZE_VALIDATION_ENABLED` | `true` |
     | `GLOVESIZE_VALIDATION_PATH` | `/data/validation/records.jsonl` |
     | `GLOVESIZE_OPERATOR_TOKEN` | a random secret of at least 32 characters (for example from a password manager) |

   * Redeploy. Keep the token private: anyone with it can add or delete study records. The app refuses to start with a
     token shorter than 32 characters.
   * Leave `GLOVESIZE_RESEARCH_ENABLED` and `GLOVESIZE_PILOT_REMOTE_ENABLED` unset.
4. **Practice.** Open `https://ocv.valgrowlabs.com/#/validation`, paste the token, and record one scan as **Software
   test**. Software tests are stored but never counted.

## 2. Each participant (about 15 minutes)

1. Give a random participant code (the screen suggests one). Never a name.
2. Confirm consent on paper, then tick it on the screen.
3. **Hand length** (protocol HL-1): two caliper readings, a third if they differ by more than 2 mm.
4. **Finger lengths** (protocol FL-1, section 2a): open *Finger lengths* and enter two readings of crease to tip, and if
   you can, knuckle to tip, for each finger.
5. **Scans:** the standard scan three times (hand repositioned between them), then the other conditions in
   `PILOT_PROTOCOL.md` section 3 if time allows. Enter the measured camera distance each time.

Aim for **at least 20 hands** for a first look and **120 participants** for the full study (`VALIDATION_PLAN.md`): with
fewer than about 20 hands the numbers describe those people, not the public.

## 3. After the sessions

* **Download:** *Download CSV* on the validation screen, or the per-finger report:

  ```bash
  cd backend
  .venv\Scripts\python scripts\validation_report.py --records <path to records.jsonl>
  ```

* **Send the records file** (`records.jsonl` and the `frames/` and `configs/` folders next to it, from the `/data` volume)
  to the developer. With it the method can be checked finger by finger, the settings compared on the same scans, and a
  calibration fitted on one half of the hands and tested on the other half (`measurement_calibration.json` is changed only
  then, and only with that held-out evidence).

## What not to do

* Do not type the app's estimate anywhere: the server computes every error from the scan itself.
* Do not change `config/` during a study: records made with another configuration are kept apart automatically.
* Do not report an accuracy figure from fewer than about 20 hands, or from scans that were retaken until they looked
  right.
