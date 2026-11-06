// Where the glowing 3D hand shows up in the customer flow: a small live tile during the scan, a large one
// while the measurements are calculated, and the customer's own hand on the result page. The screenshots
// (test-results/hand3d-*.png) are for looking at; the assertions check the placement and the honest caption.
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRemainingViews, startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

const VIEWPORTS = [
  { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "phone-320", width: 320, height: 568, touch: true },
  { name: "phone-390-landscape", width: 844, height: 390, touch: true },
  { name: "desktop-1280", width: 1280, height: 800, touch: false },
];

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

async function handInTheFlow(page: Page, tag: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Slow the sizing request a little so the "calculating" screen can be looked at.
  await page.route("**/api/scan", async (route) => {
    await new Promise((r) => setTimeout(r, 3500));
    await route.continue();
  });

  await startCustomerScan(page);

  // During the live scan: a small tile in the camera area, clear of the guidance bar and the scan panel.
  // (A phone on its side leaves the camera picture a sliver, so there the tile is not shown.)
  const vp = page.viewportSize()!;
  const sideways = vp.width > vp.height && vp.height <= 560;
  const tile = page.locator(".scan-hand3d");
  if (sideways) {
    await expect(page.locator(".scan .stage")).toBeVisible({ timeout: 120_000 });
    await expect(tile).toBeHidden();
  } else {
    await expect(tile).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(300); // the scene's first frames
    await page.screenshot({ path: `test-results/hand3d-${tag}-live.png` });
    const t = await box(page, ".scan-hand3d");
    const stage = await box(page, ".scan .stage");
    expect(t.x).toBeGreaterThanOrEqual(stage.x - 1);
    expect(t.x + t.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
    expect(t.y).toBeGreaterThanOrEqual(stage.y - 1);
    expect(t.y + t.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
    expect(t.height).toBeLessThanOrEqual(stage.height * 0.41); // a tile, not a second camera picture
    const pill = page.locator(".live-pill");
    if (await pill.count()) {
      const p = await box(page, ".live-pill");
      expect(t.y).toBeGreaterThanOrEqual(p.y + p.height - 1); // never over the guidance bar
    }
  }

  await scanRemainingViews(page);

  // While the measurements are calculated: the hand takes the middle of the screen.
  const calc = page.locator(".calc-hand3d");
  await expect(calc).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Calculating your measurements…")).toBeVisible();
  await expect(page.locator(".scan-hand3d")).toHaveCount(0); // the small tile is gone
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
    test(`the 3D hand: live tile, calculating, result (${vp.name})`, async ({ page }) => {
      test.setTimeout(300_000);
      await handInTheFlow(page, vp.name);
    });
  });
}
