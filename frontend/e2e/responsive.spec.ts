// Responsive layout: every screen at phone, small-phone, tablet and desktop widths must fit
// the viewport without horizontal scrolling. Screenshots go to test-results/rwd-*.png.
import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone-320", width: 320, height: 640 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1280", width: 1280, height: 800 },
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

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("start, coin, camera, scan and calibration fit the screen", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Surface Swarm");
      await page.waitForTimeout(1500); // let the wave draw
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/rwd-${vp.name}-start.png`, fullPage: true });
      // the primary action is reachable without scrolling sideways
      const start = await page.getByRole("button", { name: /Start Scan/ }).boundingBox();
      expect(start && start.x + start.width).toBeLessThanOrEqual(vp.width);

      await page.getByRole("button", { name: /Start Scan/ }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Select a Reference Coin");
      await page.getByRole("checkbox").check();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/rwd-${vp.name}-coin.png`, fullPage: true });
      const go = await page.getByRole("button", { name: /Continue/ }).boundingBox();
      expect(go && go.x + go.width).toBeLessThanOrEqual(vp.width);
      await page.getByRole("button", { name: /Continue/ }).click();

      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Allow Camera Access");
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/rwd-${vp.name}-camera.png` });
      await page.getByRole("button", { name: "Allow Camera" }).click();

      await expect(page.locator(".mm-pill")).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      // the camera card and the ring are on the screen, not scrolled away
      const card = await page.locator(".mm-card").boundingBox();
      expect(card && card.y + card.height).toBeLessThanOrEqual(vp.height + 1);
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
