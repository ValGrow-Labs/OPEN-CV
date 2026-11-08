// Photo-consistency refinement for concavities: a QUICK FEASIBILITY EXPERIMENT (stage 4 item, not shipped, not used by
// the chain). SIMULATED.
//
// A visual hull fills what no silhouette rules out (finger gaps not seen straight through, the hollow of a hand). Space
// carving / voxel colouring would remove a surface voxel whose colour is inconsistent across the views that see it.
// The question here is only whether that signal EXISTS on this hand: for every surface voxel of a hull carved with exact
// poses and exact masks, the colour spread across the views that see it (visibility by marching through the hull), for
// voxels that are truly on the hand's surface vs voxels the hull added (outside the true hand by more than one voxel,
// from the renderer's signed distance). If the two spreads overlap, photo-consistency cannot tell them apart.
import type { RGBAImage } from "../multiview/image";
import type { Occupancy } from "../reconstruction/carving";
import { cameraCenter, projectPoint } from "../reconstruction/linalg";
import type { CarveViewInput } from "./carve";

export interface PhotoStudy {
  surfaceVoxels: number;
  /** Surface voxels within one voxel of the true surface / more than one voxel outside the true hand. */
  trueSurface: number;
  excess: number;
  /** Hull voxels outside the true hand / all hull voxels (the over-fill the hull carries). */
  excessVolumeShare: number;
  /** Median colour spread (grey-level standard deviation across the views that see the voxel). */
  medianSpreadTrue: number;
  medianSpreadExcess: number;
  /** Probability that a random excess voxel is LESS photo-consistent (larger spread) than a random true one (0.5 = no
   *  signal, 1 = perfect separation). */
  auc: number;
  /** Excess voxels a threshold at the 95th percentile of the true spreads would remove, and true voxels it would remove. */
  removedExcessAt95: number;
  removedTrueAt95: number;
  meanVisibleViews: number;
  ms: number;
}

export function photoConsistencyStudy(hull: Occupancy, views: readonly CarveViewInput[], images: readonly RGBAImage[], sdf: (x: number, y: number, z: number) => number): PhotoStudy {
  const t0 = performance.now();
  const [nx, ny, nz] = hull.dims;
  const v = hull.voxelMm;
  const occ = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : hull.occupancy[i + nx * (j + ny * k)]);
  const centre = (i: number, j: number, k: number): [number, number, number] => [hull.origin[0] + (i + 0.5) * v, hull.origin[1] + (j + 0.5) * v, hull.origin[2] + (k + 0.5) * v];
  const cams = views.map((x) => cameraCenter(x.pose));
  const grey = images.map((im) => {
    const g = new Float32Array(im.width * im.height);
    for (let p = 0; p < g.length; p++) g[p] = 0.299 * im.data[p * 4] + 0.587 * im.data[p * 4 + 1] + 0.114 * im.data[p * 4 + 2];
    return g;
  });
  const spreadsTrue: number[] = [], spreadsExcess: number[] = [];
  let surface = 0, hullN = 0, hullOut = 0, visSum = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (!occ(i, j, k)) continue;
        hullN++;
        const X = centre(i, j, k);
        const d = sdf(X[0], X[1], X[2]);
        if (d > v) hullOut++;
        // a surface voxel above the table: an empty 6-neighbour (the table face k = 0 excluded)
        const isSurf = !occ(i + 1, j, k) || !occ(i - 1, j, k) || !occ(i, j + 1, k) || !occ(i, j - 1, k) || !occ(i, j, k + 1);
        if (!isSurf || k === 0) continue;
        const cls = Math.abs(d) <= v ? "true" : d > v ? "excess" : null;
        if (!cls) continue;
        surface++;
        const vals: number[] = [];
        views.forEach((view, c) => {
          const C = cams[c];
          const dir = [C[0] - X[0], C[1] - X[1], C[2] - X[2]];
          const L = Math.hypot(dir[0], dir[1], dir[2]);
          for (let s = 1.5 * v; s < L; s += 0.7 * v) {
            const P = [X[0] + (dir[0] * s) / L, X[1] + (dir[1] * s) / L, X[2] + (dir[2] * s) / L];
            const a = Math.floor((P[0] - hull.origin[0]) / v), b = Math.floor((P[1] - hull.origin[1]) / v), q = Math.floor((P[2] - hull.origin[2]) / v);
            if (a < 0 || b < 0 || q < 0 || a >= nx || b >= ny || q >= nz) break;
            if (occ(a, b, q)) return; // occluded by the hull
          }
          const pr = projectPoint(X, view.intrinsics, view.pose);
          if (!pr) return;
          const u = Math.floor(pr.u), w = Math.floor(pr.v);
          const im = images[c];
          if (u < 0 || w < 0 || u >= im.width || w >= im.height) return;
          vals.push(grey[c][w * im.width + u]);
        });
        if (vals.length < 2) continue;
        visSum += vals.length;
        const m = vals.reduce((s, x) => s + x, 0) / vals.length;
        const sd = Math.sqrt(vals.reduce((s, x) => s + (x - m) ** 2, 0) / (vals.length - 1));
        (cls === "true" ? spreadsTrue : spreadsExcess).push(sd);
      }
  const med = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[s.length >> 1] : NaN;
  };
  // AUC by ranks
  const all = [...spreadsTrue.map((x) => ({ x, e: 0 })), ...spreadsExcess.map((x) => ({ x, e: 1 }))].sort((a, b) => a.x - b.x);
  let rankSum = 0;
  all.forEach((q, r) => q.e && (rankSum += r + 1));
  const nE = spreadsExcess.length, nT = spreadsTrue.length;
  const auc = nE && nT ? (rankSum - (nE * (nE + 1)) / 2) / (nE * nT) : NaN;
  const t95 = [...spreadsTrue].sort((a, b) => a - b)[Math.floor(0.95 * (nT - 1))] ?? NaN;
  return {
    surfaceVoxels: surface,
    trueSurface: nT,
    excess: nE,
    excessVolumeShare: hullN ? hullOut / hullN : 0,
    medianSpreadTrue: med(spreadsTrue),
    medianSpreadExcess: med(spreadsExcess),
    auc,
    removedExcessAt95: spreadsExcess.filter((x) => x > t95).length,
    removedTrueAt95: spreadsTrue.filter((x) => x > t95).length,
    meanVisibleViews: nT + nE ? visSum / (nT + nE) : 0,
    ms: performance.now() - t0,
  };
}
