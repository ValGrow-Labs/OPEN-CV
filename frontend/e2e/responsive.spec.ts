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

    test("welcome, guide, scan and calibration fit the screen", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Find your glove size");
      // Scroll through so reveal-on-scroll content enters, and let the scene draw.
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(100);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(2500);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/rwd-${vp.name}-welcome.png`, fullPage: true });

      await page.getByRole("button", { name: "Start Scan" }).click();
      await expect(page.getByRole("dialog", { name: "Which coin are you holding?" })).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await page.getByRole("button", { name: /Yes, this is my coin/ }).click();
      const guide = page.getByRole("dialog", { name: "Before you start" });
      await expect(guide).toBeVisible();
      await page.getByRole("button", { name: "Next" }).click();
      await page.waitForTimeout(2600);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/rwd-${vp.name}-guide.png` });
      // The primary action must be reachable without scrolling sideways.
      const next = await page.getByRole("button", { name: "Next" }).boundingBox();
      expect(next && next.x + next.width).toBeLessThanOrEqual(vp.width);

      await page.getByRole("button", { name: "Skip guide" }).click();
      await expect(page.locator(".live-pill")).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
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
