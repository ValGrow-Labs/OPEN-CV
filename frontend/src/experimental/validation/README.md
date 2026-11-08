# EXPERIMENTAL: offline validation tooling for the physical phantom test (`validation/`)

> **EXPERIMENTAL, offline, not validated.** This folder turns caliper readings of a manufactured phantom and capture
> exports of the board-capture page (`/experiment/recon/`) into a report. It does not make the system validated: it is
> the bookkeeping for the first physical test (stage G1 of `docs/hand3d-research/VALIDATION_PLAN.md`). A phantom is one
> rigid object, not a person. Nothing here is used by the customer app, and `vite build` ships none of it.

## Rules

* **No invented values.** The reference checker refuses an incomplete or inconsistent reference with reasons; it never
  fills, rounds or guesses a reading. A software value with basis `none`, a null value, a value withheld by the page
  (board print scale wrong) or a dimension the export lacks is **missing**, never zero.
* **A phantom is not human accuracy.** n counts repeated captures of one object; nothing is a population estimate.
* **Synthetic and physical never mix.** A reference whose phantom id starts with `synthetic` is refused unless `--test`
  is passed; `--test` output is titled `SYNTHETIC TEST`, named `SYNTHETIC-TEST-...`, and may not be written into
  `docs/hand3d-research/validation/physical/` (that folder is for real data only). A capture labelled synthetic or
  simulated (`data_origin`, `run.phantom_id`, a `synthetic` condition) is excluded from a physical comparison.
* **Errors only against the agreed reference value**, and only from accepted captures; rejected and refused captures are
  counted with their reasons.

## Files

| File | What it does |
|---|---|
| `zipRead.ts` | Reads the page's stored (uncompressed) ZIPs in Node and the browser; refuses compressed or damaged entries with a plain message. |
| `meshIO.ts` | PLY (ASCII and binary, per-vertex properties, the page's support label names) and STL (binary and ASCII) readers; a binary STL writer. |
| `exportModel.ts` | One capture export as the tool sees it (`reconstruction.json`, `mesh.ply`, `device.json`). Every newer field is optional. |
| `dimensions.ts` | The dimension catalogue with the protocol's definitions, and the **mapping table** software -> reference. |
| `reference.ts` | The reference file schema (JSON, or a JSON header plus a readings CSV), the checker, the template. |
| `meshDimensions.ts` | Finger widths and heights 15 mm from the tip, finger gaps, the knuckle section, read off `mesh.ply` in the landmark hand frame. |
| `compare.ts` | Captures x reference: per-capture status and reasons, per-dimension agreement, repeatability, conditions, capture figures. |
| `surfaceDistance.ts` | Reconstruction vs a reference mesh (CAD or scan): alignment, both-way point-to-surface distances, coverage. |
| `device.ts` | `device.json` aggregated per device and browser. Measured values only, no compatibility verdict. |
| `report.ts` | The Markdown report and the JSON with every number. |
| `cli.ts` | The command line (`frontend/scripts/phantom-report.ts` is a thin wrapper). |
| `phantomMesh.ts` | A printable geometric test phantom from the synthetic capsule hand (flat base at the palm plane). |
| `syntheticReference.ts` | A SYNTHETIC reference from the simulated scene's exact dimensions, for the round-trip test only. |
| `__fixtures__/` | Hand-written **test fixtures, not measurements**. |

## Recording a reference

1. `npx tsx scripts/phantom-report.ts --write-template <study-folder>/reference.json` writes a blank file with every
   catalogue dimension and its definition. The checker refuses it until it is filled in.
2. Fill in: `phantom.id` (never starting with `synthetic` for a real part) and `description`; `date` (ISO); `units` `"mm"`;
   every instrument with its resolution and the day's **calibration check** (`gauge_block` nominal and reading for the
   caliper; a steel rule for the tape); measurer **codes** (`M01`, letters then digits, never names); the protocol fixed
   **before measuring**: `spread_tolerance_mm` (optionally per dimension), `min_readings_per_measurer` (at least 2; 3 for
   thickness if the protocol says so), `agreed_value` (`mean` or `median`), `second_measurer` (`"all"` or a list),
   optionally `inter_rater_tolerance_mm` (default: the spread tolerance).
3. For each dimension: the definition you used (keep the catalogue's unless the protocol says otherwise), the instrument,
   and every reading by every measurer. Remove dimensions you did not measure; add phantom-only ones as `extra_<name>`.
   Or keep the header in the JSON with `"readings_csv": "readings.csv"` and a CSV with columns
   `dimension,measurer,value_mm,instrument,definition,position,note` (definition, position and instrument stated once per
   dimension and identical where repeated).

The checker enforces: units mm; codes not names (no `*name*` field either); a gauge-block check within tolerance (default
twice the resolution); a tape for a circumference; at least 2 readings per measurer per dimension; each measurer's spread
within the tolerance; a second measurer where required, with means agreeing within the inter-rater tolerance; no null,
empty, zero or negative reading. It computes the agreed value (all readings pooled, mean or median as recorded), the
**intra-rater SD** (pooled within-measurer SD), the **inter-rater SD** (SD of the measurer means) and the **floor SD**
`sqrt(intra^2 + inter^2)`: a camera error below the floor cannot be resolved by this reference.

### Dimensions and definitions (`dimensions.ts`)

| Name | Definition (caliper / tape) |
|---|---|
| `hand_length` | Phantom's wrist datum line to the most distal point of the middle fingertip, parallel to the hand axis. |
| `palm_breadth` | At the knuckle datum line, edge to edge parallel to the board, perpendicular to the hand axis, thumb excluded. |
| `palm_thickness` | At the knuckle datum line, board surface to the top of the back of the hand, mid-palm. |
| `knuckle_section_width` / `_height` | The cross-section 8 mm proximal to the knuckle datum: width parallel to the board; height above the board. |
| `circumference_knuckle` | Tape around that section, thumb excluded, touching without indenting. |
| `finger_length_<f>` | Base datum mark on the finger's axis to the most distal point of the tip, parallel to the axis. |
| `finger_width_<f>_at_15mm` / `finger_height_<f>_at_15mm` | Section perpendicular to the finger axis 15 mm proximal to the tip: width parallel to the board; vertical extent. |
| `finger_gap_<a>_<b>` | thumb-index, index-middle, middle-ring, ring-little: clearance parallel to the board along a line perpendicular to the hand axis, 10 mm proximal to the shorter finger's tip (0 when touching). |
| `extra_<name>` | Phantom-only dimensions, no software counterpart (reported, not compared). |

### Field mapping table (software -> reference)

| Reference dimension | Software value | Relation | Why |
|---|---|---|---|
| `hand_length` | `measurements.handLength` | **definition differs** | wrist plane through the triangulated wrist LANDMARK, not the phantom's datum line |
| `palm_breadth` | `measurements.palmBreadth` | **definition differs** | software 8 mm proximal to the landmark knuckle line; caliper at the datum (use `knuckle_section_width`) |
| `palm_thickness` | `measurements.palmThickness` | **definition differs** | central 60 % window of the K - 8 mm section (use `knuckle_section_height`) |
| `circumference_knuckle` | `measurements.circumferenceKnuckle` | **definition differs** | a hull loop is an UPPER BOUND (board-plane half, filled concavities) |
| `finger_length_<f>` | `measurements.fingerLengths.<f>` | **definition differs** | from the landmark MCP joint centre, not a base datum |
| `knuckle_section_width` / `_height` | mesh section (`meshDimensions.ts`) | like for like | basis model (position from the landmark frame) |
| `finger_width_<f>_at_15mm` / `finger_height_...` | mesh section | like for like | basis model; a hull fills space under a finger nobody looked through |
| `finger_gap_<a>_<b>` | mesh section | like for like | basis model; a gap no view looked through is closed (0, with the note) |
| not mapped | `surfaceArea`, `free_surface_area_mm2`, `hull_volume_mm3` | - | withheld on the board, an upper bound, or no instrument; use the surface distance |

Pairs whose definitions differ are computed but reported **apart** (report section 9): their error includes the
definition gap and is not a reconstruction error.

Mesh-derived values need `hand_frame` (with `knuckle_y_mm`) and `finger_axes` in the export (page versions from
2026-11-08 write them); without them they are reported unavailable with the reason. Vertices labelled `support_plane`,
`volume_cut` or `truncated` count only as the board contact (the bottom of a vertical extent), never toward a width or a
tip.

## Running the report

```powershell
cd C:\Users\pc\Downloads\OPEN-CV\frontend
npx tsx scripts/phantom-report.ts --reference <study>\reference.json --captures <study>\exports `
  [--mesh <study>\phantom.stl --mesh-kind cad|scan [--transform <study>\T.json] [--refine]] [--coverage-mm 2] [--out <dir>]
```

* `--captures`: a folder of the page's export ZIPs exactly as saved (or extracted export folders with
  `reconstruction.json`), plus loose `*device*.json` files. A ZIP re-packed with compression is refused (extract it).
* `--mesh`: a reference mesh in millimetres, base on its lowest z with +z up for the automatic alignment (the board frame
  plus a 2D principal-axis yaw, both directions tried, then trimmed ICP), or `--transform` `{"R": [9], "t": [3]}`
  (reference to board mm) to fix the alignment (`--refine` adds ICP). `--mesh-kind scan` when the printed part itself was
  scanned; otherwise the report says that the CAD differs from the part by the print tolerance.
* Output: `phantom-report-<phantom>-<time>.md` and `.json` in `docs/hand3d-research/validation/physical/` by default.
* Exit codes: 0 written; 1 bad arguments; 2 something missing (nothing written, the message says what); 3 a synthetic
  reference without `--test`, or `--test` output aimed at the physical folder.

## What each figure means

| Figure | Meaning |
|---|---|
| error | software value minus the reference's agreed value (mm); + = the software reads larger |
| bias, MAE, RMSE, SD of errors, max abs | mean error; mean absolute error; root mean square; spread of the errors after removing the bias; worst capture |
| limits of agreement | bias +- 1.96 SD of the errors, over repeated captures of this one phantom (Bland-Altman form; not a population interval) |
| \|bias\| within floor | the bias is not larger than the reference's floor SD: it cannot be told apart from reference error |
| n used (produced) | accepted captures with a value (captures that produced a value at all / captures considered) |
| within-session SD, repeatability coefficient | pooled SD of values within a session; 2.77 x that SD (two captures in one session differ by less, 95 % of the time) |
| between-session SD / range | spread of the session means (needs at least two sessions) |
| bias shift vs baseline | a condition's bias minus the baseline captures' bias |
| surface distance | reconstruction -> reference on observed and implied vertices only (board-plane, cut and box vertices apart); reference (base excluded) -> reconstruction; signed mean + = outside; Hausdorff = the larger maximum; coverage = share of the reference's non-base area within the threshold |
| device figures | durations, peak heap, errors, WebGL context losses and export success per device and browser, as measured; no verdict |

## Test phantom from the synthetic hand (optional)

`npx tsx scripts/capsule-phantom-stl.ts --out <study>\capsule.stl [--voxel 0.5] [--wrist-stub 20]` writes an STL of the
capsule hand with a flat base at the palm plane (it rests on the board like the simulated hand), in the board frame, and
a `.design.json` of its design values. **Design values are not reference values**: print it, mark the wrist and knuckle
datum lines, measure the printed part with calipers and use those readings. The fingers float above the board (they lie
at mid-palm height), so the print needs supports and a visual hull fills the space under them. Voxel 1 mm gives about
390 000 triangles (19 MB).

## Tests

`npx vitest run --no-file-parallelism src/experimental/validation` (from `frontend/`). Every unit test uses the
hand-written fixtures of `__fixtures__/`. `roundTrip.test.ts` is the **SIMULATED** round trip: rendered photos of the
synthetic capsule hand -> the real chain -> the page's real `exportZip.ts` -> this tool, against a reference built from
the scene's exact dimensions (phantom id `synthetic-capsule-board-hand`); the report is printed to the test output only,
never written to the docs. It shows the bookkeeping works on clean renders; it is not an accuracy.
