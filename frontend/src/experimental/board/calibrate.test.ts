// Planar self-calibration (Zhang) on synthetic views of the board: projected corners with noise (fast) and rendered
// images (slower). SIMULATED: says nothing about a real phone's lens.
import { describe, expect, it } from "vitest";
import type { Intrinsics, Pt } from "../common";
import { intrinsicsFromHfov, project } from "../geometry/camera";
import { seededRandom } from "../geometry/linalg";
import { assumedIntrinsics, calibrateCamera, closedFormFocal, viewFromDetections, type PlanarView } from "./calibrate";
import { detectMarkers } from "./detect";
import { orbitPose, renderBoardView } from "./render";
import { BOARD, markerCorners } from "./spec";

const K: Intrinsics = { ...intrinsicsFromHfov(1280, 720, 68), k1: -0.08, k2: 0.02 };
const HAND_CENTRE = { x: 124.5, y: 105, z: 0 };

/** All markers' corners seen from a pose, with Gaussian corner noise; markers outside the image are left out. */
function syntheticView(Ki: Intrinsics, pose: ReturnType<typeof orbitPose>, noisePx: number, rnd: ReturnType<typeof seededRandom>): PlanarView {
  const world: Pt[] = [];
  const image: Pt[] = [];
  for (const m of BOARD.markers) {
    const c3 = markerCorners(m);
    const px = c3.map((c) => project(Ki, pose, c));
    if (px.some((p) => !p || p.x < 2 || p.y < 2 || p.x > Ki.width - 3 || p.y > Ki.height - 3)) continue;
    px.forEach((p, i) => {
      world.push({ x: c3[i].x, y: c3[i].y });
      image.push({ x: p!.x + noisePx * rnd.gaussian(), y: p!.y + noisePx * rnd.gaussian() });
    });
  }
  return { world, image };
}

function randomViews(n: number, seed: number, noisePx: number): PlanarView[] {
  const rnd = seededRandom(seed);
  return Array.from({ length: n }, () => {
    const e = 30 + 40 * rnd.uniform();
    const a = 360 * rnd.uniform();
    const d = 330 + 150 * rnd.uniform();
    return syntheticView(K, orbitPose({ x: 110 + 40 * rnd.uniform(), y: 85 + 40 * rnd.uniform(), z: 0 }, d, e, a), noisePx, rnd);
  });
}

describe("camera self-calibration from the board (SIMULATED)", () => {
  it("noise-free views: the closed form is close and the refinement exact", () => {
    const views = randomViews(5, 1, 0);
    const f0 = closedFormFocal(views, K.width, K.height)!;
    expect(Math.abs(f0 / K.fx - 1)).toBeLessThan(0.03); // distortion is ignored by the closed form
    const r = calibrateCamera(views, K.width, K.height, { distortion: "k1k2" });
    expect(r.method).toBe("zhang");
    if (r.method !== "zhang") return;
    expect(Math.abs(r.intrinsics.fx / K.fx - 1)).toBeLessThan(1e-5);
    expect(r.intrinsics.k1!).toBeCloseTo(K.k1!, 4);
    expect(r.intrinsics.k2!).toBeCloseTo(K.k2!, 3);
    expect(r.rmsPx).toBeLessThan(1e-3);
  });

  it("0.2 px corner noise, 10 views: focal within 0.3 %, k1 within 0.01, honest standard deviations", () => {
    const r = calibrateCamera(randomViews(10, 2, 0.2), K.width, K.height);
    expect(r.method).toBe("zhang");
    if (r.method !== "zhang") return;
    const ferr = r.intrinsics.fx - K.fx;
    expect(Math.abs(ferr / K.fx)).toBeLessThan(0.003);
    expect(Math.abs(r.intrinsics.k1! - K.k1!)).toBeLessThan(0.01);
    expect(Math.abs(ferr)).toBeLessThan(4 * r.std.fx); // the error is within a few sigma
    expect(r.rmsPx).toBeGreaterThan(0.15);
    expect(r.rmsPx).toBeLessThan(0.3);
    expect(r.perViewRmsPx.length).toBe(10);
    expect(r.degeneracy.degenerate).toBe(false);
  });

  it("the principal point and a free aspect ratio can be estimated when asked", () => {
    const Kp: Intrinsics = { ...K, cx: K.cx + 12, cy: K.cy - 8, fy: K.fx * 1.004 };
    const rnd = seededRandom(5);
    const views = Array.from({ length: 12 }, (_, i) =>
      syntheticView(Kp, orbitPose(HAND_CENTRE, 360 + 8 * i, 30 + 4 * i, 30 * i), 0.1, rnd),
    );
    const r = calibrateCamera(views, K.width, K.height, { principalPoint: "estimate", aspect: "free" });
    expect(r.method).toBe("zhang");
    if (r.method !== "zhang") return;
    expect(Math.abs(r.intrinsics.cx - Kp.cx)).toBeLessThan(4 * r.std.cx! + 0.5);
    expect(Math.abs(r.intrinsics.fy / r.intrinsics.fx - 1.004)).toBeLessThan(0.002);
  });

  it("falls back to the ASSUMED field of view, flagged, when calibration is impossible", () => {
    const two = calibrateCamera(randomViews(2, 3, 0.2), K.width, K.height);
    expect(two.method).toBe("assumed_hfov");
    expect(two.assumed).toBe(true);
    // three views all straight above: the focal length is not observable
    const rnd = seededRandom(4);
    const flat = [0, 60, 120].map((a) => syntheticView(K, orbitPose(HAND_CENTRE, 420, 90, a), 0.2, rnd));
    const r = calibrateCamera(flat, K.width, K.height);
    expect(r.method).toBe("assumed_hfov");
    if (r.method === "assumed_hfov") {
      expect(r.reason).toMatch(/fronto-parallel|closed-form/);
      expect(r.focalRangePx[0]).toBeLessThan(r.intrinsics.fx);
      expect(r.focalRangePx[1]).toBeGreaterThan(r.intrinsics.fx);
    }
    expect(assumedIntrinsics(1280, 720, 70).intrinsics.fx).toBeCloseTo(640 / Math.tan((35 * Math.PI) / 180), 6);
  });

  it("from rendered images through the detector: 5 views give the focal length to a fraction of a per cent", () => {
    const rnd = seededRandom(21);
    const views: PlanarView[] = [];
    for (let i = 0; i < 5; i++) {
      const pose = orbitPose({ x: 110 + 40 * rnd.uniform(), y: 85 + 40 * rnd.uniform(), z: 0 }, 330 + 120 * rnd.uniform(), 30 + 40 * rnd.uniform(), 72 * i + 20 * rnd.uniform());
      const img = renderBoardView(K, pose, { blurSigmaPx: 0.8, noiseSigma: 3, light: { gradientX: 0.15, vignette: 0.2 }, seed: 40 + i });
      views.push(viewFromDetections(detectMarkers(img).markers));
    }
    const r = calibrateCamera(views, K.width, K.height);
    expect(r.method).toBe("zhang");
    if (r.method !== "zhang") return;
    expect(Math.abs(r.intrinsics.fx / K.fx - 1)).toBeLessThan(0.005);
    expect(Math.abs(r.intrinsics.k1! - K.k1!)).toBeLessThan(0.02);
    expect(r.rmsPx).toBeLessThan(0.3);
  }, 60000);
});
