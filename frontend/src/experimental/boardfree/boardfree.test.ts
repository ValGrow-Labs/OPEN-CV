// Default suite of the EXPERIMENTAL board-free chain (fast, under a minute): the pieces on small SIMULATED renders with
// EXACT poses, and the refusals that need no structure from motion. The full chain (renders of a 57-frame sweep, the
// SfM, the carving) is opt in: e2e.test.ts (RUN_BOARDFREE_E2E=1) and grid.test.ts (RUN_BOARDFREE_GRID=...).
// Every number here is SIMULATED; nothing is real-world accuracy.
import { describe, expect, it } from "vitest";
import type { BinaryMask, CameraPose, Intrinsics, Pt } from "../common";
import { projectLandmarks, sceneTarget, SKIN_TONES } from "../multiview/scene";
import { lookAtPose, type Vec3 } from "../reconstruction/linalg";
import { finishRender, makeSfmScene, renderClean, SFM_SURFACE, surfaceMask } from "../sfm/scene";
import { carveBoardFree, forearmBeyond, type CarveViewInput } from "./carve";
import { autoCarveViews, neighbourFrames, reconstructBoardFree } from "./chain";
import { planeEvidence, scoreAgainstTruth, segmentView, type SegViewContext } from "./segment";
import { handExclusionMask, invert } from "./sfmStage";
import { volumeFromLandmarks } from "./tableFrame";
import type { BoardFreeFrame } from "./types";

const scene = makeSfmScene({ texture: "speckle" });
const W = 320, H = 180;
const K: Intrinsics = (() => {
  const f = W / 2 / Math.tan((64 * Math.PI) / 360);
  return { fx: f, fy: f, cx: W / 2, cy: H / 2, width: W, height: H };
})();
const target: Vec3 = sceneTarget(scene.hand);
const ringPose = (azDeg: number, elDeg = 12, dist = 340): CameraPose => {
  const e = (elDeg * Math.PI) / 180, a = (azDeg * Math.PI) / 180;
  return lookAtPose([target[0] + dist * Math.cos(e) * Math.cos(a), target[1] + dist * Math.cos(e) * Math.sin(a), target[2] + dist * Math.sin(e)], target, [0, 0, 1]);
};
const render = (pose: CameraPose, seed = 1) => {
  const c = renderClean(scene, K, pose, { skin: SKIN_TONES.medium });
  return { image: finishRender(c, { seed }), truth: { width: W, height: H, data: surfaceMask(c, SFM_SURFACE.hand) } as BinaryMask };
};

describe("board-free chain pieces (SIMULATED, exact poses)", () => {
  it("leaves the hand and the forearm out of the features by a region built from the landmarks only", () => {
    const pose = ringPose(90, 30);
    const { truth } = render(pose);
    const lm = projectLandmarks(scene.landmarks, K, pose, { noisePx: 1, seed: 3 });
    const ex = handExclusionMask(W, H, lm)!;
    let hand = 0, covered = 0, excluded = 0;
    for (let p = 0; p < W * H; p++) {
      if (ex[p]) excluded++;
      if (truth.data[p]) {
        hand++;
        if (ex[p]) covered++;
      }
    }
    expect(covered / hand).toBeGreaterThan(0.97);
    expect(excluded / (W * H)).toBeLessThan(0.6); // most of the table is still available for features
    expect(handExclusionMask(W, H, null)).toBeNull();
  });

  it("plane consistency: table pixels agree with a neighbour 7.5 degrees away, the hand does not", () => {
    const pose = ringPose(90);
    const v = render(pose, 1);
    const nb = [ringPose(82.5), ringPose(97.5)].map((p, k) => ({ id: `n${k}`, image: render(p, 2 + k).image, pose: p }));
    const volume = { min: [0, 60, 0] as Vec3, max: [215, 190, 80] as Vec3 };
    const ctx: SegViewContext = { id: "v", image: v.image, K, pose, landmarks: projectLandmarks(scene.landmarks, K, pose, { noisePx: 1, seed: 1 }), neighbours: nb, volume };
    const ev = planeEvidence(ctx);
    let handAgree = 0, hand = 0, tableAgree = 0, table = 0;
    for (let p = 0; p < W * H; p++) {
      if (!ev.roi[p] || !ev.verifiable[p]) continue;
      if (v.truth.data[p]) ((hand++), ev.agree[p] && handAgree++);
      else ((table++), ev.agree[p] && tableAgree++);
    }
    console.log(`SIMULATED plane evidence 320x180: hand pixels agreeing ${handAgree}/${hand}, table pixels agreeing ${tableAgree}/${table}`);
    expect(handAgree / hand).toBeLessThan(0.15); // the rim within a millimetre or two of the table agrees too
    expect(tableAgree / table).toBeGreaterThan(0.4);
    const seg = segmentView(ctx, { method: "plane" });
    const roiTruth = { ...v.truth, data: v.truth.data.map((x, p) => (ev.roi[p] ? x : 0)) };
    expect(scoreAgainstTruth(seg, roiTruth).iou).toBeGreaterThan(0.6);
  });

  it("the forearm cut: the cross-section the views carved at the cut, prolonged backward", () => {
    const dims: [number, number, number] = [4, 10, 6];
    const occ = new Uint8Array(4 * 10 * 6);
    for (let k = 0; k < 3; k++) for (let j = 3; j < 7; j++) occ[0 + 4 * (j + 10 * k)] = 1;
    const r = forearmBeyond({ dims, origin: [0, 0, 0], voxelMm: 2, occupancy: occ, support: occ, observed: occ, nViews: 1 }, { min: [0, 0, 0], max: [8, 20, 12] }, 3)!;
    expect(r.max[0]).toBe(0);
    expect(r.min[1]).toBeCloseTo(6 - 3);
    expect(r.max[1]).toBeCloseTo(14 + 3);
    expect(r.max[2]).toBeCloseTo(6 + 3);
  });

  it("the forearm cut policy makes the views along the forearm checkable without changing the measurements (exact masks)", () => {
    const poses: { id: string; pose: CameraPose }[] = [{ id: "top", pose: lookAtPose([target[0], target[1], target[2] + 400], target, [0, 1, 0]) }];
    for (let a = 0; a < 360; a += 22.5) poses.push({ id: `e12-${a}`, pose: ringPose(a) });
    const views = poses.map((q, i) => {
      const c = renderClean(scene, K, q.pose);
      return { id: q.id, frameIndex: i, intrinsics: K, pose: q.pose, landmarks: projectLandmarks(scene.landmarks, K, q.pose, { noisePx: 1, seed: 10 + i }), mask: { width: W, height: H, data: surfaceMask(c, SFM_SURFACE.hand) }, known: { width: W, height: H, data: new Uint8Array(W * H).fill(255) } } as CarveViewInput;
    });
    const volume = volumeFromLandmarks(views)!;
    const box = carveBoardFree(views, { voxelMm: 2.5, volume, cutPolicy: "box" });
    const fa = carveBoardFree(views, { voxelMm: 2.5, volume, cutPolicy: "forearm" });
    const along = ["e12-157.5", "e12-180", "e12-202.5"];
    const iou = (r: typeof box, id: string) => r.views.find((v) => v.id === id)!.reprojectionIoU;
    expect(iou(box, "e12-180")).toBeNull(); // board rule: nearly the whole hand unknown, uncheckable
    for (const id of along) expect(iou(fa, id)).toBeGreaterThan(0.85);
    expect(Math.min(...fa.views.map((v) => v.reprojectionIoU ?? 1))).toBeGreaterThanOrEqual(Math.min(...box.views.map((v) => v.reprojectionIoU ?? 1)) - 1e-9);
    const T = scene.hand.truth;
    for (const r of [box, fa]) expect(Math.abs(r.measurements!.handLength.value! - T.handLength)).toBeLessThan(4);
    expect(Math.abs(fa.measurements!.palmThickness.value! - box.measurements!.palmThickness.value!)).toBeLessThan(1.5);
    // labelled point cloud: per point x, y, z, label, confidence and the views that observed it
    const pc = fa.pointCloud!;
    expect(pc.length).toBe(fa.mesh!.vertices.length / 3);
    expect(pc.some((p) => p.label === "support_plane")).toBe(true);
    expect(pc.some((p) => p.label === "observed" && p.sourceViews.length > 0)).toBe(true);
    expect(pc.filter((p) => p.label === "support_plane").every((p) => p.z < 2.5 + 1e-6)).toBe(true);
  }, 120_000);

  it("neighbour and carving-view selection from the poses alone", () => {
    const poses: CameraPose[] = [lookAtPose([target[0], target[1], 410], target, [0, 1, 0])];
    for (let a = 0; a < 360; a += 7.5) poses.push(ringPose(a));
    const nb = neighbourFrames(poses, 2, target);
    expect(nb).toEqual(expect.arrayContaining([1, 3]));
    expect(nb.length).toBe(4);
    const cv = autoCarveViews(poses);
    expect(cv.length).toBeGreaterThanOrEqual(15);
  });

  it("small dense inverse", () => {
    const A = [4, 1, 0, 1, 3, 1, 0, 1, 2];
    const I = invert(A, 3)!;
    const P = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => A[i * 3] * I[j] + A[i * 3 + 1] * I[3 + j] + A[i * 3 + 2] * I[6 + j]));
    P.forEach((v, k) => expect(v).toBeCloseTo(k % 4 === 0 ? 1 : 0, 9));
  });
});

describe("board-free chain refusals that need no structure from motion", () => {
  const tiny = (n: number, o: { coin?: number; size?: (i: number) => number } = {}): BoardFreeFrame[] =>
    Array.from({ length: n }, (_, i) => {
      const s = o.size ? o.size(i) : 16;
      return { id: `f${i}`, image: { width: s, height: s, data: new Uint8ClampedArray(s * s * 4) }, coinEdges: i < (o.coin ?? n) ? Array.from({ length: 30 }, (_, k): Pt => ({ x: 8 + Math.cos(k), y: 8 + Math.sin(k) })) : null };
    });
  const opts = { coinDiameterMm: 23, coinThicknessMm: 1.5, segmentation: "plane" as const };
  it("refuses the board capture's stills: too few frames for a board-free capture", () => {
    const r = reconstructBoardFree(tiny(17), opts);
    expect(r.refused).toBe("too_few_frames");
    expect(r.refusalWords).toMatch(/sweep/);
    expect(r.reconstruction).toBeNull();
  });
  it("refuses pictures of different sizes", () => {
    expect(reconstructBoardFree(tiny(57, { size: (i) => (i === 3 ? 24 : 16) }), opts).refused).toBe("pictures_differ_in_size");
  });
  it("refuses without the coin, and with the coin seen whole in too few frames", () => {
    expect(reconstructBoardFree(tiny(57, { coin: 0 }), opts).refused).toBe("coin_missing");
    const p = reconstructBoardFree(tiny(57, { coin: 3 }), opts);
    expect(p.refused).toBe("coin_partial");
    expect(p.refusalDetail).toMatch(/3 frames/);
  });
  it("states the coin thickness as an unverified assumption in what it hands to stage 5", () => {
    const r = reconstructBoardFree(tiny(57, { coin: 0 }), opts);
    expect(r.uncertainty.scale.coinThicknessVerified).toBe(false);
    expect(r.uncertainty.scale.coinThicknessAssumedMm).toBe(1.5);
  });
});
