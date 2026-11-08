// The SIMULATED board scene: placement, truth, landmarks, determinism. Says nothing about real photos.
import { describe, expect, it } from "vitest";
import { BOARD } from "../board/spec";
import { projectPoint } from "../reconstruction/linalg";
import { boardRig, capsuleLandmarksHandFrame, makeBoardScene, moveHand, projectLandmarks, renderView, SURFACE } from "./scene";

const scene = makeBoardScene();
const cams = boardRig(scene, { width: 320, height: 180, highCount: 2 });
const top = cams.find((c) => c.id === "top")!;

describe("SIMULATED board scene", () => {
  it("places the palm on the board plane, the back 24 mm above it, fingers toward +x, wrist at the open edge", () => {
    const { R, t } = scene.handToBoard;
    // hand +y (fingers) -> board +x; hand +z (palm normal) -> board -z; hand +x (little finger) -> board +y
    expect(R).toEqual([0, 1, 0, 1, 0, 0, 0, 0, -1]);
    const palm = { x: t[0] + 50, y: t[1], z: 0 }; // under the palm centre, on the paper
    expect(Math.abs(scene.sdfBoard(palm.x, palm.y, 0))).toBeLessThan(1e-6);
    expect(Math.abs(scene.sdfBoard(palm.x, palm.y, scene.truth.palmThickness))).toBeLessThan(1e-6);
    expect(scene.sdfBoard(palm.x, palm.y, 12)).toBeLessThan(0);
    const a = BOARD.handArea;
    expect(t[0]).toBeGreaterThan(a.minX);
    const tipX = scene.landmarks[12].x;
    expect(tipX + 10).toBeLessThan(BOARD.coinTarget.center.x - BOARD.coinTarget.diameterMm / 2);
    expect(scene.truth.handLength).toBeCloseTo(177.49, 1);
  });

  it("landmarks: the landmark frame equals the exact hand frame (wrist on the axis through the middle MCP)", () => {
    const lm = capsuleLandmarksHandFrame();
    expect(lm[0][0]).toBe(lm[9][0]);
    expect(lm[9][1]).toBe(100);
    // board landmarks: wrist -> middle MCP is +x, MCPs at the knuckle line 100 mm from the wrist plane
    const w = scene.landmarks[0], m = scene.landmarks[9];
    expect(m.y - w.y).toBeCloseTo(0, 9);
    expect(m.x - w.x).toBeCloseTo(100, 9);
    expect(w.z).toBeCloseTo(scene.truth.palmThickness / 2, 9);
  });

  it("renders deterministically, with an exact mask, and every landmark projects inside the top-view hand mask", () => {
    const a = renderView(scene, top.intrinsics, top.pose, { seed: 3 });
    const b = renderView(scene, top.intrinsics, top.pose, { seed: 3 });
    expect(Buffer.from(a.image.data).equals(Buffer.from(b.image.data))).toBe(true);
    let hand = 0;
    for (let p = 0; p < a.mask.data.length; p++) {
      expect(a.mask.data[p] > 0).toBe(a.surface[p] === SURFACE.hand);
      if (a.mask.data[p]) hand++;
    }
    expect(hand).toBeGreaterThan(2000);
    const uv = projectLandmarks(scene.landmarks, top.intrinsics, top.pose);
    // tips sit at the centre of the tip sphere and joints on the capsule axes: inside the silhouette from above
    for (const p of uv) expect(a.mask.data[Math.floor(p!.y) * 320 + Math.floor(p!.x)]).toBe(255);
    // the coin is visible in the top view
    expect(a.surface.some((s) => s === SURFACE.coin)).toBe(true);
  });

  it("a moved hand moves its landmarks by the same offset", () => {
    const m = moveHand(scene, [5, 0, 0]);
    m.landmarks.forEach((p, i) => expect(p.x - scene.landmarks[i].x).toBeCloseTo(5, 9));
    const q0 = projectPoint([scene.landmarks[0].x, scene.landmarks[0].y, scene.landmarks[0].z], top.intrinsics, top.pose)!;
    const q1 = projectPoint([m.landmarks[0].x, m.landmarks[0].y, m.landmarks[0].z], top.intrinsics, top.pose)!;
    expect(Math.hypot(q1.u - q0.u, q1.v - q0.v)).toBeGreaterThan(1);
  });
});
