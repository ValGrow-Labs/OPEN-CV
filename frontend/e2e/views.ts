// Helpers for the guided angles (palm -> back of hand -> side view) in the customer flow.
// Chrome's fake camera plays ONE hand video, but the app checks that each view shows the right side of
// the hand (the back view the opposite side to the palm, the side view the hand on its edge). So the page's
// camera is re-drawn through a canvas whose picture a test can turn over (see `showSide`).
import { expect, type Page } from "@playwright/test";

/** What the fake camera shows: the video as it plays ("palm"), turned over like the back of the same hand
 *  ("back": mirrored left to right, which flips the hand's turn exactly as turning a real hand over does),
 *  or squeezed to a narrow strip ("side": the hand seen on its edge). A stand-in picture, not a real hand. */
export type ShownSide = "palm" | "back" | "side";

/** Wrap getUserMedia (before any page script) so the camera stream is a canvas re-drawing the fake camera. */
export async function installTurnableCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __shown: string };
    w.__shown = "palm";
    const md = navigator.mediaDevices;
    const real = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      const src = await real(constraints);
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = src;
      await video.play();
      while (!video.videoWidth) await new Promise((r) => setTimeout(r, 20));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d")!;
      const SIDE_ON_WIDTH = 0.5; // fraction of the picture's width the hand is squeezed into
      const draw = () => {
        const W = canvas.width;
        const H = canvas.height;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        if (w.__shown === "back") {
          ctx.translate(W, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(video, 0, 0, W, H);
        } else if (w.__shown === "side") {
          ctx.drawImage(video, (W * (1 - SIDE_ON_WIDTH)) / 2, 0, W * SIDE_ON_WIDTH, H);
        } else {
          ctx.drawImage(video, 0, 0, W, H);
        }
        ctx.restore();
      };
      draw();
      const timer = setInterval(draw, 33);
      const out = canvas.captureStream(30);
      for (const track of out.getVideoTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(timer);
          src.getTracks().forEach((t) => t.stop());
          stop();
        };
      }
      return out;
    };
  });
}

/** Change the side of the hand the fake camera shows, from now on. */
export async function showSide(page: Page, side: ShownSide): Promise<void> {
  await page.evaluate((s) => ((window as unknown as { __shown: string }).__shown = s), side);
}

/** The views after the palm, in the order the customer is guided through them (config capture.views). */
export const NEXT_VIEW_BUTTONS = ["Scan back of hand", "Scan side view"] as const;

/** Start a customer scan up to the camera: coin question, quick guide, camera. */
export async function startCustomerScan(page: Page): Promise<void> {
  await installTurnableCamera(page); // the palm view shows the video as it plays
  await page.goto("/");
  await page.getByRole("button", { name: "Start Scan" }).click();
  // The coin must be confirmed before the camera starts.
  await page.getByRole("button", { name: /Yes, this is my coin/ }).click();
  // Walk through the quick guide; the camera starts only at the end.
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: /Start camera/ }).click();
}

export interface SheetCheck {
  /** Prefix of the screenshot file name written for each card (test-results/<prefix>-<n>.png). */
  shots?: string;
  /** Also assert the layout rules of the next-angle sheet (thumb reach, no scrolling, 56 px button). */
  layout?: boolean;
}

/** The side each guided view must show, after the palm: the back is the palm turned over, the side the hand on its edge. */
const SIDE_FOR_BUTTON: ShownSide[] = ["back", "side"];

/** After the palm: scan the back of the hand, then the side view (each needs one tap on its card). The
 *  picture is turned over / onto its edge before the tap, as a customer turns their hand. */
export async function scanRemainingViews(page: Page, check: SheetCheck = {}): Promise<void> {
  for (const [i, name] of NEXT_VIEW_BUTTONS.entries()) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeVisible({ timeout: 120_000 });
    // Required views offer no way to skip to the size.
    await expect(page.getByRole("button", { name: "Skip, see my size" })).toHaveCount(0);
    await expect(page.getByText(`Step ${i + 2} of 3`)).toBeVisible();
    await page.waitForTimeout(400); // let the sheet settle before it is photographed
    if (check.shots) await page.screenshot({ path: `test-results/${check.shots}-card${i + 2}.png` });
    if (check.layout) await expectSheetLayout(page);
    await showSide(page, SIDE_FOR_BUTTON[i]);
    await button.click();
  }
}

/** The rules the next-angle sheet is built to: bottom-aligned, thumb-sized button, no scrolling. */
export async function expectSheetLayout(page: Page): Promise<void> {
  const vp = page.viewportSize()!;
  const sheet = page.locator(".view-sheet");
  const box = (await sheet.boundingBox())!;
  const portrait = vp.height >= vp.width;
  // inside the screen, and on the bottom edge (portrait) or the right edge (landscape)
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  if (portrait) {
    expect(Math.abs(box.y + box.height - vp.height)).toBeLessThanOrEqual(2);
    expect(box.width).toBeGreaterThanOrEqual(vp.width - 2); // full width
    expect(box.height).toBeLessThanOrEqual(vp.height * 0.7); // leaves the camera picture visible
  } else {
    expect(Math.abs(box.x + box.width - vp.width)).toBeLessThanOrEqual(2);
  }
  // nothing to scroll
  const scrolls = await sheet.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(scrolls).toBeLessThanOrEqual(1);
  // the primary button is a thumb target
  const btn = (await sheet.getByRole("button").first().boundingBox())!;
  expect(btn.height).toBeGreaterThanOrEqual(56);
  expect(btn.y + btn.height).toBeLessThanOrEqual(vp.height + 1);
  // no horizontal scrolling of the page
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}
