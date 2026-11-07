// GrabCut backend in Node (the same OpenCV.js build the app serves), on SYNTHETIC hands over coloured noisy
// backgrounds with an exact ground truth. Mechanics only: nothing here is accuracy on real hands.
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { initOpenCV, type CV } from "../../vision/opencv";
import type { BinaryMask } from "../common";
import { boundaryDistance, iou } from "./metrics";
import { segmentHand } from "./segmentHand";
import { makeSyntheticHand } from "./synthetic";
import { scribbleFromLandmarks } from "./backends/interactive";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCV(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 60_000);

describe("GrabCut backend (Node, OpenCV.js)", () => {
  it("exposes the OpenCV functions the backend and the later 3D work rely on, and records the ones it lacks", () => {
    const c = cv as unknown as Record<string, unknown>;
    for (const name of ["grabCut", "findContours", "morphologyEx", "distanceTransform", "convexHull", "convexityDefects", "connectedComponents", "watershed", "Laplacian", "solvePnP", "findHomography", "ORB", "AKAZE", "BFMatcher"]) {
      expect(typeof c[name], name).toBe("function");
    }
    // Not in this build (checked in the browser too): the experiments must not assume them.
    for (const name of ["calibrateCamera", "aruco", "Subdiv2D", "FlannBasedMatcher", "pyrMeanShiftFiltering"]) expect(typeof c[name], name).toBe("undefined");
  });

  it("segments a synthetic hand on a blue noisy background close to the truth, with five tips and open gaps", async () => {
    const h = makeSyntheticHand({ background: [40, 80, 170], noise: 24, seed: 3 });
    const r = await segmentHand(h.image, h.landmarks, { backend: "grabcut", cv, workingSize: 400 });
    expect(r.error).toBeUndefined();
    expect(r.reasons).toEqual([]);
    expect(iou(r.mask as BinaryMask, h.truth)).toBeGreaterThan(0.93);
    expect(boundaryDistance(r.mask as BinaryMask, h.truth).p95Px).toBeLessThan(4);
    expect(r.quality?.tipsFound).toBe(5);
    expect(r.gapsPreserved.slice(1)).toEqual([true, true, true]);
    expect(r.timingMs.backend).toBeGreaterThan(0);
  }, 60_000);

  it("works for a hand turned any way round, and for a darker skin tone on a mid-grey background", async () => {
    for (const deg of [45, 135, 270]) {
      const h = makeSyntheticHand({ rotationDeg: deg, wrist: { x: 200, y: 200 }, palmWidth: 70, skin: [110, 74, 58], background: [128, 128, 130], noise: 14, seed: deg });
      const r = await segmentHand(h.image, h.landmarks, { backend: "grabcut", cv, workingSize: 400 });
      expect(r.error, `rotation ${deg}`).toBeUndefined();
      expect(iou(r.mask as BinaryMask, h.truth), `rotation ${deg}`).toBeGreaterThan(0.9);
    }
  }, 120_000);

  it("fails loudly, not silently, without OpenCV: a named reason and the error message", async () => {
    const h = makeSyntheticHand();
    const r = await segmentHand(h.image, h.landmarks, { backend: "grabcut" });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(["segmentation_failed"]);
    expect(r.error).toMatch(/needs options\.cv/);
    expect(r.mask).toBeNull();
  });

  it("the interactive backend also needs its segmenter and says so", async () => {
    const h = makeSyntheticHand();
    const r = await segmentHand(h.image, h.landmarks, { backend: "interactive" });
    expect(r.reasons).toEqual(["segmentation_failed"]);
    expect(r.error).toMatch(/needs options\.interactiveSegmenter/);
  });

  it("builds interactive scribbles inside the unit square from the landmarks and the bones", () => {
    const h = makeSyntheticHand();
    const pts = scribbleFromLandmarks(h.landmarks, 400, 400);
    expect(pts).toHaveLength(21 + 21 * 3);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });
});
