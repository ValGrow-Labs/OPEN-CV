// The MILLIMESH "Surface Swarm" flow on a phone (390 x 844): the seven steps, the real coverage figure, the particles, the
// estimated 3D reconstruction (three renderings, orbit by drag), the empty states and a busy phone. The screenshots of the
// seven steps go to $MILLIMESH_SHOTS (default test-results/millimesh) for looking at beside the design.
import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routeConfig } from "./scanConfig";
import { continueFromRecon, installTurnableCamera, showSide, startCustomerScan } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run npm run e2e)");

const SHOTS = process.env.MILLIMESH_SHOTS ?? "test-results/millimesh";
mkdirSync(SHOTS, { recursive: true });

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const GENEROUS = { enabled: true, max_frame_ms: 100_000, min_fps: 0.01, fallback_after_slow_s: 600 };

function watchErrors(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

const coverage = (page: Page) => page.locator(".mm-capture").evaluate((el) => Number((el as HTMLElement).dataset.coverage));
const framesIn = (page: Page) => page.locator(".mm-capture").evaluate((el) => Number((el as HTMLElement).dataset.frames));

/** Non-transparent pixels on a 2D canvas. */
const ink = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const c = document.querySelector<HTMLCanvasElement>(sel);
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return -1;
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 8) n++;
    return n;
  }, selector);

/** How many pixels differ between two PNG screenshots of the same size (decoded in the page). */
const differing = (page: Page, a: Buffer, b: Buffer) =>
  page.evaluate(
    async ([x, y]) => {
      const load = async (b64: string) => {
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      };
      const [p, q] = await Promise.all([load(x), load(y)]);
      let n = 0;
      for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 60) n++;
      return n;
    },
    [a.toString("base64"), b.toString("base64")],
  );

/** Viewport-sized shots while scrolling down a long page (reveal-on-scroll content appears as it comes into view, and a
 *  sticky header stays at the top), instead of one stitched full-page image. Returns how many were taken. */
async function scrollShots(page: Page, prefix: string, max = 8): Promise<number> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(700);
  const vh = page.viewportSize()!.height;
  let n = 0;
  for (let y = 0; n < max; y += Math.round(vh * 0.8)) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(900);
    n++;
    await page.screenshot({ path: `${SHOTS}/${prefix}-${n}.png` });
    const done = await page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2);
    if (done) break;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return n;
}

test("the seven steps, with real coverage and the estimated 3D model", async ({ page }) => {
  test.setTimeout(480_000);
  const problems = watchErrors(page);
  const bodies: string[] = [];
  page.on("request", (r) => r.url().endsWith("/api/scan") && bodies.push(r.postData() ?? ""));
  await routeConfig(page, { overlay3d: GENEROUS, timing: { frames: 16 } });
  await installTurnableCamera(page); // the picture can be turned onto its edge / over between the phases (see views.ts)

  // 1. Start
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Surface Swarm");
  await expect(page.locator(".mm-start-wave")).toBeVisible();
  await page.waitForTimeout(1800);
  expect(await ink(page, ".mm-start-wave")).toBeGreaterThan(500); // the wave of particles is drawn
  await page.screenshot({ path: `${SHOTS}/1-start.png` });
  await page.getByRole("button", { name: /Start Scan/ }).click();

  // 2. Select a Reference Coin
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Select a Reference Coin");
  await expect(page.getByRole("radio")).toHaveCount(7);
  await expect(page.getByRole("radio", { checked: true })).toHaveValue("inr_2_2019");
  await page.getByRole("checkbox").check();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}/2-coin.png` });
  await page.screenshot({ path: `${SHOTS}/2-coin-full.png`, fullPage: true });
  await page.getByRole("button", { name: /Continue/ }).click();

  // 3. Allow Camera Access
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Allow Camera Access");
  await page.screenshot({ path: `${SHOTS}/3-camera.png` });
  await page.getByRole("button", { name: "Allow Camera" }).click();

  // 4. Palm. The coverage is the real figure: it starts at 0, only grows with accepted frames, and with a hand that does
  // not move (a fake camera) it never reaches 100: the angle half needs the phone to move.
  await expect(page.getByRole("heading", { level: 2, name: "Palm Scan" })).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => framesIn(page), { timeout: 120_000 }).toBeGreaterThan(5);
  await expect.poll(() => ink(page, ".mm-particles"), { timeout: 30_000 }).toBeGreaterThan(300); // particles are on the picture
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    seen.push(await coverage(page));
    await page.waitForTimeout(700);
  }
  expect(seen[0]).toBeGreaterThan(0);
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  // the ring says the same number as the screen's own figure (read together, so a tick between them cannot differ)
  const both = await page.locator(".mm-capture").evaluate((el) => ({ figure: (el as HTMLElement).dataset.coverage, ring: el.querySelector(".mm-ring-num")?.textContent }));
  expect(both.ring).toBe(`${both.figure}%`);
  await page.screenshot({ path: `${SHOTS}/4-palm.png` });

  // The sheet between phases says how much of the palm was really covered.
  const side = page.getByRole("button", { name: "Start side scan" });
  await expect(side).toBeVisible({ timeout: 240_000 });
  await expect(page.locator(".mm-between-done")).toContainText(/Palm captured · \d+% coverage/);
  expect(await coverage(page)).toBeLessThan(100);
  await showSide(page, "side");
  await side.click();

  // 5. Side
  await expect(page.getByRole("heading", { level: 2, name: "Side Scan" })).toBeVisible();
  await expect(page.getByText("Tilt and move around the side of your hand.")).toBeVisible();
  await expect.poll(() => framesIn(page), { timeout: 120_000 }).toBeGreaterThan(5);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/5-side.png` });
  const back = page.getByRole("button", { name: "Start back scan" });
  await expect(back).toBeVisible({ timeout: 240_000 });
  await showSide(page, "back");
  await back.click();

  // 6. Back
  await expect(page.getByRole("heading", { level: 2, name: "Back Scan" })).toBeVisible();
  await expect(page.getByText("Move around the back of your hand.")).toBeVisible();
  await expect.poll(() => framesIn(page), { timeout: 120_000 }).toBeGreaterThan(5);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/6-back.png` });

  // 7. 3D Reconstruction: an estimate, labelled as one, in three renderings.
  await expect(page.getByRole("heading", { level: 1, name: "3D Reconstruction" })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole("note")).toHaveText("Estimated 3D model — fitted to your three views, not a measured scan");
  const canvas = page.locator(".mm-recon-canvas");
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  for (const l of ["Palm Capture", "Side Capture", "Back Capture"]) await expect(page.getByText(l)).toBeVisible();
  await page.waitForTimeout(1500);
  const stage = (await page.locator(".mm-recon-stage").boundingBox())!;
  const clip = { x: stage.x, y: stage.y, width: stage.width, height: Math.min(stage.height, 520) };
  await page.screenshot({ path: `${SHOTS}/7-reconstruction.png` });

  // Solid, Wireframe and Point Cloud are three different pictures of the one model.
  const shots: Record<string, Buffer> = {};
  for (const mode of ["Solid", "Wireframe", "Point Cloud"]) {
    await page.getByRole("radio", { name: mode }).click();
    await page.waitForTimeout(900);
    shots[mode] = await page.screenshot({ clip });
    await page.screenshot({ path: `${SHOTS}/7-reconstruction-${mode.toLowerCase().replace(" ", "-")}.png` });
  }
  expect(await differing(page, shots.Solid, shots.Wireframe)).toBeGreaterThan(400);
  expect(await differing(page, shots.Wireframe, shots["Point Cloud"])).toBeGreaterThan(400);
  expect(await differing(page, shots.Solid, shots["Point Cloud"])).toBeGreaterThan(400);

  // Orbit by dragging turns the hand.
  await page.getByRole("radio", { name: "Solid" }).click();
  await page.waitForTimeout(700);
  const before = await page.screenshot({ clip });
  const host = (await page.locator(".mm-recon-host").boundingBox())!;
  const cx = host.x + host.width / 2;
  const cy = host.y + host.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  expect(await differing(page, before, await page.screenshot({ clip }))).toBeGreaterThan(400);

  // On to the measurements: one request, numbers only, the three views.
  await continueFromRecon(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your hand measurements", { timeout: 60_000 });
  await scrollShots(page, "8-measurements");
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).not.toMatch(/data:image|base64/);
  expect([...new Set<string>(JSON.parse(bodies[0]).frames.map((f: { view: string }) => f.view))].sort()).toEqual(["back", "palm", "side"]);
  await page.getByLabel("Unit").selectOption("mm");
  await page.getByLabel("Hand length").fill("181");
  await page.getByRole("button", { name: "See my size" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hand measurement complete");
  await scrollShots(page, "9-results");
  expect(problems).toEqual([]);
});

test("a busy phone (CPU x6): the scan keeps running; the particles thin out or stop, never the scan", async ({ page }) => {
  test.setTimeout(240_000);
  const problems = watchErrors(page);
  await routeConfig(page, { timing: "hold" });
  await startCustomerScan(page);
  await expect(page.getByRole("heading", { level: 2, name: "Palm Scan" })).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => framesIn(page), { timeout: 120_000 }).toBeGreaterThan(3);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  const f0 = await framesIn(page);
  await page.waitForTimeout(15_000);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  expect(await framesIn(page)).toBeGreaterThan(f0); // frames kept being accepted
  await expect(page.locator(".mm-card")).toBeVisible();
  expect(problems).toEqual([]);
});

test("camera permission denied: a clear message and a way back, nothing broken", async ({ page }) => {
  const problems = watchErrors(page);
  await page.addInitScript(() => {
    const denied = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = denied;
  });
  await startCustomerScan(page);
  const card = page.locator(".mm-sheet-card[role='alert']");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.locator("h2")).toHaveText("Camera access is blocked");
  await expect(card.getByRole("button", { name: "Back" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/permission-denied.png` });
  await card.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Allow Camera Access");
  expect(problems.filter((p) => !/NotAllowed|Permission denied|camera/i.test(p))).toEqual([]);
});

test("no hand and no coin in the picture: the screen says so, and no coverage is invented", async ({ page }) => {
  const problems = watchErrors(page);
  await page.addInitScript(() => {
    // A flat grey picture: nothing to find.
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
  await expect(page.locator(".mm-pill")).toHaveText("Show your open palm to the camera", { timeout: 120_000 });
  await page.waitForTimeout(6_000); // time passing does not fill the ring
  expect(await coverage(page)).toBe(0);
  expect(await framesIn(page)).toBe(0);
  await expect(page.getByRole("progressbar", { name: "Palm Scan coverage" })).toHaveAttribute("aria-valuenow", "0");
  expect(problems).toEqual([]);
});

test("reduced motion: no drifting particles, the scan still works", async ({ page }) => {
  test.setTimeout(240_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await routeConfig(page, { timing: "hold" });
  await startCustomerScan(page);
  await expect(page.getByRole("heading", { level: 2, name: "Palm Scan" })).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => framesIn(page), { timeout: 120_000 }).toBeGreaterThan(3);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  // the ring does not animate: the app's reduced-motion rules leave a transition of (effectively) zero length
  const seconds = await page.locator(".mm-ring-fill").evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(seconds).toBeLessThan(0.001);
});
