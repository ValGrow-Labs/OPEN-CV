// SIMULATED end to end, board-free, FROM PIXELS ONLY (opt in: RUN_BOARDFREE_E2E=1; renders 57-frame sweeps, several
// minutes; BOARDFREE_RENDER_CACHE=<dir> keeps the renders on disk). Like recon/chain.test.ts for the board route: the
// chain is told nothing (no focal length, no distortion, no pose, no mask). Its inputs are the pictures, the capture
// guide's approximate directions, and two detector STAND-INS: landmarks (the synthetic landmarks projected with 2 px
// noise, as the board route's test) and the coin outline (the renderer's coin label, sfm/coinEdges.ts). The coin's
// thickness is ASSUMED (1.5 mm, unverified). SIMULATED; not real accuracy.
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { initOpenCV, type CV } from "../../vision/opencv";
import { reconstructBoardFree } from "./chain";
import { runChain, SIM_COIN, TABLE_HEADER, tableRow } from "./evaluate";
import { SimCache, simulateCapture } from "./simulate";

const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
const cache = new SimCache(env.BOARDFREE_RENDER_CACHE ?? null);

describe.skipIf(!env.RUN_BOARDFREE_E2E)("SIMULATED board-free chain end to end (opt in: RUN_BOARDFREE_E2E)", () => {
  let cv: CV;
  beforeAll(async () => {
    cv = await initOpenCV(createRequire(import.meta.url)("@techstark/opencv-js"));
  }, 120_000);

  it("speckled table, continuous sweep, coin beside the hand: accepted, measured, labelled", async () => {
    const cap = await simulateCapture(cache, { texture: "speckle", capture: "sweep" });
    const { result: r, row } = runChain(cap, "combined", cv);
    console.log([TABLE_HEADER, tableRow(row)].join("\n"));
    console.log(`IoU per view: ${row.ious.map((v) => (v === null ? "-" : v.toFixed(3))).join(", ")}`);
    expect(r.refused).toBeNull();
    expect(r.accepted).toBe(true);
    const rec = r.reconstruction!;
    expect(rec.quality!.metrics.minIoU).toBeGreaterThanOrEqual(0.8);
    expect(Math.abs(row.errors.length!)).toBeLessThan(3);
    expect(Math.abs(row.errors.breadth!)).toBeLessThan(3);
    expect(Math.abs(row.errors.thickness!)).toBeLessThan(5);
    // the point cloud: table-frame millimetres, a label, a confidence and the views that observed each point
    const pc = rec.pointCloud!;
    expect(pc.length).toBeGreaterThan(1000);
    const labels = new Set(pc.map((p) => p.label));
    expect(labels.has("observed") && labels.has("support_plane")).toBe(true);
    expect(labels.has("truncated")).toBe(false);
    expect(pc.filter((p) => p.label === "observed").every((p) => p.sourceViews.length > 0 && p.confidence > 0)).toBe(true);
    expect(pc.filter((p) => p.label === "support_plane").every((p) => p.z <= rec.voxelMm + 1e-6)).toBe(true);
    // what stage 5 needs
    const u = r.uncertainty;
    expect(u.sfm!.featureRmsPx).toBeLessThan(1);
    expect(u.sfm!.perFrame.filter((x) => x).length).toBe(cap.frames.length);
    expect(u.scale.components.map((c) => c.key)).toEqual(["fit", "reference_diameter", "thickness"]);
    expect(u.scale.coinThicknessVerified).toBe(false);
    expect(u.views.length).toBe(17);
  }, 3_600_000);

  it("plain table: refused (the camera geometry cannot be recovered)", async () => {
    const cap = await simulateCapture(cache, { texture: "plain", capture: "sweep" });
    const r = reconstructBoardFree(cap.frames, { ...SIM_COIN, segmentation: "combined", cv });
    console.log(`plain table: refused ${r.refused} (${r.refusalDetail})`);
    expect(["sfm_failed", "sfm_partial_registration"]).toContain(r.refused);
    expect(r.reconstruction).toBeNull();
  }, 3_600_000);

  it("the board capture's 17 stills without the board: refused (too few frames; and the SfM itself places none)", async () => {
    const cap = await simulateCapture(cache, { texture: "speckle", capture: "stills", views: 17 });
    const r = reconstructBoardFree(cap.frames, { ...SIM_COIN, segmentation: "combined", cv });
    expect(r.refused).toBe("too_few_frames");
    const forced = reconstructBoardFree(cap.frames, { ...SIM_COIN, segmentation: "combined", cv, minFrames: 0 });
    console.log(`stills with the frame-count rule off: refused ${forced.refused} (${forced.refusalDetail})`);
    expect(["sfm_failed", "sfm_partial_registration"]).toContain(forced.refused);
  }, 3_600_000);

  it("coin partly under the hand: refused before any geometry", async () => {
    const cap = await simulateCapture(cache, { texture: "speckle", capture: "sweep", coin: "under-hand" });
    const r = reconstructBoardFree(cap.frames, { ...SIM_COIN, segmentation: "combined", cv });
    console.log(`coin under the hand: refused ${r.refused} (${r.refusalDetail})`);
    expect(["coin_missing", "coin_partial"]).toContain(r.refused);
  }, 3_600_000);
});
