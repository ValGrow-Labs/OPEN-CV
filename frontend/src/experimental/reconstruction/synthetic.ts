// SYNTHETIC test hand and camera rig for the experimental reconstruction.
//
// A "capsule hand": a rounded palm slab, a wrist stub, four finger capsules and a thumb capsule, defined as a signed
// distance function (SDF) with ANALYTIC ground-truth dimensions. It is deliberately simple. It exists so that the
// reconstruction mathematics (carving, meshing, measuring) can be checked against exact numbers. It says NOTHING
// about real hands, real phones or real accuracy: every result obtained with it is synthetic and must be labelled so.
//
// Hand frame (world, millimetres): origin at the centre of the wrist plane; +y along the hand toward the fingers;
// +z out of the palm (the palm normal); +x toward the little finger (the thumb is on the -x side).
import type { BinaryMask, CameraPose, Intrinsics } from "../common";
import { intrinsicsFor, lookAtPose, normalize, pixelRay, type Vec3 } from "./linalg";
import { gaussian, makeRng } from "./rng";
import type { FingerAxis, FingerName, HandFrame } from "./measure";

export interface CapsuleHandParams {
  palmLength: number;
  palmBreadth: number;
  palmThickness: number;
  palmRounding: number;
  wristLength: number;
  wristBreadth: number;
  wristThickness: number;
  /** Finger capsules start on the knuckle plane y = palmLength and run along (sin splay, cos splay, 0). */
  fingers: Record<Exclude<FingerName, "thumb">, { baseX: number; splayDeg: number; length: number; radius: number }>;
  thumb: { baseX: number; baseY: number; angleDeg: number; liftDeg: number; length: number; radius: number };
}

/** Plausible adult proportions (millimetres). Not taken from any person. */
export const DEFAULT_HAND_PARAMS: CapsuleHandParams = {
  palmLength: 100,
  palmBreadth: 85,
  palmThickness: 24,
  palmRounding: 8,
  wristLength: 70,
  wristBreadth: 62,
  wristThickness: 40,
  fingers: {
    index: { baseX: -31, splayDeg: -6, length: 62, radius: 9 },
    middle: { baseX: -10.5, splayDeg: -1, length: 68, radius: 9.5 },
    ring: { baseX: 10.5, splayDeg: 3, length: 64, radius: 9 },
    little: { baseX: 31, splayDeg: 9, length: 48, radius: 8 },
  },
  thumb: { baseX: -38, baseY: 35, angleDeg: 42, liftDeg: 10, length: 52, radius: 10.5 },
};

/** Exact dimensions of a capsule hand, from its parameters (no measurement involved). */
export interface HandTruth {
  handLengthMm: number;
  palmBreadthMm: number;
  palmThicknessMm: number;
  fingerLengthsMm: Record<FingerName, number>;
  knuckleYMm: number;
  circumferencePlaneYMm: number;
  /** Perimeter of the palm cross-section (a rounded rectangle) at the circumference plane. */
  circumferenceMm: number;
}

export interface CapsuleHand {
  params: CapsuleHandParams;
  /** Signed distance in millimetres (negative inside). */
  sdf: (x: number, y: number, z: number) => number;
  bounds: { min: Vec3; max: Vec3 };
  truth: HandTruth;
  /** The exact hand frame and finger axes (what a perfect landmark detector would give). */
  frame: HandFrame;
  fingerAxes: FingerAxis[];
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function roundBox(px: number, py: number, pz: number, hx: number, hy: number, hz: number, rr: number): number {
  const qx = Math.abs(px) - (hx - rr);
  const qy = Math.abs(py) - (hy - rr);
  const qz = Math.abs(pz) - (hz - rr);
  const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
  const out = Math.sqrt(ox * ox + oy * oy + oz * oz); // sqrt, not Math.hypot: this runs millions of times
  return out + Math.min(Math.max(qx, qy, qz), 0) - rr;
}

/** Distance to a capsule with axis a-b, radius r; the arguments are the point and the capsule's 7 numbers. */
function capsule(px: number, py: number, pz: number, c: Float64Array, o: number): number {
  const ax = c[o], ay = c[o + 1], az = c[o + 2];
  const bax = c[o + 3] - ax, bay = c[o + 4] - ay, baz = c[o + 5] - az;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const h = clamp01((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz));
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - c[o + 6];
} // fmt: skip

export function makeCapsuleHand(params: CapsuleHandParams = DEFAULT_HAND_PARAMS): CapsuleHand {
  const p = params;
  const caps: number[] = [];
  const axes: FingerAxis[] = [];
  const fingerLengthsMm = {} as Record<FingerName, number>;
  let maxX = p.palmBreadth / 2;
  let minX = -p.palmBreadth / 2;
  let maxY = p.palmLength;
  let maxZ = p.palmThickness / 2;
  let minZ = -p.palmThickness / 2;
  for (const name of ["index", "middle", "ring", "little"] as const) {
    const f = p.fingers[name];
    const s = (f.splayDeg * Math.PI) / 180;
    const dir: Vec3 = [Math.sin(s), Math.cos(s), 0];
    const a: Vec3 = [f.baseX, p.palmLength, 0];
    const b: Vec3 = [a[0] + dir[0] * f.length, a[1] + dir[1] * f.length, 0];
    caps.push(a[0], a[1], a[2], b[0], b[1], b[2], f.radius);
    axes.push({ name, base: a, dir });
    fingerLengthsMm[name] = f.length + f.radius;
    maxX = Math.max(maxX, b[0] + f.radius);
    minX = Math.min(minX, b[0] - f.radius);
    maxY = Math.max(maxY, b[1] + f.radius);
  }
  {
    const t = p.thumb;
    const ang = (t.angleDeg * Math.PI) / 180;
    const lift = (t.liftDeg * Math.PI) / 180;
    const dir = normalize([-Math.sin(ang) * Math.cos(lift), Math.cos(ang) * Math.cos(lift), Math.sin(lift)]);
    const a: Vec3 = [t.baseX, t.baseY, 0];
    const b: Vec3 = [a[0] + dir[0] * t.length, a[1] + dir[1] * t.length, a[2] + dir[2] * t.length];
    caps.push(a[0], a[1], a[2], b[0], b[1], b[2], t.radius);
    axes.unshift({ name: "thumb", base: a, dir });
    fingerLengthsMm.thumb = t.length + t.radius;
    maxX = Math.max(maxX, b[0] + t.radius);
    minX = Math.min(minX, b[0] - t.radius);
    maxZ = Math.max(maxZ, b[2] + t.radius);
    minZ = Math.min(minZ, b[2] - t.radius);
  }
  const capsules = Float64Array.from(caps);
  const nCaps = capsules.length / 7;
  const palmCy = p.palmLength / 2;
  const palmHy = p.palmLength / 2;
  const wristCy = (-p.wristLength + 4) / 2;
  const wristHy = (p.wristLength + 4) / 2;
  const sdf = (x: number, y: number, z: number): number => {
    let d = roundBox(x, y - palmCy, z, p.palmBreadth / 2, palmHy, p.palmThickness / 2, p.palmRounding);
    const w = roundBox(x, y - wristCy, z, p.wristBreadth / 2, wristHy, p.wristThickness / 2, 6);
    if (w < d) d = w;
    for (let i = 0; i < nCaps; i++) {
      const c = capsule(x, y, z, capsules, i * 7);
      if (c < d) d = c;
    }
    return d;
  };
  const middle = p.fingers.middle;
  const circY = p.palmLength - 8;
  const rr = p.palmRounding;
  const truth: HandTruth = {
    handLengthMm: p.palmLength + (middle.length + middle.radius) * Math.cos((middle.splayDeg * Math.PI) / 180),
    palmBreadthMm: p.palmBreadth,
    palmThicknessMm: p.palmThickness,
    fingerLengthsMm,
    knuckleYMm: p.palmLength,
    circumferencePlaneYMm: circY,
    circumferenceMm: 2 * (p.palmBreadth - 2 * rr) + 2 * (p.palmThickness - 2 * rr) + 2 * Math.PI * rr,
  };
  const margin = 6;
  return {
    params: p,
    sdf,
    bounds: { min: [minX - margin, -p.wristLength - margin, Math.min(minZ, -p.wristThickness / 2) - margin], max: [maxX + margin, maxY + margin, Math.max(maxZ, p.wristThickness / 2) + margin] },
    truth,
    frame: { origin: [0, 0, 0], axisY: [0, 1, 0], axisX: [1, 0, 0], axisZ: [0, 0, 1], knuckleYMm: p.palmLength, source: "given" },
    fingerAxes: axes,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Camera rig (cameras move around a stationary hand) and silhouette rendering by sphere tracing.

export type RigViewName =
  | "palm"
  | "back"
  | "thumb"
  | "little"
  | "palm-thumb45"
  | "palm-little45"
  | "back-thumb45"
  | "back-little45"
  | "fingertips"
  | "wrist";

export const FOUR_VIEWS: RigViewName[] = ["palm", "thumb", "little", "back"];
export const EIGHT_VIEWS: RigViewName[] = [...FOUR_VIEWS, "palm-thumb45", "palm-little45", "back-thumb45", "back-little45"];

const S45 = Math.SQRT1_2;
const DIRECTIONS: Record<RigViewName, { toCamera: Vec3; up: Vec3 }> = {
  palm: { toCamera: [0, 0, 1], up: [0, 1, 0] },
  back: { toCamera: [0, 0, -1], up: [0, 1, 0] },
  thumb: { toCamera: [-1, 0, 0], up: [0, 1, 0] },
  little: { toCamera: [1, 0, 0], up: [0, 1, 0] },
  "palm-thumb45": { toCamera: [-S45, 0, S45], up: [0, 1, 0] },
  "palm-little45": { toCamera: [S45, 0, S45], up: [0, 1, 0] },
  "back-thumb45": { toCamera: [-S45, 0, -S45], up: [0, 1, 0] },
  "back-little45": { toCamera: [S45, 0, -S45], up: [0, 1, 0] },
  fingertips: { toCamera: [0, 1, 0], up: [0, 0, 1] },
  wrist: { toCamera: [0, -1, 0], up: [0, 0, 1] },
};

export interface SyntheticCapture {
  name: RigViewName;
  mask: BinaryMask;
  intrinsics: Intrinsics;
  pose: CameraPose;
}

export interface RigOptions {
  width?: number;
  height?: number;
  hfovDeg?: number;
  distanceMm?: number;
  /** The point the cameras look at; default the middle of the modelled hand's bounds. */
  center?: Vec3;
}

export function rigPoses(names: RigViewName[], opts: RigOptions = {}, hand?: CapsuleHand): { name: RigViewName; intrinsics: Intrinsics; pose: CameraPose }[] {
  const width = opts.width ?? 256;
  const height = opts.height ?? 256;
  const distance = opts.distanceMm ?? 380;
  // Aim at the middle of everything modelled (wrist stub to fingertips), so nothing falls outside the picture.
  const center: Vec3 = opts.center ?? (hand ? [(hand.bounds.min[0] + hand.bounds.max[0]) / 2, (hand.bounds.min[1] + hand.bounds.max[1]) / 2, (hand.bounds.min[2] + hand.bounds.max[2]) / 2] : [0, 57, 0]);
  const intrinsics = intrinsicsFor(width, height, opts.hfovDeg ?? 42);
  return names.map((name) => {
    const d = DIRECTIONS[name];
    const eye: Vec3 = [center[0] + d.toCamera[0] * distance, center[1] + d.toCamera[1] * distance, center[2] + d.toCamera[2] * distance];
    return { name, intrinsics, pose: lookAtPose(eye, center, d.up) };
  });
}

/** Render the silhouette of the hand seen from one camera: a ray per pixel centre, sphere-traced against the SDF. A
 *  pixel is "hand" when the ray reaches the surface. No anti-aliasing and no noise: the exact binary silhouette. */
export function renderSilhouette(hand: CapsuleHand, K: Intrinsics, pose: CameraPose, maxSteps = 160): BinaryMask {
  const { width: w, height: h } = K;
  const data = new Uint8Array(w * h);
  const b = hand.bounds;
  const c0: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const R0 = Math.hypot(b.max[0] - c0[0], b.max[1] - c0[1], b.max[2] - c0[2]);
  const sdf = hand.sdf;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const { origin: o, dir: d } = pixelRay(i, j, K, pose);
      // ray-sphere against the bounding sphere
      const ox = o[0] - c0[0], oy = o[1] - c0[1], oz = o[2] - c0[2];
      const bq = ox * d[0] + oy * d[1] + oz * d[2];
      const cq = ox * ox + oy * oy + oz * oz - R0 * R0;
      const disc = bq * bq - cq;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      let t = Math.max(-bq - sq, 0);
      const tFar = -bq + sq;
      for (let s = 0; s < maxSteps && t <= tFar; s++) {
        const dist = sdf(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t);
        if (dist < 0.02) {
          data[j * w + i] = 255;
          break;
        }
        t += Math.max(dist, 0.04);
      }
    }
  } // fmt: skip
  return { width: w, height: h, data };
}

const captureCache = new Map<string, SyntheticCapture[]>();

/** Render a set of views of a hand (cached per hand parameters and rig, so tests do not pay twice). */
export function renderCaptures(hand: CapsuleHand, names: RigViewName[], opts: RigOptions = {}): SyntheticCapture[] {
  const key = JSON.stringify([hand.params, names, opts]);
  const hit = captureCache.get(key);
  if (hit) return hit;
  const out = rigPoses(names, opts, hand).map((v) => ({ ...v, mask: renderSilhouette(hand, v.intrinsics, v.pose) }));
  captureCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Controlled noise, to ask how much an error in the inputs costs. All seeded.

/** Distance (pixels) to the other kind of pixel, signed: positive inside the mask, negative outside (chamfer). */
function signedDistance(mask: BinaryMask): Float32Array {
  const { width: w, height: h, data } = mask;
  const INF = 1e9;
  const dIn = new Float32Array(w * h); // distance to the nearest background pixel, for hand pixels
  const dOut = new Float32Array(w * h); // distance to the nearest hand pixel, for background pixels
  for (let i = 0; i < w * h; i++) {
    dIn[i] = data[i] ? INF : 0;
    dOut[i] = data[i] ? 0 : INF;
  }
  const chamfer = (d: Float32Array) => {
    const a = 1;
    const bdiag = Math.SQRT2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + a);
        if (y > 0) {
          v = Math.min(v, d[i - w] + a);
          if (x > 0) v = Math.min(v, d[i - w - 1] + bdiag);
          if (x < w - 1) v = Math.min(v, d[i - w + 1] + bdiag);
        }
        d[i] = v;
      }
    for (let y = h - 1; y >= 0; y--)
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let v = d[i];
        if (x < w - 1) v = Math.min(v, d[i + 1] + a);
        if (y < h - 1) {
          v = Math.min(v, d[i + w] + a);
          if (x < w - 1) v = Math.min(v, d[i + w + 1] + bdiag);
          if (x > 0) v = Math.min(v, d[i + w - 1] + bdiag);
        }
        d[i] = v;
      }
  };
  chamfer(dIn);
  chamfer(dOut);
  const sd = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) sd[i] = data[i] ? dIn[i] - 0.5 : -(dOut[i] - 0.5);
  return sd;
}

/** Move the silhouette boundary by a smooth random displacement of at most ``amplitudePx`` pixels (a stand-in for
 *  segmentation boundary error). */
export function jitterMask(mask: BinaryMask, amplitudePx: number, seed: number): BinaryMask {
  if (amplitudePx <= 0) return mask;
  const { width: w, height: h } = mask;
  const rng = makeRng(seed);
  const waves = Array.from({ length: 4 }, () => ({ fx: (1 + rng() * 5) / w, fy: (1 + rng() * 5) / h, ph: rng() * 2 * Math.PI, a: 0.4 + rng() }));
  const total = waves.reduce((s, q) => s + q.a, 0);
  const sd = signedDistance(mask);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (const q of waves) n += q.a * Math.sin(2 * Math.PI * (q.fx * x + q.fy * y) + q.ph);
      out[y * w + x] = sd[y * w + x] + (amplitudePx * n) / total > 0 ? 255 : 0;
    }
  return { width: w, height: h, data: out };
}

/** The camera pose with a rotation error of ``rotDeg`` about a random axis through the camera centre and a centre
 *  displacement of ``transMm`` in a random direction. */
export function perturbPose(pose: CameraPose, rotDeg: number, transMm: number, seed: number): CameraPose {
  const rng = makeRng(seed);
  const axis = normalize([gaussian(rng), gaussian(rng), gaussian(rng)]);
  const a = (rotDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  const [x, y, z] = axis;
  const Rd = [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
  const mul = (A: number[], B: readonly number[]) => {
    const o = new Array<number>(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    return o;
  };
  const R2 = mul(Rd, pose.R);
  // original centre C = -R^T t; shift it, then t' = -R' C'
  const C0: Vec3 = [-(pose.R[0] * pose.t[0] + pose.R[3] * pose.t[1] + pose.R[6] * pose.t[2]), -(pose.R[1] * pose.t[0] + pose.R[4] * pose.t[1] + pose.R[7] * pose.t[2]), -(pose.R[2] * pose.t[0] + pose.R[5] * pose.t[1] + pose.R[8] * pose.t[2])];
  const dC = normalize([gaussian(rng), gaussian(rng), gaussian(rng)]);
  const C1: Vec3 = [C0[0] + dC[0] * transMm, C0[1] + dC[1] * transMm, C0[2] + dC[2] * transMm];
  const t2: [number, number, number] = [-(R2[0] * C1[0] + R2[1] * C1[1] + R2[2] * C1[2]), -(R2[3] * C1[0] + R2[4] * C1[1] + R2[5] * C1[2]), -(R2[6] * C1[0] + R2[7] * C1[1] + R2[8] * C1[2])];
  return { R: R2, t: t2 };
}

/** The intrinsics with the focal length wrong by a factor (1.02 = 2 % too long). */
export function scaleFocal(K: Intrinsics, factor: number): Intrinsics {
  return { ...K, fx: K.fx * factor, fy: K.fy * factor };
}

