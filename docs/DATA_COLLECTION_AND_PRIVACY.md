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

* `DELETE /api/research/records/{participant_code}` deletes all of a participant's records.
* Expired records are purged on every write and at startup.
* No names, emails, IP addresses or images are stored.
* Before enabling this in production, a consent screen must be added to the frontend (not
  built: it requires the client's legal wording). Protect the endpoint with authentication.

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
