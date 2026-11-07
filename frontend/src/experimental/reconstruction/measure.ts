// The 3D measurement engine: dimensions read off a reconstructed triangle mesh.
//
// EVERYTHING HERE IS EXPERIMENTAL AND UNVALIDATED. No result has been compared with a physical measurement.
// Each result is a `Quantity` that says HOW it was obtained:
//   * basis "direct": a distance, extent or area of the reconstructed geometry itself, given the hand frame;
//   * basis "model": it also rests on something that is not geometry of the mesh (a hand frame guessed from the mesh or
//     predicted by a landmark detector, an assumed knuckle line, a fixed offset).
// A direct quantity is only as good as the mesh. The mesh is only as good as the silhouettes, the camera poses and the
// scale (see README). "direct" never means "accurate".
//
// ANATOMICAL CONVENTIONS (the hand frame: origin O in the wrist plane on the hand axis, axisY toward the fingers, axisX
// across the palm, axisZ the palm normal; knuckle line K = the distance from O along axisY to the metacarpal heads):
//   hand length      the largest distance from the wrist plane, along axisY, of any mesh point (the middle fingertip on a
//                    normal hand): wrist plane to fingertip, in a straight line along the hand axis;
//   palm breadth     the extent along axisX of the cross-section at y = K - 8 mm (just proximal to the knuckles, thumb
//                    excluded because it leaves the palm below that plane when abducted): skin edge to skin edge;
//   palm thickness   the extent along axisZ (palm to back) of that same section over its central 60 % in width;
//   finger length    for each finger the distance along its axis from the base point (the MCP joint centre when the axes
//                    come from landmarks) to the farthest mesh point inside a narrow cylinder around the axis. This is
//                    joint-centre to skin tip, NOT the palm-crease-to-tip length a tape measure gives (a few mm more);
//   circumference    the length of the single closed loop where the plane y = K - 8 mm cuts the mesh (the "around the
//                    knuckles" hand circumference of glove sizing, thumb excluded); null if the cut is not one closed loop;
//   surface area     the sum of the triangle areas of the whole mesh, only when the reconstruction passed its gates.
// Which need landmarks: the hand frame (O, axes, K) and the finger axes. A frame from `frameFromLandmarks` and axes from
// `fingersFromLandmarks` use MediaPipe's 21 points lifted into the mesh frame; without them `frameFromPca` gives axes
// only (no wrist plane, so no hand length).
import type { Mesh, Pt3, Quantity } from "../common";
import { cross, dot, normalize, sub, type Vec3 } from "./linalg";
import { meshArea, meshBounds } from "./meshing";
import { symmetricEigen } from "./linalg";

export type FingerName = "thumb" | "index" | "middle" | "ring" | "little";
export const FINGER_NAMES: FingerName[] = ["thumb", "index", "middle", "ring", "little"];

export interface HandFrame {
  origin: Vec3;
  axisY: Vec3;
  axisX: Vec3;
  axisZ: Vec3;
  /** Distance from the origin along axisY to the knuckle (metacarpal head) line, if known. */
  knuckleYMm?: number;
  /** "given": supplied exactly (a synthetic truth or an operator-defined frame); "landmarks": predicted by a hand-landmark
   *  detector; "pca": axes guessed from the shape of the mesh (no wrist plane). */
  source: "given" | "landmarks" | "pca";
}

export interface FingerAxis {
  name: FingerName;
  /** A point on the finger's axis near its base. */
  base: Vec3;
  /** Unit direction toward the tip. */
  dir: Vec3;
}

const quantity = (value: number | null, unit: Quantity["unit"], basis: Quantity["basis"], note: string): Quantity => ({ value, unit, basis, note });
const none = (unit: Quantity["unit"], note: string): Quantity => quantity(null, unit, "none", note);

// ---------------------------------------------------------------------------------------------------------------
// Frames

/** A hand frame from the 21 MediaPipe landmarks expressed in the mesh frame (millimetres). */
export function frameFromLandmarks(lm: readonly Pt3[]): HandFrame | null {
  if (lm.length < 21) return null;
  const O: Vec3 = [lm[0].x, lm[0].y, lm[0].z];
  const mid: Vec3 = [lm[9].x, lm[9].y, lm[9].z];
  const axisY = normalize(sub(mid, O));
  const across: Vec3 = [lm[17].x - lm[5].x, lm[17].y - lm[5].y, lm[17].z - lm[5].z];
  const along = dot(across, axisY);
  const axisX = normalize([across[0] - axisY[0] * along, across[1] - axisY[1] * along, across[2] - axisY[2] * along]);
  const axisZ = normalize(cross(axisX, axisY));
  let k = 0;
  for (const i of [5, 9, 13, 17]) k += dot(sub([lm[i].x, lm[i].y, lm[i].z], O), axisY);
  return { origin: O, axisY, axisX, axisZ, knuckleYMm: k / 4, source: "landmarks" };
}

/** Finger axes from landmarks (thumb MCP 2 to tip 4; index 5-8; middle 9-12; ring 13-16; little 17-20). */
export function fingersFromLandmarks(lm: readonly Pt3[]): FingerAxis[] {
  if (lm.length < 21) return [];
  const pairs: [FingerName, number, number][] = [
    ["thumb", 2, 4],
    ["index", 5, 8],
    ["middle", 9, 12],
    ["ring", 13, 16],
    ["little", 17, 20],
  ];
  return pairs.map(([name, a, b]) => ({ name, base: [lm[a].x, lm[a].y, lm[a].z] as Vec3, dir: normalize(sub([lm[b].x, lm[b].y, lm[b].z], [lm[a].x, lm[a].y, lm[a].z])) }));
}

/** A LAST-RESORT frame from the shape of the mesh: the longest axis as axisY (toward the wider end, which is the
 *  fingertip end when the fingers are spread), the thinnest as axisZ (its sign is arbitrary: palm and back look alike),
 *  the origin at the cut end of the arm. It has no wrist plane, so hand length and the knuckle line are not defined. */
export function frameFromPca(mesh: Mesh): HandFrame {
  const V = mesh.vertices;
  const n = V.length / 3;
  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += V[i * 3 + k] / n;
  const cov = new Array<number>(9).fill(0);
  for (let i = 0; i < n; i++) {
    const d = [V[i * 3] - c[0], V[i * 3 + 1] - c[1], V[i * 3 + 2] - c[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a * 3 + b] += (d[a] * d[b]) / n;
  }
  const { vectors } = symmetricEigen(cov, 3);
  let y = normalize(vectors[0] as Vec3);
  const x0 = normalize(vectors[1] as Vec3);
  const spreadAt = (sign: number) => {
    let lo = Infinity, hi = -Infinity, smin = Infinity, smax = -Infinity;
    for (let i = 0; i < n; i++) {
      const s = sign * dot(sub([V[i * 3], V[i * 3 + 1], V[i * 3 + 2]], c), y);
      if (s < smin) smin = s;
      if (s > smax) smax = s;
    }
    const cut = smax - 0.2 * (smax - smin);
    for (let i = 0; i < n; i++) {
      const p = sub([V[i * 3], V[i * 3 + 1], V[i * 3 + 2]], c);
      if (sign * dot(p, y) >= cut) {
        const w = dot(p, x0);
        if (w < lo) lo = w;
        if (w > hi) hi = w;
      }
    }
    return hi - lo;
  };
  if (spreadAt(-1) > spreadAt(1)) y = [-y[0], -y[1], -y[2]];
  const axisX = normalize(cross(vectors[2] as Vec3, y));
  const axisZ = normalize(cross(axisX, y));
  const b = meshBounds(mesh);
  let smin = Infinity;
  for (let i = 0; i < n; i++) smin = Math.min(smin, dot(sub([V[i * 3], V[i * 3 + 1], V[i * 3 + 2]], c), y));
  void b;
  return { origin: [c[0] + y[0] * smin, c[1] + y[1] * smin, c[2] + y[2] * smin], axisY: y, axisX, axisZ: [-axisZ[0], -axisZ[1], -axisZ[2]], source: "pca" };
}

// ---------------------------------------------------------------------------------------------------------------
// Slicing

export interface SliceLoop {
  points: Vec3[];
  closed: boolean;
  lengthMm: number;
}

/** Intersect the mesh with a plane and chain the cut segments into loops. A loop is closed when the walk returns to its
 *  start; an open chain means a hole or a non-manifold edge at the cut. */
export function sliceMesh(mesh: Mesh, point: Vec3, normalIn: Vec3): SliceLoop[] {
  const n = normalize(normalIn);
  const V = mesh.vertices, I = mesh.indices;
  const nv = V.length / 3;
  const d = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const v = (V[i * 3] - point[0]) * n[0] + (V[i * 3 + 1] - point[1]) * n[1] + (V[i * 3 + 2] - point[2]) * n[2];
    d[i] = v === 0 ? 1e-9 : v;
  }
  const pts: Vec3[] = [];
  const cache = new Map<number, number>();
  const edgePoint = (a: number, b: number): number => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * nv + hi;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const t = d[lo] / (d[lo] - d[hi]);
    const id = pts.length;
    pts.push([V[lo * 3] + (V[hi * 3] - V[lo * 3]) * t, V[lo * 3 + 1] + (V[hi * 3 + 1] - V[lo * 3 + 1]) * t, V[lo * 3 + 2] + (V[hi * 3 + 2] - V[lo * 3 + 2]) * t]);
    cache.set(key, id);
    return id;
  };
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const sa = d[a] > 0, sb = d[b] > 0, sc = d[c] > 0;
    if (sa === sb && sb === sc) continue;
    const crossing: number[] = [];
    if (sa !== sb) crossing.push(edgePoint(a, b));
    if (sb !== sc) crossing.push(edgePoint(b, c));
    if (sc !== sa) crossing.push(edgePoint(c, a));
    if (crossing.length === 2) link(crossing[0], crossing[1]);
  }
  const seen = new Set<number>();
  const loops: SliceLoop[] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // walk to one end of an open chain first (a point of degree 1), else start anywhere on a loop
    let s = start;
    {
      let prev = -1, cur = start;
      for (let guard = 0; guard < pts.length + 2; guard++) {
        const nb = adj.get(cur)!;
        const next = nb.find((x) => x !== prev && x !== cur);
        if (next === undefined || nb.length === 1) {
          s = cur;
          break;
        }
        if (next === start) break;
        prev = cur;
        cur = next;
      }
    }
    const order: number[] = [];
    let prev = -1, cur = s, closed = false;
    for (let guard = 0; guard < pts.length + 2; guard++) {
      order.push(cur);
      seen.add(cur);
      const nb = adj.get(cur)!;
      let next = nb.find((x) => x !== prev && !(order.length > 1 && x === cur));
      if (nb.length === 2 && prev !== -1) next = nb[0] === prev ? nb[1] : nb[0];
      if (next === undefined) break;
      if (next === s) {
        closed = true;
        break;
      }
      if (seen.has(next)) break;
      prev = cur;
      cur = next;
    }
    const points = order.map((i) => pts[i]);
    let len = 0;
    for (let i = 0; i + 1 < points.length; i++) len += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1], points[i + 1][2] - points[i][2]);
    if (closed && points.length > 2) len += Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1], points[0][2] - points[points.length - 1][2]);
    loops.push({ points, closed, lengthMm: len });
  }
  return loops;
}

const extentAlong = (pts: readonly Vec3[], dir: Vec3): number => {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    const s = dot(p, dir);
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  return hi - lo;
};

/** The circumference of the cut: only if the plane cuts the mesh in exactly one closed loop. */
export function sectionCircumference(mesh: Mesh, point: Vec3, normal: Vec3): { value: number | null; loops: number; reason: string } {
  const loops = sliceMesh(mesh, point, normal);
  if (loops.length === 0) return { value: null, loops: 0, reason: "the plane does not cut the mesh" };
  if (loops.length > 1) return { value: null, loops: loops.length, reason: `the plane cuts the mesh in ${loops.length} loops (a finger or the thumb crosses it, or the surface is fragmented)` };
  if (!loops[0].closed) return { value: null, loops: 1, reason: "the cut is not a closed loop (a hole in the surface at this height)" };
  return { value: loops[0].lengthMm, loops: 1, reason: "" };
}

// ---------------------------------------------------------------------------------------------------------------
// The measurement set

export interface MeasureOptions {
  /** Finger axes (from landmarks, or exact for a synthetic hand). Without them finger lengths are null. */
  fingers?: readonly FingerAxis[];
  /** How far proximal to the knuckle line the palm sections are taken (mm). Default 8. */
  sectionOffsetMm?: number;
  /** Radius (mm) of the cylinder around a finger axis within which the tip is searched. Default 12 (thumb 14). */
  fingerRadiusMm?: number;
  /** The reconstruction passed its completeness gates (reconstructionQuality().accepted). Surface area is withheld unless true. */
  accepted?: boolean;
  /** Research only: report the surface area even when the gates were not passed. */
  ignoreGate?: boolean;
}

export interface HandMeasurements {
  handLength: Quantity;
  palmBreadth: Quantity;
  palmThickness: Quantity;
  fingerLengths: Record<FingerName, Quantity>;
  circumferenceKnuckle: Quantity;
  surfaceArea: Quantity;
  frameSource: HandFrame["source"];
  notes: string[];
}

export function measureHand(mesh: Mesh, frame: HandFrame, opts: MeasureOptions = {}): HandMeasurements {
  const V = mesh.vertices;
  const nv = V.length / 3;
  const notes: string[] = ["Experimental and unvalidated: no result has been compared with a physical measurement."];
  const frameBasis: Quantity["basis"] = frame.source === "given" ? "direct" : "model";
  const frameNote = frame.source === "given" ? "geometry of the mesh, given the supplied hand frame" : `depends on a hand frame from ${frame.source}, which is a model estimate`;
  const O = frame.origin;
  const offset = opts.sectionOffsetMm ?? 8;

  // hand length
  let handLength: Quantity;
  if (frame.source === "pca") {
    handLength = none("mm", "the hand frame from the mesh shape has no wrist plane (its origin is the cut end of the arm); landmarks are needed");
  } else {
    let maxY = -Infinity;
    for (let i = 0; i < nv; i++) maxY = Math.max(maxY, dot(sub([V[i * 3], V[i * 3 + 1], V[i * 3 + 2]], O), frame.axisY));
    handLength = quantity(nv ? maxY : null, "mm", frameBasis, `wrist plane to the farthest point along the hand axis; ${frameNote}`);
  }

  // knuckle line
  let knuckleY = frame.knuckleYMm;
  let knuckleNote = "knuckle line from the hand frame";
  if (knuckleY === undefined && handLength.value !== null) {
    knuckleY = 0.56 * handLength.value;
    knuckleNote = "knuckle line ASSUMED at 56 % of the hand length (a typical proportion; individual hands differ)";
  }
  const secBasis: Quantity["basis"] = knuckleNote.startsWith("knuckle line from") ? frameBasis : "model";

  const planeAt = (y: number): Vec3 => [O[0] + frame.axisY[0] * y, O[1] + frame.axisY[1] * y, O[2] + frame.axisY[2] * y];
  const biggest = (loops: SliceLoop[]) => loops.slice().sort((a, b) => b.lengthMm - a.lengthMm)[0];

  let palmBreadth: Quantity = none("mm", "no knuckle line (needs a hand length or landmarks)");
  let circumference: Quantity = none("mm", "no knuckle line (needs a hand length or landmarks)");
  let palmThickness: Quantity = none("mm", "no knuckle line (needs a hand length or landmarks)");
  if (knuckleY !== undefined) {
    const plane = planeAt(knuckleY - offset);
    const loops = sliceMesh(mesh, plane, frame.axisY);
    const main = biggest(loops);
    palmBreadth = main
      ? quantity(extentAlong(main.points, frame.axisX), "mm", secBasis, `extent across the palm of the cross-section ${offset} mm proximal to the knuckle line; ${knuckleNote}`)
      : none("mm", "the section plane does not cut the mesh");
    const c = sectionCircumference(mesh, plane, frame.axisY);
    circumference = c.value !== null ? quantity(c.value, "mm", secBasis, `length of the single closed loop ${offset} mm proximal to the knuckle line (thumb excluded); ${knuckleNote}`) : none("mm", c.reason);
    // The thickness is read on the same section as the circumference, over the central 60 % of the palm's width. Nearer
    // the wrist the thumb joins the section, and from the side a visual hull cannot tell the thumb from the palm.
    const l = biggest(loops);
    if (l) {
      const xs = l.points.map((p) => dot(p, frame.axisX));
      const lo = Math.min(...xs), hi = Math.max(...xs);
      const mid = (lo + hi) / 2, half = 0.3 * (hi - lo);
      const central = l.points.filter((p) => Math.abs(dot(p, frame.axisX) - mid) <= half);
      palmThickness = central.length > 2 ? quantity(extentAlong(central, frame.axisZ), "mm", secBasis, `palm-to-back extent over the central 60 % of the palm width, ${offset} mm proximal to the knuckle line; ${knuckleNote}`) : none("mm", "the section is too small");
    } else palmThickness = none("mm", "the section plane does not cut the mesh");
  }

  // finger lengths
  const fingerLengths = {} as Record<FingerName, Quantity>;
  for (const name of FINGER_NAMES) fingerLengths[name] = none("mm", "needs finger axes (from hand landmarks); none were supplied");
  for (const f of opts.fingers ?? []) {
    const radial = f.name === "thumb" ? (opts.fingerRadiusMm ?? 12) + 2 : (opts.fingerRadiusMm ?? 12);
    let best = -Infinity;
    for (let i = 0; i < nv; i++) {
      const p = sub([V[i * 3], V[i * 3 + 1], V[i * 3 + 2]], f.base);
      const s = dot(p, f.dir);
      if (s <= 0) continue;
      const r = Math.hypot(p[0] - f.dir[0] * s, p[1] - f.dir[1] * s, p[2] - f.dir[2] * s);
      if (r <= radial && s > best) best = s;
    }
    fingerLengths[f.name] = Number.isFinite(best)
      ? quantity(best, "mm", frameBasis, "base point on the finger axis (joint centre) to the farthest mesh point near the axis; not the palm-crease-to-tip length of a tape")
      : none("mm", "no mesh points near this finger axis");
  }

  // surface area
  let surfaceArea: Quantity;
  if (opts.accepted === true || opts.ignoreGate) {
    surfaceArea = quantity(meshArea(mesh), "mm2", "direct", opts.accepted === true ? "sum of triangle areas of the whole mesh (gates passed); a hull mesh is a smoothed upper bound, not the skin" : "sum of triangle areas, reported WITHOUT passing the completeness gates (research only)");
  } else {
    surfaceArea = none("mm2", "withheld: the reconstruction did not pass its completeness gates (or they were not checked)");
  }
  if (frame.source !== "given") notes.push(`The hand frame comes from ${frame.source}: measurements that depend on it are model estimates.`);
  return { handLength, palmBreadth, palmThickness, fingerLengths, circumferenceKnuckle: circumference, surfaceArea, frameSource: frame.source, notes };
}
