# Audit: what is 3D today, and what is not (2026-11-08)

Written before any change for the full-reconstruction work, from the code as it stands. Plain answer first: **nothing
the app or the experiments show on a real phone today is a reconstructed 3D hand.** The pieces that are genuinely 3D
(the visual-hull engine) have only ever run on a synthetic hand.

## 1. The production scan (customer app)

| Question | Answer, from the code |
|---|---|
| What is drawn over the camera | The 21 MediaPipe hand landmarks as a skeleton (`src/hand3d/HandOverlayCleanGL.tsx`), placed on the 2D image landmarks. |
| The "3D" card | MediaPipe **world landmarks** (`src/hand3d/LandmarkViewer*.tsx`): 21 points in metres around the hand's centre, **estimated by a neural network from one image**. Not measured. Its caption already says "Live 3D landmark skeleton from hand tracking, not a reconstructed surface". |
| Measurements | 2D: landmark distances in the image, scaled by the coin (mm per pixel at the coin's plane). No depth is used. |
| Surface, thickness, volume | None. |

## 2. The dense dot scan (experiment, `frontend/src/experimental/densescan/`)

| Question | Answer, from the code |
|---|---|
| Does each point have X, Y, Z? | X and Y in **camera pixels** (`SurfacePoint.x, y`). `z` is `null` by default (`points.ts`: `depth: "none", z: null`). |
| What is Z when present? | **MediaPipe's relative landmark depth**, interpolated from the 21 landmarks onto the dots (`useDenseScan.ts`, labelled `depth: "estimated"`). Relative units, **not millimetres, not measured**. A `"measured"` kind exists in the types for a real metric depth map, but **nothing in the browser ever supplies one**, so no dot is ever measured. |
| What do the points represent? | A **2D sampling of the visible side of the hand's silhouette** in one frame: a lattice of pixels inside the GrabCut mask. Not a surface point cloud, not 3D geometry. |
| Does the mesh have front, back and sides? | **No.** One flat sheet: lattice triangles in the image plane, `z = 0` (`mesh.ts`: "Flat mesh in the image plane (z = 0): a coverage map of the visible hand, NOT a 3D surface"). No back, no sides, not closed. |
| Is palm thickness observed? | **No.** Reported as "not available" (`measure.ts`). Nothing synthetic is filled in. |
| Are finger volumes reconstructed? | **No.** Fingers are 2D regions of the mask, labelled from landmarks. |
| Millimetres | Coin-plane scale only: exact at the coin's plane, a model elsewhere. |

So the dense scan is honest about itself, but it is a 2D point overlay. It must not be called a 3D scan.

## 3. The experimental reconstruction engine (`frontend/src/experimental/reconstruction/`)

| Question | Answer |
|---|---|
| Is it real 3D? | **Yes, geometrically**: silhouettes plus camera poses, then a carved visual hull, then a closed triangle mesh with front, back, sides and fingers, measured in mm (thickness, circumference, finger lengths, area), each value tagged direct, model or none. |
| On what data has it run? | **Only a synthetic capsule hand** with exact, hand-made silhouettes and exact camera poses. **It has never received a real photo.** |
| What it lacks for a real phone | Camera intrinsics (a web page gets none), a camera pose per view (a coin cannot give one), a capture flow where the hand stays rigid, and real multi-view masks. |
| Gate defect found in this audit | A ring of views from one side only (all cameras above the hand) was **accepted** by the quality gates while the thickness was 22 to 28 mm too large. The gates are fixed (section 5). |

## 4. The four-view capture prototype (`frontend/src/experimental/capture/`)

Collects four views by **turning the hand** in front of a fixed phone, with the coin as the only reference. That gives
neither a camera pose per view (one circle cannot) nor a rigid hand (the pose changes between views), so its captures
cannot feed the reconstruction engine. It remains useful for segmentation data.

## 5. Changed after this audit (all experimental, isolated)

* **Capture design decided by simulation** (`reconstruction/captureGeometry.test.ts`, SIMULATED):
  * cameras all on one side of a free hand cannot bound its far side: thickness +22 to +28 mm;
  * a hand **resting palm-down on a printed board** with a **low ring of views (about 12 degrees above the board) all
    round plus one view from straight above**: thickness about +3 mm and knuckle circumference within about 2 mm on the
    synthetic hand (16 to 24 views);
  * the same resting hand with only 45-degree views: thickness +15 mm, so low views are required.
  The palm side is then **bounded by the board plane, not observed**, and is labelled as such per vertex.
* **Two new quality gates** (`reconstruction/quality.ts`): `sides_not_observed` (the lowest view is more than 20 degrees
  above the hand's plane) and `hull_truncated_by_volume` (more than 5 % of the hull's surface lies on undeclared faces of
  the search box). Per-vertex labels `vertexSupport`: observed, implied, support plane, volume cut, truncated.
* **A printed metric marker board** (`experimental/board/`): A4, own marker dictionary, layout, printable SVG.

Nothing in production changed: the customer scan, coin calibration, measurement and quality gates are untouched.

## 6. Status after the build (2026-11-08, end of day)

Built, experimental and isolated (`frontend/src/experimental/{board,multiview,recon}/`, dev-only pages under
`frontend/experiment/`; `vite build` ships none of it, checked by building and searching the bundle):

| Deliverable | Where | State |
|---|---|---|
| 1. Audit | this file | done |
| 2. Multi-view capture (still hand, moving phone, coverage guide, auto-capture, gating) | `recon/page/`, `/experiment/recon/` | built; browser-tested with a SIMULATED fake-camera orbit |
| 3. Camera pose per view | `board/detect.ts`, `board/pose.ts`, `recon/chain.ts` (`consistentMarkers`) | built; SIMULATED pose error 0.14 degrees worst over 16 views |
| 4. Metric calibration | `board/calibrate.ts` (Zhang self-calibration), `board/coinCheck.ts` (coin vs printed board) | built; SIMULATED focal error 0.1 %; coin check reads a 100 % print within about 1 % |
| 5. 3D point cloud | `multiview/reconstruct.ts` (`pointCloud`, board mm, per-point support label) | built |
| 6. Full triangle mesh (back, sides, fingers, gaps where visible; palm side bounded by the board) | `reconstruction/` visual hull + `vertexSupport` labels | built |
| 7. Interactive viewer (360 degrees, zoom, presets, surface / wireframe / points, support and confidence colours, optional skeleton) | `reconstruction/MeshViewer*.tsx` | built; screenshots checked |
| 8. Measurements with basis (direct / model / none) | `reconstruction/measure.ts`, page table | built; one-view landmark fallback added |
| 9. Limitations and physical validation plan | `VALIDATION_PLAN.md` section 12, `NATIVE_DEPTH_OPTIONS.md`, the READMEs | written |

SIMULATED end to end from pixels only (`recon/chain.test.ts`, synthetic capsule hand, 17 rendered 1280 x 720 photos,
nothing told to the chain): length +0.0, breadth +1.6, thickness +2.5, knuckle circumference +2.1 mm; with landmarks in
the top view only: length -4.8, breadth +0.9, thickness +2.5, circumference +0.5 mm. **Not a real-world accuracy.**

Not done, and needed before any claim: a printed board and a real phone; real hands; rigid phantoms measured with
calipers (G1); glare, paper curl, rolling shutter, video compression and real shadows are not modelled; phone timing and
memory are not measured; the coin's thickness is not in the settings (the coin check assumes 1.5 mm).

## 7. Output audit before the physical phase (2026-11-08)

Checked in code and by `frontend/src/experimental/recon/audit.test.ts` (6 tests, SIMULATED pixels-only capture, all pass):

| Property | Finding |
|---|---|
| XYZ vertices are metric millimetres | Yes: board frame mm (scale from the printed board and the self-calibrated camera); the mesh spans the hand's true extent and nothing lies below the board plane |
| Camera poses from marker observations | Yes: every pose from at least 3 mutually consistent markers (`consistentMarkers`), a view without one says why |
| Marker reprojection errors | Yes: calibration RMS (refused above 1.5 px), per-view pose RMS (view dropped above 1.5 px), per-marker residuals (added for the flatness check) |
| Thickness from observed views | Yes, gated: the lowest view must be within 20 degrees of the board (`sides_not_observed`) and the hull must not lie on the search box (`hull_truncated_by_volume`) |
| Board-bounded surfaces distinguished | Yes: per-vertex `support_plane` label, all at the board plane; shown in the viewer and counted in the export |
| Model vs direct | Yes: every landmark-dependent value is basis "model"; nothing landmark-based is called "direct" |
| Circumference and surface area respect the limits | **Defect found and fixed.** The knuckle circumference was labelled like any loop although its palm half is the board plane: now basis "model", note "UPPER BOUND". Surface area summed the whole mesh including the board and forearm faces and was labelled "direct": now **withheld** for a board capture (palm side not observed); the back-and-sides hull area is reported separately as an upper bound (`multiview/reconstruct.ts` `boardLimits`) |
