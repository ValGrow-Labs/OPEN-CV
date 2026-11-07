// The geometry of the camera-view overlay (no three.js, no DOM): mapping the tracked hand from video pixels
// onto the screen exactly where the real hand is drawn, putting it into hand space (wrist at the origin, y up,
// wrist-to-middle-fingertip = 1) and building the measuring rails along the fingers. Everything writes into
// buffers the caller owns, so a frame allocates nothing.
import type { Landmark, SampledHand, Vec3 } from "./handModel";

export interface ContainRect {
  /** Screen pixels per video pixel. */
  s: number;
  /** Where the video's top-left corner is on the screen. */
  ox: number;
  oy: number;
}

/** The part of an element a video fills with ``object-fit: contain``. */
export function containRect(elW: number, elH: number, fw: number, fh: number): ContainRect {
  if (!(fw > 0 && fh > 0 && elW > 0 && elH > 0)) return { s: 1, ox: 0, oy: 0 };
  const s = Math.min(elW / fw, elH / fh);
  return { s, ox: (elW - fw * s) / 2, oy: (elH - fh * s) / 2 };
}

/** True when every landmark has a finite depth and at least one is not zero (MediaPipe always gives one). */
export function hasDepth(points: readonly Landmark[]): boolean {
  let some = false;
  for (let i = 0; i < 21; i++) {
    const z = points[i].z;
    if (z === undefined || !Number.isFinite(z)) return false;
    if (Math.abs(z) > 1e-9) some = true;
  }
  return some;
}

/** Landmarks in video pixels -> screen pixels (x, y) and relief (towards the viewer positive), 3 numbers each.
 *  ``mirror``: the video is shown flipped (a front camera), so the layer is flipped about the video's centre. */
export function mapToElement(
  src: readonly Landmark[],
  fw: number,
  rect: ContainRect,
  mirror: boolean,
  useZ: boolean,
  out: Float32Array | number[],
): void {
  const wz = useZ ? (src[0].z as number) : 0;
  for (let i = 0; i < 21; i++) {
    const p = src[i];
    out[i * 3] = rect.ox + (mirror ? fw - p.x : p.x) * rect.s;
    out[i * 3 + 1] = rect.oy + p.y * rect.s;
    out[i * 3 + 2] = useZ ? -((p.z as number) - wz) * rect.s : 0;
  }
}

export interface HandFrame {
  /** The wrist on the screen, and the screen length of wrist -> middle fingertip. */
  x0: number;
  y0: number;
  len: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Hand space from screen-space joints (3 numbers each): the wrist at the origin, y up, length 1. The relief is
 *  taken from the joints only when ``useZ`` (and limited), otherwise from the generic hand. False when the hand
 *  is too small on screen to place. */
export function normalizeInto(
  cur: ArrayLike<number>,
  pose: Vec3[],
  generic: readonly Vec3[],
  useZ: boolean,
  zGain: number,
  out: HandFrame,
): boolean {
  const x0 = cur[0];
  const y0 = cur[1];
  const len = Math.hypot(cur[36] - x0, cur[37] - y0);
  if (!(len > 4)) return false;
  for (let i = 0; i < 21; i++) {
    const p = pose[i];
    p.x = (cur[i * 3] - x0) / len;
    p.y = -(cur[i * 3 + 1] - y0) / len;
    p.z = useZ ? clamp((cur[i * 3 + 2] * zGain) / len, -0.35, 0.35) : generic[i].z;
  }
  out.x0 = x0;
  out.y0 = y0;
  out.len = len;
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Measuring rails

/** Knuckle -> tip of each finger: the same pairs the live finger lengths are measured between. */
export const FINGER_RAILS: readonly (readonly [number, number])[] = [
  [2, 4],
  [5, 8],
  [9, 12],
  [13, 16],
  [17, 20],
];

const TICK = 0.045; // half the length of an end cap, in hand lengths
const RAIL_LIFT = 0.04; // the rails float a little above the skin
/** How far the hand-length rail stands out from the hand, on the little-finger side. */
export const HAND_RAIL_OFFSET = 0.56;

export const FINGER_RAIL_VERTS = FINGER_RAILS.length * 3 * 2; // rail + two end caps, per finger
export const HAND_RAIL_VERTS = 5 * 2; // rail, two end caps and two guide lines back to the wrist and the tip
export const BEADS_PER_FINGER = 9;
export const BEADS_ON_HAND_RAIL = 13;
export const BEAD_COUNT = FINGER_RAILS.length * BEADS_PER_FINGER + BEADS_ON_HAND_RAIL;

export interface RailInfo {
  /** The middle of the hand-length rail, in hand space. */
  mx: number;
  my: number;
  /** +1 when the rail stands to the right of the hand on the screen, -1 to the left. */
  side: number;
}

const set = (a: Float32Array, o: number, x: number, y: number, z: number) => {
  a[o] = x;
  a[o + 1] = y;
  a[o + 2] = z;
};

/** Which side of the hand the hand-length rail stands on, as +1 (the little-finger side) or -1, so that it and
 *  its label stay inside a picture ``width`` px wide: the hand is at (x0, len) on the screen. The little-finger
 *  side unless there is no room for it there and more room on the other. */
export function railSide(pose: readonly Vec3[], x0: number, len: number, width: number, room = 90): number {
  let sx = pose[17].x - pose[5].x;
  const sy = pose[17].y - pose[5].y;
  const sl = Math.hypot(sx, sy) || 1;
  sx /= sl;
  // the outermost screen x the rail reaches on each side, and how much space is left beyond it
  const reach = (dir: number) => x0 + (dir > 0 ? Math.max(pose[0].x, pose[12].x) : Math.min(pose[0].x, pose[12].x)) * len + dir * sx * HAND_RAIL_OFFSET * len;
  const roomOn = (dir: number) => (sx * dir >= 0 ? width - reach(dir) : reach(dir));
  const a = roomOn(1);
  const b = roomOn(-1);
  return a >= room || a >= b ? 1 : -1;
}

/** Fill the finger rails (FINGER_RAIL_VERTS vertices) and the hand-length rail (HAND_RAIL_VERTS vertices) as
 *  line-segment pairs, and the beads (BEAD_COUNT points) strung along them. ``railDir`` is +1 for the hand-length
 *  rail on the little-finger side, -1 on the other (see ``railSide``). */
export function fillRails(
  pose: readonly Vec3[],
  fingers: Float32Array,
  hand: Float32Array,
  beads: Float32Array,
  info: RailInfo,
  railDir = 1,
): void {
  let f = 0;
  let b = 0;
  for (const [ia, ib] of FINGER_RAILS) {
    const a = pose[ia];
    const e = pose[ib];
    let dx = e.x - a.x;
    let dy = e.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const px = -dy * TICK;
    const py = dx * TICK;
    const za = a.z + RAIL_LIFT;
    const ze = e.z + RAIL_LIFT;
    set(fingers, f, a.x, a.y, za);
    set(fingers, f + 3, e.x, e.y, ze);
    set(fingers, f + 6, a.x - px, a.y - py, za);
    set(fingers, f + 9, a.x + px, a.y + py, za);
    set(fingers, f + 12, e.x - px, e.y - py, ze);
    set(fingers, f + 15, e.x + px, e.y + py, ze);
    f += 18;
    for (let i = 0; i < BEADS_PER_FINGER; i++) {
      const t = i / (BEADS_PER_FINGER - 1);
      set(beads, b, a.x + (e.x - a.x) * t, a.y + (e.y - a.y) * t, za + (ze - za) * t);
      b += 3;
    }
  }

  // the hand-length rail: a dimension line beside the hand, from the wrist level to the middle fingertip level
  const w = pose[0];
  const tip = pose[12];
  let sx = pose[17].x - pose[5].x;
  let sy = pose[17].y - pose[5].y;
  const sl = Math.hypot(sx, sy) || 1;
  sx = (sx / sl) * railDir;
  sy = (sy / sl) * railDir;
  const p0x = w.x + sx * HAND_RAIL_OFFSET;
  const p0y = w.y + sy * HAND_RAIL_OFFSET;
  const p1x = tip.x + sx * HAND_RAIL_OFFSET;
  const p1y = tip.y + sy * HAND_RAIL_OFFSET;
  const z0 = w.z + RAIL_LIFT;
  const z1 = tip.z + RAIL_LIFT;
  let rx = p1x - p0x;
  let ry = p1y - p0y;
  const rl = Math.hypot(rx, ry) || 1;
  rx /= rl;
  ry /= rl;
  const qx = -ry * TICK * 1.6;
  const qy = rx * TICK * 1.6;
  set(hand, 0, p0x, p0y, z0);
  set(hand, 3, p1x, p1y, z1);
  set(hand, 6, p0x - qx, p0y - qy, z0);
  set(hand, 9, p0x + qx, p0y + qy, z0);
  set(hand, 12, p1x - qx, p1y - qy, z1);
  set(hand, 15, p1x + qx, p1y + qy, z1);
  set(hand, 18, w.x, w.y, w.z); // guide lines from the wrist and the tip out to the rail
  set(hand, 21, p0x, p0y, z0);
  set(hand, 24, tip.x, tip.y, tip.z);
  set(hand, 27, p1x, p1y, z1);
  for (let i = 0; i < BEADS_ON_HAND_RAIL; i++) {
    const t = i / (BEADS_ON_HAND_RAIL - 1);
    set(beads, b, p0x + (p1x - p0x) * t, p0y + (p1y - p0y) * t, z0 + (z1 - z0) * t);
    b += 3;
  }
  info.mx = (p0x + p1x) / 2;
  info.my = (p0y + p1y) / 2;
  info.side = sx >= 0 ? 1 : -1;
}

/** The brightness of each bead: the ends of a rail shine, the ticks between are softer. */
export function beadGlow(): Float32Array {
  const g = new Float32Array(BEAD_COUNT);
  let i = 0;
  for (let r = 0; r < FINGER_RAILS.length; r++) {
    for (let k = 0; k < BEADS_PER_FINGER; k++) g[i++] = k === 0 || k === BEADS_PER_FINGER - 1 ? 1 : 0.5;
  }
  for (let k = 0; k < BEADS_ON_HAND_RAIL; k++) g[i++] = k === 0 || k === BEADS_ON_HAND_RAIL - 1 ? 1.15 : k % 3 === 0 ? 0.85 : 0.5;
  return g;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The extent of a pose in hand space (for the scanning sweep). */
export function poseBounds(pose: readonly Vec3[], out: Bounds): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 21; i++) {
    const p = pose[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  out.minX = minX;
  out.maxX = maxX;
  out.minY = minY;
  out.maxY = maxY;
}

/** 0 -> 1 -> 0 over one period (the sweep goes up and down the hand). */
export function triangle(t: number, period: number): number {
  const u = (((t % period) + period) % period) / period;
  return u < 0.5 ? u * 2 : 2 - u * 2;
}

// ---------------------------------------------------------------------------------------------------------
// The skin of the hologram: which points are on the edge, and the halo of dust round the hand

/** The bone indices the sampler uses for the palm (a slab) and the forearm stub (see handModel.ts). */
const PALM_BONES = new Set([4, 8, 12]);
const FOREARM_BONE = 16;

/** How near each point is to the silhouette of the hand, 0 (the middle of a face) to 1 (the very edge), seen from
 *  the palm side or the back (the hand is drawn flat to the camera). A finger is a tube round its axis: the edge
 *  is where the offset runs sideways rather than towards the viewer; the palm is a slab: its rim; the forearm
 *  likewise. This is a one-off table (the brightness of an edge in the shader), not a per-frame cost. */
export function rimWeights(sampled: SampledHand): Float32Array {
  const out = new Float32Array(sampled.count);
  const l = sampled.local;
  for (let i = 0; i < sampled.count; i++) {
    const a = l[3 * i];
    const b = l[3 * i + 1];
    const c = l[3 * i + 2];
    const bone = sampled.bone[i];
    let rim: number;
    if (PALM_BONES.has(bone)) rim = Math.abs(b) / (Math.abs(b) + Math.abs(c) + 1e-6); // in-plane rim vs the two faces
    else if (bone === FOREARM_BONE) rim = Math.abs(a) / (Math.abs(a) + Math.abs(b) + 1e-6); // lateral vs normal
    else rim = Math.abs(b) / (Math.abs(a) + Math.abs(b) + 1e-6); // v is the sideways offset round the axis
    out[i] = Math.min(1, Math.max(0, rim));
  }
  return out;
}

/** The same points pushed out from the skin: a soft shell of dust round the hand. Only the offsets away from the
 *  bone are scaled (a capsule's u, v; a palm point's in-plane and normal offsets; the forearm's), never the position
 *  along it, so the halo still follows every pose. ``rand`` gives each point its own distance. */
export function haloOf(sampled: SampledHand, rand: () => number, lo = 1.7, hi = 2.7): SampledHand {
  const local = new Float32Array(sampled.local);
  const glow = new Float32Array(sampled.count);
  for (let i = 0; i < sampled.count; i++) {
    const k = lo + (hi - lo) * rand();
    const bone = sampled.bone[i];
    if (PALM_BONES.has(bone)) {
      local[3 * i + 1] *= k;
      local[3 * i + 2] *= k;
    } else if (bone === FOREARM_BONE) {
      local[3 * i] *= k;
      local[3 * i + 1] *= k;
    } else {
      local[3 * i] *= k;
      local[3 * i + 1] *= k;
    }
    glow[i] = 0.08 + 0.14 * rand();
  }
  return { count: sampled.count, bone: sampled.bone, t: sampled.t, local, glow };
}

/** The 21 joints, lifted a little above the skin, as the positions of the glowing nodes (63 numbers). */
export function fillNodes(pose: readonly Vec3[], out: Float32Array, lift = 0.05): void {
  for (let i = 0; i < 21; i++) {
    out[i * 3] = pose[i].x;
    out[i * 3 + 1] = pose[i].y;
    out[i * 3 + 2] = pose[i].z + lift;
  }
}

/** The brightness of each node: the fingertips and the wrist shine most, the middle joints are quieter. */
export function nodeGlow(): Float32Array {
  const g = new Float32Array(21);
  for (let i = 0; i < 21; i++) g[i] = i === 0 || i % 4 === 0 ? 1.15 : i % 4 === 1 ? 0.7 : 0.5;
  return g;
}

// ---------------------------------------------------------------------------------------------------------
// The orbit rings and the sparkles round the hand (the reference look: two thin luminous rings that tilt gently
// round a glowing hand). Pure maths; the layer owns the buffers.

export interface OrbitFrame {
  /** The middle of the hand, in hand space, and the half-extents of its box (so the rings and sparkles hug it). */
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

/** The orbit frame of a pose's bounds: the centre of the box and half its width and height. A frame with no
 *  extent (a hand not yet placed) is the unit hand. */
export function orbitFrameOf(b: Bounds, out: OrbitFrame): void {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const ok = Number.isFinite(w) && Number.isFinite(h) && w > 1e-4 && h > 1e-4;
  out.cx = ok ? (b.minX + b.maxX) / 2 : 0;
  out.cy = ok ? (b.minY + b.maxY) / 2 : 0.5;
  out.hw = ok ? w / 2 : 0.35;
  out.hh = ok ? h / 2 : 0.55;
}

/** The radius of an orbit ring round a hand: a share of its larger half-extent, so a ring always clears the hand
 *  (A is the wide ring, B the inner one). */
export const RING_A = 1.32;
export const RING_B = 1.08;
export function ringRadius(f: OrbitFrame, share: number): number {
  return Math.max(f.hw, f.hh) * share;
}

/** Ease a frame towards a target, ``settleMs`` to about 95% of the way (the same exponential as the palette), so
 *  the rings follow the hand without the jitter of the tracking. A frame that has just appeared jumps. */
export function easeFrame(cur: OrbitFrame, tgt: OrbitFrame, dtMs: number, settleMs: number, jump: boolean): void {
  const k = jump || !(settleMs > 0) ? 1 : 1 - Math.exp((-3 * Math.max(0, dtMs)) / settleMs);
  cur.cx += (tgt.cx - cur.cx) * k;
  cur.cy += (tgt.cy - cur.cy) * k;
  cur.hw += (tgt.hw - cur.hw) * k;
  cur.hh += (tgt.hh - cur.hh) * k;
}

export interface OrbitPose {
  /** Tilt of the ring's plane away from the screen (radians): near pi/2 is an edge-on, flat ellipse. */
  tilt: number;
  /** Turn of the ellipse in the screen plane (radians). */
  turn: number;
}

/** A ring's gentle breathing at time ``t`` seconds: ``which`` 0 is the wide ring, 1 the inner one. With reduced
 *  motion (``t`` fixed by the caller) the same function gives a steady pose. */
export function orbitPose(t: number, which: 0 | 1, out: OrbitPose): void {
  if (which === 0) {
    out.tilt = 1.22 + 0.06 * Math.sin(t * 0.5);
    out.turn = -0.34 + 0.06 * Math.sin(t * 0.37 + 1);
  } else {
    out.tilt = 0.98 + 0.06 * Math.sin(t * 0.43 + 2);
    out.turn = 0.42 + 0.06 * Math.sin(t * 0.31);
  }
}

/** The bright bead that runs round a ring: its place on the unit circle at ``t`` seconds (``speed`` turns per
 *  second, a little different on every ring), and how much of the ring's glow it gets (full on the half nearest
 *  the viewer, dimmer behind the hand). The ring's plane is tilted so that y > 0 is the near side. */
export function orbitBead(t: number, speed: number, phase: number, out: { x: number; y: number; glow: number }): void {
  const a = (t * speed + phase) * Math.PI * 2;
  out.x = Math.cos(a);
  out.y = Math.sin(a);
  out.glow = out.y > 0 ? 1 : 0.45;
}

/** Sparkle positions on a loose shell round the hand: ``n`` points as (x, y, z) in a unit ellipse space (scale
 *  by the hand's half-extents), none inside the silhouette (radius 1.0 and out), thinning towards the edge. */
export function sparkleShell(n: number, rand: () => number, out: Float32Array, glow: Float32Array, seed: Float32Array): void {
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const rho = 1.02 + 0.8 * rand() * rand(); // most close to the outline, a few far
    out[i * 3] = Math.cos(a) * rho;
    out[i * 3 + 1] = Math.sin(a) * rho;
    out[i * 3 + 2] = (rand() - 0.5) * 0.5;
    glow[i] = 0.15 + 0.6 * rand();
    seed[i] = rand();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Labels round the hand (the live scan): two columns in the margins of the visible picture, each label joined by a
// thin leader line to the exact point it measures. Pure: nothing here touches the DOM.
//
// Rules (also the documentation of the layout):
//  * Side. Every label PREFERS a column as drawn for an unmirrored picture (the overlay's tags say left for the
//    index, thumb and palm width, right for the middle, ring and pinky fingers). A mirrored picture (front camera)
//    swaps the preference. The preference gives way to geometry: when the measured point lies clearly on the
//    other side of the hand's middle (more than 15% of the hand's width), the leader would cross the hand, so the
//    nearer margin is used. That also covers left and right hands. The hand-length label follows its bracket: it
//    sits on whichever side the bracket was drawn.
//  * Columns. The labels of a side line up with their inner edge a fixed lead away from the hand's outer edge (or
//    the bracket's, whichever sticks out more), and are stacked top to bottom in the order of their measured points,
//    pushed apart by a minimum gap, kept inside the picture and under a reserve at the top (the guidance pill).
//  * Not enough room. A label that is wider than its margin is dropped; if a column is too tall for the picture the
//    labels with the highest priority number go first. Nothing ever overflows the picture.
// ---------------------------------------------------------------------------------------------------------------

export type LabelSide = "left" | "right";

/** The gap between the picture's edge and a label, between stacked labels, and the length of a leader's first leg. */
export const LABEL_EDGE = 4;
export const LABEL_GAP = 6;
export const LABEL_LEAD = 16;
/** A point further than this share of the hand's width from the hand's middle belongs to the nearer margin. */
export const LABEL_CROSS = 0.15;

/** The side a label goes to: its preference (swapped when mirrored), unless the measured point is clearly on the other half. */
export function sideFor(preferred: LabelSide, mirrored: boolean, x: number, handMinX: number, handMaxX: number): LabelSide {
  const pref: LabelSide = mirrored ? (preferred === "left" ? "right" : "left") : preferred;
  const mid = (handMinX + handMaxX) / 2;
  const reach = LABEL_CROSS * (handMaxX - handMinX);
  if (pref === "left" && x > mid + reach) return "right";
  if (pref === "right" && x < mid - reach) return "left";
  return pref;
}

export interface LabelIn {
  /** The measured point on the picture (where the leader ends). */
  x: number;
  y: number;
  /** The label's size. */
  w: number;
  h: number;
  side: LabelSide;
  /** Lower is kept first when there is no room for everyone. */
  priority: number;
}

export interface LabelOut {
  visible: boolean;
  /** Top-left corner of the label. */
  left: number;
  top: number;
  /** Where the leader leaves the label (the middle of its inner edge). */
  x1: number;
  y1: number;
}

export interface LabelFrame {
  /** The visible picture, in element pixels. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** The hand's outer edges on the picture; ``lo`` / ``hi`` also cover a bracket drawn beside the hand. */
  loX: number;
  hiX: number;
  /** Room kept free at the top of the picture (the guidance pill). */
  topReserve: number;
}

/** The room kept free at the top of a picture ``h`` pixels tall (the guidance pill sits there). */
export function topReserveFor(h: number): number {
  return Math.min(76, Math.max(0, h * 0.34));
}

const byPriority = (a: number, b: number, ins: readonly LabelIn[]) => ins[a].priority - ins[b].priority || a - b;

/** Place the labels. ``out`` must have one entry per input; returns how many are visible. Allocation-free apart from two small index arrays. */
export function layoutLabels(ins: readonly LabelIn[], frame: LabelFrame, out: LabelOut[]): number {
  const roomL = frame.loX - LABEL_LEAD - (frame.left + LABEL_EDGE);
  const roomR = frame.right - LABEL_EDGE - (frame.hiX + LABEL_LEAD);
  const top0 = frame.top + frame.topReserve;
  const avail = frame.bottom - LABEL_EDGE - top0;
  let shown = 0;
  for (let i = 0; i < ins.length; i++) out[i].visible = false;
  for (const side of ["left", "right"] as const) {
    const room = side === "left" ? roomL : roomR;
    // who is on this side and fits across, best priority first
    const idx: number[] = [];
    for (let i = 0; i < ins.length; i++) {
      if (ins[i].side === side && ins[i].w <= room && ins[i].h <= avail) idx.push(i);
    }
    idx.sort((a, b) => byPriority(a, b, ins));
    // keep the best ones that fit the column's height
    let used = 0;
    const kept: number[] = [];
    for (const i of idx) {
      const need = ins[i].h + (kept.length ? LABEL_GAP : 0);
      if (used + need > avail) continue;
      used += need;
      kept.push(i);
    }
    // top to bottom in the order of the measured points
    kept.sort((a, b) => ins[a].y - ins[b].y || a - b);
    const tops: number[] = [];
    let prevBottom = top0 - LABEL_GAP;
    for (const i of kept) {
      const t = Math.max(prevBottom + LABEL_GAP, Math.min(frame.bottom - LABEL_EDGE - ins[i].h, ins[i].y - ins[i].h / 2), top0);
      tops.push(t);
      prevBottom = t + ins[i].h;
    }
    // if the column ran past the bottom, lift it back up
    let nextTop = frame.bottom - LABEL_EDGE + LABEL_GAP;
    for (let k = kept.length - 1; k >= 0; k--) {
      const i = kept[k];
      tops[k] = Math.min(tops[k], nextTop - LABEL_GAP - ins[i].h);
      nextTop = tops[k];
    }
    kept.forEach((i, k) => {
      const o = out[i];
      const inner = side === "left" ? frame.loX - LABEL_LEAD : frame.hiX + LABEL_LEAD;
      o.visible = true;
      o.left = side === "left" ? inner - ins[i].w : inner;
      o.top = tops[k];
      o.x1 = inner;
      o.y1 = tops[k] + ins[i].h / 2;
      shown++;
    });
  }
  return shown;
}
