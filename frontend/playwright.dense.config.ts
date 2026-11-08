// Browser tests of the EXPERIMENTAL dense-scan page (frontend/experiment/dense/, src/experimental/densescan/page/), kept apart
// from the main suite: it is a dev-only page served by the Vite dev server, not part of the production build. Run with:
//   npx playwright test -c playwright.dense.config.ts
// (after `node e2e/prepare.mjs` has made the fake-camera video and the relaxed config copy).
//
// Two fake cameras, as two projects:
//   landscape: e2e/.media/hand.y4m, the sample hand photo as a 1280 x 720 video (a laptop webcam, a phone held sideways);
//   portrait:  the same video turned 90 degrees clockwise into 720 x 1280 (a phone held upright gives a portrait stream).
//              Made here from hand.y4m on first use (e2e/.media is gitignored); the hand then points sideways.
// The backend is the existing one, only for GET /api/config (the page's single API request). Own ports, so it can run
// beside the other configs' servers.
import { defineConfig } from "@playwright/test";
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MEDIA = resolve(__dirname, "e2e/.media");
const python =
  process.env.GLOVESIZE_PYTHON ??
  resolve(__dirname, process.platform === "win32" ? "../backend/.venv/Scripts/python.exe" : "../backend/.venv/bin/python");

const API_PORT = 8786;
const PAGE_PORT = 5198;

const LANDSCAPE = resolve(MEDIA, "hand.y4m");
const PORTRAIT = resolve(MEDIA, "dense_portrait_cw90.y4m");

/** Turn a 4:2:0 YUV4MPEG2 video 90 degrees clockwise (each of the Y, U and V planes), frame by frame. */
function rotateY4mClockwise(src: string, dst: string): void {
  const buf = readFileSync(src);
  const headerEnd = buf.indexOf(0x0a);
  const header = buf.subarray(0, headerEnd).toString("latin1");
  const W = Number(/ W(\d+)/.exec(header)?.[1]);
  const H = Number(/ H(\d+)/.exec(header)?.[1]);
  if (!(W > 0 && H > 0) || !/ C420/.test(header)) throw new Error(`unsupported y4m header: ${header}`);
  const outHeader = header.replace(/ W\d+/, ` W${H}`).replace(/ H\d+/, ` H${W}`) + "\n";
  const tmp = `${dst}.part`;
  const fd = openSync(tmp, "w");
  writeSync(fd, Buffer.from(outHeader, "latin1"));
  const rotPlane = (plane: Buffer, w: number, h: number): Buffer => {
    // new width = h, new height = w; dst(x', y') = src(x = y', y = h - 1 - x')
    const out = Buffer.allocUnsafe(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const xd = h - 1 - y;
      for (let x = 0; x < w; x++) out[x * h + xd] = plane[row + x];
    }
    return out;
  };
  const cw = W / 2;
  const ch = H / 2;
  let at = headerEnd + 1;
  while (at < buf.length) {
    const lineEnd = buf.indexOf(0x0a, at);
    if (lineEnd < 0) break;
    writeSync(fd, buf.subarray(at, lineEnd + 1)); // "FRAME" line
    at = lineEnd + 1;
    const y = buf.subarray(at, at + W * H);
    const u = buf.subarray(at + W * H, at + W * H + cw * ch);
    const v = buf.subarray(at + W * H + cw * ch, at + W * H + 2 * cw * ch);
    at += W * H + 2 * cw * ch;
    writeSync(fd, rotPlane(y, W, H));
    writeSync(fd, rotPlane(u, cw, ch));
    writeSync(fd, rotPlane(v, cw, ch));
  }
  closeSync(fd);
  renameSync(tmp, dst);
}

if (existsSync(LANDSCAPE) && !existsSync(PORTRAIT)) rotateY4mClockwise(LANDSCAPE, PORTRAIT);

const camera = (file: string) => ({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${file}`],
});

export default defineConfig({
  testDir: "e2e",
  testMatch: /experiment-dense\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 90_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    channel: process.env.E2E_CHANNEL ?? "chrome",
    headless: true,
    permissions: ["camera"],
    acceptDownloads: true,
    screenshot: "only-on-failure",
    baseURL: `http://127.0.0.1:${PAGE_PORT}`,
  },
  projects: [
    { name: "landscape", use: { launchOptions: camera(LANDSCAPE) } },
    { name: "portrait", use: { launchOptions: camera(PORTRAIT) } },
  ],
  webServer: [
    {
      command: `"${python}" -m uvicorn glovesize.api:app --host 127.0.0.1 --port ${API_PORT}`,
      cwd: resolve(__dirname, "../backend"),
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { GLOVESIZE_DEFAULT_CHART: "demo-length-v1", GLOVESIZE_CONFIG_DIR: resolve(MEDIA, "config-relaxed") },
    },
    {
      // `vite optimize` first, so Vite never re-optimises dependencies (and reloads the page) while a test runs.
      command: `npx vite optimize && npx vite --port ${PAGE_PORT} --strictPort --host 127.0.0.1`,
      cwd: __dirname,
      url: `http://127.0.0.1:${PAGE_PORT}/experiment/dense/`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { GLOVESIZE_API_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
