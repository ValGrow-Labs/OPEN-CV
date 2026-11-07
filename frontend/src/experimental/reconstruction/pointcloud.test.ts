// Point-cloud tools on analytic shapes (SYNTHETIC: this proves the maths, not any phone's depth).
import { describe, expect, it } from "vitest";
import { intrinsicsFor, lookAtPose, mat3MulVec, rotationAngleDeg, rotationAxisAngle } from "./linalg";
import { meshArea } from "./meshing";
import { backprojectDepth, cameraCloudToWorld, fuseClouds, icp, pointCount, transformCloud, triangulateDepthGrid, type DepthMap, type PointCloud } from "./pointcloud";
import { makeRng } from "./rng";
import { sphereDepth, visibleCapArea } from "./testSupport";

describe("depth back-projection", () => {
  const K = intrinsicsFor(160, 160, 30);
  const R = 40;
  const D = 300;
  const { depth, mask } = sphereDepth(K, R, D);

  it("puts every back-projected point of a sphere on the sphere", () => {
    const cloud = backprojectDepth(depth, mask, K);
    expect(pointCount(cloud)).toBeGreaterThan(1000);
    let worst = 0;
    for (let i = 0; i < cloud.points.length; i += 3) worst = Math.max(worst, Math.abs(Math.hypot(cloud.points[i], cloud.points[i + 1], cloud.points[i + 2] - D) - R));
    expect(worst).toBeLessThan(0.01); // float32 only
  });

  it("skips invalid depth and never fills it in", () => {
    const bad: DepthMap = { width: 4, height: 4, data: Float32Array.from([0, NaN, -5, 20, 100, 200, 5000, 300, 400, 0, 0, 0, 0, 0, 0, 0]) };
    const cloud = backprojectDepth(bad, null, intrinsicsFor(4, 4, 30), { minMm: 30, maxMm: 3000 });
    expect(pointCount(cloud)).toBe(4); // 100, 200, 300, 400
    for (let i = 2; i < cloud.points.length; i += 3) expect([100, 200, 300, 400]).toContain(Math.round(cloud.points[i]));
  });

  it("keeps only the pixels inside the mask, and honours a confidence floor", () => {
    const half: typeof mask = { ...mask, data: mask.data.map((v, i) => (i % mask.width < mask.width / 2 ? v : 0)) as Uint8Array };
    const all = backprojectDepth(depth, mask, K);
    const left = backprojectDepth(depth, half, K);
    expect(pointCount(left)).toBeLessThan(pointCount(all));
    const conf = new Float32Array(depth.data.length).fill(0.2);
    expect(pointCount(backprojectDepth({ ...depth, confidence: conf }, mask, K, { minConfidence: 0.5 }))).toBe(0);
  });

  it("maps camera-frame points back to the world through a pose", () => {
    const pose = lookAtPose([200, -300, 100], [0, 0, 0], [0, 0, 1]);
    // a world point, into the camera frame, then back
    const X = [10, 20, 30];
    const xc = mat3MulVec(pose.R, X);
    const cam: PointCloud = { points: Float32Array.from([xc[0] + pose.t[0], xc[1] + pose.t[1], xc[2] + pose.t[2]]) };
    const world = cameraCloudToWorld(cam, pose);
    for (let k = 0; k < 3; k++) expect(world.points[k]).toBeCloseTo(X[k], 3);
  });
});

describe("rigid transform and ICP on a bumpy patch (asymmetric, so the pose is unique)", () => {
  const patch = (): PointCloud => {
    const pts: number[] = [];
    for (let x = -50; x <= 50; x += 2.5) for (let y = -50; y <= 50; y += 2.5) pts.push(x, y, 6 * Math.sin(x / 11) + 5 * Math.cos(y / 8) + 0.02 * x * y);
    return { points: Float32Array.from(pts) };
  };

  it("recovers a known small rotation and translation", () => {
    const dst = patch();
    const R = rotationAxisAngle([0.2, 0.4, 1], (3 * Math.PI) / 180);
    const t: [number, number, number] = [2, -1, 1.5];
    const src = transformCloud(dst, R, t);
    const out = icp(src, dst, { maxDistMm: 12 });
    expect(out.converged).toBe(true);
    expect(out.rms).toBeLessThan(0.05);
    // the recovered transform undoes the one applied: R_out * R ~ identity
    const comp = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => [0, 1, 2].reduce((s, k) => s + out.R[i * 3 + k] * R[k * 3 + j], 0)));
    expect(rotationAngleDeg(comp)).toBeLessThan(0.1);
  });

  it("is not dragged by outliers, thanks to trimmed matches", () => {
    const dst = patch();
    const R = rotationAxisAngle([0, 0, 1], (2 * Math.PI) / 180);
    const moved = transformCloud(dst, R, [1.5, 1, 0.5]);
    const rng = makeRng(5);
    const junk: number[] = [];
    for (let i = 0; i < 80; i++) junk.push(rng() * 100 - 50, rng() * 100 - 50, rng() * 30 + 10);
    const src: PointCloud = { points: Float32Array.from([...moved.points, ...junk]) };
    const out = icp(src, dst, { maxDistMm: 12, trimFraction: 0.8 });
    const comp = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => [0, 1, 2].reduce((s, k) => s + out.R[i * 3 + k] * R[k * 3 + j], 0)));
    expect(rotationAngleDeg(comp)).toBeLessThan(0.5);
    expect(out.rms).toBeLessThan(0.5);
  });

  it("reports a poor start rather than a false success when nothing is near", () => {
    const dst = patch();
    const far = transformCloud(dst, [1, 0, 0, 0, 1, 0, 0, 0, 1], [500, 0, 0]);
    const out = icp(far, dst, { maxDistMm: 10, maxIterations: 5 });
    expect(out.matchedFraction).toBe(0);
    expect(out.converged).toBe(false);
  });
});

describe("voxel fusion", () => {
  it("merges nearby duplicates and keeps distant points apart", () => {
    const a: PointCloud = { points: Float32Array.from([0, 0, 0, 10, 0, 0, 20, 0, 0]), confidence: Float32Array.from([0.5, 0.5, 0.5]) };
    const b: PointCloud = { points: Float32Array.from([0.4, 0.2, 0, 10.3, 0, 0.1, 40, 0, 0]), confidence: Float32Array.from([0.9, 0.1, 0.7]) };
    const fused = fuseClouds([a, b], 2);
    expect(pointCount(fused)).toBe(4); // two merged pairs, 20 and 40 alone
    expect(Math.max(...fused.confidence!)).toBeCloseTo(0.9, 6);
  });

  it("an empty set fuses to an empty cloud", () => {
    expect(pointCount(fuseClouds([], 2))).toBe(0);
  });
});

describe("depth-grid triangulation", () => {
  const K = intrinsicsFor(120, 120, 20);

  it("a fronto-parallel plane has the area of the plane and the triangles face the camera", () => {
    const z = 300;
    const depth: DepthMap = { width: 120, height: 120, data: new Float32Array(120 * 120).fill(z) };
    const mesh = triangulateDepthGrid(depth, null, K, 6);
    const halfSpan = (119 * z) / K.fx; // the covered span between the first and last pixel centres
    const expected = halfSpan * halfSpan;
    expect(meshArea(mesh)).toBeGreaterThan(expected * 0.99);
    expect(meshArea(mesh)).toBeLessThan(expected * 1.01);
    let nz = 0;
    const V = mesh.vertices, I = mesh.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      nz += (V[b] - V[a]) * (V[c + 1] - V[a + 1]) - (V[b + 1] - V[a + 1]) * (V[c] - V[a]);
    }
    expect(nz).toBeLessThan(0); // normals point toward the camera (-z)
  });

  it("does not span a depth jump with triangles (no sheet across a silhouette edge)", () => {
    const data = new Float32Array(120 * 120);
    for (let v = 0; v < 120; v++) for (let u = 0; u < 120; u++) data[v * 120 + u] = u < 60 ? 300 : 360;
    const mesh = triangulateDepthGrid({ width: 120, height: 120, data }, null, K, 6);
    const V = mesh.vertices, I = mesh.indices;
    let longest = 0;
    for (let t = 0; t < I.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = I[t + e] * 3, b = I[t + ((e + 1) % 3)] * 3;
        longest = Math.max(longest, Math.hypot(V[a] - V[b], V[a + 1] - V[b + 1], V[a + 2] - V[b + 2]));
      }
    expect(longest).toBeLessThan(6 * 1.5 + 1e-3);
    // nothing joins the two planes
    const zs = new Set<number>();
    for (let t = 0; t < I.length; t += 3) {
      const planes = [0, 1, 2].map((e) => (V[I[t + e] * 3 + 2] < 330 ? 0 : 1));
      zs.add(new Set(planes).size);
    }
    expect([...zs]).toEqual([1]);
  });

  it("the central cap of a sphere (a well-sampled patch) has the analytic area within 2 %", () => {
    const R = 40, d = 300, phi0 = (40 * Math.PI) / 180;
    const Ks = intrinsicsFor(400, 400, 24);
    const { depth, mask } = sphereDepth(Ks, R, d);
    const r0 = (Ks.fx * R * Math.sin(phi0)) / (d - R * Math.cos(phi0)); // pixel radius of the circle at polar angle phi0
    const cap = { ...mask, data: mask.data.map((v, i) => (v && Math.hypot((i % Ks.width) + 0.5 - Ks.cx, Math.floor(i / Ks.width) + 0.5 - Ks.cy) <= r0 ? 255 : 0)) as Uint8Array };
    const analytic = 2 * Math.PI * R * R * (1 - Math.cos(phi0));
    const area = meshArea(triangulateDepthGrid(depth, cap, Ks, 20));
    expect(area).toBeGreaterThan(analytic * 0.97);
    expect(area).toBeLessThan(analytic * 1.03);
  });

  it("a single depth map cannot see the grazing rim of a sphere: the whole visible cap is always a little under-measured, less so at finer sampling", () => {
    const analytic = visibleCapArea(40, 300);
    const at = (px: number) => {
      const Ks = intrinsicsFor(px, px, 24);
      const { depth, mask } = sphereDepth(Ks, 40, 300);
      return meshArea(triangulateDepthGrid(depth, mask, Ks, 80));
    };
    const coarse = at(100), mid = at(200), fine = at(400);
    expect(fine).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(coarse);
    expect(fine).toBeLessThan(analytic * 1.02); // never over-measures
    expect(fine).toBeGreaterThan(analytic * 0.85);
  });
});
