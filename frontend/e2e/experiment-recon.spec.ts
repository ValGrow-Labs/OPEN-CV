// The EXPERIMENTAL board-capture page (dev-only, /experiment/recon/), end to end, with Chrome's fake camera playing a
// SIMULATED orbit round the synthetic capsule hand resting on the printed board (e2e/recon-media.ts). Run through its own
// config:   npx playwright test -c playwright.recon.config.ts
//
// What this proves, on that SIMULATED video: the guide (board download, the coin from the served settings); the live marker
// analysis, the coverage dial and the automatic capture of the top view and all 12 low sectors with nobody touching the
// page; the reconstruction in a worker from the captured pixels alone (the page is told no focal length and no pose); the
// viewer, the measurement table with every value's basis (or "not available"), the quality verdict and every reason in
// words; a local ZIP without photos by default; no request but GET /api/config (and the page's own static files); nothing
// stored in the browser; no page errors; no sideways scrolling at 360 px. Screenshots go to test-results/recon/.
// With `?validation`: Start camera stays disabled until the board print check (ruler readings of the SIMULATED print,
// which is exact, so the layout's own lengths are typed in) and the test-run details are filled; the export then carries
// run, board_check (ruler, flatness, coin), per-view marker_residuals, hand_frame, finger_axes and a device.json.
// What it does NOT prove: anything about real phones, real prints, real light, real hands or accuracy.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUploadViolations, type RecordedRequest } from "../src/experimental/capture/privacy";
import { readZip } from "../src/experimental/capture/zip";
import { expectedRuler } from "../src/experimental/recon/page/boardCheck";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SHOTS = resolve(__dirname, "../test-results/recon");
mkdirSync(SHOTS, { recursive: true });
const META = JSON.parse(readFileSync(resolve(__dirname, ".media/recon-orbit.json"), "utf8")) as {
  loopSeconds: number;
  trueIntrinsics: { fx: number };
  truth: { handLength: number; palmBreadth: number; palmThickness: number; circumference: number; fingerLengths: Record<string, number> };
};

type Hook = {
  phase: string;
  coin: { id: string; label: string; diameter_mm: number } | null;
  captures: { id: string; bin: string; markers: number; elevation: number; azimuth: number; landmarks: number; trigger: string }[];
  filled: string[];
  missing: string[];
  live: { markers: number; elevationDeg: number | null; azimuthDeg: number | null; gate: string; guidance: string } | null;
  progress: string;
  buildError: string | null;
  result: {
    refused: string | null;
    calibration: { method: string; fx: number; rmsPx: number | null } | null;
    viewsWithPose: number;
    accepted: boolean | null;
    reasons: string[];
    hasMesh: boolean;
    triangles: number;
    landmarkViews: number;
    handFrame: boolean;
    measurements: Record<string, { value: number | null; basis: string }> | null;
    supportShare: Record<string, number> | null;
    coin: { ok: boolean; diameterMm?: number; printScale?: number; reason?: string } | null;
    timings: { detect: number; calibrate: number; pose: number; reconstruct: number; total: number };
    wallMs: number | null;
    heap: { before: number | null; after: number | null } | null;
  } | null;
  exportInfo: { bytes: number; files: number; photos: boolean } | null;
  debug: { analysedFps: number; cameraFps: number; detectMedianMs: number | null; frames: number } | null;
  validation: {
    mode: boolean;
    ruler: string;
    startBlockers: string[];
    captureIndex: number;
    liveFlatness: { verdict: string; median: number | null; worst: number | null; views: number } | null;
    flatness: { verdict: string; median: number | null; worst: number | null; ratio: number | null; views: number } | null;
    valid: { valid: boolean; reasons: string[] } | null;
  };
  device: { heap_samples_mb: number[] | null; errors: string[] } | null;
};
const hook = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__RECON__ ?? {})) as unknown) as Promise<Hook>;

declare global {
  interface Window {
    __RECON__?: Record<string, unknown>;
  }
}

function watch(page: Page) {
  const requests: RecordedRequest[] = [];
  const problems: string[] = [];
  page.on("request", (r) => requests.push({ method: r.method(), url: r.url(), postDataBytes: r.postDataBuffer()?.length ?? 0 }));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/favicon|Failed to load resource/.test(t)) return;
    problems.push(`console.error: ${t}`);
  });
  return { requests, problems };
}

const browserStorage = (page: Page) =>
  page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    indexedDB: ((await indexedDB.databases?.()) ?? []).map((d) => d.name ?? "?"),
    cacheStorage: await caches.keys(),
    serviceWorkers: ((await navigator.serviceWorker?.getRegistrations()) ?? []).length,
  }));

/** How far anything is pushed past the right edge (boxes that scroll sideways on purpose are exempt). */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const limit = window.innerWidth;
    let worst = document.documentElement.scrollWidth - limit;
    let who = "the document";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".rc-root *"))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) continue;
      let scrolls = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll") scrolls = true;
      }
      if (!scrolls && r.right > limit + 1 && Math.round(r.right - limit) > worst) {
        worst = Math.round(r.right - limit);
        who = `<${el.tagName.toLowerCase()} class="${el.className}"> "${(el.textContent ?? "").trim().slice(0, 50)}"`;
      }
    }
    return { worst, who };
  });

async function shot(page: Page, name: string, size: { width: number; height: number }, fullPage = true) {
  await page.setViewportSize(size);
  await page.waitForTimeout(400);
  const o = await overflow(page);
  expect(o.worst, `${name}: something is pushed ${o.worst}px past the right edge: ${o.who}`).toBeLessThanOrEqual(0);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage });
}

test("captures the orbit automatically, builds the 3D hand, shows it honestly, exports locally, sends nothing", async ({ page }, testInfo) => {
  const { requests, problems } = watch(page);
  const run = testInfo.repeatEachIndex + testInfo.retry;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/experiment/recon/?debug&validation");

  // ---- the guide
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect(page.getByTestId("experimental-badge")).toContainText("EXPERIMENTAL");
  await expect(page.getByTestId("coin-label")).toBeVisible();
  const h0 = await hook(page);
  expect(h0.coin, "the coin comes from GET /api/config").not.toBeNull();
  await expect(page.getByTestId("coin-label")).toHaveText(`${h0.coin!.label}, ${Number(h0.coin!.diameter_mm.toFixed(2))} mm`);
  // ---- validation mode: the camera cannot start before the board check and the run details
  await expect(page.getByTestId("validation-badge")).toBeVisible();
  await expect(page.getByTestId("start-camera")).toBeDisabled();
  await expect(page.getByTestId("start-blockers")).toContainText("ruler readings");
  await expect(page.getByTestId("ruler-verdict")).toHaveAttribute("data-verdict", "not_entered");
  await shot(page, "01-guide-phone-390", { width: 390, height: 844 });
  await shot(page, "01-guide-phone-360", { width: 360, height: 740 });
  await shot(page, "01-guide-desktop-1280", { width: 1280, height: 800 });
  await page.setViewportSize({ width: 390, height: 844 });
  // a scaled print first: the verdict asks for a reprint and the camera stays locked
  const E = expectedRuler();
  const fill = async (sx: number, sy: number, l: number, sh: number) => {
    await page.getByTestId("ruler-square-x").fill(String(sx));
    await page.getByTestId("ruler-square-y").fill(String(sy));
    await page.getByTestId("ruler-long-span").fill(String(l));
    await page.getByTestId("ruler-short-span").fill(String(sh));
  };
  await fill(+(E.square_mm * 0.97).toFixed(1), +(E.square_mm * 0.97).toFixed(1), +(E.long_span_mm * 0.97).toFixed(1), +(E.short_span_mm * 0.97).toFixed(1));
  await expect(page.getByTestId("ruler-verdict")).toHaveAttribute("data-verdict", "reprint");
  await expect(page.getByTestId("ruler-verdict")).toContainText("Reprint at 100 % / actual size");
  await shot(page, "01b-ruler-reprint-phone-390", { width: 390, height: 844 });
  // the SIMULATED print is exact: the layout's own lengths
  await fill(E.square_mm, E.square_mm, E.long_span_mm, E.short_span_mm);
  await expect(page.getByTestId("ruler-verdict")).toHaveAttribute("data-verdict", "pass");
  for (const k of ["matte", "flat", "noGlare"]) await page.getByTestId(`check-${k}`).check();
  await expect(page.getByTestId("start-camera")).toBeDisabled(); // the run details are still missing
  await page.getByTestId("run-phantom").fill("PH-SIM01");
  await page.getByTestId("run-session").fill("S-SIM");
  await page.getByTestId("run-operator").fill("Alice"); // a name is refused
  await page.getByTestId("cond-baseline").check();
  await expect(page.getByTestId("run-problems")).toContainText("Never a name");
  await expect(page.getByTestId("start-camera")).toBeDisabled();
  await page.getByTestId("run-operator").fill("OP01");
  await page.getByTestId("run-notes").fill("SIMULATED fake camera (e2e)");
  await expect(page.getByTestId("start-blockers")).toHaveCount(0);
  await expect(page.getByTestId("start-camera")).toBeEnabled();
  await shot(page, "01c-guide-filled-phone-390", { width: 390, height: 844 });
  await shot(page, "01c-guide-filled-desktop-1280", { width: 1280, height: 800 });
  await page.setViewportSize({ width: 390, height: 844 });
  const [boardDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-board").click()]);
  expect(boardDl.suggestedFilename()).toMatch(/\.svg$/);
  const svg = readFileSync((await boardDl.path())!, "utf8");
  expect(svg).toContain('width="297mm"');
  expect(svg).toContain('height="210mm"');

  // ---- live capture, hands off: the page must take the top view and all 12 low sectors by itself
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("start-camera").click();
  await page.waitForFunction(() => (window.__RECON__ as { phase?: string } | undefined)?.phase === "live");
  await page.waitForFunction(() => ((window.__RECON__ as { captures?: unknown[] } | undefined)?.captures?.length ?? 0) >= 3, null, { timeout: 120_000 });
  await shot(page, "02-live-phone-390", { width: 390, height: 844 });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByTestId("live").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "02-live-phone-landscape-844", { width: 844, height: 390 }, false);
  await shot(page, "02-live-desktop-1280", { width: 1280, height: 800 });
  const captureTimeout = Math.round(META.loopSeconds * 6 * 1000);
  await page.waitForFunction(() => ((window.__RECON__ as { missing?: unknown[] } | undefined)?.missing?.length ?? 99) === 0, null, { timeout: captureTimeout, polling: 500 });
  const h1 = await hook(page);
  console.log(
    `[recon e2e run ${run}] captured ${h1.captures.length} views automatically: ${h1.captures.map((c) => `${c.bin}(${c.markers}m, ${c.elevation.toFixed(1)}/${c.azimuth.toFixed(1)}deg, lm ${c.landmarks})`).join(" ")}; live analysis ${h1.debug?.analysedFps.toFixed(1)}/s, camera ${h1.debug?.cameraFps.toFixed(1)} fps, detect median ${h1.debug?.detectMedianMs?.toFixed(0)} ms`,
  );
  expect(h1.captures.every((c) => c.trigger === "auto")).toBe(true);
  expect(new Set(h1.captures.map((c) => c.bin))).toEqual(new Set(h1.filled));
  for (const b of ["top", ...Array.from({ length: 12 }, (_, k) => `low-${k}`)]) expect(h1.filled).toContain(b);
  expect(h1.captures.every((c) => c.markers >= 4)).toBe(true);
  await expect(page.getByTestId("build")).toBeEnabled();
  await expect(page.getByTestId("capture-thumb")).toHaveCount(h1.captures.length);
  // the live flatness check ran on the captured views (SIMULATED flat board)
  await page.waitForFunction(() => (window.__RECON__ as { validation?: { liveFlatness?: { views?: number } | null } } | undefined)?.validation?.liveFlatness != null, null, { timeout: 60_000 });
  const lf = (await hook(page)).validation.liveFlatness!;
  console.log(`[recon e2e run ${run}] SIMULATED live flatness: ${lf.verdict}, median ${lf.median?.toFixed(2)} px, worst ${lf.worst?.toFixed(2)} px over ${lf.views} views`);
  expect(["pass", "warn", "fail", "not_checked"]).toContain(lf.verdict);
  await expect(page.getByTestId("live-flatness")).toBeVisible();
  await shot(page, "03-all-views-desktop-1280", { width: 1280, height: 800 });
  await shot(page, "03-all-views-phone-390", { width: 390, height: 844 });

  // ---- reconstruction in the worker
  await page.getByTestId("build").click();
  await expect(page.getByTestId("building")).toBeVisible();
  await expect(page.getByTestId("video")).toHaveJSProperty("srcObject", null); // the camera is off while it works
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "04-building-phone-390", { width: 390, height: 844 }, false);
  await page.waitForFunction(() => (window.__RECON__ as { phase?: string } | undefined)?.phase === "result", null, { timeout: 420_000, polling: 1000 });
  const h2 = await hook(page);
  const r = h2.result;
  expect(h2.buildError, "the worker must not fail").toBeNull();
  expect(r).not.toBeNull();
  const m = r!.measurements;
  const T = META.truth;
  const err = (k: string, t: number) => (m?.[k]?.value == null ? `n/a (${m?.[k]?.basis ?? "none"})` : `${(m[k].value! - t >= 0 ? "+" : "")}${(m[k].value! - t).toFixed(1)} (${m[k].basis})`);
  console.log(
    [
      `[recon e2e run ${run}] SIMULATED result: refused ${r!.refused}; calibration ${r!.calibration?.method} fx ${r!.calibration?.fx.toFixed(1)} (true ${META.trueIntrinsics.fx.toFixed(1)}, error ${r!.calibration ? (((r!.calibration.fx - META.trueIntrinsics.fx) / META.trueIntrinsics.fx) * 100).toFixed(2) : "?"} %), rms ${r!.calibration?.rmsPx?.toFixed(2)} px; views with pose ${r!.viewsWithPose}/${h2.captures.length}`,
      `  MediaPipe landmarks found in ${r!.landmarkViews}/${h2.captures.length} views; hand frame ${r!.handFrame}; accepted ${r!.accepted} [${r!.reasons.join(", ")}]; mesh ${r!.hasMesh} (${r!.triangles} triangles)`,
      `  vs the synthetic hand (mm): length ${err("handLength", T.handLength)}, breadth ${err("palmBreadth", T.palmBreadth)}, thickness ${err("palmThickness", T.palmThickness)}, knuckle circ ${err("circumferenceKnuckle", T.circumference)}`,
      `  coin check ${JSON.stringify(r!.coin)}`,
      `  support share ${JSON.stringify(r!.supportShare)}`,
      `  timings detect ${(r!.timings.detect / 1000).toFixed(1)} s, calibrate ${r!.timings.calibrate.toFixed(0)} ms, pose ${r!.timings.pose.toFixed(0)} ms, reconstruct ${(r!.timings.reconstruct / 1000).toFixed(1)} s, whole build ${((r!.wallMs ?? 0) / 1000).toFixed(1)} s; JS heap ${JSON.stringify(r!.heap)}`,
    ].join("\n"),
  );

  // ---- honest result, whichever way it went
  const verdict = page.getByTestId("recon-verdict");
  await expect(verdict).toBeVisible();
  if (r!.refused) {
    await expect(verdict).toHaveAttribute("data-kind", "refused");
    await expect(page.locator(".mv-root, [data-testid='recon-measurements']")).toHaveCount(0);
  } else {
    expect(r!.calibration?.method).toBe("zhang");
    expect(r!.hasMesh).toBe(true);
    await expect(page.getByText(/^EXPERIMENTAL: a visual-hull reconstruction from \d+ photos\. The palm side rests on the board and is not observed\. Not validated against physical measurements\.$/).first()).toBeVisible();
    await expect(page.locator(".rc-viewer canvas").first()).toBeVisible({ timeout: 60_000 });
    const table = page.getByTestId("recon-measurements");
    await expect(table.locator("tbody tr")).toHaveCount(10);
    for (const row of await table.locator("tbody tr").all()) {
      const value = (await row.locator("td").first().locator(".rc-value").textContent())!.trim();
      const basis = (await row.locator("td").nth(1).textContent())!.trim();
      if ((await row.getAttribute("data-shown")) === "1") {
        expect(value).toMatch(/^[\d,]+(\.\d)? mm²?$/);
        expect(basis).toMatch(/^(direct|model): /);
      } else {
        expect(value).toMatch(/^(not available|withheld)$/);
        expect(value).not.toMatch(/\d/);
      }
    }
    if (r!.landmarkViews < 2 && r!.reasons.includes("hand_frame_from_one_view")) {
      // MediaPipe found the hand in one view looking down only: the hand frame is lifted from that view onto the mesh,
      // said in words, and the values it gives are model estimates, never "direct" for a length.
      expect(r!.handFrame).toBe(true);
      await expect(page.getByTestId("recon-reasons")).toContainText("only one picture looking down");
      const length = table.locator("tbody tr").first();
      if ((await length.getAttribute("data-shown")) === "1") await expect(length.locator("td").nth(1)).toHaveText(/^model: /);
    } else if (r!.landmarkViews < 2) {
      // No landmarks usable at all: no hand frame, so every measurement must be "not available", and the reason named.
      expect(r!.handFrame).toBe(false);
      expect(r!.reasons).toContain("no_hand_frame");
      await expect(page.getByTestId("recon-reasons")).toContainText("MediaPipe did not find the hand");
      for (const td of await table.locator("tbody td:first-of-type").all()) await expect(td).toHaveText("not available");
    }
    // a board capture: no hand surface area, said in the table; a knuckle circumference only as an upper bound
    const area = table.locator('tr[data-key="surfaceArea"]');
    await expect(area).toHaveAttribute("data-shown", "0");
    await expect(area).toContainText("Not available from a board capture");
    const circ = table.locator('tr[data-key="circumferenceKnuckle"]');
    if ((await circ.getAttribute("data-shown")) === "1") {
      await expect(circ.locator(".rc-bound")).toHaveText("upper bound");
      await expect(circ).toContainText("UPPER BOUND");
    }
    const reasons = page.getByTestId("recon-reasons");
    if (r!.reasons.length) await expect(reasons.locator("li")).toHaveCount(r!.reasons.length);
    if (r!.reasons.length) expect(await reasons.textContent()).not.toMatch(/[a-z]_[a-z]/);
  }
  await expect(page.getByTestId("calibration")).toBeVisible();
  await expect(page.getByTestId("view-table").locator("tbody tr")).toHaveCount(h2.captures.length);
  await expect(page.getByTestId("coin-check")).toBeVisible();
  // the board check after the build: the flatness from the pictures, and the validity in words
  const hv = (await hook(page)).validation;
  console.log(`[recon e2e run ${run}] SIMULATED flatness after the build: ${JSON.stringify(hv.flatness)}; valid for validation ${hv.valid?.valid} [${hv.valid?.reasons.join(" | ")}]`);
  await expect(page.getByTestId("board-check-result")).toBeVisible();
  await expect(page.getByTestId("result-ruler")).toContainText("Pass");
  await expect(page.getByTestId("validity")).toHaveAttribute("data-valid", hv.valid?.valid ? "1" : "0");
  if (hv.flatness) await expect(page.getByTestId("flatness")).toHaveAttribute("data-verdict", hv.flatness.verdict);
  if (hv.valid && !hv.valid.valid) await expect(page.getByTestId("not-valid-warning")).toBeVisible();
  await page.waitForTimeout(1500); // let the 3D view draw
  await shot(page, "05-result-phone-390", { width: 390, height: 844 });
  await shot(page, "05-result-phone-360", { width: 360, height: 740 });
  await shot(page, "05-result-desktop-1280", { width: 1280, height: 800 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".rc-viewer-card").screenshot({ path: resolve(SHOTS, "06-viewer-phone-390.png") }).catch(() => undefined);

  // ---- export: photos are off by default
  await expect(page.getByTestId("include-photos")).not.toBeChecked();
  const [zipDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-zip").click()]);
  const zip = readZip(new Uint8Array(readFileSync((await zipDl.path())!)));
  const names = zip.map((e) => e.name);
  expect(names.some((n) => n.startsWith("photos/"))).toBe(false);
  expect(names).toEqual(r!.hasMesh ? ["README.txt", "reconstruction.json", "mesh.ply", "points.csv", "device.json"] : ["README.txt", "reconstruction.json", "device.json"]);
  const json = JSON.parse(new TextDecoder().decode(zip.find((e) => e.name === "reconstruction.json")!.data));
  expect(json.experimental).toBe(true);
  expect(json.photos_included).toBe(false);
  expect(json.views).toHaveLength(h2.captures.length);
  expect(json.coin_entry_from_config.id).toBe(h0.coin!.id);
  expect(json.coin_entry_from_config.diameter_mm).toBe(h0.coin!.diameter_mm);
  if (r!.hasMesh) expect(new TextDecoder().decode(zip.find((e) => e.name === "mesh.ply")!.data.subarray(0, 1000))).toContain("property uchar support");
  await expect(page.getByTestId("export-info")).toContainText("without photos");

  // ---- the validation fields (structure and plausibility; the values are this SIMULATED run's)
  expect(json.validation_mode).toBe(true);
  expect(json.run).toEqual({ phantom_id: "PH-SIM01", session_id: "S-SIM", capture_index: 1, operator_code: "OP01", conditions: ["baseline"], notes: "SIMULATED fake camera (e2e)" });
  expect(json.board_check.ruler).toMatchObject({ square_x_mm: E.square_mm, square_y_mm: E.square_mm, long_span_mm: E.long_span_mm, short_span_mm: E.short_span_mm, expected: E, verdict: "pass" });
  expect(json.board_check.ruler.reasons.length).toBeGreaterThan(0);
  const fl = json.board_check.flatness;
  expect(["pass", "warn", "fail", "not_checked"]).toContain(fl.verdict);
  expect(fl.verdict).toBe(hv.flatness!.verdict);
  expect(fl.reasons.length).toBeGreaterThan(0);
  for (const k of ["worst_marker_rms_px", "median_marker_rms_px", "edge_vs_centre_ratio"]) expect(k in fl).toBe(true);
  if (fl.verdict !== "not_checked") {
    expect(fl.median_marker_rms_px).toBeGreaterThan(0);
    expect(fl.worst_marker_rms_px).toBeGreaterThanOrEqual(fl.median_marker_rms_px);
    expect(fl.worst_marker_rms_px).toBeLessThan(50);
  }
  expect(json.board_check.coin).toEqual(json.coin_print_scale_check);
  expect(typeof json.board_check.valid_for_validation).toBe("boolean");
  expect(json.board_check.valid_for_validation).toBe(hv.valid!.valid);
  const posed = json.views.filter((v: { camera: { pose: unknown } | null }) => v.camera?.pose);
  expect(posed.length).toBeGreaterThan(0);
  for (const v of posed) {
    expect(v.marker_residuals.length).toBeGreaterThan(0);
    for (const m of v.marker_residuals) {
      expect(Number.isInteger(m.id)).toBe(true);
      expect(m.rms_px).toBeGreaterThanOrEqual(0);
      expect(m.rms_px).toBeLessThan(100);
    }
  }
  if (r!.handFrame) {
    expect(["triangulated", "one_view"]).toContain(json.hand_frame.source);
    expect(json.hand_frame.source).toBe(r!.reasons.includes("hand_frame_from_one_view") ? "one_view" : "triangulated");
    for (const k of ["origin", "axis_x", "axis_y", "axis_z"]) expect(json.hand_frame[k]).toHaveLength(3);
    // origin on the board (board millimetres), unit axes
    expect(json.hand_frame.origin[0]).toBeGreaterThan(-50);
    expect(json.hand_frame.origin[0]).toBeLessThan(350);
    for (const k of ["axis_x", "axis_y", "axis_z"]) expect(Math.hypot(...(json.hand_frame[k] as number[]))).toBeCloseTo(1, 2);
    for (const f of json.finger_axes) {
      expect(["thumb", "index", "middle", "ring", "little"]).toContain(f.name);
      expect(f.base).toHaveLength(3);
      expect(Math.hypot(...(f.dir as number[]))).toBeCloseTo(1, 2);
    }
  } else {
    expect(json.hand_frame.source).toBeNull();
    expect(json.finger_axes).toEqual([]);
  }
  const dev = JSON.parse(new TextDecoder().decode(zip.find((e) => e.name === "device.json")!.data));
  expect(Object.keys(dev)).toEqual(["user_agent", "screen", "device_memory_gb", "hardware_concurrency", "camera", "capture_ms", "build_ms", "export_ms", "heap_samples_mb", "peak_heap_mb", "errors", "webgl_context_lost", "export_ok", "started_at", "finished_at"]);
  expect(dev.user_agent).toContain("Chrome");
  expect(dev.screen.width).toBeGreaterThan(0);
  expect(dev.screen.device_pixel_ratio).toBeGreaterThan(0);
  expect(dev.hardware_concurrency).toBeGreaterThan(0);
  expect(dev.camera.width).toBe(h2.captures[0].width);
  expect(dev.camera.height).toBe(h2.captures[0].height);
  expect(JSON.stringify(dev.camera.settings ?? {})).not.toMatch(/deviceId|groupId/);
  expect(dev.capture_ms).toBeGreaterThan(1000);
  expect(dev.build_ms).toBeGreaterThan(0);
  expect(Math.abs(dev.build_ms - (r!.wallMs ?? 0))).toBeLessThan(5);
  expect(dev.export_ms).toBeGreaterThanOrEqual(0);
  expect(dev.export_ok).toBe(true);
  expect(dev.heap_samples_mb === null || dev.heap_samples_mb.length > 1).toBe(true);
  if (dev.heap_samples_mb) expect(dev.peak_heap_mb).toBe(Math.max(...dev.heap_samples_mb));
  expect(Array.isArray(dev.errors)).toBe(true);
  for (const e of dev.errors) expect(e).not.toMatch(/[A-Za-z]:\\|https?:\/\//);
  expect(dev.webgl_context_lost).toBeGreaterThanOrEqual(0);
  expect(Date.parse(dev.finished_at)).toBeGreaterThanOrEqual(Date.parse(dev.started_at));
  console.log(`[recon e2e run ${run}] device.json: capture ${dev.capture_ms} ms, build ${dev.build_ms} ms, export ${dev.export_ms} ms, heap samples ${dev.heap_samples_mb?.length ?? "n/a"}, peak ${dev.peak_heap_mb} MB, errors ${JSON.stringify(dev.errors)}, webgl lost ${dev.webgl_context_lost}, cores ${dev.hardware_concurrency}, memory ${dev.device_memory_gb}`);
  // the capture index went up for the next capture (in memory)
  expect((await hook(page)).validation.captureIndex).toBe(2);
  await expect(page.getByTestId("device-log")).toBeVisible();
  await page.getByTestId("debug").scrollIntoViewIfNeeded();
  await shot(page, "07-result-debug-phone-390", { width: 390, height: 844 });

  // ---- privacy: nothing but GET /api/config (and the page's own static files); nothing stored
  const origin = new URL(page.url()).origin;
  expect(findUploadViolations(requests, origin)).toEqual([]);
  const api = requests.filter((q) => new URL(q.url).pathname.startsWith("/api/"));
  expect(api.length).toBeGreaterThan(0);
  expect(api.every((q) => q.method === "GET" && new URL(q.url).pathname === "/api/config")).toBe(true);
  expect(requests.every((q) => q.url.startsWith(origin) || q.url.startsWith("data:") || q.url.startsWith("blob:"))).toBe(true);
  expect(await browserStorage(page)).toEqual({ localStorage: 0, sessionStorage: 0, indexedDB: [], cacheStorage: [], serviceWorkers: 0 });
  expect(problems).toEqual([]);
});
