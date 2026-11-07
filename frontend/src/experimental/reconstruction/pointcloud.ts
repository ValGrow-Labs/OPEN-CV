// Point-cloud tools: depth back-projection, rigid alignment (known correspondences and ICP), voxel fusion and grid
// triangulation. They work on METRIC depth (millimetres along the optical axis). A relative depth map (a monocular
// network's output, MediaPipe's z) must never be passed in as if it were metric: see ../depth/surfaceFromDepth.ts.
import type { BinaryMask, CameraPose, Intrinsics, Mesh } from "../common";
import { mat3MulVec, mat3T, rigidAlign, type Mat3, type Vec3 } from "./linalg";

/** Points as x, y, z triples (millimetres), with optional per-point confidence in 0..1. */
export interface PointCloud {
  points: Float32Array;
  confidence?: Float32Array;
}

/** A metric depth map: ``data[v * width + u]`` is the distance in millimetres along the camera's z axis; 0, NaN or a
 *  negative value means "no measurement". */
export interface DepthMap {
  width: number;
  height: number;
  data: Float32Array;
  confidence?: Float32Array;
}

export const pointCount = (c: PointCloud): number => c.points.length / 3;

export interface BackprojectOptions {
  minMm?: number;
  maxMm?: number;
  minConfidence?: number;
}

/** Back-project the depth pixels inside ``mask`` (or all pixels) to 3D points in the CAMERA frame. Invalid depth
 *  (NaN, zero, negative, outside [minMm, maxMm], below the confidence floor) is skipped, never filled in. */
export function backprojectDepth(depth: DepthMap, mask: BinaryMask | null, K: Intrinsics, opts: BackprojectOptions = {}): PointCloud {
  const minMm = opts.minMm ?? 30;
  const maxMm = opts.maxMm ?? 3000;
  const minConf = opts.minConfidence ?? 0;
  const sx = K.width / depth.width;
  const sy = K.height / depth.height;
  const pts: number[] = [];
  const conf: number[] = [];
  for (let v = 0; v < depth.height; v++)
    for (let u = 0; u < depth.width; u++) {
      const i = v * depth.width + u;
      const z = depth.data[i];
      if (!(z >= minMm && z <= maxMm)) continue;
      if (depth.confidence && depth.confidence[i] < minConf) continue;
      if (mask) {
        const mu = Math.min(mask.width - 1, Math.floor(((u + 0.5) * mask.width) / depth.width));
        const mv = Math.min(mask.height - 1, Math.floor(((v + 0.5) * mask.height) / depth.height));
        if (!mask.data[mv * mask.width + mu]) continue;
      }
      const px = (u + 0.5) * sx;
      const py = (v + 0.5) * sy;
      pts.push(((px - K.cx) / K.fx) * z, ((py - K.cy) / K.fy) * z, z);
      conf.push(depth.confidence ? depth.confidence[i] : 1);
    }
  return { points: Float32Array.from(pts), confidence: Float32Array.from(conf) };
}

/** Apply x' = R x + t to every point. */
export function transformCloud(c: PointCloud, R: Mat3, t: Vec3): PointCloud {
  const out = new Float32Array(c.points.length);
  for (let i = 0; i < c.points.length; i += 3) {
    const p = mat3MulVec(R, [c.points[i], c.points[i + 1], c.points[i + 2]]);
    out[i] = p[0] + t[0];
    out[i + 1] = p[1] + t[1];
    out[i + 2] = p[2] + t[2];
  }
  return { points: out, confidence: c.confidence };
}

/** Camera-frame points to world coordinates: X = R^T (Xc - t). */
export function cameraCloudToWorld(c: PointCloud, pose: CameraPose): PointCloud {
  const Rt = mat3T(pose.R);
  const shifted = new Float32Array(c.points.length);
  for (let i = 0; i < c.points.length; i += 3) {
    shifted[i] = c.points[i] - pose.t[0];
    shifted[i + 1] = c.points[i + 1] - pose.t[1];
    shifted[i + 2] = c.points[i + 2] - pose.t[2];
  }
  return transformCloud({ points: shifted, confidence: c.confidence }, Rt, [0, 0, 0]);
}

// ---------------------------------------------------------------------------------------------------------------
// ICP

class SpatialHash {
  private cells = new Map<number, number[]>();
  constructor(
    private pts: Float32Array,
    private cell: number,
  ) {
    for (let i = 0; i < pts.length; i += 3) {
      const k = this.key(Math.floor(pts[i] / cell), Math.floor(pts[i + 1] / cell), Math.floor(pts[i + 2] / cell));
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(i / 3);
    }
  }
  private key(x: number, y: number, z: number): number {
    return ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096);
  }
  /** Nearest point to (x, y, z) within ``maxDist``, or -1. */
  nearest(x: number, y: number, z: number, maxDist: number): { index: number; dist: number } {
    const c = this.cell;
    const r = Math.ceil(maxDist / c);
    const cx = Math.floor(x / c), cy = Math.floor(y / c), cz = Math.floor(z / c);
    let best = -1;
    let bestD = maxDist * maxDist;
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        for (let dz = -r; dz <= r; dz++) {
          const list = this.cells.get(this.key(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const j of list) {
            const ddx = this.pts[j * 3] - x, ddy = this.pts[j * 3 + 1] - y, ddz = this.pts[j * 3 + 2] - z;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < bestD) {
              bestD = d2;
              best = j;
            }
          }
        }
    return { index: best, dist: Math.sqrt(bestD) };
  }
}

export interface IcpOptions {
  maxIterations?: number;
  /** Share of the closest matches used each iteration (rejects outliers and non-overlapping parts). Default 0.85. */
  trimFraction?: number;
  /** A match farther than this (mm) is ignored. Default 15. */
  maxDistMm?: number;
  /** Stop when the rms changes by less than this (mm). Default 1e-4. */
  toleranceMm?: number;
  /** Grid cell for nearest-neighbour search (mm). Default 4. */
  cellMm?: number;
}

export interface IcpResult {
  R: Mat3;
  t: Vec3;
  /** Root-mean-square distance of the trimmed matches after alignment (mm). */
  rms: number;
  iterations: number;
  converged: boolean;
  /** The share of source points that had a match within the distance limit in the last iteration. */
  matchedFraction: number;
}

/** Point-to-point ICP aligning ``src`` onto ``dst`` (a rigid transform from source to destination coordinates), with
 *  trimmed matches so outliers and partial overlap do not drag the result. Needs a reasonable starting alignment. */
export function icp(src: PointCloud, dst: PointCloud, opts: IcpOptions = {}): IcpResult {
  const maxIter = opts.maxIterations ?? 40;
  const trim = opts.trimFraction ?? 0.85;
  const maxDist = opts.maxDistMm ?? 15;
  const tol = opts.toleranceMm ?? 1e-4;
  const hash = new SpatialHash(dst.points, opts.cellMm ?? 4);
  let R: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let t: Vec3 = [0, 0, 0];
  let prev = Infinity;
  let rms = NaN;
  let matched = 0;
  let it = 0;
  let converged = false;
  const n = src.points.length / 3;
  for (it = 1; it <= maxIter; it++) {
    const moved = transformCloud(src, R, t).points;
    const idx: number[] = [];
    const dist: number[] = [];
    const nn: number[] = [];
    for (let i = 0; i < n; i++) {
      const m = hash.nearest(moved[i * 3], moved[i * 3 + 1], moved[i * 3 + 2], maxDist);
      if (m.index >= 0) {
        idx.push(i);
        nn.push(m.index);
        dist.push(m.dist);
      }
    }
    matched = idx.length / n;
    if (idx.length < 6) break;
    const order = Array.from(dist.keys()).sort((a, b) => dist[a] - dist[b]);
    const keep = order.slice(0, Math.max(6, Math.floor(order.length * trim)));
    const A = new Float32Array(keep.length * 3);
    const B = new Float32Array(keep.length * 3);
    keep.forEach((k, q) => {
      A[q * 3] = moved[idx[k] * 3];
      A[q * 3 + 1] = moved[idx[k] * 3 + 1];
      A[q * 3 + 2] = moved[idx[k] * 3 + 2];
      B[q * 3] = dst.points[nn[k] * 3];
      B[q * 3 + 1] = dst.points[nn[k] * 3 + 1];
      B[q * 3 + 2] = dst.points[nn[k] * 3 + 2];
    });
    const step = rigidAlign(A, B);
    // compose: x' = Rs (R x + t) + ts
    const Rn = new Array<number>(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) Rn[i * 3 + j] += step.R[i * 3 + k] * R[k * 3 + j];
    const tn = mat3MulVec(step.R, t);
    R = Rn;
    t = [tn[0] + step.t[0], tn[1] + step.t[1], tn[2] + step.t[2]];
    rms = step.rms;
    if (Math.abs(prev - rms) < tol) {
      converged = true;
      break;
    }
    prev = rms;
  }
  return { R, t, rms, iterations: Math.min(it, maxIter), converged, matchedFraction: matched };
}

// ---------------------------------------------------------------------------------------------------------------
// Fusion and triangulation

/** Fuse several clouds already in one frame: all points falling in the same voxel are replaced by their mean. The
 *  confidence of a fused point is the largest confidence in it. */
export function fuseClouds(clouds: readonly PointCloud[], voxelMm: number): PointCloud {
  type Acc = { x: number; y: number; z: number; n: number; c: number };
  const cells = new Map<string, Acc>();
  for (const cloud of clouds)
    for (let i = 0; i < cloud.points.length; i += 3) {
      const x = cloud.points[i], y = cloud.points[i + 1], z = cloud.points[i + 2];
      const key = `${Math.floor(x / voxelMm)},${Math.floor(y / voxelMm)},${Math.floor(z / voxelMm)}`;
      const a = cells.get(key) ?? { x: 0, y: 0, z: 0, n: 0, c: 0 };
      a.x += x; a.y += y; a.z += z; a.n++;
      a.c = Math.max(a.c, cloud.confidence ? cloud.confidence[i / 3] : 1);
      cells.set(key, a);
    }
  const pts = new Float32Array(cells.size * 3);
  const conf = new Float32Array(cells.size);
  let q = 0;
  for (const a of cells.values()) {
    pts[q * 3] = a.x / a.n;
    pts[q * 3 + 1] = a.y / a.n;
    pts[q * 3 + 2] = a.z / a.n;
    conf[q++] = a.c;
  }
  return { points: pts, confidence: conf };
}

/** Triangulate a metric depth map on its pixel grid into a mesh in the camera frame, skipping any quad that touches
 *  invalid depth, falls outside ``mask``, or has an edge longer than ``maxEdgeMm`` (a jump across a silhouette edge
 *  must not become a sheet). Triangles face the camera. */
export function triangulateDepthGrid(depth: DepthMap, mask: BinaryMask | null, K: Intrinsics, maxEdgeMm: number): Mesh {
  const w = depth.width, h = depth.height;
  const sx = K.width / w, sy = K.height / h;
  const id = new Int32Array(w * h).fill(-1);
  const verts: number[] = [];
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const z = depth.data[v * w + u];
      if (!(z > 0 && Number.isFinite(z))) continue;
      if (mask) {
        const mu = Math.min(mask.width - 1, Math.floor(((u + 0.5) * mask.width) / w));
        const mv = Math.min(mask.height - 1, Math.floor(((v + 0.5) * mask.height) / h));
        if (!mask.data[mv * mask.width + mu]) continue;
      }
      id[v * w + u] = verts.length / 3;
      verts.push((((u + 0.5) * sx - K.cx) / K.fx) * z, (((v + 0.5) * sy - K.cy) / K.fy) * z, z);
    }
  const d = (a: number, b: number) => Math.hypot(verts[a * 3] - verts[b * 3], verts[a * 3 + 1] - verts[b * 3 + 1], verts[a * 3 + 2] - verts[b * 3 + 2]);
  const tris: number[] = [];
  for (let v = 0; v < h - 1; v++)
    for (let u = 0; u < w - 1; u++) {
      const a = id[v * w + u], b = id[v * w + u + 1], c = id[(v + 1) * w + u], e = id[(v + 1) * w + u + 1];
      if (a < 0 || b < 0 || c < 0 || e < 0) continue;
      if (d(a, b) > maxEdgeMm || d(a, c) > maxEdgeMm || d(b, e) > maxEdgeMm || d(c, e) > maxEdgeMm || d(a, e) > maxEdgeMm * 1.5 || d(b, c) > maxEdgeMm * 1.5) continue;
      tris.push(a, c, b, b, c, e);
    }
  return { vertices: Float32Array.from(verts), indices: Uint32Array.from(tris) };
}
