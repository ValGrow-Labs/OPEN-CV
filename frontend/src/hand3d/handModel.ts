// Geometry for the glowing 3D hand (no rendering here, so it can be tested without WebGL).
// A hand is the 21 MediaPipe landmarks; a "sampled hand" is a cloud of points attached to its bones,
// so the cloud follows any pose (a generic hand, a customer's measured points, or the live hand).
//
// Units: the wrist-to-middle-fingertip length of a pose is 1 (see normalizePose). Viewer space: x right,
// y up, z towards the viewer. genericHand() is a right hand seen from the palm side, so its thumb is at +x
// and its palm normal (cross(index base - wrist, little base - wrist)) points to +z.
//
// How a sampled point is stored (bone, t, local), by the bone index it names:
//  * a capsule bone (0-3 thumb, 5-7 index, 9-11 middle, 13-15 ring, 17-19 little): the point is
//      A + t (B - A) + e w + U u + V v
//    with A, B the bone's joints, e its axis, U the palm normal made perpendicular to e (so frames do not
//    flip when a finger bends) and V = e x U. local = (u, v, w): u, v are the offset around the axis, w an
//    offset along it (only the fingertip dome uses w).
//  * bones 4, 8, 12: the PALM, a rounded slab. Wrist-line points W_k sit across the wrist (offsets
//    PALM_WRIST_X along the palm's lateral axis) and the base line is the four finger bases J5, J9, J13,
//    J17. M_k(t) = W_k + t (base_k - W_k) runs along metacarpal k (0 index .. 3 little). A palm point is
//    M_k(t) + f (M_{k+1}(t) - M_k(t)) + d lateral + w normal, where the bone index is 4 + 4k with k in
//    0..2 and local = (f, d, w): f may fall outside 0..1 (it extrapolates past the outer metacarpals, so
//    the slab stretches with the measured pose), d is an in-plane outward offset (the rounded rim) and w
//    the offset along the palm normal (the slab's two faces).
//  * bone 16: the forearm stub behind the wrist: J0 - a (STUB_LEN t) + lateral u + normal v, with a the
//    direction from the wrist to the middle finger base, local = (u, v, 0).

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A landmark as the app has it: image pixels (y down) and an optional depth. */
export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

/** The 20 bones of the hand as pairs of landmark indices (MediaPipe topology). */
export const BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
];

/** Landmark index of each finger tip, and the joints of each finger, for labels. */
export const FINGER_TIPS = { thumb: 4, index: 8, middle: 12, ring: 16, little: 20 } as const;

export interface SampledHand {
  count: number;
  /** Per point: the bone it sits on (index into BONES) and where along it, 0..1 (the palm uses bones 4..16). */
  bone: Uint8Array;
  t: Float32Array;
  /** Per point: offset from the bone axis in the bone's own frame (units of hand length). */
  local: Float32Array; // count * 3
  /** Per point: 0..1 brightness weight (fingertips and creases sparkle more). */
  glow: Float32Array;
}

// ---------------------------------------------------------------------------------------------------------
// Constants of the body (units of hand length)

/** Radius at the start and end of every capsule bone (null: not a capsule). Continuous along a finger. */
export const BONE_RADII: readonly (readonly [number, number] | null)[] = [
  [0.085, 0.082], [0.082, 0.07], [0.07, 0.06], [0.06, 0.05], // thumb (the first bone is the thenar bulge)
  null, [0.062, 0.056], [0.056, 0.049], [0.049, 0.042], // index
  null, [0.065, 0.058], [0.058, 0.051], [0.051, 0.043], // middle
  null, [0.062, 0.055], [0.055, 0.048], [0.048, 0.041], // ring
  null, [0.053, 0.047], [0.047, 0.041], [0.041, 0.036], // little
];
export const CAPSULE_BONES: readonly number[] = [0, 1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19];
const TIP_BONES: readonly number[] = [3, 7, 11, 15, 19];
const JOINT_BASES: readonly number[] = [0, 5, 9, 13, 17]; // capsule bones that start a finger (get a start ring)

const PALM_HALF_THICKNESS = 0.05;
const PALM_P_MIN = -0.45; // palm extent across the hand, in metacarpal spacings (index = 0, little = 3)
const PALM_P_MAX = 3.35;
const PALM_WRIST_X = [-0.12, -0.04, 0.04, 0.12]; // wrist-line offsets along the lateral axis, index .. little
const STUB_LEN = 0.42;
const STUB_RU = 0.15; // forearm ellipse radii: lateral, normal
const STUB_RV = 0.085;
const DUST_SHARE = 0.08;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

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

// ---------------------------------------------------------------------------------------------------------
// The generic hand

let GENERIC: Vec3[] | null = null;

function buildGeneric(): Vec3[] {
  const J: Vec3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  const rad = (d: number) => (d * Math.PI) / 180;
  // Thumb: abducted about 38 degrees from the index, reaching out of the palm plane towards the viewer.
  const thumb: [number, number, number][] = [
    [0.09, 0.06, 0.02], // CMC
    [0.22, 0.21, 0.05], // MCP
    [0.32, 0.34, 0.08], // IP
    [0.385, 0.453, 0.11], // tip
  ];
  thumb.forEach(([x, y, z], i) => (J[1 + i] = { x, y, z }));
  // The four fingers: base position, spread (degrees towards +x), bone lengths. A little curl towards the
  // viewer (the palm side) at every joint makes the open hand slightly cupped.
  const fingers = [
    { i: 5, x: 0.15, y: 0.53, z: 0.045, spread: 9, len: [0.19, 0.11, 0.095] },
    { i: 9, x: 0.0, y: 0.55, z: 0.03, spread: 0, len: [0.215, 0.13, 0.105] },
    { i: 13, x: -0.14, y: 0.52, z: 0.04, spread: -5, len: [0.2, 0.12, 0.1] },
    { i: 17, x: -0.27, y: 0.46, z: 0.065, spread: -13, len: [0.145, 0.085, 0.09] },
  ];
  const curl = [5, 12, 20];
  for (const f of fingers) {
    let p = { x: f.x, y: f.y, z: f.z };
    J[f.i] = p;
    const sp = rad(f.spread);
    f.len.forEach((len, b) => {
      const c = rad(curl[b]);
      p = {
        x: p.x + Math.sin(sp) * Math.cos(c) * len,
        y: p.y + Math.cos(sp) * Math.cos(c) * len,
        z: p.z + Math.sin(c) * len,
      };
      J[f.i + 1 + b] = p;
    });
  }
  // Scale so the middle fingertip is exactly at y = 1 (it is straight up, x = 0).
  const s = 1 / J[12].y;
  return J.map((p) => ({ x: p.x * s, y: p.y * s, z: p.z * s }));
}

/** A canonical open right hand, 21 joints, y up, wrist at the origin, middle fingertip at y = 1. */
export function genericHand(): Vec3[] {
  if (!GENERIC) GENERIC = buildGeneric();
  return GENERIC.map((p) => ({ ...p }));
}

/** Map landmarks of any scale (image pixels, y down) to 21 joints: centred on the wrist, y up, scaled so the
 *  wrist-to-middle-fingertip length is 1. ``mirror`` flips x. Missing z becomes a gentle canonical depth. */
export function normalizePose(points: readonly Landmark[], opts?: { mirror?: boolean }): Vec3[] {
  if (!points || points.length < 21) return genericHand();
  for (let i = 0; i < 21; i++) {
    if (!points[i] || !Number.isFinite(points[i].x) || !Number.isFinite(points[i].y)) return genericHand();
  }
  const w = points[0];
  const len = Math.hypot(points[12].x - w.x, points[12].y - w.y);
  if (!(len > 1e-9)) return genericHand();
  // MediaPipe's z shares the scale of x but is noisy: it is used only when every point has a real one, and
  // is limited to a gentle relief (towards the viewer is positive here, negative in the model's output).
  let zGiven = true;
  let zNonZero = false;
  for (let i = 0; i < 21; i++) {
    const z = points[i].z;
    if (z === undefined || !Number.isFinite(z)) zGiven = false;
    else if (Math.abs(z) > 1e-9) zNonZero = true;
  }
  const useZ = zGiven && zNonZero;
  const g = genericHand();
  const sx = opts?.mirror ? -1 : 1;
  const wz = useZ ? (w.z as number) : 0;
  return points.slice(0, 21).map((p, i) => ({
    x: (sx * (p.x - w.x)) / len,
    y: -(p.y - w.y) / len,
    z: useZ ? clamp(-((p.z as number) - wz) / len, -0.35, 0.35) : g[i].z,
  }));
}

// ---------------------------------------------------------------------------------------------------------
// Frames of a pose (scratch buffers, so poseSamples allocates nothing)

const FS = 15; // per bone: A(3) L=B-A(3) e(3) U(3) V(3)
const FR = new Float64Array(20 * FS);
// palm: n(0..2) lateral(3..5) a(6..8) J0(9..11) W_k(12+3k) base_k(24+3k)
const PL = new Float64Array(36);
const TMP = new Float64Array(3);

function computeFrames(pose: readonly Vec3[]): void {
  const j0 = pose[0];
  let ax = pose[9].x - j0.x;
  let ay = pose[9].y - j0.y;
  let az = pose[9].z - j0.z;
  let al = Math.hypot(ax, ay, az) || 1;
  ax /= al;
  ay /= al;
  az /= al;
  // palm normal = cross(index base - wrist, little base - wrist)
  const bx = pose[5].x - j0.x, by = pose[5].y - j0.y, bz = pose[5].z - j0.z;
  const cx = pose[17].x - j0.x, cy = pose[17].y - j0.y, cz = pose[17].z - j0.z;
  let nx = by * cz - bz * cy;
  let ny = bz * cx - bx * cz;
  let nz = bx * cy - by * cx;
  let nl = Math.hypot(nx, ny, nz);
  if (!(nl > 1e-9)) {
    nx = 0;
    ny = 0;
    nz = 1;
    nl = 1;
  }
  nx /= nl;
  ny /= nl;
  nz /= nl;
  // lateral axis (thumb side -> little side) = cross(n, a)
  let lx = ny * az - nz * ay;
  let ly = nz * ax - nx * az;
  let lz = nx * ay - ny * ax;
  let ll = Math.hypot(lx, ly, lz);
  if (!(ll > 1e-9)) {
    lx = -1;
    ly = 0;
    lz = 0;
    ll = 1;
  }
  lx /= ll;
  ly /= ll;
  lz /= ll;
  PL[0] = nx; PL[1] = ny; PL[2] = nz;
  PL[3] = lx; PL[4] = ly; PL[5] = lz;
  PL[6] = ax; PL[7] = ay; PL[8] = az;
  PL[9] = j0.x; PL[10] = j0.y; PL[11] = j0.z;
  for (let k = 0; k < 4; k++) {
    const o = PALM_WRIST_X[k];
    PL[12 + 3 * k] = j0.x + lx * o;
    PL[13 + 3 * k] = j0.y + ly * o;
    PL[14 + 3 * k] = j0.z + lz * o;
    const bp = pose[5 + 4 * k];
    PL[24 + 3 * k] = bp.x;
    PL[25 + 3 * k] = bp.y;
    PL[26 + 3 * k] = bp.z;
  }
  for (let b = 0; b < 20; b++) {
    const o = b * FS;
    const A = pose[BONES[b][0]];
    const B = pose[BONES[b][1]];
    const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ex = dx / len, ey = dy / len, ez = dz / len;
    FR[o] = A.x; FR[o + 1] = A.y; FR[o + 2] = A.z;
    FR[o + 3] = dx; FR[o + 4] = dy; FR[o + 5] = dz;
    FR[o + 6] = ex; FR[o + 7] = ey; FR[o + 8] = ez;
    // U: the palm normal made perpendicular to the bone (stable as the finger bends)
    let d = nx * ex + ny * ey + nz * ez;
    let ux = nx - d * ex, uy = ny - d * ey, uz = nz - d * ez;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-4) {
      d = lx * ex + ly * ey + lz * ez;
      ux = lx - d * ex;
      uy = ly - d * ey;
      uz = lz - d * ez;
      ul = Math.hypot(ux, uy, uz) || 1;
    }
    ux /= ul;
    uy /= ul;
    uz /= ul;
    FR[o + 9] = ux; FR[o + 10] = uy; FR[o + 11] = uz;
    FR[o + 12] = ey * uz - ez * uy;
    FR[o + 13] = ez * ux - ex * uz;
    FR[o + 14] = ex * uy - ey * ux;
  }
}

/** Position of a palm point (f, t, d, w) into ``out``; needs computeFrames(pose) first. */
function palmAt(f: number, t: number, d: number, w: number, k: number, out: Float64Array): void {
  const k1 = k + 1;
  for (let c = 0; c < 3; c++) {
    const w0 = PL[12 + 3 * k + c];
    const m0 = w0 + t * (PL[24 + 3 * k + c] - w0);
    const w1 = PL[12 + 3 * k1 + c];
    const m1 = w1 + t * (PL[24 + 3 * k1 + c] - w1);
    out[c] = m0 + f * (m1 - m0) + d * PL[3 + c] + w * PL[c];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Sampling

/** Attach ``count`` points to the bones of ``pose`` (deterministic for a given seed). */
export function sampleHand(pose: readonly Vec3[], count: number, seed: number): SampledHand {
  computeFrames(pose);
  const rng = mulberry32(seed);
  const n = Math.max(0, Math.floor(count));
  const out: SampledHand = {
    count: n,
    bone: new Uint8Array(n),
    t: new Float32Array(n),
    local: new Float32Array(n * 3),
    glow: new Float32Array(n),
  };

  // Surface primitives with their areas (from the pose): capsule sides, fingertip domes, palm faces, rim, stub.
  const PRIM_CAPSULE = 0, PRIM_DOME = 1, PRIM_FACE = 2, PRIM_RIM = 3, PRIM_STUB = 4;
  const kinds: number[] = [];
  const ids: number[] = [];
  const cum: number[] = [];
  let total = 0;
  const add = (kind: number, id: number, area: number) => {
    total += Math.max(area, 1e-9);
    kinds.push(kind);
    ids.push(id);
    cum.push(total);
  };
  for (const b of CAPSULE_BONES) {
    const [ra, rb] = BONE_RADII[b]!;
    add(PRIM_CAPSULE, b, 2 * Math.PI * ((ra + rb) / 2) * Math.hypot(FR[b * FS + 3], FR[b * FS + 4], FR[b * FS + 5]));
  }
  for (const b of TIP_BONES) add(PRIM_DOME, b, 2 * Math.PI * BONE_RADII[b]![1] ** 2);
  let lengthSum = 0;
  for (let k = 0; k < 4; k++) {
    lengthSum += Math.hypot(PL[24 + 3 * k] - PL[12 + 3 * k], PL[25 + 3 * k] - PL[13 + 3 * k], PL[26 + 3 * k] - PL[14 + 3 * k]);
  }
  const palmLen = lengthSum / 4;
  const span = (PALM_P_MAX - PALM_P_MIN) / 3;
  const wristW = (PALM_WRIST_X[3] - PALM_WRIST_X[0]) * span;
  const baseW = Math.hypot(PL[33] - PL[24], PL[34] - PL[25], PL[35] - PL[26]) * span;
  add(PRIM_FACE, 0, 2 * ((wristW + baseW) / 2) * palmLen);
  add(PRIM_RIM, 0, 2 * palmLen * Math.PI * PALM_HALF_THICKNESS);
  add(PRIM_STUB, 0, 2 * Math.PI * ((STUB_RU + STUB_RV) / 2) * STUB_LEN);

  const TWO_PI = Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const r0 = rng() * total;
    let pi = 0;
    while (pi < cum.length - 1 && cum[pi] < r0) pi++;
    const kind = kinds[pi];
    const id = ids[pi];
    const dust = rng() < DUST_SHARE;
    const delta = dust ? 0.01 + 0.04 * rng() * rng() : 0;
    let bone = id;
    let t = 0;
    let u = 0, v = 0, w = 0;
    let glow = 0.3 + 0.3 * rng();

    if (kind === PRIM_CAPSULE) {
      const [ra, rb] = BONE_RADII[id]!;
      const rmax = Math.max(ra, rb);
      do t = rng();
      while (rng() * rmax > ra + (rb - ra) * t);
      const r = ra + (rb - ra) * t;
      const phi = TWO_PI * rng();
      const s = 1 + delta / r;
      u = r * Math.cos(phi) * s;
      v = r * Math.sin(phi) * s;
      // knuckles sparkle where bones meet; the last bone of a finger glows towards its tip
      const edge = Math.min(t, 1 - t);
      if (edge < 0.12) glow += 0.35 * (1 - edge / 0.12);
      if (TIP_BONES.includes(id) && t > 0.55) glow += 0.5 * ((t - 0.55) / 0.45);
    } else if (kind === PRIM_DOME) {
      const r = BONE_RADII[id]![1];
      const c = rng();
      const sn = Math.sqrt(1 - c * c);
      const phi = TWO_PI * rng();
      const s = 1 + delta / r;
      t = 1;
      u = r * sn * Math.cos(phi) * s;
      v = r * sn * Math.sin(phi) * s;
      w = r * c * s;
      glow = 0.85 + 0.15 * rng();
    } else if (kind === PRIM_FACE) {
      let p: number;
      do {
        p = PALM_P_MIN + (PALM_P_MAX - PALM_P_MIN) * rng();
        t = rng();
      } while (rng() * Math.max(wristW, baseW) > wristW + (baseW - wristW) * t);
      const k = clamp(Math.floor(p), 0, 2);
      bone = 4 + 4 * k;
      u = p - k;
      v = 0;
      w = (rng() < 0.5 ? -1 : 1) * (PALM_HALF_THICKNESS + delta);
      // the lines of the palm sparkle: heart line, head line and the arc round the thumb
      const pp = (p - PALM_P_MIN) / (PALM_P_MAX - PALM_P_MIN);
      const q = p / 3;
      glow = 0.3 + 0.2 * rng();
      glow += 0.55 * Math.exp(-(((t - (0.8 - 0.1 * q)) / 0.025) ** 2));
      glow += 0.55 * Math.exp(-(((t - (0.62 - 0.16 * q)) / 0.025) ** 2));
      glow += 0.65 * Math.exp(-(((q - 0.38 * (1 - t) ** 0.6) / 0.03) ** 2)) * (pp < 0.5 ? 1 : 0);
      if (t > 0.9) glow += 0.3 * ((t - 0.9) / 0.1);
    } else if (kind === PRIM_RIM) {
      const thumbSide = rng() < 0.5;
      const p = thumbSide ? PALM_P_MIN : PALM_P_MAX;
      t = rng();
      const k = clamp(Math.floor(p), 0, 2);
      bone = 4 + 4 * k;
      const psi = (rng() - 0.5) * Math.PI;
      const hh = PALM_HALF_THICKNESS + delta;
      u = p - k;
      v = (thumbSide ? -1 : 1) * hh * Math.cos(psi);
      w = hh * Math.sin(psi);
      glow = 0.45 + 0.3 * rng();
    } else {
      bone = 16;
      t = rng();
      const phi = TWO_PI * rng();
      const s = 1 + delta / ((STUB_RU + STUB_RV) / 2);
      u = STUB_RU * Math.cos(phi) * s;
      v = STUB_RV * Math.sin(phi) * s;
      glow = 0.55 * (1 - t) ** 1.5;
    }
    if (dust) glow = 0.12 + 0.2 * rng();
    out.bone[i] = bone;
    out.t[i] = t;
    out.local[3 * i] = u;
    out.local[3 * i + 1] = v;
    out.local[3 * i + 2] = w;
    out.glow[i] = clamp(glow, 0, 1);
  }
  return out;
}

/** Write the world position of every sampled point for ``pose`` into ``out`` (length count * 3). */
export function poseSamples(sampled: SampledHand, pose: readonly Vec3[], out: Float32Array): void {
  computeFrames(pose);
  const { bone, t, local, count } = sampled;
  const o3 = TMP;
  const stubX = PL[9], stubY = PL[10], stubZ = PL[11];
  const ax = PL[6], ay = PL[7], az = PL[8];
  const lx = PL[3], ly = PL[4], lz = PL[5];
  const nx = PL[0], ny = PL[1], nz = PL[2];
  for (let i = 0; i < count; i++) {
    const b = bone[i];
    const tt = t[i];
    const u = local[3 * i], v = local[3 * i + 1], w = local[3 * i + 2];
    const j = 3 * i;
    if (b === 16) {
      const s = STUB_LEN * tt;
      out[j] = stubX - ax * s + lx * u + nx * v;
      out[j + 1] = stubY - ay * s + ly * u + ny * v;
      out[j + 2] = stubZ - az * s + lz * u + nz * v;
    } else if (b === 4 || b === 8 || b === 12) {
      palmAt(u, tt, v, w, (b >> 2) - 1, o3);
      out[j] = o3[0];
      out[j + 1] = o3[1];
      out[j + 2] = o3[2];
    } else {
      const o = b * FS;
      out[j] = FR[o] + tt * FR[o + 3] + FR[o + 6] * w + FR[o + 9] * u + FR[o + 12] * v;
      out[j + 1] = FR[o + 1] + tt * FR[o + 4] + FR[o + 7] * w + FR[o + 10] * u + FR[o + 13] * v;
      out[j + 2] = FR[o + 2] + tt * FR[o + 5] + FR[o + 8] * w + FR[o + 11] * u + FR[o + 14] * v;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Wireframe

const RING = 12;
const RING_COS = Array.from({ length: RING }, (_, i) => Math.cos((2 * Math.PI * i) / RING));
const RING_SIN = Array.from({ length: RING }, (_, i) => Math.sin((2 * Math.PI * i) / RING));

/** Line-segment endpoints (pairs of xyz) outlining the bones and palm of ``pose``: the wireframe layer. */
export function handWire(pose: readonly Vec3[], opts?: { dense?: boolean }): Float32Array {
  computeFrames(pose);
  const dense = !!opts?.dense;
  const seg: number[] = [];
  const line = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    seg.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  };
  const P = [0, 0, 0];
  const Q = [0, 0, 0];

  // capsule bones: two side lines (the lateral edges) and cross-rings at the start of a finger, the middle
  // and the end of every bone (the joints)
  const ring = (cx: number, cy: number, cz: number, o: number, r: number) => {
    for (let i = 0; i < RING; i++) {
      const i2 = (i + 1) % RING;
      for (let c = 0; c < 3; c++) {
        P[c] = [cx, cy, cz][c] + r * (RING_COS[i] * FR[o + 9 + c] + RING_SIN[i] * FR[o + 12 + c]);
        Q[c] = [cx, cy, cz][c] + r * (RING_COS[i2] * FR[o + 9 + c] + RING_SIN[i2] * FR[o + 12 + c]);
      }
      line(P, Q);
    }
  };
  for (const b of CAPSULE_BONES) {
    const [ra, rb] = BONE_RADII[b]!;
    const o = b * FS;
    for (const sgn of [-1, 1]) {
      for (let c = 0; c < 3; c++) {
        P[c] = FR[o + c] + sgn * ra * FR[o + 12 + c];
        Q[c] = FR[o + c] + FR[o + 3 + c] + sgn * rb * FR[o + 12 + c];
      }
      line(P, Q);
    }
    if (JOINT_BASES.includes(b)) ring(FR[o], FR[o + 1], FR[o + 2], o, ra);
    ring(FR[o] + 0.5 * FR[o + 3], FR[o + 1] + 0.5 * FR[o + 4], FR[o + 2] + 0.5 * FR[o + 5], o, (ra + rb) / 2);
    ring(FR[o] + FR[o + 3], FR[o + 1] + FR[o + 4], FR[o + 2] + FR[o + 5], o, rb);
  }

  // palm: a grid on the face towards the viewer (+normal): lines along the hand and across it
  const hh = PALM_HALF_THICKNESS;
  // (dense: twice as many lines each way, the fine mesh of the light theme)
  const gridP = dense ? [PALM_P_MIN, 0, 0.5, 1, 1.5, 2, 2.5, 3, PALM_P_MAX] : [PALM_P_MIN, 0, 1, 2, 3, PALM_P_MAX];
  const gridT = dense ? [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1] : [0, 0.25, 0.5, 0.75, 1];
  const point = (p: number, t: number, out: number[]) => {
    const k = clamp(Math.floor(p), 0, 2);
    palmAt(p - k, t, 0, hh, k, TMP);
    out[0] = TMP[0];
    out[1] = TMP[1];
    out[2] = TMP[2];
  };
  for (const p of gridP) {
    for (let s = 0; s < 8; s++) {
      point(p, s / 8, P);
      point(p, (s + 1) / 8, Q);
      line(P, Q);
    }
  }
  for (const t of gridT) {
    for (let s = 0; s < 16; s++) {
      point(PALM_P_MIN + ((PALM_P_MAX - PALM_P_MIN) * s) / 16, t, P);
      point(PALM_P_MIN + ((PALM_P_MAX - PALM_P_MIN) * (s + 1)) / 16, t, Q);
      line(P, Q);
    }
  }

  // forearm stub: three rings and four lines along it
  const stubAt = (t: number, phi: number, out: number[]) => {
    const s = STUB_LEN * t;
    const cu = STUB_RU * Math.cos(phi);
    const cv = STUB_RV * Math.sin(phi);
    for (let c = 0; c < 3; c++) out[c] = PL[9 + c] - PL[6 + c] * s + PL[3 + c] * cu + PL[c] * cv;
  };
  for (const t of [0, 0.5, 1]) {
    for (let i = 0; i < RING; i++) {
      stubAt(t, (2 * Math.PI * i) / RING, P);
      stubAt(t, (2 * Math.PI * (i + 1)) / RING, Q);
      line(P, Q);
    }
  }
  for (let q = 0; q < 4; q++) {
    stubAt(0, (Math.PI / 2) * q, P);
    stubAt(1, (Math.PI / 2) * q, Q);
    line(P, Q);
  }
  return Float32Array.from(seg);
}

// ---------------------------------------------------------------------------------------------------------
// Measuring rings (the light theme): where a width or girth is taken

/** The bones whose middle gets a measuring ring: the middle phalanx of index, middle, ring and little. */
const MEASURE_BONES: readonly number[] = [6, 10, 14, 18];
const MEASURE_RING = 20;

/** Line-segment endpoints (pairs of xyz) of the measuring rings of ``pose``: a ring around each of the four
 *  fingers (halfway along its middle phalanx, a little wider than the finger) and one around the palm at the
 *  knuckles (the palm girth). Always the same number of segments, so a pose change only moves them. */
export function measureRings(pose: readonly Vec3[]): Float32Array {
  computeFrames(pose);
  const seg: number[] = [];
  const line = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    seg.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  };
  const P = [0, 0, 0];
  const Q = [0, 0, 0];
  for (const b of MEASURE_BONES) {
    const [ra, rb] = BONE_RADII[b]!;
    const o = b * FS;
    const r = 1.4 * ((ra + rb) / 2);
    const cx = FR[o] + 0.5 * FR[o + 3];
    const cy = FR[o + 1] + 0.5 * FR[o + 4];
    const cz = FR[o + 2] + 0.5 * FR[o + 5];
    for (let i = 0; i < MEASURE_RING; i++) {
      const a0 = (2 * Math.PI * i) / MEASURE_RING;
      const a1 = (2 * Math.PI * (i + 1)) / MEASURE_RING;
      for (let c = 0; c < 3; c++) {
        const ctr = c === 0 ? cx : c === 1 ? cy : cz;
        P[c] = ctr + r * (Math.cos(a0) * FR[o + 9 + c] + Math.sin(a0) * FR[o + 12 + c]);
        Q[c] = ctr + r * (Math.cos(a1) * FR[o + 9 + c] + Math.sin(a1) * FR[o + 12 + c]);
      }
      line(P, Q);
    }
  }
  // palm girth: a loop around the slab at the knuckles (over the front face, back over the rear face)
  const hh = PALM_HALF_THICKNESS * 1.25;
  const T = 0.62;
  const N = 14;
  const loop: number[][] = [];
  const at = (p: number, w: number) => {
    const k = clamp(Math.floor(p), 0, 2);
    palmAt(p - k, T, 0, w, k, TMP);
    loop.push([TMP[0], TMP[1], TMP[2]]);
  };
  for (let s = 0; s <= N; s++) at(PALM_P_MIN + ((PALM_P_MAX - PALM_P_MIN) * s) / N, hh);
  for (let s = N; s >= 0; s--) at(PALM_P_MIN + ((PALM_P_MAX - PALM_P_MIN) * s) / N, -hh);
  for (let i = 0; i < loop.length; i++) line(loop[i], loop[(i + 1) % loop.length]);
  return Float32Array.from(seg);
}
