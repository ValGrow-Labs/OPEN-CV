// The whole chain on the SYNTHETIC capsule hand: silhouettes -> hull -> mesh -> gates -> measurements -> compare with
// the exact truth. These tests prove the mathematics works and that the gates behave. They say nothing about real
// hands, real phones or real accuracy.
import { describe, expect, it } from "vitest";
import { viewCoverage } from "./carving";
import { reconstructHand } from "./pipeline";
import { FINGER_NAMES } from "./measure";
import { EIGHT_VIEWS, FOUR_VIEWS, jitterMask, makeCapsuleHand, perturbPose, renderCaptures, scaleFocal, type RigViewName } from "./synthetic";
import { topologyReport } from "./meshing";
import { lookAtPose } from "./linalg";

const hand = makeCapsuleHand();
const SIZE = { width: 224, height: 224 };
const views = (names: RigViewName[]) => renderCaptures(hand, names, SIZE).map((c) => ({ mask: c.mask, intrinsics: c.intrinsics, pose: c.pose }));
const run = (names: RigViewName[], over: Partial<Parameters<typeof reconstructHand>[2]> = {}) =>
  reconstructHand(views(names), hand.bounds, { voxelMm: 1.5, frame: hand.frame, fingers: hand.fingerAxes, ...over });
// the gate tests do not need the finest grid
const coarse = { voxelMm: 3 } as const;

describe("eight exact views (SYNTHETIC, no noise)", () => {
  const r = run(EIGHT_VIEWS);

  it("reconstructs one watertight mesh that passes every gate", () => {
    expect(r.ok).toBe(true);
    const t = topologyReport(r.mesh!);
    expect(t.watertight).toBe(true);
    expect(t.components).toBe(1);
    expect(r.quality!.reasons).toEqual([]);
    expect(r.quality!.accepted).toBe(true);
    expect(r.quality!.metrics.meanIoU).toBeGreaterThan(0.95);
    expect(r.quality!.metrics.completeness).toBeGreaterThan(0.85);
  });

  it("measures the hand within a few tenths to a few millimetres of the exact truth", () => {
    const m = r.measurements!;
    const tr = hand.truth;
    expect(Math.abs(m.handLength.value! - tr.handLengthMm)).toBeLessThan(1.0);
    expect(Math.abs(m.palmBreadth.value! - tr.palmBreadthMm)).toBeLessThan(3);
    expect(Math.abs(m.palmThickness.value! - tr.palmThicknessMm)).toBeLessThan(5);
    expect(Math.abs(m.circumferenceKnuckle.value! - tr.circumferenceMm) / tr.circumferenceMm).toBeLessThan(0.03);
    for (const f of FINGER_NAMES) expect(Math.abs(m.fingerLengths[f].value! - tr.fingerLengthsMm[f])).toBeLessThan(1.5);
    expect(m.surfaceArea.value).not.toBeNull(); // the gates passed, so the area is reported
  });

  it("is quick enough to run in a browser worker", () => {
    expect(r.timingsMs.total).toBeLessThan(15000);
    expect(r.timingsMs.carve).toBeLessThan(5000);
  });

  it("every voxel of the hull comes with an observation count and the mesh with a confidence", () => {
    expect(r.confidence!.length).toBe(r.mesh!.vertices.length / 3);
    expect(Math.max(...r.confidence!)).toBeLessThanOrEqual(1);
    expect(r.hull.nViews).toBe(8);
  });
});

describe("the gates reject what should not be trusted (SYNTHETIC)", () => {
  it("two opposite views are rejected: too few views, and no view across the hand; the surface area is withheld", () => {
    const r = run(["palm", "back"], coarse);
    expect(r.ok).toBe(true);
    expect(r.quality!.accepted).toBe(false);
    expect(r.quality!.reasons).toContain("too_few_views");
    expect(r.quality!.reasons).toContain("views_do_not_surround_hand");
    expect(r.measurements!.surfaceArea.value).toBeNull();
    expect(r.measurements!.surfaceArea.basis).toBe("none");
    // the thickness of such a hull is the whole search volume: the data does not observe it
    expect(r.measurements!.palmThickness.value!).toBeGreaterThan(hand.truth.palmThicknessMm + 15);
  });

  it("two views close in angle leave a big gap around the hand and are rejected for it", () => {
    const r = run(["palm", "palm-thumb45"], coarse);
    expect(r.quality!.metrics.maxAzimuthGapDeg).toBeGreaterThan(100);
    expect(r.quality!.reasons).toContain("views_do_not_surround_hand");
  });

  it("a 90 degree fan of three views (palm and both 45 degree views) is on the edge of the gate and passes the gap test", () => {
    const r = run(["palm", "palm-thumb45", "palm-little45"], coarse);
    expect(r.quality!.metrics.maxAzimuthGapDeg).toBeCloseTo(90, 0);
    expect(r.quality!.reasons).not.toContain("views_do_not_surround_hand");
  });

  it("four views around the hand are accepted", () => {
    const r = run(FOUR_VIEWS, coarse);
    expect(r.quality!.accepted).toBe(true);
    expect(r.quality!.metrics.maxAzimuthGapDeg).toBeLessThanOrEqual(100);
  });

  it("a 1 degree camera pose error on every view is caught by the reprojection check", () => {
    const noisy = renderCaptures(hand, EIGHT_VIEWS, SIZE).map((c, i) => ({ mask: c.mask, intrinsics: c.intrinsics, pose: perturbPose(c.pose, 1, 2, 100 + i) }));
    const r = reconstructHand(noisy, hand.bounds, { voxelMm: 2, frame: hand.frame, fingers: hand.fingerAxes });
    expect(r.quality!.accepted).toBe(false);
    expect(r.quality!.reasons).toContain("reprojection_mismatch");
    expect(r.measurements!.surfaceArea.value).toBeNull();
  });

  it("but a 2 % focal length error passes every gate and still biases every length (the gates cannot see a shared systematic error)", () => {
    const biased = renderCaptures(hand, EIGHT_VIEWS, SIZE).map((c) => ({ mask: c.mask, intrinsics: scaleFocal(c.intrinsics, 1.02), pose: c.pose }));
    const r = reconstructHand(biased, hand.bounds, { voxelMm: 1.5, frame: hand.frame, fingers: hand.fingerAxes });
    expect(r.quality!.accepted).toBe(true); // consistent, hence accepted ...
    const err = r.measurements!.handLength.value! - hand.truth.handLengthMm;
    expect(err).toBeLessThan(-1); // ... but about 1 % short
    expect(err).toBeGreaterThan(-4);
  });

  it("silhouettes with no common volume fail with a reason instead of a mesh", () => {
    const base = renderCaptures(hand, ["palm", "thumb", "little", "back"], SIZE);
    // a camera that looks somewhere else entirely
    const wrong = { ...base[1], pose: lookAtPose([0, 600, 0], [0, 600, 100], [0, 1, 0]) };
    const r = reconstructHand([base[0], wrong, base[2], base[3]], hand.bounds, { voxelMm: 2 });
    expect(r.ok).toBe(false);
    expect(r.failure).toMatch(/no common volume/);
    expect(r.mesh).toBeNull();
  });

  it("an empty set of views has no volume", () => {
    const r = reconstructHand([], hand.bounds, { voxelMm: 3 });
    expect(r.ok).toBe(false);
  });
});

describe("tolerance and noise (SYNTHETIC)", () => {
  it("a carving tolerance of 1 keeps the hull from being carved away by one bad silhouette", () => {
    const set = renderCaptures(hand, EIGHT_VIEWS, SIZE).map((c) => ({ mask: c.mask, intrinsics: c.intrinsics, pose: c.pose }));
    // one silhouette is empty (a failed segmentation)
    const broken = set.map((v, i) => (i === 2 ? { ...v, mask: { ...v.mask, data: new Uint8Array(v.mask.data.length) } } : v));
    expect(reconstructHand(broken, hand.bounds, { voxelMm: 2 }).ok).toBe(false);
    const tolerant = reconstructHand(broken, hand.bounds, { voxelMm: 2, tolerance: 1, frame: hand.frame, fingers: hand.fingerAxes });
    expect(tolerant.ok).toBe(true);
    expect(Math.abs(tolerant.measurements!.handLength.value! - hand.truth.handLengthMm)).toBeLessThan(2);
  });

  it("boundary error of 1 px on every mask moves the lengths by about a millimetre or less", () => {
    const noisy = renderCaptures(hand, EIGHT_VIEWS, SIZE).map((c, i) => ({ mask: jitterMask(c.mask, 1, 40 + i), intrinsics: c.intrinsics, pose: c.pose }));
    const r = reconstructHand(noisy, hand.bounds, { voxelMm: 1.5, frame: hand.frame, fingers: hand.fingerAxes });
    expect(Math.abs(r.measurements!.handLength.value! - hand.truth.handLengthMm)).toBeLessThan(1.5);
    for (const f of FINGER_NAMES) expect(Math.abs(r.measurements!.fingerLengths[f].value! - hand.truth.fingerLengthsMm[f])).toBeLessThan(2);
  });

  it("view coverage of the eight-view rig has no large gap around the hand", () => {
    const cov = viewCoverage(views(EIGHT_VIEWS), [0, 57, 0]);
    expect(cov.maxAzimuthGapDeg).toBeLessThan(50);
  });
});
