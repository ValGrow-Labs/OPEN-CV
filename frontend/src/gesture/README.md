# Hand pose and finger tracking (display only)

Reads the **current hand pose** and the **bend of each finger** from the 21 MediaPipe hand landmarks the app already
has. It is a classifier over real landmarks, not an animation. It only READS: it never touches a measurement, the coin
pipeline, the calibration or any production setting, and nothing outside this folder imports it yet.

**Status: every threshold below is provisional and unvalidated.** The numbers were tuned and tested on **synthetic**
hands (`synthetic.ts`: a capsule-like hand built from simple proportions, viewed, rotated, mirrored and noised). They have
not been compared with real people's hands or real MediaPipe output.

## API

```ts
import { readHandPose, PoseSmoother, HandPosePanel } from "../gesture";

const reading = readHandPose(imageLandmarks, worldLandmarks /* optional */);   // HandPoseReading
const smoother = new PoseSmoother({ holdMs: 250 });
const shown = smoother.update(reading, performance.now());                      // call every frame; smoother.reset() when no hand
<HandPosePanel reading={shown} />                                                // null shows "Show your hand"
```

`HandPoseReading`: `label` (`open_palm`, `fist`, `fingers_spread`, `fingers_together`, `thumb_extended`, `index_extended`,
`pointing`, `relaxed`, `unknown`), customer `text`, `fingers[5]` (thumb first: `state` extended / half_bent / bent and
`bendDeg`), `spread` (together / apart / mixed), `thumbOut`, `confidence` (0 to 1) and `usedWorld`.

The app's `ScanController.onPose` already hands out the image landmarks and, as a third argument, the world landmarks, so
wiring it is `readHandPose(landmarks, world?.points)` per frame. (Not wired: that is a separate step.)

## How it decides

Everything comes from **joint angles and distances normalised by the palm length** (wrist to middle knuckle), never from
absolute x/y directions. A left or right hand, a mirrored picture and any rotation of the hand in the image therefore give
the same answer (tested over 0 to 330 degrees, both hands, scales 0.4 to 12).

* **3D world landmarks (preferred).** Finger flexion = how far the proximal phalanx leaves the palm plane (palm normal from
  wrist, index knuckle and little knuckle) + the angle between that phalanx and the PIP-to-tip chord. The chord is long, so
  the estimate is far less noisy than the sum of three short-bone joint angles; it reads about **75 to 100 % of the true total
  flexion** (a fully curled finger built as 250 degrees reads about 210), which keeps the order and the thresholds.
* **Thumb:** the angle between its first bone (CMC to MCP) and its last (IP to tip) = MCP + IP flexion for a hinge.
* **2D image landmarks only (fallback).** The same angles measured in the picture, with the knuckle reference being the wrist
  to knuckle direction. A finger that bends toward the camera shortens in the picture; when its projected bones are much
  shorter than a straight finger's (`FORESHORTEN_*`), the in-plane angle means nothing and a **reach rule** takes over (tip to
  wrist distance in palm lengths against the finger's straight reach, squared). Confidence is lower (0.6 against 0.9).

### Finger states

| | extended | half bent | bent |
|---|---|---|---|
| four fingers | below 60 degrees | 60 to 140 | 140 and over |
| thumb | below 35 | 35 to 70 | 70 and over |

On synthetic hands: a straight finger reads about 10 to 20 degrees (with 1.5 % noise), a half-bent one about 90, a fist about 210.

### Spread and thumb

* **Spread** uses only neighbouring fingers that are both *extended*, with the angle between their knuckle-to-tip directions.
  *Together*: mean gap below 9 degrees and no gap at 15 or more. *Apart*: mean gap at least 17 and no gap below 9. Otherwise
  *mixed*. With no pair measurable (a fist) it says *together*. The mean is used because the angle between two noisy fingertip
  directions jitters by a few degrees.
* **Thumb out**: not bent, the angle between the thumb (CMC to tip) and the index metacarpal (wrist to index knuckle) at least
  30 degrees, and the thumb tip at least 0.6 palm lengths from the index knuckle.

### Labels, in this order

1. `fist`: all four fingers bent **and the thumb not out**. (A fist with the thumb out is a thumbs-up and reads as
   `thumb_extended`; this is the one deliberate departure from "fist first".)
2. `pointing`: index extended, middle/ring/little not extended and at least two of them bent. The thumb does not matter.
3. `index_extended`: index extended and at least two of the other three not extended.
4. `thumb_extended`: thumb out while the four fingers are not all extended.
5. `fingers_spread`: four fingers extended and spread *apart*.
6. `fingers_together`: four extended, *together*, thumb tucked.
7. `open_palm`: four extended otherwise (mild spread, or together with the thumb out).
8. `relaxed`: anything else. `unknown`: missing, non-finite or collapsed landmarks. **Nothing is guessed**: the panel then
   shows "Hand not clear" and no finger rows.

### Smoothing (`PoseSmoother`)

A new label, finger state, spread or thumb value replaces the shown one only after it has been the latest reading for
`holdMs` (250 ms) without a break. If it keeps contradicting the shown value without ever holding (two labels
alternating), the latest reading is shown after four hold times, so the display never stays far from the hand. Bend angles
and the confidence are lightly smoothed (80 ms and 200 ms). An unreadable frame does not wipe the fingers.

## What the tests show (synthetic only)

* Every named pose, in four viewing directions (palm to the camera, side, tilted, back of the hand), six in-plane rotations,
  both hands, several scales: read correctly, 0 failures (3D landmarks).
* Each single finger bent (thumb included) bends only that finger, in 3D from any side and in 2D from the side or from the front.
* **Stability over 200 noisy frames** (Gaussian noise of 1.5 % of the hand length, about 2.6 mm, on every coordinate, 30 fps,
  20 cases: ten poses, 3D and 2D): the raw label flipped **62 times in total** (all in the borderline cases: a mildly spread
  hand, fingers together near the spread band, relaxed hands in 2D), the smoothed label **0 times**. Raw accuracy over the 3D
  frames is above 90 % for every pose.
* Rendering of the panel, the spoken line (changes at most about four times a second) and the empty states.

## What 2D landmarks cannot see

* **Bending toward the camera.** The projection shortens and the in-plane angles collapse or fold back. The reach rule
  recovers the common cases (a fist or a half-bent hand seen palm-on) but is a heuristic: a finger that merely *points at the
  camera* while straight also looks short and reads as bent.
* **Spreading seen edge-on.** From the side, the fingers' splay is along the line of sight: the spread reads "together".
* **Thumb abduction seen edge-on** reads as the thumb not being out.
* Prefer the 3D world landmarks; they are the default in the scan (`HandFrame.world`). MediaPipe's depth is a model's
  **relative** estimate, so the angles are plausible hand geometry, **not calibrated physical measurements**, and a pose
  reading is a display aid, never a measurement.

## Unvalidated

No real-hand data was used. The thresholds are anatomical estimates tuned on synthetic hands; the 2D reach constants
(`REACH_EXTENDED`, `REACH_FIST`) are rough proportions. Real hands differ (finger lengths, hyperextension, thumb range,
MediaPipe's own jitter, which can exceed the 2.6 mm used here). Before relying on a label, record real hands in each pose
on the phones the product must support and check the labels and the thresholds.
