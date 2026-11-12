import { describe, expect, it } from "vitest";
import { angleHint, cellOf, computeCoverage, frameOrientation, palmFacingZSign, palmZSignOf, PHASE_GEOMETRY } from "./coverage";
import { handFrame, sweep } from "./testHands";

describe("orientation from landmarks", () => {
  it("reads a palm facing the camera as 0 degrees, from the handedness label and from the palm frames", () => {
    const f = handFrame({});
    expect(frameOrientation(f)!.facingDeg).toBeLessThan(3);
    expect(frameOrientation(f)!.basis).toBe("handedness");
    expect(palmZSignOf([f])).toBe(palmFacingZSign("right"));
    expect(frameOrientation(f, palmZSignOf([f]))!.basis).toBe("palm_reference");
  });

  it("works for a left hand too", () => {
    const f = handFrame({ hand: "left" });
    expect(frameOrientation(f)!.facingDeg).toBeLessThan(3);
    expect(palmZSignOf([f])).toBe(palmFacingZSign("left"));
  });

  it("reads the back of the hand as 180 and an edge-on hand as 90", () => {
    const sign = palmZSignOf([handFrame({})]);
    expect(frameOrientation(handFrame({ flip: 180 }), sign)!.facingDeg).toBeGreaterThan(175);
    const edge = frameOrientation(handFrame({ yaw: 90 }), sign)!.facingDeg;
    expect(edge).toBeGreaterThan(80);
    expect(edge).toBeLessThan(100);
  });

  it("puts different phone positions in different cells", () => {
    const sign = -1 as const;
    const cell = (yaw: number, pitch: number) => cellOf("palm", frameOrientation(handFrame({ yaw, pitch }), sign)!);
    expect(cell(0, 0)).toBe("centre");
    const cells = new Set([cell(20, 0), cell(-20, 0), cell(0, 20), cell(0, -20)]);
    expect(cells.size).toBe(4);
    expect(cells.has("centre")).toBe(false);
  });

  it("does not guess a side it cannot judge: no label, no palm reference folds to 0..90", () => {
    const f = { ...handFrame({ flip: 180 }), handedness: null };
    const o = frameOrientation(f)!;
    expect(o.basis).toBe("unknown");
    expect(o.facingDeg).toBeLessThan(10); // flat to the camera, but which side is not claimed
  });
});

const palmInput = (frames: ReturnType<typeof sweep>, pipelineReady = true) => ({ phase: "palm" as const, frames, framesTarget: 10, pipelineReady });

describe("palm coverage", () => {
  it("is empty without frames", () => {
    const c = computeCoverage(palmInput([], false));
    expect(c.percent).toBe(0);
    expect(c.complete).toBe(false);
  });

  it("grows with accepted frames but stops short of 100 while the phone has not moved", () => {
    const still = sweep(40, [{}]); // the phone does not move: every frame the same view (with noise)
    const noisy = still.map((_, i) => handFrame({ seed: i + 7, noiseM: 0.002 }));
    const c = computeCoverage(palmInput(noisy));
    expect(c.framePart).toBe(1);
    expect(c.cellsCovered.length).toBeLessThan(PHASE_GEOMETRY.palm.cellsNeeded);
    expect(c.complete).toBe(false);
    expect(c.percent).toBeLessThan(100);
    expect(c.percent).toBeGreaterThanOrEqual(50);
    expect(c.nextCell).not.toBeNull();
  });

  it("is a function of the frames alone, not of the time: the same frames give the same number", () => {
    const frames = sweep(30, [{ yaw: 0 }, { yaw: 16 }]);
    expect(computeCoverage(palmInput(frames))).toEqual(computeCoverage(palmInput(frames)));
  });

  it("completes only when the frames are enough and the phone has seen the hand from several angles", () => {
    const moving = sweep(48, [{}, { yaw: 14 }, { yaw: -14 }, { pitch: 14 }], {}, 8);
    const c = computeCoverage(palmInput(moving));
    expect(c.cellsCovered.length).toBeGreaterThanOrEqual(3);
    expect(c.complete).toBe(true);
    expect(c.percent).toBe(100);
    // ... and not while the pipeline itself still needs frames
    const early = computeCoverage(palmInput(moving.slice(0, 20), false));
    expect(early.percent).toBeLessThan(100);
    expect(early.framePart).toBeLessThan(1);
  });

  it("never counts frames whose coin was not accepted", () => {
    const frames = sweep(40, [{}, { yaw: 14 }, { yaw: -14 }, { pitch: 14 }], { coinAccepted: false });
    const c = computeCoverage(palmInput(frames));
    expect(c.frames).toBe(0);
    expect(c.percent).toBe(0);
    const none = sweep(40, [{}], { coin: false });
    expect(computeCoverage(palmInput(none)).frames).toBe(0);
  });

  it("counts less when only a few frames are in", () => {
    const frames = sweep(4, [{}]);
    const c = computeCoverage({ phase: "palm", frames, framesTarget: 16, pipelineReady: false });
    expect(c.framePart).toBeCloseTo(0.25, 5);
    expect(c.percent).toBeLessThanOrEqual(13);
  });
});

describe("side and back coverage", () => {
  const sign = palmZSignOf([handFrame({})]);

  it("the side view needs the hand roughly edge-on and does not need the coin", () => {
    const faceOn = sweep(40, [{}], { coin: false });
    const c0 = computeCoverage({ phase: "side", frames: faceOn, framesTarget: 8, pipelineReady: true, palmZSign: sign });
    expect(c0.cellsCovered).toEqual([]);
    expect(c0.complete).toBe(false);
    const edge = sweep(48, [{ yaw: 90 }, { yaw: 72 }, { yaw: 108 }], { coin: false });
    const c1 = computeCoverage({ phase: "side", frames: edge, framesTarget: 8, pipelineReady: true, palmZSign: sign });
    expect(c1.cellsCovered.length).toBeGreaterThanOrEqual(2);
    expect(c1.complete).toBe(true);
  });

  it("the back view needs the back of the hand to the camera: the palm shown again counts for nothing", () => {
    const palmAgain = sweep(48, [{}, { yaw: 14 }, { yaw: -14 }, { pitch: 14 }]);
    const c0 = computeCoverage({ phase: "back", frames: palmAgain, framesTarget: 8, pipelineReady: true, palmZSign: sign });
    expect(c0.cellsCovered).toEqual([]);
    expect(c0.complete).toBe(false);
    const back = sweep(48, [{}, { yaw: 14 }, { yaw: -14 }, { pitch: 14 }], { flip: 180 });
    const c1 = computeCoverage({ phase: "back", frames: back, framesTarget: 8, pipelineReady: true, palmZSign: sign });
    expect(c1.complete).toBe(true);
  });

  it("the back view needs a coin, as the palm does", () => {
    const back = sweep(48, [{}, { yaw: 14 }, { yaw: -14 }, { pitch: 14 }], { flip: 180, coinAccepted: false });
    expect(computeCoverage({ phase: "back", frames: back, framesTarget: 8, pipelineReady: true, palmZSign: sign }).frames).toBe(0);
  });
});

describe("guidance for the missing angle", () => {
  it("names a direction for every cell and nothing when complete", () => {
    for (const cell of ["centre", "toward_fingers", "toward_wrist", "thumb_side", "little_side", "edge_palm", "edge_on", "edge_back"] as const) {
      expect(angleHint("palm", cell)).toMatch(/phone/);
    }
    expect(angleHint("palm", null)).toBeNull();
  });
});
