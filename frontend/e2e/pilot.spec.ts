// Remote pilot end to end: the operator creates a TEST invite, a "volunteer" opens the link,
// consents, checks the coin, enters ruler readings and runs a real browser scan (fake camera
// playing the hand photo with a SYNTHETIC coin). Test invites are never counted as real data.
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

test("a volunteer enrols from an invite link and submits a scan", async ({ page, request }) => {
  const r = await request.post("/api/pilot/invites", { data: { purpose: "test" }, headers: { "X-Glovesize-Operator": "1" } });
  expect(r.status()).toBe(201);
  const { token } = (await r.json()) as { token: string };

  await page.goto(`/#/pilot/${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hand measurement pilot");
  await expect(page.getByText(/Test link/)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel(/I have read this and agree/).check();
  await page.getByRole("button", { name: "I agree" }).click();

  await page.getByLabel(/US quarter/).check();
  await page.getByLabel(/Measure the coin across/).fill("24.3");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Right").check();
  await page.getByLabel("I measured myself").check();
  await page.getByLabel("Reading 1").fill("182");
  await page.getByLabel("Reading 2").fill("183");
  await page.getByLabel("Phone model").fill("Chrome fake camera (synthetic)");
  await page.getByRole("button", { name: "Save and start scanning" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Scan your hand");
  await page.getByRole("button", { name: "Start this scan" }).click();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: /Start camera/ }).click();

  await expect(page.getByRole("status").filter({ hasText: /Scan saved|could not be used/ })).toBeVisible({ timeout: 120_000 });
  // The volunteer is never shown a camera estimate or a glove size.
  await expect(page.locator("main")).toContainText("Scan saved.");
  await expect(page.locator("main")).not.toContainText(/\d\s?mm|glove size|hand length/i);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Scan your hand");
  await page.screenshot({ path: "test-results/pilot.png", fullPage: true });
});
