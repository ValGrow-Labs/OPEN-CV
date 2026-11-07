// Plane-based pose on synthetic ground-truth cameras: these tests check the MATHS, not any phone or marker.
import { describe, expect, it } from "vitest";
import type { Pt } from "../common";
import { intrinsicsFromHfov, lookAt, project, rotationAngleBetween } from "./camera";
import { cameraCenter } from "./camera";
import { seededRandom, type V3 } from "./linalg";
import { estimateHomography, poseFromPlanarPoints } from "./pnp";

const near = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

/** A 4 x 4 grid of 20 mm squares' corners in the plane z = 0, centred on the origin. */
const grid: Pt[] = [];
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) grid.push({ x: (i - 1.5) * 20, y: (j - 1.5) * 20 });

function observe(K: ReturnType<typeof intrinsicsFromHfov>, pose: ReturnType<typeof lookAt>, pts: Pt[], noisePx = 0, seed = 1): Pt[] {
  const rnd = seededRandom(seed);
  return pts.map((p) => {
    const q = project(K, pose, [p.x, p.y, 0])!;
    return { x: q.x + noisePx * rnd.gaussian(), y: q.y + noisePx * rnd.gaussian() };
  });
}

describe("homography", () => {
  it("recovers a known projective map exactly from four points, and from many", () => {
    const H0 = [1.2, 0.1, 5, -0.05, 0.9, -3, 0.0004, 0.0002, 1];
    const apply = (p: Pt): Pt => {
      const w = H0[6] * p.x + H0[7] * p.y + H0[8];
      return { x: (H0[0] * p.x + H0[1] * p.y + H0[2]) / w, y: (H0[3] * p.x + H0[4] * p.y + H0[5]) / w };
    };
    for (const pts of [[grid[0], grid[3], grid[12], grid[15]], grid]) {
      const H = estimateHomography(pts, pts.map(apply))!;
      for (let k = 0; k < 9; k++) near(H[k], H0[k], 1e-6 * Math.max(1, Math.abs(H0[k])));
    }
  });
  it("refuses fewer than four points and collinear points", () => {
    expect(estimateHomography(grid.slice(0, 3), grid.slice(0, 3))).toBeNull();
    const line: Pt[] = [0, 1, 2, 3, 4].map((i) => ({ x: i * 10, y: 0 }));
    expect(estimateHomography(line, line)).toBeNull();
  });
});

describe("pose from coplanar points (synthetic camera, known pose)", () => {
  const K = intrinsicsFromHfov(1280, 720, 70);

  it("recovers a tilted pose exactly from noise-free points", () => {
    const truth = lookAt([70, -90, 340], [0, 0, 0], [0, -1, 0]);
    const r = poseFromPlanarPoints(K, grid, observe(K, truth, grid));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rotationAngleBetween(r.pose.R, truth.R)).toBeLessThan(1e-4);
    const c = cameraCenter(r.pose);
    const c0 = cameraCenter(truth);
    for (let i = 0; i < 3; i++) near(c[i], c0[i], 1e-3);
    expect(r.reprojRmsPx).toBeLessThan(1e-6);
    near(r.planeTiltDeg, (Math.acos(Math.abs(truth.R[8])) * 180) / Math.PI, 1e-3);
  });

  it("works from the minimum, four points", () => {
    const truth = lookAt([40, -60, 300], [0, 0, 0], [0, -1, 0]);
    const four = [grid[0], grid[3], grid[12], grid[15]];
    const r = poseFromPlanarPoints(K, four, observe(K, truth, four));
    expect(r.ok).toBe(true);
    if (r.ok) expect(rotationAngleBetween(r.pose.R, truth.R)).toBeLessThan(1e-3);
  });

  it("handles lens distortion when the distortion is known", () => {
    const Kd = { ...K, k1: -0.08, k2: 0.01 };
    const truth = lookAt([-60, -80, 360], [0, 0, 0], [0, -1, 0]);
    const r = poseFromPlanarPoints(Kd, grid, observe(Kd, truth, grid));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rotationAngleBetween(r.pose.R, truth.R)).toBeLessThan(1e-3);
    expect(r.reprojRmsPx).toBeLessThan(1e-4);
  });

  /** The worst rotation (degrees) and camera-position (mm) error over 20 noise draws of `noisePx`. */
  function worstErrors(points: Pt[], noisePx: number) {
    const truth = lookAt([70, -90, 340], [0, 0, 0], [0, -1, 0]);
    let worstRot = 0;
    let worstPos = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = poseFromPlanarPoints(K, points, observe(K, truth, points, noisePx, seed));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      worstRot = Math.max(worstRot, rotationAngleBetween(r.pose.R, truth.R));
      const c = cameraCenter(r.pose);
      const c0 = cameraCenter(truth);
      worstPos = Math.max(worstPos, Math.hypot(c[0] - c0[0], c[1] - c0[1], c[2] - c0[2]));
    }
    return { worstRot, worstPos };
  }

  // A sheet-sized target: a 7 x 7 grid at 30 mm spacing (180 mm across).
  const sheet: Pt[] = [];
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) sheet.push({ x: (i - 3) * 30, y: (j - 3) * 30 });

  it("with 0.3 px of pixel noise a sheet-sized target (180 mm) gives a pose within about a degree and 2-3 mm (synthetic noise only)", () => {
    const { worstRot, worstPos } = worstErrors(sheet, 0.3);
    expect(worstRot).toBeLessThan(1.5);
    expect(worstPos).toBeLessThan(4);
  });

  it("the extent of the target matters a great deal: the same noise on a 60 mm target gives a much worse pose (synthetic noise only)", () => {
    const small = worstErrors(grid, 0.3); // 60 mm across at 340 mm
    const big = worstErrors(sheet, 0.3);
    expect(small.worstPos).toBeGreaterThan(2 * big.worstPos);
    expect(small.worstPos).toBeGreaterThan(4); // several millimetres of camera-position error from 0.3 px of noise
  });

  it("scale comes from the known point spacing: the camera distance is recovered in millimetres", () => {
    const truth = lookAt([0, -50, 250], [0, 0, 0], [0, -1, 0]);
    const r = poseFromPlanarPoints(K, grid, observe(K, truth, grid));
    expect(r.ok).toBe(true);
    if (r.ok) near(Math.hypot(...cameraCenter(r.pose)), Math.hypot(0, 50, 250), 1e-2);
  });

  it("warns about the flip ambiguity near fronto-parallel and not when clearly tilted", () => {
    const flat = lookAt([0.01, -0.01, 340], [0, 0, 0], [0, -1, 0]);
    const a = poseFromPlanarPoints(K, grid, observe(K, flat, grid));
    expect(a.ok && a.ambiguityWarning).toMatch(/fronto-parallel/);
    const tilted = lookAt([150, -120, 300], [0, 0, 0], [0, -1, 0]);
    const b = poseFromPlanarPoints(K, grid, observe(K, tilted, grid));
    expect(b.ok && b.ambiguityWarning).toBeNull();
  });

  it("refuses too few or degenerate points", () => {
    expect(poseFromPlanarPoints(K, grid.slice(0, 3), grid.slice(0, 3))).toEqual({ ok: false, reason: "too_few_points" });
    const line: Pt[] = [0, 1, 2, 3, 4].map((i) => ({ x: i * 10, y: 0 }));
    const r = poseFromPlanarPoints(K, line, line.map((p) => ({ x: 600 + p.x, y: 360 })));
    expect(r.ok).toBe(false);
  });

  it("a point set that is not actually coplanar-and-known shows up as a large reprojection error", () => {
    const truth = lookAt([70, -90, 340], [0, 0, 0], [0, -1, 0]);
    const obs = observe(K, truth, grid);
    const wrong = grid.map((p, i) => ({ x: p.x + (i % 3) * 6, y: p.y }));
    const r = poseFromPlanarPoints(K, wrong, obs);
    expect(r.ok && r.reprojRmsPx).toBeGreaterThan(1);
  });
});

describe("a single circle cannot do this", () => {
  it("many 3D circle points give an ellipse, but the pose from the ellipse alone is not unique: two tilts of opposite sign image identically", () => {
    const K = intrinsicsFromHfov(1280, 720, 70);
    const D = 24.26;
    const ring = (): V3[] => Array.from({ length: 36 }, (_, i) => [(D / 2) * Math.cos((i * 10 * Math.PI) / 180), (D / 2) * Math.sin((i * 10 * Math.PI) / 180), 0]);
    // two cameras, mirrored left-right about the optical axis, see mirrored ellipses of the same axes: tilt sign is not observable
    const a = lookAt([60, 0, 300], [0, 0, 0], [0, -1, 0]);
    const b = lookAt([-60, 0, 300], [0, 0, 0], [0, -1, 0]);
    const axes = (pose: ReturnType<typeof lookAt>) => {
      const px = ring().map((X) => project(K, pose, X)!);
      const xs = px.map((p) => p.x);
      const ys = px.map((p) => p.y);
      return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    };
    const [ax, ay] = axes(a);
    const [bx, by] = axes(b);
    near(ax, bx, 1e-6);
    near(ay, by, 1e-6);
  });
});
