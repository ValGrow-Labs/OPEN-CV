// ?debug on the real scan screen: every line the phone test needs is there and shows live values, including the
// real connection to the sizing API from this page (fake camera, software WebGL: not a phone test).
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeConfig } from "./scanConfig";
import { startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test("?debug shows camera, hand, coin, frames, the layers, WebGL errors and the API connection", async ({ page }) => {
  test.setTimeout(240_000);
  await routeConfig(page, { timing: "hold" }); // the view stays open while the panel is read
  await startCustomerScan(page, "/?debug");
  const panel = page.getByRole("region", { name: "Diagnostics" });
  await expect(panel).toBeVisible({ timeout: 120_000 });
  await expect(panel).toContainText(/camera\s+running/, { timeout: 120_000 });
  await expect(panel).toContainText(/stream\s+\d+x\d+/);
  await expect(panel).toContainText(/hand\s+found/, { timeout: 120_000 });
  await expect(panel).toContainText(/coin\s+accepted/, { timeout: 120_000 });
  await expect(panel).toContainText(/frames\s+accepted [1-9]\d* \/ \d+/, { timeout: 120_000 });
  await expect(panel).toContainText(/3d layer\s+off.*particles/); // the MILLIMESH scan draws particles
  await expect(panel).toContainText(/3d card\s+ok/);
  await expect(panel).toContainText(/webgl\s+no errors seen/);
  await expect(panel).toContainText(/api\s+OK HTTP 200 · \d+ ms · v/, { timeout: 30_000 }); // the page's own /api/health
  await expect(panel).toContainText(/secure context/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/scan-debug-phone-390.png" });
});
