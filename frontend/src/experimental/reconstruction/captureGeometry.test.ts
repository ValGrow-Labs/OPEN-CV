// SIMULATED. Which phone positions can reconstruct a hand that stays still while the phone moves around it?
// A synthetic capsule hand (exact truth) seen by cameras on one side only, as when the hand rests palm-down on the
// marker board and the phone moves above it. Says nothing about real accuracy; it decides the capture design.
import { describe, expect, it } from "vitest";
import type { CarveView } from "./carving";
import { truthOf } from "./experiment";
import { intrinsicsFor, lookAtPose, type Vec3 } from "./linalg";
import { reconstructHand } from "./pipeline";
import { DEFAULT_HAND_PARAMS, makeCapsuleHand, renderSilhouette } from "./synthetic";

const hand = makeCapsuleHand(DEFAULT_HAND_PARAMS);
const truth = truthOf(hand);
const K = intrinsicsFor(256, 256, 42);
const b = hand.bounds;
const center: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
// Hand frame: +z out of the palm. Palm-down on a board: the palm surface (z = +palmThickness / 2) is on the board and the
// cameras are on the -z side (above the back of the hand).
const PALM_PLANE = DEFAULT_HAND_PARAMS.palmThickness / 2;
const PAD = 15;

/** A ring of `n` cameras at `elevDeg` above the board plane, all around, plus one straight above if `top`. */
function ring(elevDeg: number, n: number, top: boolean): CarveView[] {
  const e = (elevDeg * Math.PI) / 180;
  const out: CarveView[] = [];
  const add = (dir: Vec3, up: Vec3) => {
    const eye: Vec3 = [center[0] + dir[0] * 380, center[1] + dir[1] * 380, center[2] + dir[2] * 380];
    const pose = lookAtPose(eye, center, up);
    out.push({ mask: renderSilhouette(hand, K, pose), intrinsics: K, pose });
  };
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    add([Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), -Math.sin(e)], [0, 0, -1]);
  }
  if (top) add([0, 0, -1], [0, 1, 0]);
  return out;
}

// A search volume with room around the hand, as a real one would have. Resting: its +z face is the board.
const free = { min: [b.min[0] - PAD, b.min[1], b.min[2] - PAD] as Vec3, max: [b.max[0] + PAD, b.max[1] + PAD, b.max[2] + PAD] as Vec3 };
const resting = { min: free.min, max: [free.max[0], free.max[1], PALM_PLANE] as Vec3 };
// -y is the end of the volume at the wrist (the forearm continues out of it): an expected cut in both cases.
const run = (views: CarveView[], bounds: { min: Vec3; max: Vec3 }, cutFaces: ("+z" | "-y")[]) =>
  reconstructHand(views, bounds, { voxelMm: 1.5, frame: hand.frame, fingers: hand.fingerAxes, ignoreGate: true, cutFaces, planeNormal: [0, 0, 1] });

describe("SIMULATED capture geometry for a still hand and a moving phone", () => {
  it("cameras on one side only, 30 degrees up: a wedge under the hand that no view rules out; rejected", () => {
    const r = run(ring(30, 8, true), free, ["-y"]);
    expect(r.measurements!.palmThickness.value! - truth.palmThickness).toBeGreaterThan(10);
    expect(r.quality!.accepted).toBe(false);
    expect(r.quality!.reasons).toContain("sides_not_observed");
  }, 120_000);

  it("cameras on one side only, 45 degrees up: the far side is the search box itself; rejected as truncated", () => {
    const r = run(ring(45, 8, true), free, ["-y"]);
    expect(r.quality!.reasons).toContain("hull_truncated_by_volume");
    expect(r.quality!.accepted).toBe(false);
  }, 120_000);

  it("resting on the board, a low ring all round plus one view from above bounds every side", () => {
    const r = run(ring(12, 16, true), resting, ["+z", "-y"]);
    const m = r.measurements!;
    expect(r.quality!.reasons).not.toContain("hull_truncated_by_volume");
    expect(r.quality!.accepted).toBe(true);
    // Synthetic numbers, on an exact capsule hand: they show the geometry is sufficient, not that a real scan is accurate.
    expect(Math.abs(m.palmThickness.value! - truth.palmThickness)).toBeLessThan(5);
    expect(Math.abs(m.circumferenceKnuckle.value! - truth.circumference)).toBeLessThan(5);
    expect(Math.abs(m.handLength.value! - truth.handLength)).toBeLessThan(2);
  }, 120_000);

  it("resting, but only high views (45 degrees): the sides are not bounded and thickness is badly over-estimated", () => {
    const r = run(ring(45, 8, true), resting, ["+z", "-y"]);
    expect(r.measurements!.palmThickness.value! - truth.palmThickness).toBeGreaterThan(8);
    expect(r.quality!.reasons).toContain("sides_not_observed");
  }, 120_000);
});
