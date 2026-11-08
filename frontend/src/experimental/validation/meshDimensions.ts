// Dimensions read off the exported mesh (mesh.ply with per-vertex support labels) in the landmark hand frame, for the
// PHYSICAL PHANTOM validation (EXPERIMENTAL). The caliper protocol uses the same definitions (dimensions.ts):
//
//   finger_width_<f>_at_15mm   the section of the mesh perpendicular to the finger axis, 15 mm proximal to the fingertip
//                              (the farthest observed mesh point along the axis inside the finger's cylinder, radius
//                              12 mm, thumb 14 mm, as measure.ts uses); its horizontal extent (parallel to the board,
//                              perpendicular to the finger axis);
//   finger_height_<f>_at_15mm  the vertical extent (board z) of the same section, lowest to highest point;
//   finger_gap_<a>_<b>         in the vertical plane perpendicular to axis_y, 10 mm proximal to the SHORTER finger's tip
//                              (tip position measured along axis_y), the horizontal clearance between the two finger
//                              sections seen from above; 0 with the note "closed in the reconstruction (no view looked
//                              through the gap)" when one section loop holds both fingers;
//   knuckle_section_width/height  the section the reconstruction uses for palm breadth and thickness, 8 mm proximal to
//                              knuckle_y_mm, normal axis_y: horizontal extent and vertical extent.
//
// Vertices labelled support_plane, volume_cut or truncated are not observed hand surface: they count only as the board
// contact (the bottom of a vertical extent), never toward a width or a tip. All values have basis "model": their position
// rests on the landmark hand frame and finger axes (a detector's estimate), and the mesh is a visual hull (concavities
// and any space nobody looked through are filled).
import type { Mesh, Quantity } from "../common";
import type { FingerName } from "../reconstruction/measure";
import { cross, dot, normalize, type Vec3 } from "../reconstruction/linalg";
import { FINGER_SECTION_FROM_TIP_MM, FINGERS, GAP_PAIRS, GAP_PROXIMAL_TO_SHORTER_TIP_MM, KNUCKLE_SECTION_PROXIMAL_MM } from "./dimensions";

export const NOT_OBSERVED_LABELS: readonly string[] = ["support_plane", "volume_cut", "truncated"];
export const CLOSED_GAP_NOTE = "closed in the reconstruction (no view looked through the gap)";

export interface MeshDimensionInput {
  mesh: Mesh | null;
  support: Uint8Array | null;
  supportLabels: readonly string[];
  frame: { source?: string | null; origin: Vec3; axisX: Vec3; axisY: Vec3; knuckleYMm: number | null } | null;
  fingers: readonly { name: FingerName; base: Vec3; dir: Vec3 }[] | null;
  /** Why `frame` is null, when known (printed instead of the generic reason). */
  frameMissing?: string | null;
  /** Radius of the cylinder around a finger axis for the tip search (mm). Default 12, thumb +2. */
  fingerRadiusMm?: number;
}

export interface SectionLoop {
  points: Vec3[];
  /** Per point: it comes from a vertex that is board contact / cut (not observed surface). */
  board: boolean[];
  closed: boolean;
}

const UP: Vec3 = [0, 0, 1];
const mm = (value: number, note: string): Quantity => ({ value, unit: "mm", basis: "model", note });
const none = (note: string): Quantity => ({ value: null, unit: "mm", basis: "none", note });
const at = (o: Vec3, d: Vec3, s: number): Vec3 => [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s];
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Cut the mesh with a plane; chain the cut into loops; label each cut point by its nearer edge end. */
export function sliceLabelled(mesh: Mesh, notObserved: Uint8Array | null, point: Vec3, normalIn: Vec3): SectionLoop[] {
  const n = normalize(normalIn);
  const V = mesh.vertices, I = mesh.indices;
  const nv = V.length / 3;
  const d = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const v = (V[i * 3] - point[0]) * n[0] + (V[i * 3 + 1] - point[1]) * n[1] + (V[i * 3 + 2] - point[2]) * n[2];
    d[i] = v === 0 ? 1e-9 : v;
  }
  const pts: Vec3[] = [];
  const brd: boolean[] = [];
  const cache = new Map<number, number>();
  const edgePoint = (a: number, b: number): number => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * nv + hi;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const t = d[lo] / (d[lo] - d[hi]);
    pts.push([V[lo * 3] + (V[hi * 3] - V[lo * 3]) * t, V[lo * 3 + 1] + (V[hi * 3 + 1] - V[lo * 3 + 1]) * t, V[lo * 3 + 2] + (V[hi * 3 + 2] - V[lo * 3 + 2]) * t]);
    brd.push(notObserved ? notObserved[t < 0.5 ? lo : hi] === 1 : false);
    cache.set(key, pts.length - 1);
    return pts.length - 1;
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
    const cr: number[] = [];
    if (sa !== sb) cr.push(edgePoint(a, b));
    if (sb !== sc) cr.push(edgePoint(b, c));
    if (sc !== sa) cr.push(edgePoint(c, a));
    if (cr.length === 2 && cr[0] !== cr[1]) link(cr[0], cr[1]);
  }
  const seen = new Set<number>();
  const loops: SectionLoop[] = [];
  for (const s0 of adj.keys()) {
    if (seen.has(s0)) continue;
    // the component, to start an open chain at one of its ends
    const comp: number[] = [];
    const stack = [s0];
    const inComp = new Set<number>([s0]);
    while (stack.length) {
      const x = stack.pop()!;
      comp.push(x);
      for (const y of adj.get(x)!) if (!inComp.has(y)) { inComp.add(y); stack.push(y); } // fmt: skip
    }
    const start = comp.find((x) => adj.get(x)!.length === 1) ?? s0;
    const order = [start];
    seen.add(start);
    let cur = start;
    for (;;) {
      const next = adj.get(cur)!.find((x) => !seen.has(x));
      if (next === undefined) break;
      order.push(next);
      seen.add(next);
      cur = next;
    }
    for (const x of comp) seen.add(x); // branches of a non-manifold cut are dropped from this loop's walk
    const closed = order.length > 2 && adj.get(cur)!.includes(start) && adj.get(start)!.length >= 2;
    loops.push({ points: order.map((i) => pts[i]), board: order.map((i) => brd[i]), closed });
  }
  return loops;
}

/** Point-in-polygon of q in the loop, in the plane basis (e1, e2). */
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

function nearestDist(loop: SectionLoop, q: Vec3): number {
  let best = Infinity;
  for (const p of loop.points) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  return best;
}

/** The loop around q: the closed loop containing it, else the nearest loop within maxDist. */
function loopAround(loops: readonly SectionLoop[], q: Vec3, e1: Vec3, e2: Vec3, maxDist: number): SectionLoop | null {
  const inside = loops.filter((l) => contains(l, q, e1, e2));
  if (inside.length) return inside.sort((a, b) => a.points.length - b.points.length)[0]; // innermost-ish
  let best: SectionLoop | null = null, bd = maxDist;
  for (const l of loops) {
    const dd = nearestDist(l, q);
    if (dd <= bd) { bd = dd; best = l; } // fmt: skip
  }
  return best;
}

function extent(loop: SectionLoop, dir: Vec3, observedOnly: boolean): { lo: number; hi: number; n: number } {
  let lo = Infinity, hi = -Infinity, n = 0;
  loop.points.forEach((p, i) => {
    if (observedOnly && loop.board[i]) return;
    const s = dot(p, dir);
    if (s < lo) lo = s;
    if (s > hi) hi = s;
    n++;
  });
  return { lo, hi, n };
}

/** Vertical extent: top from observed points, bottom from all points (the board contact counts as the bottom). */
function verticalExtent(loop: SectionLoop): { value: number; boardContact: boolean } | null {
  const top = extent(loop, UP, true);
  const all = extent(loop, UP, false);
  if (top.n < 3) return null;
  return { value: top.hi - all.lo, boardContact: loop.board.some((b) => b) };
}

export function meshDimensions(input: MeshDimensionInput): Record<string, Quantity> {
  const out: Record<string, Quantity> = {};
  const fingerKeys = FINGERS.flatMap((f) => [`finger_width_${f}_at_${FINGER_SECTION_FROM_TIP_MM}mm`, `finger_height_${f}_at_${FINGER_SECTION_FROM_TIP_MM}mm`]);
  const gapKeys = GAP_PAIRS.map(([a, b]) => `finger_gap_${a}_${b}`);
  const knuckleKeys = ["knuckle_section_width", "knuckle_section_height"];
  const all = [...knuckleKeys, ...fingerKeys, ...gapKeys];
  const setAll = (keys: string[], why: string) => keys.forEach((k) => (out[k] = none(why)));
  const { mesh, frame } = input;
  if (!mesh || mesh.indices.length === 0) {
    setAll(all, "unavailable: the export has no mesh (mesh.ply)");
    return out;
  }
  if (!frame) {
    setAll(all, `unavailable: ${input.frameMissing ?? "the export has no hand_frame"} (the landmark hand frame and finger axes are needed)`);
    return out;
  }
  if (frame.source === "pca" || frame.source === null) {
    setAll(all, `unavailable: the hand frame is not from landmarks (source ${frame.source === null ? "null" : "pca"})`);
    return out;
  }
  const V = mesh.vertices;
  const nv = V.length / 3;
  let notObserved: Uint8Array | null = null;
  let labelNote = "";
  if (input.support && input.supportLabels.length) {
    const bad = new Set(NOT_OBSERVED_LABELS.map((l) => input.supportLabels.indexOf(l)).filter((i) => i >= 0));
    notObserved = new Uint8Array(nv);
    for (let i = 0; i < nv; i++) notObserved[i] = bad.has(input.support[i]) ? 1 : 0;
  } else labelNote = " No support labels in the mesh: board-contact vertices could not be excluded.";
  const frameNote = `landmark hand frame (${frame.source ?? "unknown source"}); visual hull mesh.${labelNote}`;

  // knuckle section
  if (frame.knuckleYMm === null) setAll(knuckleKeys, "unavailable: the hand_frame has no knuckle_y_mm");
  else {
    const n = normalize(frame.axisY);
    const w = normalize(cross(UP, n));
    const e2 = cross(n, w);
    const y = frame.knuckleYMm - KNUCKLE_SECTION_PROXIMAL_MM;
    const P = at(frame.origin, n, y);
    const loops = sliceLabelled(mesh, notObserved, P, n);
    const loop = loopAround(loops, P, w, e2, 60) ?? loops.slice().sort((a, b) => b.points.length - a.points.length)[0] ?? null;
    if (!loop) setAll(knuckleKeys, "the knuckle section plane does not cut the mesh");
    else {
      const ex = extent(loop, w, true);
      const v = verticalExtent(loop);
      const where = `section ${KNUCKLE_SECTION_PROXIMAL_MM} mm proximal to knuckle_y_mm (${loops.length} loop(s) cut, ${loop.closed ? "closed" : "OPEN"} loop used)`;
      out.knuckle_section_width = ex.n >= 3 ? mm(ex.hi - ex.lo, `horizontal extent of the ${where}, board-contact points excluded; ${frameNote}`) : none("too few observed points in the knuckle section");
      out.knuckle_section_height = v
        ? mm(v.value, `vertical extent of the ${where}${v.boardContact ? "; the bottom is the board contact (bounded by the board, not observed)" : ""}; ${frameNote}`)
        : none("too few observed points in the knuckle section");
    }
  }

  // fingers
  const fingers = input.fingers;
  if (!fingers || fingers.length === 0) {
    setAll([...fingerKeys, ...gapKeys], "unavailable: the export has no finger_axes");
    return out;
  }
  const R = input.fingerRadiusMm ?? 12;
  const tip = new Map<FingerName, { s: number; point: Vec3; base: Vec3; dir: Vec3 }>();
  for (const f of fingers) {
    const dir = normalize(f.dir);
    const radial = f.name === "thumb" ? R + 2 : R;
    let best = -Infinity;
    for (let i = 0; i < nv; i++) {
      if (notObserved && notObserved[i]) continue;
      const p: Vec3 = [V[i * 3] - f.base[0], V[i * 3 + 1] - f.base[1], V[i * 3 + 2] - f.base[2]];
      const s = dot(p, dir);
      if (s <= 0) continue;
      const r = Math.hypot(p[0] - dir[0] * s, p[1] - dir[1] * s, p[2] - dir[2] * s);
      if (r <= radial && s > best) best = s;
    }
    if (Number.isFinite(best)) tip.set(f.name, { s: best, point: at(f.base, dir, best), base: f.base, dir });
  }
  const axisPointIn = (name: FingerName, P: Vec3, n: Vec3): Vec3 | null => {
    const t = tip.get(name);
    if (!t) return null;
    const den = dot(t.dir, n);
    if (Math.abs(den) < 0.2) return null;
    const s = dot(minus(P, t.base), n) / den;
    return s > 0 && s <= t.s ? at(t.base, t.dir, s) : null;
  };
  for (const name of FINGERS) {
    const wk = `finger_width_${name}_at_${FINGER_SECTION_FROM_TIP_MM}mm`, hk = `finger_height_${name}_at_${FINGER_SECTION_FROM_TIP_MM}mm`;
    const t = tip.get(name);
    if (!fingers.some((f) => f.name === name)) { setAll([wk, hk], `unavailable: no axis for the ${name} in finger_axes`); continue; } // fmt: skip
    if (!t) { setAll([wk, hk], `no observed mesh point near the ${name}'s axis`); continue; } // fmt: skip
    if (t.s < FINGER_SECTION_FROM_TIP_MM) { setAll([wk, hk], `the ${name}'s tip is less than ${FINGER_SECTION_FROM_TIP_MM} mm from its base point`); continue; } // fmt: skip
    const n = t.dir;
    const hz = Math.hypot(n[0], n[1]);
    if (hz < 0.3) { setAll([wk, hk], `the ${name}'s axis is too steep to define a horizontal width`); continue; } // fmt: skip
    const w = normalize(cross(UP, n));
    const e2 = cross(n, w);
    const c = at(t.base, n, t.s - FINGER_SECTION_FROM_TIP_MM);
    const loops = sliceLabelled(mesh, notObserved, c, n);
    const loop = loopAround(loops, c, w, e2, name === "thumb" ? R + 2 : R);
    if (!loop) { setAll([wk, hk], `the section ${FINGER_SECTION_FROM_TIP_MM} mm from the ${name}'s tip does not cut the finger`); continue; } // fmt: skip
    const merged = FINGERS.filter((o) => o !== name).filter((o) => {
      const q = axisPointIn(o, c, n);
      return q !== null && contains(loop, q, w, e2);
    });
    if (merged.length) { setAll([wk, hk], `the ${name}'s section also holds the ${merged.join(", ")} (fingers merged in the reconstruction); not separable`); continue; } // fmt: skip
    const ex = extent(loop, w, true);
    const v = verticalExtent(loop);
    const where = `section perpendicular to the ${name}'s axis ${FINGER_SECTION_FROM_TIP_MM} mm proximal to its tip (${loop.closed ? "closed" : "OPEN"} loop)`;
    out[wk] = ex.n >= 3 ? mm(ex.hi - ex.lo, `horizontal extent of the ${where}, board-contact points excluded; ${frameNote}`) : none(`too few observed points in the ${name}'s section`);
    out[hk] = v
      ? mm(v.value, `vertical extent of the ${where}${v.boardContact ? "; the bottom reaches the board (filled down to the board: no view looked under the finger, or it rests there)" : ""}; ${frameNote}`)
      : none(`too few observed points in the ${name}'s section`);
  }

  // gaps
  const nh = normalize([frame.axisY[0], frame.axisY[1], 0]);
  const wg = normalize(cross(UP, nh));
  for (const [a, b] of GAP_PAIRS) {
    const key = `finger_gap_${a}_${b}`;
    const ta = tip.get(a), tb = tip.get(b);
    if (!ta || !tb) { out[key] = none(`unavailable: no tip found for the ${!ta ? a : b}`); continue; } // fmt: skip
    const ya = dot(minus(ta.point, frame.origin), frame.axisY), yb = dot(minus(tb.point, frame.origin), frame.axisY);
    const shorter = ya <= yb ? a : b;
    const y = Math.min(ya, yb) - GAP_PROXIMAL_TO_SHORTER_TIP_MM;
    const P = at(frame.origin, normalize(frame.axisY), y);
    const qa = axisPointIn(a, P, nh), qb = axisPointIn(b, P, nh);
    if (!qa || !qb) { out[key] = none(`the gap line (${GAP_PROXIMAL_TO_SHORTER_TIP_MM} mm proximal to the ${shorter}'s tip) lies proximal to the ${!qa ? a : b}'s base point; no gap defined there`); continue; } // fmt: skip
    const loops = sliceLabelled(mesh, notObserved, P, nh);
    const la = loopAround(loops, qa, wg, UP, R), lb = loopAround(loops, qb, wg, UP, R);
    if (!la || !lb) { out[key] = none(`the ${!la ? a : b} is not cut by the gap line`); continue; } // fmt: skip
    const where = `${GAP_PROXIMAL_TO_SHORTER_TIP_MM} mm proximal to the ${shorter}'s tip, plane perpendicular to axis_y`;
    if (la === lb) { out[key] = mm(0, `${CLOSED_GAP_NOTE}; ${where}; ${frameNote}`); continue; } // fmt: skip
    const [lo, hi] = dot(qa, wg) <= dot(qb, wg) ? [la, lb] : [lb, la];
    const elo = extent(lo, wg, true), ehi = extent(hi, wg, true);
    if (elo.n < 3 || ehi.n < 3) { out[key] = none("too few observed points in a finger section at the gap line"); continue; } // fmt: skip
    const gap = ehi.lo - elo.hi;
    out[key] = gap > 0 ? mm(gap, `horizontal clearance between the two finger sections seen from above, ${where}; ${frameNote}`) : mm(0, `the two finger outlines overlap seen from above (separate loops); ${where}; ${frameNote}`);
  }
  return out;
}

/** Exact values of these dimensions for the SYNTHETIC capsule hand where an exact value exists (for tests only). The
 *  capsule fingers lie in the hand's mid-plane, so a finger section 15 mm from the tip is a circle of the capsule radius
 *  (width = height = 2 r) and a gap is the clearance of two ellipses of half-width r / cos(splay). The thumb is lifted
 *  INTO the board in the board scene (it is clipped by the paper), so no exact thumb value is given. */
export function capsuleExactDimensions(p: {
  palmLength: number;
  palmBreadth: number;
  palmThickness: number;
  fingers: Record<Exclude<FingerName, "thumb">, { baseX: number; splayDeg: number; length: number; radius: number }>;
}): Record<string, number> {
  const out: Record<string, number> = {
    knuckle_section_width: p.palmBreadth,
    knuckle_section_height: p.palmThickness,
  };
  const names = ["index", "middle", "ring", "little"] as const;
  for (const f of names) {
    const r = p.fingers[f].radius;
    out[`finger_width_${f}_at_${FINGER_SECTION_FROM_TIP_MM}mm`] = 2 * r;
    out[`finger_height_${f}_at_${FINGER_SECTION_FROM_TIP_MM}mm`] = 2 * r;
  }
  const tipY = (f: (typeof names)[number]) => {
    const g = p.fingers[f];
    return p.palmLength + Math.cos((g.splayDeg * Math.PI) / 180) * (g.length + g.radius);
  };
  for (const [a, b] of [["index", "middle"], ["middle", "ring"], ["ring", "little"]] as const) {
    const y = Math.min(tipY(a), tipY(b)) - GAP_PROXIMAL_TO_SHORTER_TIP_MM;
    const edge = (f: (typeof names)[number], side: 1 | -1) => {
      const g = p.fingers[f];
      const s = (g.splayDeg * Math.PI) / 180;
      return g.baseX + Math.tan(s) * (y - p.palmLength) + (side * g.radius) / Math.cos(s);
    };
    out[`finger_gap_${a}_${b}`] = Math.max(0, edge(b, -1) - edge(a, 1));
  }
  return out;
}
