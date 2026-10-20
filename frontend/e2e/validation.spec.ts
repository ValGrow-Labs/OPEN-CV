// Developer validation mode end to end: form -> real browser scan (fake camera playing the
// hand photo with a SYNTHETIC coin) -> server-computed errors -> summary. This checks the
// plumbing only. The record is marked as a software test, so it must never count as a
// real-world result, and it is written to a throwaway file.
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

test("validation mode records a software-test scan without counting it", async ({ page }) => {
  await page.goto("/#/validation");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Measurement validation");
  await expect(page.getByText(/Real-world camera tests only/)).toBeVisible();
  await expect(page.getByText(/uncalibrated, not validated/)).toBeVisible();

  await page.getByLabel(/Software test/).check();
  await page.getByLabel("Participant code").fill("E2E-0001");
  await page.getByLabel("Right").check();
  await page.getByLabel("Reading 1").fill("185");
  await page.getByLabel("Reading 2").fill("185.5");
  await expect(page.getByText(/Readings agree/)).toBeVisible();
  await page.getByLabel("Device and camera").fill("Chrome fake camera (synthetic)");
  await page.getByRole("button", { name: "Scan and record" }).click();
  await page.getByRole("button", { name: /Yes, this is my coin/ }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Measurement validation", { timeout: 120_000 });
  await expect(page.getByRole("status").filter({ hasText: /Recorded/ })).toContainText("software test, not counted");
  // Running accuracy is shown right under the result; a software test never counts towards it.
  await expect(page.getByLabel("Running accuracy")).toContainText("No scored scans yet");
  // Other specs (the remote pilot) may add test records to the same throwaway file.
  await expect(page.getByText(/Tests \(\d+\)/)).toBeVisible();
  const row = page.locator(".validation-table tbody tr").filter({ hasText: "E2E-0001" });
  await expect(row).toContainText("E2E-0001");
  await expect(row).toContainText("software test");
  await expect(row).toContainText("185.3 mm");
  // Not counted as a real-world result.
  await expect(page.getByRole("region", { name: "Real-participant results" }).getByText(/No real-participant results yet/)).toBeVisible();
  await expect(page.getByText(/software test \d+/)).toBeVisible();
  await page.screenshot({ path: "test-results/validation.png", fullPage: true });
});
