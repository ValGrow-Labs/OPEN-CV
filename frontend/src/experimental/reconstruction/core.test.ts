// Foundation tests: camera maths, rigid alignment, isosurface extraction and carving on analytic shapes (SYNTHETIC).
import { describe, expect, it } from "vitest";
import type { BinaryMask } from "../common";
import { carveVisualHull, unconstrainedSurfaceFraction, viewCoverage, voxelVolumeMm3 } from "./carving";
import { cameraCenter, intrinsicsFor, lookAtPose, mat3MulVec, pixelRay, projectPoint, rigidAlign, rotationAngleDeg, rotationAxisAngle, symmetricEigen } from "./linalg";
import { extractMesh, meshArea, meshVolume, occupancyToField, removeSmallComponents, sdfToField, taubinSmooth, topologyReport } from "./meshing";
import { makeRng } from "./rng";

const sphereSdf = (r: number) => (x: number, y: number, z: number) => Math.hypot(x, y, z) - r;

describe("camera maths", () => {
  it("looks at the target: the target projects to the principal point, in front of the camera", () => {
    const K = intrinsicsFor(200, 100, 50);
    const pose = lookAtPose([300, 50, -20], [10, 20, 30], [0, 0, 1]);
    const p = projectPoint([10, 20, 30], K, pose)!;
    expect(p.u).toBeCloseTo(100, 6);
    expect(p.v).toBeCloseTo(50, 6);
    expect(p.z).toBeGreaterThan(0);
    expect(cameraCenter(pose).map((x) => Math.round(x * 1e6) / 1e6)).toEqual([300, 50, -20]);
  });

  it("puts world 'up' at the top of the picture and the camera's right on the right", () => {
    const K = intrinsicsFor(200, 200, 60);
    const pose = lookAtPose([0, -300, 0], [0, 0, 0], [0, 0, 1]); // looking along +y, up = +z
    const above = projectPoint([0, 0, 40], K, pose)!;
    const right = projectPoint([40, 0, 0], K, pose)!;
    expect(above.v).toBeLessThan(100); // smaller v = higher in the picture
    expect(right.u).toBeGreaterThan(100);
  });

  it("a pixel's ray goes through the point that projects to that pixel", () => {
    const K = intrinsicsFor(320, 240, 45);
    const pose = lookAtPose([200, 100, 150], [0, 0, 0], [0, 0, 1]);
    const { origin, dir } = pixelRay(150, 80, K, pose);
    const X = [origin[0] + dir[0] * 250, origin[1] + dir[1] * 250, origin[2] + dir[2] * 250];
    const p = projectPoint(X, K, pose)!;
    expect(p.u).toBeCloseTo(150.5, 6);
    expect(p.v).toBeCloseTo(80.5, 6);
  });

  it("applies radial distortion in projection only when asked", () => {
    const K = { ...intrinsicsFor(200, 200, 60), k1: 0.1 };
    const pose = lookAtPose([0, -300, 0], [0, 0, 0], [0, 0, 1]);
    const plain = projectPoint([60, 0, 0], intrinsicsFor(200, 200, 60), pose)!;
    const dist = projectPoint([60, 0, 0], K, pose)!;
    expect(dist.u).toBeGreaterThan(plain.u);
  });
});

describe("rigid alignment (Horn / Kabsch)", () => {
  it("recovers a known rotation and translation exactly from clean correspondences", () => {
    const rng = makeRng(3);
    const R = rotationAxisAngle([0.3, -0.5, 0.8], 0.7);
    const t = [12, -7, 30];
    const src: number[] = [];
    const dst: number[] = [];
    for (let i = 0; i < 40; i++) {
      const p = [rng() * 100 - 50, rng() * 100 - 50, rng() * 100 - 50];
      src.push(...p);
      const q = mat3MulVec(R, p);
      dst.push(q[0] + t[0], q[1] + t[1], q[2] + t[2]);
    }
    const out = rigidAlign(src, dst);
    expect(out.rms).toBeLessThan(1e-4);
    for (let i = 0; i < 9; i++) expect(out.R[i]).toBeCloseTo(R[i], 5);
    for (let i = 0; i < 3; i++) expect(out.t[i]).toBeCloseTo(t[i], 3);
    expect(rotationAngleDeg(out.R)).toBeCloseTo((0.7 * 180) / Math.PI, 3);
  });

  it("returns a proper rotation (not a reflection) for noisy data", () => {
    const rng = makeRng(8);
    const src: number[] = [];
    const dst: number[] = [];
    for (let i = 0; i < 60; i++) {
      const p = [rng() * 80, rng() * 80, rng() * 80];
      src.push(...p);
      dst.push(p[0] + 5 + (rng() - 0.5), p[1] - 3 + (rng() - 0.5), p[2] + (rng() - 0.5));
    }
    const { R } = rigidAlign(src, dst);
    const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
    expect(det).toBeCloseTo(1, 6);
  });

  it("finds eigenvalues of a symmetric matrix in descending order", () => {
    const { values } = symmetricEigen([2, 0, 0, 0, 5, 0, 0, 0, 3], 3);
    expect(values).toEqual([5, 3, 2]);
  });
});

describe("isosurface extraction (marching tetrahedra) on a sphere", () => {
  const r = 20;
  const field = sdfToField(sphereSdf(r), { min: [-26, -26, -26], max: [26, 26, 26] }, 1);
  const mesh = extractMesh(field, 0);

  it("is watertight with the topology of a sphere", () => {
    const rep = topologyReport(mesh);
    expect(rep.watertight).toBe(true);
    expect(rep.components).toBe(1);
    expect(rep.eulerCharacteristic).toBe(2);
    expect(rep.holes).toBe(0);
  });

  it("has area and volume of a sphere within a small tolerance, with outward-facing triangles", () => {
    expect(meshArea(mesh)).toBeGreaterThan(4 * Math.PI * r * r * 0.97);
    expect(meshArea(mesh)).toBeLessThan(4 * Math.PI * r * r * 1.03);
    const vol = meshVolume(mesh);
    expect(vol).toBeGreaterThan(0); // positive = outward orientation
    expect(vol).toBeGreaterThan(((4 / 3) * Math.PI * r ** 3) * 0.97);
    expect(vol).toBeLessThan(((4 / 3) * Math.PI * r ** 3) * 1.03);
  });

  it("smoothing keeps the size (no shrinkage) and the topology", () => {
    const smooth = taubinSmooth(mesh, { iterations: 10 });
    expect(meshArea(smooth)).toBeGreaterThan(meshArea(mesh) * 0.97);
    expect(meshArea(smooth)).toBeLessThan(meshArea(mesh) * 1.01);
    expect(topologyReport(smooth).watertight).toBe(true);
  });

  it("removes a floating speck but keeps the big surface", () => {
    const speck = extractMesh(sdfToField(sphereSdf(2), { min: [-6, -6, -6], max: [6, 6, 6] }, 0.5), 0);
    const off = speck.vertices.map((x, i) => (i % 3 === 0 ? x + 60 : x));
    const merged = {
      vertices: Float32Array.from([...mesh.vertices, ...off]),
      indices: Uint32Array.from([...mesh.indices, ...Array.from(speck.indices, (i) => i + mesh.vertices.length / 3)]),
    };
    expect(topologyReport(merged).components).toBe(2);
    const cleaned = removeSmallComponents(merged, 0.05);
    expect(cleaned.removed).toBe(1);
    expect(topologyReport(cleaned.mesh).components).toBe(1);
  });

  it("reports a hole when triangles are missing", () => {
    const n = mesh.indices.length / 3;
    const open = { vertices: mesh.vertices, indices: mesh.indices.slice(0, (n - 30) * 3) };
    const rep = topologyReport(open);
    expect(rep.watertight).toBe(false);
    expect(rep.boundaryEdges).toBeGreaterThan(0);
    expect(rep.holes).toBeGreaterThanOrEqual(1);
  });
});

/** Silhouette of a sphere of radius r at the origin, seen by an exact pinhole camera. */
function sphereMask(K: ReturnType<typeof intrinsicsFor>, pose: ReturnType<typeof lookAtPose>, r: number): BinaryMask {
  const data = new Uint8Array(K.width * K.height);
  const c = cameraCenter(pose);
  const dist = Math.hypot(c[0], c[1], c[2]);
  const half = Math.asin(r / dist);
  for (let j = 0; j < K.height; j++)
    for (let i = 0; i < K.width; i++) {
      const { dir } = pixelRay(i, j, K, pose);
      const toCenter = [-c[0] / dist, -c[1] / dist, -c[2] / dist];
      const ang = Math.acos(Math.min(1, dir[0] * toCenter[0] + dir[1] * toCenter[1] + dir[2] * toCenter[2]));
      if (ang <= half) data[j * K.width + i] = 255;
    }
  return { width: K.width, height: K.height, data };
}

describe("visual hull of a sphere from three exact silhouettes (SYNTHETIC)", () => {
  const r = 25;
  const K = intrinsicsFor(200, 200, 40);
  const poses = [lookAtPose([0, 0, 300], [0, 0, 0], [0, 1, 0]), lookAtPose([300, 0, 0], [0, 0, 0], [0, 1, 0]), lookAtPose([0, 300, 0], [0, 0, 0], [0, 0, 1])];
  const views = poses.map((pose) => ({ mask: sphereMask(K, pose, r), intrinsics: K, pose }));
  const bounds = { min: [-40, -40, -40] as [number, number, number], max: [40, 40, 40] as [number, number, number] };

  it("is never smaller than the sphere and not much larger (three orthogonal views give the Steinmetz-like hull)", () => {
    const occ = carveVisualHull(views, bounds, { voxelMm: 1 });
    const vol = voxelVolumeMm3(occ);
    const sphere = (4 / 3) * Math.PI * r ** 3;
    expect(vol).toBeGreaterThan(sphere * 0.98); // a hull contains the object
    expect(vol).toBeLessThan(sphere * 1.45); // three cylinders intersect to ~ 1.26 x sphere volume (perspective adds a little)
  });

  it("with only one view the hull is a long prism, and with a tolerance of 1 it is at least as large", () => {
    const one = carveVisualHull(views.slice(0, 1), bounds, { voxelMm: 2 });
    expect(voxelVolumeMm3(one)).toBeGreaterThan(((4 / 3) * Math.PI * r ** 3) * 1.8);
    const strict = carveVisualHull(views, bounds, { voxelMm: 2 });
    const loose = carveVisualHull(views, bounds, { voxelMm: 2, tolerance: 1 });
    expect(voxelVolumeMm3(loose)).toBeGreaterThanOrEqual(voxelVolumeMm3(strict));
  });

  it("support counts and the observed counts are consistent", () => {
    const occ = carveVisualHull(views, bounds, { voxelMm: 2 });
    for (let i = 0; i < occ.occupancy.length; i += 97) {
      expect(occ.support[i]).toBeLessThanOrEqual(occ.observed[i]);
      expect(occ.observed[i]).toBeLessThanOrEqual(occ.nViews);
      if (occ.occupancy[i]) expect(occ.support[i]).toBe(occ.nViews);
    }
  });

  it("meshes the hull into one watertight surface", () => {
    const occ = carveVisualHull(views, bounds, { voxelMm: 1.5 });
    const mesh = extractMesh(occupancyToField(occ, 2), 0.5);
    const rep = topologyReport(mesh);
    expect(rep.watertight).toBe(true);
    expect(rep.components).toBe(1);
  });
});

describe("view coverage (SYNTHETIC rigs)", () => {
  const c: [number, number, number] = [0, 0, 0];
  const cams = (dirs: [number, number, number][]) => dirs.map((d) => ({ pose: lookAtPose([d[0] * 300, d[1] * 300, d[2] * 300], c, Math.abs(d[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0]) }));

  it("two opposite views leave a whole half-space unseen; four views around the axis are better; adding the axis view is best", () => {
    const two = viewCoverage(cams([[0, 0, 1], [0, 0, -1]]), c);
    const four = viewCoverage(cams([[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]]), c);
    const five = viewCoverage(cams([[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0]]), c);
    expect(two.coverageRadiusDeg).toBeGreaterThan(80);
    expect(four.coverageRadiusDeg).toBeLessThan(two.coverageRadiusDeg);
    expect(five.coverageRadiusDeg).toBeLessThan(four.coverageRadiusDeg);
    expect(two.maxSpreadDeg).toBeLessThan(1); // opposite views carry the same silhouette
  });

  it("the unconstrained surface of a prism hull from two opposite views is large; with a side view it drops", () => {
    const K = intrinsicsFor(160, 160, 40);
    const r = 25;
    const mk = (poses: ReturnType<typeof lookAtPose>[]) => poses.map((pose) => ({ mask: sphereMask(K, pose, r), intrinsics: K, pose }));
    const pz = lookAtPose([0, 0, 300], c, [0, 1, 0]);
    const nz = lookAtPose([0, 0, -300], c, [0, 1, 0]);
    const px = lookAtPose([300, 0, 0], c, [0, 1, 0]);
    const bounds = { min: [-40, -40, -40] as [number, number, number], max: [40, 40, 40] as [number, number, number] };
    const two = mk([pz, nz]);
    const three = mk([pz, nz, px]);
    const hull2 = carveVisualHull(two, bounds, { voxelMm: 2 });
    const hull3 = carveVisualHull(three, bounds, { voxelMm: 2 });
    expect(unconstrainedSurfaceFraction(hull2, two)).toBeGreaterThan(unconstrainedSurfaceFraction(hull3, three));
  });
});
