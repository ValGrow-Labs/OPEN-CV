# Marker-board verification protocol

The board sets the scale of every millimetre and the pose of every camera. A board printed at the wrong scale scales the
whole hand; a curled board bends the poses. **Verify every printed copy before its first capture and at the start of each
session.** Expected values below are computed from the layout in `frontend/src/experimental/board/spec.ts` (board
version `glovesize-board/1`); the capture page computes them from the same layout.

## 1. Printing

* File: `docs/hand3d-research/board/marker-board-a4-v1.svg` (or the page's "Download the board" button).
* **A4, landscape, "Actual size" / 100 %**, never "Fit to page" (typically 94 to 97 %).
* **Matte** plain paper, 90 g/m² or heavier. Prefer an **inkjet** print: laser toner can turn shiny at grazing angles,
  and the low ring of views looks at the board from about 12 degrees, where a shiny black square reads grey (not tested
  yet; see section 5).
* No printer "enhancement", no draft mode (the black must be solid).

## 2. Measurements with a steel rule or caliper (record every reading)

| Check | Expected | Tolerance (provisional) | Catches |
|---|---|---|---|
| Page | 297 x 210 mm | +-1 mm (paper cutting) | wrong paper size |
| One marker's black square, width and height | 30.0 x 30.0 mm | +-0.3 mm | gross scaling (fit to page) |
| Top row outer span: left edge of the first marker to right edge of the last | **270.0 mm** | +-0.5 % (+-1.35 mm) | print scale along the long edge |
| Right column outer span: top edge of the upper marker to bottom edge of the lower | **70.0 mm** | +-0.5 % (+-0.35 mm) | print scale along the short edge |
| Top edge of the top row to bottom edge of the bottom row | **194.0 mm** | +-0.5 % (+-0.97 mm) | scale along the short edge (longer baseline than 70 mm, more precise) |
| Long-edge scale vs short-edge scale | equal | within 0.5 % | anisotropic printer scaling |

Why the spans matter more than the square: a 0.3 mm reading error is 1 % of 30 mm but 0.11 % of 270 mm. For the short
edge use the 194 mm span (or a caliper on the 70 mm one): read to 0.5 mm with a rule, the 70 mm span alone is uncertain by
about 0.7 %, more than the tolerance, and would false-fail the scale-agreement check (the page currently asks for the 70 mm
span; read it with a caliper). A 0.5 % scale
error is about 1 mm on a 190 mm hand. The capture page's validation mode (`?validation`) takes these readings and gives the
verdict; the coin check (`board/coinCheck.ts`: the coin's diameter measured in board millimetres) is a second, independent
check of the print scale during capture.

## 3. Flatness (the strictest requirement)

**Arithmetic, not measured:** a point of the board raised by h millimetres moves in the picture by about h x f / Z pixels
whatever the viewing angle (f the focal length in pixels, Z the distance). At 350 mm with f about 1,025 px (1280 x 720
video, about 64 degrees field of view) that is about **2.9 px per millimetre of lift**, against corner noise of 0.3 to
0.5 px on clean renders. Keeping the curl's effect below the corner noise needs the board **flat within about 0.2 mm**.
A 1 mm lift along one edge tilts the fitted plane by roughly 1 mm / 200 mm, about 0.3 degrees, already more than half of the
0.5 degree pose error at which the reconstruction gates start rejecting (multiview end-to-end tests, SIMULATED).

So: **plain paper lying on a table is not flat enough.** Mount the print:
* spray-mount or double-sided tape it, smoothed from the centre outwards, onto a rigid flat backing: 5 mm foam board, an
  acrylic or glass sheet, or a flat clipboard larger than A4;
* check: lay a steel rule on edge across the board in both directions and along both diagonals; no light gap. A 0.1 mm
  feeler gauge must not slide under the rule anywhere;
* re-check at every session (humidity curls paper; a board stored rolled is rejected).

The page also judges flatness from the pictures (`board_check.flatness`): per-marker reprojection residuals over all views.
SIMULATED results (`frontend/src/experimental/recon/boardFlatness.test.ts`, a sheet bent as an even cylinder, 7 views at
1280 x 720):

| Sheet | Median / worst marker residual | Verdict | Effect |
|---|---|---|---|
| flat | 0.10 / 0.19 px | pass | none |
| 1 mm bend | about 0.8 px | **pass (not caught)** | focal length shifted 0.1 to 0.3 %: a hidden scale error of about 0.2 to 0.6 mm on a hand |
| 3 mm bend (long or short edges) | 2.1 to 2.4 / 3.4 to 3.8 px | fail | the chain itself also refuses (calibration RMS 2.4 px) |
| 5 mm bend | 3.4 to 3.8 / 5.6 to 6.0 px | fail | refused |

So the arithmetic above overstates what the residuals show: the plane and camera fit absorb most of a smooth bend, and
put it into the calibration instead. **The picture-based check catches gross curl only; the steel-rule check is the
safeguard for the last millimetre.** The edge-versus-centre ratio did not separate curled from flat sheets and is reported
only. Thresholds are provisional: the first phantom session must record flat-board residuals on a real print (the
simulated flat board with a hand already sits at 0.8 px) and re-set them.

## 4. Marker visibility across camera positions

During a capture, the page shows the markers found in each view and refuses views with fewer than 3 consistent markers.
For verification, take one capture of the empty board (no phantom) with the full coverage path and check in the export:
every view has a pose; per-view marker counts; the calibration RMS under 1.5 px. Expected weak spots (SIMULATED): low views
looking along the forearm from the open left edge see few markers; far, blurred, low views lose the farthest row.

## 5. Reject the board if

* any reading in section 2 is outside tolerance, or the two edge scales disagree by more than 0.5 %;
* the steel-rule flatness check shows a gap, or the page's flatness verdict fails;
* the black squares look grey, shiny or streaked (toner sheen, low ink), or the paper is glossy;
* the sheet is torn, creased, stained across a marker, or its markers were cut by the print margin;
* the coin check in a capture reports a print scale off by more than 2 % (then re-measure the spans).

A rejected board is destroyed or marked "REJECTED" so it cannot be reused. Record the board's id (write it on the back),
printer, paper, mounting, the readings and the verdict in the session log.

## 6. Not yet known (needs the first physical tests)

Real corner accuracy on a print; glare at 10 to 15 degrees on matte inkjet vs laser; how flat foam board stays; whether the
SIMULATED flatness thresholds catch a real curl without false alarms.
