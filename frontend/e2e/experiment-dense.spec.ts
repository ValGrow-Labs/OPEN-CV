// The EXPERIMENTAL dense-scan page (dev-only, /experiment/dense/), end to end, with Chrome's fake camera playing the sample
// hand photo in landscape (1280 x 720) and portrait (720 x 1280, the same video turned 90 degrees). Run through its own
// config:   npx playwright test -c playwright.dense.config.ts
//
// What this proves, on that photo: the live hand detection and the quality gates (a blurred or shaking picture does not
// start a scan); the scan through every phase on the real segmentation of a real frame with the frame's own dimensions
// everywhere; dots inside the hand mask and not in the gaps between fingers, also on screen; all five fingers and the wrist
// found; counters that add up; the honest 3D captions; a local ZIP export with matching JSON and CSV, no image data unless
// asked; no uploads, nothing stored in the browser; a clean console and no clipped or sideways-scrolling layout at phone and
// desktop widths; the page's messages for an insecure page and a blocked camera; the frame costs with the CPU slowed 4x
// and 6x.
// What it does NOT prove: anything about real phones, real hands or accuracy (the fake camera is one photo, and the costs
// are this desktop's, with software WebGL, not a phone's).
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUploadViolations, type RecordedRequest } from "../src/experimental/capture/privacy";
import { readZip } from "../src/experimental/capture/zip";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
test.skip(!existsSync(resolve(__dirname, ".media/hand.json")), "hand test video not generated (run node e2e/prepare.mjs)");

declare global {
  interface Window {
    __DENSE_SCAN__?: Record<string, unknown>;
  }
}

const SHOTS = process.env.DS_SHOTS ?? resolve(__dirname, "../test-results/dense-shots");
mkdirSync(SHOTS, { recursive: true });

// The phones use the page's default coin (the 2019 2-rupee coin when the served settings enable it); the desktop picks
// another coin with ?coin=, to show the page follows the served entry for whichever coin is chosen.
const VIEWPORTS: { name: string; width: number; height: number; touch: boolean; button: boolean; coin?: string }[] = [
  { name: "phone-360", width: 360, height: 740, touch: true, button: false },
  { name: "phone-390", width: 390, height: 844, touch: true, button: true },
  { name: "desktop-1280", width: 1280, height: 800, touch: false, button: false, coin: "us_quarter" },
];

const PHASES = ["waiting_hand", "segmenting", "sweeping", "validating", "captured", "processing", "done"];
const FINGERS = ["thumb", "index", "middle", "ring", "little"];

function watch(page: Page) {
  const requests: RecordedRequest[] = [];
  const problems: string[] = [];
  const loads = { count: 0 };
  page.on("load", () => loads.count++);
  page.on("request", (r) => requests.push({ method: r.method(), url: r.url(), postDataBytes: r.postDataBuffer()?.length ?? 0 }));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/favicon|Failed to load resource/.test(t)) return; // the browser asking for a favicon the dev page does not have
    problems.push(`console.error: ${t}`);
  });
  return { requests, problems, loads };
}

/** How far anything is pushed past the right edge (element right edges; boxes that scroll sideways on purpose are exempt),
 *  and any text cut off inside its own box (a label wider than the box that shows it). */
const layoutProblems = (page: Page) =>
  page.evaluate(() => {
    const limit = window.innerWidth;
    let worst = document.documentElement.scrollWidth - limit;
    let who = "the document";
    const clipped: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".ds-root *"))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) continue; // empty, or visually hidden on purpose (screen-reader text)
      let scrolls = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll") scrolls = true;
      }
      if (!scrolls && r.right > limit + 1 && Math.round(r.right - limit) > worst) {
        worst = Math.round(r.right - limit);
        who = `<${el.tagName.toLowerCase()} class="${el.className}"> "${(el.textContent ?? "").trim().slice(0, 50)}"`;
      }
      const cs = getComputedStyle(el);
      const textual = el.children.length === 0 && (el.textContent ?? "").trim().length > 0;
      if (textual && (cs.overflowX === "hidden" || cs.textOverflow === "ellipsis") && el.scrollWidth > el.clientWidth + 1) clipped.push((el.textContent ?? "").trim().slice(0, 40));
    }
    return { worst, who, clipped };
  });
const expectCleanLayout = async (page: Page) => {
  const { worst, who, clipped } = await layoutProblems(page);
  expect(worst, `something is pushed ${worst}px past the right edge of the screen: ${who}`).toBeLessThanOrEqual(0);
  expect(clipped, "text cut off inside its box").toEqual([]);
};

type Summary = { frames: number; medianMs: number | null; p95Ms: number | null; maxMs: number | null };
type LT = { count: number; totalMs: number; maxMs: number };
type Hook = {
  phase: string;
  phases: string[];
  reasons: string[];
  counts: { generated: number; accepted: number; rejected: number; byReason: Record<string, number> } | null;
  spacing: { px: number } | null;
  outsideMask: number;
  gapProbes: { pair: string; x: number; y: number; gap: boolean; nearestAcceptedPx: number | null }[];
  segmentation: { ok: boolean; gapsPreserved: boolean[]; reasons: string[]; wristLine: unknown; wristWidthPx: number; fingertips: unknown[] } | null;
  frame: { width: number; height: number } | null;
  video: { width: number; height: number } | null;
  mask: { width: number; height: number; scaleToSource: number } | null;
  pointBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  regions: Record<string, number> | null;
  display: { k: number; pitchCss: number; shownPitchCss: number; shownAccepted: number; totalAccepted: number; canvas: { width: number; height: number } } | null;
  zUnit: string | null;
  mesh: { triangles: number; completeness: number; components: number; measured: boolean } | null;
  marks: Record<string, number>;
  longTaskLog: { start: number; duration: number }[] | null;
  coin: Record<string, unknown> | null;
  coinVia: string | null;
  coinAtCapture: Record<string, unknown> | null;
  scaleAtCapture: { mmPerPx: number | null; coinMajorPx: number | null; impliedHandMm: number | null } | null;
  liveCoin: { found: boolean; accepted: boolean; reasons: string[]; x: number; y: number; majorPx: number } | null;
  gate: {
    allowed: boolean;
    blocking: { group: string; code: string; words: string } | null;
    groups: Record<string, { status: string; reasons: { code: string; words: string }[] }>;
    waitingForCoinOnly: boolean;
  } | null;
  discarded: string | null;
  live: { reasons: string[]; chips: { steady: { steady: boolean }; sharpness: { sharp: boolean } } | null } | null;
  perf: {
    segmentationMs: number | null;
    segmentationWhere: string | null;
    stages: Record<string, number> | null;
    pointsWhere: string | null;
    pointsWallMs: number | null;
    processing: Record<string, number> | null;
    processWhere: string | null;
    processWallMs: number | null;
    render: Summary;
    frameInterval: Summary;
    longFrames: number;
    points: number;
    longTasks: { supported: boolean; segmentation: LT; points: LT; sweep: LT; processing: LT } | null;
    idleLive: Summary | null;
    idleAfter: Summary | null;
    cameraFps: number | null;
    memory: { atCaptureMb: number | null; afterPointsMb: number | null; afterProcessingMb: number | null } | null;
  };
};
const hook = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify({ ...window.__DENSE_SCAN__, pointSet: undefined })) as unknown) as Promise<Hook>;

const waitPhase = (page: Page, phases: string[], timeout = 180_000) =>
  page.waitForFunction((ps) => ps.includes(String(window.__DENSE_SCAN__?.phase)), phases, { timeout, polling: "raf" });

/** Non-transparent pixels on a canvas (to show that something was drawn on it). */
const inked = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext("2d");
    if (!ctx || !c.width || !c.height) return 0;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });

/** Inked pixels of the dot layer in a square of +-r SOURCE px around a source point (the gap between two fingers). */
const inkAround = (page: Page, frame: { width: number; height: number }, x: number, y: number, r: number) =>
  page.getByTestId("dots-canvas").evaluate(
    (c: HTMLCanvasElement, a) => {
      const sx = c.width / a.fw;
      const sy = c.height / a.fh;
      const x0 = Math.max(0, Math.floor((a.x - a.r) * sx));
      const y0 = Math.max(0, Math.floor((a.y - a.r) * sy));
      const w = Math.max(1, Math.min(c.width - x0, Math.ceil(2 * a.r * sx)));
      const h = Math.max(1, Math.min(c.height - y0, Math.ceil(2 * a.r * sy)));
      const d = c.getContext("2d")!.getImageData(x0, y0, w, h).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    },
    { fw: frame.width, fh: frame.height, x, y, r },
  );

/** Everything a page could have stored in the browser. */
const browserStorage = (page: Page) =>
  page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    indexedDB: ((await indexedDB.databases?.()) ?? []).map((d) => d.name ?? "?"),
    cacheStorage: await caches.keys(),
    serviceWorkers: ((await navigator.serviceWorker?.getRegistrations()) ?? []).length,
  }));
const NOTHING_STORED = { localStorage: 0, sessionStorage: 0, indexedDB: [], cacheStorage: [], serviceWorkers: 0 };

/** The JS heap from the DevTools protocol (Performance.getMetrics, JSHeapUsedSize), in MB. */
async function cdpHeapMb(page: Page): Promise<number | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Performance.enable");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value;
    return used === undefined ? null : Math.round((used / 1048576) * 10) / 10;
  } finally {
    await cdp.detach();
  }
}

// ---- the coin: one source, the served config ------------------------------------------------------------------

type ServedCoin = {
  id: string;
  label: string;
  diameter_mm: number;
  diameter_uncertainty_mm: number;
  source: string;
  enabled: boolean;
  size_check?: boolean;
  customer_hint?: string | null;
};
const PREFERRED = "inr_2_2019";

/** GET /api/config from the TEST (not the page): the single source the page must agree with. */
async function servedCoins(request: APIRequestContext, baseURL: string): Promise<{ default: string; objects: ServedCoin[] }> {
  const res = await request.get(`${baseURL}/api/config`);
  expect(res.ok()).toBe(true);
  return (await res.json()).reference_objects;
}
const expectedCoin = (ro: { default: string; objects: ServedCoin[] }, url?: string) => {
  const id = url ?? (ro.objects.some((o) => o.id === PREFERRED && o.enabled) ? PREFERRED : ro.default);
  return ro.objects.find((o) => o.id === id)!;
};

/** The selector, the coin panel and the debug hook all show the served entry, with nothing hard-coded. */
async function expectCoinShown(page: Page, coin: ServedCoin) {
  await expect(page.locator("#ds-coin")).toHaveValue(coin.id);
  await expect(page.getByTestId("coin-label")).toHaveText(coin.label);
  await expect(page.getByTestId("coin-diameter")).toContainText(`${coin.diameter_mm.toFixed(2)} mm ± ${coin.diameter_uncertainty_mm.toFixed(2)} mm`);
  await expect(page.getByTestId("coin-diameter")).toContainText("assumed allowance");
  await expect(page.getByTestId("coin-source")).toHaveText(coin.source);
  if (coin.customer_hint) await expect(page.getByTestId("coin-hint")).toHaveText(coin.customer_hint);
  await expect(page.getByLabel(/^My coin is the/)).toHaveCount(coin.size_check ? 1 : 0);
  const h = await hook(page);
  expect(h.coin).toMatchObject({ id: coin.id, label: coin.label, diameter_mm: coin.diameter_mm, diameter_uncertainty_mm: coin.diameter_uncertainty_mm, source: coin.source, size_check: !!coin.size_check });
}

/** The coin used for the frozen frame, its scale and the export's calibration block are the served entry's. */
function expectCoinUsed(h: Hook, json: { meta: { calibration: Record<string, unknown> } }, coin: ServedCoin) {
  const record = { id: coin.id, label: coin.label, diameter_mm: coin.diameter_mm, diameter_uncertainty_mm: coin.diameter_uncertainty_mm, source: coin.source, size_check: !!coin.size_check, size_check_confirmed: !!coin.size_check };
  expect(h.coinAtCapture).toMatchObject(record);
  const s = h.scaleAtCapture!;
  // the coin-plane scale: mm per px times the coin's size in px is the coin's diameter from the config
  expect(s.mmPerPx! * s.coinMajorPx!).toBeGreaterThan(coin.diameter_mm * 0.97);
  expect(s.mmPerPx! * s.coinMajorPx!).toBeLessThan(coin.diameter_mm * 1.03);
  const cal = json.meta.calibration;
  expect(cal.referenceObjectId).toBe(coin.id);
  expect(cal.referenceLabel).toBe(coin.label);
  expect(cal.referenceDiameterMm).toBe(coin.diameter_mm);
  expect(cal.referenceDiameterUncertaintyMm).toBe(coin.diameter_uncertainty_mm);
  expect(cal.coin).toMatchObject(record);
  expect((cal.scale as { mmPerPx: number }).mmPerPx).toBeCloseTo(s.mmPerPx!, 9);
}

/** Tick the size confirmation when the selected coin asks for one (after the settings have loaded). */
async function confirmSizeIfAsked(page: Page) {
  await expect(page.locator("#ds-coin")).toBeEnabled();
  const box = page.getByLabel(/^My coin is the/);
  if ((await box.count()) > 0) await box.check();
}

const waitCoinAccepted = (page: Page, timeout = 120_000) =>
  page.waitForFunction(() => (window.__DENSE_SCAN__?.gate as { groups?: { coin?: { status?: string } } } | null)?.groups?.coin?.status === "ok", null, { timeout });

async function startAndWaitForHand(page: Page) {
  await expect(page.getByLabel("Coin on the palm")).toBeEnabled();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByText("Hand: detected")).toBeVisible({ timeout: 150_000 });
}

async function download(page: Page) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download point set (this device only)" }).click()]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), entries: readZip(new Uint8Array(readFileSync(path))) };
}

const IMAGE_DATA = /data:image|;base64,|iVBORw0KGgo|\/9j\/4AAQ/;

const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "n/a" : v.toFixed(d));
const lt = (t: LT | undefined) => (t ? `${t.count}(max ${t.maxMs})` : "n/a");
function perfLine(tag: string, h: Hook, cdpMb: number | null): string {
  const p = h.perf;
  return (
    `[${tag}] frame=${h.frame?.width}x${h.frame?.height} points=${p.points} seg=${fmt(p.segmentationMs, 0)}ms(${p.segmentationWhere}) gen=${fmt(p.stages?.generateMs)} val=${fmt(p.stages?.validateMs)} filter=${fmt(p.stages?.filterMs)} dots-wall=${fmt(p.pointsWallMs, 0)}ms(${p.pointsWhere}) ` +
    `mesh=${fmt(p.processing?.meshMs)}ms build-wall=${fmt(p.processWallMs, 0)}ms(${p.processWhere}) | sweep frame median/p95=${p.frameInterval.medianMs}/${p.frameInterval.p95Ms}ms (${p.frameInterval.frames} frames, long ${p.longFrames}) draw median/p95/max=${p.render.medianMs}/${p.render.p95Ms}/${p.render.maxMs}ms ` +
    `| idle live median=${p.idleLive?.medianMs}ms after=${p.idleAfter?.medianMs}ms camera=${fmt(p.cameraFps, 0)}fps ` +
    `| longtasks seg/dots/sweep/build=${lt(p.longTasks?.segmentation)}/${lt(p.longTasks?.points)}/${lt(p.longTasks?.sweep)}/${lt(p.longTasks?.processing)} ` +
    `| heap(performance.memory) ${fmt(p.memory?.atCaptureMb)}/${fmt(p.memory?.afterPointsMb)}/${fmt(p.memory?.afterProcessingMb)}MB heap(CDP)=${fmt(cdpMb)}MB`
  );
}

/**
 * A phone held upright: Chrome on Android answers the app's 1280 x 720 request (src/camera/camera.ts, unchanged) with a
 * PORTRAIT 720 x 1280 stream. Chrome's fake desktop camera instead crops a portrait file to fit 1280 x 720 (it gave
 * 720 x 720), so in the portrait project the request is turned the way the phone turns it before it reaches the fake camera.
 */
async function emulateUprightPhone(page: Page, info: TestInfo) {
  if (info.project.name !== "portrait") return;
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    const real = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => {
      const v = c?.video;
      if (v && typeof v === "object") {
        const w = v.width as ConstrainULongRange | undefined;
        const h = v.height as ConstrainULongRange | undefined;
        if (w?.ideal && h?.ideal && w.ideal > h.ideal) return real({ ...c, video: { ...v, width: { ideal: h.ideal }, height: { ideal: w.ideal } } });
      }
      return real(c);
    };
  });
}

/** Phase marks and long tasks (start+duration, ms) relative to the moment the frame was frozen. */
function timeline(tag: string, h: Hook): string {
  const t0 = h.marks.segmenting ?? 0;
  const rel = (v: number) => Math.round(v - t0);
  const marks = Object.entries(h.marks)
    .sort((a, b) => a[1] - b[1])
    .map(([k, v]) => `${k}@${rel(v)}`)
    .join(" ");
  const tasks = (h.longTaskLog ?? [])
    .filter((e) => e.start > t0 - 1500)
    .map((e) => `${rel(e.start)}+${Math.round(e.duration)}`)
    .join(" ");
  return `[${tag}] marks ${marks} | long tasks ${tasks || "none"}`;
}

const shot = (info: TestInfo, name: string) => resolve(SHOTS, `${info.project.name}-${name}.png`);

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });

    test(`scans the hand into a dense dot map, exports locally, stores and uploads nothing (${vp.name})`, async ({ page, baseURL, request }, info) => {
      const portrait = info.project.name === "portrait";
      const { requests, problems, loads } = watch(page);
      await emulateUprightPhone(page, info);
      await page.goto(`/experiment/dense/?debug${vp.coin ? `&coin=${vp.coin}` : ""}`);

      await expect(page.getByRole("note").first()).toHaveText("EXPERIMENTAL dense scan, not the customer app. Images stay on this device.");
      await expectCleanLayout(page);

      // The coin: the served config's entry (the 2019 2-rupee coin by default when served, or the ?coin= one).
      const served = await servedCoins(request, baseURL!);
      const coin = expectedCoin(served, vp.coin);
      expect(coin, `coin ${vp.coin ?? "default"} in the served config`).toBeTruthy();
      await expectCoinShown(page, coin);
      expect((await hook(page)).coinVia).toBe(vp.coin ? "url" : coin.id === PREFERRED ? "preferred" : "default");

      if (vp.button) await page.getByLabel(/Start by itself/).uncheck();
      await startAndWaitForHand(page);
      await expectCleanLayout(page);
      const scanButton = page.getByRole("button", { name: "Scan", exact: true });
      if (coin.size_check) {
        // Until the coin's size is confirmed nothing starts, even with the coin accepted: the button is off and says why.
        await waitCoinAccepted(page);
        await page.waitForTimeout(1500);
        const before = await hook(page);
        expect(before.phase, "no scan before the size is confirmed").toBe("waiting_hand");
        expect(before.gate!.allowed).toBe(false);
        expect(before.gate!.groups.calibration.reasons.map((r) => r.code)).toContain("size_not_confirmed");
        await expect(scanButton).toBeDisabled();
        await expect(page.getByTestId("scan-blocked")).toContainText("Calibration");
        await page.screenshot({ path: shot(info, `${vp.name}-0-size-check`), fullPage: true });
        await page.getByLabel(/^My coin is the/).check();
      }
      await page.screenshot({ path: shot(info, `${vp.name}-1-live`) });
      if (vp.button) {
        await waitCoinAccepted(page);
        await expect(scanButton).toBeEnabled({ timeout: 30_000 });
        expect((await hook(page)).phase, "with auto-start off nothing starts by itself").toBe("waiting_hand");
        await scanButton.click();
      }

      // The sweep, caught in the middle for the screenshot; nothing is stored in the browser while it runs.
      await waitPhase(page, ["sweeping", "rejected"]);
      const mid = await hook(page);
      expect(mid.phase, `rejected: ${mid.reasons.join(" ")}`).toBe("sweeping");
      await page.waitForTimeout(300);
      await page.locator(".ds-stage").screenshot({ path: shot(info, `${vp.name}-2-sweep`) });
      expect(await browserStorage(page), "storage during the scan").toEqual(NOTHING_STORED);

      await waitPhase(page, ["done", "rejected"]);
      const h = await hook(page);
      expect(h.phase, `rejected: ${h.reasons.join(" ")}`).toBe("done");
      expect(h.phases).toEqual(PHASES);
      await page.waitForFunction(() => !!(window.__DENSE_SCAN__?.perf as { idleAfter?: unknown })?.idleAfter, null, { timeout: 30_000 });
      const hp = await hook(page); // with the long tasks and the idle frame rate filled in
      await page.locator(".ds-stage").screenshot({ path: shot(info, `${vp.name}-3-done`) });

      // The frame's own dimensions everywhere: video, frame, mask, points, layers, export.
      const f = h.frame!;
      expect(f).toEqual({ width: h.video!.width, height: h.video!.height });
      expect(f.height > f.width, "frame orientation").toBe(portrait);
      expect(Math.abs(h.mask!.width * h.mask!.scaleToSource - f.width)).toBeLessThanOrEqual(h.mask!.scaleToSource + 1);
      expect(Math.abs(h.mask!.height * h.mask!.scaleToSource - f.height)).toBeLessThanOrEqual(h.mask!.scaleToSource + 1);
      const b = h.pointBounds!;
      expect(b.minX).toBeGreaterThanOrEqual(0);
      expect(b.minY).toBeGreaterThanOrEqual(0);
      expect(b.maxX).toBeLessThan(f.width);
      expect(b.maxY).toBeLessThan(f.height);
      const layers = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLCanvasElement>(".ds-stage canvas")).map((c) => ({ cls: c.className, w: c.width, h: c.height })),
      );
      const still = layers.find((l) => l.cls.includes("ds-still"))!;
      expect(still).toMatchObject({ w: f.width, h: f.height });
      for (const l of layers.filter((x) => /ds-dots|ds-line/.test(x.cls))) expect(Math.abs(l.w / l.h - f.width / f.height), `${l.cls} aspect`).toBeLessThan(0.01);
      // the outline layer is above the dots (drawn over them)
      expect(layers.findIndex((l) => l.cls.includes("ds-line"))).toBeGreaterThan(layers.findIndex((l) => l.cls.includes("ds-dots")));
      const stageBox = (await page.locator(".ds-stage").boundingBox())!;
      expect(stageBox.width).toBeLessThanOrEqual(vp.width);

      // The outline and the dots were drawn.
      expect(await inked(page, "line-canvas"), "outline drawn").toBeGreaterThan(200);
      expect(await inked(page, "dots-canvas"), "dots drawn").toBeGreaterThan(200);

      // Segmentation, the wrist boundary, all five fingers and the palm.
      expect(h.segmentation?.ok).toBe(true);
      expect(h.segmentation!.wristLine, "wrist boundary").not.toBeNull();
      expect(h.segmentation!.wristWidthPx).toBeGreaterThan(0);
      for (const r of [...FINGERS, "palm"]) expect(h.regions?.[r] ?? 0, `points on the ${r}`).toBeGreaterThan(0);

      // Counts come from the real arrays and add up; the page shows the same numbers.
      const c = h.counts!;
      expect(c.generated).toBeGreaterThan(0);
      expect(c.accepted).toBeGreaterThan(0);
      expect(c.accepted + c.rejected).toBe(c.generated);
      const num = async (id: string) => Number((await page.getByTestId(id).innerText()).replace(/[^\d]/g, ""));
      expect(await num("c-generated")).toBe(c.generated);
      expect(await num("c-accepted")).toBe(c.accepted);
      expect(await num("c-rejected")).toBe(c.rejected);
      await expect(page.getByTestId("c-progress")).toHaveText("100 %");

      // Every accepted dot is on the hand mask; none sits in a gap between fingers, in the data and on the screen.
      expect(h.outsideMask).toBe(0);
      const gaps = h.gapProbes.filter((g) => g.gap);
      expect(gaps.length, "the sample hand has visible gaps between fingers").toBeGreaterThan(0);
      for (const g of gaps) {
        expect(g.nearestAcceptedPx!, `a dot in the ${g.pair} gap`).toBeGreaterThan(h.spacing!.px / 2);
        expect(await inkAround(page, f, g.x, g.y, 3), `ink in the ${g.pair} gap on screen`).toBe(0);
      }

      // Display only: a coarser display lattice where the full one is too fine to read, said in words.
      const d = h.display!;
      expect(d.totalAccepted).toBe(c.accepted);
      expect(d.shownPitchCss).toBeGreaterThanOrEqual(4.99);
      if (d.k > 1) {
        await expect(page.getByTestId("display-note")).toContainText(`Showing 1 in ${d.k * d.k} dots on this screen`);
        await expect(page.getByTestId("display-note")).toContainText(`all ${c.accepted.toLocaleString("en-GB")} are kept for processing`);
        expect(d.shownAccepted).toBeLessThan(d.totalAccepted);
      } else {
        await expect(page.getByTestId("display-note")).toContainText("Showing every dot");
      }

      // Rejected by reason, on tap.
      if (c.rejected > 0) {
        await page.getByTestId("c-rejected").getByRole("button").click();
        await expect(page.getByLabel("Rejected points by reason")).toBeVisible();
      }

      // The honest labels: estimated relative depth, never "measured".
      expect(h.zUnit).toBe("relative");
      await expect(page.getByTestId("depth-label")).toHaveText("Estimated relative depth from MediaPipe landmarks, not measured.");
      await expect(page.locator(".mv-caption")).toHaveText("Estimated relative depth (MediaPipe), not a measured 3D scan.");
      await page.getByRole("button", { name: "Mesh", exact: true }).click();
      await expect(page.locator(".mv-caption")).toHaveText(/^Flat 2D surface-point map \(no depth\)/);
      expect(h.mesh!.measured).toBe(false);
      expect(h.mesh!.triangles).toBeGreaterThan(0);
      await expect(page.getByTestId("tenth-mm-note")).toContainText("0.1 mm");
      const preview = page.locator("section[aria-labelledby='ds-3d-h']");
      await preview.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1500);
      await preview.screenshot({ path: shot(info, `${vp.name}-4-preview-mesh`) });
      await page.getByRole("button", { name: "Points", exact: true }).click();
      await page.waitForTimeout(1500);
      await preview.screenshot({ path: shot(info, `${vp.name}-5-preview-points`) });
      const pageText = await page.locator(".ds-root").innerText();
      expect(pageText).not.toContain("Measured depth (mm)");
      expect(pageText).not.toContain("with measured depth (mm)");

      // Export: a local download (no request), JSON and CSV with matching counts and the frame size, no image data.
      const before = requests.length;
      const ex = await download(page);
      await page.waitForTimeout(300);
      expect(requests.slice(before).filter((r) => !/^(blob|data):/.test(r.url)), "requests made by the export").toEqual([]);
      expect(ex.entries.map((e) => e.name).sort()).toEqual(["README.txt", "points.csv", "points.json"]);
      for (const e of ex.entries) expect(e.crcOk).toBe(true);
      const jsonText = new TextDecoder().decode(ex.entries.find((e) => e.name === "points.json")!.data);
      const csvText = new TextDecoder().decode(ex.entries.find((e) => e.name === "points.csv")!.data);
      expect(jsonText).not.toMatch(IMAGE_DATA);
      expect(csvText).not.toMatch(IMAGE_DATA);
      expect(jsonText).not.toContain('"pixels"');
      const json = JSON.parse(jsonText);
      expect(json.frame).toEqual(f);
      expect(json.meta.frame).toMatchObject({ ...f, orientation: portrait ? "portrait" : "landscape" });
      expect(json.counts.generated).toBe(c.generated);
      expect(json.counts.accepted).toBe(c.accepted);
      expect(json.points.length).toBe(c.generated);
      expect(json.config.seed).toBeDefined();
      expect(json.meta.stream.settings).toBeDefined();
      // the coin used, its scale and the export's calibration: the served config's entry, nothing else
      expectCoinUsed(h, json, coin);
      expect(json.meta.photoIncluded).toBe(false);
      const csv = csvText.trim().split("\n");
      expect(csv.length - 1).toBe(c.generated);
      expect(csv.slice(1).filter((r) => r.split(",")[6] === "1").length).toBe(c.accepted);
      for (const row of csv.slice(1)) {
        const [, x, y] = row.split(",").map(Number);
        if (!(x >= 0 && x < f.width && y >= 0 && y < f.height)) throw new Error(`CSV point outside the frame: ${row}`);
      }
      if (vp.name === "desktop-1280") {
        // with the consent box ticked, and only then, the photo is in the file
        await page.getByLabel(/Include the photo of my hand/).check();
        const withPhoto = await download(page);
        expect(withPhoto.entries.map((e) => e.name)).toContain("photo.png");
        const meta = JSON.parse(new TextDecoder().decode(withPhoto.entries.find((e) => e.name === "points.json")!.data)).meta;
        expect(meta.photoIncluded).toBe(true);
      }

      await expectCleanLayout(page);
      await page.screenshot({ path: shot(info, `${vp.name}-6-results`), fullPage: true });

      // The cost of this run (this desktop, not a phone).
      const cdpMb = await cdpHeapMb(page);
      console.log(perfLine(`dense-perf ${info.project.name} ${vp.name}`, hp, cdpMb));
      console.log(timeline(`dense-timeline ${info.project.name} ${vp.name}`, hp));
      await expect(page.getByTestId("perf-summary")).toContainText("not a phone's");
      expect(hp.perf.longTasks?.supported).toBe(true);
      // the segmentation, the dots and the mesh run in workers: the page stays responsive (no long task over 200 ms)
      expect([hp.perf.segmentationWhere, hp.perf.pointsWhere, hp.perf.processWhere]).toEqual(["worker", "worker", "worker"]);
      expect(hp.perf.longTasks!.segmentation.maxMs).toBeLessThan(200);
      expect(hp.perf.longTasks!.points.maxMs).toBeLessThan(200);

      if (vp.button) {
        // "Scan again": the live picture resumes and the hand is tracked again (auto-start is off here, so it waits).
        await page.getByRole("button", { name: "Scan again" }).click();
        await expect(page.getByText("Hand: detected")).toBeVisible({ timeout: 60_000 });
        expect((await hook(page)).phase).toBe("waiting_hand");
        await expect(page.getByTestId("c-generated")).toHaveText("0");
      }

      // Nothing stored in the browser, nothing uploaded: only GET /api/config and static files from this origin, no
      // request with a body. One page load. A clean console.
      expect(await browserStorage(page), "storage after the scan and the export").toEqual(NOTHING_STORED);
      const origin = new URL(baseURL!).origin;
      expect(findUploadViolations(requests, origin)).toEqual([]);
      expect(requests.filter((r) => r.method !== "GET" && r.method !== "HEAD")).toEqual([]);
      const api = requests.filter((r) => new URL(r.url).pathname.startsWith("/api/"));
      expect(api.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["GET /api/config"]);
      expect(loads.count).toBe(1);
      expect(problems).toEqual([]);
    });
  });
}

/** The fake camera re-drawn through a canvas whose picture a test can blur or shake (window.__cam = "sharp" | "blur" |
 *  "shake"), or in which it can cover the coin with skin colour (window.__hide = { x, y, r } in frame px, or null): the
 *  hand stays, the coin is gone, as when a customer forgets it. */
async function installAdjustableCamera(page: Page, mode: string) {
  await page.addInitScript((initial) => {
    const w = window as unknown as { __cam: string; __hide: { x: number; y: number; r: number } | null };
    w.__cam = initial;
    w.__hide = null;
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
      let n = 0;
      const draw = () => {
        n++;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.filter = w.__cam === "blur" ? "blur(5px)" : "none";
        // a random shift each frame (an alternating one can alias with the tracker's frame rate and look still)
        const shake = w.__cam === "shake";
        const dx = shake ? (Math.random() - 0.5) * 0.14 * canvas.width : 0;
        const dy = shake ? (Math.random() - 0.5) * 0.14 * canvas.height : 0;
        ctx.drawImage(video, dx, dy, canvas.width, canvas.height);
        ctx.filter = "none";
        const hide = w.__hide;
        if (hide) {
          // skin colour from beside the coin, painted over it with a soft edge (no new circle for the detector to find)
          const s = ctx.getImageData(Math.round(hide.x + hide.r * 1.9), Math.round(hide.y), 1, 1).data;
          const g = ctx.createRadialGradient(hide.x, hide.y, hide.r * 0.6, hide.x, hide.y, hide.r * 1.8);
          g.addColorStop(0, `rgba(${s[0]},${s[1]},${s[2]},1)`);
          g.addColorStop(1, `rgba(${s[0]},${s[1]},${s[2]},0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(hide.x, hide.y, hide.r * 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
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
  }, mode);
}

test.describe("quality gates and camera problems, 390 x 844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a blurred or shaking picture does not start a scan; a sharp, still one does", async ({ page }, info) => {
    test.skip(info.project.name !== "landscape", "the gates are the same in both orientations");
    const { problems } = watch(page);
    await installAdjustableCamera(page, "blur");
    await page.goto("/experiment/dense/?debug");
    // the size is confirmed up front (if the coin needs it), so only the picture can hold the scan back
    await confirmSizeIfAsked(page);
    await startAndWaitForHand(page);
    const gate = async (reason: RegExp, chip: "sharpness" | "steady", code: string) => {
      // for several seconds: the gate fails, says why (live loop and the page's hand group), and nothing starts
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(500);
        const h = await hook(page);
        expect(h.phase).toBe("waiting_hand");
        if (!h.live?.chips) continue; // no hand in this frame
        expect(h.live.reasons.join(" ")).toMatch(reason);
        expect(chip === "sharpness" ? h.live.chips.sharpness.sharp : h.live.chips.steady.steady).toBe(false);
        expect(h.gate!.allowed).toBe(false);
        expect(h.gate!.groups.hand.status).toBe("failed");
        expect(h.gate!.groups.hand.reasons.map((r) => r.code)).toContain(code);
      }
      await expect(page.getByRole("button", { name: "Scan", exact: true })).toBeDisabled();
      await expect(page.locator('[data-group="hand"]')).toHaveAttribute("data-status", "failed");
    };
    await gate(/blurred/, "sharpness", "picture_blurred");
    await expect(page.locator(".ds-chip", { hasText: "Sharp:" })).toHaveClass(/is-bad/);
    await page.screenshot({ path: shot(info, "gate-blur") });
    await page.evaluate(() => ((window as unknown as { __cam: string }).__cam = "shake"));
    await page.waitForTimeout(800);
    await gate(/Hold the hand still/, "steady", "hand_unsteady");
    await expect(page.locator(".ds-chip", { hasText: "Steady:" })).toHaveClass(/is-bad/);
    await page.evaluate(() => ((window as unknown as { __cam: string }).__cam = "sharp"));
    await waitPhase(page, ["sweeping", "done", "rejected"], 90_000);
    expect((await hook(page)).phases).toContain("sweeping");
    expect(problems).toEqual([]);
  });

  test("an unknown ?coin= is ignored with a visible note, and the default coin stays", async ({ page, baseURL, request }, info) => {
    test.skip(info.project.name !== "landscape", "orientation does not matter here");
    await page.goto("/experiment/dense/?coin=not_a_coin");
    await expect(page.getByTestId("coin-note")).toContainText('"not_a_coin"');
    await expect(page.getByTestId("coin-note")).toContainText("ignored");
    await expectCoinShown(page, expectedCoin(await servedCoins(request, baseURL!)));
  });

  test("on a page that is not secure (http on a network address) it says why the camera cannot start", async ({ page }, info) => {
    test.skip(info.project.name !== "landscape", "orientation does not matter here");
    await page.addInitScript(() => Object.defineProperty(window, "isSecureContext", { get: () => false }));
    await page.goto("/experiment/dense/");
    await expect(page.getByTestId("insecure")).toContainText("This page is not secure");
    await expect(page.getByTestId("insecure")).toContainText("npm run dev:https");
    await expect(page.getByRole("button", { name: "Start camera" })).toBeDisabled();
    await expectCleanLayout(page);
    await page.screenshot({ path: shot(info, "insecure") });
  });

  test("a blocked camera is explained, with how to allow it", async ({ page }, info) => {
    test.skip(info.project.name !== "landscape", "orientation does not matter here");
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    await page.goto("/experiment/dense/");
    await page.getByRole("button", { name: "Start camera" }).click();
    await expect(page.getByTestId("camera-error")).toContainText("Camera access is blocked");
    await expect(page.getByTestId("blocked")).toContainText("Permissions, Camera, Allow");
    await expect(page.getByRole("button", { name: "Try the camera again" })).toBeEnabled();
    await expectCleanLayout(page);
    await page.screenshot({ path: shot(info, "blocked") });
  });
});

test.describe("waiting for the coin, 360 x 740", () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

  test("with the hand ready but no coin: the indicator, the coin reasons, Scan off; then with the coin the full scan runs", async ({ page, baseURL, request }, info) => {
    test.skip(info.project.name !== "landscape", "orientation does not matter here");
    const { problems } = watch(page);
    await installAdjustableCamera(page, "sharp");
    await page.goto("/experiment/dense/?debug");
    const coin = expectedCoin(await servedCoins(request, baseURL!));
    await confirmSizeIfAsked(page);
    // auto-start off while the coin is located and covered; on again once the coin engine has stopped accepting it
    await page.getByLabel(/Start by itself/).uncheck();
    await startAndWaitForHand(page);
    await waitCoinAccepted(page);
    const c = (await hook(page)).liveCoin!;
    await page.evaluate((h) => ((window as unknown as { __hide: unknown }).__hide = h), { x: c.x, y: c.y, r: c.majorPx / 2 });
    await expect(page.getByTestId("coin-indicator")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel(/Start by itself/).check();
    await expect(page.getByTestId("coin-indicator")).toContainText("Waiting for coin acceptance");
    await expect(page.getByTestId("coin-indicator")).toContainText("centre of your palm");
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(500);
      const h = await hook(page);
      expect(h.phase, "no scan without an accepted coin").toBe("waiting_hand");
      if (!h.gate?.waitingForCoinOnly) continue;
      expect(h.gate.allowed).toBe(false);
      expect(h.gate.groups.hand.status).toBe("ok");
      expect(h.gate.groups.coin.status).not.toBe("ok");
      expect(h.gate.groups.coin.reasons.length).toBeGreaterThan(0);
      expect(h.gate.groups.calibration.reasons.map((r) => r.code)).toEqual(["no_accepted_coin"]);
    }
    await expect(page.locator('[data-group="coin"]')).not.toHaveAttribute("data-status", "ok");
    await expect(page.locator('[data-group="coin"] li').first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan", exact: true })).toBeDisabled();
    await expect(page.getByTestId("scan-blocked")).toContainText("Coin detection");
    const h0 = await hook(page);
    console.log(`[dense-coin-missing] coin group ${h0.gate?.groups.coin.status}: ${h0.gate?.groups.coin.reasons.map((r) => `${r.code} (${r.words})`).join("; ")}`);
    await page.screenshot({ path: shot(info, "coin-missing-360") });
    await page.locator(".ds-stage").screenshot({ path: shot(info, "coin-indicator-360") });
    await page.getByTestId("reasons-panel").screenshot({ path: shot(info, "reasons-panel-360") });
    await page.getByTestId("coin-panel").screenshot({ path: shot(info, "coin-panel-360") });
    await expectCleanLayout(page);

    // the coin back: accepted, the indicator goes, and the scan runs through to the end
    await page.evaluate(() => ((window as unknown as { __hide: unknown }).__hide = null));
    await waitPhase(page, ["done", "rejected"], 180_000);
    const h = await hook(page);
    expect(h.phase, `rejected: ${h.reasons.join(" ")}`).toBe("done");
    expect(h.phases).toEqual(PHASES);
    expect(h.coinAtCapture).toMatchObject({ id: coin.id, diameter_mm: coin.diameter_mm });
    await expect(page.getByTestId("coin-indicator")).toHaveCount(0);
    expect(problems).toEqual([]);
  });
});

for (const rate of [4, 6]) {
  test.describe(`busy phone stand-in (CPU slowed ${rate}x), 390 x 844`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test(`the scan's costs with the CPU throttled ${rate}x (not phone numbers)`, async ({ page }, info) => {
      const { problems } = watch(page);
      await emulateUprightPhone(page, info);
      await page.goto("/experiment/dense/?debug");
      // The scan is started with the Scan button: this measures the scan's own costs on a slowed CPU. (The automatic
      // start waits for 8 consecutive good frames, which a 3-5 fps throttled live loop may take minutes to deliver;
      // the gates themselves are tested above, unthrottled.)
      await page.getByLabel(/Start by itself/).uncheck();
      await confirmSizeIfAsked(page);
      await startAndWaitForHand(page);
      await waitCoinAccepted(page);
      await expect(page.getByRole("button", { name: "Scan", exact: true })).toBeEnabled({ timeout: 30_000 });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
      try {
        await page.getByRole("button", { name: "Scan", exact: true }).click();
        await waitPhase(page, ["done", "rejected"], 240_000);
        await page.waitForFunction(() => !!(window.__DENSE_SCAN__?.perf as { idleAfter?: unknown })?.idleAfter, null, { timeout: 60_000 });
      } finally {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        await cdp.detach();
      }
      const h = await hook(page);
      expect(h.phase, `rejected: ${h.reasons.join(" ")}`).toBe("done");
      expect(h.frame!.height > h.frame!.width, "frame orientation").toBe(info.project.name === "portrait");
      console.log(perfLine(`dense-perf-${rate}x ${info.project.name}`, h, await cdpHeapMb(page)));
      console.log(timeline(`dense-timeline-${rate}x ${info.project.name}`, h));
      // The dot drawing itself stays a small part of a frame even on a slowed CPU (each frame draws only the new rows).
      expect(h.perf.render.frames).toBeGreaterThan(5);
      expect(h.perf.render.medianMs!).toBeLessThan(16);
      expect(problems).toEqual([]);
    });
  });
}
