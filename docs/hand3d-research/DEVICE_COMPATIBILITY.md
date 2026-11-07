# What an ordinary phone web page can and cannot get

Scope: the customer opens the app in the phone's browser (no app-store install). Sources were read on **2026-11-07**;
anything I could not confirm from a primary source says `UNVERIFIED`. Nothing here was measured on a real phone:
every performance statement for phones is an open question, not a result.

## 1. Summary matrix

| Capability | Android Chrome | iOS Safari | Basis |
|---|---|---|---|
| Live camera (`getUserMedia`) | Yes | Yes | caniuse data (see 2); MDN lists it as widely available |
| `ImageCapture` (`takePhoto`, still photo, per-shot settings) | Yes | **No** | caniuse |
| WebXR AR session (`immersive-ar`) | Partial (Chrome; caniuse marks it "partial") | **No** | caniuse |
| WebXR `depth-sensing` | Yes, "limited availability" since Chrome 90 | **No** | web-features data (see 4) |
| Camera intrinsics (focal length, principal point) from the web | **None found** | **None found** | see 3 |
| Hardware depth (ToF / LiDAR) from a web page | Only through WebXR depth on a supported phone | **No** (LiDAR only in native apps) | see 4, 5 |
| Depth from motion (ARCore) | Where the device supports the Depth API | Not from the web | see 4 |
| Native ARKit scene depth (LiDAR) | n/a | Native app on LiDAR devices only | see 5 |

**Fallback for phones with no depth (the baseline we must support):** RGB-only. The existing product (coin on the palm,
MediaPipe landmarks, guided palm / back / side views) already works that way. For these phones there is **no dense or metric 3D**
without a calibrated multi-view method; the 3D hand the app draws is a visualisation. Nothing in this document
changes that baseline.

## 2. Camera access from a web page

* **Live video:** `getUserMedia` works on Android Chrome and iOS Safari (caniuse feature `stream`, read from the caniuse JSON on GitHub, 2026-11-07:
  https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/stream.json). MDN lists it as "Baseline Widely available":
  https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia .
* **Resolution and frame rate** are requests ("ideal" or "min/max" constraints), not guarantees; the browser picks the nearest
  mode. The app today runs on **video frames** (typically 720p to 1080p, `?debug` shows the actual stream size and frame rate),
  where the coin is about 120 px across, roughly 0.2 mm per pixel at the coin's plane (a US quarter read about 120 px across in this repository's fake-camera tests; a real phone was not measured).
* **Still photos at full sensor resolution:** `ImageCapture.takePhoto()` is available on Android Chrome and **not on iOS Safari**
  (caniuse feature `imagecapture`: Chrome for Android "y", iOS Safari "n"; spec https://w3c.github.io/mediacapture-image/#imagecaptureapi).
  On iOS the only web route to higher resolution is a larger video constraint, which is still video. Whether a still is
  sharper or less compressed than the same-size video frame on a given phone is `UNVERIFIED`; test per device.
* **Autofocus, exposure, white balance:** these are optional constraints (`focusMode`, `exposureMode`, `exposureCompensation`,
  `whiteBalanceMode`) that a browser may ignore. This repository already treats exposure compensation as "null when the browser does not
  allow it" (`ScanStatus.exposureEv`). Support per phone and browser: `UNVERIFIED`; read it from `track.getCapabilities()` on the device
  (the `?debug` panel can be extended to print it). Autofocus hunting at 30 cm and autoexposure drift matter for a repeatable measurement.
* **Lens choice:** a web page cannot reliably choose between the main, ultra-wide and macro lenses. Which lens the browser opens
  varies by phone and browser: `UNVERIFIED`. The lens changes distortion and field of view.

## 3. Camera intrinsics and distortion

* The web camera APIs I read expose size, frame rate, facing mode and optional controls, **not focal length or principal point**.
  I found no web API that returns intrinsics (`UNVERIFIED` for completeness: absence in the documents I read is not a proof).
  Still-photo EXIF can carry a focal length, but whether `takePhoto()` output or a canvas capture keeps it is `UNVERIFIED`, and EXIF
  is not available for video frames.
* **What the repository does today:** it does not know the intrinsics, so it assumes a horizontal field of view range
  (`assumed_hfov_deg: [55, 80]` in `config/measurement.json`), uses the coin's apparent size as the scale at the coin's plane, and treats the
  field-of-view range as a stated uncertainty (`docs/MEASUREMENT_METHODOLOGY.md`).
* **Consequence for 3D:** a metric multi-view reconstruction needs intrinsics (and lens distortion). Options: (a) calibrate each phone model
  from a printed chart (not possible for every phone, so only for a supported-device list); (b) estimate them per session from
  a known printed marker sheet seen in several views (self-calibration); (c) take them from ARCore/ARKit (native or WebXR; ARCore through WebXR gives a
  projection matrix to the page: `UNVERIFIED` which fields). One coin gives a scale at one plane, **not** the full camera model.
* Phone cameras usually apply their own distortion correction in the ISP; how much remains at the edges of a video frame, per phone,
  is `UNVERIFIED`.

## 4. WebXR and ARCore depth (Android)

* **WebXR Device API:** Chrome for Android partial, iOS Safari no, Firefox for Android no (caniuse feature `webxr`, 2026-11-07:
  https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/webxr.json).
* **WebXR Depth Sensing Module:** "Limited availability"; Chrome for Android since version 90 (2021-04-13); Firefox and Safari do not support it
  (web-features explorer, found by search on 2026-11-07: https://web-platform-dx.github.io/web-features-explorer/features/webxr-depth-sensing).
  The module (spec https://immersive-web.github.io/depth-sensing/) lets a page request depth as `raw` or `smooth`, for CPU or GPU use, in data formats
  `luminance-alpha` or `unsigned-short` (16-bit unsigned integers) or `float32`, and needs a user gesture and a session started with the feature
  requested. It exists only inside an AR session (the camera feed is composited by the browser; getting the camera pixels of the same frame for
  segmentation is `UNVERIFIED` on Android Chrome: WebXR has a camera-access module, support not checked here).
* **ARCore Depth API (what is underneath):** "uses a depth-from-motion algorithm to create depth images and merges data from available hardware
  sensors like ToF for enhanced accuracy"; a device **does not need** a ToF sensor; "Depth data is most accurate when the device is half a meter to about five
  meters away from the real-world scene"; estimates are described as robust "from 0 to 65 meters"; depth is a 16-bit-per-pixel image in millimetres
  (https://developers.google.com/ar/develop/depth and https://developers.google.com/ar/develop/java/depth/developer-guide, both read 2026-11-07).
  **Not every ARCore device supports it**; Google's device page states "As of May 2026, over 88% of active devices support the Depth API"
  and lists device models and, separately, devices with a hardware depth sensor (https://developers.google.com/ar/devices , read 2026-11-07).
* **What this means for a hand at 25 to 40 cm:** that is **below the documented best range** (0.5 m and up). Depth-from-motion needs the phone to
  move and gives dense but not guaranteed pixel coverage; a hand is small, textureless, and moves. **No accuracy figure for hands at close range was
  found in the sources I read: `UNVERIFIED`.** Depth image resolution relative to the camera image: not stated in the pages I read, `UNVERIFIED`.
  Raw Depth and confidence images exist (Google's "Raw Depth" guide) but I did not read their numbers.
* **ToF phones:** a hardware sensor adds depth without camera motion and helps low-texture surfaces (Google's text above). Which phones have one is on the
  device page; I did not extract the list.

## 5. iOS: LiDAR and ARKit

* ARKit **scene depth** needs a LiDAR scanner: "the API is supported on devices with the LiDAR scanner" (WWDC20 "Explore ARKit 4",
  https://developer.apple.com/videos/play/wwdc2020/10611/ , read via search 2026-11-07). A WWDC22 session names the iPhone 12 Pro, iPhone 13 Pro and iPad Pro as LiDAR devices
  (https://developer.apple.com/videos/play/wwdc2022/110429/). That list is old; newer Pro models are `UNVERIFIED` here: check Apple's current specifications.
* Safari on iOS has **no WebXR** (caniuse above), so a **web page on an iPhone cannot get LiDAR depth**. LiDAR depth needs a **native app**
  (ARKit, or AVFoundation capture of the LiDAR depth camera from iOS 15.4, reported in Apple's developer forum thread
  https://developer.apple.com/forums/thread/677602 , read via search). Apple's `supportsFrameSemantics(.sceneDepth)` is the runtime check.
* Most iPhones sold have no LiDAR, so iPhone customers on the web are **RGB-only** by construction.

## 6. Android ToF and iOS TrueDepth

* ToF on Android: only some phones; see Google's device page above. Not assumed by this project.
* The iPhone's front TrueDepth camera is a structured-light depth camera for the front side; whether any web API exposes it: `UNVERIFIED` (none found). The hand is
  presented to the rear camera in this product.

## 7. Performance limits of WebGL and WASM on phones

* **Not measured.** The repository's performance numbers come from a desktop machine with software WebGL and a fake camera, plus CPU throttling (4x, 6x) in Chrome.
  The 3D layer's own cost was 5 to 15 ms per frame there, and a phone's real tracker loop rate is unknown. The `?debug` panel of the scan screen now prints
  the tracker fps, ms per frame, the 3D layer's cost and level, and WebGL context events: use it on every test phone and record the numbers.
* Heavy models are the main risk: a 6 MB segmenter (MediaPipe `magic_touch`) is realistic on a phone, SAM-class encoders (tens to hundreds of MB, large compute)
  and diffusion depth models (Marigold) are not, in a page. Browser memory limits, WASM threading (needs cross-origin isolation headers for threads) and
  thermal throttling during a 10 to 30 second scan: `UNVERIFIED`, measure.
* Two WebGL contexts (the 3D overlay and the 3D card) plus camera plus WASM tracking can lose a context on a low-memory phone; the app handles
  `webglcontextlost` by falling back to 2D and says why (tested in a browser, not on a phone).

## 8. What to ask the client and what to test

* Which phones **must** work (a list of models and OS versions)? The compatibility matrix above becomes per-model once a list exists.
* Must iPhone customers get depth? If yes, a native app is required (a separate product decision).
* On each test phone record: browser and version, stream size and fps, `getCapabilities()` for focus and exposure, WebXR `immersive-ar` and `depth-sensing`
  support (feature-detect, never assume), ARCore Depth support, ToF/LiDAR presence, tracker fps and thermal behaviour over a full scan.
