# Data collection and privacy

## Default customer flow: no images leave the device

* Camera frames are processed in the browser (MediaPipe WASM + OpenCV.js) and are never
  uploaded, stored or logged.
* `/api/scan` accepts only numeric observations: 21 landmark coordinates, the coin ellipse and
  its quality metrics, brightness, and optional non-identifying capture context (device class,
  camera facing). The API schemas reject unknown fields, so an `image` field is refused with
  HTTP 422.
* The server keeps nothing from a scan. Logs contain only frame counts and issue codes.
  Validation errors never echo submitted values.
* MediaPipe's WASM, the model file and OpenCV.js are served from the application's own origin,
  so no third-party CDN is involved at runtime.
* The browser stores only two conveniences, both in `localStorage`: the chosen reference
  object and the chosen product.

## Optional research records (disabled by default)

Enable with `research_collection_enabled: true` in `config/app.json`, or
`GLOVESIZE_RESEARCH_ENABLED=true`.

`POST /api/research/records` stores one JSON line per record in
`data/research/records.jsonl` (override with `GLOVESIZE_RESEARCH_PATH`). A record contains:

| Field | Content |
|---|---|
| `participant_code` | Random, non-identifying code of 6–40 characters (`@` is rejected). The participant keeps it to request deletion. |
| `consent` | Version, timestamp, `measurements: true` (required), `images: false` (images are never accepted), `retention_days` (≤ the configured maximum) |
| `estimated_measurements` | Camera estimates with their uncertainties |
| `reference_measurements` | Tape or caliper values, with who measured them and the tool used |
| `capture`, `reference_object_id`, `chart_id`, `recommended_size`, `fit_outcome` | Capture conditions and outcome |

* `DELETE /api/research/records/{participant_code}` deletes all of a participant's records. It
  is an operator action and stays available when collection is switched off.
* Expired records are purged on every write and at startup.
* No names, emails, IP addresses or images are stored.
* Both endpoints are operator-only: they answer local requests only, or requests carrying the
  operator token when `GLOVESIZE_OPERATOR_TOKEN` is set (README, Security). Before collecting
  from customers in production, a consent screen must be added to the frontend (not built: it
  requires the client's legal wording), together with a proper login.

## Pilot validation records (validation mode, disabled by default)

The pilot (`PILOT_PROTOCOL.md`) stores one JSON line per scan in the file named by
`GLOVESIZE_VALIDATION_PATH` (default `data/validation/records.jsonl`, which git ignores).

* **Stored:**
  * a random participant code (`@` refused) and the hand scanned (left or right);
  * physical readings and their unit, and camera estimates with errors;
  * scan status and reasons, coin and calibration figures, and the image size;
  * device, lighting, distance, the operator code and free-text notes.
* **Also stored, per scan (`frames/<record id>.json`):** the numeric per-frame observations
  the browser sent, so that pilot scans can be re-measured with a changed configuration. This
  covers the 21 hand-landmark coordinates (image and MediaPipe world coordinates), the coin
  ellipse and its quality metrics, brightness and the image size. These coordinates describe the
  geometry of the participant's hand: treat them as personal data under the consent form. Turn
  this off with `validation_store_frame_data: false` in `config/app.json`.
* **Configuration versions (`configs/<fingerprint>.json`):** the measurement settings each record
  was made with. These contain no participant data.
* **Not stored:** images, names, contact details, birth dates or IP addresses. The request models
  have no image field and refuse unknown fields, so validation mode cannot store images. The
  notes field is labelled "no personal details"; operators must keep to that.
* **Consent:** the operator confirms consent for each real-participant record. The signed form
  is kept outside the app. The app keeps no link between the code and the person; if the study
  needs that link (for withdrawal), keep it on paper with the consent form.
* **Remote pilot:** volunteers consent in the app to the text in `config/pilot_consent.json`.
  Each record stores the consent version, a hash of the exact text and the time. Invites
  (`pilot_invites.json`) store the participant code, progress and the volunteer's enrolment (which
  hand, ruler readings, coin and its measured size, phone model). The invite token is stored only
  as a hash. Data reaches this laptop through the tunnel, and the app stores it nowhere else. Cloudflare
  ends the HTTPS connection at its servers and passes the requests on to this laptop, so it
  handles the data in transit. Name Cloudflare as a processor in the consent text, or use a
  different hosting route if that is not acceptable. Volunteers can withdraw from their link,
  which deletes their records and frames.
* **Withdrawal:** delete the participant's records on the validation screen (Delete on each row).
  This also deletes their frame files.
* **Retention:** no automatic expiry. Delete the folder (records file, `frames/`, `configs/`)
  when the pilot analysis is complete, or move it to the study's controlled storage.

## Research images (validation study only)

Images are collected only in **supervised studies with signed informed consent** that covers:

* purpose;
* storage location and access;
* the retention period;
* withdrawal and deletion.

They are copied from the capture device to encrypted storage under `dataset/captures/` and keyed
by participant code, never by name. They are processed offline by
`validation/extract_from_images.py` and never through the public web app. Hands can carry
identifying features (tattoos, scars, jewellery), so treat these images as personal data.

## Client inputs required

Privacy policy wording, consent text, the retention period, the data controller and processor
arrangements, and the applicable US state privacy laws (e.g. CCPA/CPRA, and BIPA if hand
geometry could be considered a biometric identifier) must be confirmed by the client's counsel
before any data collection.
