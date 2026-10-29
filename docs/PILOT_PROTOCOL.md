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
  * Indian 1-rupee coin, 2019 series: 20 mm. The older silver 1-rupee coin is 25 mm (pilot only).
  * Sri Lankan 5-rupee coin, 2017 series: 23.5 mm, stainless steel. The older 5-rupee coin is
    the same size but gold-coloured, which the detector rejects.

  The Indian sizes come from the Coinage Rules 2019 (G.S.R. 184(E)) and the Sri Lankan size from
  the Central Bank of Sri Lanka's coin specifications. Gold-coloured or two-metal coins (₹5, ₹10,
  ₹20) and coins with lobed edges (Sri Lankan Rs 10 and Rs 20) cannot be used.

  The US quarter, the Indian 2-rupee coin and the Sri Lankan 5-rupee coin are also offered to
  customers. For the 2-rupee coin, customers must tick that they checked the 23 mm size
  (`"size_check": true`), and the server refuses scans without that confirmation. Other countries'
  coins can be added to `config/reference_objects.json` only from an official specification,
  silver-coloured and round. None of these coins has been tested on real scans yet.
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

## 7. Multi-view additions (draft; cannot be run yet)

**Status: draft, not runnable.** Do not send any invitation that asks for the back or side view
until all of these are cleared:

1. **The pilot screens must be changed.** The validation screen and the remote pilot link scan the
   **palm only** today. The guided back and side views are in the customer flow. See
   `VALIDATION_PLAN.md` §7.6 (TODO list).
2. **The consent text must be amended and reviewed.** `config/pilot_consent.json` has
   `"reviewed": false` today, and its draft text describes about nine palm scans only. Nothing
   here is reviewed or approved (§7.3).
3. **The record must be able to hold the extra data** (§7.4).

The study design, the reference measurements and the analysis plan are in `VALIDATION_PLAN.md`
§7. This section covers only what changes for volunteers. Operator-led sessions take the caliper
thickness reading (HT-1) as described in `VALIDATION_PLAN.md` §7.2.

### 7.1 What a volunteer does in addition

A complete scan is three views, each with the coin on the hand. The app shows the same wording.
The numbers only leave the phone; no photos or video.

* **Palm:** unchanged (§3, standard condition).
* **Back of the hand:** turn the hand over and rest it flat on the table, fingers slightly
  spread. Put the coin flat in the middle of the back of the hand, between the wrist and the
  knuckles. Hold the phone level above the hand at the usual distance and keep still. The app says
  "Hold your phone level, parallel to the back of your hand" if it is not.
* **Side of the hand:** turn the hand on its edge, thumb side up, with the coin resting flat on the
  side of the hand, facing the camera. Hold still. This view is awkward, so a helper can steady
  the phone. If the coin cannot rest flat, write a note and do not force it.
* The side view is **not used for any result today** and the volunteer sees no estimate or size
  (§5). It is collected so that a method can be developed later. Tell volunteers so.
* **What is optional and what is not.** Hand length (`HL-1-self`, §5) stays required. Whether the
  extra views are required in the pilot, and the number of complete scans, are to be fixed when the
  pilot screens are changed. The thickness reading below is **optional**.

### 7.2 Optional: hand thickness, if the volunteer has a tool

Only for a volunteer who has **spreading or sliding calipers** (record the tool as "calipers"),
with a helper if possible. The thickness is the distance between the skin over the knuckle at the
base of the middle finger and the skin directly opposite on the palm side, with the tips just
touching, not pressing (definition HT-1 in `VALIDATION_PLAN.md` §7.2). Take **three readings**,
lifting and replacing the hand between them, and enter each with its unit.

A volunteer with only a ruler can measure the height of that knuckle above the table with the hand
resting palm down, using a flat block laid across the knuckle and a ruler held upright beside it.
The palm may flatten against the table and read lower than a caliper does, so such readings are
recorded as the ruler tool, reported separately and never pooled with caliper readings, as for
`HL-1-self`. If the volunteer has no tool, skip this step: nothing else depends on it.

### 7.3 Consent: what must change before an invitation is sent

The current draft text says the volunteer will scan the hand "about nine times in slightly
different ways", and describes what is recorded as the positions of 21 hand points, the coin's
size and position and image brightness. Before multi-view invites, the study owner must amend and
review it so that it states:

* the three views, where the coin is placed in each, and the new time estimate;
* that each set of numbers is stored with the view it came from;
* the optional thickness readings, if the volunteer gives any;
* that the side view is not used for any result at present;
* that no photos or video are stored (true only while this pilot stays numbers-only; an image
  study needs its own research consent, `DATA_COLLECTION_AND_PRIVACY.md`).

Placeholders (retention date, contact) must still be filled. A new `version` is needed, so that
records made under the old text stay distinguishable (the version and a hash of the text are
stored with each record). The privacy and legal review must cover the added views; do not assume
the earlier review does.

### 7.4 Data fields

| Field | Status today |
|---|---|
| `view` tag on each frame | Part of the multi-view scan change; stored with the frames when present |
| Per-view frames and `view_agreement` | Computed by the server per scan; recomputable from the stored frames; not separate record fields |
| `thickness_readings` (each with its unit), `thickness_reference_mm`, `thickness_tool` | **Not stored yet**: proposed names, a future code change (`VALIDATION_PLAN.md` §7.6) |

Until those fields exist, write thickness readings on the paper sheet with the participant code,
not in the notes field of the app (§1).

### 7.5 What these additions can and cannot conclude

| Can | Cannot |
|---|---|
| Show whether the palm and back views agree on hand length for these volunteers | Validate any thickness or circumference method (numbers only; no silhouette) |
| Show how often volunteers can place the coin on the back and side, and how often those scans fail | Show that the extra views improve accuracy |
| Collect side-view landmark and coin numbers for later work | Justify any accuracy claim to customers, or use the side view for sizing |
