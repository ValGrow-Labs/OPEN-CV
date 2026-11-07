// Test-only control of how long a scan view stays open, without touching the app or the server.
//
// The fake camera is a perfect hand and coin, so at the shipped settings (50 ms frame interval, 8-16 frames) a view
// completes in about a second, before a slow software-WebGL layer has even drawn, and the screen changes under
// the assertions. The tests that LOOK at the live scan therefore serve the browser its own copy of /api/config with
// only the capture targets and the scan timeout changed. The frame interval stays the shipped 50 ms: the real
// (simulated) camera frames keep being processed, the hand landmarks keep updating, the 3D hand keeps rendering and
// accepted frames keep accumulating. The server's real config, the acceptance checks and the production code are untouched.
import type { Page } from "@playwright/test";

export const BIG = 100_000;

/** "hold": the view never completes and never times out (look at the live scan for as long as the test needs).
 *  { frames }: each view needs that many accepted frames (a few seconds at the shipped interval), then completes
 *  normally, so a flow test has time to look at the live layer and then carries on. */
export type ScanTiming = "hold" | { frames: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyScanTiming(config: any, timing: ScanTiming): void {
  const ls = config.live_scan;
  if (timing === "hold") {
    Object.assign(ls, {
      mobile_frames_target: BIG,
      mobile_frames_min: BIG,
      early_stop_frames_mobile: BIG,
      early_stop_frames_desktop: BIG,
      early_stop_after_s: BIG,
      timeout_s: BIG,
    });
    config.capture.frames_target = BIG;
    for (const v of config.capture.views ?? []) if ("mobile_frames_target" in v) v.mobile_frames_target = BIG;
    return;
  }
  const n = timing.frames;
  Object.assign(ls, { mobile_frames_target: n, early_stop_frames_mobile: n, early_stop_frames_desktop: n });
  config.capture.frames_target = n;
  for (const v of config.capture.views ?? []) if ("mobile_frames_target" in v) v.mobile_frames_target = n;
}

/** Serve /api/config with the live 3D layer's settings and/or the scan timing replaced (what the browser sees only). */
export async function routeConfig(
  page: Page,
  options: { overlay3d?: Record<string, unknown>; timing?: ScanTiming } = {},
): Promise<void> {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (options.overlay3d) body.live_scan.overlay_3d = { ...body.live_scan.overlay_3d, ...options.overlay3d };
    if (options.timing) applyScanTiming(body, options.timing);
    await route.fulfill({ response: res, json: body });
  });
}
