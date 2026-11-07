// The capsule prior (SYNTHETIC): does trimming the hull with a fitted model help where the views are incomplete?
import { describe, expect, it } from "vitest";
import { carveVisualHull, voxelCount } from "./carving";
import { reconstructHand } from "./pipeline";
import { capsulePrior, fitCapsulePrior, intersectWithPrior } from "./prior";
import { DEFAULT_HAND_PARAMS, EIGHT_VIEWS, FOUR_VIEWS, makeCapsuleHand, renderCaptures, type CapsuleHandParams } from "./synthetic";

const hand = makeCapsuleHand();
const SIZE = { width: 192, height: 192 };
const views = (names: Parameters<typeof renderCaptures>[1]) => renderCaptures(hand, names, SIZE).map((c) => ({ mask: c.mask, intrinsics: c.intrinsics, pose: c.pose }));
// a starting model that is NOT the truth: a population-like hand a little different from this one
const GUESS: CapsuleHandParams = { ...DEFAULT_HAND_PARAMS, palmThickness: 22, palmBreadth: 82, palmLength: 96 };

describe("fitting the model outline to the hull", () => {
  const hull = carveVisualHull(views(FOUR_VIEWS), hand.bounds, { voxelMm: 2 });

  it("improves the outline agreement and ends close to the hull's outline", () => {
    const fit = fitCapsulePrior(hull, GUESS);
    const before = fitCapsulePrior(hull, GUESS, { rounds: 0 });
    expect(fit.outlineIoU).toBeGreaterThan(before.outlineIoU);
    expect(fit.outlineIoU).toBeGreaterThan(0.9);
    // The outline cannot tell a longer palm from longer fingers, but it does fix where the fingertips end: the fitted
    // model's middle fingertip is closer to the truth (177.5 mm from the wrist plane) than the guess's (173.5 mm).
    const tip = (p: CapsuleHandParams) => p.palmLength + p.fingers.middle.length + p.fingers.middle.radius;
    expect(Math.abs(tip(fit.params) - hand.truth.handLengthMm)).toBeLessThan(Math.abs(tip(GUESS) - hand.truth.handLengthMm));
  }, 60000);

  it("does not touch the palm thickness unless told (the views along it cannot observe it)", () => {
    expect(fitCapsulePrior(hull, GUESS).params.palmThickness).toBe(22);
    expect(fitCapsulePrior(hull, GUESS, { thicknessMm: 25 }).params.palmThickness).toBe(25);
  }, 60000);
});

describe("trimming the hull with the prior", () => {
  const hull = carveVisualHull(views(FOUR_VIEWS), hand.bounds, { voxelMm: 2 });

  it("only ever removes volume, never adds any", () => {
    const trimmed = intersectWithPrior(hull, GUESS, 2);
    expect(voxelCount(trimmed)).toBeLessThanOrEqual(voxelCount(hull));
    for (let i = 0; i < hull.occupancy.length; i++) if (trimmed.occupancy[i]) expect(hull.occupancy[i]).toBe(1);
    expect(voxelCount(trimmed)).toBeGreaterThan(0.5 * voxelCount(hull));
  });

  it("a bigger margin keeps more of the hull", () => {
    expect(voxelCount(intersectWithPrior(hull, GUESS, 6))).toBeGreaterThanOrEqual(voxelCount(intersectWithPrior(hull, GUESS, 1)));
  });
});

describe("does the prior reduce error where the views are incomplete? (SYNTHETIC)", () => {
  const thick = (r: ReturnType<typeof reconstructHand>) => Math.abs(r.measurements!.palmThickness.value! - hand.truth.palmThicknessMm);

  it("two opposite views: the hull has no thickness at all; the prior brings it to within a few millimetres", () => {
    const opts = { voxelMm: 2, frame: hand.frame, fingers: hand.fingerAxes, ignoreGate: true } as const;
    const plain = reconstructHand(views(["palm", "back"]), hand.bounds, opts);
    const withPrior = reconstructHand(views(["palm", "back"]), hand.bounds, { ...opts, prior: capsulePrior(GUESS) });
    expect(thick(plain)).toBeGreaterThan(20);
    expect(thick(withPrior)).toBeLessThan(4);
    // and the lengths the views DO observe are not made worse
    expect(Math.abs(withPrior.measurements!.handLength.value! - hand.truth.handLengthMm)).toBeLessThan(2);
  }, 90000);

  it("four views: the prior trims the thumb/palm phantom volume; eight views barely need it", () => {
    const opts = { voxelMm: 2, frame: hand.frame, fingers: hand.fingerAxes, ignoreGate: true } as const;
    const four = reconstructHand(views(FOUR_VIEWS), hand.bounds, opts);
    const fourPrior = reconstructHand(views(FOUR_VIEWS), hand.bounds, { ...opts, prior: capsulePrior(GUESS) });
    expect(thick(fourPrior)).toBeLessThanOrEqual(thick(four) + 0.2);
    const eight = reconstructHand(views(EIGHT_VIEWS), hand.bounds, opts);
    const eightPrior = reconstructHand(views(EIGHT_VIEWS), hand.bounds, { ...opts, prior: capsulePrior(GUESS) });
    // with enough views the data already constrains the hand: the prior must not make the length error worse by more than a mm
    expect(Math.abs(eightPrior.measurements!.handLength.value! - hand.truth.handLengthMm)).toBeLessThan(Math.abs(eight.measurements!.handLength.value! - hand.truth.handLengthMm) + 1);
  }, 120000);
});
