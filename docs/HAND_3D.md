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
* Two looks, eased between over 0.3 s (the `onBlack` prop):
  * **On the live picture** it reads on bright and dark pictures: normal (not additive) blending with a dark rim on
    every point and a dark drop shadow under every line. (Additive glow disappears on a white table.)
  * **On a picture blacked out round the hand** (the scan screen's focus mask) it is a hologram: additive glow, soft
    round points of different sizes, a brighter silhouette edge (computed once per point from its offset from the
    bone), brighter fingertips, knuckles and creases, a halo of dust round the hand (a second, thinner sample pushed
    out from the skin), glowing nodes at the 21 joints, soft glow along the measuring rails, a thin low-alpha
    wireframe and a luminous band for the scanning sweep.
* It uses only the landmarks. No video pixels are read. It takes no input (`pointer-events: none`), is
  `aria-hidden`, and the 2D drawing and labels carry the same information for assistive use.

## Tones and entry

The `tone` prop recolours the layer: `idle` (cyan and blue, nothing to judge yet), `ok` (a cool green-cyan: the pose is
right) and `warn` (amber: the pose needs fixing). Every colour comes from one table (`palette.ts`), shared by all the
materials and by the labels' accent; a change of tone eases over about a quarter of a second, never jumps. A `warn`
sweep is slower and dimmer, so it reads as waiting.

When a hand is found the layer fades in over 0.3 s while its points converge on it from a little way out (a one-off
vertex-shader offset, no per-frame cost); when the hand is lost it fades out over a quarter of a second. With
`prefers-reduced-motion` there is no sweep, twinkle or converging.

## Protecting scan speed

Scan speed matters more than the picture. `perfGuard.ts` watches a rolling average of the layer's own cost per frame
and of the page's frame interval, against a budget (`budget` prop: `maxFrameMs`, `minFps`; defaults 9 ms and 18 fps).
When either is over budget for about 1.5 s it steps down, in this order, and never back up:

1. no halo of dust, no scanning sweep or twinkle (the look goes first),
2. no wireframe, no joint nodes,
3. half the points,
4. 20 frames a second,
5. switched off: it renders nothing and calls `onDegrade("disabled")` so the screen goes back to its 2D drawing.

The extras of the black look cost nothing on the live picture (they are not posed or drawn there), and the halo is
posed every other frame.

The first frames (shader compile) and a hidden tab are not held against it. The layer also switches itself off if
WebGL is missing, the scene cannot start, or the WebGL context is lost (never a blank, frozen canvas). The chunk is
loaded behind an error boundary: if it cannot be fetched the page carries on without it. It is capped at pixel
ratio 1.25, 30 frames a second, 3,000 points on phones (5,000 otherwise), and it draws only while it is on screen
and the page is in front.

Measured in headless Chrome with software WebGL on a desktop CPU, alternating old and new builds on the same page
(5,000 points, three runs each, on a machine that was busy with other work, so only roughly): the live-picture look
costs about the same as before (about 1.7 ms of JavaScript per frame); the black look about 2.4 ms. That is not a
phone GPU (see below).

## Honest limits

* It is an illustration drawn from landmarks. The shape of the hand is a generic one, posed by the landmarks, so it
  does not show the customer's real hand surface.
* The depth of the landmarks is noisy and relative; the relief is exaggerated slightly and limited.
* It has **not been run by us on a real phone GPU**. The speed numbers above come from software rendering and the
  budget values are provisional. The performance guard exists because of that: on a phone that cannot afford it, the
  layer reduces itself and then goes away rather than slow the scan.
* The look was checked on one still photograph with MediaPipe's own landmarks (bright and dark backgrounds, mirrored,
  with and without depth, at 360 and 390 px wide), not on live video of many hands.

## The result page's light stage

The result page shows the hand on a light stage (white and pale blue, navy ink), as one card with the size:
`HandStage` takes `theme="light"` (default `"dark"`; the live overlay and the calculating screen are unchanged).
The look is display-only: it reads the same 21 landmarks and measured values as before and changes no
measurement, threshold or config. Labels show only what was measured (the four finger lengths and the hand
length); nothing is added for circumference or palm girth, which the camera does not measure. The card says
which coin set the scale, never that calibration is "complete", and keeps the line that a camera estimate cannot
guarantee fit. Styles: `frontend/src/screens/results.css` (scoped to `.results-v2`) and `.hand-stage--light` in
`handStage.css`. Real-phone speed of the extra layers (orbit rings, sparkles) has not been timed.
