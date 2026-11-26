// The alignment corners of the capture screen: the scan frame around the hand has a boxed arrow in each corner, lit green when
// the hand is lined up. The arrows are drawn on the particle canvas; the screen reports which are lit in data-corners and
// data-aligned. With the test hand video it checks that the scan still collects frames and the state is consistent, that no
// corner is lit with no hand in the picture, and writes a screenshot to $MILLIMESH_SHOTS for looking at.
import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeConfig } from "./scanConfig";
import { startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

const SHOTS = process.env.MILLIMESH_SHOTS ?? "test-results/millimesh";
mkdirSync(SHOTS, { recursive: true });

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

function watchErrors(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

const framesIn = (page: Page) => page.locator(".mm-capture").evaluate((el) => Number((el as HTMLElement).dataset.frames));
const lit = (page: Page) => page.locator(".mm-capture").evaluate((el) => (el.getAttribute("data-corners") ?? "").split(" ").filter(Boolean));

test("the scan frame carries the corner arrows, there is no separate outer box, and the scan still collects frames", async ({ page }) => {
  test.setTimeout(240_000);
  const problems = watchErrors(page);
  await routeConfig(page, { timing: "hold" });
  await startCustomerScan(page);
  await expect(page.getByRole("heading", { level: 2, name: "Palm Scan" })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".mm-particles")).toBeVisible();
  await expect(page.locator(".mm-align, .mm-corner")).toHaveCount(0);
  await expect.poll(() => framesIn(page), { timeout: 120_000 }).toBeGreaterThan(3);
  // "lined up" means all four corners are lit
  const corners = await lit(page);
  expect((await page.locator(".mm-capture").getAttribute("data-aligned")) === "true").toBe(corners.length === 4);
  await page.screenshot({ path: `${SHOTS}/align-corners.png` });
  expect(problems).toEqual([]);
});

test("with no hand in the picture no corner is lit", async ({ page }) => {
  const problems = watchErrors(page);
  await page.addInitScript(() => {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 480;
    const ctx = c.getContext("2d")!;
    const draw = () => {
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, 640, 480);
    };
    draw();
    setInterval(draw, 100);
    navigator.mediaDevices.getUserMedia = () => Promise.resolve(c.captureStream(10));
  });
  await startCustomerScan(page);
  await expect(page.locator(".mm-cam")).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(3000);
  expect(await lit(page)).toEqual([]);
  await expect(page.locator(".mm-capture")).toHaveAttribute("data-aligned", "false");
  await page.screenshot({ path: `${SHOTS}/align-corners-no-hand.png` });
  expect(problems.filter((p) => !/NotAllowed|Permission denied|camera/i.test(p))).toEqual([]);
});
