# Smartphone performance (Android): protocol and results

**Results: none yet. No phone has run the 3D capture page.** Nothing below may be read as device compatibility until the
table in section 3 holds real runs. The only timings that exist are a desktop's (Node, headless Chrome), in the READMEs.

## 1. What is measured (the page's `device.json`, one per capture)

| Measure | Field | How |
|---|---|---|
| Capture duration | `capture_ms` | Start camera to Build pressed |
| Reconstruction duration | `build_ms` | Build pressed to result shown (detection, calibration, poses, segmentation, carving, meshing, gates, measurement, coin check) |
| Export duration and success | `export_ms`, `export_ok` | Download pressed to the ZIP handed to the browser |
| Memory | `heap_samples_mb`, `peak_heap_mb`, `device_memory_gb` | `performance.memory` every 2 s where Chrome exposes it (null elsewhere); `navigator.deviceMemory` |
| Stability | `errors`, `webgl_context_lost` | uncaught errors and rejections (messages only), worker failures, viewer context loss; plus the tester's note of tab reloads or crashes |
| Device | `user_agent`, `screen`, `hardware_concurrency`, `camera` | as reported by the browser; the phone model is written by the tester in the run notes |

## 2. Procedure per phone

1. Chrome updated; battery above 50 %; power saving off; other apps closed; phone at room temperature.
2. HTTPS page as in `frontend/src/experimental/recon/README.md`, with `?validation&debug`.
3. At least 5 baseline captures in a row (the experiment's baseline session counts), each exported, then 2 more after 10
   minutes of continuous use (thermal throttling).
4. Note any tab reload, "Aw, Snap!", frozen viewer, missing camera, or export failure, with the capture index.
5. Run `npx tsx frontend/scripts/phantom-report.ts ...` over the exports: its device section aggregates `device.json`.

Which phones: the client chooses (it should include at least one low-end, one mid-range and one recent phone, since the
reconstruction holds about 13 or more 1280 x 720 frames in memory and runs for tens of seconds).

## 3. Results

| Phone (model, Android, Chrome) | Runs | Capture (median) | Build (median, max) | Peak heap | Errors / context losses | Export OK | Notes |
|---|---|---|---|---|---|---|---|
| none tested yet | 0 | | | | | | |

## 4. Known risks before testing (not findings)

* Memory: about 3.7 MB per 1280 x 720 RGBA frame; 13 to 25 frames plus the voxel grid and mesh. Low-memory phones may
  reload the tab.
* Time: the build took about 9 to 23 s on a desktop (headless Chrome, simulated orbit); a phone's single-threaded worker
  is expected to be several times slower: unmeasured.
* Two WebGL contexts are not used at the same time (the camera stops before the viewer opens), but the viewer's mesh of
  about 180,000 triangles has not been drawn on a phone GPU.
