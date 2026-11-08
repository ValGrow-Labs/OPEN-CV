// Fake-camera video for the browser test of the EXPERIMENTAL board-capture page (e2e/experiment-recon.spec.ts): a SIMULATED
// orbit round the synthetic capsule hand resting on the printed board (multiview/scene.ts), as a phone held by a person
// would move: straight above first, then a low ring all round (12 degrees above the board; 15 degrees beside the open
// left edge, where a lower phone sees too few markers), holding still at the middle of each of the 12 sectors with two
// in-between frames per move. 1280 x 720, 5 frames per second, an unknown-to-the-page focal length (64 degrees across)
// and lens distortion (k1 -0.06, k2 0.02), as recon/chain.test.ts. Written as YUV4MPEG2 (4:2:0) for Chrome's
// --use-file-for-fake-video-capture, under e2e/.media (gitignored), once; delete the file to make it again.
//
// Used as the Playwright globalSetup of playwright.recon.config.ts; also runnable on its own:
//   RECON_MEDIA_RUN=1 npx vite-node e2e/recon-media.ts      (PowerShell: $env:RECON_MEDIA_RUN = "1"; npx vite-node e2e/recon-media.ts)
// SIMULATED renders, not photos: they say nothing about real phones, prints, light or hands.
import { closeSync, existsSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BOARD } from "../src/experimental/board/spec";
import { makeBoardScene, renderView, SKIN_TONES } from "../src/experimental/multiview/scene";
import { lookAtPose, type Vec3 } from "../src/experimental/reconstruction/linalg";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
export const RECON_MEDIA = resolve(__dirname, ".media");
export const RECON_VIDEO = resolve(RECON_MEDIA, "recon-orbit.y4m");
export const RECON_META = resolve(RECON_MEDIA, "recon-orbit.json");

const W = 1280, H = 720, FPS = 5, HOLD = 7, BETWEEN = 2;
const HFOV = 64;

interface Station {
  name: string;
  elevationDeg: number;
  azimuthDeg: number;
}

function eyeOf(target: Vec3, s: Station, distanceMm: number, topHeightMm: number): Vec3 {
  if (s.elevationDeg >= 89.9) return [target[0], target[1], topHeightMm];
  const e = (s.elevationDeg * Math.PI) / 180, a = (s.azimuthDeg * Math.PI) / 180;
  return [target[0] + distanceMm * Math.cos(e) * Math.cos(a), target[1] + distanceMm * Math.cos(e) * Math.sin(a), target[2] + distanceMm * Math.sin(e)];
}

/** RGBA to I420 (BT.601, as OpenCV's COLOR_RGB2YUV_I420 that the other fake videos of this repo use). */
function toI420(rgba: Uint8ClampedArray, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 1.5);
  const Y = out.subarray(0, w * h), U = out.subarray(w * h, w * h * 1.25), V = out.subarray(w * h * 1.25);
  for (let i = 0; i < w * h; i++) Y[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
  for (let y = 0; y < h / 2; y++)
    for (let x = 0; x < w / 2; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const o = ((2 * y + dy) * w + 2 * x + dx) * 4;
          r += rgba[o];
          g += rgba[o + 1];
          b += rgba[o + 2];
        }
      r /= 4;
      g /= 4;
      b /= 4;
      const yy = 0.299 * r + 0.587 * g + 0.114 * b;
      U[y * (w / 2) + x] = Math.max(0, Math.min(255, Math.round((b - yy) * 0.564 + 128)));
      V[y * (w / 2) + x] = Math.max(0, Math.min(255, Math.round((r - yy) * 0.713 + 128)));
    }
  return out;
}

export default async function makeReconMedia(): Promise<void> {
  if (existsSync(RECON_VIDEO) && existsSync(RECON_META)) return;
  mkdirSync(RECON_MEDIA, { recursive: true });
  const t0 = Date.now();
  // The coin: 23 mm across (the served settings' 2019 2-rupee coin, which the page prefers) and 1.5 mm thick (an assumed
  // thickness for the simulation; the settings give none).
  const scene = makeBoardScene({ coin: { diameterMm: 23, thicknessMm: 1.5 } });
  const f = W / 2 / Math.tan((HFOV * Math.PI) / 360);
  const K = { fx: f, fy: f, cx: W / 2, cy: H / 2, width: W, height: H, k1: -0.06, k2: 0.02 };
  const a = BOARD.handArea;
  const target: Vec3 = [(a.minX + a.maxX) / 2, (a.minY + a.maxY) / 2, 10]; // the azimuths the page shows are about this point
  const lowElev = (az: number) => (az === 165 || az === 195 ? 15 : 12);
  const low: Station[] = Array.from({ length: 12 }, (_, k) => ({ name: `low-${15 + 30 * k}`, elevationDeg: lowElev(15 + 30 * k), azimuthDeg: 15 + 30 * k }));
  const top: Station = { name: "top", elevationDeg: 90, azimuthDeg: 15 };
  // the path: hold above, come down at 15 degrees azimuth, hold at each sector's middle, two frames between, back up
  const frames: { station: Station; hold: boolean }[] = [];
  const hold = (s: Station) => {
    for (let i = 0; i < HOLD; i++) frames.push({ station: s, hold: true });
  };
  const between = (from: Station, to: Station) => {
    for (let i = 1; i <= BETWEEN; i++) {
      const t = i / (BETWEEN + 1);
      frames.push({ station: { name: `${from.name}>${to.name}`, elevationDeg: from.elevationDeg + t * (to.elevationDeg - from.elevationDeg), azimuthDeg: from.azimuthDeg + t * (to.azimuthDeg - from.azimuthDeg) }, hold: false });
    }
  };
  hold(top);
  between({ ...top, elevationDeg: 80 }, low[0]);
  low.forEach((s, k) => {
    hold(s);
    if (k < low.length - 1) between(s, low[k + 1]);
  });
  between(low[low.length - 1], { ...top, elevationDeg: 80, azimuthDeg: low[low.length - 1].azimuthDeg });

  const tmp = `${RECON_VIDEO}.part`;
  const fd = openSync(tmp, "w");
  writeSync(fd, Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`, "latin1"));
  let last: { key: string; yuv: Buffer } | null = null;
  let renders = 0;
  for (const fr of frames) {
    const s = fr.station;
    const key = `${s.elevationDeg.toFixed(3)}/${s.azimuthDeg.toFixed(3)}`;
    if (!last || last.key !== key) {
      const eye = eyeOf(target, s, 340, 400);
      const pose = lookAtPose(eye, target, s.elevationDeg >= 89.9 ? [0, 1, 0] : [0, 0, 1]);
      const img = renderView(scene, K, pose, { skin: SKIN_TONES.medium, seed: 7 }).image;
      last = { key, yuv: toI420(img.data, W, H) };
      renders++;
    }
    writeSync(fd, Buffer.from("FRAME\n", "latin1"));
    writeSync(fd, last.yuv);
  }
  closeSync(fd);
  renameSync(tmp, RECON_VIDEO);
  writeFileSync(
    RECON_META,
    JSON.stringify(
      {
        simulated: true,
        width: W,
        height: H,
        fps: FPS,
        frames: frames.length,
        loopSeconds: frames.length / FPS,
        trueIntrinsics: K,
        stations: [top, ...low],
        renders,
        secondsToMake: (Date.now() - t0) / 1000,
        truth: scene.truth,
        coin: { diameterMm: 23, thicknessMm: 1.5 },
      },
      null,
      2,
    ),
  );
  console.log(`[recon-media] wrote ${RECON_VIDEO}: ${frames.length} frames (${renders} renders) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

if (process.env.RECON_MEDIA_RUN === "1") void makeReconMedia();
