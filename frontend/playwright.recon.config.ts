// Browser test of the EXPERIMENTAL board-capture page (frontend/experiment/recon/, src/experimental/recon/page/), kept apart
// from the main suite: a dev-only page served by its own Vite dev server, not part of the production build. Run with:
//   npx playwright test -c playwright.recon.config.ts
// The fake camera plays a SIMULATED orbit round the synthetic hand on the printed board (e2e/recon-media.ts, made once by the
// globalSetup into e2e/.media, gitignored; about 2 to 4 minutes the first time). The backend is the existing one, only for
// GET /api/config (the page's single API request). Own ports (5231, 8831), so it runs beside the other configs' servers.
// Screenshots land in test-results/recon/ (gitignored) to be looked at.
import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const python =
  process.env.GLOVESIZE_PYTHON ??
  resolve(__dirname, process.platform === "win32" ? "../backend/.venv/Scripts/python.exe" : "../backend/.venv/bin/python");

const API_PORT = 8831;
const PAGE_PORT = 5231;
const VIDEO = resolve(__dirname, "e2e/.media/recon-orbit.y4m");

export default defineConfig({
  testDir: "e2e",
  testMatch: /experiment-recon\.spec\.ts/,
  globalSetup: "./e2e/recon-media.ts",
  timeout: 600_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/recon-artifacts",
  use: {
    channel: process.env.E2E_CHANNEL ?? "chrome",
    headless: true,
    permissions: ["camera"],
    acceptDownloads: true,
    screenshot: "only-on-failure",
    baseURL: `http://127.0.0.1:${PAGE_PORT}`,
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-video-capture=${VIDEO}`,
        // WebGL in headless Chrome: allow the software renderer when there is no usable GPU.
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
    },
  },
  webServer: [
    {
      command: `"${python}" -m uvicorn glovesize.api:app --host 127.0.0.1 --port ${API_PORT}`,
      cwd: resolve(__dirname, "../backend"),
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite --config vite.recon.config.ts --port ${PAGE_PORT} --strictPort --host 127.0.0.1`,
      cwd: __dirname,
      url: `http://127.0.0.1:${PAGE_PORT}/experiment/recon/`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { GLOVESIZE_API_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
