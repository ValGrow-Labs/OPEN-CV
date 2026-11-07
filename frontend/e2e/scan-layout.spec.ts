// The measuring screen on every screen size: a full-width camera picture in the shape of the real video (no empty
// side bars, nothing cropped), the status with hand and coin apart, a dedicated 3D hand card, and the live
// measurements in two columns. Also: nothing overlaps, nothing scrolls sideways, the console stays clean, and the
// two honest empty states (camera permission denied; no hand or coin in the picture).
// The fake camera plays the sample hand photo; this is a software-WebGL, fake-camera test, not a phone test.
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeConfig } from "./scanConfig";
import { startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

const VIEWPORTS = [
  { name: "phone-360", width: 360, height: 740, touch: true, side: false },
  { name: "phone-390", width: 390, height: 844, touch: true, side: false },
  { name: "phone-430", width: 430, height: 932, touch: true, side: false },
  { name: "tablet-768", width: 768, height: 1024, touch: true, side: false },
  { name: "phone-844-landscape", width: 844, height: 390, touch: true, side: true },
  { name: "desktop-1280", width: 1280, height: 800, touch: false, side: true },
];

// Software WebGL is far slower than a phone GPU: the 3D hand over the picture must not trip its speed guard here.
const GENEROUS = { enabled: true, max_frame_ms: 100_000, min_fps: 0.01, fallback_after_slow_s: 600 };

// The first view stays open for the whole test (scanConfig.ts), at the shipped 50 ms frame interval.
const overlayConfig = (page: Page, overlay3d: Record<string, unknown>) => routeConfig(page, { overlay3d, timing: "hold" });

const rect = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }, selector);

const overlaps = (a: NonNullable<Awaited<ReturnType<typeof rect>>>, b: NonNullable<Awaited<ReturnType<typeof rect>>>) =>
  a.x < b.right - 1 && b.x < a.right - 1 && a.y < b.bottom - 1 && b.y < a.bottom - 1;

function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // Chrome's own notices about the fake camera and favicon are not the app's.
    if (/favicon|Failed to load resource/.test(t)) return;
    problems.push(`console.error: ${t}`);
  });
  return problems;
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });

    test(`measuring screen layout (${vp.name})`, async ({ page }) => {
      test.setTimeout(240_000);
      const problems = watchConsole(page);
      await overlayConfig(page, GENEROUS);
      await startCustomerScan(page);
      await expect(page.locator(".scan .stage")).toBeVisible({ timeout: 120_000 });
      await expect(page.locator(".live-pill")).toBeVisible({ timeout: 120_000 });

      // 1. The camera frame has the shape of the video: no empty bars, nothing cropped or stretched.
      const shape = await page.evaluate(() => {
        const v = document.querySelector<HTMLVideoElement>(".scan .stage video")!;
        const s = document.querySelector<HTMLElement>(".scan .stage")!.getBoundingClientRect();
        return { vw: v.videoWidth, vh: v.videoHeight, sw: s.width, sh: s.height };
      });
      expect(shape.vw).toBeGreaterThan(0);
      expect(Math.abs(shape.sw / shape.sh - shape.vw / shape.vh)).toBeLessThan(0.03);

      // 2. On a phone the picture runs edge to edge (unless its own height cap makes it narrower, then it is centred).
      const stage = (await rect(page, ".scan .stage"))!;
      if (!vp.side) {
        const cap = vp.height * 0.7 * (shape.vw / shape.vh);
        const expectWidth = Math.min(vp.width, cap);
        expect(stage.width).toBeGreaterThanOrEqual(expectWidth - 2);
        if (vp.width <= 430) expect(stage.x).toBeLessThanOrEqual(Math.max(0, (vp.width - expectWidth) / 2) + 2);
      }

      // 3. No horizontal scrolling anywhere.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => { const s = document.querySelector(".scan")!; return s.scrollWidth - s.clientWidth; })).toBeLessThanOrEqual(0);

      // 4. The cards exist and sit where the layout says: below the camera on a phone, beside it on a wide screen.
      await page.locator(".scan-3d").scrollIntoViewIfNeeded();
      const card3d = (await rect(page, ".scan-3d"))!;
      const measure = (await rect(page, ".scan-measure"))!;
      const panel = (await rect(page, ".scan-panel"))!;
      for (const r of [card3d, measure, panel]) {
        expect(r.width).toBeGreaterThan(150);
        expect(r.height).toBeGreaterThan(60);
        expect(r.x).toBeGreaterThanOrEqual(-1);
        expect(r.right).toBeLessThanOrEqual(vp.width + 1);
      }
      expect(overlaps(card3d, measure)).toBe(false);
      expect(overlaps(card3d, panel)).toBe(false);
      expect(overlaps(measure, panel)).toBe(false);
      const stageNow = (await rect(page, ".scan .stage"))!;
      if (vp.side) {
        expect(card3d.x).toBeGreaterThanOrEqual(stageNow.right - 1); // beside the camera
        expect(overlaps(stageNow, card3d)).toBe(false);
      } else {
        expect(card3d.width).toBeGreaterThan(vp.width * 0.8); // a full-width card
      }

      // 5. The measurements: two columns, eight labels, units in mm, nothing invented before a reading exists.
      const labels = await page.locator(".scan-measure dt").allTextContents();
      expect(labels).toEqual(["Hand length", "Middle finger", "Index finger", "Ring finger", "Palm width", "Thumb", "Pinky finger", "Coin scale"]);
      const cols = await page.locator(".scan-measure .mcol").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x));
      expect(cols.length).toBe(2);
      expect(cols[1]).toBeGreaterThan(cols[0] + 50);
      const values = await page.locator(".scan-measure dd").allTextContents();
      for (const v of values) expect(v).toMatch(/^(—|\d+ mm|\d+\.\d+ px\/mm)/);

      // 6. Hand and coin status, apart; progress; Reset reachable.
      await expect(page.locator(".scan-chips .scan-chip")).toHaveCount(2);
      await expect(page.getByRole("progressbar", { name: "Scan progress" })).toBeVisible();
      await page.getByRole("button", { name: "Reset", exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "Reset", exact: true })).toBeVisible();

      // 7. The 3D hand card draws (or says clearly why not), with a canvas that has a real size.
      const canvas = page.locator(".scan-3d canvas");
      const note = page.locator(".scan-3d").getByText(/WebGL|unavailable|could not|not available/i);
      await expect.poll(async () => (await canvas.count()) + (await note.count()), { timeout: 90_000 }).toBeGreaterThan(0);
      if (await canvas.count()) {
        const c = (await rect(page, ".scan-3d canvas"))!;
        expect(c.width).toBeGreaterThan(150);
        expect(c.height).toBeGreaterThan(150);
      }
      await expect(page.locator(".scan-3d")).toContainText(/Estimated 3D landmark view/i);

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `test-results/scan-layout-${vp.name}.png`, fullPage: false });
      expect(problems).toEqual([]);
    });
  });
}

test.describe("empty states", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("camera permission denied: a clear message and a way back, nothing broken", async ({ page }) => {
    const problems = watchConsole(page);
    await page.addInitScript(() => {
      const denied = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = denied;
    });
    await startCustomerScan(page);
    const card = page.locator(".stage-card[role='alert']");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.locator("h2")).not.toBeEmpty();
    await expect(card.getByRole("button", { name: "Back" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/scan-layout-permission-denied.png" });
    expect(problems.filter((p) => !/NotAllowed|Permission denied|camera/i.test(p))).toEqual([]);
  });

  test("no hand and no coin in the picture: the status says so, no measurement is invented", async ({ page }) => {
    const problems = watchConsole(page);
    await overlayConfig(page, GENEROUS);
    await page.addInitScript(() => {
      // A flat grey picture: nothing to find.
      const c = document.createElement("canvas");
      c.width = 640;
      c.height = 480;
      const ctx = c.getContext("2d")!;
      const draw = () => {
        ctx.fillStyle = "#808080";
        ctx.fillRect(0, 0, 640, 480);
      };
      draw();
      setInterval(draw, 100);
      navigator.mediaDevices.getUserMedia = () => Promise.resolve(c.captureStream(10));
    });
    await startCustomerScan(page);
    await expect(page.locator(".live-pill")).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(".scan-chips")).toContainText("No hand yet");
    await expect(page.locator(".scan-chips")).toContainText("Coin not found");
    const values = await page.locator(".scan-measure dd").allTextContents();
    expect(values.every((v) => v.startsWith("—"))).toBe(true); // nothing shown as a result
    await expect(page.locator(".scan-panel")).toContainText("0 / ");
    expect(problems).toEqual([]);
  });
});
