// The EXPERIMENTAL guided capture prototype (dev-only page /experiment/), end to end, with Chrome's fake camera playing the
// sample hand photo. Run through its own config:   npx playwright test -c playwright.experiment.config.ts
//
// What this proves: the four views can be walked through with the live hand/coin/posture/steadiness/sharpness checks; the
// experimental segmentation runs on a captured view and says what it found in words; the local bundle is a valid ZIP with
// the manifest, images and masks; the SIMULATED reconstruction is labelled everywhere; nothing is uploaded; the console is
// clean; nothing scrolls sideways at phone and desktop widths.
// What it does NOT prove: anything about real phones, real hands, or accuracy (the fake camera is a photo, and the turned,
// squeezed and mirrored pictures are stand-ins made by e2e/views.ts, not real turned hands).
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUploadViolations, type RecordedRequest } from "../src/experimental/capture/privacy";
import { readZip } from "../src/experimental/capture/zip";
import { installTurnableCamera, showSide } from "./views";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run node e2e/prepare.mjs)");

const SHOTS = process.env.XP_SHOTS ?? "test-results";

const VIEWPORTS = [
  { name: "phone-360", width: 360, height: 740, touch: true },
  { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "desktop-1280", width: 1280, height: 800, touch: false },
];

function watch(page: Page) {
  const requests: RecordedRequest[] = [];
  const problems: string[] = [];
  const loads = { count: 0 }; // full page loads: more than one means the dev server reloaded the page (and the captures were lost)
  page.on("load", () => loads.count++);
  page.on("request", (r) => requests.push({ method: r.method(), url: r.url(), postDataBytes: r.postDataBuffer()?.length ?? 0 }));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.text().startsWith("[capture]")) console.log(m.text()); // the capture trail, shown in the test output
    if (m.type() !== "error") return;
    const t = m.text();
    if (/favicon|Failed to load resource/.test(t)) return; // the browser asking for a favicon the dev page does not have
    problems.push(`console.error: ${t}`);
  });
  return { requests, problems, loads };
}

/**
 * How far (px) anything is pushed past the right edge of the screen. The page root hides horizontal overflow, so the document's own
 * scrollWidth cannot see content that is merely cut off: this measures every element's right edge instead (elements inside a box that
 * scrolls sideways on purpose, such as a table wrapper, are exempt).
 */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const limit = window.innerWidth;
    let worst = document.documentElement.scrollWidth - limit;
    let who = "the document";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".xp-root *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= limit + 1) continue;
      let scrolls = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll") scrolls = true;
      }
      if (!scrolls && Math.round(r.right - limit) > worst) {
        worst = Math.round(r.right - limit);
        who = `<${el.tagName.toLowerCase()} class="${el.className}"> "${(el.textContent ?? "").trim().slice(0, 50)}"`;
      }
    }
    return { worst, who };
  });
const expectNoOverflow = async (page: Page) => {
  const { worst, who } = await overflow(page);
  expect(worst, `something is pushed ${worst}px past the right edge of the screen: ${who}`).toBeLessThanOrEqual(0);
};

const step = (page: Page, title: string, what: RegExp) => expect(page.getByLabel("Views").getByText(new RegExp(`${title}${what.source}`))).toBeVisible({ timeout: 150_000 });

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });

    test(`walks the four views, analyses, exports, simulates, and uploads nothing (${vp.name})`, async ({ page, baseURL }) => {
      const { requests, problems, loads } = watch(page);
      await installTurnableCamera(page);
      await page.goto("/experiment/");

      // The banner and the honest framing.
      await expect(page.getByRole("note").first()).toContainText("EXPERIMENTAL research prototype, not the customer app. Images stay on this device; nothing is uploaded.");
      await expect(page.getByText("Marker-sheet pose estimation is NOT implemented yet.")).toBeVisible();
      await expectNoOverflow(page);

      // The settings come from the existing public config (the page's only API request).
      await expect(page.getByLabel("Coin you will use")).toBeEnabled();
      expect(await page.getByLabel("Coin you will use").locator("option").count()).toBeGreaterThan(0);

      // Camera on: the live checks of the first view.
      await page.getByRole("button", { name: "Start camera" }).click();
      await expect(page.getByText("Hand: found")).toBeVisible({ timeout: 150_000 });
      // No wait for the "Coin: accepted" chip here: the page captures the palm by itself the moment every check has passed, and the chip then
      // reads "not needed in this view", so waiting for it is a race with the app working correctly. That the palm's coin was accepted is
      // asserted below from the exported manifest (views[0].coin.accepted), which is the record of what the check saw.
      await expect(page.getByText(/^Sharp: /)).toBeVisible();
      await expect(page.getByText(/^Steady: /)).toBeVisible();

      // 1. Open palm: captured by itself once every check has passed (nothing is faked: the live chips are the checks).
      await step(page, "Open palm", /: captured(?!, checks)/);
      // 2 and 3. The two edge-on profiles (the fake camera squeezes the picture to a strip, as a hand on its edge).
      await showSide(page, "side");
      await step(page, "Thumb-side profile", /: captured/);
      await step(page, "Little-finger-side profile", /: captured/);
      // 4. The back of the hand (the picture mirrored, which flips the hand's turn as turning a hand over does).
      await showSide(page, "back");
      await step(page, "Back of hand", /: captured/);
      await expect(page.getByText("Every view is captured or skipped.")).toBeVisible();
      await expectNoOverflow(page);

      // Segmentation runs on each captured view and says what it found, in words.
      const cards = page.locator('article[aria-label^="Analysis of"]');
      await expect(cards).toHaveCount(4);
      for (let i = 0; i < 4; i++) await expect(cards.nth(i).getByText(/Segmentation (accepted|rejected) by the quality gates/)).toBeVisible({ timeout: 240_000 });
      for (let i = 0; i < 4; i++) {
        const card = cards.nth(i);
        const title = (await card.getByRole("heading", { level: 3 }).innerText()).trim();
        const time = (await card.locator("dt:has-text('Segmentation time') + dd").innerText()).trim();
        const verdict = (await card.getByText(/Segmentation (accepted|rejected) by the quality gates/).innerText()).replace(/\s+/g, " ").slice(0, 160);
        console.log(`[xp-timing] ${vp.name} | ${title}: ${time} | ${verdict}`); // for the report: how long each view's segmentation took here
      }
      const palm = page.locator('article[aria-label="Analysis of Open palm"]');
      const areaText = await palm.locator("dt:has-text('Projected hand area') + dd").innerText();
      const area = Number(areaText.replace(/[^\d]/g, ""));
      expect(area, `palm area text "${areaText}"`).toBeGreaterThan(20_000);
      await expect(palm.getByText(/Segmentation time/)).toBeVisible();
      // The mask is drawn over the still (a non-blank canvas of the still's size).
      const drawn = await palm.locator("canvas").evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let tinted = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 2] > d[i] + 60) tinted++;
        return { w: c.width, h: c.height, tinted };
      });
      expect(drawn.w).toBeGreaterThan(300);
      expect(drawn.tinted, "pixels carrying the blue mask tint").toBeGreaterThan(500);
      // Every millimetre figure is labelled a model estimate.
      await expect(palm.getByText(/Model estimate from the coin's plane scale: unvalidated/)).toBeVisible();
      // A profile has no coin: no millimetre figures, said in words.
      await expect(page.locator('article[aria-label="Analysis of Thumb-side profile"]').getByText("No accepted coin in this view, so no millimetre figures are shown.")).toBeVisible();

      // Pose consistency across the views, with the flagged views named.
      await expect(page.getByRole("heading", { name: /Did the hand keep its pose/ })).toBeVisible();
      await expect(page.getByText(/No view differs from the others|Flagged: /)).toBeVisible();

      // Depth capability, with the iPhone note.
      await expect(page.locator("dt:has-text('Platform') + dd")).toHaveText(vp.touch ? /desktop|android|other/ : "desktop");
      await expect(page.getByText(/Safari cannot give a web page any depth/)).toBeVisible();

      // Export: a valid ZIP, built here, with the manifest, the images and the masks.
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download capture bundle (this device only)" }).click()]);
      expect(download.suggestedFilename()).toMatch(/^experimental-capture-.*\.zip$/);
      const bytes = new Uint8Array(readFileSync((await download.path())!));
      const zip = readZip(bytes);
      const names = zip.map((e) => e.name);
      expect(names).toContain("manifest.json");
      expect(names).toContain("README.txt");
      for (const n of ["01-palm", "02-thumb-side", "03-little-side", "04-back"]) expect(names, `still of ${n}`).toContain(`views/${n}.png`);
      expect(names.filter((n) => n.startsWith("masks/")).length).toBeGreaterThanOrEqual(1);
      expect(zip.every((e) => e.crcOk), "every CRC-32 verifies").toBe(true);
      const png = zip.find((e) => e.name === "views/01-palm.png")!.data;
      expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const manifestText = new TextDecoder().decode(zip.find((e) => e.name === "manifest.json")!.data);
      const manifest = JSON.parse(manifestText);
      expect(manifest.schema).toMatch(/^glovesize-experimental-capture\/\d+$/);
      expect(manifest.experimental).toBe(true);
      expect(manifest.marker.implemented).toBe(false);
      expect(manifest.views.map((v: { id: string }) => v.id)).toEqual(["palm", "thumb", "little", "back"]);
      expect(manifest.views[0].landmarksImagePx).toHaveLength(21);
      expect(manifest.views[0].coin.accepted).toBe(true);
      expect(manifest.views[0].stream.settings).toBeTruthy();
      expect(manifest.config.calibrationValidated).toBe(false);
      expect(manifestText).not.toMatch(/data:image|base64/);
      expect(new TextDecoder().decode(zip.find((e) => e.name === "README.txt")!.data)).toMatch(/PERSONAL DATA/);
      await expect(page.getByRole("status", { name: "Last export" }), "the page must announce the export it built").toBeVisible();
      await expect(page.getByLabel("Files in the bundle").getByRole("listitem")).toHaveCount(names.length);

      // The SIMULATED reconstruction: separate, and labelled SIMULATED everywhere.
      const sim = page.locator('section[data-simulated="true"]');
      await expect(sim.getByRole("heading", { name: /SIMULATED reconstruction \(synthetic hand, not your hand\)/ })).toBeVisible();
      await expect(sim).toContainText("This proves the mathematics only.");
      await sim.getByRole("button", { name: "Run simulated reconstruction (synthetic hand, not your hand)" }).click();
      const table = sim.getByRole("table", { name: "SIMULATED truth versus estimate" });
      await expect(table).toBeVisible({ timeout: 240_000 });
      await expect(table.getByRole("columnheader", { name: "SIMULATED measurement" })).toBeVisible();
      await expect(table.locator("tbody tr")).toHaveCount(10);
      const lengthError = Number((await table.locator("tr:has-text('Hand length') td").nth(3).innerText()).replace("+", ""));
      expect(Math.abs(lengthError), "simulated hand-length error in mm").toBeLessThan(3);
      await expect(sim.locator(".xp-viewer")).toContainText(/SIMULATED: a synthetic capsule hand|3D view unavailable/);
      await page.screenshot({ path: `${SHOTS}/experiment-${vp.name}.png`, fullPage: true });

      // Clear: the captures vanish from the page.
      await page.getByRole("button", { name: "Clear all captures" }).click();
      await expect(cards).toHaveCount(0);
      await expect(page.getByText("All captures cleared from memory.").first()).toBeVisible();
      await expectNoOverflow(page);

      // Nothing was uploaded: only static assets and GET /api/config.
      const origin = new URL(baseURL!).origin;
      expect(findUploadViolations(requests, origin)).toEqual([]);
      expect(requests.some((r) => r.method === "GET" && new URL(r.url).pathname === "/api/config")).toBe(true);
      expect(requests.some((r) => r.method !== "GET")).toBe(false);
      expect(problems).toEqual([]);
      expect(loads.count, "the page must load once: a second load means the dev server reloaded it and dropped the captured views").toBe(1);
    });
  });
}
