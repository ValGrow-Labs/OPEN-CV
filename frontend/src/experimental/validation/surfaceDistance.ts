// Surface distance between the reconstructed mesh and a REFERENCE MESH of the phantom (EXPERIMENTAL validation): a CAD
// model of the printed phantom, or a reference scan of it.
//
//   alignment  fixed (a supplied reference-to-board transform), or coarse by the board frame + PCA (the reference's base
//              plane, its lowest z, rests on the board plane z = 0 with +z up; yaw from the 2D principal axes of the two
//              footprints, both directions tried) then trimmed ICP (reconstruction/pointcloud.ts) on the observed surface;
//   distances  mesh -> reference: every reconstructed vertex labelled observed or implied, point-to-surface (closest point
//              on a reference triangle); vertices on the board plane, the forearm cut or the search box are reported
//              SEPARATELY, never in the main figures;
//              reference -> mesh: area-uniform samples of the reference surface, excluding its base face (it lies on the
//              board and no camera sees it), to the reconstruction's observed/implied triangles;
//   figures    mean, RMS, median, p95, max (the Hausdorff distance is the larger max of the two directions), signed mean
//              (positive = the reconstruction lies OUTSIDE the reference), coverage (share of the reference's non-base
//              area within `coverageMm` of the reconstruction). Reference area nearer to the reconstruction's own cut
//              faces (volume_cut, truncated: the forearm end, the search box) than to its hand surface is excluded and
//              reported.
// A nominal CAD differs from the printed part by the print tolerance: unless the printed part itself was scanned, every
// figure here includes that difference.
import type { Mesh } from "../common";
import { icp, transformCloud } from "../reconstruction/pointcloud";
import { mat3MulVec, symmetricEigen, type Mat3, type Vec3 } from "../reconstruction/linalg";
import { meshVolume } from "../reconstruction/meshing";
import { makeRng } from "../reconstruction/rng";
import { median } from "../reconstruction/stats";
import { percentile } from "./compare";

export const CAD_TOLERANCE_NOTE =
  "The reference is a NOMINAL CAD: the printed part differs from it by the print tolerance (and any shrink or warp), so every distance includes that difference. Only a scan of the printed part removes it.";

export interface RigidTransform {
  /** x_board = R x_ref + t; R row-major. */
  R: number[];
  t: Vec3;
}

export interface SurfaceDistanceInput {
  reconstruction: { mesh: Mesh; support: Uint8Array | null; supportLabels: readonly string[] };
  reference: Mesh;
  referenceKind: "cad_nominal" | "scan";
  /** Fixed reference-to-board transform: used as is (no ICP) unless `refine` is true. */
  transform?: RigidTransform | null;
  refine?: boolean;
  coverageMm?: number;
  /** Reference samples within this height of the board plane (after alignment) are the base face. Default 1 mm. */
  baseTolMm?: number;
  /** Mean spacing of the reference surface samples (mm). Default 1. */
  sampleSpacingMm?: number;
  maxReferenceSamples?: number;
}

export interface DistanceStats {
  n: number;
  meanMm: number | null;
  rmsMm: number | null;
  medianMm: number | null;
  p95Mm: number | null;
  maxMm: number | null;
  signedMeanMm: number | null;
}

export interface SurfaceDistanceResult {
  ok: boolean;
  reason: string | null;
  referenceKind: "cad_nominal" | "scan";
  alignment: {
    method: "fixed" | "fixed+icp" | "board-pca+icp";
    transform: RigidTransform;
    icpRmsMm: number | null;
    icpMatchedFraction: number | null;
    /** Angle between the reference's +z and the board's +z after alignment (a tilted base means the coarse frame failed). */
    baseTiltDeg: number;
    candidates: { yawDeg: number; rmsMm: number; matched: number }[];
  } | null;
  meshToReference: DistanceStats;
  /** Every support label separately (observed, implied, support_plane, volume_cut, truncated). */
  perLabel: Record<string, DistanceStats>;
  referenceToMesh: DistanceStats;
  hausdorffMm: number | null;
  coverage: {
    thresholdMm: number;
    share: number | null;
    referenceAreaMm2: number;
    baseAreaExcludedMm2: number;
    /** Reference area nearer to the reconstruction's cut faces (volume_cut, truncated) than to its hand surface. */
    cutAreaExcludedMm2: number;
  };
  notes: string[];
}

const EMPTY: DistanceStats = { n: 0, meanMm: null, rmsMm: null, medianMm: null, p95Mm: null, maxMm: null, signedMeanMm: null };

export function distanceStats(unsigned: readonly number[], signed?: readonly number[]): DistanceStats {
  const n = unsigned.length;
  if (!n) return EMPTY;
  return {
    n,
    meanMm: unsigned.reduce((s, x) => s + x, 0) / n,
    rmsMm: Math.sqrt(unsigned.reduce((s, x) => s + x * x, 0) / n),
    medianMm: median(unsigned),
    p95Mm: percentile(unsigned, 95),
    maxMm: Math.max(...unsigned),
    signedMeanMm: signed && signed.length ? signed.reduce((s, x) => s + x, 0) / signed.length : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Closest point on a triangle mesh

/** Closest point to p on triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const d1 = ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2], d2 = ac[0] * ap[0] + ac[1] * ap[1] + ac[2] * ap[2];
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = ab[0] * bp[0] + ab[1] * bp[1] + ab[2] * bp[2], d4 = ac[0] * bp[0] + ac[1] * bp[1] + ac[2] * bp[2];
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]; } // fmt: skip
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = ab[0] * cp[0] + ab[1] * cp[1] + ab[2] * cp[2], d6 = ac[0] * cp[0] + ac[1] * cp[1] + ac[2] * cp[2];
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; } // fmt: skip
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** A uniform grid of triangles for closest-point queries. */
export class TriangleGrid {
  private cells = new Map<number, number[]>();
  private normals: Float64Array;
  private boxes: Float32Array;
  private stamp: Uint32Array;
  private query = 0;
  private min: Vec3;
  constructor(
    private V: Float32Array,
    private tris: Uint32Array,
    private cell = 3,
  ) {
    const nt = tris.length / 3;
    this.normals = new Float64Array(nt * 3);
    this.boxes = new Float32Array(nt * 6);
    this.stamp = new Uint32Array(nt);
    this.min = [Infinity, Infinity, Infinity];
    for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) this.min[k] = Math.min(this.min[k], V[i + k]);
    for (let t = 0; t < nt; t++) {
      const a = this.vtx(tris[t * 3]), b = this.vtx(tris[t * 3 + 1]), c = this.vtx(tris[t * 3 + 2]);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      this.normals.set([nx / l, ny / l, nz / l], t * 3);
      for (let k = 0; k < 3; k++) { this.boxes[t * 6 + k] = Math.min(a[k], b[k], c[k]); this.boxes[t * 6 + 3 + k] = Math.max(a[k], b[k], c[k]); } // fmt: skip
      const lo = [0, 1, 2].map((k) => Math.floor((Math.min(a[k], b[k], c[k]) - this.min[k]) / cell));
      const hi = [0, 1, 2].map((k) => Math.floor((Math.max(a[k], b[k], c[k]) - this.min[k]) / cell));
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        const key = this.key(x, y, z);
        (this.cells.get(key) ?? this.cells.set(key, []).get(key)!).push(t);
      } // fmt: skip
    }
  }
  get triangleCount(): number {
    return this.tris.length / 3;
  }
  private vtx(i: number): Vec3 {
    return [this.V[i * 3], this.V[i * 3 + 1], this.V[i * 3 + 2]];
  }
  private key(x: number, y: number, z: number): number {
    return ((x + 2048) * 4096 + (y + 2048)) * 4096 + (z + 2048);
  }
  private test(t: number, p: Vec3, best: { d: number; t: number; q: Vec3 }) {
    // lower bound: the distance to the triangle's bounding box
    const B = this.boxes, o = t * 6;
    const dx = Math.max(B[o] - p[0], 0, p[0] - B[o + 3]), dy = Math.max(B[o + 1] - p[1], 0, p[1] - B[o + 4]), dz = Math.max(B[o + 2] - p[2], 0, p[2] - B[o + 5]);
    if (dx * dx + dy * dy + dz * dz >= best.d * best.d) return;
    const q = closestOnTriangle(p, this.vtx(this.tris[t * 3]), this.vtx(this.tris[t * 3 + 1]), this.vtx(this.tris[t * 3 + 2]));
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d < best.d) { best.d = d; best.t = t; best.q = q; } // fmt: skip
  }
  /** Distance to the surface and its sign (+ outside, by the closest triangle's normal). Exact: falls back to all
   *  triangles when nothing lies within the ring search. */
  closest(p: Vec3, maxRings = 8): { dist: number; signed: number } {
    const c = this.cell;
    const g = [0, 1, 2].map((k) => Math.floor((p[k] - this.min[k]) / c));
    const best = { d: Infinity, t: -1, q: p as Vec3 };
    const stamp = this.stamp;
    const id = ++this.query;
    for (let r = 0; r <= maxRings; r++) {
      for (let x = g[0] - r; x <= g[0] + r; x++) for (let y = g[1] - r; y <= g[1] + r; y++) for (let z = g[2] - r; z <= g[2] + r; z++) {
        if (Math.max(Math.abs(x - g[0]), Math.abs(y - g[1]), Math.abs(z - g[2])) !== r) continue;
        const list = this.cells.get(this.key(x, y, z));
        if (!list) continue;
        for (const t of list) if (stamp[t] !== id) { stamp[t] = id; this.test(t, p, best); } // fmt: skip
      } // fmt: skip
      if (best.t >= 0 && best.d <= r * c) break; // nothing outside ring r can be closer
    }
    if (best.t < 0 || best.d > maxRings * c) for (let t = 0; t < this.triangleCount; t++) this.test(t, p, best);
    if (best.t < 0) return { dist: Infinity, signed: Infinity };
    const n = [this.normals[best.t * 3], this.normals[best.t * 3 + 1], this.normals[best.t * 3 + 2]];
    const s = (p[0] - best.q[0]) * n[0] + (p[1] - best.q[1]) * n[1] + (p[2] - best.q[2]) * n[2];
    return { dist: best.d, signed: s >= 0 ? best.d : -best.d };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sampling and transforms

/** Area-uniform samples of a mesh surface (deterministic). Returns points and the area each stands for. */
export function sampleSurface(mesh: Mesh, spacingMm: number, maxSamples: number, seed = 7): { points: Float32Array; areaEach: number; totalArea: number } {
  const V = mesh.vertices, I = mesh.indices;
  const nt = I.length / 3;
  const areas = new Float64Array(nt);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2], wx = V[c] - V[a], wy = V[c + 1] - V[a + 1], wz = V[c + 2] - V[a + 2];
    areas[t] = 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    total += areas[t];
  }
  const target = Math.max(1, Math.min(maxSamples, Math.round(total / (spacingMm * spacingMm))));
  const per = target / (total || 1);
  const rng = makeRng(seed);
  const out: number[] = [];
  for (let t = 0; t < nt; t++) {
    const want = areas[t] * per;
    let k = Math.floor(want);
    if (rng() < want - k) k++;
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    for (let s = 0; s < k; s++) {
      let u = rng(), v = rng();
      if (u + v > 1) { u = 1 - u; v = 1 - v; } // fmt: skip
      for (let q = 0; q < 3; q++) out.push(V[a + q] + (V[b + q] - V[a + q]) * u + (V[c + q] - V[a + q]) * v);
    }
  }
  return { points: Float32Array.from(out), areaEach: total / Math.max(1, out.length / 3), totalArea: total };
}

const applyT = (T: RigidTransform, pts: Float32Array): Float32Array => transformCloud({ points: pts }, T.R as Mat3, T.t).points;
const compose = (A: RigidTransform, B: RigidTransform): RigidTransform => {
  // x -> A(B x)
  const R = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i * 3 + j] += A.R[i * 3 + k] * B.R[k * 3 + j];
  const t = mat3MulVec(A.R, B.t);
  return { R, t: [t[0] + A.t[0], t[1] + A.t[1], t[2] + A.t[2]] };
};
const rotZ = (deg: number): number[] => {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
};

function footprintPca(pts: Float32Array): { cx: number; cy: number; angleDeg: number } {
  const n = pts.length / 3;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += pts[i * 3]; cy += pts[i * 3 + 1]; } // fmt: skip
  cx /= n; cy /= n; // fmt: skip
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 3] - cx, dy = pts[i * 3 + 1] - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy; // fmt: skip
  }
  const { vectors } = symmetricEigen([sxx, sxy, sxy, syy], 2);
  return { cx, cy, angleDeg: (Math.atan2(vectors[0][1], vectors[0][0]) * 180) / Math.PI };
}

function subsample(pts: Float32Array, max: number): Float32Array {
  const n = pts.length / 3;
  if (n <= max) return pts;
  const step = n / max;
  const out = new Float32Array(max * 3);
  for (let i = 0; i < max; i++) out.set(pts.subarray(Math.floor(i * step) * 3, Math.floor(i * step) * 3 + 3), i * 3);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

export function surfaceDistance(input: SurfaceDistanceInput): SurfaceDistanceResult {
  const coverageMm = input.coverageMm ?? 2;
  const baseTol = input.baseTolMm ?? 1;
  const notes: string[] = [];
  if (input.referenceKind === "cad_nominal") notes.push(CAD_TOLERANCE_NOTE);
  else notes.push("The reference is a scan of the printed part: its own scanner accuracy (state it) is the floor of these figures.");
  notes.push("Only reconstructed vertices labelled observed or implied enter the main figures; board-plane, forearm-cut and search-box vertices are reported separately. The visual hull fills concavities, so 'implied' surface tends to lie outside.");
  const fail = (reason: string): SurfaceDistanceResult => ({
    ok: false,
    reason,
    referenceKind: input.referenceKind,
    alignment: null,
    meshToReference: EMPTY,
    perLabel: {},
    referenceToMesh: EMPTY,
    hausdorffMm: null,
    coverage: { thresholdMm: coverageMm, share: null, referenceAreaMm2: 0, baseAreaExcludedMm2: 0, cutAreaExcludedMm2: 0 },
    notes,
  });
  const { mesh, support, supportLabels } = input.reconstruction;
  if (!mesh.indices.length) return fail("the reconstruction has no mesh");
  if (!input.reference.indices.length) return fail("the reference mesh has no triangles");
  if (!support || !supportLabels.length) return fail("the reconstruction mesh has no support labels, so observed vertices cannot be told from board-plane ones");
  const nv = mesh.vertices.length / 3;
  const freeIdx = new Set(["observed", "implied"].map((l) => supportLabels.indexOf(l)).filter((i) => i >= 0));
  const free: number[] = [];
  for (let i = 0; i < nv; i++) if (freeIdx.has(support[i])) free.push(i);
  if (free.length < 20) return fail("fewer than 20 observed/implied vertices in the reconstruction");
  const freePts = new Float32Array(free.length * 3);
  free.forEach((i, k) => freePts.set(mesh.vertices.subarray(i * 3, i * 3 + 3), k * 3));

  // reference samples in its own frame; orientation outward
  const flip = meshVolume(input.reference) < 0 ? -1 : 1;
  const samples = sampleSurface(input.reference, input.sampleSpacingMm ?? 1, input.maxReferenceSamples ?? 60000);

  // alignment: reference -> board
  let T: RigidTransform;
  let method: "fixed" | "fixed+icp" | "board-pca+icp";
  let icpRms: number | null = null, icpMatched: number | null = null;
  const candidates: { yawDeg: number; rmsMm: number; matched: number }[] = [];
  const refine = (start: RigidTransform): { T: RigidTransform; rms: number; matched: number } => {
    let cur = start;
    let rms = NaN, matched = 0;
    // coarse pass: wide search on few points and a coarse grid; fine pass: short search on more points
    const passes = [
      { maxDistMm: 30, trimFraction: 0.7, cellMm: 10, nSrc: 1500, nDst: 5000, maxIterations: 20 },
      { maxDistMm: 8, trimFraction: 0.85, cellMm: 4, nSrc: 6000, nDst: 60000, maxIterations: 40 },
    ];
    for (const { maxDistMm, trimFraction, cellMm, nSrc, nDst, maxIterations } of passes) {
      const src = subsample(applyT(cur, samples.points), nSrc);
      const r = icp({ points: src }, { points: subsample(freePts, nDst) }, { maxDistMm, trimFraction, cellMm, maxIterations });
      cur = compose({ R: r.R, t: r.t }, cur);
      rms = r.rms;
      matched = r.matchedFraction;
    }
    return { T: cur, rms, matched };
  };
  if (input.transform) {
    T = { R: [...input.transform.R], t: [...input.transform.t] as Vec3 };
    method = "fixed";
    if (input.refine) {
      const r = refine(T);
      T = r.T;
      icpRms = r.rms;
      icpMatched = r.matched;
      method = "fixed+icp";
    }
  } else {
    let minZ = Infinity;
    for (let i = 2; i < samples.points.length; i += 3) minZ = Math.min(minZ, samples.points[i]);
    const lift: RigidTransform = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, -minZ] };
    const lifted = applyT(lift, samples.points);
    const above: number[] = [];
    for (let i = 0; i < lifted.length / 3; i++) if (lifted[i * 3 + 2] > baseTol) above.push(lifted[i * 3], lifted[i * 3 + 1], lifted[i * 3 + 2]);
    const refFoot = footprintPca(above.length >= 30 ? Float32Array.from(above) : lifted);
    const recFoot = footprintPca(freePts);
    let best: { T: RigidTransform; rms: number; matched: number } | null = null;
    for (const extra of [0, 180]) {
      const yaw = recFoot.angleDeg - refFoot.angleDeg + extra;
      const Rz = rotZ(yaw);
      const c = mat3MulVec(Rz, [refFoot.cx, refFoot.cy, 0]);
      const coarse = compose({ R: Rz, t: [recFoot.cx - c[0], recFoot.cy - c[1], 0] }, lift);
      const r = refine(coarse);
      candidates.push({ yawDeg: ((yaw % 360) + 360) % 360, rmsMm: r.rms, matched: r.matched });
      const score = (x: { rms: number; matched: number }) => (x.matched >= 0.5 ? x.rms : Infinity);
      if (!best || score(r) < score(best)) best = r;
    }
    T = best!.T;
    icpRms = best!.rms;
    icpMatched = best!.matched;
    method = "board-pca+icp";
    if (!(icpMatched !== null && icpMatched >= 0.5)) notes.push("ICP matched under half of the reference samples: the alignment is doubtful; supply a fixed transform.");
  }
  const zAxis = mat3MulVec(T.R, [0, 0, 1]);
  const baseTiltDeg = (Math.acos(Math.max(-1, Math.min(1, zAxis[2]))) * 180) / Math.PI;

  // reference in the board frame
  const refBoard: Mesh = { vertices: applyT(T, input.reference.vertices), indices: input.reference.indices };
  const refGrid = new TriangleGrid(refBoard.vertices, refBoard.indices);
  const byLabel = new Map<number, { u: number[]; s: number[] }>();
  const mainU: number[] = [], mainS: number[] = [];
  for (let i = 0; i < nv; i++) {
    const r = refGrid.closest([mesh.vertices[i * 3], mesh.vertices[i * 3 + 1], mesh.vertices[i * 3 + 2]]);
    const sg = flip * r.signed;
    const acc = byLabel.get(support[i]) ?? byLabel.set(support[i], { u: [], s: [] }).get(support[i])!;
    acc.u.push(r.dist);
    acc.s.push(sg);
    if (freeIdx.has(support[i])) { mainU.push(r.dist); mainS.push(sg); } // fmt: skip
  }
  const perLabel: Record<string, DistanceStats> = {};
  for (const [k, v] of byLabel) perLabel[supportLabels[k] ?? `label_${k}`] = distanceStats(v.u, v.s);

  // reference -> reconstruction's observed/implied triangles, base excluded
  const I = mesh.indices;
  const keep: number[] = [];
  for (let t = 0; t < I.length; t += 3) if (freeIdx.has(support[I[t]]) && freeIdx.has(support[I[t + 1]]) && freeIdx.has(support[I[t + 2]])) keep.push(I[t], I[t + 1], I[t + 2]);
  const recGrid = new TriangleGrid(mesh.vertices, Uint32Array.from(keep));
  // the reconstruction's own cut faces (forearm end, search box): reference area facing them is not compared
  const cutIdx = new Set(["volume_cut", "truncated"].map((l) => supportLabels.indexOf(l)).filter((i) => i >= 0));
  const cutTris: number[] = [];
  for (let t = 0; t < I.length; t += 3) if (cutIdx.has(support[I[t]]) && cutIdx.has(support[I[t + 1]]) && cutIdx.has(support[I[t + 2]])) cutTris.push(I[t], I[t + 1], I[t + 2]);
  const cutGrid = cutTris.length ? new TriangleGrid(mesh.vertices, Uint32Array.from(cutTris)) : null;
  const sb = applyT(T, samples.points);
  const ru: number[] = [];
  let baseN = 0, cutN = 0, within = 0;
  for (let i = 0; i < sb.length / 3; i++) {
    if (sb[i * 3 + 2] <= baseTol) { baseN++; continue; } // fmt: skip
    const p: Vec3 = [sb[i * 3], sb[i * 3 + 1], sb[i * 3 + 2]];
    const r = recGrid.closest(p);
    if (cutGrid && cutGrid.closest(p).dist < r.dist) { cutN++; continue; } // fmt: skip
    ru.push(r.dist);
    if (r.dist <= coverageMm) within++;
  }
  const meshToReference = distanceStats(mainU, mainS);
  const referenceToMesh = distanceStats(ru);
  return {
    ok: true,
    reason: null,
    referenceKind: input.referenceKind,
    alignment: { method, transform: T, icpRmsMm: icpRms, icpMatchedFraction: icpMatched, baseTiltDeg, candidates },
    meshToReference,
    perLabel,
    referenceToMesh,
    hausdorffMm: meshToReference.maxMm !== null && referenceToMesh.maxMm !== null ? Math.max(meshToReference.maxMm, referenceToMesh.maxMm) : null,
    coverage: { thresholdMm: coverageMm, share: ru.length ? within / ru.length : null, referenceAreaMm2: ru.length * samples.areaEach, baseAreaExcludedMm2: baseN * samples.areaEach, cutAreaExcludedMm2: cutN * samples.areaEach },
    notes,
  };
}
