// Full customer flow on a real hand photo (MediaPipe test asset) with a SYNTHETIC coin
// composited on the hand. Verifies the whole pipeline end to end and that the browser agrees
// with the Python offline pipeline on the same frames. It is not an accuracy measurement.
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const summaryPath = resolve(__dirname, ".media/hand.json");

test.skip(!existsSync(summaryPath), "hand test video not generated (run npm run e2e)");

/** Scroll through the page so reveal-on-scroll content enters, then let animations settle. */
async function scrollThrough(page: Page) {
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function fullScan(page: Page, tag: string) {
  const python = JSON.parse(readFileSync(summaryPath, "utf-8")) as { python_hand_length_mm: number; python_size: string };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const bodies: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/scan")) bodies.push(r.postData() ?? "");
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Start Scan" }).click();
  // Walk through the quick guide; the camera starts only at the end.
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: /Start camera/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your hand measurements", { timeout: 120_000 });

  // Only numeric observations are sent: no image data in the request.
  expect(bodies).toHaveLength(1);
  const body = JSON.parse(bodies[0]);
  expect(body.frames).toHaveLength(24);
  expect(bodies[0]).not.toMatch(/data:image|base64/);
  expect(Object.keys(body.frames[0]).sort()).toEqual(
    ["brightness", "coin", "handedness", "handedness_score", "image_height", "image_width", "landmarks", "timestamp_ms", "world_landmarks"].sort(),
  );

  // The value counts up on screen; data-value holds the final number.
  const value = (await page.locator("tr", { hasText: "Hand length" }).locator("[data-value]").getAttribute("data-value")) ?? "";
  const browserMm = parseFloat(value);
  // Browser (OpenCV.js + MediaPipe JS) vs Python (OpenCV + MediaPipe Python) on the same video.
  expect(Math.abs(browserMm - python.python_hand_length_mm) / python.python_hand_length_mm).toBeLessThan(0.02);
  await scrollThrough(page);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `test-results/${tag}measurements.png`, fullPage: true });

  await page.getByRole("button", { name: "See my size" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your glove size");
  await expect(page.locator(".size-tile .size")).toHaveText(python.python_size);
  await expect(page.getByText(/DEMONSTRATION CHART/)).toBeVisible();
  await scrollThrough(page);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `test-results/${tag}results.png`, fullPage: true });
  expect(errors).toEqual([]);
}

test("full scan: camera -> measurements -> size recommendation", async ({ page }) => {
  await fullScan(page, "");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("full scan on a phone-sized screen", async ({ page }) => {
    await fullScan(page, "rwd-phone-390-");
  });
});
