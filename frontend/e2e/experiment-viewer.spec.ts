// The EXPERIMENTAL 3D viewer, in Chromium, on its dev-only demo page (a SIMULATED synthetic capsule hand, not a real scan).
// Exercises every display mode, colour mode and preset, the skeleton toggle, free rotation to the underside (mouse and
// keyboard), phone width, the board-axis fallback without a hand frame and a 500k-triangle stress set, with no console
// errors. Saves screenshots under test-results/viewer/ to be looked at; a few pixel checks guard the obvious failures
// (nothing drawn, skeleton not distinguishable). Run: npx playwright test -c playwright.viewer.config.ts
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const OUT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../test-results/viewer");
mkdirSync(OUT, { recursive: true });
const SIM = "SIMULATED: synthetic capsule hand, not a real scan";

/** A minimal PNG decoder (8-bit RGB / RGBA, the formats Chromium screenshots use) for pixel counts. */
function decodePng(buf: Buffer): { w: number; h: number; px: Uint8Array; ch: number } {
  let o = 8, w = 0, h = 0, ch = 4;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("latin1", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error("unsupported bit depth");
      ch = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!ch) throw new Error(`unsupported colour type ${data[9]}`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, px, ch };
}

/** Share of the image's pixels that pass `pred(r, g, b)`. */
function share(png: Buffer, pred: (r: number, g: number, b: number) => boolean): number {
  const { w, h, px, ch } = decodePng(png);
  let n = 0;
  for (let i = 0; i < w * h; i++) if (pred(px[i * ch], px[i * ch + 1], px[i * ch + 2])) n++;
  return n / (w * h);
}
const isModelBlue = (r: number, g: number, b: number) => b > 120 && b - r > 45 && b - g > 15; // shaded blue surface (grid lines are paler)
const isOrange = (r: number, g: number, b: number) => r > 200 && g > 70 && g < 175 && b < 90;
const isRose = (r: number, g: number, b: number) => r > 170 && g < 140 && b > 80 && r - g > 70;
const isTeal = (r: number, g: number, b: number) => g > 110 && b > 90 && r < 90 && g - r > 50;
const isSupportGrey = (r: number, g: number, b: number) => Math.abs(r - g) < 14 && b - r > 6 && b - r < 30 && r > 110 && r < 200;

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  return errors;
}

/** Wait until the next frame has been drawn (the scene renders on demand and counts its renders on the canvas host). */
async function settle(page: Page): Promise<void> {
  const canvas = page.getByTestId("mv-canvas");
  const before = Number((await canvas.getAttribute("data-renders")) ?? 0);
  await page.waitForTimeout(120);
  await expect.poll(async () => Number((await canvas.getAttribute("data-renders")) ?? 0), { timeout: 10_000 }).toBeGreaterThanOrEqual(before);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function shot(stage: Locator, name: string): Promise<Buffer> {
  await settle(stage.page());
  return stage.screenshot({ path: resolve(OUT, `${name}.png`) });
}

async function openDemo(page: Page, query = ""): Promise<Locator> {
  await page.goto(`/experiment/viewer/${query}`);
  await expect(page.getByTestId("vd-sim")).toHaveText(SIM);
  await expect(page.getByRole("button", { name: "Reset view" })).toBeEnabled({ timeout: 120_000 });
  return page.locator(".mv-stage");
}

const press = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();

test.describe("experimental 3D viewer demo (SIMULATED synthetic hand)", () => {
  test("desktop: every preset, display mode, colour mode, the skeleton and free rotation", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1280, height: 1000 });
    const stage = await openDemo(page);
    await expect(page.locator(".mv-caption")).toHaveText(SIM);
    await expect(page.getByTestId("mv-viewname")).toHaveText("Home view");
    await expect(page.getByTestId("mv-facts")).toContainText("Named from the hand frame");
    await expect(page.getByTestId("mv-facts")).toContainText(/Grid: 10 mm squares/);

    const home = await shot(stage, "desktop-01-home-surface");
    expect(share(home, isModelBlue), "the hand is drawn").toBeGreaterThan(0.04);
    expect(share(home, isOrange), "no skeleton until asked").toBeLessThan(0.0005);

    // presets
    const presets = ["Top", "Palm", "Back", "Thumb side", "Little-finger side", "Fingertips", "Wrist"];
    for (const [i, name] of presets.entries()) {
      await press(page, name);
      await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("mv-viewname")).toHaveText(`${name} view`);
      if (name === "Palm") await expect(page.getByTestId("mv-board-note")).toContainText("Palm side: bounded by the board, not observed");
      else await expect(page.getByTestId("mv-board-note")).toHaveCount(0);
      const png = await shot(stage, `desktop-02-preset-${i + 1}-${name.toLowerCase().replace(/[^a-z]+/g, "-")}`);
      expect(share(png, isModelBlue), `${name}: the hand is drawn`).toBeGreaterThan(0.015);
    }

    // the palm (board-bounded) side in support colours: grey must be visible from below
    await press(page, "Palm");
    await page.getByRole("button", { name: "Show support colours" }).click();
    await expect(page.getByRole("button", { name: "Support", exact: true })).toHaveAttribute("aria-pressed", "true");
    const palmSupport = await shot(stage, "desktop-03-palm-support");
    expect(share(palmSupport, isSupportGrey), "the board-bounded palm reads grey").toBeGreaterThan(0.02);
    await expect(page.getByTestId("mv-legend")).toContainText("bounded by the board, not observed");
    await expect(page.getByTestId("mv-legend")).toContainText("cut at the forearm");
    await expect(page.getByTestId("mv-legend")).toContainText("observed");
    await expect(page.getByTestId("mv-legend")).toContainText("implied");
    await expect(page.getByTestId("mv-legend")).toContainText("truncated");
    await page.getByRole("button", { name: "Reset view" }).click();
    await expect(page.getByTestId("mv-viewname")).toHaveText("Home view");

    // colour and display modes (with the panel in the picture for the legends)
    const panel = page.locator(".mv");
    const combos: [string, string][] = [
      ["Surface", "Support"],
      ["Surface", "Confidence"],
      ["Surface", "Plain"],
      ["Wireframe", "Plain"],
      ["Wireframe", "Support"],
      ["Point cloud", "Plain"],
      ["Point cloud", "Support"],
    ];
    const geometries: string[] = [];
    for (let pass = 0; pass < 2; pass++) {
      for (const [display, colour] of combos) {
        await press(page, display);
        await press(page, colour);
        await expect(page.getByRole("button", { name: display, exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("button", { name: colour, exact: true })).toHaveAttribute("aria-pressed", "true");
        if (pass === 0) {
          await settle(page);
          const png = await panel.screenshot({ path: resolve(OUT, `desktop-04-${display.toLowerCase().replace(" ", "-")}-${colour.toLowerCase()}.png`) });
          if (display === "Surface" && colour === "Support") expect(share(png, isTeal), "the forearm cut reads teal").toBeGreaterThan(0.001);
          if (display === "Surface" && colour === "Confidence") expect(share(png, isRose), "weakly observed areas (the forearm cut face, finger gaps) read rose").toBeGreaterThan(0.0002);
        }
      }
      await settle(page);
      geometries.push((await page.getByTestId("mv-canvas").getAttribute("data-geometries")) ?? "");
    }
    expect(geometries[1], "toggling modes re-created no geometry").toBe(geometries[0]);
    await expect(page.getByRole("button", { name: "Confidence", exact: true })).toBeDisabled(); // the cloud has no confidence

    // the skeleton overlay: off by default, orange on top, then off again
    await press(page, "Surface");
    await press(page, "Plain");
    const skel = page.getByRole("button", { name: "Landmark skeleton (diagnostic)" });
    await expect(skel).toHaveAttribute("aria-pressed", "false");
    await skel.click();
    await expect(skel).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".mv-chip-skeleton")).toContainText("Landmark skeleton (diagnostic)");
    const withSkel = await shot(stage, "desktop-05-skeleton-surface");
    expect(share(withSkel, isOrange), "the skeleton is visible and distinct").toBeGreaterThan(0.002);
    await press(page, "Wireframe");
    await shot(stage, "desktop-05-skeleton-wireframe");
    await press(page, "Top");
    await shot(stage, "desktop-05-skeleton-top");
    await skel.click();
    await press(page, "Surface");
    const noSkel = await shot(stage, "desktop-05-skeleton-off");
    expect(share(noSkel, isOrange)).toBeLessThan(0.0005);

    // free rotation by mouse, well past the pole: no clamp
    await page.getByRole("button", { name: "Reset view" }).click();
    const box = (await page.getByTestId("mv-canvas").boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy - 150);
    await page.mouse.down();
    for (let k = 1; k <= 20; k++) await page.mouse.move(cx, cy - 150 + k * 15);
    await page.mouse.up();
    await expect(page.getByTestId("mv-viewname")).toHaveText("Free view");
    const dragged = await shot(stage, "desktop-06-free-drag");
    expect(share(dragged, isModelBlue)).toBeGreaterThan(0.015);

    // the keyboard: twelve 15-degree turns = 180 degrees, from the top over to the underside
    await press(page, "Top");
    await page.getByTestId("mv-canvas").focus();
    for (let k = 0; k < 12; k++) await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("mv-viewname")).toHaveText("Free view");
    const under = await shot(stage, "desktop-07-keyboard-underside");
    expect(share(under, isModelBlue) + share(under, isSupportGrey)).toBeGreaterThan(0.015);
    await page.keyboard.press("-");
    await page.keyboard.press("0");
    await expect(page.getByTestId("mv-viewname")).toHaveText("Home view");

    await page.screenshot({ path: resolve(OUT, "desktop-08-page.png"), fullPage: true });
    expect(errors, "console errors").toEqual([]);
  });

  test("phone width (390 px): fits without sideways scrolling, controls reachable", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const stage = await openDemo(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
    const png = await shot(stage, "phone-01-home");
    expect(share(png, isModelBlue)).toBeGreaterThan(0.04);
    await press(page, "Palm");
    await shot(stage, "phone-02-palm");
    await press(page, "Support");
    await press(page, "Little-finger side");
    await shot(stage, "phone-03-little-support");
    await page.getByRole("button", { name: "Landmark skeleton (diagnostic)" }).click();
    await press(page, "Point cloud");
    await shot(stage, "phone-04-points-skeleton");
    await page.screenshot({ path: resolve(OUT, "phone-05-page.png"), fullPage: true });
    for (const b of await page.locator(".mv-panel button").all()) {
      const bb = (await b.boundingBox())!;
      expect(bb.x).toBeGreaterThanOrEqual(0);
      expect(bb.x + bb.width).toBeLessThanOrEqual(390);
    }
    expect(errors, "console errors").toEqual([]);
  });

  test("without a hand frame: board-axis views, and the underside carries the board note", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1100, height: 950 });
    const stage = await openDemo(page, "?frame=0&cloud=0");
    await expect(page.getByTestId("mv-facts")).toContainText("No hand frame given: named by the board axes");
    const labels = await page.getByRole("group", { name: "Preset views" }).getByRole("button").allTextContents();
    expect(labels).toEqual(["Top (+z)", "Underside (−z)", "+x end", "−x end", "+y side", "−y side"]);
    await press(page, "Underside (−z)");
    await expect(page.getByTestId("mv-board-note")).toContainText("Underside: bounded by the board, not observed");
    await shot(stage, "noframe-01-underside");
    await press(page, "Point cloud");
    await expect(page.getByTestId("mv-facts")).toContainText("Point cloud shows the mesh's vertices");
    await press(page, "+y side");
    await shot(stage, "noframe-02-mesh-vertices-points");
    expect(errors, "console errors").toEqual([]);
  });

  test("stress: about 500k triangles and 200k points stay responsive", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1280, height: 1000 });
    const t0 = Date.now();
    const stage = await openDemo(page, "?data=stress");
    const readyMs = Date.now() - t0;
    await expect(page.getByTestId("mv-facts")).toContainText(/501,264 triangles/);
    await expect(page.getByTestId("mv-facts")).toContainText(/200,000 points/);
    await shot(stage, "stress-01-surface");
    const timings: Record<string, number> = {};
    for (const mode of ["Wireframe", "Point cloud", "Surface"]) {
      const t = Date.now();
      await press(page, mode);
      await settle(page);
      timings[mode] = Date.now() - t;
      await shot(stage, `stress-02-${mode.toLowerCase().replace(" ", "-")}`);
    }
    // a drag must keep drawing frames
    const box = (await page.getByTestId("mv-canvas").boundingBox())!;
    const canvas = page.getByTestId("mv-canvas");
    const r0 = Number(await canvas.getAttribute("data-renders"));
    const td = Date.now();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let k = 1; k <= 30; k++) await page.mouse.move(box.x + box.width / 2 + k * 8, box.y + box.height / 2 + k * 3);
    await page.mouse.up();
    const dragMs = Date.now() - td;
    const frames = Number(await canvas.getAttribute("data-renders")) - r0;
    console.log(`stress: ready ${readyMs} ms (incl. worker build), mode switches ${JSON.stringify(timings)} ms, drag 30 moves in ${dragMs} ms drew ${frames} frames`);
    expect(frames).toBeGreaterThan(5);
    expect(errors, "console errors").toEqual([]);
  });
});
