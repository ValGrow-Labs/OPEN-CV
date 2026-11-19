// REAL photos, REAL MediaPipe landmarks, NO ground truth: where the outline fingertip lies on the repository's two
// flat-hand photos (frontend/e2e/.media/hand.png, hand_portrait.png; git-ignored). Opt-in: set FINGERTIP_REAL_DIR to a
// folder written by `python -m scripts.finger_real_photo_probe --dump-landmarks DIR` (landmarks + the photos).
// It writes DIR/<photo>_tips.json (for the overlay: `--overlay DIR`) and prints the table quoted in
// docs/FINGER_ACCURACY_AUDIT.md. The only sanity checks are the sign and the size of the extension: positive, a few mm.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodePng } from "../experimental/segmentation/pngNode";
import { measureTip } from "./fingertip";

const DIR = process.env.FINGERTIP_REAL_DIR;
const FINGERS = [
  { name: "thumb", chain: [2, 3, 4] },
  { name: "index", chain: [5, 6, 7, 8] },
  { name: "middle", chain: [9, 10, 11, 12] },
  { name: "ring", chain: [13, 14, 15, 16] },
  { name: "little", chain: [17, 18, 19, 20] },
];

describe.skipIf(!DIR)("outline fingertip on the two real photos (no ground truth)", () => {
  it("prints the extension per finger", () => {
    const lines = ["| photo | finger | distal landmark segment mm | outline found | extension px | extension mm | chain mm before | chain mm after | reason |", "|---|---|---|---|---|---|---|---|---|"];
    const exts: number[] = [];
    for (const photo of ["hand", "hand_portrait"]) {
      const meta = JSON.parse(readFileSync(`${DIR}/${photo}.json`, "utf-8")) as { width: number; height: number; landmarks: [number, number][]; px_per_mm_coin: number };
      const png = decodePng(new Uint8Array(readFileSync(`${DIR}/${photo}.png`)));
      const lm = meta.landmarks.map(([x, y]) => ({ x, y }));
      const ppm = meta.px_per_mm_coin;
      const out: unknown[] = [];
      for (const { name, chain } of FINGERS) {
        const T = lm[chain[chain.length - 1]];
        const D = lm[chain[chain.length - 2]];
        const L = Math.hypot(T.x - D.x, T.y - D.y);
        const half = Math.ceil(1.5 * L) + 8; // the crop the phone cuts (scan/tipCapture.ts)
        const x0 = Math.max(0, Math.round(T.x - half));
        const y0 = Math.max(0, Math.round(T.y - half));
        const x1 = Math.min(png.width, Math.round(T.x + half));
        const y1 = Math.min(png.height, Math.round(T.y + half));
        const w = x1 - x0;
        const h = y1 - y0;
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) data[(y * w + x) * 4 + c] = png.data[((y0 + y) * png.width + x0 + x) * 4 + c];
        const est = measureTip({ data, width: w, height: h }, { x: D.x - x0, y: D.y - y0 }, { x: T.x - x0, y: T.y - y0 }, 0.5);
        const chainPx = chain.slice(1).reduce((s, k, i) => s + Math.hypot(lm[k].x - lm[chain[i]].x, lm[k].y - lm[chain[i]].y), 0);
        const extMm = est.extensionPx / ppm;
        const refined = { x: T.x + ((T.x - D.x) / L) * est.extensionPx, y: T.y + ((T.y - D.y) / L) * est.extensionPx };
        lines.push(`| ${photo} | ${name} | ${(L / ppm).toFixed(1)} | ${est.ok ? "yes" : "no"} | ${est.extensionPx.toFixed(1)} | ${est.ok ? extMm.toFixed(1) : "-"} | ${(chainPx / ppm).toFixed(1)} | ${est.ok ? (chainPx / ppm + extMm).toFixed(1) : (chainPx / ppm).toFixed(1)} | ${est.ok ? "" : est.reason} |`);
        if (est.ok) exts.push(extMm);
        out.push({ name, tip: [T.x, T.y], refined: [refined.x, refined.y], ok: est.ok, reason: est.reason, ext_mm: extMm, ext_px: est.extensionPx });
      }
      writeFileSync(`${DIR}/${photo}_tips.json`, JSON.stringify({ fingers: out }));
    }
    console.log(`\nREAL photos, scale from each photo's drawn coin (px/mm), no ground truth:\n\n${lines.join("\n")}\n`);
    // sanity only: whatever is accepted is positive and within the cap (0.5 x a ~20 mm segment)
    for (const e of exts) {
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThan(13);
    }
  });
});
