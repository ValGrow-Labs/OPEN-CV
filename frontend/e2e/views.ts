// Helpers for the guided angles (palm -> back of hand -> side view) in the customer flow.
// The fake camera plays the same hand video for every view, so each view finds a hand and a coin.
import { expect, type Page } from "@playwright/test";

/** The views after the palm, in the order the customer is guided through them (config capture.views). */
export const NEXT_VIEW_BUTTONS = ["Scan back of hand", "Scan side view"] as const;

/** Start a customer scan up to the camera: coin question, quick guide, camera. */
export async function startCustomerScan(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Start Scan" }).click();
  // The coin must be confirmed before the camera starts.
  await page.getByRole("button", { name: /Yes, this is my coin/ }).click();
  // Walk through the quick guide; the camera starts only at the end.
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: /Start camera/ }).click();
}

export interface SheetCheck {
  /** Prefix of the screenshot file name written for each card (test-results/<prefix>-<n>.png). */
  shots?: string;
  /** Also assert the layout rules of the next-angle sheet (thumb reach, no scrolling, 56 px button). */
  layout?: boolean;
}

/** After the palm: scan the back of the hand, then the side view (each needs one tap on its card). */
export async function scanRemainingViews(page: Page, check: SheetCheck = {}): Promise<void> {
  for (const [i, name] of NEXT_VIEW_BUTTONS.entries()) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeVisible({ timeout: 120_000 });
    // Required views offer no way to skip to the size.
    await expect(page.getByRole("button", { name: "Skip, see my size" })).toHaveCount(0);
    await expect(page.getByText(`Step ${i + 2} of 3`)).toBeVisible();
    await page.waitForTimeout(400); // let the sheet settle before it is photographed
    if (check.shots) await page.screenshot({ path: `test-results/${check.shots}-card${i + 2}.png` });
    if (check.layout) await expectSheetLayout(page);
    await button.click();
  }
}

/** The rules the next-angle sheet is built to: bottom-aligned, thumb-sized button, no scrolling. */
export async function expectSheetLayout(page: Page): Promise<void> {
  const vp = page.viewportSize()!;
  const sheet = page.locator(".view-sheet");
  const box = (await sheet.boundingBox())!;
  const portrait = vp.height >= vp.width;
  // inside the screen, and on the bottom edge (portrait) or the right edge (landscape)
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  if (portrait) {
    expect(Math.abs(box.y + box.height - vp.height)).toBeLessThanOrEqual(2);
    expect(box.width).toBeGreaterThanOrEqual(vp.width - 2); // full width
    expect(box.height).toBeLessThanOrEqual(vp.height * 0.7); // leaves the camera picture visible
  } else {
    expect(Math.abs(box.x + box.width - vp.width)).toBeLessThanOrEqual(2);
  }
  // nothing to scroll
  const scrolls = await sheet.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(scrolls).toBeLessThanOrEqual(1);
  // the primary button is a thumb target
  const btn = (await sheet.getByRole("button").first().boundingBox())!;
  expect(btn.height).toBeGreaterThanOrEqual(56);
  expect(btn.y + btn.height).toBeLessThanOrEqual(vp.height + 1);
  // no horizontal scrolling of the page
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}
