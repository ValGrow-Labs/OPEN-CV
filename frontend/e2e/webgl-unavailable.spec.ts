// When the browser has no WebGL at all (some old phones, blocked GPUs, privacy modes), the app must still scan
// and size: the glowing hand over the picture is replaced by the flat outline, the 3D card says in words why it
// is empty, the calculating screen and the result page show their non-3D versions, and nothing throws.
// WebGL is switched off by making every WebGL context request fail, which is what such a browser does.
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeConfig } from "./scanConfig";
import { scanRemainingViews, startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function noWebgl(page: Page) {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (/webgl/i.test(type)) return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...rest) as never;
    } as typeof original;
  });
}

function watchErrors(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

test("without WebGL the scan screen says so, draws the flat hand and keeps working", async ({ page }) => {
  test.setTimeout(240_000);
  const problems = watchErrors(page);
  await noWebgl(page);
  await routeConfig(page, { timing: "hold" }); // the view stays open while the screen is looked at
  await startCustomerScan(page);
  await expect(page.locator(".live-pill")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".scan-overlay3d")).toHaveCount(0);
  await expect(page.locator(".scan-note")).toContainText(/needs WebGL/);
  await expect(page.locator(".scan-note")).toContainText(/measuring is not affected/);
  // The flat outline and skeleton are drawn by the 2D layer instead.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = document.querySelector<HTMLCanvasElement>(".scan .stage canvas:not(.focus-mask-canvas)");
          const ctx = c?.getContext("2d");
          if (!c || !ctx) return -1;
          const px = ctx.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
          return n;
        }),
      { timeout: 90_000 },
    )
    .toBeGreaterThan(500);
  // The 3D card explains itself instead of staying blank, and offers no dead controls.
  const card = page.locator(".scan-3d");
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator(".lv-error")).toContainText(/3D view unavailable/);
  await expect(card.locator(".lv-error")).toContainText(/scan itself still works/);
  await expect(card.getByRole("button", { name: "Reset view" })).toHaveCount(0);
  await expect(card.locator("canvas")).toHaveCount(0);
  // The numbers and the status are still all there.
  await expect(page.locator(".scan-chips .scan-chip")).toHaveCount(2);
  await expect(page.locator(".length-item dt")).toHaveCount(6);
  await expect(page.locator(".lengths-main span")).toHaveText("Hand length");
  await expect(page.locator(".scan-pose")).toBeVisible(); // the pose reader needs no WebGL
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/webgl-unavailable-scan.png" });
  expect(problems).toEqual([]);
});

test("without WebGL the whole flow still ends in a result, with the flat hand picture", async ({ page }) => {
  test.setTimeout(300_000);
  const problems = watchErrors(page);
  await noWebgl(page);
  await startCustomerScan(page);
  await expect(page.locator(".live-pill")).toBeVisible({ timeout: 120_000 });
  await scanRemainingViews(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your hand measurements", { timeout: 120_000 });
  await page.getByLabel("Unit").selectOption("mm");
  await page.getByLabel("Hand length").fill("181");
  await page.getByRole("button", { name: "See my size" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hand measurement complete");
  const hero = page.locator(".rv2-hero");
  await expect(hero.locator(".rv2-size .size")).toBeVisible();
  // The hand picture falls back to its CSS-only version: no canvas, nothing blank, the caption is still honest.
  await expect(hero.locator(".hand-stage-fallback")).toBeVisible();
  await expect(hero.locator("canvas")).toHaveCount(0);
  await expect(hero.getByText("An illustration drawn from the 21 hand points we measured, not a 3D scan.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/webgl-unavailable-result.png", fullPage: true });
  expect(problems).toEqual([]);
});
