// Ellipse / conic maths of the coin study: exact round trips and recovery of known synthetic geometry.
import { describe, expect, it } from "vitest";
import { lookAt, project } from "../geometry/camera";
import { seededRandom, type V3 } from "../geometry/linalg";
import type { Intrinsics, Pt } from "../common";
import { circlePosesFromConic, conicToEllipse, ellipseToConic, fitEllipseRobust, planeBasis, projectCircleConic, sampleEllipse, sampsonDistance } from "./conic";

const K: Intrinsics = { fx: 1000, fy: 1000, cx: 640, cy: 360, width: 1280, height: 720 };

function circlePoints(center: V3, normal: V3, r: number, n: number): V3[] {
  const [u, v] = planeBasis(normal);
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return [center[0] + r * (Math.cos(t) * u[0] + Math.sin(t) * v[0]), center[1] + r * (Math.cos(t) * u[1] + Math.sin(t) * v[1]), center[2] + r * (Math.cos(t) * u[2] + Math.sin(t) * v[2])] as V3;
  });
}

describe("conic maths", () => {
  it("round-trips an ellipse through its conic", () => {
    const e = { cx: 320.5, cy: 211.25, major: 80, minor: 61, angleDeg: 33 };
    const back = conicToEllipse(ellipseToConic(e));
    expect(back).not.toBeNull();
    expect(back!.cx).toBeCloseTo(e.cx, 9);
    expect(back!.cy).toBeCloseTo(e.cy, 9);
    expect(back!.major).toBeCloseTo(e.major, 9);
    expect(back!.minor).toBeCloseTo(e.minor, 9);
    expect(back!.angleDeg).toBeCloseTo(e.angleDeg, 7);
    for (const p of sampleEllipse(e, 12)) expect(Math.abs(sampsonDistance(e, p.x, p.y))).toBeLessThan(1e-9);
  });

  it("fits an ellipse to noisy points with outliers, and its standard errors match the scatter", () => {
    const truth = { cx: 400, cy: 300, major: 120, minor: 96, angleDeg: 120 };
    const majors: number[] = [];
    let sigmaMajor = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rnd = seededRandom(seed);
      const pts: Pt[] = sampleEllipse(truth, 300, rnd.uniform()).map((p) => ({ x: p.x + 0.3 * rnd.gaussian(), y: p.y + 0.3 * rnd.gaussian() }));
      for (let k = 0; k < 30; k++) pts.push({ x: 400 + 40 * rnd.uniform(), y: 300 + 40 * rnd.uniform() }); // a finger / glare edge inside
      const fit = fitEllipseRobust(pts);
      expect(fit).not.toBeNull();
      majors.push(fit!.ellipse.major);
      sigmaMajor += fit!.sigma.major / 30;
      expect(Math.abs(fit!.ellipse.minor - truth.minor)).toBeLessThan(0.3);
      expect(fit!.inliers.length).toBeGreaterThan(280);
    }
    const mean = majors.reduce((a, b) => a + b, 0) / majors.length;
    const sd = Math.sqrt(majors.reduce((s, m) => s + (m - mean) ** 2, 0) / (majors.length - 1));
    expect(Math.abs(mean - truth.major)).toBeLessThan(0.1);
    expect(sigmaMajor / sd).toBeGreaterThan(0.5);
    expect(sigmaMajor / sd).toBeLessThan(2);
  });

  it("recovers the 3D circle (one of two poses) from its exact image conic, and the projected conic matches projected points", () => {
    const rnd = seededRandom(7);
    for (let trial = 0; trial < 20; trial++) {
      const center: V3 = [(rnd.uniform() - 0.5) * 200, (rnd.uniform() - 0.5) * 100, 0];
      const eye: V3 = [center[0] + (rnd.uniform() - 0.5) * 300, center[1] - 150 - rnd.uniform() * 100, 250 + rnd.uniform() * 200];
      const pose = lookAt(eye, [0, 0, 0]);
      const normal: V3 = [0, 0, 1];
      const Q = projectCircleConic(center, normal, 11.5, pose.R, pose.t, K)!;
      const e = conicToEllipse(Q)!;
      expect(e).not.toBeNull();
      for (const X of circlePoints(center, normal, 11.5, 16)) {
        const p = project(K, pose, X)!;
        expect(Math.abs(sampsonDistance(e, p.x, p.y))).toBeLessThan(1e-6);
      }
      const sols = circlePosesFromConic(Q, K, 11.5);
      expect(sols.length).toBe(2);
      const Rv = (w: V3): V3 => [pose.R[0] * w[0] + pose.R[1] * w[1] + pose.R[2] * w[2], pose.R[3] * w[0] + pose.R[4] * w[1] + pose.R[5] * w[2], pose.R[6] * w[0] + pose.R[7] * w[1] + pose.R[8] * w[2]];
      const cTrue = Rv(center).map((x, i) => x + pose.t[i]);
      const nTrue = Rv(normal);
      const best = Math.min(...sols.map((s) => Math.hypot(s.center[0] - cTrue[0], s.center[1] - cTrue[1], s.center[2] - cTrue[2])));
      expect(best).toBeLessThan(1e-6 * Math.hypot(...cTrue));
      const angle = Math.min(...sols.map((s) => Math.acos(Math.min(1, Math.abs(s.normal[0] * nTrue[0] + s.normal[1] * nTrue[1] + s.normal[2] * nTrue[2])))));
      expect(angle).toBeLessThan(1e-6);
      // both solutions reproduce the same conic (the ambiguity is real)
      for (const s of sols) {
        const q2 = conicToEllipse(projectCircleConic(s.center, s.normal, 11.5, [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0], K)!)!;
        expect(q2.major).toBeCloseTo(e.major, 6);
        expect(q2.minor).toBeCloseTo(e.minor, 6);
      }
    }
  });
});
