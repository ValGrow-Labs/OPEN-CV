# Licensing review: components for a commercial smartphone hand-measurement product

**Not legal advice.** This is an engineering review of licence texts, so that legal counsel has a short list to confirm.
The product is **commercial** (a US glove manufacturer's customer-facing tool), so licences that allow only research or
non-commercial use are **blockers**. All sources below were read on **2026-11-07**. "Read" means the licence file or
vendor page itself, except where a row says it came through a search summary; those rows are marked
`UNVERIFIED`. Where I could not confirm something from a primary source the verdict is `UNVERIFIED: needs legal/vendor confirmation`.

Verdicts: **ok** (permissive, no conditions beyond keeping the notice), **ok with conditions**, **blocked**, **UNVERIFIED**.

Three rules that apply to every row:

1. **Code, weights and training data have separate licences.** A permissive code licence does not make the weights
   permissive, and a dataset's licence does not automatically bind a model trained on it (whether it does is a legal
   question: `UNVERIFIED: needs legal/vendor confirmation`). The MANO licence is explicit that it does bind: it also prohibits using the data
   "to train methods/algorithms/neural networks/etc. for commercial ... use".
2. **A library's licence does not cover its dependencies.** COLMAP's own LICENSE says so in its first lines.
3. **Check the licence of the exact file you download**, at the time you download it. Licences change between
   releases (the OpenCV repository now reports Apache-2.0 on its default branch).

## 1. Already in this repository (read from `frontend/node_modules`, 2026-11-07)

| Component | Licence | Verdict | Obligations | Source |
|---|---|---|---|---|
| `@mediapipe/tasks-vision` 0.10.35 | Apache-2.0 (package.json) | ok with conditions | Keep licence and NOTICE, state changes | this repo, `frontend/node_modules/@mediapipe/tasks-vision/package.json` |
| `@techstark/opencv-js` 4.10.0-release.1 (wrapper of OpenCV.js) | Apache-2.0 (package.json) | ok with conditions | Keep licence and NOTICE | this repo, `frontend/node_modules/@techstark/opencv-js/package.json` |
| `three` 0.170.0 | MIT (package.json) | ok | Keep the copyright notice | this repo, `frontend/node_modules/three/package.json`; https://github.com/mrdoob/three.js/blob/dev/LICENSE |
| `public/opencv/opencv.js` (the bundled build) | Apache-2.0 for OpenCV itself | ok with conditions; **UNVERIFIED** which optional modules the binary contains and whether any carry another licence | Keep notice | https://github.com/opencv/opencv/blob/5.x/LICENSE |
| `public/models/hand_landmarker.task` | Apache-2.0 (model card, below) | ok with conditions | Keep notice; the card is the licence statement | see section 2 |

## 2. Google MediaPipe code and models

| Component | Licence found | Verdict | Obligations / notes | Source |
|---|---|---|---|---|
| MediaPipe (code) | Apache-2.0 | ok with conditions | Keep licence and NOTICE, state changes | https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE |
| HandLandmarker model (21 landmarks, hand and world) | Model card: "LICENSED UNDER Apache License, Version 2.0" | ok with conditions | The card states intended use (landmarks in a crop of prominently displayed hands). Training-data terms: **UNVERIFIED** | https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf |
| Interactive Segmenter, `magic_touch` (6 MB, point-prompted object mask) | Model card (dated Mar 13, 2023): "LICENSED UNDER Apache License, Version 2.0" | ok with conditions | Intended use "object segmentation"; a generic object model, not hand-specific. Training-data terms: **UNVERIFIED** | https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MagicTouch.pdf |
| Image Segmenter, multiclass model (hair, body, face, clothes, others; people only) | Model card: Apache-2.0 | ok with conditions | No hand class | https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf |
| Image Segmenter, DeepLab v3, selfie and hair models | **UNVERIFIED**: their cards were not retrieved (the docs page links cards for selfie, hair and multiclass only) | UNVERIFIED | Confirm the card for the exact file | https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter |
| MediaPipe documentation text and samples | Content CC BY 4.0, code samples Apache-2.0 (page footer) | ok with conditions | Attribution if the text is reproduced | https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker |

## 3. Segmentation models

| Component | Licence found | Verdict | Obligations / notes | Source |
|---|---|---|---|---|
| Segment Anything (SAM), code | Apache-2.0 | ok with conditions | Keep notice | https://github.com/facebookresearch/segment-anything/blob/main/LICENSE |
| SAM weights | README: "The model is licensed under the Apache 2.0 license"; Hugging Face `facebook/sam-vit-base` metadata: apache-2.0 | ok with conditions | Large encoders (tens to hundreds of MB) are heavy for a phone | https://raw.githubusercontent.com/facebookresearch/segment-anything/main/README.md ; https://huggingface.co/api/models/facebook/sam-vit-base |
| SA-1B dataset | README: "SA-1B Dataset Research License". The licence text itself could not be opened | UNVERIFIED (treat as research-only; a third-party summary says commercial use is prohibited) | Not needed for inference | https://raw.githubusercontent.com/facebookresearch/segment-anything/main/README.md |
| SAM 2, code | Apache-2.0 | ok with conditions | Keep notice | https://github.com/facebookresearch/sam2/blob/main/LICENSE |
| SAM 2 weights | Hugging Face metadata `facebook/sam2-hiera-tiny` and `facebook/sam2.1-hiera-small`: apache-2.0 (other checkpoints not checked) | ok with conditions | | https://huggingface.co/api/models/facebook/sam2-hiera-tiny |
| MobileSAM | Code Apache-2.0; Hugging Face `dhkim2810/MobileSAM` metadata: MIT | ok with conditions | Two permissive licences are named for code and weights; both allow commercial use | https://github.com/ChaoningZhang/MobileSAM/blob/master/LICENSE |
| EdgeSAM | **S-Lab License 1.0**: "Redistribution and use for non-commercial purpose ... In the event that redistribution and/or use for commercial purpose ... is required, please contact the contributor(s)" | **blocked** (unless written permission) | | https://raw.githubusercontent.com/chongzhou96/EdgeSAM/master/LICENSE |
| FastSAM | Repository LICENSE is **GNU AGPL-3.0** | **blocked** for a closed-source product (network copyleft: offering it as a service requires releasing the corresponding source) | A separate commercial licence is not mentioned in the file I read | https://raw.githubusercontent.com/CASIA-IVA-Lab/FastSAM/main/LICENSE |

## 4. Depth models

| Component | Licence found | Verdict | Obligations / notes | Source |
|---|---|---|---|---|
| MiDaS, code | MIT | ok | Weights: **UNVERIFIED** (the weights' licence was not read; Hugging Face `Intel/dpt-large`, a DPT model of the same family, lists apache-2.0) | https://github.com/isl-org/MiDaS/blob/master/LICENSE |
| ZoeDepth | Code MIT; Hugging Face `Intel/zoedepth-nyu-kitti` metadata: MIT | ok with conditions | Trained on indoor/driving data; no hand evaluation was read. Training-data terms **UNVERIFIED** | https://github.com/isl-org/ZoeDepth/blob/main/LICENSE |
| Depth Anything V1 | Code Apache-2.0 | code ok; **weights UNVERIFIED** (no licence statement in the README, no licence field in the Hugging Face metadata for `vits14`/`vitl14`) | | https://github.com/LiheYoung/Depth-Anything/blob/main/LICENSE |
| Depth Anything V2 **Small** | README: "Depth-Anything-V2-Small model is under the Apache-2.0 license"; Hugging Face agrees | ok with conditions | Relative (not metric) depth | https://raw.githubusercontent.com/DepthAnything/Depth-Anything-V2/main/README.md ; https://huggingface.co/api/models/depth-anything/Depth-Anything-V2-Small-hf |
| Depth Anything V2 **Base / Large / Giant** | README: "Base/Large/Giant models are under the CC-BY-NC-4.0 license"; Hugging Face agrees for Base and Large | **blocked** | | same README |
| Depth Anything V2 **Metric** variants | No licence in the Hugging Face metadata or README text I read | UNVERIFIED (treat as non-commercial until confirmed) | | https://huggingface.co/depth-anything/Depth-Anything-V2-Metric-Indoor-Large-hf |
| Depth Pro (Apple) | Code: Apple sample-code licence (use, reproduce, modify, redistribute; keep the notice). **Weights: "Apple Machine Learning Research Model" licence, "exclusively for Research Purposes"** | code ok with conditions; **weights blocked** | | https://raw.githubusercontent.com/apple/ml-depth-pro/main/LICENSE ; https://huggingface.co/apple/DepthPro/raw/main/LICENSE |
| Marigold | Code Apache-2.0; README: models under **RAIL++-M** (`LICENSE-MODEL.txt`); the LCM variant on Hugging Face lists apache-2.0 | code ok with conditions; model **UNVERIFIED** (OpenRAIL allows commercial use with use restrictions that must be passed on; I did not read the full model licence) | Diffusion model: far too heavy for a phone | https://raw.githubusercontent.com/prs-eth/Marigold/main/README.md |
| Metric3D | Code BSD-2-Clause; README adds "For further commercial inquiries, please contact" the authors | code ok; **weights UNVERIFIED** | | https://github.com/YvanYin/Metric3D/blob/main/LICENSE |

## 5. Hand models and hand-pose software

| Component | Licence found | Verdict | Notes | Source |
|---|---|---|---|---|
| **MANO** | "Software Copyright License for non-commercial scientific research purposes". Any other use "in particular any use for commercial ... purposes is prohibited. This includes ... incorporation in a commercial product, use in a commercial service". Also prohibits training methods for commercial use. Commercial licensing: ps-license@tue.mpg.de | **blocked** (needs a commercial licence from the Max Planck side; terms and price unknown) | | https://mano.is.tue.mpg.de/license.html |
| **SMPL-X** | Same wording ("academic research purposes"); "also available for commercial licensing through Meshcapade.com"; contact smpl@max-planck-innovation.de | **blocked** (needs a commercial licence) | | https://smpl-x.is.tue.mpg.de/modellicense.html |
| HaMeR | Code MIT; README: you "also need to download the MANO model" after registering on the MANO site | **blocked in practice** (it cannot run without MANO). Whether the released checkpoint carries its own terms: **UNVERIFIED** | | https://github.com/geopavlakos/hamer/blob/main/LICENSE.md ; https://raw.githubusercontent.com/geopavlakos/hamer/main/README.md |
| FrankMocap | **CC BY-NC 4.0** (the LICENSE file is the Creative Commons NonCommercial text) | **blocked** | | https://raw.githubusercontent.com/facebookresearch/frankmocap/main/LICENSE |
| Google's hand pose | = HandLandmarker, section 2 | ok with conditions | Gives 21 landmarks and world landmarks, not a surface | section 2 |

## 6. Datasets (for training or evaluating; all would be new data for a commercial product)

| Dataset | Licence found | Verdict | Source |
|---|---|---|---|
| FreiHAND | Official page (as reported by a search summary; the page body could not be fetched): research use only, commercial use prohibited, cite the paper | **blocked**; primary read **UNVERIFIED** | https://lmb.informatik.uni-freiburg.de/projects/freihand/ |
| InterHand2.6M | LICENSE file is the Creative Commons **Attribution-NonCommercial 4.0** text | **blocked** | https://raw.githubusercontent.com/facebookresearch/InterHand2.6M/main/LICENSE |
| HO-3D | README: "for academic research only ... not redistribute, modificate, or commercial usage" | **blocked** | https://raw.githubusercontent.com/shreyashampali/ho3d/master/README.md |
| DexYCB | Data: "licensed under CC BY-NC 4.0"; toolkit: GPL-3.0 | **blocked** (data) | https://dex-ycb.github.io/ ; https://raw.githubusercontent.com/NVlabs/dex-ycb-toolkit/master/README.md |
| HaGRID | Custom licence ("a variant of Creative Commons Attribution-ShareAlike 4.0", the PDF says "This license is not a Creative Commons license", elements "with attribution and conditions reserved"). I found no explicit non-commercial clause in the extracted text but the text extraction may be incomplete and "conditions reserved" is not defined in what I read | **UNVERIFIED** (legal read needed; share-alike obligations likely) | https://raw.githubusercontent.com/hukenovs/hagrid/master/license/en_us.pdf |
| HaGRID mask extensions | Not investigated | UNVERIFIED | |
| EgoHands | The original Indiana University page did not show a licence in what I could read. A Roboflow re-host lists CC BY 4.0 (secondary) | **UNVERIFIED** | http://vision.soic.indiana.edu/projects/egohands/ |
| HGR1 (hand gestures, with skin masks) | Page (via search summary): free for research, non-commercial purposes, cite the papers | **blocked**; primary read **UNVERIFIED** | https://sun.aei.polsl.pl/~mkawulok/gestures/ |
| GTEA | No licence found | UNVERIFIED | |
| COCO-WholeBody | README: "ONLY for research and non-commercial use"; annotations CC BY-NC (the README links `by-nc/4.0`); images carry Flickr terms | **blocked** | https://raw.githubusercontent.com/jin-s13/COCO-WholeBody/master/README.md |
| Open Images | Annotations CC BY 4.0 ("by Google LLC"); images "listed as having a CC BY 2.0 license" (Google notes it cannot guarantee each image) | ok with conditions (attribution; check per-image licences) | https://storage.googleapis.com/openimages/web/factsfigures_v7.html |

Consequence: **every public dataset with 3D hand ground truth that I checked is non-commercial.** A commercial
product needs its **own consented dataset** anyway (also the only valid validation data; see `VALIDATION_PLAN.md`).

## 7. Reconstruction and 3D code

| Component | Licence found | Verdict | Notes | Source |
|---|---|---|---|---|
| COLMAP | "new BSD licence" (BSD-3-Clause); "Building COLMAP with these dependencies may affect the resulting COLMAP license" | ok with conditions | Check the licence of the build's dependencies (CUDA, optional GPL libraries) | https://raw.githubusercontent.com/colmap/colmap/main/LICENSE |
| OpenMVG | MPL-2.0 (GitHub licence detection) | ok with conditions (file-level copyleft: modified MPL files must be shared) | Bundled third-party code: **UNVERIFIED** | https://github.com/openMVG/openMVG/blob/develop/LICENSE |
| OpenMVS | **AGPL-3.0** | **blocked** for a closed-source product (a commercial licence is not mentioned in what I read) | | https://github.com/cdcseacave/openMVS/blob/develop/LICENSE |
| Open3D | MIT | ok | Keep the notice | https://raw.githubusercontent.com/isl-org/Open3D/main/LICENSE |
| AliceVision / Meshroom | MPL-2.0 with some MIT, BSD components (COPYING.md lists the third-party parts) | ok with conditions | MPL file-level copyleft | https://raw.githubusercontent.com/alicevision/AliceVision/develop/COPYING.md |
| instant-ngp | NVIDIA Source Code License §3.3: the Work "only may be used or intended for use non-commercially" (non-commercially = "for research or evaluation purposes only"); NVIDIA may use it commercially | **blocked** | | https://raw.githubusercontent.com/NVlabs/instant-ngp/master/LICENSE.txt |
| Nerfstudio | Apache-2.0 | ok with conditions | It bundles or wraps methods with their own licences; check each method | https://github.com/nerfstudio-project/nerfstudio/blob/main/LICENSE |
| 3D Gaussian Splatting (Inria) | Gaussian-Splatting License: "THE USER CANNOT USE, EXPLOIT OR DISTRIBUTE THE SOFTWARE FOR COMMERCIAL PURPOSES"; research, evaluation and testing only | **blocked** (confirmed from the licence text) | | https://raw.githubusercontent.com/graphdeco-inria/gaussian-splatting/main/LICENSE.md |
| Kornia | Apache-2.0 | ok with conditions | | https://github.com/kornia/kornia/blob/main/LICENSE |
| PyTorch3D | BSD (Meta) | ok with conditions | | https://raw.githubusercontent.com/facebookresearch/pytorch3d/main/LICENSE |

## 8. Platform SDKs (not read)

ARCore (Depth API) and ARKit (scene depth, LiDAR) are platform SDKs under Google's and Apple's developer terms.
**UNVERIFIED: needs legal/vendor confirmation** (the terms were not read in this review). They also need a native app on iOS (see `DEVICE_COMPATIBILITY.md`).

## 9. The safe path today

Clearly usable commercially (subject to keeping notices and a legal read of the `UNVERIFIED` items):

* **Hand tracking:** MediaPipe HandLandmarker (Apache-2.0 model card).
* **Segmentation:** MediaPipe `magic_touch` (Apache-2.0 card), OpenCV classical methods (Apache-2.0), SAM 2 and MobileSAM weights
  (Apache-2.0/MIT) as candidates or as an offline labelling aid. A **custom model trained on our own consented data** is the
  cleanest long-term route and the only one tuned to hands.
* **Rendering and geometry:** three.js (MIT), Open3D (MIT), COLMAP (BSD-3-Clause) for offline structure-from-motion experiments, AliceVision (MPL-2.0).
* **Depth:** Depth Anything V2 **Small** (Apache-2.0) as a *relative* depth research baseline only; platform depth (ARCore/ARKit) once the SDK terms are confirmed.

Needs a **licence purchase, written permission, or a clean-room replacement**:

* **MANO, SMPL-X and everything built on them (HaMeR and similar):** commercial licence from the Max Planck side (MANO: ps-license@tue.mpg.de; SMPL-X via Meshcapade).
  Alternative: build our own low-dimensional hand model from our own consented scans (needs data and time), or use a simple scaled template.
* **Depth Pro weights, Depth Anything V2 Base/Large/Giant, 3DGS, instant-ngp, EdgeSAM, FrankMocap:** non-commercial; replace or obtain permission.
* **FastSAM, OpenMVS:** AGPL; use only if the whole product is released under the AGPL, or buy a licence.
* **All public 3D-hand datasets (FreiHAND, InterHand2.6M, HO-3D, DexYCB, COCO-WholeBody, HGR1):** research only; collect our own data with consent.

Open questions are collected in `README.md`.
