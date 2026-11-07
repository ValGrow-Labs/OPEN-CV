# Depth and reconstruction options for a smartphone hand-measurement product

Sources read on **2026-11-07**. Statements marked *(judgement)* are engineering reasoning, not citations; anything
I could not confirm says `UNVERIFIED`. No option below has been tested on real phones or real hands in this project.
The existing product (coin on the palm, MediaPipe landmarks, guided palm / back / side views) stays the baseline.

## 1. The options side by side

| Option | What it can give | What it needs | Main risks | Commercial licence status |
|---|---|---|---|---|
| **A. Multi-view RGB, visual hull from silhouettes** | A closed volume that contains the hand (the *visual hull*); lengths, breadths and thickness where the hull is tight | A hand mask per view, camera pose per view, metric scale | Hulls cannot represent concavities (section 3); needs accurate poses; the hand moves between views | Own code, plus Open3D (MIT) and OpenCV (Apache-2.0): clear |
| **B. Multi-view RGB, structure-from-motion + dense stereo (SfM/MVS)** | Dense points from texture | Many sharp views, a rigid scene, texture | Skin is low-texture and soft; the hand is not rigid across a 20-60 s capture *(judgement)*. COLMAP (BSD) works offline; OpenMVS is AGPL (blocked) | COLMAP/AliceVision usable; OpenMVS blocked |
| **C. ARCore Depth (Android)** | A depth image in millimetres per frame (depth-from-motion, merged with ToF where present) | A supported phone, WebXR or a native app, a session with camera motion | Documented best range is 0.5 m to about 5 m; a hand at 25-40 cm is **below** it; no hand accuracy figure found (`UNVERIFIED`) | Platform SDK terms `UNVERIFIED` |
| **D. ARKit scene depth / LiDAR (iOS)** | Dense LiDAR depth | A LiDAR iPhone/iPad and a **native app** (no WebXR on iOS Safari) | Few phones; a separate native product | Platform SDK terms `UNVERIFIED` |
| **E. Learned monocular depth** | A dense depth map from one image | A model on the phone or a server; for metric depth, a model trained for it | Relative vs metric (below); no validation on hands in what I read; sharp fingertips and gaps are hard | Depth Anything V2 Small only (Apache-2.0); Depth Pro weights and DA2 Base/Large are non-commercial |
| **F. Parametric hand model fitted to the views** | A complete, plausible hand surface where views are incomplete | A model with a commercial licence, a fitting method | The answer is partly the model's prior, not the customer's hand; **MANO and SMPL-X are non-commercial** | **Blocked** (see `LICENSING.md`) |
| **G. Landmarks only (today)** | Joint-to-joint lengths in the image plane, a posed template for display | Nothing extra | Not skin edges, not thickness, not circumference | Clear |

## 2. Metric depth: what is and is not "physical"

* **Hardware or motion-based depth (C, D)** gives a physical distance per pixel *when the platform's sensor and calibration are
  good*. Google documents ARCore depth as 16-bit millimetres and most accurate from half a metre
  (https://developers.google.com/ar/develop/depth, read 2026-11-07). The accuracy **at hand distance is not documented in what I read**.
  A phone at 30 cm is outside Google's stated best range, so depth from ARCore must be measured against calipers before it is trusted.
* **Learned monocular depth (E)** comes in two kinds. *Relative* models (for example Depth Anything V2 Small) give an ordering up to an unknown
  scale and shift; they are not physical depth. *Metric* models (Depth Pro: "zero-shot metric monocular depth ... without ... camera intrinsics",
  2.25 megapixels in 0.3 s on a V100 GPU, https://arxiv.org/abs/2410.02073 , read 2026-11-07) predict absolute scale from image cues. A predicted metric depth is
  still a **model prediction**, learned from other scenes; no benchmark on hands at 30 cm was found. Published average errors on general benchmarks would not answer the
  hand question, so I quote none. Treat both kinds as **visualisation until validated**.
* **A coin gives the scale of one plane**, not depth. With a known coin and a model of where the hand surface lies relative to the coin's plane, the
  scale at other heights is *assumed*, which is what `landmark_layer_depth_mm` does today (`docs/VALIDATION_PLAN.md` section 4).

## 3. Silhouettes and circumference: the concavity problem

* The **visual hull** is "the largest object that produces the same silhouettes as the given object" (Laurentini, *The visual hull concept for silhouette-based image
  understanding*, IEEE TPAMI 1994; summary read through a search on 2026-11-07). Only surface parts that also lie on the hull can be recovered from silhouettes;
  concavities hidden in every silhouette cannot (same sources, plus Cremers and Kolev, IEEE TPAMI 2011, who note that silhouette-based approaches cannot reconstruct concavities because these do not affect the silhouettes; paraphrased from a search summary).
* **Consequences for a hand** *(reasoning from that result)*:
  * Thickness at a given place along the hand and breadth across the knuckles are **direct** measurements from the right silhouettes (side and top views) if the
    scale and pose are right. They are as accurate as the mask edge and the scale, not more.
  * A **circumference** is the length of a closed path around a cross-section. Silhouettes bound the cross-section from outside, so the perimeter of a hull cross-section is an
    **upper bound** (it cannot dip into the palm hollow, the base of the thumb or the grooves between knuckles). Using breadth and thickness with an ellipse formula is a **model**
    (the repository proposes exactly this as a hypothesis to test: `docs/VALIDATION_PLAN.md` section 7.4, A3). Neither is a direct measurement.
  * **A direct circumference needs surface points on all sides**: a depth source (C, D) or dense multi-view stereo (B) with good coverage. Even a 3D scanner study found
    circumferences were the weak measurement: a 2020 University of Minnesota comparison reported linear hand lengths agreeing with manual measurement but "a significant difference
    between conventional and automatic surface circumference measurements" of about 4% for hand and wrist circumference, because the automatic tape path wandered
    (found via search: https://www.proc.3dbody.tech/papers/2020/2038bhuyan.pdf and https://proc.3dbody.tech/papers/2020/2041seifert.pdf; I did not read the full papers).
  * **The definition of the circumference matters more than the method.** Glove-size charts in the EN 420 / EN ISO 21420 family use hand circumference and hand length, and the
    manufacturer charts I found describe the circumference "just below the knuckles, excluding the thumb, with the hand in a fist" (secondary, manufacturer size charts such as
    https://cdn.shopify.com/s/files/1/0604/0902/0506/files/MoG_Standard-EN420-size-chart-2.pdf ; the standard's own text is paywalled and was **not read**: `UNVERIFIED`).
    Whether the client's chart means an open hand or a fist changes what can be measured at all (a fist is not a posture a flat-palm silhouette scan captures).
    The client must define it (README, open question 4; also `docs/RISKS_AND_CLIENT_INPUTS.md`, input 2).

## 4. What each measurement needs (realistic from RGB only vs needs depth)

| Measurement | RGB only (A or G) | With reliable depth (C, D) | Basis |
|---|---|---|---|
| Hand length (wrist crease to middle fingertip) | Direct from landmarks or silhouette, if the wrist crease is defined in the mask; scale from the coin | Same, plus 3D length along the surface | The crease is not a silhouette feature: needs a landmark or a model *(judgement)* |
| Palm breadth (knuckle line) | Direct from the mask at the knuckle row (skin edge to skin edge); landmark span is a model | Same | Present system has no skin-edge model (`docs/MEASUREMENT_METHODOLOGY.md`) |
| Finger lengths | Landmark chains (joint centres) or mask tips; both are model-dependent at the base | Along-surface lengths | |
| Hand thickness | Direct from a side-view mask with a valid scale (coin plane vs the hand's own plane differ) | Direct | |
| Circumference (anatomically defined cross-section) | **Model-based** (ellipse from breadth and thickness) or an upper bound from a hull | **Direct** where the surface is covered all around; otherwise model-based | section 3 |
| Projected area | Direct from the mask (px), in mm² only with a scale valid for the whole hand | Same | The coin's scale applies at the coin's plane; fingers sit at other heights |
| 3D surface area | Model-based only | Direct only with dense coverage of palm, back, fingers and sides | A single viewpoint never sees the whole surface |

Always label each number *direct*, *model-based* or *not available*, and never describe an estimate as a measurement. (The shared `Quantity` type in `frontend/src/experimental/common.ts`
carries that label.)

## 5. Parametric hand models

* **What they add:** a statistical prior over hand shape and pose that fills occluded or unobserved surface and regularises noise. MANO-style models make a *complete* mesh from
  sparse evidence. The cost is that **parts of the result come from the prior, not from the customer's hand**, so a measurement taken on a fitted model is a model estimate.
* **Blocker:** MANO and SMPL-X are non-commercial; commercial use needs a licence from the Max Planck side (MANO: ps-license@tue.mpg.de; SMPL-X via Meshcapade).
  HaMeR needs MANO to run. See `LICENSING.md`.
* **Alternatives** *(judgement)*: (1) buy the commercial licence; (2) a low-dimensional model built from the manufacturer's **own consented scans** (needs a 3D reference
  scanner and an ethics process, and a lot of hands); (3) a simple scaled template used only for display.
* Evaluate any fitted model **against calipers on held-out people**, never against its own output.

## 6. Guided capture design

Three designs *(judgement)*; the literature I found does not decide between them:

| Design | How | For | Against |
|---|---|---|---|
| **1. Fixed hand, moving phone (orbit)** | The hand rests (forearm supported) on a marked sheet; the user moves the phone around it | Hand pose is consistent across views; poses come from the marker sheet | A user must move a phone steadily around a hand; the hand must stay still for the whole orbit; motion blur; harder to explain |
| **2. Fixed phone, rotating hand** | The phone is propped; the user turns the hand to palm, thumb side, little-finger side and back | Phone is steady and sharp; easy to follow (close to today's flow) | The hand is the moving object: fingers, soft tissue and tremor change between views; poses are unknown (no marker is rigid with the hand), so multi-view geometry is weak |
| **3. Fixed phone, hand laid on a marker sheet in set poses** | Palm and back flat on a printed sheet; side poses against a rest | Marker sheet gives scale and plane pose per view; poses are repeatable if the sheet constrains them | Needs a printed sheet (an ask of the customer); soft tissue flattens on the sheet |

* **Views:** open palm, thumb-side profile, little-finger-side profile and back of hand, plus two 45-degree obliques *(judgement)* if the hull is to be reasonably tight. The
  existing flow already captures palm, back and side (`docs/MULTI_VIEW_PLAN.md`). **Capture time** and drop-out for 4 to 6 views: unmeasured.
* **A printed marker sheet with the coin** *(judgement)*: a printed fiducial sheet gives a metric scale and the plane's pose in every view; one coin gives scale at its plane
  and a pose that is ambiguous in sign and in-plane rotation. Whether the bundled OpenCV.js build includes ArUco or other marker modules: `UNVERIFIED` (check `typeof cv.aruco` at runtime).
  Whether the client accepts a printed sheet: README, open question 3.
* **Pose consistency** across views can be *measured*, not assumed: compare finger lengths, knuckle spans and landmark-to-landmark ratios between views of the same hand; large drift
  means the views do not describe one rigid shape. Published guidance on hand posture and finger spread effects on measurements: **none found** (`UNVERIFIED`); the one comparison
  found (the Minnesota papers above) concerns scanner type and circumference, not posture.
* **Soft-tissue deformation:** pressing the hand on a surface or squeezing a caliper changes thickness and breadth; I found no primary source with numbers for glove-relevant
  dimensions (`UNVERIFIED`), so the validation protocol must fix the posture and the caliper pressure and report repeatability (`VALIDATION_PLAN.md`).

## 7. Recommended order of work *(judgement)*

1. A **hand mask** (segmentation) first: every option above depends on it, and it can be judged against hand-traced masks.
2. **Silhouette measurements** (hull, thickness, breadth) on controlled captures with a marker sheet; synthetic tests prove the geometry code, real captures with calipers prove accuracy.
3. **Depth sources** (ARCore, then LiDAR in a native app if the client needs iPhone depth) measured against calipers at hand distance.
4. **Parametric model** only after a licensing decision.

Nothing here replaces the validation plan: no accuracy claim until the held-out study (`VALIDATION_PLAN.md`).
