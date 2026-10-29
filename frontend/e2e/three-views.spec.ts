// The guided angles on a phone: palm -> back of hand -> side view, then the measurements page.
// Written but not run in the worktree that produced it. The fake camera plays the same hand video
// for every view; the side view needs only a hand and a coin in view (basic checks).
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRemainingViews, startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

const VIEWPORTS = [
  { name: "phone-390", width: 390, height: 844 },
  { name: "phone-320", width: 320, height: 568 },
  { name: "phone-390-landscape", width: 844, height: 390 },
];

async function threeViews(page: Page, tag: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bodies: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/scan")) bodies.push(r.postData() ?? "");
  });

  await startCustomerScan(page);
  // The camera is opened once: the next-angle cards must not bring a new permission prompt or restart it.
  await scanRemainingViews(page, { shots: tag, layout: true });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your hand measurements", { timeout: 120_000 });

  // One request, numbers only, frames tagged by view.
  expect(bodies).toHaveLength(1);
  const body = JSON.parse(bodies[0]);
  expect(bodies[0]).not.toMatch(/data:image|base64/);
  const views = new Set<string>(body.frames.map((f: { view: string }) => f.view));
  expect([...views].sort()).toEqual(["back", "palm", "side"]);
  for (const v of ["palm", "back", "side"]) {
    expect(body.frames.filter((f: { view: string }) => f.view === v).length).toBeGreaterThanOrEqual(6);
  }

  // The result says what each view did: palm and back are used, the side view is only captured.
  await page.getByText("Scan views").click();
  await expect(page.locator('[data-view="palm"]')).toContainText("used");
  await expect(page.locator('[data-view="back"]')).toContainText("used");
  await expect(page.locator('[data-view="side"]')).toContainText("not used for your size yet");
  await expect(page.locator('[data-view="side"]')).not.toContainText("hand length");
  await page.screenshot({ path: `test-results/${tag}-measurements.png`, fullPage: true });
  expect(errors).toEqual([]);
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: true });
    test(`palm, back of hand and side view (${vp.name})`, async ({ page }) => {
      test.setTimeout(240_000);
      await threeViews(page, `three-views-${vp.name}`);
    });
  });
}
