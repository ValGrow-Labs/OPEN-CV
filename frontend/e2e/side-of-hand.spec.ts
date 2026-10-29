// The scan checks that each guided view shows the right side of the hand: the back-of-hand view the OTHER
// side to the palm view, the side view the hand on its edge. The fake camera re-draws one hand video
// (e2e/views.ts); showing the same picture again must be refused, turning it must let the scan go on.
// These use a stand-in picture (mirrored / squeezed video), not real hands: they test the guard, not accuracy.
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { showSide, startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test("the back-of-hand view refuses the palm shown again, and goes on once the hand is turned over", async ({ page }) => {
  test.setTimeout(240_000);
  await startCustomerScan(page);
  const next = page.getByRole("button", { name: "Scan back of hand" });
  await expect(next).toBeVisible({ timeout: 120_000 });
  await next.click(); // the SAME unmirrored picture: still the palm

  // The customer is told what is wrong, and the view does not complete.
  await expect(page.getByText("That is your palm. Turn your hand over to show the back of your hand").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(8_000);
  await expect(page.getByText("Step 3 of 3")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Scan side view" })).toHaveCount(0);

  // Turning the hand over (the mirrored picture) lets the view finish.
  await showSide(page, "back");
  await expect(page.getByRole("button", { name: "Scan side view" })).toBeVisible({ timeout: 120_000 });
});

test("the side view refuses a hand still seen face-on, and goes on once it is on its edge", async ({ page }) => {
  test.setTimeout(300_000);
  await startCustomerScan(page);
  await expect(page.getByRole("button", { name: "Scan back of hand" })).toBeVisible({ timeout: 120_000 });
  await showSide(page, "back");
  await page.getByRole("button", { name: "Scan back of hand" }).click();
  const side = page.getByRole("button", { name: "Scan side view" });
  await expect(side).toBeVisible({ timeout: 120_000 });
  await side.click(); // still face-on (the back picture)

  await expect(page.getByText(/other side|on its edge/i).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(8_000);
  await expect(page.getByRole("heading", { level: 1, name: "Your hand measurements" })).toHaveCount(0); // not finished

  await showSide(page, "side");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your hand measurements", { timeout: 120_000 });
});
