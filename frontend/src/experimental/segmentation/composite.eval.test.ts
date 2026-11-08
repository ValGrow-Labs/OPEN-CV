// OPT-IN evaluation of analyseHand on COMPOSITE scenes (real hand pixels on synthetic backgrounds, with a truth matte).
// The scenes are not in the repository (they derive from an untracked sample photo; README "Composite evaluation" says
// how they are made). Skipped unless these are set (paths separated by ";"):
//   SEG_COMPOSITE_DIRS  folders holding cases.json, <name>.png and <name>_gt.png
//   SEG_LANDMARKS       JSON files mapping <name> -> 21 landmarks in the picture's pixels (null = none found)
//   SEG_EVAL_OUT        optional: write every row as JSON here
//   SEG_EXTERNAL_MASKS  optional: a folder with <name>__<model>.png masks from another segmenter (e.g. SAM 2), scored
//                       through the same analysis as backend "external"
// Results are COMPOSITE: never real-world accuracy.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initOpenCV, type CV } from "../../vision/opencv";
import type { BinaryMask, Pt } from "../common";
import { analyseHand, type HandAnalysis } from "./analyse";
import { compareToTruth } from "./boundary";
import { scaleLandmarks } from "./geometry";
import { decodePng } from "./pngNode";

const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
const dirs = (env.SEG_COMPOSITE_DIRS ?? "").split(";").filter(Boolean);
const lmFiles = (env.SEG_LANDMARKS ?? "").split(";").filter(Boolean);

function toMask(img: { width: number; height: number; data: Uint8ClampedArray }): BinaryMask {
  const data = new Uint8Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) data[i] = img.data[4 * i] > 127 ? 255 : 0;
  return { width: img.width, height: img.height, data };
}

function row(name: string, group: string, backend: string, a: HandAnalysis, truth: BinaryMask, landmarks: Pt[]) {
  const base = {
    name,
    group,
    backend,
    ok: a.ok,
    reasons: a.gates.reasons.map((r) => `${r.code}: ${r.message}`),
    codes: [...new Set(a.gates.reasons.map((r) => r.code))],
    timings: a.timings,
  };
  if (!a.mask || !a.labels) return base;
  const lmW = scaleLandmarks(landmarks, 1 / a.scaleToSource);
  const cmp = compareToTruth({ mask: a.mask, labels: a.labels, gaps: a.gaps }, truth, lmW);
  return {
    ...base,
    iou: cmp.iou,
    dice: cmp.dice,
    boundaryMeanPx: cmp.boundary.meanPx,
    boundaryP95Px: cmp.boundary.p95Px,
    perPartIoU: cmp.perPartIoU,
    partTruth: cmp.partTruth,
    gapTruthOpen: cmp.gapTruthOpen,
    gapPredOpen: cmp.gapPredOpen,
    gapRecall: cmp.gapRecall,
    gapPrecision: cmp.gapPrecision,
    gaps: a.gaps.map((g) => ({ pair: g.names.join("-"), status: g.status, expected: g.expected, merged: g.merged, depthRatio: +g.depthRatio.toFixed(2), widthsPx: g.widths.map((w) => (w.widthPx === null ? null : +w.widthPx.toFixed(1))) })),
    fingers: a.parts.fingers.map((f) => ({ finger: f.finger, lengthRatio: +f.lengthRatio.toFixed(2), neck: f.neck ? +f.neck.ratio.toFixed(2) : null, medianWidthPx: f.medianWidthPx, tipToLandmarkPw: f.tipToLandmarkPw })),
    confidence: a.confidence?.summary,
    boundaryMetrics: a.boundaryMetrics,
  };
}

describe.skipIf(!dirs.length || dirs.length !== lmFiles.length)("composite evaluation of analyseHand (opt-in, COMPOSITE scenes)", () => {
  it("runs every scene and writes the rows", async () => {
    const cv: CV = await initOpenCV(createRequire(import.meta.url)("@techstark/opencv-js"));
    const rows: unknown[] = [];
    const ext = env.SEG_EXTERNAL_MASKS;
    const extFiles = ext && existsSync(ext) ? readdirSync(ext) : [];
    for (let d = 0; d < dirs.length; d++) {
      const cases = JSON.parse(readFileSync(join(dirs[d], "cases.json"), "utf8")) as { name: string; group: string }[];
      const lms = JSON.parse(readFileSync(lmFiles[d], "utf8")) as Record<string, Pt[] | null>;
      for (const c of cases) {
        const lm = lms[c.name] ?? null;
        if (!lm) {
          rows.push({ name: c.name, group: c.group, backend: "none", ok: false, codes: ["no_hand"], reasons: ["no_hand: MediaPipe found no hand"] });
          continue;
        }
        const img = decodePng(readFileSync(join(dirs[d], `${c.name}.png`)));
        const truth = toMask(decodePng(readFileSync(join(dirs[d], `${c.name}_gt.png`))));
        const a = await analyseHand(img, lm, { backend: "grabcut", cv });
        rows.push(row(c.name, c.group, "grabcut", a, truth, lm));
        for (const f of extFiles.filter((x) => x.startsWith(`${c.name}__`) && x.endsWith(".png"))) {
          const model = f.slice(c.name.length + 2, -4);
          const m = toMask(decodePng(readFileSync(join(ext as string, f))));
          const b = await analyseHand(img, lm, { backend: "external", externalMask: m });
          rows.push(row(c.name, c.group, `external:${model}`, b, truth, lm));
        }
      }
    }
    if (env.SEG_EVAL_OUT) writeFileSync(env.SEG_EVAL_OUT, JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);
});
