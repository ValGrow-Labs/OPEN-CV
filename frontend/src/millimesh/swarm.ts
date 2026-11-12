// The particle effect of the capture screen (pure parts: no DOM). A VISUAL EFFECT only: the particles drifting over the
// camera picture, swarming onto the skin of the tracked hand and thickening as coverage grows are decoration drawn from
// the hand's landmarks. They are not measured points and not a 3D scan, and nothing here feeds a measurement.
import type { Landmark } from "../hand3d/handModel";

export interface Size {
  width: number;
  height: number;
}

/** Map a point of the video frame (pixels) to the canvas that covers the picture with `object-fit: cover`. */
export function videoToCanvas(p: { x: number; y: number }, video: Size, canvas: Size, mirror: boolean): { x: number; y: number } {
  const scale = Math.max(canvas.width / video.width, canvas.height / video.height);
  const ox = (canvas.width - video.width * scale) / 2;
  const oy = (canvas.height - video.height * scale) / 2;
  const x = ox + p.x * scale;
  return { x: mirror ? canvas.width - x : x, y: oy + p.y * scale };
}

/** Bones that carry skin: the four fingers and the thumb (landmark index pairs). The palm is a polygon. */
const FINGER_BONES: readonly (readonly [number, number])[] = [
  [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
];
/** Palm outline as a fan of triangles from the wrist. */
const PALM_TRIANGLES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [0, 2, 5], [0, 5, 9], [0, 9, 13], [0, 13, 17],
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** For each of `count` skin samples: which part of the hand it sits on and where. Fixed once, so the samples follow
 *  the hand from frame to frame instead of jumping. */
export interface SkinTable {
  count: number;
  /** 0..4 palm triangle, 5.. finger bone (5 + index). */
  part: Uint8Array;
  /** Two uniform random numbers per sample. */
  a: Float32Array;
  b: Float32Array;
}

export function skinTable(count: number, seed = 7): SkinTable {
  const rng = mulberry32(seed);
  const part = new Uint8Array(count);
  const a = new Float32Array(count);
  const b = new Float32Array(count);
  // The palm is about half the skin: weight the parts by a typical hand.
  const weights = [...PALM_TRIANGLES.map(() => 1.3), ...FINGER_BONES.map(() => 0.55)];
  const total = weights.reduce((s, w) => s + w, 0);
  for (let i = 0; i < count; i++) {
    let r = rng() * total;
    let p = 0;
    while (p < weights.length - 1 && r > weights[p]) r -= weights[p++];
    part[i] = p;
    a[i] = rng();
    b[i] = rng();
  }
  return { count, part, a, b };
}

/** Half width of a finger as a share of the hand's length (wrist to middle fingertip). */
const FINGER_HALF_WIDTH = 0.05;

/** Write the positions (x, y in the landmarks' own pixels) of every skin sample for this hand into `out` (2 per sample). */
export function skinSamples(landmarks: readonly Landmark[], table: SkinTable, out: Float32Array): void {
  const w = landmarks[0];
  const t = landmarks[12];
  const len = Math.hypot(t.x - w.x, t.y - w.y) || 1;
  for (let i = 0; i < table.count; i++) {
    const p = table.part[i];
    let x: number;
    let y: number;
    if (p < PALM_TRIANGLES.length) {
      const [i0, i1, i2] = PALM_TRIANGLES[p];
      // a uniform point of the triangle
      const s = Math.sqrt(table.a[i]);
      const u = 1 - s;
      const v = s * (1 - table.b[i]);
      const q = s * table.b[i];
      x = u * landmarks[i0].x + v * landmarks[i1].x + q * landmarks[i2].x;
      y = u * landmarks[i0].y + v * landmarks[i1].y + q * landmarks[i2].y;
    } else {
      const [i0, i1] = FINGER_BONES[p - PALM_TRIANGLES.length];
      const A = landmarks[i0];
      const B = landmarks[i1];
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const l = Math.hypot(dx, dy) || 1;
      const off = (table.b[i] * 2 - 1) * FINGER_HALF_WIDTH * len;
      x = A.x + dx * table.a[i] - (dy / l) * off;
      y = A.y + dy * table.a[i] + (dx / l) * off;
    }
    out[2 * i] = x;
    out[2 * i + 1] = y;
  }
}

/** The share of the particles that swarm onto the hand: some always come as soon as the hand is found, and more as
 *  the real coverage (0..100) of the view grows. */
export function swarmShare(coveragePercent: number): number {
  const c = Math.max(0, Math.min(100, Number.isFinite(coveragePercent) ? coveragePercent : 0));
  return 0.3 + 0.7 * (c / 100);
}

/** How many particles to draw: the full number scaled by the speed guard's share, never fewer than a handful. */
export function particleCount(max: number, pointFraction: number): number {
  return Math.max(24, Math.round(max * Math.max(0, Math.min(1, pointFraction))));
}
