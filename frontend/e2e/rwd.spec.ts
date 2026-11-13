// The whole MILLIMESH flow (steps 1 to 7, then the measurements and results pages) at phone, tablet, laptop and desktop
// sizes, and a phone held sideways, on the hand photo (fake camera, landscape 1280 x 720 like a webcam). At every size:
// no sideways scrolling, the key elements are visible and none sits on top of another, the camera keeps its own shape,
// the particle layer and the 3D scene match the box they are drawn in (device pixel ratio, no distortion), and
// the controls are proper touch targets on tablet and up. Screenshots of every step go to $MILLIMESH_RWD_SHOTS
// (default test-results/millimesh-rwd) for looking at. Layout only: nothing here changes how a scan is measured.
import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeConfig } from "./scanConfig";
import { continueFromRecon, expectSheetLayout, installTurnableCamera, overlapArea, showSide } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

const SHOTS = process.env.MILLIMESH_RWD_SHOTS ?? "test-results/millimesh-rwd";
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: "phone-360", width: 360, height: 740 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "laptop-1024", width: 1024, height: 768 },
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "desktop-1920", width: 1920, height: 1080 },
];

const overflow = (page: Page) =>
  page.evaluate(() => {
    const W = window.innerWidth;
    const wide = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > W + 0.5 && getComputedStyle(el).position !== "fixed")
      .map((el) => el.tagName + "." + String((el as HTMLElement).className) + " " + el.getBoundingClientRect().right.toFixed(1));
    return { over: document.documentElement.scrollWidth - W, wide: wide.slice(0, 4) };
  });

async function expectNoOverflow(page: Page, where: string) {
  const o = await overflow(page);
  expect(o.over, `${where}: sideways overflow ${JSON.stringify(o.wide)}`).toBeLessThanOrEqual(0);
}

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

async function expectTouchTargets(page: Page, selector: string) {
  const sizes = await page.locator(selector).evaluateAll((els) =>
    els
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ w: Math.round(r.width), h: Math.round(r.height) })),
  );
  for (const s of sizes) expect(Math.min(s.w, s.h), `${selector} is ${s.w}x${s.h}`).toBeGreaterThanOrEqual(44);
}

/** Viewport-sized shots while scrolling down a long page (reveal-on-scroll content appears as it comes into view). */
async function scrollShots(page: Page, prefix: string, max: number): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  const vh = page.viewportSize()!.height;
  for (let n = 0, y = 0; n < max; y += Math.round(vh * 0.85)) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(800);
    n++;
    await page.screenshot({ path: `${SHOTS}/${prefix}-${n}.png` });
    if (await page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2)) break;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** The canvas of a layer is drawn at the device pixel ratio in exactly the box it sits in (nothing stretched). */
async function expectCanvasFits(page: Page, canvasSel: string, boxSel: string, where: string) {
  const m = await page.evaluate(
    ([c, b]) => {
      const canvas = document.querySelector<HTMLCanvasElement>(c)!;
      const host = document.querySelector<HTMLElement>(b)!.getBoundingClientRect();
      const r = canvas.getBoundingClientRect();
      return { cw: r.width, ch: r.height, hw: host.width, hh: host.height, pw: canvas.width, ph: canvas.height, dpr: window.devicePixelRatio };
    },
    [canvasSel, boxSel],
  );
  expect(Math.abs(m.cw - m.hw), `${where}: ${canvasSel} width`).toBeLessThanOrEqual(2);
  expect(Math.abs(m.ch - m.hh), `${where}: ${canvasSel} height`).toBeLessThanOrEqual(2);
  expect(Math.abs(m.pw / m.cw - m.dpr), `${where}: ${canvasSel} pixel ratio x`).toBeLessThan(0.06);
  expect(Math.abs(m.ph / m.ch - m.dpr), `${where}: ${canvasSel} pixel ratio y`).toBeLessThan(0.06);
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.width < 600 });
    const roomy = vp.width >= 600;
    const side = vp.width >= 900 || (vp.width >= 600 && vp.width > vp.height); // the side-by-side layouts

    test(`steps 1 to 7, measurements and results at ${vp.name}`, async ({ page }) => {
      test.setTimeout(420_000);
      const shot = (name: string, fullPage = false) => page.screenshot({ path: `${SHOTS}/${vp.name}-${name}.png`, fullPage });
      const problems: string[] = [];
      page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) problems.push(`console.error: ${m.text()}`);
      });
      await routeConfig(page, { timing: { frames: 10 } });
      await installTurnableCamera(page);

      // 1. Start
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Surface Swarm");
      await page.waitForTimeout(1500);
      await expectNoOverflow(page, "start");
      await expect(page.getByRole("button", { name: /Start Scan/ })).toBeVisible();
      if (side) {
        const body = await box(page, ".mm-start-body");
        const wave = await box(page, ".mm-start-wave");
        expect(overlapArea(body, wave)).toBeLessThanOrEqual(1);
        expect(wave.width).toBeGreaterThan(vp.width * 0.35); // the wave gets a real share of a wide window
        await expectCanvasFits(page, ".mm-start-wave", ".mm-start-wave", "start wave");
      }
      await shot("1-start");
      await page.getByRole("button", { name: /Start Scan/ }).click();

      // 2. Coin
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Select a Reference Coin");
      await expect(page.getByRole("radio")).toHaveCount(7);
      await page.getByRole("checkbox").check();
      await expectNoOverflow(page, "coin");
      if (roomy) await expectTouchTargets(page, ".mm-btn");
      if (side) {
        const grid = await box(page, ".mm-coins");
        const aside = await box(page, ".mm-coin-aside");
        expect(overlapArea(grid, aside)).toBeLessThanOrEqual(1);
        if (vp.height >= 600) {
          // all seven coins and the Continue button are on the screen at once on a laptop or desktop window
          await expect(page.getByRole("button", { name: /Continue/ })).toBeInViewport();
          const lastCard = await box(page, ".mm-coin-card:last-child");
          expect(lastCard.y + lastCard.height).toBeLessThanOrEqual(vp.height + 1);
        } else {
          // a phone held sideways is only 390 px tall: the page scrolls, and Continue can be reached
          await page.getByRole("button", { name: /Continue/ }).scrollIntoViewIfNeeded();
          await expect(page.getByRole("button", { name: /Continue/ })).toBeInViewport();
        }
      }
      await shot("2-coin", true);
      await page.getByRole("button", { name: /Continue/ }).click();

      // 3. Camera access
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Allow Camera Access");
      await expectNoOverflow(page, "camera");
      if (roomy) {
        const card = await box(page, ".mm-camera-card");
        expect(Math.abs(card.x + card.width / 2 - vp.width / 2)).toBeLessThanOrEqual(2);
      }
      await shot("3-camera");
      await page.getByRole("button", { name: "Allow Camera" }).click();

      // 4-6. Palm, side and back
      const capture = async (name: string, title: string) => {
        await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible({ timeout: 120_000 });
        await expect.poll(() => page.locator(".mm-capture").evaluate((el) => Number((el as HTMLElement).dataset.frames)), { timeout: 120_000 }).toBeGreaterThan(5);
        await page.waitForTimeout(600);
        await expectNoOverflow(page, name);
        const cam = await box(page, ".mm-cam");
        const card = await box(page, ".mm-card");
        const tabs = await box(page, ".mm-tabs");
        expect(overlapArea(cam, card)).toBeLessThanOrEqual(1);
        expect(overlapArea(cam, tabs)).toBeLessThanOrEqual(1);
        expect(overlapArea(card, tabs)).toBeLessThanOrEqual(1);
        expect(card.x + card.width).toBeLessThanOrEqual(vp.width + 1);
        if (roomy) {
          expect(card.y + card.height).toBeLessThanOrEqual(vp.height + 1);
          expect(cam.width / cam.height).toBeGreaterThan(1.5); // a landscape webcam keeps its own shape
          expect(cam.width / cam.height).toBeLessThan(2.0);
          await expectTouchTargets(page, ".mm-icon-btn");
        }
        await expectCanvasFits(page, ".mm-particles", ".mm-cam", name);
        // the ring, the tabs and the guidance pill are there
        await expect(page.getByRole("progressbar")).toBeVisible();
        await expect(page.locator(".mm-tabs li.is-active")).toBeVisible();
        await shot(name);
      };
      await capture("4-palm", "Palm Scan");
      await expect(page.getByRole("button", { name: "Start side scan" })).toBeVisible({ timeout: 240_000 });
      await expectSheetLayout(page);
      await shot("4b-between");
      await showSide(page, "side");
      await page.getByRole("button", { name: "Start side scan" }).click();
      await capture("5-side", "Side Scan");
      await expect(page.getByRole("button", { name: "Start back scan" })).toBeVisible({ timeout: 240_000 });
      await showSide(page, "back");
      await page.getByRole("button", { name: "Start back scan" }).click();
      await capture("6-back", "Back Scan");

      // 7. Reconstruction
      await expect(page.getByRole("heading", { level: 1, name: "3D Reconstruction" })).toBeVisible({ timeout: 240_000 });
      await expect(page.locator(".mm-recon-canvas")).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      await expectNoOverflow(page, "recon");
      const stage = await box(page, ".mm-recon-stage");
      for (const other of [".mm-seg", ".mm-estimate", ".mm-recon .mm-actions"]) expect(overlapArea(stage, await box(page, other)), `stage over ${other}`).toBeLessThanOrEqual(1);
      await expectCanvasFits(page, ".mm-recon-canvas", ".mm-recon-host", "recon");
      expect(stage.width, "the stage has a real size").toBeGreaterThan(Math.min(vp.width * 0.5, 280));
      if (side) {
        expect(stage.height).toBeGreaterThan(vp.height * 0.6); // the 3D hand fills the height on a wide window
        expect(stage.x + stage.width).toBeLessThanOrEqual((await box(page, ".mm-seg")).x + 1); // the controls sit beside it
      }
      if (roomy) {
        await expectTouchTargets(page, ".mm-seg button");
        await expectTouchTargets(page, ".mm-btn");
      }
      for (const l of ["Palm Capture", "Side Capture", "Back Capture"]) await expect(page.getByText(l)).toBeVisible();
      await expect(page.getByRole("note")).toHaveText("Estimated 3D model — fitted to your three views, not a measured scan");
      await shot("7-reconstruction");
      if (vp.name === "desktop-1440" || vp.name === "tablet-768") {
        for (const mode of ["Wireframe", "Point Cloud"]) {
          await page.getByRole("radio", { name: mode }).click();
          await page.waitForTimeout(800);
          await shot(`7-reconstruction-${mode.toLowerCase().replace(" ", "-")}`);
        }
        await page.getByRole("radio", { name: "Solid" }).click();
      }

      // 8. Measurements
      await continueFromRecon(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your hand measurements", { timeout: 60_000 });
      await page.waitForTimeout(800);
      await expectNoOverflow(page, "measurements");
      if (vp.width >= 900) {
        const hand = await box(page, "#hand-heading");
        const cams = await box(page, "#camera-heading");
        expect(hand.x + hand.width, "the two measurement cards sit side by side").toBeLessThanOrEqual(cams.x + 1);
        const main = await box(page, "main.page");
        expect(main.width).toBeLessThanOrEqual(1320 + 1);
        expect(Math.abs(main.x + main.width / 2 - vp.width / 2)).toBeLessThanOrEqual(2);
      }
      await scrollShots(page, `${vp.name}-8-measurements`, 4);
      await page.getByLabel("Unit").selectOption("mm");
      await page.getByLabel("Hand length").fill("181");
      await page.getByRole("button", { name: "See my size" }).click();

      // 9. Results
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hand measurement complete", { timeout: 60_000 });
      await page.waitForTimeout(1200);
      await expectNoOverflow(page, "results");
      await expect(page.locator(".rv2-size .size")).toBeVisible();
      if (vp.width >= 1000) {
        const hero = await box(page, ".rv2-hero");
        const rest = await box(page, ".rv2-rest");
        expect(overlapArea(hero, rest)).toBeLessThanOrEqual(1);
        expect(hero.x + hero.width).toBeLessThanOrEqual(rest.x + 1); // the details sit beside the hero, not under it
      }
      await scrollShots(page, `${vp.name}-9-results`, 4);
      await expectNoOverflow(page, "results (scrolled)");
      expect(problems).toEqual([]);
    });
  });
}
