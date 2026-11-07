// Where the glowing 3D hand shows up in the customer flow: the camera picture itself during the scan (a
// transparent 3D layer drawn over the real hand, with the live finger lengths), a large one while the
// measurements are calculated, and the customer's own hand on the result page. Also the way out: config can
// switch the 3D layer off, and a layer that runs too slowly hands the drawing back to the 2D hand without
// restarting the scan. The screenshots (test-results/hand3d-*.png) are for looking at.
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeConfig, type ScanTiming } from "./scanConfig";
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

/** The browser's copy of /api/config with the 3D layer's settings and the scan timing replaced (see scanConfig.ts). */
const overlayConfig = (page: Page, overlay3d: Record<string, unknown>, timing?: ScanTiming) => routeConfig(page, { overlay3d, timing });

/** Each view needs 40 accepted frames (a few seconds at the shipped 50 ms interval): time to look at the live layer. */
const LONGER_VIEWS: ScanTiming = { frames: 40 };
/** A view that stays open for as long as the test needs. */
const HOLD_OPEN: ScanTiming = "hold";

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

/** The picture itself inside the camera pane: the video drawn with `object-fit: contain`, without the bars the
 *  pane shows around it (light blue in the app's theme). */
async function pictureBox(page: Page) {
  return page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>(".scan .stage video")!;
    const r = v.getBoundingClientRect();
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    return { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, width: w, height: h };
  });
}

/** What the camera picture looks like: the share of its pixels that are bright (the white room behind the hand)
 *  and the share that are dark, from a screenshot decoded in the page. With `withoutLayer` everything the app draws
 *  over the picture besides the black mask is hidden for the shot (the glowing 3D layer with its white label pills,
 *  and the white guidance pill): only the camera picture and the mask are measured, because pills and glow are bright
 *  pixels of their own and say nothing about whether the room went black. */
async function paneLight(page: Page, path?: string, withoutLayer = false) {
  const clip = await pictureBox(page);
  const covers = page.locator(".scan-overlay3d, .live-pill");
  const hide = withoutLayer && (await covers.count()) > 0;
  // display: none, not visibility: the label pills set their own visibility, which beats a hidden parent.
  const setDisplay = (d: string) => covers.evaluateAll((els, value) => els.forEach((el) => ((el as HTMLElement).style.display = value)), d);
  if (hide) await setDisplay("none");
  let png: Buffer;
  try {
    png = await page.screenshot({ clip, path });
  } finally {
    if (hide) await setDisplay("").catch(() => undefined);
  }
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let bright = 0;
    let dark = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      const luma = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (luma > 200) bright++;
      else if (luma < 40) dark++;
    }
    return { bright: bright / n, dark: dark / n };
  }, png.toString("base64"));
}

/** Pixels in the 2D drawing canvas of the camera pane that are not transparent (the hand outline, the coin ring). */
const drawn2d = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".scan .stage canvas:not(.hand-stage-gl canvas):not(.focus-mask-canvas)");
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return -1;
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
    return n;
  });

/** Non-transparent pixels on the focus-mask canvas (-1: there is none). */
const maskCanvasInk = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".scan .stage canvas.focus-mask-canvas");
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
  await overlayConfig(page, GENEROUS, LONGER_VIEWS);
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
  const clip = { x: stage.x, y: stage.y, width: stage.width, height: stage.height };
  await page.screenshot({ clip, path: `test-results/hand3d-${tag}-live.png` });
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
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hand measurement complete");

  // The result page: one card with the customer's own hand, the suggested size and the honest caption.
  const card = page.locator(".rv2-hero");
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText("An illustration drawn from the 21 hand points we measured, not a 3D scan.")).toBeVisible();
  await expect(card.getByRole("img")).toBeVisible();
  await expect(card.locator(".rv2-size .size")).toBeVisible();
  const hand = await box(page, ".rv2-stage");
  const size = await box(page, ".rv2-size");
  expect(size.y).toBeGreaterThan(hand.y + hand.height - 1); // the size sits below the hand
  const s = await box(page, ".rv2-stage-box");
  expect(s.width).toBeLessThanOrEqual(vp.width);
  expect(s.height).toBeLessThanOrEqual(471); // capped
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.waitForTimeout(1200);
  await card.screenshot({ path: `test-results/hand3d-${tag}-result.png` });
  await page.screenshot({ path: `test-results/hand3d-${tag}-result-page.png`, fullPage: true });
  expect(errors).toEqual([]);
}

test.describe("the glowing layer over the real hand", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the picture looks different with the layer than without it", async ({ page }) => {
    test.setTimeout(240_000);
    await overlayConfig(page, GENEROUS, HOLD_OPEN); // the palm view stays open: nothing to race
    await startCustomerScan(page);
    const overlay = page.locator(".scan-overlay3d");
    await expect(overlay.locator("canvas")).toBeVisible({ timeout: 120_000 });
    const stage = await box(page, ".scan .stage");
    const clip = { x: stage.x, y: stage.y, width: stage.width, height: stage.height };
    await expect
      .poll(
        async () => {
          const withLayer = await page.screenshot({ clip });
          await overlay.evaluate((el) => ((el as HTMLElement).style.visibility = "hidden"));
          const without = await page.screenshot({ clip });
          await overlay.evaluate((el) => ((el as HTMLElement).style.visibility = "visible"));
          return differing(page, withLayer, without);
        },
        { timeout: 90_000, intervals: [200, 500, 1000] },
      )
      .toBeGreaterThan(300);
  });
});

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
    await overlayConfig(page, { enabled: false }, HOLD_OPEN);
    await startCustomerScan(page);
    await expect(page.locator(".scan .stage")).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(".live-pill")).toBeVisible({ timeout: 120_000 }); // the scan is running
    await expect(page.locator(".scan-overlay3d")).toHaveCount(0);
    await expect(page.locator(".scan .stage .hand-stage")).toHaveCount(0);
    await expect(page.locator(".focus-mask-canvas")).toHaveCount(0); // no black, no extra canvas
    // The 2D layer draws the hand outline, skeleton and finger tags itself.
    await expect.poll(() => drawn2d(page), { timeout: 90_000 }).toBeGreaterThan(500);
    expect((await paneLight(page)).bright).toBeGreaterThan(0.1); // the whole picture, no black
    await page.screenshot({ path: "test-results/hand3d-kill-switch-2d.png" });
  });

  test("a lost WebGL context gives the drawing back to 2D, says why, and the scan carries on", async ({ page }) => {
    test.setTimeout(300_000);
    // The speed guard's own switch-off (too heavy at its cheapest level) is timed over many seconds and is covered by
    // the unit tests and e2e/overlay-throttle.spec.ts; the way out itself is the same, so here the browser takes
    // the graphics context away, as a phone short of memory does.
    await overlayConfig(page, { ...GENEROUS, focus_mask: true }, LONGER_VIEWS);
    await startCustomerScan(page);
    await expect(page.locator(".scan-overlay3d canvas")).toBeVisible({ timeout: 120_000 });
    await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>(".scan-overlay3d canvas")!;
      const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext;
      gl.getExtension("WEBGL_lose_context")!.loseContext();
    });
    await expect(page.locator(".scan-overlay3d")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator(".scan-note")).toContainText(/graphics memory/);
    await expect(page.locator(".scan-note")).toContainText(/measuring is not affected/);
    await expect.poll(() => drawn2d(page), { timeout: 90_000 }).toBeGreaterThan(500); // the 2D hand took over
    // ... and the black is wiped from the mask canvas (nothing left on it).
    await expect.poll(() => maskCanvasInk(page), { timeout: 30_000 }).toBe(0);
    expect((await paneLight(page)).bright).toBeGreaterThan(0.1); // and the room is back in view
    // No restart and no lost frames: the palm view still completes and asks for the next angle.
    await expect(page.getByRole("button", { name: NEXT_VIEW_BUTTONS[0] })).toBeVisible({ timeout: 180_000 });
    await page.screenshot({ path: "test-results/hand3d-fallback-2d.png" });
  });
});

// The black background: while the 3D layer draws the measuring, everything but the hand and the coin is black
// (display only). The fake camera shows the hand on a white sheet, so a bright pane means the room is visible.
for (const vp of [VIEWPORTS[0], VIEWPORTS[3]]) {
  test.describe(`black background (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });

    test("the room goes black around the hand and the coin", async ({ page }) => {
      test.setTimeout(300_000);
      await overlayConfig(page, { ...GENEROUS, focus_mask: true }, HOLD_OPEN); // the black is opt-in (shipped off)
      await startCustomerScan(page);
      await expect(page.locator(".scan-overlay3d canvas")).toBeVisible({ timeout: 120_000 });
      // The black fades in once a hand is tracked; the picture is the sheet's white until then.
      await expect
        .poll(async () => (await paneLight(page, undefined, true)).bright, { timeout: 120_000, intervals: [300, 600] })
        .toBeLessThan(0.1); // the white sheet is 40% of the picture without the black
      // The black has a small canvas of its own (not the camera's resolution), laid exactly over the 2D drawing
      // canvas and the video, so `object-fit: contain` keeps it aligned.
      const geometry = await page.evaluate(() => {
        const q = (s: string) => document.querySelector<HTMLCanvasElement | HTMLVideoElement>(s)!;
        const mask = q(".scan .stage canvas.focus-mask-canvas") as HTMLCanvasElement;
        const draw = q(".scan .stage canvas:not(.hand-stage-gl canvas):not(.focus-mask-canvas)") as HTMLCanvasElement;
        const video = q(".scan .stage video") as HTMLVideoElement;
        const r = (el: Element) => el.getBoundingClientRect().toJSON();
        return { mask: [mask.width, mask.height], draw: [draw.width, draw.height], video: [video.videoWidth, video.videoHeight], rm: r(mask), rd: r(draw), rv: r(video) };
      });
      expect(Math.max(...geometry.mask)).toBeLessThanOrEqual(480); // config live_scan.overlay_3d.focus_mask_max_px
      expect(Math.abs(geometry.mask[0] / geometry.mask[1] - geometry.video[0] / geometry.video[1])).toBeLessThan(0.02); // the video's aspect
      for (const k of ["x", "y", "width", "height"] as const) {
        expect(Math.abs(geometry.rm[k] - geometry.rd[k])).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.rm[k] - geometry.rv[k])).toBeLessThanOrEqual(1);
      }
      expect(await maskCanvasInk(page)).toBeGreaterThan(1000); // the black is on the mask canvas, not on the 2D one
      await page.screenshot({ clip: await pictureBox(page), path: `test-results/hand3d-focus-${vp.name}.png` }); // for looking at, with the layer
      const shot = await paneLight(page, undefined, true);
      expect(shot.dark).toBeGreaterThan(0.5); // black around the hand
      expect(shot.dark).toBeLessThan(0.97); // and the hand and the coin are still there to be seen
    });

    test("with focus_mask off (the shipped setting) the 3D hand sits over the normal picture", async ({ page }) => {
      test.setTimeout(300_000);
      await overlayConfig(page, { ...GENEROUS, focus_mask: false }, HOLD_OPEN);
      await startCustomerScan(page);
      await expect(page.locator(".scan-overlay3d canvas")).toBeVisible({ timeout: 120_000 });
      await expect.poll(async () => (await paneLight(page)).bright, { timeout: 120_000 }).toBeGreaterThan(0.2);
      await page.waitForTimeout(2000); // long enough for the black to have come in, if it were on
      await expect(page.locator(".focus-mask-canvas")).toHaveCount(0); // and no canvas for it
      const shot = await paneLight(page, `test-results/hand3d-focus-off-${vp.name}.png`);
      expect(shot.bright).toBeGreaterThan(0.2);
    });
  });
}
