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

`segmentHand.ts` (pipeline), `backends/{grabcut,interactive,skin}.ts`, `seeds.ts`, `fingers.ts` (tips, wrist, gaps),
`quality.ts`, `metrics.ts`, `morph.ts`, `geometry.ts`, `imageops.ts`, `constants.ts` (all thresholds),
`stillLandmarks.ts`, `synthetic.ts`, `index.ts`, tests (`*.test.ts`: metrics, pipeline, GrabCut in Node). A local `tools/` folder of scratch scripts produced the composite numbers; it is
**not committed** (hard-coded machine paths, personal frame sources) and the evaluation should be rebuilt as a proper, path-independent harness. Run the tests from `frontend/`: `npx vitest run --no-file-parallelism src/experimental/segmentation`.
