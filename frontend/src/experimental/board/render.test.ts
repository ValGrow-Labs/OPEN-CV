// The test renderer itself: deterministic, geometrically consistent with geometry/camera.ts. SIMULATED support code.
import { describe, expect, it } from "vitest";
import { intrinsicsFromHfov, project } from "../geometry/camera";
import { toGray, sampleBilinear } from "./image";
import { handOccluders, makeBoardSampler, occludedFromCamera, orbitPose, renderBoardView, toBoardUnits } from "./render";
import { BOARD, boardIsBlack, markerCorners } from "./spec";

const K = { ...intrinsicsFromHfov(640, 360, 65), k1: -0.05 };
const target = { x: 124.5, y: 105, z: 0 };

describe("board renderer (test support)", () => {
  it("the fast sampler agrees with boardIsBlack everywhere on the sheet", () => {
    const s = makeBoardSampler();
    for (let x = 0.13; x < 297; x += 0.71)
      for (let y = 0.29; y < 210; y += 0.67) {
        const v = s(x, y);
        if (v === 2) continue; // the coin outline (not a marker)
        expect(v === 1).toBe(boardIsBlack(x, y));
      }
    expect(s(-1, 5)).toBe(-1);
  });

  it("is deterministic for a seed and differs for another", () => {
    const pose = orbitPose(target, 450, 60, 250);
    const opts = { noiseSigma: 4, blurSigmaPx: 0.7, seed: 3 };
    const a = renderBoardView(K, pose, opts);
    const b = renderBoardView(K, pose, opts);
    const c = renderBoardView(K, pose, { ...opts, seed: 4 });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(Buffer.from(a.data).equals(Buffer.from(c.data))).toBe(false);
  });

  it("puts ink where the projected marker interior is and paper between markers (lens distortion included)", () => {
    const pose = orbitPose(target, 450, 80, 270);
    const g = toGray(renderBoardView(K, pose, { seed: 1 }));
    const m = BOARD.markers[2];
    const cell = BOARD.markerMm / 6;
    const ink = project(K, pose, [m.x + cell / 2, m.y + cell / 2, 0])!; // a border cell
    const paper = project(K, pose, [m.x + BOARD.markerMm + 5, m.y + 15, 0])!; // the gap to the next marker
    expect(sampleBilinear(g, ink.x, ink.y)).toBeLessThan(60);
    expect(sampleBilinear(g, paper.x, paper.y)).toBeGreaterThan(190);
  });

  it("a print scale moves the markers to s times their board position; toBoardUnits gives the same image corners", () => {
    const s = 0.94;
    const pose = orbitPose({ x: target.x * s, y: target.y * s, z: 0 }, 450, 70, 250);
    const c = markerCorners(BOARD.markers[0])[0];
    const viaPhysical = project(K, pose, [c.x * s, c.y * s, 0])!;
    const viaBoard = project(K, toBoardUnits(pose, s), c)!;
    expect(viaBoard.x).toBeCloseTo(viaPhysical.x, 9);
    expect(viaBoard.y).toBeCloseTo(viaPhysical.y, 9);
  });

  it("the crude hand hides markers behind it from a low view, not from above", () => {
    const hand = handOccluders();
    const far = BOARD.markers.find((m) => m.y > 150 && m.x > 100 && m.x < 140)!; // top row, behind the palm seen from below
    const pt = { x: far.x + 15, y: far.y + 15 };
    expect(occludedFromCamera(orbitPose(target, 350, 10, 270), pt, hand)).toBe(true);
    expect(occludedFromCamera(orbitPose(target, 350, 90, 270), pt, hand)).toBe(false);
  });
});
