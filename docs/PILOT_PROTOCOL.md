# Pilot study protocol (HL-1): real hands, real coins, physical measurements

**Purpose.** Compare the camera's hand-length estimate with a physical measurement on 10–15
consenting volunteers, record how often scans are rejected, and check repeatability. This is
a **pilot**. Its results describe these volunteers only. They cannot establish accuracy for the
public, and they must not be used to fit or "validate" the calibration
(`config/measurement_calibration.json` stays `uncalibrated`). The full study is described in
`VALIDATION_PLAN.md`.

## 1. Before the session

* **Approval and consent.** Use a written consent form that states what is recorded: a random
  code, which hand was scanned, physical hand measurements, camera estimates and capture
  details. No images, names or contact details are stored by the app. Keep the signed forms on
  paper or in a separate system, never in the app or its notes field. Get the privacy and legal
  review in `DATA_COLLECTION_AND_PRIVACY.md` first.
* **Equipment:**
  * **hand length:** an anthropometer or a large sliding caliper (range of at least 300 mm, flat
    jaws, read to 0.5 mm or better);
  * **palm breadth (if recorded):** a sliding caliper (at least 150 mm, 0.1 mm resolution);
  * a gauge block or certified 100 mm reference to check the instruments each day;
  * fallback only, when no caliper is available: a rigid steel ruler with 1 mm graduations
    starting at its end, and a flat block. Record the tool as "ruler"; ruler references are
    lower quality and are reported separately;
  * a genuine **US quarter** (check its date side; it should be clean and not bent);
  * one test device, used for the whole pilot, and its model noted.
* **Software.** On the test computer only:

  ```bash
  cd backend
  set GLOVESIZE_VALIDATION_ENABLED=true
  set GLOVESIZE_VALIDATION_PATH=C:\pilot\records.jsonl     # outside the repository
  .venv\Scripts\python -m uvicorn glovesize.api:app --host 127.0.0.1 --port 8080
  ```

  Open `http://127.0.0.1:8080/#/validation` **on that computer**. Validation mode only answers
  local requests (see `README.md`, Security). For a phone, use the computer's browser with the
  phone as a webcam, or follow the token set-up in the README behind HTTPS.
* **Practice.** Do one practice scan and record it as **Software test** to check the set-up.
  Software tests are never counted.
* **Configuration.** Do not change `config/` during the pilot. Records made with a different
  configuration are kept separate automatically.

## 2. Physical hand length (protocol HL-1)

**Definition:** the straight-line distance from the **distal wrist crease** (the crease
closest to the palm, at the base of the palm) to the **tip of the middle finger** (the most
distal point of the fingertip pad, not the nail). This is the hand-length definition used for
glove sizing, and it is what the app compares against.

1. The participant sits with the forearm and hand resting **palm up** on a flat table. The
   wrist is straight, in line with the forearm. The fingers are straight and together, and the
   thumb is relaxed alongside.
2. **With a caliper or anthropometer (preferred):** hold the beam above the hand, parallel to the
   hand's long axis, without resting it on the hand. Put one jaw at the middle of the distal wrist
   crease and the other at the tip of the middle finger. Read to 0.5 mm or better.
3. **Ruler fallback only:** place the block against the tip of the middle finger, square to the
   table. Lay the ruler **on the table beside the hand**, not on the palm (a ruler lying on the palm
   follows its curve and reads long), with its zero end against the block. Read the position of the
   middle of the distal wrist crease looking straight down to avoid parallax, to the nearest 1 mm.
4. **Reading 2:** the participant lifts the hand, relaxes it and puts it back. Repeat steps 2–3
   without looking at reading 1.
5. If the readings differ by **more than 2 mm**
   (`validation_reference_tolerance_mm` in `config/app.json`), take a **third reading**. The app
   uses the median when it agrees with another reading within 2 mm. Otherwise the reference is
   marked "readings disagree", that participant's scans are excluded from the error statistics,
   and the operator should re-measure carefully.
6. Enter every reading with its unit (mm, cm or in). The server converts to mm, so do not convert
   by hand. A value that is implausible for the chosen unit (for example 7.25 mm) is refused.

One trained operator should measure all participants if possible. Record the operator code
(e.g. `OP1`), not a name.

## 3. Scans for each participant (about 10 minutes)

Scan the **right hand** for everyone unless that is not possible; record which hand was used.
Keep the same reference readings for every scan of that hand: the app flags a hand whose records
carry different references.

| # | Condition (select in the app) | How |
|---|---|---|
| 1–3 | Standard | Hand flat and open, palm to the camera, fingers together, quarter flat in the centre of the palm. Camera about 35–40 cm away, even indoor light. The participant lowers and repositions the hand between scans. |
| 4 | Closer | About 25–30 cm (the app refuses closer than about 25 cm) |
| 5 | Further | About 50–60 cm, hand still filling the guide |
| 6 | Coin off-centre | Quarter towards the base of the index finger, still flat on the palm |
| 7 | Different lighting | Change the room light (lamp off, window light, or dimmer) |
| 8 | Hand rotated slightly | Rotate the hand about 15–20° within the image (fingers pointing up-left or up-right) |
| 9 | Fingers slightly bent | Relax the fingers so that they curve slightly |

* Rejected scans are recorded automatically with their reasons. Do not delete them: they are the
  rejection rate. If a scan is rejected, repeat it with the same condition.
* **Measure the camera-to-palm distance** (lens to the coin) with a tape and enter it in cm for
  every scan. The report breaks errors down by this distance. The app's own coin-implied
  distance depends on an assumed field of view.
* Do not coach the participant on the result; do not show them the camera estimate before the
  physical readings are taken.

## 4. After the session

```bash
cd backend
.venv\Scripts\python -m scripts.validation_report --records C:\pilot\records.jsonl --out C:\pilot\report.md
```

The report has three separate parts:

1. real participants (this pilot);
2. synthetic software tests (pytest);
3. simulated camera experiments.

Only part 1 involves real hands. In part 1:

* **By hand** is the main unit: repeated scans of one hand are not independent people. The
  per-participant table shows each hand's standard-scan errors.
* **By camera distance:** within a band each hand counts once; bands with fewer than 3 hands are
  listed but not interpreted.
* Below 10 hands, read the individual results; below 30, the summary figures describe this
  sample only. No confidence intervals are given.
* **Repeatability** (scan to scan on the same hand) is **not** accuracy. A system can repeat the
  same wrong value.
* A condition whose shift exceeds the standard-scan repeatability coefficient suggests that the
  condition changes the estimate. With one or two hands per condition, treat it only as a hint
  for the main study.

Keep the whole validation folder with the study data, not in the repository:

* `records.jsonl`;
* `frames/`, the per-frame numbers of each scan, which can be re-measured later;
* `configs/`, the settings each record was made with;
* the report.

## 5. Remote pilot (volunteers in other places)

When volunteers cannot come to one place, each one gets a personal link, for example by
WhatsApp, and measures and scans their own hand on their own phone. The app guides them
through the same steps.

**How it differs from the in-person pilot:**

* **Self-measured references** (protocol `HL-1-self`). These are less reliable than an operator's
  readings. The report keeps them in a separate row ("Readings taken by: Participant") and never
  pools them with operator-measured results. Ask volunteers to have someone help them measure.
* **Coins by country.** The volunteer picks their coin and **measures it with the ruler**. The app
  refuses a coin whose measured size is more than 1.5 mm from its official diameter, which
  catches older coin series of the same value:
  * US quarter: 24.26 mm.
  * Indian 2-rupee coin, 2019 series: 23 mm. The older silver 2-rupee coin is 27 mm.
  * Indian 1-rupee coin, 2019 series: 20 mm. The older silver 1-rupee coin is 25 mm.

  The Indian sizes come from the Coinage Rules 2019 (G.S.R. 184(E)). Gold-coloured or two-metal
  coins (₹5, ₹10, ₹20) cannot be used. Other countries' coins can be added to
  `config/reference_objects.json` only from an official specification, silver-coloured and
  circular, with `"availability": "pilot"`.
* **Consent in the app.** The volunteer reads `config/pilot_consent.json` and ticks agreement. The
  version and a hash of the exact text are stored with each record. **Volunteer invites are
  locked until a person reviews that text** and sets `reviewed`, `reviewed_by` and
  `reviewed_at`, after removing the draft notice and filling every placeholder. Test invites
  work before that; their scans are never counted.
* **No results shown.** Volunteers see "scan saved" or "please repeat", never the camera's
  estimate or a size.
* **Withdrawal** is a button on their link. It deletes everything they submitted.

**Running it:**

1. Review and finalise `config/pilot_consent.json`.
2. Start the server on this laptop with validation mode and the remote pilot switched on (README).
3. Start the tunnel: `cloudflared tunnel --url http://127.0.0.1:8080`. It prints an
   `https://….trycloudflare.com` address.
4. On this laptop, open `http://127.0.0.1:8080/#/validation`. Under **Remote pilot invites**,
   paste the tunnel address and press **New volunteer invite**. Then **Send on WhatsApp**, to
   that one person only.
5. Follow progress in the invite table. Revoke a link that was sent to the wrong person.
6. Keep the laptop on, awake and online while volunteers take part. A quick tunnel gets a new
   address each time it starts, which breaks links already sent. Create new invites (or set up a
   named Cloudflare tunnel) if it restarts.

Operator pages are not reachable through the tunnel: tunnelled requests carry proxy headers and
are refused (README, Security). The data stays on this laptop.

## 6. What the pilot can and cannot conclude

| Can | Cannot |
|---|---|
| Show whether the camera is grossly biased for these volunteers | Establish accuracy for the general population |
| Show the rejection rate and its reasons on a real device | Validate or fit the calibration |
| Show scan-to-scan repeatability and gross condition effects | Justify any accuracy claim to customers |
| Find practical problems (lighting, coin, posture, instructions) | Replace the held-out study in `VALIDATION_PLAN.md` |
