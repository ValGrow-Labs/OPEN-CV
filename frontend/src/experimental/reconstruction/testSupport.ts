// Helpers for the SYNTHETIC tests only (not part of the pipeline).
import type { BinaryMask, Intrinsics } from "../common";
import type { DepthMap } from "./pointcloud";

/** The metric depth map and silhouette of a sphere of radius ``radius`` whose centre is ``distance`` mm straight ahead of a
 *  camera at the origin looking along +z (identity pose). Depth is the z coordinate of the visible surface point. */
export function sphereDepth(K: Intrinsics, radius: number, distance: number): { depth: DepthMap; mask: BinaryMask } {
  const data = new Float32Array(K.width * K.height);
  const mask = new Uint8Array(K.width * K.height);
  for (let v = 0; v < K.height; v++)
    for (let u = 0; u < K.width; u++) {
      const dx = (u + 0.5 - K.cx) / K.fx;
      const dy = (v + 0.5 - K.cy) / K.fy;
      const dd = dx * dx + dy * dy + 1;
      const dc = distance; // d . c with c = (0, 0, distance), d = (dx, dy, 1)
      const disc = dc * dc - dd * (distance * distance - radius * radius);
      if (disc < 0) continue;
      const t = (dc - Math.sqrt(disc)) / dd;
      data[v * K.width + u] = t; // z = t * 1
      mask[v * K.width + u] = 255;
    }
  return { depth: { width: K.width, height: K.height, data }, mask: { width: K.width, height: K.height, data: mask } };
}

/** The area of the part of a sphere visible from a point ``distance`` from its centre. */
export const visibleCapArea = (radius: number, distance: number): number => 2 * Math.PI * radius * radius * (1 - radius / distance);
