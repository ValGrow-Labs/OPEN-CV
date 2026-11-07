// Silhouette carving: the visual hull of a set of calibrated binary masks.
//
// A voxel is kept when its centre projects inside the hand silhouette of (almost) every view. The result is the
// LARGEST shape consistent with all the silhouettes, so it is never smaller than the true hand (up to mask error).
//
// What a visual hull CANNOT recover, plainly:
//   * concavities: anything hidden inside the convex-ish outline from every view (the dip of the palm, the hollow
//     between thumb and index finger seen edge-on) is filled in;
//   * gaps between fingers seen from only a few directions: they close up unless a view looks straight through them;
//   * with two views looking along the same line (palm and back) the thickness is not observed at all: the hull
//     is a prism running the full length of the search volume;
//   * surfaces that no silhouette edge touches ("phantom" volume): see `unconstrainedSurfaceFraction`.
// It also inherits every error of its inputs: mask boundary error, focal length error, pose error.
import type { BinaryMask, CameraPose, Intrinsics } from "../common";
import { cameraCenter, dot, normalize, sub, type Vec3 } from "./linalg";

export interface CarveView {
  mask: BinaryMask;
  intrinsics: Intrinsics;
  pose: CameraPose;
}

export interface Occupancy {
  dims: [number, number, number];
  /** World position (mm) of the corner of voxel (0,0,0); voxel (i,j,k) has its centre at origin + (i+0.5, j+0.5, k+0.5) * voxelMm. */
  origin: Vec3;
  voxelMm: number;
  /** 1 = inside the hull. Index = i + nx * (j + ny * k). */
  occupancy: Uint8Array;
  /** How many views' silhouettes contain the voxel centre. */
  support: Uint8Array;
  /** In how many views the voxel centre falls inside the picture at all. */
  observed: Uint8Array;
  nViews: number;
}

export interface CarveOptions {
  voxelMm: number;
  /** Tolerance for mask errors: a voxel is kept if it is inside at least (views - tolerance) silhouettes. Default 0. */
  tolerance?: number;
  /** A voxel that projects outside a picture: "carve" counts it as outside that silhouette (default), "ignore" does not
   *  hold it against the voxel (use when the hand may leave some pictures; needs at least 2 views that see it). */
  outsideImage?: "carve" | "ignore";
}

export function carveVisualHull(views: readonly CarveView[], bounds: { min: Vec3; max: Vec3 }, opts: CarveOptions): Occupancy {
  const voxel = opts.voxelMm;
  const nx = Math.max(1, Math.ceil((bounds.max[0] - bounds.min[0]) / voxel));
  const ny = Math.max(1, Math.ceil((bounds.max[1] - bounds.min[1]) / voxel));
  const nz = Math.max(1, Math.ceil((bounds.max[2] - bounds.min[2]) / voxel));
  const n = nx * ny * nz;
  const support = new Uint8Array(n);
  const observed = new Uint8Array(n);
  const k = opts.tolerance ?? 0;

  for (const view of views) {
    const { mask, intrinsics: K, pose } = view;
    const R = pose.R, t = pose.t;
    const sx = mask.width / K.width;
    const sy = mask.height / K.height;
    const data = mask.data;
    const mw = mask.width, mh = mask.height;
    const distort = !!(K.k1 || K.k2);
    const dx0 = R[0] * voxel, dx1 = R[3] * voxel, dx2 = R[6] * voxel;
    for (let kz = 0; kz < nz; kz++) {
      const Z = bounds.min[2] + (kz + 0.5) * voxel;
      for (let jy = 0; jy < ny; jy++) {
        const Y = bounds.min[1] + (jy + 0.5) * voxel;
        const X0 = bounds.min[0] + 0.5 * voxel;
        let xc = R[0] * X0 + R[1] * Y + R[2] * Z + t[0];
        let yc = R[3] * X0 + R[4] * Y + R[5] * Z + t[1];
        let zc = R[6] * X0 + R[7] * Y + R[8] * Z + t[2];
        let idx = nx * (jy + ny * kz);
        for (let ix = 0; ix < nx; ix++, idx++, xc += dx0, yc += dx1, zc += dx2) {
          if (zc <= 1e-6) continue;
          let xn = xc / zc;
          let yn = yc / zc;
          if (distort) {
            const r2 = xn * xn + yn * yn;
            const d = 1 + (K.k1 ?? 0) * r2 + (K.k2 ?? 0) * r2 * r2;
            xn *= d;
            yn *= d;
          }
          const u = (K.fx * xn + K.cx) * sx;
          const v = (K.fy * yn + K.cy) * sy;
          if (u < 0 || v < 0 || u >= mw || v >= mh) continue;
          observed[idx]++;
          if (data[(v | 0) * mw + (u | 0)] > 0) support[idx]++;
        }
      }
    }
  }

  const nViews = views.length;
  const occupancy = new Uint8Array(n);
  const ignore = opts.outsideImage === "ignore";
  for (let i = 0; i < n; i++) {
    if (ignore) occupancy[i] = observed[i] >= 2 && support[i] >= observed[i] - k ? 1 : 0;
    else occupancy[i] = support[i] >= nViews - k && nViews > 0 ? 1 : 0;
  }
  return { dims: [nx, ny, nz], origin: [bounds.min[0], bounds.min[1], bounds.min[2]], voxelMm: voxel, occupancy, support, observed, nViews };
}

export function voxelCount(o: Occupancy): number {
  let c = 0;
  for (let i = 0; i < o.occupancy.length; i++) c += o.occupancy[i];
  return c;
}

export function voxelVolumeMm3(o: Occupancy): number {
  return voxelCount(o) * o.voxelMm ** 3;
}

// ---------------------------------------------------------------------------------------------------------------
// View coverage

export interface ViewCoverage {
  views: number;
  /** Unit vectors from the object centre toward each camera. */
  directions: Vec3[];
  /** The largest angle (degrees) from any direction on the sphere to the nearest camera axis (a silhouette from a
   *  direction is nearly the same as from the opposite one, so the nearest of +d and -d counts). 90 = a whole
   *  half-space is unseen; small is good. */
  coverageRadiusDeg: number;
  /** The largest gap (degrees) between neighbouring cameras around the hand axis ``axis`` (0 when there is one camera;
   *  views are folded to a half circle because opposite views carry the same silhouette). */
  maxAzimuthGapDeg: number;
  /** Largest angle between any two camera axes (degrees, folded): how spread out the views are. */
  maxSpreadDeg: number;
}

export function viewCoverage(views: readonly { pose: CameraPose }[], center: Vec3, axis: Vec3 = [0, 1, 0]): ViewCoverage {
  const dirs = views.map((v) => normalize(sub(cameraCenter(v.pose), center)));
  const samples: Vec3[] = [];
  const N = 600;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    samples.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r]);
  }
  let worst = 0;
  if (dirs.length === 0) worst = 90;
  else
    for (const s of samples) {
      let best = 0;
      for (const d of dirs) best = Math.max(best, Math.abs(dot(s, d)));
      worst = Math.max(worst, (Math.acos(Math.min(1, best)) * 180) / Math.PI);
    }
  let spread = 0;
  for (let i = 0; i < dirs.length; i++)
    for (let j = i + 1; j < dirs.length; j++) spread = Math.max(spread, (Math.acos(Math.min(1, Math.abs(dot(dirs[i], dirs[j])))) * 180) / Math.PI);
  // azimuth around the hand axis, folded to [0, 180)
  const ax = normalize(axis);
  const ref: Vec3 = Math.abs(ax[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize(sub(ref, [ax[0] * dot(ref, ax), ax[1] * dot(ref, ax), ax[2] * dot(ref, ax)]));
  const e2: Vec3 = [ax[1] * e1[2] - ax[2] * e1[1], ax[2] * e1[0] - ax[0] * e1[2], ax[0] * e1[1] - ax[1] * e1[0]];
  const az = dirs
    .map((d) => {
      const px = dot(d, e1), py = dot(d, e2);
      if (Math.hypot(px, py) < 0.15) return null; // looking along the axis: no azimuth
      let a = (Math.atan2(py, px) * 180) / Math.PI;
      a = ((a % 180) + 180) % 180;
      return a;
    })
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b);
  let gap = az.length === 0 ? 180 : 0;
  for (let i = 0; i < az.length; i++) gap = Math.max(gap, i === 0 ? az[0] + 180 - az[az.length - 1] : az[i] - az[i - 1]);
  return { views: views.length, directions: dirs, coverageRadiusDeg: worst, maxAzimuthGapDeg: az.length === 1 ? 180 : gap, maxSpreadDeg: spread };
}

/** The share of the hull's surface voxels that no camera constrains: a surface voxel counts as constrained when at
 *  least one camera looks along the surface there (its viewing ray within ``toleranceDeg`` of the tangent plane), so a
 *  silhouette edge can have shaped it. Heuristic. Unconstrained surface is "phantom" volume the data cannot confirm. */
export function unconstrainedSurfaceFraction(o: Occupancy, views: readonly { pose: CameraPose }[], toleranceDeg = 30): number {
  const [nx, ny, nz] = o.dims;
  const occ = o.occupancy;
  const at = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : occ[i + nx * (j + ny * k)]);
  const centers = views.map((v) => cameraCenter(v.pose));
  const sinTol = Math.sin((toleranceDeg * Math.PI) / 180);
  let surface = 0;
  let free = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (!occ[i + nx * (j + ny * k)]) continue;
        // outward normal estimate: minus the gradient of occupancy over the 3x3x3 neighbourhood
        let gx = 0, gy = 0, gz = 0, empties = 0;
        for (let dk = -1; dk <= 1; dk++)
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              if (!di && !dj && !dk) continue;
              if (!at(i + di, j + dj, k + dk)) {
                gx += di; gy += dj; gz += dk; empties++;
              }
            }
        if (!empties) continue;
        const nrm = normalize([gx, gy, gz]);
        if (nrm[0] === 0 && nrm[1] === 0 && nrm[2] === 0) continue;
        surface++;
        const X: Vec3 = [o.origin[0] + (i + 0.5) * o.voxelMm, o.origin[1] + (j + 0.5) * o.voxelMm, o.origin[2] + (k + 0.5) * o.voxelMm];
        let constrained = false;
        for (const c of centers) {
          const d = normalize(sub(X, c));
          if (Math.abs(dot(nrm, d)) <= sinTol) {
            constrained = true;
            break;
          }
        }
        if (!constrained) free++;
      }
  return surface === 0 ? 1 : free / surface;
}
