// SYNTHETIC hands for the tests of the pose reader. A plausible 21-point hand is built in 3D (millimetres, from simple
// anatomical proportions), posed, viewed from any direction, mirrored for a left hand, scaled, noised and projected.
// This proves the reader's logic only: it is not real MediaPipe output and says nothing about accuracy on real hands.

export type Four = "index" | "middle" | "ring" | "little";

export interface FingerFlex {
  mcp: number;
  pip: number;
  dip: number;
}

export interface PoseSpec {
  fingers: Record<Four, FingerFlex>;
  /** Degrees each finger is turned in the palm plane away from straight ahead, positive toward the thumb side. */
  splay: Record<Four, number>;
  /** Abduction: the angle of the thumb's first bone from the palm axis (about 20 resting, 70 and more when out). */
  thumb: { abduction: number; mcp: number; ip: number };
}

export interface ViewSpec {
  /** Rotation of the hand in the image plane, degrees. */
  inPlaneDeg?: number;
  /** Turn about the vertical axis: 0 palm to the camera, 90 the hand seen from the side. */
  yawDeg?: number;
  /** Turn about the horizontal axis. */
  pitchDeg?: number;
  /** A left hand (the right hand reflected). */
  mirror?: boolean;
  /** Pixels per millimetre of the image landmarks. */
  scale?: number;
  /** Noise as a fraction of the wrist-to-middle-fingertip length (about 176 mm): Gaussian, per coordinate. */
  noiseFrac?: number;
  seed?: number;
}

export interface SyntheticHand {
  /** Image landmarks in pixels (x right, y down), no z. */
  landmarks: { x: number; y: number }[];
  /** World landmarks in metres. */
  world: { x: number; y: number; z: number }[];
}

type V = [number, number, number];

const STRAIGHT: FingerFlex = { mcp: 0, pip: 0, dip: 0 };
/** Wrist-to-middle-fingertip length of the model with a straight finger, mm. */
export const HAND_LENGTH_MM = 176;

// Knuckle (MCP) positions in the hand frame: x toward the thumb side, y toward the fingertips, z out of the palm.
const MCP: Record<Four, V> = { index: [29, 82, 0], middle: [10, 86, 0], ring: [-9, 82, 0], little: [-26, 72, 0] };
const LENGTHS: Record<Four, [number, number, number]> = { index: [40, 23, 19], middle: [44, 26, 20], ring: [41, 25, 19], little: [32, 18, 17] };
const THUMB_CMC: V = [18, 10, 0];
const THUMB_LENGTHS: [number, number, number] = [38, 30, 25];

const rad = (d: number) => (d * Math.PI) / 180;

/** The 21 points in the hand frame (right hand). */
function handFrame(p: PoseSpec): V[] {
  const out: V[] = new Array(21);
  out[0] = [0, 0, 0];
  // Thumb: its bones lie in the palm plane, turning toward -x (across the palm) as it flexes.
  {
    let alpha = p.thumb.abduction;
    let pos = THUMB_CMC;
    out[1] = pos;
    const angles = [alpha, alpha - p.thumb.mcp, alpha - p.thumb.mcp - p.thumb.ip];
    for (let k = 0; k < 3; k++) {
      alpha = angles[k];
      pos = [pos[0] + THUMB_LENGTHS[k] * Math.sin(rad(alpha)), pos[1] + THUMB_LENGTHS[k] * Math.cos(rad(alpha)), pos[2]];
      out[2 + k] = pos;
    }
  }
  (["index", "middle", "ring", "little"] as Four[]).forEach((f, fi) => {
    const base = 5 + fi * 4;
    const splay = rad(p.splay[f]);
    const flex = p.fingers[f];
    let pos = MCP[f];
    out[base] = pos;
    const cum = [flex.mcp, flex.mcp + flex.pip, flex.mcp + flex.pip + flex.dip];
    for (let k = 0; k < 3; k++) {
      // Flexion turns the +y direction toward +z (the palm side), then the splay turns it about z toward +x.
      const c = Math.cos(rad(cum[k]));
      const s = Math.sin(rad(cum[k]));
      const d: V = [Math.sin(splay) * c, Math.cos(splay) * c, s];
      pos = [pos[0] + LENGTHS[f][k] * d[0], pos[1] + LENGTHS[f][k] * d[1], pos[2] + LENGTHS[f][k] * d[2]];
      out[base + 1 + k] = pos;
    }
  });
  return out;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

type M = [V, V, V];
const mul = (a: M, b: M): M => {
  const r: M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return r;
};
const apply = (m: M, v: V): V => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
const rotX = (d: number): M => [[1, 0, 0], [0, Math.cos(rad(d)), -Math.sin(rad(d))], [0, Math.sin(rad(d)), Math.cos(rad(d))]];
const rotY = (d: number): M => [[Math.cos(rad(d)), 0, Math.sin(rad(d))], [0, 1, 0], [-Math.sin(rad(d)), 0, Math.cos(rad(d))]];
const rotZ = (d: number): M => [[Math.cos(rad(d)), -Math.sin(rad(d)), 0], [Math.sin(rad(d)), Math.cos(rad(d)), 0], [0, 0, 1]];

/** Build the landmarks and world landmarks of a posed hand as a camera sees it (MediaPipe convention: x right, y down, z away). */
export function makeHand(pose: PoseSpec, view: ViewSpec = {}): SyntheticHand {
  const { inPlaneDeg = 0, yawDeg = 0, pitchDeg = 0, mirror = false, scale = 2.5, noiseFrac = 0, seed = 1 } = view;
  const rand = mulberry32(seed);
  const frame = handFrame(pose);
  // Hand frame -> camera frame for a palm facing the camera: y_cam = -y_hand, z_cam = -z_hand (a half turn about x).
  const R = mul(rotZ(inPlaneDeg), mul(rotX(pitchDeg), mul(rotY(yawDeg), rotX(180))));
  const sigma = noiseFrac * HAND_LENGTH_MM;
  const cam = frame.map((p) => {
    const q: V = mirror ? [-p[0], p[1], p[2]] : p;
    return apply(R, q);
  });
  const world = cam.map((p) => ({
    x: (p[0] + sigma * gaussian(rand)) / 1000,
    y: (p[1] + sigma * gaussian(rand)) / 1000,
    z: (p[2] + sigma * gaussian(rand)) / 1000,
  }));
  const landmarks = cam.map((p) => ({
    x: 320 + scale * (p[0] + sigma * gaussian(rand)),
    y: 320 + scale * (p[1] + sigma * gaussian(rand)),
  }));
  return { landmarks, world };
}

// ---- Named poses (flexion in degrees per joint; sums are the finger's true total flexion) ----------------------
const FLAT: Record<Four, FingerFlex> = { index: STRAIGHT, middle: STRAIGHT, ring: STRAIGHT, little: STRAIGHT };
const CURLED: FingerFlex = { mcp: 85, pip: 100, dip: 65 }; // 250 in total
const HALF: FingerFlex = { mcp: 35, pip: 45, dip: 20 }; // 100 in total
const TOGETHER = { index: 3, middle: 0, ring: -2, little: -5 }; // neighbours 3, 2, 3 degrees apart
const APART = { index: 33, middle: 11, ring: -11, little: -33 }; // 22 degrees apart
const MILD = { index: 21, middle: 7, ring: -7, little: -21 }; // 14 degrees apart
const THUMB_IN = { abduction: 20, mcp: 0, ip: 0 };
const THUMB_OUT = { abduction: 75, mcp: 0, ip: 0 };
const THUMB_ACROSS = { abduction: 20, mcp: 45, ip: 55 };

const withFingers = (p: PoseSpec, patch: Partial<Record<Four, FingerFlex>>): PoseSpec => ({ ...p, fingers: { ...p.fingers, ...patch } });

export const POSES = {
  open_palm_thumb_out: { fingers: FLAT, splay: TOGETHER, thumb: THUMB_OUT } as PoseSpec,
  open_palm_mild: { fingers: FLAT, splay: MILD, thumb: THUMB_IN } as PoseSpec,
  fingers_spread: { fingers: FLAT, splay: APART, thumb: THUMB_OUT } as PoseSpec,
  fingers_together: { fingers: FLAT, splay: TOGETHER, thumb: THUMB_IN } as PoseSpec,
  fist: { fingers: { index: CURLED, middle: CURLED, ring: CURLED, little: CURLED }, splay: TOGETHER, thumb: THUMB_ACROSS } as PoseSpec,
  thumbs_up: { fingers: { index: CURLED, middle: CURLED, ring: CURLED, little: CURLED }, splay: TOGETHER, thumb: THUMB_OUT } as PoseSpec,
  relaxed_thumb_out: { fingers: { index: HALF, middle: HALF, ring: HALF, little: HALF }, splay: TOGETHER, thumb: THUMB_OUT } as PoseSpec,
  pointing: { fingers: { index: STRAIGHT, middle: CURLED, ring: CURLED, little: CURLED }, splay: TOGETHER, thumb: THUMB_ACROSS } as PoseSpec,
  index_extended: { fingers: { index: STRAIGHT, middle: HALF, ring: HALF, little: HALF }, splay: TOGETHER, thumb: THUMB_IN } as PoseSpec,
  relaxed: { fingers: { index: HALF, middle: HALF, ring: HALF, little: HALF }, splay: TOGETHER, thumb: THUMB_IN } as PoseSpec,
} as const;

/** An open hand with one finger bent (the thumb flexes across the palm). */
export function oneFingerBent(finger: Four | "thumb"): PoseSpec {
  const open = POSES.fingers_together;
  if (finger === "thumb") return { ...open, thumb: { abduction: 20, mcp: 40, ip: 50 } };
  return withFingers(open, { [finger]: { mcp: 80, pip: 95, dip: 60 } });
}
