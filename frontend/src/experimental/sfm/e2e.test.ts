// SIMULATED end to end, board-free (opt in: RUN_SFM_E2E=1; renders 57 pictures, a few minutes): a continuous sweep of
// the capsule hand on a speckled table with a 23.00 mm coin beside it -> features (hand excluded) -> structure from
// motion with focal length and distortion self-calibrated -> coin scale fitted jointly in the bundle adjustment ->
// table frame -> carving of the 17 stills (exact masks: the board segmentation needs the board) -> measurements.
// Nothing is told to the SfM: not the focal length, not the distortion, not one pose. SIMULATED; not real accuracy.
import { describe, expect, it } from "vitest";
import { camOf, CARVE_HEADER, carveRow, carveWithPoses, RenderCache, ROW_HEADER, rowOf, runCondition, type Condition } from "./evaluate";

const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;

describe.skipIf(!env.RUN_SFM_E2E)("SIMULATED board-free SfM + coin + carving (opt in: RUN_SFM_E2E)", () => {
  it("registers every frame, self-calibrates the camera, fixes the scale with the coin and measures the hand", async () => {
    const cache = new RenderCache(env.SFM_RENDER_CACHE ?? null);
    const c: Condition = { texture: "speckle", views: 17, capture: "sweep", sweepStepDeg: 7.5 };
    await cache.warm(c);
    const r = runCondition(cache, c);
    console.log([ROW_HEADER, rowOf(r)].join("\n"));
    const t = r.sfm.timingsMs;
    console.log(
      `SfM timings (s): features ${(t.features / 1000).toFixed(1)}, matching ${(t.matching / 1000).toFixed(1)}, init ${(t.init / 1000).toFixed(1)}, incremental ${(t.incremental / 1000).toFixed(1)}, ` +
        `final BA ${(t.finalBA / 1000).toFixed(1)}, coin ${(t.coin / 1000).toFixed(1)}, total ${(t.total / 1000).toFixed(1)}; points ${r.sfm.points.length}; ` +
        `plane height at the hand ${r.planeHeightMm.toFixed(2)} mm; coin views ${r.sfm.coinJoint?.views}`,
    );
    expect(r.registered).toBe(r.views);
    expect(r.sfm.accepted).toBe(true);
    expect(Math.abs(r.focalErr)).toBeLessThan(0.005);
    expect(r.similarity.maxRotDeg).toBeLessThan(0.5);
    expect(r.joint).not.toBeNull();
    expect(Math.abs(r.joint!.scaleErr)).toBeLessThan(0.005);
    expect(r.joint!.rigid.maxRotDeg).toBeLessThan(0.5);
    const out = carveWithPoses(cache, c, r.joint!.poses, camOf(r), "SfM + coin (joint)");
    console.log([CARVE_HEADER, carveRow(out)].join("\n"));
    expect(Math.abs(out.errors.handLength!)).toBeLessThan(3);
    expect(Math.abs(out.errors.palmBreadth!)).toBeLessThan(3);
    expect(Math.abs(out.errors.palmThickness!)).toBeLessThan(5);
  }, 3_600_000);
});
