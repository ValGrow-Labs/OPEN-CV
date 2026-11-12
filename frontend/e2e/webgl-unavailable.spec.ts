// When the browser has no WebGL at all (some old phones, blocked GPUs, privacy modes), the app must still scan and
// size: the capture screen (2D particles) is unaffected, the 3D reconstruction is replaced by a flat drawing of the same
// fitted hand that says why, and nothing throws. WebGL is switched off by making every WebGL context request fail, which
// is what such a browser does.
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { continueFromRecon, scanRemainingViews, startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function noWebgl(page: Page) {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (/webgl/i.test(type)) return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...rest) as never;
    } as typeof original;
  });
}

function watchErrors(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

test("without WebGL the whole flow still ends in a result, with a flat drawing of the fitted hand", async ({ page }) => {
  test.setTimeout(420_000);
  const problems = watchErrors(page);
  await noWebgl(page);
  await startCustomerScan(page);
  await expect(page.locator(".mm-pill")).toBeVisible({ timeout: 120_000 }); // the scanner runs
  await expect(page.locator(".mm-particles")).toHaveCount(1); // the 2D particles do not need WebGL
  await scanRemainingViews(page);

  await expect(page.getByRole("heading", { level: 1, name: "3D Reconstruction" })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole("note")).toContainText("not a measured scan");
  await expect(page.getByRole("img", { name: /flat drawing/ })).toBeVisible();
  await expect(page.getByText(/cannot draw in 3D/)).toBeVisible();
  await expect(page.locator(".mm-recon-canvas")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset view" })).toHaveCount(0);
  await page.getByRole("radio", { name: "Wireframe" }).click(); // the control still works
  await page.screenshot({ path: "test-results/webgl-unavailable-recon.png" });
  await continueFromRecon(page);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your hand measurements", { timeout: 120_000 });
  await page.getByLabel("Unit").selectOption("mm");
  await page.getByLabel("Hand length").fill("181");
  await page.getByRole("button", { name: "See my size" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hand measurement complete");
  expect(problems).toEqual([]);
});
