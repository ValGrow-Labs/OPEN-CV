// Responsive layout: the start, coin, camera and capture screens (and the operator calibration screen) at phone, small
// phone, phone held sideways, tablet, laptop, desktop and a very wide window must fit the viewport without scrolling
// sideways, keep their key controls visible and not on top of each other, and keep real touch targets.
// (The later steps, the reconstruction and the result pages, are covered by e2e/rwd.spec.ts on the hand photo.)
// Screenshots go to test-results/rwd-*.png.
import { expect, test, type Page } from "@playwright/test";
import { overlapArea } from "./views";

const VIEWPORTS = [
  { name: "phone-320", width: 320, height: 640 },
  { name: "phone-360", width: 360, height: 740 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "laptop-1024", width: 1024, height: 768 },
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "desktop-1920", width: 1920, height: 1080 },
  { name: "wide-2560", width: 2560, height: 1440 },
];

async function horizontalOverflow(page: Page): Promise<number> {
  const r = await page.evaluate(() => {
    const W = window.innerWidth;
    const wide = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > W + 0.5)
      .map((el) => el.tagName + "." + String((el as HTMLElement).className) + " " + el.getBoundingClientRect().right.toFixed(1));
    return { over: document.documentElement.scrollWidth - W, wide: wide.slice(0, 5) };
  });
  if (r.over > 0) console.log("overflow", r.over, r.wide);
  return r.over;
}

/** Every visible control of these kinds is at least 44 px each way (tablet and up; a phone keeps the client's sizes, with
 *  hit areas of 44 px made by the invisible padding of the small buttons). */
async function expectTouchTargets(page: Page, selector: string) {
  const sizes = await page.locator(selector).evaluateAll((els) =>
    els
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ w: Math.round(r.width), h: Math.round(r.height) })),
  );
  for (const s of sizes) {
    expect(s.h, `${selector} is ${s.w}x${s.h}`).toBeGreaterThanOrEqual(44);
    expect(s.w, `${selector} is ${s.w}x${s.h}`).toBeGreaterThanOrEqual(44);
  }
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    const roomy = vp.width >= 600;

    test("start, coin, camera, scan and calibration fit the screen", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Surface Swarm");
      await page.waitForTimeout(1500); // let the wave draw
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/rwd-${vp.name}-start.png`, fullPage: true });
      // the primary action is reachable without scrolling sideways
      const start = await page.getByRole("button", { name: /Start Scan/ }).boundingBox();
      expect(start && start.x + start.width).toBeLessThanOrEqual(vp.width);
      expect(start && start.x).toBeGreaterThanOrEqual(0);
      if (roomy) {
        await expectTouchTargets(page, ".mm-btn");
        // the heading is not tiny on a big screen, and the wave has a real size (not squashed into a strip)
        const h1 = await page.getByRole("heading", { level: 1 }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        expect(h1).toBeGreaterThanOrEqual(vp.height >= 560 ? 48 : 36); // a phone held sideways gets a smaller one
        const wave = (await page.locator(".mm-start-wave").boundingBox())!;
        expect(wave.height).toBeGreaterThanOrEqual(Math.min(260, vp.height * 0.4));
        const body = (await page.locator(".mm-start-body").boundingBox())!;
        // side by side on a wide window: the text and the wave never overlap
        if (vp.width >= 900 || vp.width > vp.height) expect(overlapArea(body, wave)).toBeLessThanOrEqual(1);
      }

      await page.getByRole("button", { name: /Start Scan/ }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Select a Reference Coin");
      await page.getByRole("checkbox").check();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/rwd-${vp.name}-coin.png`, fullPage: true });
      const go = await page.getByRole("button", { name: /Continue/ }).boundingBox();
      expect(go && go.x + go.width).toBeLessThanOrEqual(vp.width);
      if (roomy) {
        await expectTouchTargets(page, ".mm-btn");
        // all seven coins fit in at most two rows (3 or 4 per row), and nothing sits on top of the Continue panel
        const cards = await page.locator(".mm-coin-card").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
        expect(cards).toHaveLength(7);
        expect(new Set(cards.map((t) => Math.round(t / 10))).size).toBeLessThanOrEqual(vp.width >= 700 ? 2 : 3);
        const grid = (await page.locator(".mm-coins").boundingBox())!;
        const aside = (await page.locator(".mm-coin-aside").boundingBox())!;
        expect(overlapArea(grid, aside)).toBeLessThanOrEqual(1);
      }
      await page.getByRole("button", { name: /Continue/ }).click();

      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Allow Camera Access");
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/rwd-${vp.name}-camera.png` });
      if (roomy) {
        // a centred card
        const card = (await page.locator(".mm-camera-card").boundingBox())!;
        expect(Math.abs(card.x + card.width / 2 - vp.width / 2)).toBeLessThanOrEqual(2);
        expect(card.width).toBeLessThanOrEqual(560);
        await expectTouchTargets(page, ".mm-btn");
      }
      await page.getByRole("button", { name: "Allow Camera" }).click();

      await expect(page.locator(".mm-pill")).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      // the camera, its guidance card and the ring are all on the screen, none on top of another
      const cam = (await page.locator(".mm-cam").boundingBox())!;
      const card = (await page.locator(".mm-card").boundingBox())!;
      const tabs = (await page.locator(".mm-tabs").boundingBox())!;
      expect(card.y + card.height).toBeLessThanOrEqual(vp.height + 1);
      expect(card.x + card.width).toBeLessThanOrEqual(vp.width + 1);
      expect(overlapArea(cam, card)).toBeLessThanOrEqual(1);
      expect(overlapArea(cam, tabs)).toBeLessThanOrEqual(1);
      expect(overlapArea(card, tabs)).toBeLessThanOrEqual(1);
      if (roomy) {
        // the camera keeps the webcam's own landscape shape instead of a portrait crop
        expect(cam.width / cam.height).toBeGreaterThan(1.5);
        expect(cam.width / cam.height).toBeLessThan(2.0);
        await expectTouchTargets(page, ".mm-icon-btn");
        // the overlay lives on exactly the camera picture
        const field = (await page.locator(".mm-cam .mm-corner--tl").boundingBox())!;
        expect(field.x).toBeGreaterThanOrEqual(cam.x - 1);
        const pill = (await page.locator(".mm-pill").boundingBox())!;
        expect(pill.x).toBeGreaterThanOrEqual(cam.x - 1);
        expect(pill.x + pill.width).toBeLessThanOrEqual(cam.x + cam.width + 1);
        expect(pill.y + pill.height).toBeLessThanOrEqual(cam.y + cam.height + 1);
      }
      await page.screenshot({ path: `test-results/rwd-${vp.name}-scan.png` });
      await page.getByRole("button", { name: "Cancel scan" }).click();

      await page.goto("/#/calibration");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reference calibration");
      await expect(page.getByText("Calibration acceptable")).toBeVisible(); // widest state: diagnostics table shown
      await page.waitForTimeout(800);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
}

test.describe("resizing the window during a scan", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the particle layer and the overlay follow the camera picture at every size, with no distortion", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Start Scan/ }).click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.getByRole("button", { name: "Allow Camera" }).click();
    await expect(page.locator(".mm-pill")).toBeVisible();
    await page.waitForTimeout(800);

    const sizes: [number, number][] = [
      [1440, 900],
      [1000, 700],
      [700, 900],
      [390, 844],
      [844, 390],
      [1920, 1080],
    ];
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(600);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      const m = await page.evaluate(() => {
        const cam = document.querySelector(".mm-cam")!.getBoundingClientRect();
        const c = document.querySelector<HTMLCanvasElement>(".mm-particles");
        const r = c?.getBoundingClientRect();
        return {
          cam: { w: cam.width, h: cam.height },
          canvas: r ? { w: r.width, h: r.height, pw: c!.width, ph: c!.height } : null,
          dpr: window.devicePixelRatio,
        };
      });
      expect(m.canvas, `particle canvas missing at ${w}x${h}`).not.toBeNull();
      // the layer covers the camera picture exactly (no stretch, no gap)...
      expect(Math.abs(m.canvas!.w - m.cam.w)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.canvas!.h - m.cam.h)).toBeLessThanOrEqual(1);
      // ...and its pixel grid has the same shape as the box it is drawn in, at the device pixel ratio (not distorted)
      expect(Math.abs(m.canvas!.pw / m.canvas!.w - m.dpr)).toBeLessThan(0.05);
      expect(Math.abs(m.canvas!.ph / m.canvas!.h - m.dpr)).toBeLessThan(0.05);
      await page.screenshot({ path: `test-results/rwd-resize-${w}x${h}.png` });
    }
  });
});
