// Isosurface extraction and mesh clean-up for the experimental reconstruction.
//
// The surface is extracted with MARCHING TETRAHEDRA (each grid cell is split into six tetrahedra around its main
// diagonal; the classic marching-cubes family, written from scratch here so there is no code licence to carry; it
// needs only a 3-case table and is watertight by construction). It gives more triangles than marching cubes for the
// same grid, which the smoothing and slicing code handles without trouble.
import type { Mesh } from "../common";
import type { Occupancy } from "./carving";
import type { Vec3 } from "./linalg";

export interface ScalarField {
  dims: [number, number, number];
  /** World position (mm) of the corner of sample (0,0,0); sample (i,j,k) sits at origin + (i+0.5, j+0.5, k+0.5) * voxelMm. */
  origin: Vec3;
  voxelMm: number;
  /** One value per sample; the surface is where the value crosses ``iso``; "inside" is above it. */
  values: Float32Array;
}

/** The occupancy as a smooth scalar field: padded by one empty layer (so surfaces close) and blurred by small
 *  [1 2 1] passes, which puts the surface between voxels (sub-voxel position, no staircase). */
export function occupancyToField(o: Occupancy, passes = 2): ScalarField {
  const [nx, ny, nz] = o.dims;
  const mx = nx + 2, my = ny + 2, mz = nz + 2;
  let a = new Float32Array(mx * my * mz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) a[i + 1 + mx * (j + 1 + my * (k + 1))] = o.occupancy[i + nx * (j + ny * k)];
  let b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    // x, y and z passes, ping-ponging between the two buffers
    for (let axis = 0; axis < 3; axis++) {
      const stride = axis === 0 ? 1 : axis === 1 ? mx : mx * my;
      const len = axis === 0 ? mx : axis === 1 ? my : mz;
      for (let k = 0; k < mz; k++)
        for (let j = 0; j < my; j++)
          for (let i = 0; i < mx; i++) {
            const idx = i + mx * (j + my * k);
            const pos = axis === 0 ? i : axis === 1 ? j : k;
            const c = a[idx];
            const l = pos > 0 ? a[idx - stride] : 0;
            const r = pos < len - 1 ? a[idx + stride] : 0;
            b[idx] = 0.25 * l + 0.5 * c + 0.25 * r;
          }
      const tmp = a;
      a = b;
      b = tmp;
    }
  }
  return { dims: [mx, my, mz], origin: [o.origin[0] - o.voxelMm, o.origin[1] - o.voxelMm, o.origin[2] - o.voxelMm], voxelMm: o.voxelMm, values: a };
}

/** Sample a signed distance function on a grid as a scalar field whose value is -sdf (inside positive; iso 0). */
export function sdfToField(sdf: (x: number, y: number, z: number) => number, bounds: { min: Vec3; max: Vec3 }, voxelMm: number): ScalarField {
  const nx = Math.ceil((bounds.max[0] - bounds.min[0]) / voxelMm);
  const ny = Math.ceil((bounds.max[1] - bounds.min[1]) / voxelMm);
  const nz = Math.ceil((bounds.max[2] - bounds.min[2]) / voxelMm);
  const values = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        values[i + nx * (j + ny * k)] = -sdf(bounds.min[0] + (i + 0.5) * voxelMm, bounds.min[1] + (j + 0.5) * voxelMm, bounds.min[2] + (k + 0.5) * voxelMm);
  return { dims: [nx, ny, nz], origin: [bounds.min[0], bounds.min[1], bounds.min[2]], voxelMm, values };
}

const CORNERS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
]; // fmt: skip
// Six tetrahedra around the cell diagonal 0-6; every cell uses the same split, so the faces of neighbouring cells match.
const TETS = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
];

/** Extract the isosurface ``values == iso`` as an indexed triangle mesh (counter-clockwise seen from outside, where
 *  outside is the side with values below ``iso``). Vertices are shared between triangles. */
export function extractMesh(field: ScalarField, isoLevel = 0.5): Mesh {
  // A tiny offset so that no sample is ever EXACTLY on the level: blurred voxel values are often exactly 0.5, and a
  // tie puts several vertices on the same point (zero-area triangles, cracks in the surface).
  const iso = isoLevel + 1e-4;
  const [nx, ny, nz] = field.dims;
  const v = field.values;
  const vox = field.voxelMm;
  const N = nx * ny * nz;
  const verts: number[] = [];
  const tris: number[] = [];
  const cache = new Map<number, number>();
  const px = (i: number) => field.origin[0] + (i + 0.5) * vox;
  const py = (j: number) => field.origin[1] + (j + 0.5) * vox;
  const pz = (k: number) => field.origin[2] + (k + 0.5) * vox;
  const cornerIdx = new Int32Array(8);
  const cx = new Float64Array(8);
  const cy = new Float64Array(8);
  const cz = new Float64Array(8);
  const cv = new Float64Array(8);

  const edgeVertex = (a: number, b: number): number => {
    // a, b: corner slots 0..7 of the current cell
    let ia = cornerIdx[a], ib = cornerIdx[b];
    let sa = a, sb = b;
    if (ia > ib) {
      [ia, ib] = [ib, ia];
      [sa, sb] = [sb, sa];
    }
    const key = ia * N + ib;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const t = (iso - cv[sa]) / (cv[sb] - cv[sa]);
    const id = verts.length / 3;
    verts.push(cx[sa] + (cx[sb] - cx[sa]) * t, cy[sa] + (cy[sb] - cy[sa]) * t, cz[sa] + (cz[sb] - cz[sa]) * t);
    cache.set(key, id);
    return id;
  };

  const emit = (a: number, b: number, c: number, ref: Vec3, outward: 1 | -1) => {
    // orient so that the normal points away from `ref` (outward = 1) or toward it (outward = -1)
    const ax = verts[a * 3], ay = verts[a * 3 + 1], az = verts[a * 3 + 2];
    const bx = verts[b * 3], by = verts[b * 3 + 1], bz = verts[b * 3 + 2];
    const qx = verts[c * 3], qy = verts[c * 3 + 1], qz = verts[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = qx - ax, wy = qy - ay, wz = qz - az;
    const nxn = uy * wz - uz * wy, nyn = uz * wx - ux * wz, nzn = ux * wy - uy * wx;
    const gx = (ax + bx + qx) / 3 - ref[0], gy = (ay + by + qy) / 3 - ref[1], gz = (az + bz + qz) / 3 - ref[2];
    const s = (nxn * gx + nyn * gy + nzn * gz) * outward;
    if (s >= 0) tris.push(a, b, c);
    else tris.push(a, c, b);
  };

  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let any = false, all = true;
        for (let c = 0; c < 8; c++) {
          const ci = i + CORNERS[c][0], cj = j + CORNERS[c][1], ck = k + CORNERS[c][2];
          const idx = ci + nx * (cj + ny * ck);
          cornerIdx[c] = idx;
          const val = v[idx];
          cv[c] = val;
          if (val > iso) any = true;
          else all = false;
        }
        if (!any || all) continue;
        for (let c = 0; c < 8; c++) {
          cx[c] = px(i + CORNERS[c][0]);
          cy[c] = py(j + CORNERS[c][1]);
          cz[c] = pz(k + CORNERS[c][2]);
        }
        for (const tet of TETS) {
          const inside: number[] = [];
          const outside: number[] = [];
          for (const c of tet) (cv[c] > iso ? inside : outside).push(c);
          const ni = inside.length;
          if (ni === 0 || ni === 4) continue;
          if (ni === 1) {
            const a = inside[0];
            const [b, c, d] = outside;
            emit(edgeVertex(a, b), edgeVertex(a, c), edgeVertex(a, d), [cx[a], cy[a], cz[a]], 1);
          } else if (ni === 3) {
            const d = outside[0];
            const [a, b, c] = inside;
            emit(edgeVertex(d, a), edgeVertex(d, b), edgeVertex(d, c), [cx[d], cy[d], cz[d]], -1);
          } else {
            const [a, b] = inside;
            const [c, d] = outside;
            const mid: Vec3 = [(cx[a] + cx[b]) / 2, (cy[a] + cy[b]) / 2, (cz[a] + cz[b]) / 2];
            const ac = edgeVertex(a, c), ad = edgeVertex(a, d), bd = edgeVertex(b, d), bc = edgeVertex(b, c);
            emit(ac, ad, bd, mid, 1);
            emit(ac, bd, bc, mid, 1);
          }
        }
      }
  return { vertices: Float32Array.from(verts), indices: Uint32Array.from(tris) };
}

// ---------------------------------------------------------------------------------------------------------------
// Mesh utilities

export function triangleCount(m: Mesh): number {
  return m.indices.length / 3;
}

export function meshArea(m: Mesh): number {
  const V = m.vertices, I = m.indices;
  let s = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const wx = V[c] - V[a], wy = V[c + 1] - V[a + 1], wz = V[c + 2] - V[a + 2];
    s += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
  }
  return s;
}

/** Signed enclosed volume (positive for outward-facing triangles of a closed mesh). */
export function meshVolume(m: Mesh): number {
  const V = m.vertices, I = m.indices;
  let s = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    s += (V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c])) / 6;
  }
  return s;
}

export function meshBounds(m: Mesh): { min: Vec3; max: Vec3 } {
  const V = m.vertices;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (V[i + k] < min[k]) min[k] = V[i + k];
      if (V[i + k] > max[k]) max[k] = V[i + k];
    }
  return { min, max };
}

/** Keep only the triangles for which ``keep[t]`` is true and drop vertices nobody uses. ``map`` (if given) receives,
 *  for every new vertex, the index of the old vertex (so per-vertex data can follow). */
export function compactMesh(m: Mesh, keep: ArrayLike<number | boolean>, map?: { oldIndex: number[] }): Mesh {
  const remap = new Int32Array(m.vertices.length / 3).fill(-1);
  const verts: number[] = [];
  const tris: number[] = [];
  const old: number[] = [];
  for (let t = 0; t < m.indices.length / 3; t++) {
    if (!keep[t]) continue;
    for (let k = 0; k < 3; k++) {
      const vi = m.indices[t * 3 + k];
      if (remap[vi] < 0) {
        remap[vi] = verts.length / 3;
        verts.push(m.vertices[vi * 3], m.vertices[vi * 3 + 1], m.vertices[vi * 3 + 2]);
        old.push(vi);
      }
      tris.push(remap[vi]);
    }
  }
  if (map) map.oldIndex = old;
  return { vertices: Float32Array.from(verts), indices: Uint32Array.from(tris) };
}

/** Label the connected components (triangles that share a vertex) of a mesh. */
export function connectedComponents(m: Mesh): { labels: Int32Array; sizes: number[] } {
  const nv = m.vertices.length / 3;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const I = m.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = find(I[t]), b = find(I[t + 1]), c = find(I[t + 2]);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    const c2 = find(c);
    if (a2 !== c2) parent[c2] = a2;
  }
  const nt = I.length / 3;
  const labels = new Int32Array(nt);
  const ids = new Map<number, number>();
  const sizes: number[] = [];
  for (let t = 0; t < nt; t++) {
    const r = find(I[t * 3]);
    let id = ids.get(r);
    if (id === undefined) {
      id = sizes.length;
      ids.set(r, id);
      sizes.push(0);
    }
    labels[t] = id;
    sizes[id]++;
  }
  return { labels, sizes };
}

/** Drop components with fewer than ``minFraction`` of the triangles of the largest one (floating specks). */
export function removeSmallComponents(m: Mesh, minFraction = 0.02): { mesh: Mesh; removed: number } {
  const { labels, sizes } = connectedComponents(m);
  if (sizes.length <= 1) return { mesh: m, removed: 0 };
  const biggest = Math.max(...sizes);
  const keep = new Uint8Array(labels.length);
  let removed = 0;
  for (let t = 0; t < labels.length; t++) keep[t] = sizes[labels[t]] >= minFraction * biggest ? 1 : 0;
  for (const s of sizes) if (s < minFraction * biggest) removed++;
  return { mesh: compactMesh(m, keep), removed };
}

export interface TopologyReport {
  vertices: number;
  triangles: number;
  edges: number;
  /** Edges used by exactly one triangle (the rim of every hole or open end). */
  boundaryEdges: number;
  /** Edges used by more than two triangles. */
  nonManifoldEdges: number;
  /** Closed loops of boundary edges: the number of holes. */
  holes: number;
  components: number;
  /** vertices - edges + triangles. 2 for one closed sphere-like surface. */
  eulerCharacteristic: number;
  /** No boundary and no non-manifold edge. */
  watertight: boolean;
}

export function topologyReport(m: Mesh): TopologyReport {
  const nv = m.vertices.length / 3;
  const I = m.indices;
  const edgeCount = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  for (let t = 0; t < I.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const e = key(I[t + k], I[t + ((k + 1) % 3)]);
      edgeCount.set(e, (edgeCount.get(e) ?? 0) + 1);
    }
  let boundary = 0, nonManifold = 0;
  const bAdj = new Map<number, number[]>();
  for (const [e, c] of edgeCount) {
    if (c === 1) {
      boundary++;
      const a = Math.floor(e / nv), b = e % nv;
      (bAdj.get(a) ?? bAdj.set(a, []).get(a)!).push(b);
      (bAdj.get(b) ?? bAdj.set(b, []).get(b)!).push(a);
    } else if (c > 2) nonManifold++;
  }
  // boundary loops = connected components of the boundary graph
  const seen = new Set<number>();
  let holes = 0;
  for (const start of bAdj.keys()) {
    if (seen.has(start)) continue;
    holes++;
    const stack = [start];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of bAdj.get(x) ?? []) if (!seen.has(y)) stack.push(y);
    }
  }
  const nt = I.length / 3;
  return {
    vertices: nv,
    triangles: nt,
    edges: edgeCount.size,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    holes,
    components: connectedComponents(m).sizes.length,
    eulerCharacteristic: nv - edgeCount.size + nt,
    watertight: boundary === 0 && nonManifold === 0 && nt > 0,
  };
}

/** Taubin smoothing (alternating shrink and inflate steps, so thin parts do not shrink away like with plain Laplacian). */
export function taubinSmooth(m: Mesh, opts: { iterations?: number; lambda?: number; mu?: number } = {}): Mesh {
  const iterations = opts.iterations ?? 8;
  const lambda = opts.lambda ?? 0.5;
  const mu = opts.mu ?? -0.53;
  const nv = m.vertices.length / 3;
  const I = m.indices;
  // CSR adjacency (unique neighbours)
  const deg = new Int32Array(nv + 1);
  const pairs = new Set<number>();
  const list: number[] = [];
  for (let t = 0; t < I.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = I[t + k], b = I[t + ((k + 1) % 3)];
      const e = a < b ? a * nv + b : b * nv + a;
      if (!pairs.has(e)) {
        pairs.add(e);
        list.push(a, b);
        deg[a + 1]++;
        deg[b + 1]++;
      }
    }
  for (let i = 0; i < nv; i++) deg[i + 1] += deg[i];
  const fill = deg.slice(0, nv);
  const nbr = new Int32Array(deg[nv]);
  for (let e = 0; e < list.length; e += 2) {
    nbr[fill[list[e]]++] = list[e + 1];
    nbr[fill[list[e + 1]]++] = list[e];
  }
  let cur = Float32Array.from(m.vertices);
  let nxt = new Float32Array(cur.length);
  const step = (w: number) => {
    for (let i = 0; i < nv; i++) {
      const s = deg[i], e = deg[i + 1];
      if (e === s) {
        nxt[i * 3] = cur[i * 3];
        nxt[i * 3 + 1] = cur[i * 3 + 1];
        nxt[i * 3 + 2] = cur[i * 3 + 2];
        continue;
      }
      let mx = 0, my = 0, mz = 0;
      for (let q = s; q < e; q++) {
        const j = nbr[q] * 3;
        mx += cur[j]; my += cur[j + 1]; mz += cur[j + 2];
      }
      const inv = 1 / (e - s);
      nxt[i * 3] = cur[i * 3] + w * (mx * inv - cur[i * 3]);
      nxt[i * 3 + 1] = cur[i * 3 + 1] + w * (my * inv - cur[i * 3 + 1]);
      nxt[i * 3 + 2] = cur[i * 3 + 2] + w * (mz * inv - cur[i * 3 + 2]);
    }
    const tmp = cur;
    cur = nxt;
    nxt = tmp;
  };
  for (let it = 0; it < iterations; it++) {
    step(lambda);
    step(mu);
  }
  return { vertices: cur, indices: m.indices };
}
