// Surface distance on hand-made boxes (TEST FIXTURES: invented shapes with known distances).
import { describe, expect, it } from "vitest";
import { boardLabels, boxesMesh, SUPPORT_LABELS } from "./__fixtures__/fixtures";
import { CAD_TOLERANCE_NOTE, closestOnTriangle, distanceStats, surfaceDistance, TriangleGrid } from "./surfaceDistance";
import type { Mesh } from "../common";

const reference = boxesMesh([{ min: [0, 0, 0], max: [40, 20, 10] }], 1);
const bigger = boxesMesh([{ min: [-1, -1, 0], max: [41, 21, 11] }], 1); // 1 mm outside on every side but the base
const recon = (m: Mesh) => ({ mesh: m, support: boardLabels(m), supportLabels: SUPPORT_LABELS });

const moved = (m: Mesh, yawDeg: number, t: [number, number, number]): Mesh => {
  const a = (yawDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const V = new Float32Array(m.vertices.length);
  for (let i = 0; i < V.length; i += 3) {
    const x = m.vertices[i], y = m.vertices[i + 1], z = m.vertices[i + 2];
    V[i] = c * x - s * y + t[0];
    V[i + 1] = s * x + c * y + t[1];
    V[i + 2] = z + t[2];
  }
  return { vertices: V, indices: m.indices };
};

describe("closest point and grid", () => {
  it("closest point on a triangle: face, edge and corner regions", () => {
    const a: [number, number, number] = [0, 0, 0], b: [number, number, number] = [10, 0, 0], c: [number, number, number] = [0, 10, 0];
    expect(closestOnTriangle([2, 2, 5], a, b, c)).toEqual([2, 2, 0]);
    expect(closestOnTriangle([5, -3, 0], a, b, c)).toEqual([5, 0, 0]);
    expect(closestOnTriangle([-2, -2, 1], a, b, c)).toEqual(a);
  });
  it("signed distance: + outside, - inside a closed outward mesh; exact far away", () => {
    const g = new TriangleGrid(reference.vertices, reference.indices);
    expect(g.closest([20, 10, 13]).signed).toBeCloseTo(3, 3);
    expect(g.closest([20, 10, 8]).signed).toBeCloseTo(-2, 3);
    expect(g.closest([20, 10, 210]).dist).toBeCloseTo(200, 3); // beyond the ring search: falls back to all triangles
  });
  it("statistics", () => {
    const s = distanceStats([1, 2, 3, 4], [1, -2, 3, -4]);
    expect(s).toMatchObject({ n: 4, meanMm: 2.5, medianMm: 2.5, maxMm: 4, p95Mm: 4, signedMeanMm: -0.5 });
    expect(s.rmsMm).toBeCloseTo(Math.sqrt(7.5), 10);
  });
});

describe("surfaceDistance", () => {
  it("fixed alignment: a reconstruction 1 mm outside reads about +1 mm, coverage 100 % within 2 mm", () => {
    const r = surfaceDistance({ reconstruction: recon(bigger), reference, referenceKind: "cad_nominal", transform: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] } });
    expect(r.ok).toBe(true);
    expect(r.alignment!.method).toBe("fixed");
    expect(r.meshToReference.medianMm).toBeCloseTo(1, 1);
    expect(r.meshToReference.signedMeanMm!).toBeGreaterThan(0.9);
    expect(r.referenceToMesh.medianMm).toBeCloseTo(1, 1);
    expect(r.coverage.share).toBe(1);
    expect(r.coverage.baseAreaExcludedMm2).toBeGreaterThan(700); // the 40 x 20 base, roughly
    expect(r.perLabel.support_plane.n).toBeGreaterThan(0); // board vertices reported apart
    expect(r.meshToReference.n).toBe(r.perLabel.observed.n);
    expect(r.notes).toContain(CAD_TOLERANCE_NOTE);
  });

  it("coarse board-frame + PCA, then ICP, recovers a reference given in another frame", () => {
    const ref2 = moved(reference, 30, [10, -5, 3]);
    const r = surfaceDistance({ reconstruction: recon(reference), reference: ref2, referenceKind: "scan" });
    expect(r.ok).toBe(true);
    expect(r.alignment!.method).toBe("board-pca+icp");
    expect(r.alignment!.candidates).toHaveLength(2);
    expect(r.alignment!.baseTiltDeg).toBeLessThan(1);
    expect(r.meshToReference.meanMm!).toBeLessThan(0.2);
    expect(r.coverage.share!).toBeGreaterThan(0.99);
    expect(r.notes.some((n) => /scan of the printed part/.test(n))).toBe(true);
  });

  it("refuses without support labels", () => {
    const r = surfaceDistance({ reconstruction: { mesh: reference, support: null, supportLabels: [] }, reference, referenceKind: "cad_nominal" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/support labels/);
  });
});
