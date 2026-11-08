// Browser test of the EXPERIMENTAL 3D viewer demo (frontend/experiment/viewer/, src/experimental/reconstruction/viewerDemo/),
// kept apart from the main suite: a dev-only page served by its own Vite dev server, not part of the production build. No
// backend and no camera are needed. Run with:
//   npx playwright test -c playwright.viewer.config.ts
// Screenshots of every mode and preset land in test-results/viewer/ (gitignored) to be looked at.
import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PAGE_PORT = 5207;

export default defineConfig({
  testDir: "e2e",
  testMatch: /experiment-viewer\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/viewer-artifacts",
  use: {
    channel: process.env.E2E_CHANNEL ?? "chrome",
    headless: true,
    screenshot: "only-on-failure",
    baseURL: `http://127.0.0.1:${PAGE_PORT}`,
    // WebGL in headless Chrome: allow the software renderer when there is no usable GPU.
    launchOptions: { args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
  },
  webServer: [
    {
      command: `npx vite --config vite.viewer.config.ts --port ${PAGE_PORT} --strictPort --host 127.0.0.1`,
      cwd: __dirname,
      url: `http://127.0.0.1:${PAGE_PORT}/experiment/viewer/`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
