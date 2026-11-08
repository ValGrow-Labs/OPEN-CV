// A triangle mesh over the accepted lattice: only cells whose four corners are accepted AND whose centre and edge
// midpoints lie on hand pixels, so no triangle bridges a gap between fingers. Without measured depth it is a flat mesh
// in the image plane (z = 0): a coverage map of the visible hand, not a 3D surface.
import type { Mesh } from "../../common";
import { insideMask } from "./edt";
import { MIN_COMPONENT_TRIANGLES, type PointSet, type SurfacePoint } from "./types";

export function meshFromLattice(set: PointSet): { mesh: Mesh | null; completeness: number; components: number; triangles: number; note: string } {
  const acc = new Map<string, SurfacePoint>();
  for (const p of set.points) if (p.accepted) acc.set(`${p.gx},${p.gy}`, p);
  const onHand = (x: number, y: number) => (set.mask ? insideMask(set.mask, set.scaleToSource, x, y) : true);
  // candidate cells
  const cells: SurfacePoint[][] = [];
  for (const p of acc.values()) {
    const b = acc.get(`${p.gx + 1},${p.gy}`);
    const c = acc.get(`${p.gx},${p.gy + 1}`);
    const d = acc.get(`${p.gx + 1},${p.gy + 1}`);
    if (!b || !c || !d) continue;
    const mids = [
      [(p.x + b.x + c.x + d.x) / 4, (p.y + b.y + c.y + d.y) / 4],
      [(p.x + b.x) / 2, (p.y + b.y) / 2],
      [(p.x + c.x) / 2, (p.y + c.y) / 2],
      [(b.x + d.x) / 2, (b.y + d.y) / 2],
      [(c.x + d.x) / 2, (c.y + d.y) / 2],
    ];
    if (!mids.every(([x, y]) => onHand(x, y))) continue;
    cells.push([p, b, c, d]);
  }
  // components of cells sharing a corner (union-find over lattice nodes)
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = k;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const key = (p: SurfacePoint) => `${p.gx},${p.gy}`;
  for (const cell of cells) for (const p of cell) if (!parent.has(key(p))) parent.set(key(p), key(p));
  for (const cell of cells) {
    const r0 = find(key(cell[0]));
    for (let i = 1; i < 4; i++) {
      const ri = find(key(cell[i]));
      if (ri !== r0) parent.set(ri, r0);
    }
  }
  const sizes = new Map<string, number>();
  for (const cell of cells) {
    const r = find(key(cell[0]));
    sizes.set(r, (sizes.get(r) ?? 0) + 2);
  }
  const kept = cells.filter((cell) => (sizes.get(find(key(cell[0]))) ?? 0) >= MIN_COMPONENT_TRIANGLES);
  const components = [...sizes.values()].filter((n) => n >= MIN_COMPONENT_TRIANGLES).length;

  const maskArea = set.mask ? set.mask.data.reduce((n, v) => n + (v ? 1 : 0), 0) * set.scaleToSource ** 2 : 0;
  const coveredArea = kept.length * set.spacing.px ** 2;
  const completeness = maskArea > 0 ? Math.min(1, coveredArea / maskArea) : 0;
  if (!kept.length) return { mesh: null, completeness, components: 0, triangles: 0, note: "No complete lattice cell: nothing to triangulate." };

  const allMeasured = kept.every((cell) => cell.every((p) => p.depth === "measured" && p.z !== null));
  const mm = set.mmPerPx;
  const index = new Map<SurfacePoint, number>();
  const verts: number[] = [];
  const idx: number[] = [];
  const vid = (p: SurfacePoint) => {
    let i = index.get(p);
    if (i === undefined) {
      i = verts.length / 3;
      index.set(p, i);
      const k = mm ?? 1;
      verts.push(p.x * k, p.y * k, allMeasured ? (p.z as number) : 0);
    }
    return i;
  };
  for (const [a, b, c, d] of kept) {
    // image y points down: (a, c, b) and (b, c, d) wind counter-clockwise seen from the camera
    idx.push(vid(a), vid(c), vid(b), vid(b), vid(c), vid(d));
  }
  const note = [
    allMeasured ? "z is measured depth in mm." : "Flat mesh in the image plane (z = 0): a coverage map of the visible hand, NOT a 3D surface.",
    mm ? "x and y are scaled to mm with the coin-plane scale (a model: exact only at the coin's plane)." : "x and y are in source pixels (no coin scale).",
    "Only cells with four accepted corners whose centre and edge midpoints are on hand pixels: gaps between fingers stay open; missing surface is reported, never filled.",
  ].join(" ");
  return { mesh: { vertices: new Float32Array(verts), indices: new Uint32Array(idx) }, completeness, components, triangles: idx.length / 3, note };
}
