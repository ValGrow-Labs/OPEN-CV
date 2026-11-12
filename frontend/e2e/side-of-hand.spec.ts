// The scan checks that each guided view shows the right side of the hand: the side view the hand on its edge, the
// back-of-hand view the OTHER side to the palm view. The fake camera re-draws one hand video (e2e/views.ts); showing the
// wrong picture must be refused with a plain message, turning it must let the scan go on.
// These use a stand-in picture (mirrored / squeezed video), not real hands: they test the guard, not accuracy.
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { continueFromRecon, showSide, startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test("the side phase refuses a hand still seen face-on, and goes on once it is on its edge", async ({ page }) => {
  test.setTimeout(300_000);
  await startCustomerScan(page);
  const side = page.getByRole("button", { name: "Start side scan" });
  await expect(side).toBeVisible({ timeout: 180_000 });
  await side.click(); // still face-on (the palm picture)

  // The customer is told what is wrong, and the phase does not complete.
  await expect(page.getByText("Turn your hand on its edge, like a handshake, to show the side of your hand").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(8_000);
  await expect(page.getByRole("button", { name: "Start back scan" })).toHaveCount(0);
  await expect(page.getByRole("progressbar", { name: "Side Scan coverage" })).toHaveAttribute("aria-valuenow", "0"); // nothing counted

  // Putting the hand on its edge lets the phase finish.
  await showSide(page, "side");
  await expect(page.getByRole("button", { name: "Start back scan" })).toBeVisible({ timeout: 180_000 });
});

test("the back phase refuses the palm shown again, and goes on once the hand is turned over", async ({ page }) => {
  test.setTimeout(420_000);
  await startCustomerScan(page);
  await expect(page.getByRole("button", { name: "Start side scan" })).toBeVisible({ timeout: 180_000 });
  await showSide(page, "side");
  await page.getByRole("button", { name: "Start side scan" }).click();
  const back = page.getByRole("button", { name: "Start back scan" });
  await expect(back).toBeVisible({ timeout: 180_000 });
  await showSide(page, "palm"); // the palm again
  await back.click();

  await expect(page.getByText("That is your palm. Turn your hand over to show the back of your hand").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(8_000);
  await expect(page.getByRole("heading", { level: 1, name: "3D Reconstruction" })).toHaveCount(0); // not finished

  // Turning the hand over (the mirrored picture) lets the scan finish.
  await showSide(page, "back");
  await continueFromRecon(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your hand measurements", { timeout: 120_000 });
});
