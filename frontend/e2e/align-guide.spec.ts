// The alignment guide of the capture screen: fixed boxed arrows at the corners of a guide box, the scan frame around the hand
// with a boxed arrow in each of its own corners (moved onto the fixed ones; each pair turns green when it lines up), and a
// phone-tilt indicator (a phone rectangle with a smaller one inside). The scan frame's arrows are drawn on the particle canvas;
// the screen reports which are lit in data-corners and data-aligned. With the test hand video it checks that the scan still
// collects frames and the state is consistent, that no corner is lit with no hand in the picture, and writes a screenshot to
// $MILLIMESH_SHOTS for looking at.
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

test("fixed corner arrows, arrows on the scan frame and a tilt indicator, and the scan still collects frames", async ({ page }) => {
  test.setTimeout(240_000);
  const problems = watchErrors(page);
  await routeConfig(page, { timing: "hold" });
  await startCustomerScan(page);
  await expect(page.getByRole("heading", { level: 2, name: "Palm Scan" })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".mm-particles")).toBeVisible();
  await expect(page.locator(".mm-align-box")).toHaveCount(1);
  await expect(page.locator(".mm-align-tag")).toHaveCount(4);
  for (const c of ["tl", "tr", "bl", "br"]) await expect(page.locator(`.mm-align-tag[data-corner='${c}']`)).toHaveCount(1);
  await expect.poll(() => framesIn(page), { timeout: 120_000 }).toBeGreaterThan(3);
  // the phone-tilt indicator: a phone rectangle with a smaller one inside, reading the palm once a hand is tracked
  await expect(page.locator(".mm-tilt .mm-tilt-inner")).toHaveCount(1);
  await expect(page.locator(".mm-tilt")).toHaveAttribute("data-on", "true", { timeout: 30_000 });
  await expect.poll(async () => Number(await page.locator(".mm-tilt").getAttribute("data-tilt"))).toBeGreaterThanOrEqual(0);
  // "lined up" means all four corners are lit
  const corners = await lit(page);
  expect((await page.locator(".mm-capture").getAttribute("data-aligned")) === "true").toBe(corners.length === 4);
  // the fixed arrows light exactly where the screen reports the corners lit
  expect(await page.locator(".mm-align-tag.is-on").count()).toBe(corners.length);
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
