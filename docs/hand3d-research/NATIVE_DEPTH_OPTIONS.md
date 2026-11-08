# Native depth vs the RGB marker-board method, for a hand at 20 to 45 cm

**Verified on 2026-11-08.** Every source below was opened and read on 2026-11-08, unless the line says otherwise. Anything I could not
confirm from a primary source (official developer documentation, SDK licence file, vendor page, peer-reviewed paper, or the
browser's own source code) is marked `UNVERIFIED` and repeated in the list at the end. Nothing here was measured on a phone or a hand.
Statements marked *(inference)* are my reasoning, not a citation.

This document builds on `DEVICE_COMPATIBILITY.md`, `DEPTH_AND_RECONSTRUCTION_OPTIONS.md`, `LICENSING.md` and `CONSOLIDATED_FINDINGS.md`
(sections 7 and 8), and does not repeat them. New here: depth image resolutions and rates, the ToF device list, intrinsics units,
what Chrome actually implements for WebXR depth, SDK terms, and published close-range accuracy numbers.

## 0. Short answer

* **What the sources say.** Google documents ARCore depth as most accurate from **50 cm** up, typically **160x120 px**, raw depth at about
  **10 updates/s**, and it needs camera motion unless the phone has a ToF sensor. Apple's ARKit LiDAR depth is **256x192 at 60 Hz**. The LiDAR
  emitter projects **576 points**, about **7,225 points per m² at 25 cm**, and its detection limit is about **5 cm** objects, with **±1 cm** accuracy on
  objects larger than 10 cm (Luetzenburg et al. 2021). The only peer-reviewed phone-depth test at hand distance I found (iPhone 15 Pro, about 35 cm, a flat plate)
  reports **3 to 17 mm RMS** errors before correction and a **5.5 % scale error**, dropping to **3 to 8 mm** after a scale correction from known distances (Romanenko and Chibunichev 2025).
  Front TrueDepth face scans agree with clinical scanners to about **1 mm** (two studies). **No peer-reviewed study of phone depth for hand or finger measurement was found.**
* **My conclusion** *(inference, section 6)*: no rear-camera depth source (ARCore depth from motion, Android ToF, iPhone LiDAR) is likely to beat a
  well-executed RGB marker-board reconstruction of **fingers** at 20 to 45 cm. LiDAR and ARCore depth are too coarse at that size. The one candidate that
  might help is the **front TrueDepth camera** (iPhones with Face ID), but its range and accuracy on a hand are undocumented and the capture is awkward (screen facing away from the user).
  For a native app, the **bigger gain is not the depth map. It is what the web cannot give: per-frame intrinsics in pixels, a tracked camera pose, focus control and full-resolution frames.** Feed those into the same marker-board method.
  The decision needs a measured head-to-head test on the same hands and the same reference (section 6.3).

## 1. Android: ARCore (native app)

### 1.1 Depth API (full and raw depth)

| Property | Documented value | Source (read 2026-11-08) |
|---|---|---|
| Method | "The Depth API uses a depth-from-motion algorithm to create depth images"; "If the device has a dedicated depth sensor, such as ToF, the algorithm automatically merges data from all available sources" | https://developers.google.com/ar/develop/depth |
| Needs the phone to move? | "Depth data becomes available when the user moves their device." "Depth data will not be available if there are no tracked feature points. This can happen when there is no motion". A ToF sensor "enables depth even when the camera is not moving" | same page; https://developers.google.com/ar/develop/java/depth/developer-guide |
| Static vs moving scene | `AUTOMATIC` mode "Provides depth estimation for every pixel in the image, and works best for static scenes. Adds significant computational load." | https://developers.google.com/ar/reference/java/com/google/ar/core/Config.DepthMode |
| Resolution | "typically around 160x120 pixels, with higher resolutions up to 640x480 on some devices. These sizes may change in the future." Raw and full depth are the same size | https://developers.google.com/ar/reference/java/com/google/ar/core/Frame (`acquireDepthImage16Bits`, `acquireRawDepthImage16Bits`) |
| Format, units | 16-bit unsigned, millimetres, 0 = no data, range 0 to 65535 mm. Values are depth along the optical axis, "not the length of the ray" | Frame reference; developer guide |
| Frame rate | Full depth: one image per frame, but "If an up-to-date depth image isn't ready for the current frame, the most recent depth image" is returned. Raw depth: "Typically there are about 10 updates to the raw depth data per second"; frames in between are 3D reprojections | Frame reference |
| Documented range | Overview: "robust, accurate depth estimates from 0 to 65 meters"; "most accurate results come when the device is half a meter to about five meters away". Frame reference: "Optimal depth accuracy occurs between 500 millimeters (50 centimeters) and 15000 millimeters (15 meters)", "reliably observed up to 25000 millimeters". The two pages differ on the upper bound; both give **50 cm** as the start of the optimal range | overview page; Frame reference |
| Accuracy at 20 to 50 cm | **No figure published.** Only qualitative: "Surfaces with few or no features, such as white walls, will be associated with imprecise depth"; raw-depth "confidence in areas of the image close enough to the camera will likely be higher" | overview; https://developers.google.com/ar/develop/java/depth/raw-depth |
| Raw depth | "higher accuracy" than full depth, sparse, with an 8-bit confidence image (0 to 255); "removing depth pixels below a confidence threshold of half confidence (128) tends to work well"; compute cost "about half" of full depth | raw-depth guide; Frame reference |
| Device support | "Not all ARCore-compatible devices support the Depth API due to processing power constraints"; check with `isDepthModeSupported`. "As of May 2026, over 88% of active devices support the Depth API" | developer guide; https://developers.google.com/ar/devices |
| Devices with a hardware ToF sensor (Google's list, "Supports time-of-flight (ToF) hardware depth sensor") | LG V60 ThinQ, V60 ThinQ 5G; Samsung Galaxy A80, Note10+, Note10+ 5G, S10 5G, S20 Ultra 5G, S20+, S20+ 5G; Sharp AQUOS R5G. All other Depth-API phones use depth from motion only | https://developers.google.com/ar/devices |
| Focus | ARCore's default focus mode is `FIXED` ("the default desired focus mode is currently" FIXED). Chrome's ARCore code switches to auto focus for image tracking because "The default fixed focus mode has trouble tracking close images since they end up blurry" | https://developers.google.com/ar/reference/java/com/google/ar/core/Config.FocusMode ; Chromium `device/vr/android/arcore/arcore_impl.cc` (main branch) |

**Still object close to the camera** *(inference from the rows above)*: a hand resting on a board is a static scene, which suits
depth from motion. But without a ToF sensor nothing comes out unless the phone moves, and 20 to 45 cm lies at or below the documented 50 cm start of the
optimal range. The ToF phones on Google's list are all 2019 to 2020 models. A native app should set `FocusMode.AUTO` for close work.

### 1.2 Motion tracking, pose and intrinsics

| Item | Documented | Source |
|---|---|---|
| How pose is computed | Feature points "combined with inertial measurements from the device's IMU" to "estimate the pose (position and orientation) of the camera relative to the world over time" | https://developers.google.com/ar/develop/fundamentals |
| Pose per frame | `Camera.getPose()`: "the pose of the physical camera in world space for the latest frame ... at the center of exposure of the center row of the image"; only valid when tracking state is `TRACKING` | https://developers.google.com/ar/reference/java/com/google/ar/core/Camera |
| Accuracy or drift | **Not documented.** The only statement: "Poses can change as ARCore improves its understanding of its own position and its environment" | fundamentals page |
| Intrinsics | `Camera.getImageIntrinsics()`: "unrotated camera intrinsics for the CPU image"; `getTextureIntrinsics()` for the GPU texture. `CameraIntrinsics.getFocalLength()` "Returns the camera's focal length in **pixels**" (fx, fy); `getPrincipalPoint()` {cx, cy}; `getImageDimensions()` {width, height}. **No lens distortion coefficients** are documented | Camera and https://developers.google.com/ar/reference/java/com/google/ar/core/CameraIntrinsics |
| Depth/camera alignment | "An acquired depth image has the same timestamp and field of view intrinsics as the camera" | depth overview |

Independent pose accuracy (peer-reviewed, not hand scale): in indoor and outdoor robot tests, ARKit "showed the most stable and high accuracy/consistency"
of four systems, with "a drift error of about 0.02 m per second" (Kim et al., *Sensors* 22(24):9873, 2022, doi:10.3390/s22249873, abstract read via Europe PMC).
That is room-scale motion; it says nothing about millimetre accuracy over a 30 cm orbit around a hand.

### 1.3 Camera2 `DEPTH16` / `DEPTH_POINT_CLOUD` (ToF phones, without ARCore)

* `DEPTH16`: 16-bit samples, the top 3 bits a confidence value, 13 bits range, "When produced by a camera, the units for the range are millimeters" (API 23).
  `DEPTH_POINT_CLOUD`: X, Y, Z, confidence floats, metres in the camera frame for depth-capable cameras
  (https://developer.android.com/reference/android/graphics/ImageFormat#DEPTH16).
* A camera that advertises `REQUEST_AVAILABLE_CAPABILITIES_DEPTH_OUTPUT` must support `DEPTH16` and must list `lens.poseTranslation`, `lens.poseRotation`,
  `lens.intrinsicCalibration` and `lens.distortion`. "Generally, depth output operates at a slower frame rate than standard color capture"
  (https://developer.android.com/reference/android/hardware/camera2/CameraMetadata , `REQUEST_AVAILABLE_CAPABILITIES_DEPTH_OUTPUT`).
* **Which retail phones expose their ToF sensor to third-party apps through Camera2: `UNVERIFIED`** (no manufacturer documentation found).
  Feature-detect on the device: look for `DEPTH_OUTPUT` in `REQUEST_AVAILABLE_CAPABILITIES`.

### 1.4 Licence, terms and privacy (ARCore)

| Item | Finding | Source |
|---|---|---|
| SDK repository licence | Multi-part file. Section 1: binaries (`arcore_c_api.h`, `.aar`, `.apk`, `arcoreimg`) "governed by" the **ARCore Additional Terms of Service**. Section 2: SDK source files **Apache-2.0**. Section 3: bundled deps (AndroidX annotation, Error Prone, Guava) Apache-2.0 | https://github.com/google-ar/arcore-android-sdk/blob/master/LICENSE |
| ARCore Additional Terms (last modified May 11, 2022) | You must accept the **Google APIs Terms of Service** plus these terms. Your app's terms must "notify end users that the API Client includes ARCore functionality provided by Google" and that its use is subject to Google's terms and privacy policy. No Cloud Anchors or Geospatial API in COPPA child-directed apps. Must not re-create a Google product ("substantial, independent value"). **No fee, royalty or commercial-use ban found** | https://developers.google.com/ar/develop/terms |
| Google APIs Terms of Service (last modified November 9, 2021) | "You will provide and adhere to a privacy policy for your API Client" (3d). Prohibits use "where the use or failure of the APIs could lead to death, personal injury" (4a). Bars sending protected health information to Google if you are a HIPAA covered entity. Commercial use is **not** prohibited | https://developers.google.com/terms |
| Required in-app disclosure | Basic ARCore apps "must disclose the use of Google Play Services for AR (ARCore) and how it collects and processes data", "prominently ... easily accessible to users", for example on the main menu or a notice screen, with the text "This application runs on Google Play Services for AR (ARCore), which is provided by Google and governed by the Google Privacy Policy". Cloud Anchors / Geospatial need an extra notice ("Google will process sensor data (e.g., camera and location)"); not needed for depth | https://developers.google.com/ar/develop/privacy-requirements |
| Runtime | AR features live in **Google Play Services for AR**, updated by the Play Store. AR Required apps: min Android 7.0 (API 24), the Store installs the service; AR Optional: the app calls `ArCoreApk.requestInstall()`. Camera permission must be granted before creating a session | https://developers.google.com/ar/develop/java/enable-arcore |
| What data Google Play Services for AR collects in a basic (depth-only) session | **Not stated** on the privacy page (it points to the Google Privacy Policy): `UNVERIFIED` | privacy-requirements page |

Not legal advice: counsel should confirm. The hand images themselves are the product's own personal data, and the existing privacy plan applies to them.

## 2. iOS: ARKit, AVFoundation, Object Capture (native app)

### 2.1 Rear LiDAR: `sceneDepth` / `smoothedSceneDepth`, and the AVFoundation LiDAR camera

| Property | Documented value | Source (read 2026-11-08) |
|---|---|---|
| Devices | iPhone 12 Pro, 12 Pro Max, 13 Pro, 13 Pro Max, 14 Pro, 14 Pro Max, 15 Pro, 15 Pro Max, 16 Pro, 16 Pro Max, 17 Pro, 17 Pro Max (Apple's "Models with a LiDAR Scanner"). Non-Pro iPhones have none. iPad Pro 11-inch (3rd gen) / 12.9-inch (5th gen) or later are named in Apple's LiDAR sample | https://support.apple.com/guide/iphone/aside/iphc07537a89/26/ios/26 ; https://developer.apple.com/documentation/avfoundation/capturing-depth-using-the-lidar-camera |
| API | `ARFrame.sceneDepth` (iOS 14): `ARDepthData` "captured by the LiDAR scanner"; `smoothedSceneDepth` "smoothes the depth data over time". "ARKit supports scene depth only on LiDAR-capable devices"; check `supportsFrameSemantics(_:)` | https://developer.apple.com/documentation/arkit/arframe/scenedepth ; https://developer.apple.com/documentation/arkit/arframe/smoothedscenedepth ; .../arconfiguration/framesemantics-swift.struct/scenedepth |
| Units | `depthMap`: "distance from the device to its environment, in meters" (Float32 at runtime per Apple's example); `confidenceMap`: `ARConfidenceLevel` per pixel, lower on "highly reflective" or light-absorbing surfaces | https://developer.apple.com/documentation/arkit/ardepthdata |
| Resolution, rate | "AVFoundation's LiDAR Depth Camera can output depth up to 768 by 576. This is more than twice as big as ARKit's depth resolution of 256 by 192" (WWDC22). "The depth data would be available at 60 Hz, associated with each AR frame" (WWDC20) | https://developer.apple.com/videos/play/wwdc2022/110429/ ; https://developer.apple.com/videos/play/wwdc2020/10611/ |
| How the dense map is made | The LiDAR camera "produces high quality depth data by fusing sparse output from the LiDAR Scanner with the color image" (WWDC22). `builtInLiDARDepthCamera` (iOS 15.4): "high-quality, high-accuracy depth information by measuring the round trip of an artificial light signal" | WWDC22; https://developer.apple.com/documentation/avfoundation/avcapturedevice/devicetype-swift.struct/builtinlidardepthcamera |
| Range | Apple: "measures the distance to surrounding objects up to 5 meters away" (iPad Pro 2020 press release). **Minimum range: not documented by Apple (`UNVERIFIED`)** | https://www.apple.com/newsroom/2020/03/apple-unveils-new-ipad-pro-with-lidar-scanner-and-trackpad-support-in-ipados/ |
| Accuracy at hand distance | **Not documented by Apple.** Peer-reviewed: the emitter projects "a total of 576 points", density "7,225 points m⁻² at 25 cm distance"; small objects "with a side length > 10 cm with an absolute accuracy of ± 1 cm"; "Precision is decreasing when scanning surfaces under 10 cm side length and the limit of detection for objects is around five cm" (iPhone 12 Pro and iPad Pro 2020, '3d Scanner App') | Luetzenburg, Kroon, Bjørk, *Sci Rep* 11:22221 (2021), doi:10.1038/s41598-021-01763-9, full text via Europe PMC PMC8593014 |

*(inference)* 7,225 points/m² is one raw LiDAR return per about 12 x 12 mm at 25 cm. A finger is about 15 to 20 mm wide, so it gets one or two
raw returns across per frame. The 256x192 map between them is filled from the colour image. For fingers, that puts LiDAR depth well below
the detail the marker-board silhouettes can give.

### 2.2 Front TrueDepth camera

| Item | Documented | Source |
|---|---|---|
| What it is | `builtInTrueDepthCamera` (iOS 11.1): "two cameras, one Infrared and one YUV"; "The TrueDepth camera projects an infrared light pattern ... and images that pattern with an infrared camera"; "unlike a dual camera device, the TrueDepth camera can directly measure depth (in meters) with absolute accuracy" (set `activeDepthDataFormat` for depth instead of disparity) | https://developer.apple.com/documentation/avfoundation/avcapturedevice/devicetype-swift.struct/builtintruedepthcamera ; https://developer.apple.com/documentation/avfoundation/capturing-photos-with-depth |
| Not face-only | The AVFoundation route streams depth for the whole scene ("determine the distance of a pixel from the front-facing camera", point-cloud viewer sample). ARKit gives TrueDepth depth only in face tracking: `capturedDepthData` "is available only in face-based experiences (see `ARFaceTrackingConfiguration`)". *(inference)* For a hand, use AVFoundation, not ARKit face tracking | https://developer.apple.com/documentation/avfoundation/streaming-depth-data-from-the-truedepth-camera ; https://developer.apple.com/documentation/arkit/arframe/captureddepthdata |
| Rate | "The depth-sensing camera provides data at a different frame rate than the color camera" (value not given) | captureddepthdata page |
| Distortion | `AVDepthData` maps are "nonrectilinear": "use the data in the `cameraCalibrationData` property to rectify the depth data" before 3D use | https://developer.apple.com/documentation/avfoundation/avdepthdata |
| Resolution and usable range at 20 to 50 cm | **Not documented by Apple: `UNVERIFIED`.** The supported depth formats can be listed at runtime (`supportedDepthDataFormats`). A 2025 paper's background table lists "iPhone TrueDepth camera 640x360 iToF", which contradicts Apple's structured-light description, so I do not rely on it | Romanenko and Chibunichev 2025 (section 5) |
| Face tracking range | `ARFaceTrackingConfiguration` "detects faces within 3 meters" (face tracking, not raw depth) | https://developer.apple.com/documentation/arkit/arfacetrackingconfiguration |
| Devices | iPhones with a TrueDepth camera, that is Face ID models (the exact model list was not checked against an Apple page: `UNVERIFIED`) | |

### 2.3 Intrinsics and pose (ARKit and AVFoundation)

* `ARCamera.intrinsics` (`simd_float3x3`, iOS 11): "`fx` and `fy` are the pixel focal length ... `ox` and `oy` are the offsets of the principal point from the top-left corner of the image frame. **All values are expressed in pixels.**"
  `ARCamera.transform`: "The position and orientation of the camera in world coordinate space" (https://developer.apple.com/documentation/arkit/arcamera/intrinsics ; .../transform).
* World tracking uses "visual-inertial odometry"; "ARKit develops a better understanding of the scene if the device is moving"; "Excessive motion ... results in a blurred image". **No accuracy or drift figure** (https://developer.apple.com/documentation/arkit/understanding-world-tracking).
* AVFoundation: `AVCameraCalibrationData` gives "pixel focal length, principal point, and lens distortion characteristics"; `intrinsicMatrix` "expresses all values in pixels" (https://developer.apple.com/documentation/avfoundation/avcameracalibrationdata).
  Unlike ARCore's documented intrinsics, this includes lens distortion.

### 2.4 Object Capture (`ObjectCaptureSession`, `PhotogrammetrySession`)

| Item | Documented | Source |
|---|---|---|
| OS | `ObjectCaptureSession` iOS 17+; `PhotogrammetrySession` iOS 17+ and macOS 12+; Apple's current sample app needs "A LiDAR Scanner, An A14 Bionic chip or later, iOS or iPadOS 18 or later" | https://developer.apple.com/documentation/realitykit/objectcapturesession ; .../photogrammetrysession ; .../scanning-objects-using-object-capture |
| Devices | "Object Capture is available on iPhone 12 Pro, iPad Pro 2021, and the later models" (WWDC23; repeated WWDC24); check `isSupported` | https://developer.apple.com/videos/play/wwdc2023/10191/ ; https://developer.apple.com/videos/play/wwdc2024/10107/ |
| Non-rigid subject | "Choose objects that are static and won't bend or deform while you're taking photos ... a soft, articulated, or bendable object that changes shape ... may cause Object Capture to fail or produce low-quality results." Also "Avoid objects that are very thin in one dimension" and objects with "a very smooth surface"; WWDC23: avoid "very thin structures" | https://developer.apple.com/documentation/realitykit/capturing-photographs-for-realitykit-object-capture ; WWDC23 |
| Capture and processing time | Not quantified for capture. Reconstruction "In just a few minutes" on iOS (WWDC23); on iOS "only one detail level, `.reduced`, is currently supported" | WWDC23; https://developer.apple.com/documentation/realitykit/photogrammetrysession/request/detail |
| Scale | "If your source images contain depth data, RealityKit uses it to calculate the real-world size"; otherwise "you may have to scale the object" | capturing-photographs page |
| Accuracy claims | **None found** in Apple's documentation or sessions | |

*(inference)* A live hand is articulated and soft, which is exactly what Apple says to avoid, and fingers are "thin structures". Object Capture is a poor fit for the hand itself.
It could serve as a quick reference scanner for a rigid plaster or 3D-printed hand, but with no published accuracy it cannot be the ground truth.

### 2.5 Apple licensing relevant to a commercial app

* ARKit, AVFoundation and RealityKit are Apple SDKs used under the **Apple Developer Program License Agreement** (ADPLA). No separate royalty or commercial-use restriction for them was found in the text
  (https://developer.apple.com/support/terms/apple-developer-program-license-agreement/ , read 2026-11-08).
* ADPLA 3.3.3(A): if the app makes camera recordings, "a reasonably conspicuous audio, visual or other indicator must be displayed"; all data collection must
  comply with privacy laws "including but not limited to any notice or consent requirements". 3.3.3(B): no collection of user or device data "without prior user consent", and "only to provide a service or function that is directly relevant to the use of the Application".
* ADPLA defines **Face Data** (data "related to human faces ... e.g., through ARKit, the Camera APIs") with extra rules (3.3.3 K). *(inference)* A hand scan is not Face Data, but a front-camera (TrueDepth) capture can catch the user's face. Avoid storing such frames, or follow those rules.
* `ARFaceTrackingConfiguration`: "your app must include a privacy policy describing to users how you intend to use face tracking and face data" (only if face tracking is used).
* Not legal advice; counsel to confirm. App Store Review Guidelines were not re-read for this document.

## 3. Web: WebXR on Chrome for Android, and iOS Safari

| Item | Finding | Source (read 2026-11-08) |
|---|---|---|
| Does WebXR depth need ARCore? | Yes: "On Google Chrome, WebXR uses ARCore to provide AR functionalities on supported Android devices"; Depth API listed as "Shipped". Chrome's implementation calls ARCore (`ArConfig_setDepthMode(... AR_DEPTH_MODE_AUTOMATIC)`, `ArFrame_acquireDepthImage16Bits`) | https://developers.google.com/ar/develop/webxr/arcore-comparison ; Chromium `device/vr/android/arcore/arcore_impl.cc` (main) |
| Status in Chrome | "WebXR Depth API": "Enabled by default", Chrome **90** on Android (origin trial from 87). Safari and Firefox views listed as no signal | Chrome Platform Status API, feature 5742647199137792 (https://chromestatus.com/feature/5742647199137792) |
| Usage and format Chrome supports | Source code: "We can only support cpu-optimized usage" (**no `gpu-optimized`**); formats `luminance-alpha` and `unsigned-short` (**no `float32`**); "We only support smooth depth" (**no `raw`**). So the web gets ARCore *full* depth, never ARCore *raw* depth or its confidence image | Chromium `arcore_impl.cc`, `ConfigureDepthSensing()` |
| Spec | Editor's Draft, 25 August 2026. `XRDepthInformation`: `width`, `height`, `normDepthBufferFromNormView`, `rawValueToMeters`; CPU variant adds `data` and `getDepthInMeters(x, y)`. Values are "distance from the sensor's near plane ... in unspecified units" (scaled by `rawValueToMeters`). Privacy: user agents "could for example reduce the resolution of the resulting depth buffer" | https://immersive-web.github.io/depth-sensing/ |
| Resolution and near range | Not in the spec. *(inference)* It is ARCore's depth image (section 1.1: typically 160x120, best from 50 cm), possibly reduced by the browser | |
| Camera pixels (`camera-access`) | "WebXR Raw Camera Access": "Enabled by default", Chrome **107** on Android. Spec (Draft Community Group Report, 11 December 2025): `XRCamera` `width`/`height`, `XRWebGLBinding.getCameraImage()` returns "an opaque texture" (GPU only; read back pixels yourself). A privacy indicator must be shown | chromestatus feature 5759984304390144; https://immersive-web.github.io/raw-camera-access/ |
| Intrinsics and pose on the web | Pose: "The camera extrinsics can be obtained by inspecting the `XRView`'s `transform` attribute." Intrinsics: "can be computed given a projection matrix returned from an `XRView`, as well as `XRViewport`" (formulas given; valid because the camera image is aligned with the view). **So a web page on Chrome Android can get a per-frame camera pose and pinhole intrinsics, but only inside an ARCore `immersive-ar` session with `camera-access`.** No distortion model | https://github.com/immersive-web/raw-camera-access/blob/main/explainer.md |
| iOS Safari | WebXR: "n" for iOS Safari 26.6 to 27.2; desktop Safari "n" (can be enabled with an experimental flag). Chrome for Android 157: "a" (partial) | caniuse data, https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/webxr.json |

*(inference)* This corrects the earlier note in `DEVICE_COMPATIBILITY.md` section 3 ("Camera intrinsics from the web: none found"). On Android Chrome, a WebXR AR session with `camera-access`
gives intrinsics (derived from the projection matrix) and a tracked pose per frame. That would feed the marker-board reconstruction without a native app on supported Android phones.
Costs: the AR session controls the camera (resolution, focus and exposure are ARCore's choice), the frame arrives as a GPU texture, and nothing equivalent exists on iPhone.

## 4. Cross-platform wrappers for a native prototype (short)

| Wrapper | Licence | Depth | Intrinsics | Source |
|---|---|---|---|---|
| **Unity AR Foundation** (ARCore + ARKit) | Package: "Unity Companion License for Unity-dependent projects": royalty-free, "in connection with the authoring" of content "under a valid Unity content authoring and rendering engine software license"; no use "to develop a competing product". The Unity Editor plan terms were not checked (`UNVERIFIED`) | `AROcclusionManager.TryAcquireRawEnvironmentDepthCpuImage`, `...SmoothedEnvironmentDepthCpuImage`, `...EnvironmentDepthConfidenceCpuImage`. Note "ARCore only supports Disabled and Fastest modes for Environment Depth Mode" | `ARCameraManager.TryGetIntrinsics`; `XRCameraIntrinsics.focalLength` "in pixels", principal point "in pixels"; CPU camera image via `TryAcquireLatestCpuImage` | https://docs.unity3d.com/Packages/com.unity.xr.arfoundation@6.1/ (AROcclusionManager, ARCameraManager, XRCameraIntrinsics, occlusion manual, license); https://unity.com/legal/licenses/unity-companion-license |
| ViroReact (React Native) | MIT (GitHub API) | Not mentioned in README: `UNVERIFIED` | Not mentioned: `UNVERIFIED` | https://github.com/ReactVision/viro |
| arkit_flutter_plugin (Flutter, iOS) | MIT | README lists "Depth Scene Snapshot ... using LiDAR" | Not mentioned: `UNVERIFIED` | https://github.com/olexale/arkit_flutter_plugin |
| ar_flutter_plugin / arcore_flutter_plugin (Flutter) | MIT / MIT; last pushed 2024-08 / 2024-03 | Not mentioned in README | Not mentioned | https://github.com/CariusLars/ar_flutter_plugin ; https://github.com/giandifra/arcore_flutter_plugin |
| Capacitor | No ARCore/ARKit depth plugin found (`UNVERIFIED`) | | | |

*(inference)* Only Unity AR Foundation exposes depth, confidence, intrinsics and the CPU image on both platforms out of the box. For a React or Capacitor app, the
realistic route is a small custom native module (Kotlin on ARCore, Swift on ARKit/AVFoundation) that returns frames, intrinsics and poses to the existing TypeScript reconstruction code.

## 5. Published accuracy of phone depth at close range

Searched Europe PMC (title/abstract queries on hand or finger with LiDAR, TrueDepth, iPhone, smartphone depth, ToF and ARCore) and the web, 2026-11-08.
**No peer-reviewed study measured hands or fingers with a phone's built-in depth sensor against a reference.** Closest evidence:

| Study (peer-reviewed) | Sensor, distance, subject | Reported numbers | Relevance |
|---|---|---|---|
| Romanenko and Chibunichev, *Int. Arch. Photogramm. Remote Sens.* XLVIII-2/W9-2025, 227-232, doi:10.5194/isprs-archives-XLVIII-2-W9-2025-227-2025 (footer: "This contribution has been peer-reviewed"; full PDF read) | iPhone 15 Pro depth camera the authors call "ToF" (front or rear not clearly stated), clamped "approximately 35 cm" from a 267 x 120 mm metal plate moved in 10 mm steps; depth map about 640 x 360 | Parallel view, uncalibrated: RMS of plate distances **17 / 8 / 3 mm** (X/Y/Z); point RMS **2 to 4 mm**; scale factor **t = 1.055**. After applying the scale factor: **7 / 3 / 5 mm**. Oblique view uncalibrated: **4 / 3 / 5 mm**. "classical ToF camera calibration ... does not improve point-coordinate accuracy"; "Model accuracy significantly improves when applying the scale factor"; results "should be considered preliminary" | The only test at hand distance. A flat rigid plate, one phone; shows mm-to-cm errors and a ~5 % scale bias unless a known reference corrects it |
| Luetzenburg, Kroon, Bjørk, *Sci Rep* 11:22221 (2021), doi:10.1038/s41598-021-01763-9 | iPhone 12 Pro / iPad Pro 2020 rear LiDAR, small objects and a cliff | Small objects >10 cm: "absolute accuracy of ± 1 cm"; detection limit "around five cm"; 7,225 points/m² at 25 cm | Fingers are below the detection-limit size |
| Hartmann et al., *Oral Maxillofac Surg* (2025), doi:10.1007/s10006-024-01322-2 (abstract via Europe PMC) | iPhone 14 Pro **TrueDepth** vs Vectra M5, faces, 30 volunteers | TrueDepth landmark deviation **M = 1.1 mm (SD 0.72)**; phone photogrammetry **0.8 mm (SD 0.58)**; volume difference 3.1 cc vs 1.8 cc; most 95 % LoA ≤ 2 mm. "Photogrammetry-based SMs demonstrated superior alignment and volumetric accuracy" | Face at selfie distance; even here RGB photogrammetry beat TrueDepth |
| D'Ettorre et al., *Angle Orthod* 92(3) (2022), doi:10.2319/040921-290.1 (abstract) | iPhone Xs **TrueDepth** (Bellus3D, Capture apps) vs 3dMDtrio, 40 faces | **80.0 % ± 5.9 %** of surface within 1 mm, **56.6 % ± 7.7 %** within 0.5 mm (Bellus3D); Capture 81.4 % / 56.5 %. Acquisition slower than the reference | Face, rigid-ish, held still |
| Nissen et al., *Sensors* 23(9):4486 (2023), doi:10.3390/s23094486 (abstract and parts of full text) | TrueDepth + ARKit **face tracking**, eye-to-phone distance, 200 to 600 mm, head fixed, phone on a robot arm | errors "ranging between 0.88% and 9.07% from the actual distance"; affected by "head size, position, device model, and temperature" | A face-tracking model output, not a raw depth map; shows device and thermal effects |
| Callegari et al., *Sensors* 24(2):500 (2024), doi:10.3390/s24020500 (full text) | iPad Pro 2020 rear LiDAR (Polycam), held ~1.5 m above one cadaver, 7 long body lengths (all > 40 cm) | errors "below 1.5%"; largest on the shortest distances | Far from hand scale; % error grows as length shrinks |
| Kim et al., *Sensors* 22(24):9873 (2022) | ARKit / ARCore pose (VIO), room scale | ARKit relative pose drift "about 0.02 m per second" | Pose drift context only |

Not usable as evidence: a hand-scan study using an external Structure Sensor Pro on an iPad, which evaluated scan completeness, not accuracy
(Glazer et al., *Bioengineering* 2025, doi:10.3390/bioengineering12070777). ARCore depth-from-motion accuracy: the method paper (Valentin et al., "Depth from motion for smartphone AR",
*ACM TOG* 37(6), 2018, doi:10.1145/3272127.3275041) was **not read**, so I quote no numbers from it (`UNVERIFIED`). **No peer-reviewed close-range accuracy figure for ARCore depth or Android ToF phones was found.**
A 2025 study on whether enabling the Depth API improves anchor stability is only a preprint (Research Square, doi:10.21203/rs.3.rs-10991704/v1), so it is not used.

## 6. Conclusion

### 6.1 What the sources state

* ARCore depth: optimal from 50 cm; typically 160x120 (up to 640x480); needs motion without ToF; no close-range accuracy published. ToF phones listed by Google are 2019 to 2020 models.
* WebXR depth in Chrome: ARCore full (smooth) depth, CPU only, no raw depth, no confidence. WebXR `camera-access` plus the projection matrix gives intrinsics and pose on Chrome Android only. Nothing on iOS Safari.
* iPhone LiDAR (12 Pro to 17 Pro): 256x192 at 60 Hz in ARKit, up to 768x576 in AVFoundation, a dense map fused from 576 raw points with the RGB image; ±1 cm on objects above 10 cm, detection limit about 5 cm.
* TrueDepth: absolute depth in metres (Apple); about 1 mm agreement on faces (two clinical studies), with RGB photogrammetry better in the one direct comparison; resolution and range not documented.
* The one hand-distance test of a phone depth camera (35 cm, flat plate): 3 to 17 mm RMS uncorrected, about 5 % scale error, 3 to 8 mm after scaling from known distances.
* Object Capture: Apple says not for articulated or deforming objects or thin structures.
* ARKit and ARCore give intrinsics in pixels and a pose per frame; neither documents pose accuracy. Only AVFoundation documents lens distortion.

### 6.2 My inference: will any depth source beat the RGB marker-board method at 20 to 45 cm?

1. **Rear LiDAR (iPhone Pro): unlikely for fingers, possibly useful for the back of the hand.** With roughly one raw return per 12 mm at 25 cm and a ~5 cm detection limit,
   finger width and thickness come from the RGB-guided fill, not from the laser. The marker-board hull bounds each finger from its silhouettes with sub-millimetre pixels (the synthetic
   simulation in `AUDIT_3D_STATUS.md` reached about 3 mm thickness and 2 mm circumference error; not yet shown on real photos). Possible use: a coarse check of the back-of-hand
   surface (the palm hollow, the main concavity the hull misses, faces the board and is invisible to every rear-camera option in this capture). Works on about 12 iPhone models only.
2. **ARCore depth from motion (most Android phones): unlikely to beat it.** It is computed from the same moving RGB camera the board method uses, at 160x120 typically, below its documented
   range, and through WebXR without confidence or raw data. It adds no independent measurement. Exception: the few ToF phones, still coarse and old.
3. **Android ToF via Camera2: unknown, rare.** Exposure to apps is unverified, and the phones are 2019 to 2020 models.
4. **Front TrueDepth (Face ID iPhones): the only plausible competitor, unproven.** It is designed for 20 to 50 cm objects (faces) and reaches about 1 mm on faces. Against it: undocumented
   range, resolution and accuracy for hands, front-facing (the user cannot see the screen while it faces the hand), Face Data rules if the face is captured, and even on faces RGB photogrammetry did better.
5. **The real benefit of going native is camera control and geometry, not depth:** per-frame intrinsics in pixels (ARKit, ARCore) plus distortion (AVFoundation, Camera2), tracked poses as a
   second opinion next to the board poses, full-resolution frames, focus lock (ARCore defaults to fixed focus, which Chrome's own code calls blurry at close range), and exposure control.
   These improve the RGB board method itself. On Android, part of this (intrinsics plus pose) is reachable from the web through WebXR `camera-access`.
6. **Metric scale:** every depth source above still needs a scale check. The 35 cm study found a 5.5 % scale error that a known reference removed. The printed board already provides that reference, so
   it stays necessary in every option.

### 6.3 What would have to be measured to decide

Run the same protocol for each candidate (RGB board via web, RGB board via native with platform intrinsics/pose, LiDAR fusion, TrueDepth, ARCore depth on one ToF and one non-ToF phone):

1. **Rigid phantom first**: a 3D-printed or cast hand with known geometry (measured by a reference scanner or CMM, not by Object Capture). This separates sensor and pipeline error from hand movement.
   Report per-point surface error (mean, RMS, 95th percentile) and per-dimension error for finger widths and thicknesses, knuckle breadth, palm thickness and circumferences, at **20, 30 and 45 cm**.
2. **Coverage**: fraction of finger surface with valid depth (confidence above threshold), gaps between fingers, sides.
3. **Scale bias per device model** (the 5 % effect) with and without the board as reference.
4. **Real hands** (consented, held-out people): the glove-relevant measurements against calipers and tape by a trained measurer, with repeated captures. Report bias, SD, Bland–Altman limits of agreement and test–retest repeatability (as in `VALIDATION_PLAN.md`).
5. **Practicalities**: capture time, failure rate, thermal state over a full scan, and the share of the client's customer phones that have each sensor.
6. **Decision rule** *(proposal)*: a depth source is worth a native app only if, on the same captures, it reduces the limits of agreement of the glove-sizing measurements by more than the client's tolerance
   (to be defined by the client) compared with the native RGB board method, on phones that a meaningful share of customers own.

## UNVERIFIED (not confirmed from a primary source)

* ARCore depth accuracy at 20 to 50 cm (none published); actual depth resolution per device; which devices give 640x480.
* ARCore pose accuracy or drift (not documented); whether ARCore exposes lens distortion (not documented; I found none).
* Which retail Android ToF phones expose `DEPTH_OUTPUT` / `DEPTH16` to third-party apps through Camera2.
* What data Google Play Services for AR collects in a basic depth session.
* ARCore depth-from-motion published accuracy (Valentin et al. 2018 not read).
* iPhone LiDAR minimum range; LiDAR depth accuracy at 20 to 45 cm from Apple.
* TrueDepth depth resolution, frame rate, near and far range, accuracy on non-face objects; the exact list of TrueDepth iPhones.
* Whether the iPhone 15 Pro sensor in Romanenko and Chibunichev 2025 was the front TrueDepth or the rear LiDAR (the paper is not explicit), and its "640x360 iToF" description of TrueDepth.
* Object Capture accuracy (no claim found) and capture time.
* Unity Editor licence plan terms; depth and intrinsics support in ViroReact, the Flutter ARCore plugins and any Capacitor plugin; react-native-nitro-ar (found by search, not read).
* App Store Review Guidelines items relevant to depth and camera use (not re-read here).
* Glove-size tolerances (the EN ISO 21420 text is still unread, see `DEPTH_AND_RECONSTRUCTION_OPTIONS.md`).
* All legal readings above: not legal advice; counsel to confirm the ARCore Additional Terms, Google APIs Terms and the ADPLA for this product.
