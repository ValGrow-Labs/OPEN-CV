// Browser tests of the EXPERIMENTAL capture prototype (frontend/experiment/, src/experimental/capture/), kept apart from the main
// suite: the prototype is a dev-only page served by the Vite dev server, not part of the production build that playwright.config.ts
// tests. Run with:   npx playwright test -c playwright.experiment.config.ts
// (after `node e2e/prepare.mjs` has made the fake-camera video and the relaxed config copy; `npm run e2e` does that too).
//
// Chrome's fake camera plays the sample hand photo as a video (e2e/.media/hand.y4m). The backend is the existing one, only for
// GET /api/config (the page's single API request); validation and pilot modes stay off.
import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MEDIA = resolve(__dirname, "e2e/.media");
const python =
  process.env.GLOVESIZE_PYTHON ??
  resolve(__dirname, process.platform === "win32" ? "../backend/.venv/Scripts/python.exe" : "../backend/.venv/bin/python");

const API_PORT = 8776;
const PAGE_PORT = 5199;

export default defineConfig({
  testDir: "e2e",
  testMatch: /experiment-capture\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 90_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    channel: process.env.E2E_CHANNEL ?? "chrome",
    headless: true,
    permissions: ["camera"],
    screenshot: "only-on-failure",
    baseURL: `http://127.0.0.1:${PAGE_PORT}`,
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${resolve(MEDIA, "hand.y4m")}`],
    },
  },
  webServer: [
    {
      command: `"${python}" -m uvicorn glovesize.api:app --host 127.0.0.1 --port ${API_PORT}`,
      cwd: resolve(__dirname, "../backend"),
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      // The relaxed world-landmark gates for the sample hand photo (made by e2e/prepare.mjs), as in the main suite.
      env: { GLOVESIZE_DEFAULT_CHART: "demo-length-v1", GLOVESIZE_CONFIG_DIR: resolve(MEDIA, "config-relaxed") },
    },
    {
      // The Vite dev server: it serves /experiment/ and proxies /api to the backend above. `vite optimize` first pre-bundles the
      // dependencies to completion (a no-op when the cache is valid), so Vite never re-optimises them while a test is running:
      // that on-demand optimisation reloads the page and drops the captured views mid-test.
      command: `npx vite optimize && npx vite --port ${PAGE_PORT} --strictPort --host 127.0.0.1`,
      cwd: __dirname,
      url: `http://127.0.0.1:${PAGE_PORT}/experiment/`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { GLOVESIZE_API_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
