# Flat-hand-on-paper method: experimental evaluation

**Status: experimental, evaluated on synthetic images only.** The customer-facing app still
uses only the coin-on-palm method. Neither method has been compared with physical hand
measurements, so this document makes **no accuracy claim** for either. Figures below come from
synthetic renderings and describe geometry only. Published results for other paper-based
systems (for example HandAnthro, arXiv:2609.37855) used a different capture protocol, landmark
model and population. They are **not** transferred to this implementation. No third-party
dataset, model or research code was downloaded or used.

## 1. What was built

An isolated package, `backend/experimental/paper_method/`, with its own config (`config.json`).
It is not imported by `glovesize/`, the API or `config/`, and a test enforces this.

| Step | Implementation |
|---|---|
| Paper boundary | Bright, low-saturation region; then 120 sub-pixel samples per edge along the edge normal and a robust line fit. Corners are line intersections, so a wrist or forearm covering part of an edge does not move them. A quadratic fit to each edge measures bending (lens distortion or a curled sheet). |
| Perspective rectification | Plane-to-plane homography from the four corners to the sheet's millimetre size. Exact for any camera tilt for points on the sheet (pinhole model). |
| Metric scale | Known sheet size selected by the customer: A4 (210 × 297 mm) or US Letter (215.9 × 279.4 mm). The sheet's true aspect ratio is recovered from the image (focal length from the rectangle's vanishing points). A wrong selection is rejected: A4 and Letter differ by 9% in aspect. |
| Camera pose | Focal length, camera height and the point below the camera, from the homography. When the view is frontal, or tilted about an axis parallel to a sheet edge, the focal length is not observable; a 55–80° field-of-view prior then brackets the camera height. |
| Hand segmentation | The rectified sheet's signed warm-chroma channel (reused from the coin detector) with an Otsu threshold. Skin of any tone is warm; white paper and grey shadows are neutral, so shadows are not segmented as hand. |
| Anatomical endpoints | From the hand's outline (skin edges), not joint centres. See section 2. |
| Height adjustment | The outline lies 5–20 mm above the sheet and is seen displaced away from the point below the camera. The outline points are moved back using the recovered camera position and assumed outline heights (5 mm fingertip, 12 mm palm edge). This is an assumption-based adjustment, like the coin method's depth model. |
| Checks | Paper not found or cut off; edges unclear or curved; wrong paper size; hand not crossing an edge; hand within 4 mm of another edge; hand axis rotated > 10°; breadth/length > 0.52 (thumb probably against the palm). |
| Tools | `python -m scripts.paper_measure photo.jpg --paper a4 [--mediapipe]` (local, stores nothing). `python -m scripts.paper_method_study` writes `docs/PAPER_METHOD_STUDY.md`. |

**Not built: a customer-facing capture screen.** The pipeline runs in Python on an image file.
Offering it in the browser would need an OpenCV.js port (as was done for the coin detector).
The image must stay on the customer's device: uploading photos would break the app's privacy
design. That port is worth doing only if the comparison pilot favours this method.

## 2. Measurement definitions (paper method)

| Measurement | Start | End | How | Physical or estimate |
|---|---|---|---|---|
| Hand length | Wrist crease. **Protocol:** the customer places the crease on the sheet edge, so the start is a physical line. | Most distal point of the outline (middle fingertip skin) | Distance from the edge line to the tip, sub-pixel | Physical on the sheet plane, plus the height adjustment. **The crease placement is not visible in the image.** |
| Hand breadth (metacarpal) | Radial skin edge of the palm | Ulnar skin edge | Widest outline chord perpendicular to the hand axis within ±2 mm of the metacarpal level | Skin edges: physical. The level comes from MediaPipe's MCP landmarks (5, 17) if available, otherwise 0.57 × hand length (a heuristic). |
| Hand circumference | n/a | n/a | Not measurable: a top view shows neither thickness nor cross-section | Tape entry or a validated model only |

MediaPipe is used only to locate the metacarpal level. Its landmarks are joint centres and would
give neither skin endpoint.

## 3. Geometric assumptions compared

| | Coin on palm (production) | Hand flat on paper (experimental) |
|---|---|---|
| Scale reference | 24.26 mm coin, roughly 50–120 px across | Whole sheet, about 700–1000 px across in the simulated 1600 × 1200 image |
| Reference localisation | 0.5 px edge uncertainty ≈ 0.5–1% of scale | Sub-pixel corners over a long baseline: about 0.05% |
| Reference size tolerance | Mint diameter, about 0.2% | ISO 216 allowance up to ±2 mm (≤ 0.7%), usually far less; one sheet's error is systematic for that sheet |
| Perspective and tilt | Coin ellipse; tilt not rectified (perspective-biased); gated at 12° | Full homography: exact on the sheet plane at any tilt |
| Hand pose | Held in the air: palm tilt, finger curl and flatness are uncontrolled and gated | Flat on a surface: planar, fingers extended, posture repeatable |
| Depth offsets | Coin top 1.75 mm above the skin; joints about 10 mm below it (assumed). Raw bias about −3% (simulation). | Outline 5–20 mm above the sheet (assumed). Raw breadth reads +2–5% wide, length −0.7 to +1.3% (simulation). |
| Endpoints | MediaPipe joint centres; offset to skin points is unknown (prior 0 ± 5 mm) | Skin outline (tip, palm edges); wrist defined by placing the crease on the sheet edge (assumed 0 ± 3 mm) |
| Measurements | Hand length (and joint-centre spans) | Hand length and true skin-to-skin breadth |
| Camera intrinsics | Unknown; field-of-view prior | Often recoverable from the sheet when the view is oblique; prior otherwise |
| Lens distortion | Not observable | Detected (edge curvature) and rejected above 0.6 mm |
| Frames | Live video, 24 frames, real-time guidance | One still image (several can be taken) |

## 4. Synthetic results (geometry only)

Full table: `docs/PAPER_METHOD_STUDY.md`. Coin method: `docs/CALIBRATION_STUDY.md`. The two
studies use different simulated hands and are not an accuracy comparison. Main observations:

* **The sheet geometry is not the limiting factor.** Corners are recovered within 0.6 px. The
  homography is exact to rounding error, and a wrong paper size or strong lens distortion is
  rejected.
* **Hand thickness is the main geometric bias.** Raw breadth read 1.7–4.5 mm (2.1–5.3%) wide in
  the scenarios. When the assumed outline heights matched the rendered hand, the adjustment
  left ≤ 0.4 mm. When they did not (a thin or thick hand), it left −1.1 to +1.6 mm. Real outline
  heights are unknown and vary between people.
* **Hand length is less affected by thickness** (raw −1.3 to +2.5 mm, depending on where the
  camera is; within ±0.4 mm after adjustment). It is **fully exposed to wrist-crease placement**: a
  3 mm misplacement gives a 3 mm error, which nothing in the image can detect.
* **A thumb held against the palm** inflated breadth by about 20 mm. It is only flagged by a
  plausibility ratio, not detected directly.

## 5. Expected advantages and disadvantages

**Advantages (expected, not shown on real hands):**

* An exact perspective correction for the reference plane. A large, precisely localised scale
  reference. Lens distortion is detectable.
* A flat, repeatable hand posture removes the coin method's palm tilt, finger curl and "hand in
  the air" variability.
* Skin-edge endpoints for the fingertip and palm edges, matching anthropometric definitions
  better than joint centres.
* Measures **hand breadth**, which the coin method cannot measure from skin to skin.
* Paper is available worldwide in two standard sizes, which avoids the coin-series problem.

**Disadvantages and risks:**

* Hand length depends on the customer placing the wrist crease on the sheet edge. This is a
  manual alignment with an unknown real-world error, likely several millimetres.
* An outline-height assumption is needed for breadth (and slightly for length), just as the coin
  method needs a joint-depth assumption.
* It needs a white sheet on a **contrasting** surface: a white table defeats paper detection.
* Most people need **both hands**: one flat on the sheet, one holding the phone directly above.
  Self-capture works, but the hand being measured may move.
* A single still image gives no real-time feedback on retakes unless a live preview is added.
* Thumb position, fingers spread or together, rings, sleeves and nail length all change the
  outline. Long fingernails would lengthen "hand length" unless they are segmented out.
* Image processing currently happens off the phone (Python). A browser port is needed for the
  privacy-preserving customer flow.

## 6. Customer usability (to be measured, not assumed)

| Aspect | Coin on palm | Paper |
|---|---|---|
| Items needed | One specific coin | One A4/Letter sheet and a dark, contrasting surface |
| Steps | Hold the hand up and keep it steady; live guide | Place the sheet, align the wrist crease, flatten the hand, spread the thumb, photograph from above |
| Likely failure points | Coin tilt or glare, hand tilt, distance | Wrist alignment, thumb, sheet on a white table, sheet not fully in frame |
| Remote self-capture | Possible with a propped phone | Possible (the free hand holds the phone) |

## 7. Remaining unknowns

1. How accurately customers place the wrist crease on the sheet edge (the dominant
   hand-length term).
2. Real outline heights at the fingertip and palm edge across hand sizes and body types.
3. Segmentation of real skin, nails, jewellery, tattoos and sleeves on real paper, under real
   light, from real phone cameras (auto exposure, HDR, JPEG compression).
4. How flat real sheets lie (curled or creased paper) and how well customers keep the phone
   above the sheet.
5. Whether the heuristic metacarpal level (without MediaPipe) is adequate.
6. Real-world accuracy and repeatability of **both** methods against physical measurements.

## 8. Recommended controlled comparison pilot

The full, study-ready protocol is **`docs/COMPARISON_STUDY_PROTOCOL.md`**, with its consent and
data-protection review in `docs/CONSENT_REVIEW.md`.

**Correction to an earlier draft of this section.** It estimated about 32 participants by
assuming an SD of 2 mm for the paired difference. That figure was not derived from the method
error assumptions. With method error SDs of 3–6 mm, the simulated SD of the paired difference in
absolute error is 2.7–5.2 mm. Detecting a 1.5 mm difference then needs about 28–96 participants,
and a 1.0 mm difference about 59–214 (protocol, section 9). The feasibility phase replaces these
planning assumptions with estimates.

Neither method is validated until this, and then the larger held-out study in
`VALIDATION_PLAN.md`, has been done. Both stay experimental until then.
