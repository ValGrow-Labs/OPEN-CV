// A busy phone must keep its 3D hand. The real phone runs the hand tracker and the coin search on the same
// thread, so the page (and the scan loop) is slow whatever the 3D layer does; the layer used to be switched off
// for it ("the 3D hand is missing, only the 2D outline"). Chrome's CPU throttling stands in for that phone, with the
// SHIPPED overlay config (enabled, max_frame_ms 40, min_fps 12, fallback_after_slow_s 3), a phone viewport and the
// fake camera. The scan is held open (only the capture targets change: the fake hand would otherwise finish the palm
// view in a second). The layer publishes read-only numbers on window.__OVERLAY_STATS__ = { level, costMs, pageFps, reason }.
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

const BIG = 100_000;

/** Serve /api/config with the scan held open and, optionally, some of live_scan.overlay_3d replaced. */
async function holdScanOpen(page: Page, overlay3d: Record<string, unknown> = {}) {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    Object.assign(body.live_scan, { mobile_frames_target: BIG, mobile_frames_min: BIG, early_stop_frames_mobile: BIG, early_stop_frames_desktop: BIG, early_stop_after_s: BIG, timeout_s: BIG });
    body.live_scan.overlay_3d = { ...body.live_scan.overlay_3d, ...overlay3d };
    body.capture.frames_target = BIG;
    for (const v of body.capture.views) if ("mobile_frames_target" in v) v.mobile_frames_target = BIG;
    await route.fulfill({ response: res, json: body });
  });
}

interface Sample {
  t: number;
  level: number | null;
  costMs: number | null;
  pageFps: number | null;
  reason: string | null;
  canvases: number;
  loopFps: number | null;
}

/** Throttle the CPU, then sample the layer once a second for ``seconds``. */
async function busyPhone(page: Page, rate: number, seconds: number): Promise<Sample[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  const t0 = Date.now();
  const out: Sample[] = [];
  for (let i = 0; i < seconds; i++) {
    await page.waitForTimeout(1000);
    out.push(
      await page.evaluate((t) => {
        const s = (window as unknown as { __OVERLAY_STATS__?: { level: number; costMs: number | null; pageFps: number | null; reason: string | null } }).__OVERLAY_STATS__;
        const fps = document.querySelector<HTMLElement>(".scan .progress")?.dataset.fps;
        return {
          t,
          level: s?.level ?? null,
          costMs: s?.costMs ?? null,
          pageFps: s?.pageFps ?? null,
          reason: s?.reason ?? null,
          canvases: document.querySelectorAll(".scan-overlay3d canvas").length,
          loopFps: fps === undefined ? null : Number(fps),
        };
      }, Math.round((Date.now() - t0) / 1000)),
    );
  }
  return out;
}

const table = (rows: Sample[]) => rows.map((r) => `${r.t}s level=${r.level} cost=${r.costMs}ms page=${r.pageFps}fps loop=${r.loopFps}fps canvas=${r.canvases} reason=${r.reason}`).join("\n");

test.describe("a busy phone (CPU throttled), 390 x 844, touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the guard alone: a scan loop far below min_fps keeps a visible 3D hand at the guard's floor and never switches it off", async ({ page }) => {
    test.setTimeout(240_000);
    // Only the scan screen's own slow-loop fallback is held off here (fallback_after_slow_s), so that the guard's
    // behaviour is what is measured; max_frame_ms 40 and min_fps 12 stay as shipped.
    await holdScanOpen(page, { fallback_after_slow_s: 600 });
    await startCustomerScan(page);
    await page.locator(".scan-overlay3d canvas").waitFor({ timeout: 120_000 });
    const rows = await busyPhone(page, 10, 30);
    console.log(`guard alone, x10\n${table(rows)}`);
    // (In software WebGL the layer is itself a big share of the load, so once the guard drops the rings the page
    // speeds up again; the scan loop stays at 4-7 fps, far below min_fps, which is the case being held out.)
    expect(Math.max(...rows.map((r) => r.loopFps ?? 0)), "the throttle must keep the scan loop below min_fps 12").toBeLessThan(12);
    for (const r of rows) {
      expect(r.canvases, `the 3D layer vanished at ${r.t}s:\n${table(rows)}`).toBe(1);
      expect(r.reason).toBeNull();
      expect(r.level ?? 0).toBeLessThanOrEqual(1); // no rings, halo or sweep at most: still points + wireframe + nodes
    }
  });

  for (const rate of [4, 6]) {
    test(`the shipped config as it is: x${rate} CPU keeps the 3D layer on the scan`, async ({ page }) => {
      test.setTimeout(240_000);
      const logs: string[] = [];
      page.on("console", (m) => /3D overlay off/.test(m.text()) && logs.push(m.text()));
      await holdScanOpen(page);
      await startCustomerScan(page);
      await page.locator(".scan-overlay3d canvas").waitFor({ timeout: 120_000 });
      const rows = await busyPhone(page, rate, 20);
      console.log(`shipped config, x${rate}\n${table(rows)}\n${logs.join("\n")}`);
      for (const r of rows) expect(r.canvases, `3D layer gone at ${r.t}s (${logs.join("; ")}):\n${table(rows)}`).toBe(1);
      expect(logs).toEqual([]);
    });
  }
});
