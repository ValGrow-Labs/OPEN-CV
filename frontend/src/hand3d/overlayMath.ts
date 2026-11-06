// The geometry of the camera-view overlay (no three.js, no DOM): mapping the tracked hand from video pixels
// onto the screen exactly where the real hand is drawn, putting it into hand space (wrist at the origin, y up,
// wrist-to-middle-fingertip = 1) and building the measuring rails along the fingers. Everything writes into
// buffers the caller owns, so a frame allocates nothing.
import type { Landmark, Vec3 } from "./handModel";

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
