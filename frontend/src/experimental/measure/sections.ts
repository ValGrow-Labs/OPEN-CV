// Mesh sections for the EXPERIMENTAL measurement engine: finger widths at defined stations, and a uniform surface offset
// of a mesh (used to read the first-order sensitivity of a value to a silhouette boundary shift ON THE ACTUAL MESH).
//
// Finger width (same construction as validation/meshDimensions.ts, so the 15 mm station matches the caliper protocol):
//   the section of the mesh perpendicular to the finger axis (from landmarks) at the station; the width is the extent of
//   that section along w = up x axis (parallel to the support plane, perpendicular to the finger), over observed points
//   only (support-plane / volume-cut / truncated vertices never count toward a width). Withheld when the section loop is
//   open, holds another finger's axis (fingers merged in the reconstruction), or has fewer than 3 observed points.
import type { Mesh } from "../common";
import type { FingerAxis, FingerName } from "../reconstruction/measure";
import { cross, dot, normalize, type Vec3 } from "../reconstruction/linalg";
import { NOT_OBSERVED_LABELS, sliceLabelled, type SectionLoop } from "../validation/meshDimensions";

export type Station = { kind: "fromTip"; mm: number } | { kind: "fraction"; of: "base_to_tip"; f: number };

export interface FingerTip {
  name: FingerName;
  base: Vec3;
  dir: Vec3;
  /** Distance from the base point along the axis to the farthest observed mesh point in the finger's cylinder. */
  s: number;
}

export interface WidthResult {
  value: number | null;
  note: string;
  /** Distance of the section from the base point along the axis (mm). */
  stationS: number | null;
  loopClosed: boolean | null;
  /** Share of the section's points that come from observed (not support / cut) vertices. */
  observedShare: number | null;
}

const at = (o: Vec3, d: Vec3, s: number): Vec3 => [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s];
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** 1 for every vertex labelled support_plane, volume_cut or truncated; null without labels. */
export function notObservedMask(support: Uint8Array | null, labels: readonly string[], nVertices: number): Uint8Array | null {
  if (!support || support.length !== nVertices || !labels.length) return null;
  const bad = new Set(NOT_OBSERVED_LABELS.map((l) => labels.indexOf(l)).filter((i) => i >= 0));
  const out = new Uint8Array(nVertices);
  for (let i = 0; i < nVertices; i++) out[i] = bad.has(support[i]) ? 1 : 0;
  return out;
}

/** The farthest observed mesh point along each finger axis inside its cylinder (radius 12 mm, thumb 14, as measure.ts). */
export function fingerTips(mesh: Mesh, notObserved: Uint8Array | null, fingers: readonly FingerAxis[], radiusMm = 12): Map<FingerName, FingerTip> {
  const V = mesh.vertices;
  const nv = V.length / 3;
  const out = new Map<FingerName, FingerTip>();
  for (const f of fingers) {
    const dir = normalize(f.dir);
    const radial = f.name === "thumb" ? radiusMm + 2 : radiusMm;
    let best = -Infinity;
    for (let i = 0; i < nv; i++) {
      if (notObserved && notObserved[i]) continue;
      const px = V[i * 3] - f.base[0], py = V[i * 3 + 1] - f.base[1], pz = V[i * 3 + 2] - f.base[2];
      const s = px * dir[0] + py * dir[1] + pz * dir[2];
      if (s <= 0) continue;
      const r = Math.hypot(px - dir[0] * s, py - dir[1] * s, pz - dir[2] * s);
      if (r <= radial && s > best) best = s;
    }
    if (Number.isFinite(best)) out.set(f.name, { name: f.name, base: [f.base[0], f.base[1], f.base[2]], dir, s: best });
  }
  return out;
}

function contains(loop: SectionLoop, q: Vec3, e1: Vec3, e2: Vec3): boolean {
  if (!loop.closed) return false;
  const qx = dot(q, e1), qy = dot(q, e2);
  let inside = false;
  const P = loop.points;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const xi = dot(P[i], e1), yi = dot(P[i], e2), xj = dot(P[j], e1), yj = dot(P[j], e2);
    if (yi > qy !== yj > qy && qx < ((xj - xi) * (qy - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function loopAround(loops: readonly SectionLoop[], q: Vec3, e1: Vec3, e2: Vec3, maxDist: number): SectionLoop | null {
  const inside = loops.filter((l) => contains(l, q, e1, e2));
  if (inside.length) return inside.sort((a, b) => a.points.length - b.points.length)[0];
  let best: SectionLoop | null = null, bd = maxDist;
  for (const l of loops)
    for (const p of l.points) {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (d <= bd) {
        bd = d;
        best = l;
      }
    }
  return best;
}

/** Station position (mm from the base point along the axis) for a finger with tip at `tipS`. */
export function stationS(station: Station, tipS: number): number {
  return station.kind === "fromTip" ? tipS - station.mm : station.f * tipS;
}

/** The finger's width at a station; `shiftMm` moves the section along the axis (for the station-slope sensitivity). */
export function fingerWidthAt(
  mesh: Mesh,
  notObserved: Uint8Array | null,
  tips: ReadonlyMap<FingerName, FingerTip>,
  name: FingerName,
  station: Station,
  opts: { up?: Vec3; radiusMm?: number; shiftMm?: number } = {},
): WidthResult {
  const up = normalize(opts.up ?? [0, 0, 1]);
  const R = opts.radiusMm ?? 12;
  const t = tips.get(name);
  const fail = (note: string, extra: Partial<WidthResult> = {}): WidthResult => ({ value: null, note, stationS: null, loopClosed: null, observedShare: null, ...extra });
  if (!t) return fail(`no observed mesh point near the ${name}'s axis (or no axis from landmarks)`);
  const s = stationS(station, t.s) + (opts.shiftMm ?? 0);
  if (!(s > 0) || s >= t.s) return fail(`the station lies outside the ${name} (tip ${t.s.toFixed(1)} mm from its base point)`);
  const n = t.dir;
  if (Math.hypot(n[0] - up[0] * dot(n, up), n[1] - up[1] * dot(n, up), n[2] - up[2] * dot(n, up)) < 0.3) return fail(`the ${name}'s axis is too steep to define a width parallel to the support plane`);
  const w = normalize(cross(up, n));
  const e2 = cross(n, w);
  const c = at(t.base, n, s);
  const loops = sliceLabelled(mesh, notObserved, c, n);
  const loop = loopAround(loops, c, w, e2, name === "thumb" ? R + 2 : R);
  if (!loop) return fail(`the section does not cut the ${name}`, { stationS: s });
  if (!loop.closed) return fail(`the ${name}'s section is not a closed loop (a hole in the surface there)`, { stationS: s, loopClosed: false });
  const merged: FingerName[] = [];
  for (const o of tips.values()) {
    if (o.name === name) continue;
    const den = dot(o.dir, n);
    if (Math.abs(den) < 0.2) continue;
    const so = dot(minus(c, o.base), n) / den;
    if (so <= 0 || so > o.s) continue;
    if (contains(loop, at(o.base, o.dir, so), w, e2)) merged.push(o.name);
  }
  if (merged.length) return fail(`the ${name}'s section also holds the ${merged.join(", ")} (fingers merged in the reconstruction: no view looked through the gap); not separable`, { stationS: s, loopClosed: true });
  let lo = Infinity, hi = -Infinity, nObs = 0;
  loop.points.forEach((p, i) => {
    if (loop.board[i]) return;
    const v = dot(p, w);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    nObs++;
  });
  const share = nObs / loop.points.length;
  if (nObs < 3) return fail(`too few observed points in the ${name}'s section`, { stationS: s, loopClosed: true, observedShare: share });
  return { value: hi - lo, note: "", stationS: s, loopClosed: true, observedShare: share };
}

/** Area-weighted vertex normals (triangles counter-clockwise seen from outside). */
export function vertexNormals(mesh: Mesh): Float32Array {
  const V = mesh.vertices, I = mesh.indices;
  const N = new Float32Array(V.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const wx = V[c] - V[a], wy = V[c + 1] - V[a + 1], wz = V[c + 2] - V[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    for (const k of [a, b, c]) {
      N[k] += nx;
      N[k + 1] += ny;
      N[k + 2] += nz;
    }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= l;
    N[i + 1] /= l;
    N[i + 2] /= l;
  }
  return N;
}

/** The mesh with every movable vertex moved `eps` mm along its outward normal (a uniform offset of the observed
 *  surface, i.e. what an outward silhouette boundary shift does to a hull). Vertices with notObserved = 1 (on the
 *  support plane or a cut face: bounded by the box, not by any silhouette) stay where they are. */
export function offsetMesh(mesh: Mesh, eps: number, notObserved: Uint8Array | null, normals: Float32Array = vertexNormals(mesh)): Mesh {
  const V = mesh.vertices;
  const out = new Float32Array(V.length);
  for (let i = 0; i < V.length / 3; i++) {
    const move = notObserved && notObserved[i] ? 0 : eps;
    out[i * 3] = V[i * 3] + normals[i * 3] * move;
    out[i * 3 + 1] = V[i * 3 + 1] + normals[i * 3 + 1] * move;
    out[i * 3 + 2] = V[i * 3 + 2] + normals[i * 3 + 2] * move;
  }
  return { vertices: out, indices: mesh.indices };
}
