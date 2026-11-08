// SIMULATED research grid of the EXPERIMENTAL board-free chain (opt in; long):
//   RUN_BOARDFREE_GRID=seg,results,photo      chosen blocks (or "all")
//   BOARDFREE_RENDER_CACHE=<dir>              keep the clean renders on disk between runs (optional, ~12 MB a picture)
// Prints the markdown tables of README.md. Every number is SIMULATED (a capsule hand on procedural textures, rendered
// without gloss, tone curve or compression); none is real-world accuracy.
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { initOpenCV, type CV } from "../../vision/opencv";
import { segmentAndCarve } from "./chain";
import { runBoardRoute, runChain, runExactPoses, SIM_COIN, TABLE_HEADER, tableRow, truthMaskProvider, type Row } from "./evaluate";
import { photoConsistencyStudy } from "./photo";
import { halveImage, scoreAgainstTruth } from "./segment";
import { SimCache, simulateCapture, type SkinName } from "./simulate";
import type { SegmentationMethod } from "./types";
import { rayBox, rayGrid } from "../multiview/image";

const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
const sel = (env.RUN_BOARDFREE_GRID ?? "").split(",").map((s) => s.trim());
const on = (b: string) => sel.includes("all") || sel.includes(b);
const cache = new SimCache(env.BOARDFREE_RENDER_CACHE ?? null);
const T = 6 * 3600_000;
const tick = () => new Promise((r) => setTimeout(r, 0));
const METHODS: SegmentationMethod[] = ["grabcut", "plane", "combined"];

describe.skipIf(!sel.some((s) => s))("SIMULATED board-free grid (opt in: RUN_BOARDFREE_GRID)", () => {
  let cv: CV;
  beforeAll(async () => {
    cv = await initOpenCV(createRequire(import.meta.url)("@techstark/opencv-js"));
  }, 120_000);

  it.runIf(on("seg"))("segmentation without the board: IoU with the renderer's masks per view, by skin tone", async () => {
    const lines = ["| skin | method | mean IoU | min IoU | views rejected | hand px unknown | IoU per view (top, e12-000 ... e12-338) |", "|---|---|---|---|---|---|---|"];
    for (const skin of ["light", "medium", "dark", "veryDark"] as SkinName[]) {
      const cap = await simulateCapture(cache, { texture: "speckle", capture: "sweep", skin });
      await tick();
      // the chain's own SfM poses for this capture (SfM with the truth-mask hook so the carving is not the point here)
      const { result } = runChain(cap, "plane", cv, { maskProvider: truthMaskProvider(cap) });
      if (!result.tablePoses.length || !result.intrinsics) {
        lines.push(`| ${skin} | (SfM refused: ${result.refused}) | | | | | |`);
        continue;
      }
      const idx = cap.frames.map((f, i) => (f.carve ? i : -1)).filter((i) => i >= 0);
      for (const method of METHODS) {
        await tick();
        const r = segmentAndCarve(cap.frames, result.tablePoses, result.intrinsics, idx, { ...SIM_COIN, segmentation: method, cv });
        const truth = truthMaskProvider(cap);
        const ious: number[] = [];
        let unkHand = 0, hand = 0;
        r.segmentation.forEach((s, k) => {
          const fi = r.carveViews[k].frameIndex;
          const t = truth(fi, s.mask.width, s.mask.height).mask;
          // score inside the projected volume only (pixels whose rays cross it: the only ones the carving uses)
          const K0 = result.intrinsics!;
          const g = rayGrid({ ...K0, fx: K0.fx / 2, fy: K0.fy / 2, cx: K0.cx / 2, cy: K0.cy / 2, width: s.mask.width, height: s.mask.height }, r.carveViews[k].pose, s.mask.width, s.mask.height);
          const inVol = new Uint8Array(t.data.length);
          for (let p = 0; p < inVol.length; p++) if (rayBox(g.origin, [g.dirs[p * 3], g.dirs[p * 3 + 1], g.dirs[p * 3 + 2]], r.volume!.min, r.volume!.max)) inVol[p] = 1;
          const tt = { ...t, data: t.data.map((x, p) => (inVol[p] ? x : 0)) };
          const ss = { ...s, mask: { ...s.mask, data: s.mask.data.map((x, p) => (inVol[p] ? x : 0)) } };
          const sc = scoreAgainstTruth(ss, tt);
          ious.push(sc.iou);
          for (let p = 0; p < tt.data.length; p++) if (tt.data[p]) ((hand++), !s.known.data[p] && unkHand++);
        });
        const rej = r.segmentation.filter((s) => s.rejected.length).map((s) => `${s.id}: ${s.rejected.join("; ")}`);
        lines.push(`| ${skin} | ${method} | ${(ious.reduce((a, b) => a + b, 0) / ious.length).toFixed(3)} | ${Math.min(...ious).toFixed(3)} | ${rej.length ? rej.join(" / ") : "none"} | ${((100 * unkHand) / Math.max(1, hand)).toFixed(1)} % | ${ious.map((v) => v.toFixed(2)).join(" ")} |`);
        console.log(lines[lines.length - 1]);
      }
    }
    console.log(["### Segmentation without the board (SIMULATED, speckle sweep, SfM poses, half size 640 x 360)", "", ...lines].join("\n"));
    expect(lines.length).toBeGreaterThan(2);
  }, T);

  it.runIf(on("results"))("results: board-free chain vs exact poses vs the board route, same hand", async () => {
    const cap = await simulateCapture(cache, { texture: "speckle", capture: "sweep" });
    const rows: Row[] = [];
    const log = (r: Row) => {
      rows.push(r);
      console.log(tableRow(r) + `  IoU ${r.ious.map((v) => (v === null ? "-" : v.toFixed(3))).join(",")}`);
    };
    log(runExactPoses(cap, "truth", cv));
    await tick();
    for (const m of METHODS) {
      log(runExactPoses(cap, m, cv));
      await tick();
    }
    const truthMasks = runChain(cap, "combined", cv, { maskProvider: truthMaskProvider(cap) });
    log(truthMasks.row);
    const fr = truthMasks.result.frame;
    console.log(`frame: ${fr?.notes.join("; ")}; plane rms ${fr?.plane.rmsMm.toFixed(3)} mm, ${fr?.plane.inliers} inliers; cut at x = ${fr?.cutXMm.toFixed(1)} mm`);
    const u = truthMasks.result.uncertainty;
    console.log(
      `stage-5 inputs: feature rms ${u.sfm?.featureRmsPx.toFixed(3)} px (median ${u.sfm?.featureMedianPx.toFixed(3)}, p95 ${u.sfm?.featureP95Px.toFixed(3)}), ${u.sfm?.observations} observations, ` +
        `conditional sigmas: rotation max ${Math.max(...(u.sfm?.perFrame ?? []).map((p) => p?.rotSigmaDeg ?? 0)).toFixed(4)} deg, centre max ${Math.max(...(u.sfm?.perFrame ?? []).map((p) => p?.centreSigmaMm ?? 0)).toFixed(3)} mm, focal ${((u.sfm?.focalRelSigma ?? NaN) * 100).toFixed(4)} %; ` +
        `coin rms ${u.sfm?.coin?.jointRmsPx.toFixed(3)} px over ${u.sfm?.coin?.frames} frames; scale components ${u.scale.components.map((c) => `${c.key} ${(c.rel * 100).toFixed(3)} %`).join(", ")}; rss ${((u.scale.relSigma ?? NaN) * 100).toFixed(2)} %`,
    );
    const trueF = cap.truth.cams[0].intrinsics.fx;
    console.log(`focal error ${(((truthMasks.result.intrinsics!.fx - trueF) / trueF) * 100).toFixed(3)} %, k1 ${truthMasks.result.intrinsics!.k1?.toFixed(4)} (true -0.06)`);
    await tick();
    for (const m of METHODS) {
      log(runChain(cap, m, cv).row);
      await tick();
    }
    log(runBoardRoute("medium"));
    console.log(["### Results (SIMULATED, mm, measured - true; the same capsule hand)", "", TABLE_HEADER, ...rows.map(tableRow)].join("\n"));
    expect(rows.length).toBe(9);
  }, T);

  it.runIf(on("photo"))("photo-consistency: can colour tell the hull's over-fill from the true surface?", async () => {
    const cap = await simulateCapture(cache, { texture: "speckle", capture: "sweep" });
    const poses = cap.truth.cams.map((c) => c.pose);
    const idx = cap.frames.map((f, i) => (f.carve ? i : -1)).filter((i) => i >= 0);
    const r = segmentAndCarve(cap.frames, poses, cap.truth.cams[0].intrinsics, idx, { ...SIM_COIN, segmentation: "plane", maskProvider: truthMaskProvider(cap) });
    const rec = r.reconstruction!;
    const images = rec.carvedViews.map((v) => halveImage(cap.frames[v.frameIndex].image, 2));
    const s = photoConsistencyStudy(rec.hull!, rec.carvedViews, images, cap.truth.scene.hand.sdfBoard);
    console.log(`SIMULATED photo-consistency study (exact poses, exact masks, 17 views, voxel ${rec.voxelMm} mm): ${JSON.stringify(s)}`);
    expect(s.surfaceVoxels).toBeGreaterThan(0);
  }, T);
});
