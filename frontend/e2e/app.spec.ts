import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const truth = JSON.parse(readFileSync(resolve(__dirname, ".media/coin.json"), "utf-8")) as { diameter_px: number };

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

test("welcome screen, privacy notice and demo disclaimer", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Find your glove size");
  await expect(page.getByText("Your video never leaves this device.")).toBeVisible();
  await expect(page.getByText("Demo size chart")).toBeVisible();
  await expect(page.getByRole("radio", { checked: true })).toHaveValue("demo-length-v1");
  await page.screenshot({ path: "test-results/welcome.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("scan starts the camera, loads MediaPipe and OpenCV, and guides the user", async ({ page }) => {
  const errors = collectErrors(page);
  const scanRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/scan")) scanRequests.push(r.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start Scan" }).click();
  await expect(page.getByRole("dialog", { name: "Before you start" })).toBeVisible();
  await page.getByRole("button", { name: "Skip guide" }).click();
  // No hand in the synthetic video: the scanner must be running and asking for the palm.
  await expect(page.locator(".live-pill")).toHaveText("Show your open palm to the camera");
  const video = await page.locator(".stage video").evaluate((v: HTMLVideoElement) => ({
    w: v.videoWidth,
    h: v.videoHeight,
    playing: !v.paused && v.readyState >= 2,
  }));
  expect(video).toEqual({ w: 1280, h: 720, playing: true });
  await expect(page.getByText("0 / 24 frames")).toBeVisible();
  await page.screenshot({ path: "test-results/scan.png" });
  expect(scanRequests).toEqual([]); // nothing is sent without accepted frames
  await page.getByRole("button", { name: "Cancel scan" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Find your glove size");
  expect(errors).toEqual([]);
});

test("operator calibration detects the coin with OpenCV.js in the browser", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/#/calibration");
  await expect(page.getByText("Calibration acceptable")).toBeVisible();
  const diameterText = await page.locator("tr", { hasText: "Diameter (major axis)" }).locator("td").nth(1).innerText();
  const diameter = parseFloat(diameterText);
  expect(Math.abs(diameter - truth.diameter_px)).toBeLessThan(0.01 * truth.diameter_px);
  await page.screenshot({ path: "test-results/calibration.png", fullPage: true });
  expect(errors).toEqual([]);
});
