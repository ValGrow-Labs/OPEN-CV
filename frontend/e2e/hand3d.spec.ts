// Where the glowing 3D hand shows up in the customer flow: the camera picture itself during the scan (a
// transparent 3D layer drawn over the real hand, with the live finger lengths), a large one while the
// measurements are calculated, and the customer's own hand on the result page. Also the way out: config can
// switch the 3D layer off, and a layer that runs too slowly hands the drawing back to the 2D hand without
// restarting the scan. The screenshots (test-results/hand3d-*.png) are for looking at.
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NEXT_VIEW_BUTTONS, scanRemainingViews, startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

const VIEWPORTS = [
  { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "phone-320", width: 320, height: 568, touch: true },
  { name: "phone-390-landscape", width: 844, height: 390, touch: true },
  { name: "desktop-1280", width: 1280, height: 800, touch: false },
];

// Software WebGL in headless Chrome is far slower than a phone GPU: give the 3D layer a budget it cannot trip
// unless a test wants it to.
const GENEROUS = { enabled: true, max_frame_ms: 100_000, min_fps: 0.01, fallback_after_slow_s: 600 };

/** Serve /api/config with live_scan.overlay_3d replaced (the server's real config is untouched). */
async function overlayConfig(page: Page, overlay3d: Record<string, unknown>) {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.live_scan.overlay_3d = { ...body.live_scan.overlay_3d, ...overlay3d };
    await route.fulfill({ response: res, json: body });
  });
}

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

/** Pixels in the 2D drawing canvas of the camera pane that are not transparent (the hand outline, the coin ring). */
const drawn2d = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".scan .stage canvas:not(.hand-stage-gl canvas)");
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return -1;
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
    return n;
  });

/** How many pixels differ between two PNG screenshots of the same size (decoded in the page). */
const differing = (page: Page, a: Buffer, b: Buffer) =>
  page.evaluate(
    async ([x, y]) => {
      const load = async (b64: string) => {
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      };
      const [p, q] = await Promise.all([load(x), load(y)]);
      let n = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 60) n++;
      }
      return n;
    },
    [a.toString("base64"), b.toString("base64")],
  );

async function handInTheFlow(page: Page, tag: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await overlayConfig(page, GENEROUS);
  // Slow the sizing request a little so the "calculating" screen can be looked at.
  await page.route("**/api/scan", async (route) => {
    await new Promise((r) => setTimeout(r, 3500));
    await route.continue();
  });

  await startCustomerScan(page);

  // During the live scan the camera picture is the 3D measuring display: one transparent layer over the
  // whole camera pane (no small box), that takes no taps.
  const vp = page.viewportSize()!;
  const overlay = page.locator(".scan-overlay3d");
  await expect(overlay).toBeVisible({ timeout: 120_000 });
  await expect(overlay.locator("canvas")).toBeVisible({ timeout: 60_000 }); // the scene has loaded
  await expect(page.locator(".scan-hand3d")).toHaveCount(0); // the small corner tile is gone
  const o = await box(page, ".scan-overlay3d");
  const stage = await box(page, ".scan .stage");
  for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(o[k] - stage[k])).toBeLessThanOrEqual(1.5);
  expect(await overlay.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  expect(await overlay.locator(".hand-stage").first().evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  // The overlay layer is not over the guidance bar's taps, and never changes the size of the camera pane.
  const pill = page.locator(".live-pill");
  if (await pill.count()) {
    const p = await box(page, ".live-pill");
    const z = await page.evaluate(() => {
      const zi = (s: string) => Number(getComputedStyle(document.querySelector(s)!).zIndex) || 0;
      return [zi(".scan-overlay3d"), zi(".live-pill")];
    });
    expect(z[1]).toBeGreaterThanOrEqual(z[0]); // the pill is drawn on top of it
    expect(p.height).toBeGreaterThan(0);
  }
  // Glowing mesh over the real hand: the stage looks different with the layer than without it. The palm
  // view can finish quickly (and the layer goes away with the camera), so look as soon as the scene draws.
  const clip = { x: stage.x, y: stage.y, width: stage.width, height: stage.height };
  await expect
    .poll(
      async () => {
        if ((await overlay.count()) === 0) return -1; // the view already finished: nothing left to look at
        const withLayer = await page.screenshot({ clip, path: `test-results/hand3d-${tag}-live.png` });
        await overlay.evaluate((el) => ((el as HTMLElement).style.visibility = "hidden")).catch(() => undefined);
        const without = await page.screenshot({ clip });
        await overlay.evaluate((el) => ((el as HTMLElement).style.visibility = "visible")).catch(() => undefined);
        return differing(page, withLayer, without);
      },
      { timeout: 60_000, intervals: [100, 300, 600] },
    )
    .toBeGreaterThan(300);
  // The camera pane does not change size while it runs.
  const after = await box(page, ".scan .stage");
  expect(Math.abs(after.height - stage.height)).toBeLessThanOrEqual(1.5);

  await scanRemainingViews(page);

  // While the measurements are calculated: the hand takes the middle of the screen.
  const calc = page.locator(".calc-hand3d");
  await expect(calc).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Calculating your measurements…")).toBeVisible();
  await expect(page.locator(".scan-overlay3d")).toHaveCount(0); // the overlay is gone with the camera
  const c = await box(page, ".calc-hand3d");
  expect(c.x).toBeGreaterThanOrEqual(0);
  expect(c.x + c.width).toBeLessThanOrEqual(vp.width + 1);
  expect(c.y + c.height).toBeLessThanOrEqual(vp.height + 1);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `test-results/hand3d-${tag}-calculating.png` });

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your hand measurements", { timeout: 120_000 });
  await page.getByLabel("Unit").selectOption("mm");
  await page.getByLabel("Hand length").fill("181");
  await page.getByRole("button", { name: "See my size" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your glove size results");

  // The result page: the size still leads; the customer's own hand follows, with the honest caption.
  const card = page.locator(".result-hand3d");
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole("heading", { name: "Your hand" })).toBeVisible();
  await expect(card.getByText("An illustration drawn from the 21 hand points we measured, not a 3D scan.")).toBeVisible();
  await expect(card.getByRole("img")).toBeVisible();
  const hero = await box(page, ".result-hero");
  const h = await box(page, ".result-hand3d");
  expect(h.y).toBeGreaterThan(hero.y + hero.height - 1);
  const s = await box(page, ".result-hand3d-stage");
  expect(s.width).toBeLessThanOrEqual(vp.width);
  expect(s.height).toBeLessThanOrEqual(Math.max(vp.height * 0.46, 420) + 1); // capped: phones ~46vh, wide screens 420px
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.waitForTimeout(1200);
  await card.screenshot({ path: `test-results/hand3d-${tag}-result.png` });
  expect(errors).toEqual([]);
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });
    test(`the 3D hand: live overlay, calculating, result (${vp.name})`, async ({ page }) => {
      test.setTimeout(300_000);
      await handInTheFlow(page, vp.name);
    });
  });
}

test.describe("the way out of the 3D layer", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("config can switch it off: no 3D layer, the 2D hand is drawn as before", async ({ page }) => {
    test.setTimeout(240_000);
    await overlayConfig(page, { enabled: false });
    await startCustomerScan(page);
    await expect(page.locator(".scan .stage")).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(".live-pill")).toBeVisible({ timeout: 120_000 }); // the scan is running
    await expect(page.locator(".scan-overlay3d")).toHaveCount(0);
    await expect(page.locator(".scan .stage .hand-stage")).toHaveCount(0);
    // The 2D layer draws the hand outline, skeleton and finger tags itself.
    await expect.poll(() => drawn2d(page), { timeout: 90_000 }).toBeGreaterThan(500);
    await page.screenshot({ path: "test-results/hand3d-kill-switch-2d.png" });
  });

  test("a layer that runs too slowly gives the drawing back to 2D, and the scan carries on", async ({ page }) => {
    test.setTimeout(300_000);
    // Impossible budget: the scan loop can never reach 1000 fps, so after half a second it must fall back.
    await overlayConfig(page, { enabled: true, max_frame_ms: 100_000, min_fps: 1000, fallback_after_slow_s: 0.5 });
    await startCustomerScan(page);
    await expect(page.locator(".live-pill")).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(".scan-overlay3d")).toHaveCount(0, { timeout: 60_000 });
    await expect.poll(() => drawn2d(page), { timeout: 90_000 }).toBeGreaterThan(500); // the 2D hand took over
    // No restart and no lost frames: the palm view still completes and asks for the next angle.
    await expect(page.getByRole("button", { name: NEXT_VIEW_BUTTONS[0] })).toBeVisible({ timeout: 180_000 });
    await page.screenshot({ path: "test-results/hand3d-fallback-2d.png" });
  });
});
