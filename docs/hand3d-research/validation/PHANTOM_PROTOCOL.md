# Physical phantom protocol (draft for the first test)

A rigid, hand-shaped object placed on the printed board exactly like a hand. It separates the reconstruction's own error
(camera geometry, segmentation, carving) from everything a living hand adds (soft tissue, posture, movement). **A phantom
result is not human-hand accuracy**, and passing it does not validate the system.

**No dimension of the phantom is given here.** Its reference values are whatever calipers read on the manufactured part
(section 4). A design drawing or CAD file is a design, never a reference.

## 1. Requirements

| Requirement | Why (from the pipeline) |
|---|---|
| **Rigid, dimensionally stable** (cured resin, PLA/PETG print, sealed cast). No foam, no rubber | Repeated captures and repeated caliper readings must see the same object |
| **Rests on the board without rocking**: a flat base under the palm and the fingertips; press each corner, no visible lift (check with a 0.1 mm feeler gauge where possible) | The reconstruction bounds the palm side by the board plane (`support_plane`); a rocking phantom breaks that assumption and moves between views |
| **Hand-like enough for MediaPipe in the top view** (proportions, five separate fingers, a thumb) | The hand frame and every length come from MediaPipe's landmarks (triangulated, or lifted from one top view). A geometric block gets a mesh but no measurements |
| **Matte, skin-coloured finish with colour** (not white, grey or black) | The board segmentation separates skin by its chroma from the neutral paper and black ink (`multiview/segment.ts`). A grey phantom would read as paper or ink |
| **Fingers slightly spread, gaps of at least 5 mm** at the fingertip level | Finger gaps are reconstructed only where a view looks through them; closed gaps are reported closed |
| **Adult-hand size**, fits the board's hand area (inside the marker rows, fingertips short of the coin ticks), wrist at the open left edge | `BOARD.handArea`; the forearm cut face is at the open edge |
| **Datum marks** (section 3), thin and small | So the calipers and the software measure the same thing |
| Identified with a phantom id written underneath (not visible from above) | Traceability in exports (`run.phantom_id`) |

## 2. Construction options

| Option | Use | Notes |
|---|---|---|
| **A. Cast of a real adult hand** (alginate mould, resin or sealed plaster cast, painted matte skin tone), hand pressed palm-down on a flat plate while casting | **Primary**: realistic shape for MediaPipe; full pipeline incl. measurements | The volunteer is a team member, not a study participant; written consent to make and keep the cast. The cast is not a person: no human-accuracy claim |
| **B. 3D print of this project's own CAD** (optional script `frontend/scripts/capsule-phantom-stl.ts`, the synthetic capsule hand with a flat base) | Geometry and surface distance against a nominal CAD | MediaPipe will probably not find it (the simulated capsule hand was found in the top view only, and not in low views), so lengths may be unavailable; still tests mesh shape, thickness, gaps. Print tolerance (typically a few tenths of a mm, varies by printer) means the CAD is nominal: calipers are the reference |
| C. 3D print of a licensed hand model | Only after its licence is confirmed for commercial use | Not chosen here: no model's licence has been verified |

A reference **3D scan** of the phantom (a scanner with documented accuracy) is optional; it enables surface-distance
metrics for option A. Without one, surface distance is reported for option B against its nominal CAD, labelled so.

## 3. Datum marks (draw once, never move)

Thin lines (0.5 mm or less, one dark colour), on the back only (the palm side rests on the board):

1. **Wrist datum line**: across the wrist where the forearm stub begins (for a cast: the distal wrist crease position).
2. **Knuckle line**: across the most prominent points of the index to little-finger knuckles (MCP heads).
3. **Section line**: parallel to the knuckle line, **8 mm toward the wrist** (the software's palm breadth, thickness and
   circumference section; `reconstruction/measure.ts`).
4. A dot on each fingertip's farthest point (optional: the fingertip is its own datum).

The software's definitions rest on MediaPipe's landmarks (joint centres), the physical ones on these datum marks. Where
they cannot be the same (hand length from a landmark wrist plane vs a drawn wrist line; finger length from a joint centre
vs a datum), the report flags the pair as **definition differs** and does not present the difference as an error alone.

## 4. Reference measurements (the only source of reference values)

**Instruments:** 0.01 mm digital caliper (150 or 200 mm), a 300 mm caliper or an anthropometer for the hand length, a
height gauge or caliper depth rod on a surface plate for heights, a non-stretch tape (only if a circumference is
recorded), a gauge block or certified 100 mm reference read before every session (the reading is recorded in the
reference file).

**Readers:** two measurers (codes, never names), each reading every dimension at least twice, phantom lifted and replaced
between readings; the spread tolerance is fixed before the first reading and recorded. The reference file
(`frontend/src/experimental/validation/reference.ts` schema) stores every reading; the tool computes the agreed value and
the intra- and inter-rater SD, and refuses incomplete files.

**Dimensions** (names as used by the reference schema and the comparison tool):

| Dimension | Physical definition | Software counterpart | Like for like? |
|---|---|---|---|
| hand_length | wrist datum line to the middle fingertip's farthest point, parallel to the board | `handLength` (landmark wrist plane to farthest mesh point along the hand axis) | **definition differs** (wrist) |
| palm_breadth | across the palm along the section line, skin to skin, thumb excluded | `palmBreadth` | yes |
| palm_thickness | highest point of the back on the section line over its central 60 %, measured from the base plane (height gauge) | `palmThickness` (height above the board) | yes |
| finger_length_<name> | fingertip to the knuckle line along the finger | `fingerLengths` (joint centre to tip) | **definition differs** (base point) |
| finger_width_<name>_at_15mm | width parallel to the board, 15 mm from the fingertip, perpendicular to the finger | mesh slice (validation tool) | yes |
| finger_height_<name>_at_15mm | height above the base plane at the same place | mesh slice | yes |
| finger_gap_<a>_<b> | horizontal clearance between adjacent fingers, 10 mm short of the shorter finger's tip | mesh slice (0 = closed) | yes |
| knuckle_section_width / knuckle_section_height | as palm_breadth / palm_thickness | mesh slice | yes |
| circumference_section (optional) | tape around the section line, including the palm side | `circumferenceKnuckle` (**upper bound**: palm side is the board plane) | **no**: reported, never scored as an error |

Surface area: not measurable by hand and **not produced** by a board capture (the palm side is not observed).

## 5. Before every session

Gauge-block reading recorded; phantom inspected for chips, warping, loose paint; base flatness re-checked on the surface
plate; datum marks intact. A damaged phantom is re-measured from scratch (a new reference file, a new phantom id
suffix).
