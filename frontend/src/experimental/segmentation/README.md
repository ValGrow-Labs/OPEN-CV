# Experimental hand segmentation

**EXPERIMENTAL. Not used by the customer flow, the live scan, the coin pipeline, the calibration or the sizing.**
It adds no production setting and changes none. Every threshold is provisional and unvalidated. Nothing here is a
measurement of a person: see "What is and is not established" at the end.

Goal: from an ordinary smartphone RGB picture, find the **whole hand silhouette** (palm, all five fingers, fingertips,
the gaps between fingers, the wrist boundary), not just the hull of the 21 MediaPipe landmarks. The landmarks only
**seed** the segmentation (where the hand certainly is and is not); they are never returned as the mask.

## Use

```ts
import { segmentHand } from "./segmentation";
import { loadOpenCV } from "../../vision/opencv";

const cv = await loadOpenCV();
const r = await segmentHand(imageData, landmarksInImagePixels, { backend: "grabcut", cv });
if (!r.ok) console.log("unusable:", r.reasons); // never silent: no_hand, hand_incomplete, hand_blurred, hand_occluded,
                                                // fingers_merged, mask_implausible, segmentation_failed
r.mask;          // BinaryMask at the working size (longest side 512 px by default); r.scaleToSource = source px per working px
r.contour;       // outer contour, SOURCE pixels, simplified to ~0.7 working px
r.areaPx;        // projected hand area, SOURCE px^2 (mask pixel count / scale^2); r.areaPolygonPx from the contour
r.fingertips;    // thumb..pinky tip in source px (null = not recovered)
r.wristLine;     // the two ends of the wrist cut (source px); r.wristWidthPx
r.gapsPreserved; // thumb-index, index-middle, middle-ring, ring-pinky: is the gap open in the mask
r.quality;       // the numbers behind the gates; r.timingMs per stage
```

`frame` is anything shaped `{ width, height, data: Uint8ClampedArray }` (a DOM `ImageData` fits). Landmarks are the
21 points in the frame's pixels (the app's `HandTracker` gives them for video; `createStillHandDetector()` for a still).
Backends: `"grabcut"` (needs `options.cv`), `"interactive"` (needs `options.interactiveSegmenter` from
`createInteractiveSegmenter()`), `"skin"` (pure TypeScript, the naive baseline).

Pure helpers for the evaluation, in `metrics.ts`: `iou`, `dice`, `maskArea`, `maskToContour` (crack tracing: the polygon
area equals the pixel count), `contourArea`, `simplifyPolygon`, `polygonToMask`, `boundaryDistance` (symmetric mean,
95th percentile and maximum, in pixels), `resizeMaskNearest`. `synthetic.ts` makes a **synthetic** parametric hand with
its exact truth for tests only.

## Stage 2a: `analyseHand` (part labels, finger gaps, confidence, boundary metrics, gates)

Board-independent: it needs one RGB picture and the 21 landmarks, nothing printed. **EXPERIMENTAL**, same rules as above.

```ts
import { analyseHand } from "./segmentation";
const a = await analyseHand(imageData, landmarksInImagePixels, { backend: "grabcut", cv });
a.gates;            // { ok, reasons: [{ code, message, part? }] }: code is one of no_hand, segmentation_failed, blurred,
                    // incomplete, occluded, fingers_merged, implausible, low_confidence; the message holds the measured number
a.mask;             // BinaryMask at the working size (a.scaleToSource = source px per working px). NOT carved by the landmarks
a.labels;           // Uint8Array per working pixel: 0 background, 1 palm, 2 wrist, 3 thumb, 4 index, 5 middle, 6 ring, 7 little
a.parts.fingers;    // per digit: present, areaPx, outline, tip, tipToLandmarkPw, maskLengthPx, landmarkLengthPx, lengthRatio,
                    // touchesBorder, widths (9 stations: widthPx + what ended each side: "mask" | "part" | "image"),
                    // medianWidthPx, neck, bulge, colourBreak            (all lengths in SOURCE pixels)
a.parts.areaPx;     // per part, SOURCE px^2
a.gaps;             // thumb-index .. ring-little: status open/enclosed/closed/unknown, expected (landmarks show them apart),
                    // merged, openAreaPx, enclosedAreaPx, depthPx, referenceDepthPx, depthRatio, valley, widths at
                    // 0.05/0.1/0.2/0.3/0.5 palm widths from the valley
a.gapMap;           // per working pixel: 1-4 open gap of pair 0-3, 5-8 enclosed background of pair 0-3
a.confidence;       // { map: Float32Array 0..1 per working pixel, summary: meanHand, meanBoundaryBand, lowShareHand, lowShareBand,
                    //   colourAgreementBand, edgeSupportBoundary, perPart, colourModel: "grabcut" | "fitted" }
a.boundaryMetrics;  // no ground truth needed: roughness, grey/colour contrast across the edge, gradient agreement, fingertip consistency
a.segmentation;     // the underlying segmentHand result (contour, wrist line, legacy quality numbers and reasons)
a.timings;          // ms per stage: segment, parts, gaps, confidence, boundary, gates, total
```

Backends: everything `segmentHand` takes, plus `"external"` with `externalMask` (any size): a mask from another segmenter (for
example SAM 2 run offline) goes through the same wrist cut, clean-up, analysis and gates, so segmenters are judged by one yardstick.
With ground truth (evaluation only): `compareToTruth({ mask, labels, gaps }, truthMask, landmarksWorkingPx, { truthParts? })` gives
IoU, Dice, boundary distance, per-part IoU, gap recall and precision, and says which part truth it used (`partTruth`).

### How it works and its conventions

* **Part labels** (`parts.ts`): the landmarks give a skeleton of segments, each owned by one part. Each mask pixel takes the part of
  the segment it is closest to **along a path inside the mask** (multi-source Dijkstra, 8-neighbour), so a label never jumps across a
  gap. The landmarks only say which part a hand pixel belongs to; which pixels are hand is the mask's decision.
  * a finger begins at its **knuckle line** (through the MCP landmark, perpendicular to the proximal phalanx): a palm "stub" ends at
    each knuckle along the finger's axis, which puts the palm/finger border there. The web skin above the knuckle line is split
    between the two neighbouring fingers. This is not the palmar crease (anthropometric finger length often starts there);
  * the thumb begins at landmark 2 (perpendicular to 2-3); the thumb metacarpal is palm;
  * wrist = palm pixels within 0.2 palm widths of the wrist cut (the existing cut through landmark 0);
  * fingertip = the finger-labelled mask pixel farthest along the landmark polyline continued past the tip (never landmark 4/8/...);
  * widths are measured perpendicular to the axis; each side says whether it ended on the mask outline (`"mask"`) or on another
    part's label (`"part"`: a label border, not a real edge, e.g. fingers held together or the web). Downstream measurement must
    use only `"mask"`-bounded widths.
* **Finger gaps** (`fingerGaps.ts`): the background inside the polygon bounded by the two finger axes up to the height of the less
  advanced mask fingertip. Connected to the outside = **open** gap (depth to its valley point, widths); background surrounded by
  hand = **enclosed**; none = **closed**. **Merged** = the landmarks show the two digits apart (existing valley rule) and the mask has
  no open gap, or one shallower than 0.35 of the reference depth, or enclosed background between them (a bridge). The mask is never
  carved (the old `carveGaps` stays available but is off in `analyseHand`).
* **Confidence** (`confidence.ts`): `colour * (dist + (1 - dist) * edge)`. colour = logistic of the hand/background colour
  log-likelihood ratio, signed by the label (GrabCut's own final mixtures with the GrabCut backend, otherwise mixtures fitted to both
  sides of the boundary); dist = distance to the boundary saturating at 0.06 palm widths; edge = image gradient along the nearby
  boundary (low under blur and low contrast). The forearm side of the wrist cut is ignored (the cut is a convention, not an edge).
  **A heuristic score for ranking and gating, not a calibrated probability.**
* **Boundary metrics** (`boundary.ts`): roughness (contour vs its smoothed copy), grey/colour contrast across the edge, share of
  boundary samples whose strongest gradient lies within 1.5 px of the mask edge, gradient/normal alignment, every fingertip landmark
  on the mask and within 0.3 palm widths of its mask tip.
* **Gates** (`analyse.ts`, every rejection names its reason; thresholds in `constants.ts`, all provisional):
  | code | fires when |
  |---|---|
  | `incomplete` | mask pixels on the image edge; a fingertip landmark outside the frame; a finger's label touching the border |
  | `blurred` | median edge width above 6 working px (existing measure) |
  | `occluded` | a finger missing (< 25 % of the area its landmarks imply) or reaching < 70 % of its landmark length; a neck (< 0.65 of its median width) or bulge (> 1.6) between 20 and 80 % of its length; a cross-band (10-60 % of its length) more than half not hand-coloured (rg chromaticity); its tip landmark off the mask; skeleton seed colours inconsistent; landmarks off the mask |
  | `fingers_merged` | see "Merged" above, naming the pair |
  | `implausible` | mask/landmark-hull area outside 0.85-2.4; > 25 % of the raw mask in stray pieces; > 2 % of the mask unreachable from the skeleton |
  | `low_confidence` | mean boundary-band confidence < 0.45, or > 30 % of hand pixels below 0.5 |

### Results (data sources stated per table; NONE of this is real-world accuracy)

Tests: `analyse.test.ts` (24 tests, **synthetic** parametric hands with exact mask and part truth from `synthetic.ts`): per-part IoU
above 0.85 for every digit at three orientations, geodesic labelling, tips, widths (= the generator's 2 x 0.115 palm widths within
2 px), gap states, every gate including bars over a finger, a painted-out finger, a border cut, blur, a skin-coloured bridge, a grown
mask; plus GrabCut in Node.

The composite evaluation is `composite.eval.test.ts`, opt-in (skipped unless `SEG_COMPOSITE_DIRS` and `SEG_LANDMARKS` point to the
scenes; see its header). Run on 2026-11-08 in Node with the bundled OpenCV.js, working size 512.

**Table 1. COMPOSITE scenes (one real hand photo matted onto synthetic backgrounds, recoloured skin, lighting, blur, rotation,
mirror, distance; truth = the matte cut at the wrist).** 28 scenes, 26 with MediaPipe landmarks (none found on the skin-coloured
table and wood stripes: `no_hand`). Pixels are working pixels (source = 2.5 x). Per-part IoU here uses the labeller applied to the
truth mask with the same landmarks (`partTruth: "labeller-on-truth-mask"`), so it shows how mask errors spread into parts, **not**
whether the labelling itself is right (that is only tested on synthetic hands). Gap recall = open gaps of the truth mask also open
in the result.

| backend (prompt) | IoU mean / median / min | Dice | boundary mean / p95 (medians) | accepted | accepted with IoU < 0.9 | per-part IoU palm / wrist / thumb / index / middle / ring / little | gap recall |
|---|---|---|---|---|---|---|---|
| GrabCut + landmark seeds | 0.947 / 0.955 / 0.759 | 0.972 | 1.1 / 2.2 px | 22 / 26 | 0 | 0.99 / 0.96 / 0.95 / 0.94 / 0.92 / 0.89 / 0.91 | 0.93 |
| SAM 2 tiny (box + 21 landmark points) | 0.943 / 0.943 / 0.892 | 0.971 | 1.9 / 1.4 px | 25 / 26 | 0 | 0.94 / 0.98 / 0.94 / 0.94 / 0.94 / 0.95 / 0.95 | 1.00 |
| SAM 2 tiny (+ 3 negative points between spread fingertips) | 0.933 / 0.935 / 0.885 | 0.965 | 2.1 / 2.0 px | 26 / 26 | 1 (blur sigma 9, IoU 0.885) | 0.93 / 0.97 / 0.93 / 0.93 / 0.93 / 0.93 / 0.94 | 1.00 |

GrabCut gate outcomes on Table 1 (same source): accepted 22 scenes with IoU 0.945-0.990 (every background where landmarks were
found, all six skin-tone scenes, four lightings, JPEG q25, four rotations, the mirror). Rejected: blur sigma 4 (IoU 0.908, p95 19.7 px:
`fingers_merged` ring-little), blur sigma 9 (0.759: `blurred`, `fingers_merged`, `low_confidence`, ...), hand at 60 % size (0.870:
`fingers_merged`), at 40 % (0.795: `fingers_merged` x3). The stage-1 gates had accepted both small-hand cases (false accepts); the gap
analysis now rejects them. Compared with stage 1 (mean IoU 0.952, browser, gap carving on), this run has carving off and runs in
Node; the numbers are close but not identical.

**Table 2. Derived COMPOSITE cases (made from the stone-background composite with its landmarks; truth = the matte minus any painted
object).**

| case | GrabCut | SAM 2 tiny (box + points) |
|---|---|---|
| grey bar over the middle finger's middle phalanx | IoU 0.952, **rejected** `occluded`: middle narrows to 57 % of its width at 54 % of its length | 0.895, **rejected** `occluded`: middle reaches 56 % of its landmark length, tip landmark off the mask |
| blue bar over the ring finger (GrabCut took the bar into the hand: the forced bone seeds put blue into its colour model) | 0.933, **rejected** `occluded`: 64 % of the ring's band at 60 % not hand-coloured | 0.900, **rejected** `occluded` + `fingers_merged` |
| skin-coloured bridge filling the middle-ring gap | 0.938, **rejected** `fingers_merged` middle-ring (open gap 30 % of expected depth) | 0.943, **accepted** (SAM left the bridge out, correctly: the truth excludes it) |
| top rows removed at the middle DIP (fingertips out of frame) | 0.959, **rejected** `incomplete` (border pixels; index, middle, ring tips outside) | 0.963, **rejected** `incomplete` |

Mean boundary-band confidence on Table 1 (GrabCut): median 0.82, 0.41 on blur sigma 9; edge support falls from ~1.0 on sharp scenes
to 0.58 / 0.30 under blur sigma 4 / 9. **The thresholds of the new gates (neck 0.65, merged depth 0.35, colour band 10-60 %) were set
by looking at these same scenes: there is no held-out set, so the gate behaviour above is in-sample and optimistic.** Clean spread
ring-little gaps gave depth ratios down to 0.37 (JPEG q25) against 0.30 for the bridge: a narrow margin.

**Latency (desktop, NOT a phone).** `analyseHand` with GrabCut in Node, medians over Table 1: total 654 ms (segment 516, parts 37,
gaps 7, confidence 72, boundary 18). SAM 2 tiny in Python/PyTorch on a 10-thread desktop CPU: image encoder 1.79 s, prompt decoder
0.07 s per prompt. **No phone was measured.**

### Architecture comparison

| | GrabCut + landmarks (current) | MediaPipe interactive segmenter (`magic_touch`) | MobileSAM | SAM 2 tiny (`sam2-hiera-tiny`) |
|---|---|---|---|---|
| Licence (see `docs/hand3d-research/LICENSING.md`) | OpenCV Apache-2.0 (rows for `@techstark/opencv-js` and the bundled `opencv.js`, whose optional modules are UNVERIFIED); GrabCut patent US7660463B2 shown expired (CONSOLIDATED_FINDINGS section 7; other patents not searched) | model card: Apache-2.0 (LICENSING section 2); training data UNVERIFIED | code Apache-2.0, weights `dhkim2810/MobileSAM` tagged MIT (LICENSING section 3; tag re-read 2026-11-08) | code Apache-2.0, weights `facebook/sam2-hiera-tiny` tagged apache-2.0 (LICENSING section 3; tag re-read 2026-11-08) |
| Model size | no model (the OpenCV.js already shipped) | 6.2 MB tflite | 40.7 MB PyTorch checkpoint (`mobile_sam.pt`, size from the Hugging Face listing) | 155.8 MB fp32 safetensors; 31.4 M parameters load into the image model |
| Run here | yes (Node, Tables 1-2) | stage 1 only (browser): mean IoU 0.832, fills finger gaps, picked the wrong object at 30 and 250 degrees | **not run**: only a raw PyTorch checkpoint; running it needs the MobileSAM repository code plus `timm` (not installed) or a third-party ONNX export of unverified provenance; not added | yes: Python, already-installed `transformers` 5.14.1 + `torch` 2.11 (CPU), offline, masks scored through `backend: "external"` |
| Composite result | Table 1-2 | stage-1 table above | none | Table 1-2: equal mean IoU, much better on small/blurred hands (60 %: 0.969 vs 0.870; 40 %: 0.954 vs 0.795), worse palm because it drops the synthetic coin on the palm (which the truth matte keeps); with negative gap prompts it got slightly worse |
| Phone feasibility (expected, unmeasured) | per-capture step, ~0.5 s desktop Node / 2.2 s desktop Chrome at 512 px; worker needed | runs in the MediaPipe web runtime (1.3 s CPU delegate in desktop Chrome) | the most plausible SAM for a phone by size; needs an ONNX/tflite export and a web runtime not in the repo | heavy: 156 MB download, 1.8 s encoder on a desktop CPU; would need quantisation and WebGPU/ONNX runtime (a new dependency); server-side or offline labelling aid more realistic |
| Trained on own data? | no training; but every number above is composite, so a labelled real set is needed to know its accuracy | no | no (promptable) | no (promptable) |

Conclusion (composite evidence only): keep GrabCut + landmarks as the on-device baseline behind these gates; SAM 2 tiny is the
strongest candidate as an **offline / server-side** segmenter and as a labelling aid for the real dataset, and as a second opinion
where GrabCut fails (small or blurred hands). A small model trained on **our own consented, hand-traced masks** remains the only
route to a measured real-world accuracy; none of the public hand datasets checked is licensed for commercial use.

### External files used for the evaluation (nothing added to the repository or to package.json)

* Composite scenes: rebuilt locally from the untracked `frontend/e2e/.media/hand.png` and `hand_portrait.png` with the stage-1
  recipe; derived cases (bars, bridge, border cut) made the same way. Landmarks from the app's own `createStillHandDetector`
  (MediaPipe HandLandmarker, `public/models/hand_landmarker.task`) in headless Chrome. All in a scratch folder, not committed.
* SAM 2 tiny: `facebook/sam2-hiera-tiny` from Hugging Face (`config.json`, `model.safetensors`, processor configs; revision
  `7c218beaf0`), Apache-2.0 per its licence tag, cached in a scratch folder (not the repo, not the user's HF cache), run with Python
  packages that were already installed. The loader warns that the checkpoint is a `sam2_video` model loaded into the image model.

### Limitations (stage 2a)

* **No real ground-truth masks exist.** Tables 1-2 are composites of **one** real hand photo; per-part truth exists only for synthetic
  hands. Nothing here is accuracy on people, cameras or lighting in the wild.
* Gate thresholds were chosen on the same scenes they are reported on; the merged-gap margin is narrow; a real labelled set must
  re-fit them.
* Fingers held together pass `fingers_merged` (the landmarks agree) but their widths end at label borders (`"part"`), not edges.
* A skin-coloured object over a finger is invisible to the colour checks; the neck/length checks catch it only if the mask follows it.
* The confidence is a heuristic score, not a probability. The wrist band is a landmark convention.
* Landmark failure (no hand on skin-coloured or striped backgrounds) still stops everything before segmentation.
* Phone latency is unmeasured for every option.

## What the pipeline does

1. Shrink to the working size (area average; never enlarge). 2. Seeds from the landmarks, in units of the palm width
(landmark 5 to 17): thick bones and the shrunken palm are sure hand; the hull grown by 0.3 palm widths is probable
hand; out to 0.75 is probable background; beyond, and the border ring, is sure background. 3. The backend. 4. Wrist cut,
main connected component (the one holding the seeds), small-hole fill, 3x3 majority and a 1 px opening (no closing: a
closing would seal real narrow finger gaps). 5. Finger gaps checked and, for the three finger-to-finger valleys only,
restored. 6. Contour, area, fingertips, quality numbers and gates.

Conventions (all derived from landmark axes, so orientation does not matter):
* **Wrist boundary**: the line through landmark 0, perpendicular to the forearm axis (from the mean of the four knuckles
  through landmark 0). Hand pixels beyond it, on the forearm side, are removed.
* **Fingertip**: the farthest mask pixel along the DIP-to-tip axis (a 2 px break is bridged). Found only if the walk starts
  inside the hand and reaches 60 % of the way to the landmark tip.
* **Finger gap**: the valley line runs midway between two digit axes. Where the landmarks show the digits more than
  0.42 palm widths apart, that line is more than half a finger width from both bones, so it must be background; hand
  pixels there mean the mask merged the fingers and a thin line is cleared. Fingers the landmarks show together are
  only reported, never carved; the thumb-index web (a wide skin region) is only reported.

Quality gates (`constants.ts`, all provisional): **blurred** = median edge width (contrast / steepest slope across the
contour) above 6 working px with enough contrast to judge; **incomplete** = hand pixels on the frame edge or fewer than
five fingertips; **occluded** = landmarks outside the mask, or the sure-hand seeds not skin-coloured (something covers
the hand); **merged** = a finger-to-finger gap closed; **implausible** = mask/landmark-hull area outside 0.85-2.4 or
a large stray share; **no_hand**; **segmentation_failed** (a backend threw: the message is in `error`).

## Capability of the bundled OpenCV.js (checked in Chrome and Node; the bundled file is byte-identical to the npm package)

Present: `grabCut`, `findContours`, `morphologyEx`, `distanceTransform`, `convexHull`, `convexityDefects`,
`connectedComponents(+WithStats)`, `watershed`, `Laplacian`, `Sobel`, `Canny`, `floodFill`, `approxPolyDP`, `kmeans`,
`bilateralFilter`, `undistort`, `solvePnP`, `findHomography`, `estimateAffine2D`, `ORB`, `AKAZE`, `BFMatcher`.
**Absent**: `calibrateCamera`, `aruco` (no fiducial markers), `Subdiv2D`, `FlannBasedMatcher`, `pyrMeanShiftFiltering`.
(The segmentation here does not depend on any OpenCV function except `grabCut` and its matrix plumbing; contours,
morphology and metrics are pure TypeScript.)

## Findings

### Pretrained models

* **MediaPipe InteractiveSegmenter ("magic touch")**, 6.2 MB, `public/models/experimental/magic_touch.tflite`
  (https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite,
  sha256 starts `e24338a717c1b7ad`). The repo's `.gitignore` ignores `models/`, so the file is **not committed**: download it with the
  URL above into `frontend/public/models/experimental/` before using the `interactive` backend (GrabCut and skin need no model). The model card (Google, 13 Mar 2023) says *licensed under Apache License 2.0*,
  intended for "object segmentation", evaluated on the person class, and warns that thin features such as fingers
  may be missed. It does not name its training data. Licence review of the project's models is another agent's task:
  this is only what the card says.
* **DeepLab v3** (MediaPipe, 21 PASCAL VOC classes) has **no hand class**. On the sample hand photo it labelled the hand
  as class 9, "chair", not even "person". Not a candidate.
* **MediaPipe Hand Landmarker** (already in the app) is the seed source and the first point of failure: it found **no hand
  at all** on two composites (the hand on a skin-coloured table and on wood stripes) and on three of four small, low
  resolution real crops. `segmentHand` then returns `no_hand`.

### Composite evaluation (26 scenes with landmarks, ground truth known)

**These are composites, not real-world data.** The hand pixels are real (the repo's sample hand photo, matted from its
white background by whiteness), the scenes are synthetic: six backgrounds, three recoloured skin tones, four lightings,
three blur/compression levels, rotations of 30/90/180/250 degrees and a mirror, and the hand 60 % and 40 % size. Truth =
the matte, cut at the wrist like the pipeline. Pixels are working-image pixels (source pixels are 2.5x larger for these 1280 px scenes). Produced with local scratch tooling (not committed: it has machine-specific paths and the personal frame sources it used are not in the repository; the composite-scene recipe is described here so the evaluation can be rebuilt properly).

| backend | IoU mean / median / min | Dice mean | boundary mean, median p95 | accepted | false accepts (IoU<0.9) | false rejects |
|---|---|---|---|---|---|---|
| **GrabCut** (landmark seeds) | **0.952** / 0.956 / 0.813 | 0.975 | **1.0 px**, 2.5 px | 25/26 | 2 (the two "far" cases) | 0 |
| InteractiveSegmenter | 0.832 / 0.905 / 0.176 | 0.889 | 6.9 px, 11.3 px | 21/26 | 6 | 0 |
| Skin colour (baseline) | 0.786 / 0.963 / 0.326 | 0.851 | 6.1 px, 1.7 px | 16/26 | 0 | 1 |

* **GrabCut**: IoU 0.946-0.992 on every background, tone, lighting, orientation and the mirror; the three finger-to-finger gaps
  were open in all 26 scenes (78 of 78). Weakest: blur (sigma 4: 0.91, p95 14 px; sigma 9: 0.81 and, correctly, rejected as blurred) and
  a small hand (60 %: 0.90; 40 %: 0.81 with p95 11 px, accepted: a false accept).
* **InteractiveSegmenter** gives a coarse, over-inclusive silhouette that fills the finger gaps and sometimes picks the
  wrong object when the picture is rotated by 30 or 250 degrees (IoU 0.18). It would need a refinement stage; its
  confidence mask could serve as the "probable hand" prior for GrabCut.
* **Skin colour** is excellent when the skin is saturated and the background neutral, and fails (IoU ~0.4, flooding the
  band) whenever skin chroma is close to grey: the dark, pale and recoloured tones, gamma and warm-cast lighting. It is
  why colour alone cannot be the answer.
* The gates caught the right things in these scenes (blurred, incomplete) but are not a safety net: the "far" cases and
  the skin baseline on a real frame (below) were accepted despite visible errors.

### Real frames (qualitative only, no ground truth)

Frames from the repo-root phone screen recordings. They are **not raw camera pictures**: the app's own orange outline,
white skeleton, labels and coin ring are drawn over the hand, and the hand is only ~130-200 px wide. Four crops were tried
(also enlarged three times): only one yielded landmarks (a hand on dark patterned fabric). On it, by looking at the overlay:
GrabCut traced the whole hand tightly with the wrist cut, five tips and open gaps; the interactive segmenter filled the
two right-hand finger gaps and was rejected as incomplete; the skin baseline left ragged, partly missing fingers and still
passed its gates. The other three (blue floral cloth, grey desk) produced no landmarks. Nothing was copied into the repo.

### Latency

Median per call, working size 512, **headless desktop Chrome without a GPU (pessimistic; not a phone)**, 1280x720 sources:
GrabCut 2.2 s (backend 1.5 s), InteractiveSegmenter 1.3 s (backend 0.8 s, CPU delegate), skin 0.7 s. Of the pipeline
outside the backend, about 160 ms in Node (resize 16, seeds 20, post 38, gaps 20, quality 62). **No phone was measured.**
At this cost GrabCut is a per-capture step (a few frames), not a per-frame live overlay.

## Recommendation

1. Carry **GrabCut with landmark seeds** forward as the baseline silhouette: best accuracy on the controlled scenes, no
   model download, runs on the OpenCV already shipped. Keep the gates, and add the failure it shows (small or blurred hands,
   a hand-landmarker miss) to the capture guidance rather than the measurement.
2. Try as the next candidates, on real labelled data first: a promptable segmenter prompted with the landmarks (MobileSAM /
   EdgeSAM / SAM 2), and a small fine-tuned U-Net/DeepLab-MobileNet. A **custom labelled dataset is required in any case**
   to know how any of them performs on real phone pictures (different cameras, skin tones, lighting, backgrounds,
   orientations, distances): at least masks traced on real photos plus the physical reference measurements. Whether to
   **train** a model depends on how GrabCut and the promptable models do on that data. Licences of those models and of
   hand datasets (HaGRID-style masks etc.) are being reviewed by another agent; nothing here decides them.
3. Do not use skin colour or the interactive segmenter alone.

## What is and is not established

Established: the code runs in real Chrome and in Node; the mechanics (contour area = pixel count, orientation
independence, gap restoration, wrist cut, gates) are unit tested on synthetic hands; on the composites above GrabCut
reproduces the known mask closely.

**Not established**: any accuracy on real hands (there is no ground-truth mask and no physical reference measurement), any
behaviour on real phone cameras, any timing on a phone, any generalisation beyond one hand photo (the composites reuse one
real hand), the thresholds in `constants.ts`. The numbers above are labelled "composite" for that reason and must not be
quoted as measurement accuracy. The hand outline is a silhouette in the image plane: converting it to millimetres is the
calibration work (coin scale, perspective, distortion), not done here.

## Files

Stage 2a: `analyse.ts` (`analyseHand`, gates), `parts.ts` (part labels, per-finger geometry), `fingerGaps.ts`, `confidence.ts`,
`boundary.ts` (metrics with and without truth), `pngNode.ts` (Node-only PNG reader for the evaluation), `analyse.test.ts`,
`composite.eval.test.ts` (opt-in). `segmentHand.ts` gained the `"external"` backend and returns GrabCut's colour models and the
working image; `synthetic.ts` gained part truth.

`segmentHand.ts` (pipeline), `backends/{grabcut,interactive,skin}.ts`, `seeds.ts`, `fingers.ts` (tips, wrist, gaps),
`quality.ts`, `metrics.ts`, `morph.ts`, `geometry.ts`, `imageops.ts`, `constants.ts` (all thresholds),
`stillLandmarks.ts`, `synthetic.ts`, `index.ts`, tests (`*.test.ts`: metrics, pipeline, GrabCut in Node). A local `tools/` folder of scratch scripts produced the composite numbers; it is
**not committed** (hard-coded machine paths, personal frame sources) and the evaluation should be rebuilt as a proper, path-independent harness. Run the tests from `frontend/`: `npx vitest run --no-file-parallelism src/experimental/segmentation`.
