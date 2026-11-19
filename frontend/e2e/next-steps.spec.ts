// The simple results page's Next steps, the per-scan thumb hint and Copy results, on a phone (390 x 844) and a narrow one (320).
// The scan runs for real (fake camera, hand photo); only the thumb's reported tilt is patched in the server's answer, because the
// sample photo's thumb is not turned out of the palm plane. The screenshots go to $NEXT_STEPS_SHOTS (default test-results/next-steps).
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRemainingViews, startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

const SHOTS = process.env.NEXT_STEPS_SHOTS ?? "test-results/next-steps";
mkdirSync(SHOTS, { recursive: true });

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, permissions: ["camera", "clipboard-read", "clipboard-write"] });

test("next steps, the thumb hint and Copy results on the simple results page", async ({ page }) => {
  test.setTimeout(420_000);
  await page.route("**/api/scan", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    for (const m of json.measurements ?? []) if (m.key === "thumb_length_mm") m.finger_tilt_deg = 41;
    await route.fulfill({ response, json });
  });
  await startCustomerScan(page);
  await scanRemainingViews(page);
  await expect(page.getByRole("heading", { level: 1, name: "Your hand", exact: true })).toBeVisible({ timeout: 180_000 });

  // the per-scan thumb hint, with its limit stated, next to the finger rows
  const hint = page.getByTestId("thumb-hint");
  await expect(hint).toContainText("Your thumb was turned about 40° out of the palm plane");
  await expect(hint).toContainText("Spread it flat and scan again");

  // a short, numbered list between the card and More details
  const steps = page.getByRole("region", { name: "Next steps" });
  await expect(steps).toBeVisible();
  const items = await steps.locator("ol li").allTextContents();
  expect(items.length).toBeGreaterThanOrEqual(3);
  expect(items.length).toBeLessThanOrEqual(4);
  expect(items[0]).toMatch(/size/);
  expect(items.some((s) => /scan again with your hand flat, fingers spread, thumb out and the whole coin visible/.test(s))).toBe(true);
  expect(items[items.length - 1]).toMatch(/More details/);
  const stepsBox = (await steps.boundingBox())!;
  const moreBox = (await page.getByRole("button", { name: /More details/ }).boundingBox())!;
  expect(stepsBox.y + stepsBox.height).toBeLessThanOrEqual(moreBox.y + 1);

  await page.screenshot({ path: `${SHOTS}/crease-with-hint.png`, fullPage: true });
  await page.getByRole("radio", { name: "Knuckle to tip" }).click();
  await page.screenshot({ path: `${SHOTS}/knuckle-with-hint.png`, fullPage: true });

  // Copy results: a plain-text summary on the clipboard and a visible confirmation
  await page.getByRole("button", { name: "Copy results" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("MILLIMESH hand estimate (unvalidated prototype)");
  expect(text).toMatch(/Hand length: ≈ \d+\.\d cm/);
  expect(text).toContain("Finger length, knuckle to tip:");
  expect(text).toMatch(/not validated and not a guarantee of fit/);
  expect(text.split("\n").filter((l) => /^ {2}(Thumb|Index|Middle|Ring|Little):/.test(l))).toHaveLength(5);

  // narrow phone: nothing overflows sideways
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole("radio", { name: "Crease to tip (est.)" }).click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/crease-with-hint-320.png`, fullPage: true });

  // the detailed page is still one tap away
  await page.getByRole("button", { name: /More details/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your hand measurements", { timeout: 60_000 });
});
