// REAL photos, REAL MediaPipe landmarks on perturbed copies (rotation +-5 deg, scale +-8%, noise), NO ground truth:
// how repeatable is the tip extension between scans of the same hand, with the first per-finger rule against the per-hand rule.
// Opt-in: FINGERTIP_PERT_DIR = a folder written by `python -m scripts.finger_real_photo_probe --dump-perturbed DIR --n 40`.
// A "scan" here is 4 random frames out of the 40 (what the phone keeps), measured and combined exactly as the phone does.
// The frames are copies of ONE photo, so frame-to-frame variation is understated; this is not a repeat-scan study on people.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodePng } from "../experimental/segmentation/pngNode";
import { rng } from "./fingerRender";
import { combineTipResults, measureTip, type TipEstimate } from "./fingertip";
import { planHandTips } from "./handTips";

const DIR = process.env.FINGERTIP_PERT_DIR;
const FINGERS = [
  { name: "thumb", dip: 3, tip: 4 },
  { name: "index", dip: 7, tip: 8 },
  { name: "middle", dip: 11, tip: 12 },
  { name: "ring", dip: 15, tip: 16 },
  { name: "little", dip: 19, tip: 20 },
];
const TIPS = FINGERS.map((f) => f.tip);
const sd = (v: number[]) => {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
};

describe.skipIf(!DIR)("tip extension repeatability on perturbed real photos (no ground truth)", () => {
  it("prints scan-to-scan SD of the extension per finger, per-finger rule vs per-hand rule", () => {
    const lines = ["| photo | rule | " + FINGERS.map((f) => f.name).join(" | ") + " |", "|---|---|" + FINGERS.map(() => "---").join("|") + "|"];
    const foundLines = ["| photo | " + FINGERS.map((f) => `${f.name} found`).join(" | ") + " | scans with < 2 found |", "|---|" + FINGERS.map(() => "---").join("|") + "|---|"];
    const rand = rng(5);
    const perFrameSd: string[] = [];
    for (const photo of ["hand", "hand_portrait"]) {
      const meta = JSON.parse(readFileSync(`${DIR}/${photo}_meta.json`, "utf-8")) as { n: number };
      type Frame = { est: Record<number, TipEstimate>; lmm: Record<number, number> };
      const frames: Frame[] = [];
      for (let i = 0; i < meta.n; i++) {
        const lm = (JSON.parse(readFileSync(`${DIR}/${photo}_${i}.json`, "utf-8")) as { landmarks: [number, number][] }).landmarks.map(([x, y]) => ({ x, y }));
        const png = decodePng(new Uint8Array(readFileSync(`${DIR}/${photo}_${i}.png`)));
        const ppm = Math.hypot(lm[12].x - lm[0].x, lm[12].y - lm[0].y) / 185; // ASSUMED 185 mm hand: only to express the extension in mm
        const f: Frame = { est: {}, lmm: {} };
        for (const { dip, tip } of FINGERS) {
          const T = lm[tip];
          const D = lm[dip];
          const L = Math.hypot(T.x - D.x, T.y - D.y);
          const half = Math.ceil(1.5 * L) + 8;
          const x0 = Math.max(0, Math.round(T.x - half));
          const y0 = Math.max(0, Math.round(T.y - half));
          const x1 = Math.min(png.width, Math.round(T.x + half));
          const y1 = Math.min(png.height, Math.round(T.y + half));
          const w = x1 - x0;
          const h = y1 - y0;
          const data = new Uint8ClampedArray(w * h * 4);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) data[(y * w + x) * 4 + c] = png.data[((y0 + y) * png.width + x0 + x) * 4 + c];
          f.est[tip] = measureTip({ data, width: w, height: h }, { x: D.x - x0, y: D.y - y0 }, { x: T.x - x0, y: T.y - y0 }, 0.5);
          f.lmm[tip] = L / ppm;
        }
        frames.push(f);
      }
      // frame-to-frame SD of the measured ratio itself (found crops only)
      perFrameSd.push(`${photo}: ` + FINGERS.map((fg) => `${fg.name} ${sd(frames.filter((f) => f.est[fg.tip].ok).map((f) => f.est[fg.tip].ratio)).toFixed(3)} (found ${frames.filter((f) => f.est[fg.tip].ok).length}/${frames.length})`).join(", "));

      const rules: Record<string, number[][]> = { landmark: TIPS.map(() => []), "per finger (first version)": TIPS.map(() => []), "per hand (prior 0.27)": TIPS.map(() => []), "per hand, no prior": TIPS.map(() => []) };
      let few = 0;
      const foundCount = TIPS.map(() => 0);
      const N = 400;
      for (let s = 0; s < N; s++) {
        const idx: number[] = [];
        while (idx.length < 4) {
          const k = Math.floor(rand() * frames.length);
          if (!idx.includes(k)) idx.push(k);
        }
        const by: Record<number, ReturnType<typeof combineTipResults>> = {};
        const lmm: Record<number, number> = {};
        for (const t of TIPS) {
          by[t] = combineTipResults(idx.map((k) => frames[k].est[t]));
          lmm[t] = idx.reduce((a, k) => a + frames[k].lmm[t], 0) / idx.length;
        }
        if (TIPS.filter((t) => by[t].ok).length < 2) few++;
        TIPS.forEach((t, j) => {
          if (by[t].ok) foundCount[j]++;
        });
        const withPrior = planHandTips(by, TIPS, null, 0.27);
        const noPrior = planHandTips(by, TIPS, null, null);
        TIPS.forEach((t, j) => {
          rules.landmark[j].push(0);
          rules["per finger (first version)"][j].push(by[t].ok ? by[t].ratio * lmm[t] : 0);
          rules["per hand (prior 0.27)"][j].push(withPrior.tips[t].ratio * lmm[t]);
          rules["per hand, no prior"][j].push(noPrior.tips[t].ratio * lmm[t]);
        });
      }
      for (const [rule, per] of Object.entries(rules)) lines.push(`| ${photo} | ${rule} | ${per.map((v) => sd(v).toFixed(2)).join(" | ")} |`);
      foundLines.push(`| ${photo} | ${foundCount.map((c) => `${((100 * c) / N).toFixed(0)}%`).join(" | ")} | ${((100 * few) / N).toFixed(0)}% |`);
    }
    console.log(`\nREAL perturbed photos, ${DIR ? "scan = 4 random frames of 40" : ""}: SD of the tip extension (mm) across 400 scans\n\n${lines.join("\n")}\n\n${foundLines.join("\n")}\n\nFrame-to-frame SD of the measured ratio: ${perFrameSd.join(" | ")}\n`);
    expect(lines.length).toBeGreaterThan(4);
  });
});
