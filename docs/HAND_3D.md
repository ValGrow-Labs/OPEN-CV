# The glowing 3D hand

An illustration, not a measurement and not a 3D scan. It is drawn from the 21 hand landmarks the camera tracks
(plus, for the finger lengths it labels, the same coin-scaled numbers the app already shows). The size result
comes only from the server's pipeline; nothing here changes it.

Code: `frontend/src/hand3d/`. The three.js scene is a separate, lazily loaded chunk (about 125 KB gzipped), so the
main bundle does not carry it.

## Modes (`HandStage`)

| Mode | What it is | Where |
| --- | --- | --- |
| `overlay` | The camera view itself: a transparent layer over the live video that draws a luminous 3D hand exactly where the real hand is, with a measuring rail along each finger (knuckle to tip, the same pairs the live finger lengths use), a hand-length rail beside the hand and a scanning sweep. Finger lengths and the hand length are labels on it. | The live scan |
| `scan` | A generic hand turning slowly over a sonar-wave grid, with a scan beam. | "Calculating your measurements" |
| `static` | The same scene, reshaped from the customer's own landmarks, with finger-length labels. | The result page ("Your hand") |
| `live` | A small tile that follows the tracked hand. | Where the overlay is switched off or not available |

The scene is dark stage inside the cream pages in `scan`, `static` and `live`; the overlay has no background at
all.

## How the overlay sits on the hand

* The landmarks are in video pixels. The layer uses an orthographic camera in screen pixels and the same
  `object-fit: contain` rectangle as the video, so a landmark lands on the pixel where the real hand is. A mirrored
  (front camera) picture is mirrored the same way.
* The hand is a cloud of points attached to the bones (`handModel.ts`), re-posed from the landmarks every frame,
  with a wireframe outline. The depth (`z`) of the landmarks gives a little relief, so a tilted hand reads as 3D.
* It reads on bright and dark pictures: normal (not additive) blending with a dark rim on every point and a dark
  drop shadow under every line. (Additive glow disappears on a white table.)
* It uses only the landmarks. No video pixels are read. It takes no input (`pointer-events: none`), is
  `aria-hidden`, and the 2D drawing and labels carry the same information for assistive use.

## Protecting scan speed

Scan speed matters more than the picture. `perfGuard.ts` watches a rolling average of the layer's own cost per frame
and of the page's frame interval, against a budget (`budget` prop: `maxFrameMs`, `minFps`; defaults 9 ms and 18 fps).
When either is over budget for about 1.5 s it steps down, in this order, and never back up:

1. half the points,
2. no wireframe, no twinkle, no sweep,
3. 20 frames a second,
4. switched off: it renders nothing and calls `onDegrade("disabled")` so the screen goes back to its 2D drawing.

The first frames (shader compile) and a hidden tab are not held against it. The layer also switches itself off if
WebGL is missing, the scene cannot start, or the WebGL context is lost (never a blank, frozen canvas). The chunk is
loaded behind an error boundary: if it cannot be fetched the page carries on without it. It is capped at pixel
ratio 1.25, 30 frames a second, 3,000 points on phones (5,000 otherwise), and it draws only while it is on screen
and the page is in front.

Measured in headless Chrome with software WebGL on a desktop CPU: about 2 ms of JavaScript per frame, 0.9 ms of it
re-posing the cloud. That is not a phone GPU (see below).

## Honest limits

* It is an illustration drawn from landmarks. The shape of the hand is a generic one, posed by the landmarks, so it
  does not show the customer's real hand surface.
* The depth of the landmarks is noisy and relative; the relief is exaggerated slightly and limited.
* It has **not been run by us on a real phone GPU**. The speed numbers above come from software rendering and the
  budget values are provisional. The performance guard exists because of that: on a phone that cannot afford it, the
  layer reduces itself and then goes away rather than slow the scan.
* The look was checked on one still photograph with MediaPipe's own landmarks (bright and dark backgrounds, mirrored,
  with and without depth, at 360 and 390 px wide), not on live video of many hands.
