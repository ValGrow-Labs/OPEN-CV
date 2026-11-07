# Smartphone 3D hand reconstruction: licensing, devices, options and validation

Research notes for a US glove manufacturer's smartphone-only hand-measurement product. Written **2026-11-07**. Documents only: no code was written,
nothing was run, no customer data is involved. "UNVERIFIED" always means I could not confirm it from a primary source and it needs legal or vendor confirmation
(the full list is at the end of this file).

## The documents

| Document | Answers |
|---|---|
| [`CONSOLIDATED_FINDINGS.md`](CONSOLIDATED_FINDINGS.md) | **Start here.** All research and engineering passes merged: segmentation comparison, pose and marker-sheet strategy, what the reconstruction can and cannot recover, measured vs model-based, licences re-checked against primary sources, Android/iOS limits, architecture and phased plan |
| [`LICENSING.md`](LICENSING.md) | Which models, datasets and libraries can be used in a **commercial** product, which are blocked, and a "safe path" |
| [`DEVICE_COMPATIBILITY.md`](DEVICE_COMPATIBILITY.md) | What an ordinary phone web page can and cannot get (camera controls, intrinsics, WebXR depth, ARCore, ARKit/LiDAR), with a matrix and the no-depth fallback |
| [`DEPTH_AND_RECONSTRUCTION_OPTIONS.md`](DEPTH_AND_RECONSTRUCTION_OPTIONS.md) | Multi-view RGB vs ARCore/ARKit depth vs learned depth vs parametric models; guided capture designs; what silhouettes can and cannot measure |
| [`VALIDATION_PLAN.md`](VALIDATION_PLAN.md) | The study needed before any accuracy claim, aligned with the repository's existing validation, consent and privacy documents |

How they fit: the **options** document says what could work; **device compatibility** says which phones can do it; **licensing** says which parts we may legally ship;
the **validation plan** says how we would find out, honestly, whether any of it measures a hand correctly. Read the repository's own `docs/VALIDATION_PLAN.md` first: this plan extends it.

## Top ten findings, in plain language

1. **Every public 3D-hand dataset I checked is non-commercial** (FreiHAND, InterHand2.6M, HO-3D, DexYCB, COCO-WholeBody, HGR1). A commercial product needs its **own consented dataset**,
   which is also the only data that can validate accuracy.
2. **MANO and SMPL-X, the standard parametric hand and body models, are non-commercial**, and their licence also forbids training commercial models with them. Anything built on them
   (HaMeR) inherits that. A commercial licence has to be bought from the Max Planck side, or we build our own model from our own scans.
3. **Several attractive models cannot be used commercially as published:** Depth Anything V2 Base/Large/Giant (CC BY-NC), Depth Pro's weights (research-only Apple licence), EdgeSAM (non-commercial),
   FrankMocap (CC BY-NC), 3D Gaussian Splatting and instant-ngp (non-commercial). FastSAM and OpenMVS are AGPL (copyleft, a problem for a closed product).
4. **A commercially clean stack exists today:** MediaPipe's hand model and its `magic_touch` segmenter (Apache-2.0 model cards), OpenCV, three.js, Open3D, COLMAP, SAM 2 and MobileSAM weights, and Depth Anything V2 *Small*.
   A hand-specific segmentation model trained on our own consented data is the cleanest long-term route.
5. **iPhone customers on the web cannot get depth.** Safari on iOS has no WebXR; LiDAR depth needs a native app and a LiDAR iPhone/iPad. For web users the baseline is **RGB only**.
6. **Android depth is wide but weak at hand distance.** Google says over 88% of active Android devices support the ARCore Depth API (May 2026), no ToF sensor needed, but accuracy is documented as best from
   0.5 m to about 5 m. A hand is scanned at 25 to 40 cm, **below that range**, and no accuracy figure for hands was found.
7. **The web gives no camera intrinsics, and one coin gives the scale of one plane, not a camera model.** Metric multi-view 3D needs a printed marker sheet, self-calibration, or platform depth. Scale per pixel is not accuracy:
   0.1 mm per pixel never means 0.1 mm measurement accuracy.
8. **Silhouettes cannot recover concavities.** From RGB only, thickness and breadth can be direct measurements, but a circumference is model-based (or an upper bound); a direct circumference needs depth that covers the whole cross-section.
   Even 3D scanners disagree with tape circumference by a few percent in published studies.
9. **Learned depth is a model's guess**, relative or metric; no validation on hands was found. Treat it as visualisation until measured against calipers.
10. **No accuracy claim is possible yet.** The plan is staged: synthetic arithmetic checks (never accuracy), rigid phantoms with known dimensions, a pilot (descriptive), then a held-out study of at least 120 people with
    acceptance criteria **the client sets in advance**; nothing reaches sizing until at least 60 held-out participants meet them and a person signs.

## Open questions for the client

1. **Budget and appetite for a commercial licence** for a MANO-class hand model (or for building our own from consented scans)?
2. **Will customers accept a printed marker sheet** (with the coin) for metric scale and camera pose? It is the most reliable way to a metric multi-view capture; the alternative is weaker.
3. **Which phones and OS versions must work?** Is an **iPhone depth experience** required (that means a native app) or is RGB-only acceptable for iPhone?
4. **How exactly is hand circumference defined** on the client's size chart: open hand or fist, below the knuckles, with or without the thumb, tape or caliper? It decides what can be measured at all.
5. **Acceptance criteria:** the largest error per measurement, per customer group, that still gives a correct or acceptable adjacent size.
6. **Is a 3D reference scanner available** (to validate surface area and completeness)? If not, surface area cannot be validated.
7. **Legal and privacy review:** biometric-law assessment (palm and fingertip images can reveal ridges), consent text for an image study, retention and deletion, and whether images may leave the phone at all.
8. **May processing run on a server** (more compute, but images leave the device) or must it all run on the phone?
9. **Data collection:** who recruits and measures, how many hands, and by when?

## Every item marked UNVERIFIED (needs legal or vendor confirmation)

Licences:
* Google MediaPipe: DeepLab v3, selfie and hair segmenter model cards (not retrieved); training-data terms of HandLandmarker and `magic_touch`.
* The OpenCV.js bundled binary: which optional modules it contains and their licences.
* SAM: the SA-1B dataset licence text (not opened; treated as research-only).
* MiDaS weights; ZoeDepth training-data terms; Depth Anything V1 weights; Depth Anything V2 Metric variants; Marigold model licence full text (RAIL++-M); Metric3D weights.
* HaMeR released checkpoint terms.
* Datasets: FreiHAND and HGR1 (primary pages not read; summaries only); HaGRID (custom licence, commercial conditions unclear) and any HaGRID mask extensions; EgoHands (original page showed no licence; a re-host says CC BY 4.0); GTEA (none found).
* OpenMVG bundled third-party code; whether a commercial licence exists for OpenMVS or FastSAM.
* ARCore and ARKit SDK terms (not read).
* Whether a model's training-data licence binds users of the weights (legal question, applies to all learned models).

Devices and technology:
* Camera intrinsics from any web API or still-photo EXIF; per-phone autofocus, exposure and lens behaviour; remaining lens distortion per phone.
* WebXR camera-access support alongside depth on Android Chrome; which projection data ARCore through WebXR gives the page.
* ARCore depth accuracy for a hand at 25 to 40 cm and its depth-image resolution; the list of ToF phones; newer LiDAR iPhone and iPad models.
* Performance on real phones (tracker fps, WASM/WebGL limits, thermal throttling); whether the bundled OpenCV.js has ArUco or other marker modules.
* Any published numbers on hand posture, finger-spread and soft-tissue effects on glove-relevant dimensions.

Standards:
* The text of ISO 7250-1:2017, ISO 20685 and EN ISO 21420:2020 (only titles and manufacturer summaries were read); the exact glove-size circumference definition (open hand or fist).
