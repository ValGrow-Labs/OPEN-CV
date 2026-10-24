// The coin search only looks at the palm: a dark, colourless gap between two fingers looks like a
// coin to the detector (seen in a phone recording), so everything outside the palm is painted over.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import type { CoinDetectionParams, Point } from "../api/types";
import { detectCoin } from "./coinDetector";
import { runCoinJob } from "./coinJob";
import { liveScanParams } from "../test/fixtures";
import { maskOutsidePalm } from "./frameAnalysis";
import { initOpenCV, type CV } from "./opencv";

const params = JSON.parse(readFileSync(new URL("../../../config/measurement.json", import.meta.url), "utf-8"))
  .coin_detection as CoinDetectionParams;

const GROW = liveScanParams.palm_mask_grow ?? 1;
const SKIN = [196, 132, 100];
const W = 320;
const H = 320;
// Palm outline (wrist at the bottom, finger bases along the top edge at y ~ 110).
const PALM: Point[] = [
  [150, 290],
  [80, 250],
  [70, 170],
  [95, 112],
  [160, 106],
  [225, 112],
  [245, 200],
].map(([x, y]) => ({ x, y, z: 0 }));
const COIN = { x: 160, y: 190, d: 60, rgb: [150, 150, 152] };
// A shadowed gap between two fingers just above the palm: dark and colourless, about coin-sized.
const GAP = { x: 160, y: 66, d: 58, rgb: [70, 66, 66] };

/** Skin with mild noise and anti-aliased discs (4 x 4 supersampling). */
function scene(): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 6;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let rgb = SKIN.map(Number);
      for (const disc of [COIN, GAP]) {
        let cover = 0;
        for (let sy = 0; sy < 4; sy++)
          for (let sx = 0; sx < 4; sx++)
            if (Math.hypot(x + (sx + 0.5) / 4 - disc.x, y + (sy + 0.5) / 4 - disc.y) <= disc.d / 2) cover++;
        const a = cover / 16;
        rgb = rgb.map((v, k) => v * (1 - a) + disc.rgb[k] * a);
      }
      const i = (y * W + x) * 4;
      const n = rand();
      data[i] = rgb[0] + n;
      data[i + 1] = rgb[1] + n;
      data[i + 2] = rgb[2] + n;
      data[i + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCV(createRequire(import.meta.url)("@techstark/opencv-js"));
});

describe("coin search is limited to the palm", () => {
  it("paints outside the palm with the palm's colour and leaves the palm alone", () => {
    const img = scene();
    const before = img.data.slice();
    expect(maskOutsidePalm(img, PALM, GROW)).toBe(true);
    const at = (x: number, y: number) => Array.from(img.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3));
    const was = (x: number, y: number) => Array.from(before.slice((y * W + x) * 4, (y * W + x) * 4 + 3));
    expect(at(COIN.x, COIN.y)).toEqual(was(COIN.x, COIN.y)); // the coin is untouched
    expect(at(160, 200 + 30)).toEqual(was(160, 230)); // so is the palm
    const gap = at(GAP.x, GAP.y); // the finger gap now has a skin-like colour
    expect(gap[0] - gap[2]).toBeGreaterThan(40);
    expect(at(5, 5)).toEqual(gap);
  });

  it("without the mask the finger gap counts as a second coin and blocks the scan", () => {
    const det = detectCoin(cv, scene(), params, null, [40, 90]);
    expect(det.accepted).toBe(false);
    expect(det.reasons).toEqual(["coin_ambiguous"]);
  });

  it("finds the coin, not the finger gap", () => {
    const img = scene();
    maskOutsidePalm(img, PALM, GROW);
    const det = detectCoin(cv, img, params, null, [40, 90]);
    expect(det.accepted).toBe(true);
    expect(Math.hypot(det.center_x - COIN.x, det.center_y - COIN.y)).toBeLessThan(2);
    expect(Math.abs(det.major_axis_px - COIN.d) / COIN.d).toBeLessThan(0.03);
  });

  it("leaves the image alone when the palm barely overlaps the window", () => {
    const img = scene();
    const before = img.data.slice();
    const far = PALM.map((p) => ({ ...p, x: p.x + 1000 }));
    expect(maskOutsidePalm(img, far, GROW)).toBe(false);
    expect(Buffer.from(img.data).equals(Buffer.from(before))).toBe(true);
  });
});

describe("coin job (shared by the coin worker and the page)", () => {
  const job = (seed: { x: number; y: number; d: number } | null) => ({
    image: scene(),
    params,
    diameterRange: [40, 90] as [number, number],
    palm: PALM,
    palmGrow: GROW,
    seed: seed && { center_x: seed.x, center_y: seed.y, major_axis_px: seed.d, minor_axis_px: seed.d, angle_deg: 0 },
    trackMinConfidence: liveScanParams.track_min_confidence,
  });

  it("tracks the coin from its previous position", () => {
    const r = runCoinJob(cv, job({ x: COIN.x + 1.5, y: COIN.y - 1, d: COIN.d }));
    expect(r.tracked).toBe(true);
    expect(r.coin.accepted).toBe(true);
    expect(Math.hypot(r.coin.center_x - COIN.x, r.coin.center_y - COIN.y)).toBeLessThan(2);
  });

  it("searches the whole window when the tracker has drifted off the coin", () => {
    const r = runCoinJob(cv, job({ x: COIN.x - 45, y: COIN.y + 40, d: COIN.d }));
    expect(r.tracked).toBe(false);
    expect(r.coin.accepted).toBe(true);
    expect(Math.hypot(r.coin.center_x - COIN.x, r.coin.center_y - COIN.y)).toBeLessThan(2);
  });

  it("masks out the finger gap before searching", () => {
    const r = runCoinJob(cv, job(null));
    expect(r.tracked).toBe(false);
    expect(r.coin.accepted).toBe(true);
  });
});
