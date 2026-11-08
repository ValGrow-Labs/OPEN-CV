// Pure helpers of the experimental mesh viewer (no three.js, no React): named views, colour tables, bounds, the scale grid,
// label counts and input checks. Kept apart so they are unit-tested in node and shared by the wrapper and the scene.
//
// Coordinates: the viewer expects millimetres in a BOARD frame: +z up out of the board the hand rests on (palm-down),
// +x roughly along the fingers, the board plane is z = 0. An optional anatomical hand frame (origin, x toward the little
// finger, y toward the fingers, z out of the palm) names the views anatomically; without one, views are named by the board
// axes and the viewer says so.

export type V3 = [number, number, number];

/** An anatomical hand frame in the mesh's coordinates (axes need not be exactly unit; they are normalised here). */
export interface ViewerHandFrame {
  origin: ArrayLike<number>;
  /** Toward the little finger. */
  x: ArrayLike<number>;
  /** Toward the fingertips. */
  y: ArrayLike<number>;
  /** Out of the palm. */
  z: ArrayLike<number>;
}

export interface CleanFrame {
  origin: V3;
  x: V3;
  y: V3;
  z: V3;
}

export type DisplayMode = "surface" | "wireframe" | "points";
export type ColourMode = "plain" | "support" | "confidence";

export const DISPLAY_LABELS: Record<DisplayMode, string> = { surface: "Surface", wireframe: "Wireframe", points: "Point cloud" };
export const COLOUR_LABELS: Record<ColourMode, string> = { plain: "Plain", support: "Support", confidence: "Confidence" };

export type ViewPresetId =
  | "top"
  | "palm"
  | "back"
  | "thumb"
  | "little"
  | "fingertips"
  | "wrist"
  // board-axis fallbacks (no hand frame)
  | "bottom"
  | "plus-x"
  | "minus-x"
  | "plus-y"
  | "minus-y";

export interface ViewPreset {
  id: ViewPresetId;
  label: string;
  /** Unit vector from the target toward the camera. */
  toCamera: V3;
  /** Screen-up direction (orthogonal to toCamera). */
  up: V3;
  /** True when this view looks at the side the hand rests on (the board-bounded side). */
  facesBoard: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// small vector maths

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export function unit(a: V3): V3 {
  const l = len(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0];
}
const WORLD_UP: V3 = [0, 0, 1];

/** The first of `candidates` not (nearly) parallel to `dir`, made orthogonal to it. */
function chooseUp(dir: V3, candidates: V3[]): V3 {
  for (const c of candidates) {
    const u = unit(c);
    if (len(u) === 0 || Math.abs(dot(u, dir)) > 0.95) continue;
    return unit(sub(u, scale(dir, dot(u, dir))));
  }
  const fallback: V3 = Math.abs(dir[2]) < 0.95 ? [0, 0, 1] : [1, 0, 0];
  return unit(sub(fallback, scale(dir, dot(fallback, dir))));
}

const toV3 = (a: ArrayLike<number> | null | undefined): V3 | null => {
  if (!a || a.length < 3) return null;
  const v: V3 = [Number(a[0]), Number(a[1]), Number(a[2])];
  return v.every(Number.isFinite) ? v : null;
};

/** A usable frame (finite origin, three non-degenerate, roughly independent axes), with unit axes; otherwise null. */
export function cleanFrame(f: ViewerHandFrame | null | undefined): CleanFrame | null {
  if (!f) return null;
  const o = toV3(f.origin), x = toV3(f.x), y = toV3(f.y), z = toV3(f.z);
  if (!o || !x || !y || !z) return null;
  if (len(x) < 1e-9 || len(y) < 1e-9 || len(z) < 1e-9) return null;
  const ux = unit(x), uy = unit(y), uz = unit(z);
  if (Math.abs(dot(ux, uy)) > 0.9 || Math.abs(dot(ux, uz)) > 0.9 || Math.abs(dot(uy, uz)) > 0.9) return null;
  return { origin: o, x: ux, y: uy, z: uz };
}

/** A hand frame of the reconstruction module (measure.ts HandFrame: axisX/axisY/axisZ) as a viewer frame. */
export function viewerFrameOf(f: { origin: ArrayLike<number>; axisX: ArrayLike<number>; axisY: ArrayLike<number>; axisZ: ArrayLike<number> }): ViewerHandFrame {
  return { origin: f.origin, x: f.axisX, y: f.axisY, z: f.axisZ };
}

/** True when the palm faces down into the board (the hand frame's palm normal points against board +z). */
export function isPalmDown(frame: CleanFrame | null): boolean {
  return !!frame && dot(frame.z, WORLD_UP) < -0.5;
}

/** The preset views: anatomical with a hand frame, board-axis names without one. */
export function viewPresets(frame: CleanFrame | null): ViewPreset[] {
  if (!frame) {
    const v = (id: ViewPresetId, label: string, toCamera: V3, up: V3[]): ViewPreset => ({ id, label, toCamera, up: chooseUp(toCamera, up), facesBoard: id === "bottom" });
    return [
      v("top", "Top (+z)", [0, 0, 1], [[1, 0, 0]]),
      v("bottom", "Underside (−z)", [0, 0, -1], [[1, 0, 0]]),
      v("plus-x", "+x end", [1, 0, 0], [WORLD_UP]),
      v("minus-x", "−x end", [-1, 0, 0], [WORLD_UP]),
      v("plus-y", "+y side", [0, 1, 0], [WORLD_UP]),
      v("minus-y", "−y side", [0, -1, 0], [WORLD_UP]),
    ];
  }
  const { x, y, z } = frame;
  const palmDown = isPalmDown(frame);
  // Fingers up on screen for views along the palm normal; board-up (or the back of the hand) up for the side views.
  const flatY = unit(sub(y, scale(WORLD_UP, dot(y, WORLD_UP))));
  const sideUp: V3[] = [WORLD_UP, scale(z, -1), y];
  const v = (id: ViewPresetId, label: string, toCamera: V3, up: V3[], facesBoard = false): ViewPreset => ({ id, label, toCamera: unit(toCamera), up: chooseUp(unit(toCamera), up), facesBoard });
  return [
    v("top", "Top", WORLD_UP, [flatY, y, [1, 0, 0]]),
    v("palm", "Palm", z, [y], palmDown),
    v("back", "Back", scale(z, -1), [y], !palmDown && dot(z, WORLD_UP) > 0.5),
    v("thumb", "Thumb side", scale(x, -1), sideUp),
    v("little", "Little-finger side", x, sideUp),
    v("fingertips", "Fingertips", y, sideUp),
    v("wrist", "Wrist", scale(y, -1), sideUp),
  ];
}

/** The framed "home" view: from above, a little from the wrist and the thumb side (or -x, -y without a frame). */
export function homeView(frame: CleanFrame | null): { toCamera: V3; up: V3 } {
  const toCamera = frame ? unit(add(add(scale(WORLD_UP, 0.78), scale(frame.y, -0.5)), scale(frame.x, -0.38))) : unit([-0.5, -0.38, 0.78]);
  return { toCamera, up: chooseUp(toCamera, [WORLD_UP]) };
}

// ---------------------------------------------------------------------------------------------------------------
// support labels and confidence colours

/** Per-vertex support codes (quality.ts vertexSupport): the legend words, in code order 0..4. */
export const SUPPORT_LEGEND: { code: number; name: string; words: string; detail: string; colour: string }[] = [
  { code: 0, name: "observed", words: "observed", detail: "a silhouette contour passes through it", colour: "#1f5eea" },
  { code: 1, name: "implied", words: "implied", detail: "inside every silhouette, no contour touches it", colour: "#9a74db" },
  { code: 2, name: "support_plane", words: "bounded by the board, not observed", detail: "flat where the hand rests on the board", colour: "#a3acbb" },
  { code: 3, name: "volume_cut", words: "cut at the forearm", detail: "the end of the scanned volume, not hand surface", colour: "#12a189" },
  { code: 4, name: "truncated", words: "truncated (a failure)", detail: "shaped by the search box, not by any view", colour: "#e03131" },
];

/** Confidence ramp: low (rose) to high (accent blue). Deliberately not orange: orange is the landmark skeleton. */
export const CONFIDENCE_LOW = "#e8487f";
export const CONFIDENCE_HIGH = "#1f5eea";
export const PLAIN_SURFACE = "#9cb7ec";
export const POINT_PLAIN = "#1f5eea";
export const SKELETON_COLOUR = "#ff7a1a";
export const SKELETON_JOINT = "#e8590c";

export function hexToRgb(hex: string): V3 {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** RGB (0..1) per label, for a vertex or point colour attribute. Unknown codes are drawn as truncated (a failure). */
export function supportColours(labels: ArrayLike<number>): Float32Array {
  const table = SUPPORT_LEGEND.map((s) => hexToRgb(s.colour));
  const out = new Float32Array(labels.length * 3);
  for (let i = 0; i < labels.length; i++) {
    const c = table[labels[i]] ?? table[4];
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}

/** RGB (0..1) per confidence value in 0..1 (clamped; non-finite counts as 0). */
export function confidenceColours(conf: ArrayLike<number>): Float32Array {
  const lo = hexToRgb(CONFIDENCE_LOW), hi = hexToRgb(CONFIDENCE_HIGH);
  const out = new Float32Array(conf.length * 3);
  for (let i = 0; i < conf.length; i++) {
    const raw = conf[i];
    const t = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    out[i * 3] = lo[0] + (hi[0] - lo[0]) * t;
    out[i * 3 + 1] = lo[1] + (hi[1] - lo[1]) * t;
    out[i * 3 + 2] = lo[2] + (hi[2] - lo[2]) * t;
  }
  return out;
}

/** How many labels of each code 0..4 (others counted as 4). */
export function supportCounts(labels: ArrayLike<number>): number[] {
  const c = [0, 0, 0, 0, 0];
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i];
    c[k >= 0 && k <= 4 ? k : 4]++;
  }
  return c;
}

/** Share of values at or above `threshold` (0..1). */
export function shareAtLeast(values: ArrayLike<number>, threshold: number): number {
  if (values.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) if (values[i] >= threshold) n++;
  return n / values.length;
}

// ---------------------------------------------------------------------------------------------------------------
// bounds, extents, grid

export interface Bounds {
  min: V3;
  max: V3;
  size: V3;
  center: V3;
  radius: number;
}

/** Axis-aligned bounds of x, y, z triples (non-finite points skipped); null when there are none. */
export function boundsOf(positions: ArrayLike<number> | null | undefined): Bounds | null {
  if (!positions || positions.length < 3) return null;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  if (!Number.isFinite(min[0])) return null;
  const size: V3 = sub(max, min);
  const center: V3 = scale(add(min, max), 0.5);
  return { min, max, size, center, radius: Math.max(len(size) / 2, 1e-6) };
}

/** Extents of the points along the hand frame's axes (breadth along x, length along y, thickness along z). */
export function frameExtents(positions: ArrayLike<number>, frame: CleanFrame): { breadth: number; length: number; thickness: number } | null {
  if (positions.length < 3) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const axes = [frame.x, frame.y, frame.z];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const p: V3 = [positions[i], positions[i + 1], positions[i + 2]];
    if (!p.every(Number.isFinite)) continue;
    for (let a = 0; a < 3; a++) {
      const d = dot(p, axes[a]);
      if (d < lo[a]) lo[a] = d;
      if (d > hi[a]) hi[a] = d;
    }
  }
  if (!Number.isFinite(lo[0])) return null;
  return { breadth: hi[0] - lo[0], length: hi[1] - lo[1], thickness: hi[2] - lo[2] };
}

export interface GridSpec {
  /** Height of the grid plane (slightly below the geometry so it never z-fights with a flat board face). */
  z: number;
  /** The plane the grid stands for, for the words (0 for the board plane). */
  planeZ: number;
  onBoard: boolean;
  step: number;
  majorEvery: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** A round grid step (1, 2, 5 x 10^k) giving at most about 40 squares across the given extent. */
export function gridStep(extent: number): number {
  if (!(extent > 0)) return 1;
  const raw = extent / 40;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** The scale grid under the geometry: on the board plane z = 0 when the geometry rests on it, else just under its lowest point. */
export function gridFor(b: Bounds): GridSpec {
  const extent = Math.max(b.size[0], b.size[1], b.size[2], 1e-6);
  const step = gridStep(Math.max(b.size[0], b.size[1]) * 1.4 || extent);
  const majorEvery = 5;
  const major = step * majorEvery;
  const onBoard = Math.abs(b.min[2]) <= 0.05 * extent + 2;
  const planeZ = onBoard ? 0 : b.min[2];
  const z = Math.min(planeZ, b.min[2]) - Math.max(0.3, 0.004 * extent);
  const pad = Math.max(b.size[0], b.size[1]) * 0.2 + step;
  return {
    z,
    planeZ,
    onBoard,
    step,
    majorEvery,
    x0: Math.floor((b.min[0] - pad) / major) * major,
    x1: Math.ceil((b.max[0] + pad) / major) * major,
    y0: Math.floor((b.min[1] - pad) / major) * major,
    y1: Math.ceil((b.max[1] + pad) / major) * major,
  };
}

const fmtStep = (s: number) => (s >= 1 ? String(Math.round(s)) : s.toPrecision(1));
export function gridWords(g: GridSpec, unitName: string): string {
  const where = g.onBoard ? "on the board plane (z = 0)" : `just under the lowest point (z = ${g.planeZ.toFixed(1)} ${unitName})`;
  return `Grid: ${fmtStep(g.step)} ${unitName} squares, darker every ${fmtStep(g.step * g.majorEvery)} ${unitName}, ${where}`;
}

// ---------------------------------------------------------------------------------------------------------------
// landmarks (MediaPipe topology)

export const LANDMARK_COUNT = 21;
/** MediaPipe hand connections: wrist 0, thumb 1-4, index 5-8, middle 9-12, ring 13-16, little 17-20. */
export const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
]; // fmt: skip

/** 21 landmarks as a flat Float32Array(63), from either 21 triples or 63 numbers; null when the input is not 21 finite points. */
export function cleanLandmarks(lm: ArrayLike<number> | readonly ArrayLike<number>[] | null | undefined): Float32Array | null {
  if (!lm) return null;
  const out = new Float32Array(LANDMARK_COUNT * 3);
  if (lm.length === LANDMARK_COUNT * 3 && typeof (lm as ArrayLike<number>)[0] === "number") {
    for (let i = 0; i < out.length; i++) out[i] = Number((lm as ArrayLike<number>)[i]);
  } else if (lm.length === LANDMARK_COUNT) {
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      const p = (lm as readonly ArrayLike<number>[])[i];
      if (!p || typeof p !== "object" || p.length < 3) return null;
      out[i * 3] = Number(p[0]);
      out[i * 3 + 1] = Number(p[1]);
      out[i * 3 + 2] = Number(p[2]);
    }
  } else return null;
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) return null;
  return out;
}

/** "228 × 95 × 46" with sensible precision. */
export function fmtSize(v: number): string {
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}
