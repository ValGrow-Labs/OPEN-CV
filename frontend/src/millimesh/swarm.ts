// The "3D mesh" of the capture screen (pure parts: no DOM). A VISUAL EFFECT only: a dense, fine lattice of dots, contour
// lines, a scan frame and a scan line drawn over the hand from its 21 tracked landmarks. It looks like a scanned surface
// but it is decoration: the dots are not measured points and not a 3D scan, and nothing here feeds a measurement.
//
// How the lattice works. Every dot has FIXED coordinates inside the part of the hand it sits on, chosen once and never
// random per frame:
//   * each finger (thumb, index, middle, ring, little) is a strip: `u` runs along the finger from its base joint to a few
//     millimetres past its tip (rows across the finger every few pixels), `v` runs across it from -1 to +1 (columns). The
//     strip narrows towards the tip and closes in a dome beyond the tip landmark, so the finger reads as a round shape;
//   * the palm is a Coons patch between four curves taken from the landmarks (wrist line, thumb side, knuckle line, little
//     finger side): `a` runs from the thumb side to the little-finger side, `b` from the wrist to the knuckles. The patch
//     reaches out to the true outline: the thumb strip's inner edge and the little finger's outer edge;
//   * the places a strip or the palm does not reach are small quadrilateral patches of their own: the thenar (the ball of
//     the thumb, between the wrist and the thumb), the wrist stub (a little forearm below the wrist line) and the four webs
//     (the skin between two neighbouring fingers at their bases, up to the crotch of the web). Their rows have a few dots
//     more or fewer as the patch gets wider or narrower, so the spacing of the dots is the same over the whole hand.
// Odd rows are shifted by half a column (a hex-like grid), so the dots are even, not stripy. Each frame only the 21
// landmarks change, so every dot keeps its place on the hand from frame to frame and moves with it: nothing jumps.
// Dots near the edge of the hand carry a "rim" weight (1 at the silhouette, 0 in the middle): they are drawn brighter and
// with a glow, the middle ones dimmer so the skin shows through. The side of a finger that faces its neighbour is not a
// silhouette at its base (the web fills the gap), so it does not glow there. Which side that is depends on the hand
// (left or right, front or back) and is worked out from the landmarks every frame.
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

// ------------------------------------------------------------------------------------------------------------------
// The lattice

/** Landmark chains of the five fingers: thumb (from its CMC joint), index, middle, ring, little (from their knuckles). */
export const FINGER_CHAINS: readonly (readonly [number, number, number, number])[] = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
/** Part ids: 0..4 a finger, then the palm, the thenar, the wrist stub and the four webs (thumb-index .. ring-little). */
export const PALM = 5;
export const THENAR = 6;
export const STUB = 7;
export const WEB0 = 8;
export const PART_COUNT = 12;
const QUAD0 = THENAR; // the quadrilateral patches are the parts from here on
const QUADS = PART_COUNT - QUAD0;
/** The most rows a quadrilateral patch can have (the per-row dot counts are kept in a fixed array). */
const MAX_ROWS = 32;

/** Half width of each finger at its base, as a share of the hand's length (wrist to middle fingertip). */
const FINGER_HALF_WIDTH = [0.085, 0.056, 0.058, 0.054, 0.046];
/** How much a finger narrows between its base and its tip, and where its dome begins. */
const TAPER = 0.3;
const DOME_FROM = 0.86;
/** The strip runs this much (share of the finger) past the tip landmark: a fingertip is a few millimetres beyond it. */
export const FINGER_CAP = 0.09;
/** Where the tip landmark sits along a strip (u). */
export const TIP_U = 1 / (1 + FINGER_CAP);
/** How far up a finger (u) the web between it and its neighbour reaches (the thumb: the share of its proximal bone). */
const WEB_UP = 0.15;
const THUMB_WEB = 0.55;
/** Target distance between two neighbouring dots, as a share of the hand's length (sets how many dots a patch row gets). */
export const SPACING = 0.0115;
/** The wrist stub: how much forearm is covered below the wrist line (share of the hand's length), and the bulge of the thenar. */
export const STUB_LENGTH = 0.17;
const BULGE = 0.3;
/** How far the little-finger edge of the palm (the heel of the hand) bulges out from the straight line wrist - little finger. */
const HEEL_BULGE = 0.035;

export interface LatticeConfig {
  fingerRows: number;
  /** Columns of each finger's strip, thumb .. little: the thumb is much the broadest and longest, the little finger the slimmest. */
  fingerCols: readonly number[];
  palmRows: number;
  palmCols: number;
  thenarRows: number;
  /** The most dots a thenar / stub / web row can have (a row has fewer where the patch is narrow). */
  thenarCols: number;
  stubRows: number;
  stubCols: number;
  webRows: number;
  webCols: number;
}

/** About 3960 dots at most (a few of the web and thenar slots are empty on any one hand), spaced about the same on the
 *  fingers, the palm, the thenar, the webs and the wrist (about 5.5 px apart on a hand 500 px long): fine enough to read as a
 *  scanned surface on a phone-sized hand. */
export const FULL_LATTICE: LatticeConfig = {
  fingerRows: 40,
  fingerCols: [16, 10, 10, 9, 7],
  palmRows: 35,
  palmCols: 35,
  thenarRows: 20,
  thenarCols: 6,
  stubRows: 14,
  stubCols: 28,
  webRows: 6,
  webCols: 6,
};

const rowsOf = (c: LatticeConfig, q: number): number => (q === 0 ? c.thenarRows : q === 1 ? c.stubRows : c.webRows);
const colsOf = (c: LatticeConfig, q: number): number => (q === 0 ? c.thenarCols : q === 1 ? c.stubCols : c.webCols);

export function latticeSize(c: LatticeConfig): number {
  return c.fingerRows * c.fingerCols.reduce((a, b) => a + b, 0) + c.palmRows * c.palmCols + c.thenarRows * c.thenarCols + c.stubRows * c.stubCols + 4 * c.webRows * c.webCols;
}

export interface Lattice {
  count: number;
  /** 0..4 a finger, then PALM, THENAR, STUB and the webs (WEB0 ..). */
  part: Uint8Array;
  /** Along the finger (0 base .. 1 past the tip) / from the thumb side to the little-finger side of the palm (0..1) /
   *  along a thenar, stub or web patch row by row (0..1). */
  u: Float32Array;
  /** Across the finger (-1..1) / from the wrist to the knuckles of the palm (0..1) / across a patch's row (nominal, 0..1). */
  v: Float32Array;
  /** 0 in the middle .. 1 on the silhouette edge (fingers and palm; a patch's rim depends on where its dot lands, see latticePoints). */
  rim: Float32Array;
  /** 0..1, even over the lattice: the dots with the lowest rank are shown first (and kept when a slow phone shows fewer). */
  rank: Float32Array;
  /** A fixed phase per dot for the shimmer. */
  phase: Float32Array;
  /** Patch dots: which row and which column of it (the dot is shown when its column is within the row's count this frame). */
  row: Uint8Array;
  col: Uint8Array;
  /** Finger dots: the side of the strip (+1 / -1 = the sign of v). */
  side: Int8Array;
  config: LatticeConfig;
}

const GOLDEN = 0.6180339887498949;
const frac = (x: number) => x - Math.floor(x);

export function buildLattice(config: LatticeConfig = FULL_LATTICE): Lattice {
  const { fingerRows, fingerCols, palmRows, palmCols } = config;
  if (fingerCols.length !== 5) throw new Error("a lattice needs a column count for each of the five fingers");
  for (let q = 0; q < QUADS; q++) if (rowsOf(config, q) > MAX_ROWS) throw new Error("too many rows in a lattice patch");
  const count = latticeSize(config);
  const part = new Uint8Array(count);
  const u = new Float32Array(count);
  const v = new Float32Array(count);
  const rim = new Float32Array(count);
  const rank = new Float32Array(count);
  const phase = new Float32Array(count);
  const row = new Uint8Array(count);
  const col = new Uint8Array(count);
  const side = new Int8Array(count);
  let i = 0;
  const put = (p: number, uu: number, vv: number, r: number, rr = 0, cc = 0) => {
    part[i] = p;
    u[i] = uu;
    v[i] = vv;
    rim[i] = Math.max(0, Math.min(1, r));
    rank[i] = frac((i + 1) * GOLDEN);
    phase[i] = frac((i + 1) * 0.7548776662466927) * Math.PI * 2;
    row[i] = rr;
    col[i] = cc;
    side[i] = p < 5 ? (vv >= 0 ? 1 : -1) : 0;
    i++;
  };
  for (let f = 0; f < 5; f++) {
    const fstep = 2 / fingerCols[f];
    for (let r = 0; r < fingerRows; r++) {
      const uu = (r + 0.5) / fingerRows;
      for (let c = 0; c < fingerCols[f]; c++) {
        const vv = -1 + fstep * (c + 0.25 + (r & 1 ? 0.5 : 0));
        // the silhouette edge of a finger and the rim of its fingertip dome
        const tip = uu > DOME_FROM ? (uu - DOME_FROM) / (1 - DOME_FROM) : 0;
        put(f, uu, vv, Math.max(Math.abs(vv) ** 3, tip ** 2 * 0.4));
      }
    }
  }
  const pstep = 1 / palmCols;
  for (let r = 0; r < palmRows; r++) {
    const b = (r + 0.5) / palmRows;
    for (let c = 0; c < palmCols; c++) {
      const a = pstep * (c + 0.25 + (r & 1 ? 0.5 : 0));
      // only the little-finger edge of the palm is a silhouette: the thumb side runs into the thumb (which has its own rim),
      // and the wrist and the knuckle line are not edges of the hand at all
      put(PALM, a, b, 1 - (1 - a) / 0.09);
    }
  }
  for (let q = 0; q < QUADS; q++) {
    const rows = rowsOf(config, q);
    const cols = colsOf(config, q);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) put(QUAD0 + q, (r + 0.5) / rows, (c + 0.5) / cols, 0, r, c);
  }
  return { count, part, u, v, rim, rank, phase, row, col, side, config };
}

// ------------------------------------------------------------------------------------------------------------------
// The hand's geometry for one frame (landmarks already in canvas pixels)

export interface HandGeom {
  /** Wrist to middle fingertip, px. */
  len: number;
  /** Per finger: cumulative length at the start of each bone and the total (4 numbers each). */
  cum: Float32Array;
  /** The four curves that bound the palm, as x,y pairs: knuckle row (6 points), thumb side (4), wrist line (3), little side (3),
   *  and for each the share of its length reached at each point (so a dot's `a` / `b` is the same distance along it). */
  top: Float32Array;
  left: Float32Array;
  bottom: Float32Array;
  right: Float32Array;
  topT: Float32Array;
  leftT: Float32Array;
  bottomT: Float32Array;
  rightT: Float32Array;
  /** The thenar, the stub and the four webs, 8 numbers each: the corners (p 0, q 0), (p 1, q 0), (p 0, q 1), (p 1, q 1). */
  quad: Float32Array;
  /** How many dots each row of each patch has now (kept from frame to frame: a row changes its count only for a clear change). */
  rowN: Uint8Array;
  /** Per finger: the sign of v on the side that faces the next finger (towards the little finger) / the previous one; 0 for none. */
  faceNext: Int8Array;
  facePrev: Int8Array;
  /** Per finger: how far along it (u) the side facing a neighbour is still inside the hand (the web), not a silhouette. */
  interior: Float32Array;
}

export const newHandGeom = (): HandGeom => ({
  len: 1,
  cum: new Float32Array(20),
  top: new Float32Array(12),
  left: new Float32Array(8),
  bottom: new Float32Array(6),
  right: new Float32Array(6),
  topT: new Float32Array(6),
  leftT: new Float32Array(4),
  bottomT: new Float32Array(3),
  rightT: new Float32Array(3),
  quad: new Float32Array(QUADS * 8),
  rowN: new Uint8Array(QUADS * MAX_ROWS),
  faceNext: new Int8Array(5),
  facePrev: new Int8Array(5),
  interior: new Float32Array(5),
});

/** The share of a polyline's length reached at each of its n points. */
function curveShares(arr: Float32Array, n: number, out: Float32Array): void {
  let total = 0;
  out[0] = 0;
  for (let k = 1; k < n; k++) {
    total += Math.hypot(arr[2 * k] - arr[2 * k - 2], arr[2 * k + 1] - arr[2 * k - 1]);
    out[k] = total;
  }
  for (let k = 1; k < n; k++) out[k] = total > 1e-9 ? out[k] / total : k / (n - 1);
}

const hbuf = new Float32Array(4);

/** Fill `g` from 21 landmarks (any pixel space). */
export function handGeom(lm: readonly Landmark[], g: HandGeom = newHandGeom()): HandGeom {
  g.len = Math.hypot(lm[12].x - lm[0].x, lm[12].y - lm[0].y) || 1;
  for (let f = 0; f < 5; f++) {
    const ch = FINGER_CHAINS[f];
    let total = 0;
    g.cum[f * 4] = 0;
    for (let k = 0; k < 3; k++) {
      total += Math.hypot(lm[ch[k + 1]].x - lm[ch[k]].x, lm[ch[k + 1]].y - lm[ch[k]].y);
      g.cum[f * 4 + k + 1] = total;
    }
  }
  const buf = hbuf;
  /** Which side (+1 / -1 of v) of finger f, at u, is nearer the point (tx, ty). */
  const sideToward = (f: number, u: number, tx: number, ty: number): number => {
    fingerPoint(lm, g, f, u, 1, buf, 0);
    fingerPoint(lm, g, f, u, -1, buf, 2);
    return Math.hypot(buf[0] - tx, buf[1] - ty) <= Math.hypot(buf[2] - tx, buf[3] - ty) ? 1 : -1;
  };
  /** u of the joint k (0..3) of finger f. */
  const jointU = (f: number, k: number) => g.cum[f * 4 + k] / ((g.cum[f * 4 + 3] || 1) * (1 + FINGER_CAP));
  const uMcp = jointU(0, 1);
  const uThumbWebTop = uMcp + THUMB_WEB * (jointU(0, 2) - uMcp);
  // the side of every finger that faces its neighbours (the thumb's: its inner side; the little finger has none towards the next)
  for (let f = 0; f < 5; f++) {
    g.faceNext[f] = 0;
    g.facePrev[f] = 0;
    g.interior[f] = f === 0 ? uThumbWebTop : WEB_UP;
    const u0 = f === 0 ? uMcp : 0;
    if (f < 4) {
      const t = lm[FINGER_CHAINS[f + 1][0]];
      g.faceNext[f] = sideToward(f, u0, t.x, t.y);
    }
    if (f > 0) {
      const t = lm[f === 1 ? FINGER_CHAINS[0][1] : FINGER_CHAINS[f - 1][0]];
      g.facePrev[f] = sideToward(f, 0, t.x, t.y);
    }
  }

  const set = (arr: Float32Array, k: number, x: number, y: number) => {
    arr[2 * k] = x;
    arr[2 * k + 1] = y;
  };
  const setFinger = (arr: Float32Array, k: number, f: number, u: number, v: number) => {
    fingerPoint(lm, g, f, u, v, buf, 0);
    set(arr, k, buf[0], buf[1]);
  };
  // the wrist is a line across the base of the palm, as wide as about a third of the knuckle line to either side of the wrist point
  const wx = (lm[5].x - lm[17].x) * 0.36;
  const wy = (lm[5].y - lm[17].y) * 0.36;
  const wlx = lm[0].x + wx;
  const wly = lm[0].y + wy;
  const wrx = lm[0].x - wx;
  const wry = lm[0].y - wy;

  // the palm: out to the thumb's inner edge, the knuckle row (from the index finger's outer edge to the little finger's), the
  // little finger's outer edge, and the wrist line
  setFinger(g.top, 0, 1, 0, g.facePrev[1]);
  for (let k = 0; k < 4; k++) set(g.top, k + 1, lm[[5, 9, 13, 17][k]].x, lm[[5, 9, 13, 17][k]].y);
  setFinger(g.top, 5, 4, 0, -g.facePrev[4]);
  set(g.left, 0, wlx, wly);
  setFinger(g.left, 1, 0, 0, g.faceNext[0]);
  setFinger(g.left, 2, 0, uMcp, g.faceNext[0]);
  set(g.left, 3, g.top[0], g.top[1]);
  set(g.bottom, 0, wlx, wly);
  set(g.bottom, 1, lm[0].x, lm[0].y);
  set(g.bottom, 2, wrx, wry);
  // the little-finger edge: from the wrist corner to the little finger's outer edge, bulging out a little (the heel of the hand)
  {
    const mx = (wrx + g.top[10]) / 2;
    const my = (wry + g.top[11]) / 2;
    const ax = g.top[10] - wrx;
    const ay = g.top[11] - wry;
    const al = Math.hypot(ax, ay) || 1;
    let nx = -ay / al;
    let ny = ax / al;
    // away from the middle of the palm
    if (nx * (mx - (lm[0].x + (lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 4) / 2) + ny * (my - (lm[0].y + (lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 4) / 2) < 0) {
      nx = -nx;
      ny = -ny;
    }
    set(g.right, 0, wrx, wry);
    set(g.right, 1, mx + nx * HEEL_BULGE * g.len, my + ny * HEEL_BULGE * g.len);
    set(g.right, 2, g.top[10], g.top[11]);
  }
  curveShares(g.top, 6, g.topT);
  curveShares(g.left, 4, g.leftT);
  curveShares(g.bottom, 3, g.bottomT);
  curveShares(g.right, 3, g.rightT);

  const quad = (q: number, p00x: number, p00y: number, p10x: number, p10y: number, p01x: number, p01y: number, p11x: number, p11y: number) => {
    const o = q * 8;
    g.quad[o] = p00x;
    g.quad[o + 1] = p00y;
    g.quad[o + 2] = p10x;
    g.quad[o + 3] = p10y;
    g.quad[o + 4] = p01x;
    g.quad[o + 5] = p01y;
    g.quad[o + 6] = p11x;
    g.quad[o + 7] = p11y;
  };
  // the thenar: from the wrist line (a little bulging out past its end) to the thumb's base row, between the palm's thumb-side
  // edge and the thumb's outer edge
  const dlx = wlx + (wlx - lm[0].x) * BULGE;
  const dly = wly + (wly - lm[0].y) * BULGE;
  fingerPoint(lm, g, 0, 0, -g.faceNext[0], buf, 0);
  quad(0, wlx, wly, g.left[2], g.left[3], dlx, dly, buf[0], buf[1]);
  // the wrist stub: a little forearm below the wrist line, in the direction away from the knuckles
  const kx = (lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 4;
  const ky = (lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 4;
  const ex = lm[0].x - kx;
  const ey = lm[0].y - ky;
  const el = Math.hypot(ex, ey) || 1;
  const sx = (ex / el) * STUB_LENGTH * g.len;
  const sy = (ey / el) * STUB_LENGTH * g.len;
  quad(1, dlx, dly, dlx + sx, dly + sy, wrx, wry, wrx + sx, wry + sy);
  // the webs: from the base of two neighbouring fingers (their facing edges) up to the crotch of the web
  for (let w = 0; w < 4; w++) {
    const u0 = w === 0 ? uMcp : 0;
    const u1 = g.interior[w];
    fingerPoint(lm, g, w, u0, g.faceNext[w], buf, 0);
    fingerPoint(lm, g, w, u1, g.faceNext[w], buf, 2);
    const a0x = buf[0];
    const a0y = buf[1];
    const a1x = buf[2];
    const a1y = buf[3];
    fingerPoint(lm, g, w + 1, 0, g.facePrev[w + 1], buf, 0);
    fingerPoint(lm, g, w + 1, WEB_UP, g.facePrev[w + 1], buf, 2);
    quad(2 + w, a0x, a0y, a1x, a1y, buf[0], buf[1], buf[2], buf[3]);
  }
  return g;
}

/** A point of a polyline (n points, x,y pairs, `shares` = how far along its length each point is) at t in 0..1. */
function polyAt(arr: Float32Array, shares: Float32Array, n: number, t: number, out: Float32Array, o: number): void {
  const tt = Math.max(0, Math.min(1, t));
  let k = 0;
  while (k < n - 2 && tt > shares[k + 1]) k++;
  const span = shares[k + 1] - shares[k];
  const f = span > 1e-9 ? (tt - shares[k]) / span : 0;
  out[o] = arr[2 * k] + (arr[2 * k + 2] - arr[2 * k]) * f;
  out[o + 1] = arr[2 * k + 1] + (arr[2 * k + 3] - arr[2 * k + 1]) * f;
}

const tmp = new Float32Array(8);
const rowWidths = new Float32Array(MAX_ROWS);

/** The point of finger `f` at (u along, v across) into out[o], out[o+1]; `lm` are the same landmarks `g` was made from. */
export function fingerPoint(lm: readonly Landmark[], g: HandGeom, f: number, u: number, v: number, out: Float32Array, o: number): void {
  const ch = FINGER_CHAINS[f];
  const total = (g.cum[f * 4 + 3] || 1) * (1 + FINGER_CAP);
  const s = Math.max(0, Math.min(1, u)) * total;
  const k = s < g.cum[f * 4 + 1] ? 0 : s < g.cum[f * 4 + 2] ? 1 : 2;
  const a = lm[ch[k]];
  const b = lm[ch[k + 1]];
  const segLen = g.cum[f * 4 + k + 1] - g.cum[f * 4 + k] || 1;
  // past the tip landmark the last bone simply goes on (t > 1): that is the rounded cap of the fingertip
  const t = (s - g.cum[f * 4 + k]) / segLen;
  const dx = (b.x - a.x) / segLen;
  const dy = (b.y - a.y) / segLen;
  const dome = u > DOME_FROM ? Math.sqrt(Math.max(0, 1 - ((u - DOME_FROM) / (1 - DOME_FROM)) ** 2)) : 1;
  const half = FINGER_HALF_WIDTH[f] * g.len * (1 - TAPER * u) * dome;
  out[o] = a.x + (b.x - a.x) * t - dy * v * half;
  out[o + 1] = a.y + (b.y - a.y) * t + dx * v * half;
}

/** The point of the palm at (a from the thumb side, b from the wrist) into out[o], out[o+1] (a Coons patch of g's four curves). */
export function palmPoint(g: HandGeom, a: number, b: number, out: Float32Array, o: number): void {
  polyAt(g.bottom, g.bottomT, 3, a, tmp, 0);
  polyAt(g.top, g.topT, 6, a, tmp, 2);
  polyAt(g.left, g.leftT, 4, b, tmp, 4);
  polyAt(g.right, g.rightT, 3, b, tmp, 6);
  const bx0 = g.bottom[0];
  const by0 = g.bottom[1];
  const bx1 = g.bottom[4];
  const by1 = g.bottom[5];
  const tx0 = g.top[0];
  const ty0 = g.top[1];
  const tx1 = g.top[10];
  const ty1 = g.top[11];
  const ia = 1 - a;
  const ib = 1 - b;
  out[o] = ib * tmp[0] + b * tmp[2] + ia * tmp[4] + a * tmp[6] - (ia * ib * bx0 + a * ib * bx1 + ia * b * tx0 + a * b * tx1);
  out[o + 1] = ib * tmp[1] + b * tmp[3] + ia * tmp[5] + a * tmp[7] - (ia * ib * by0 + a * ib * by1 + ia * b * ty0 + a * b * ty1);
}

/** A point of a quadrilateral patch (0 thenar, 1 stub, 2..5 the webs) at (p along, q across). */
export function quadPoint(g: HandGeom, q: number, p: number, across: number, out: Float32Array, o: number): void {
  const k = q * 8;
  const q0 = g.quad;
  const lx = q0[k] + (q0[k + 2] - q0[k]) * p;
  const ly = q0[k + 1] + (q0[k + 3] - q0[k + 1]) * p;
  const rx = q0[k + 4] + (q0[k + 6] - q0[k + 4]) * p;
  const ry = q0[k + 5] + (q0[k + 7] - q0[k + 5]) * p;
  out[o] = lx + (rx - lx) * across;
  out[o + 1] = ly + (ry - ly) * across;
}

/** How many dots a row of `width` px gets (at most `max`). A row keeps the count it had unless the width moved clearly away
 *  from it, so the dots of a row do not flicker between two counts when the hand is at a borderline size. */
export function rowCount(width: number, len: number, prev: number, max: number, scale = 1): number {
  const ideal = (scale * width) / (SPACING * len);
  const n = prev > 0 && Math.abs(ideal - prev) < 0.8 ? prev : Math.round(ideal);
  return Math.max(0, Math.min(max, n));
}

/** The dots of a patch that are not drawn this frame sit here. */
export const HIDDEN = -1e5;

/** The rim weight of a patch dot at (p along, q across): the thenar's outer edge, the stub's two sides, the crotch of a web. */
function quadRim(q: number, p: number, across: number): number {
  if (q === 0) return across ** 3;
  if (q === 1) return Math.abs(2 * across - 1) ** 3;
  return p ** 4 * 0.55;
}

/** Write the position of every dot (x, y interleaved) for this hand into `out`; with `rimOut` also the rim weight each dot has
 *  now. A patch dot that is not needed on this hand (its row is narrow) gets x = HIDDEN. */
export function latticePoints(lm: readonly Landmark[], g: HandGeom, lat: Lattice, out: Float32Array, rimOut?: Float32Array): void {
  const cfg = lat.config;
  // how many dots each row of each patch has this frame: by the row's width, and (for a patch that has almost folded flat, e.g.
  // a web between fingers held together, or a thenar seen edge-on) never more than its area has room for
  for (let q = 0; q < QUADS; q++) {
    const rows = rowsOf(cfg, q);
    const cols = colsOf(cfg, q);
    const k = q * 8;
    const w = rowWidths;
    let sum = 0;
    for (let r = 0; r < rows; r++) {
      const p = (r + 0.5) / rows;
      const lx = g.quad[k] + (g.quad[k + 2] - g.quad[k]) * p;
      const ly = g.quad[k + 1] + (g.quad[k + 3] - g.quad[k + 1]) * p;
      const rx = g.quad[k + 4] + (g.quad[k + 6] - g.quad[k + 4]) * p;
      const ry = g.quad[k + 5] + (g.quad[k + 7] - g.quad[k + 5]) * p;
      w[r] = Math.hypot(rx - lx, ry - ly);
      sum += w[r] / (SPACING * g.len);
    }
    // the corners in order P00, P10, P11, P01: shoelace area
    const area =
      Math.abs(
        g.quad[k] * g.quad[k + 3] - g.quad[k + 2] * g.quad[k + 1] +
          (g.quad[k + 2] * g.quad[k + 7] - g.quad[k + 6] * g.quad[k + 3]) +
          (g.quad[k + 6] * g.quad[k + 5] - g.quad[k + 4] * g.quad[k + 7]) +
          (g.quad[k + 4] * g.quad[k + 1] - g.quad[k] * g.quad[k + 5]),
      ) / 2;
    const room = (1.3 * area) / (SPACING * g.len) ** 2;
    const scale = sum > room ? room / sum : 1;
    for (let r = 0; r < rows; r++) {
      const o = q * MAX_ROWS + r;
      g.rowN[o] = rowCount(w[r], g.len, g.rowN[o], cols, scale);
    }
  }
  for (let i = 0; i < lat.count; i++) {
    const p = lat.part[i];
    if (p < 5) {
      fingerPoint(lm, g, p, lat.u[i], lat.v[i], out, 2 * i);
      if (rimOut) {
        // the side facing a neighbour is inside the hand at the finger's base (the web fills the gap): no glow there
        let rim = lat.rim[i];
        const s = lat.side[i];
        if (s === g.faceNext[p] || s === g.facePrev[p]) {
          const inside = Math.min(1, lat.u[i] / g.interior[p]);
          rim *= inside * inside * inside;
        }
        rimOut[i] = rim;
      }
    } else if (p === PALM) {
      palmPoint(g, lat.u[i], lat.v[i], out, 2 * i);
      if (rimOut) rimOut[i] = lat.rim[i];
    } else {
      const q = p - QUAD0;
      const r = lat.row[i];
      const n = g.rowN[q * MAX_ROWS + r];
      if (lat.col[i] >= n) {
        out[2 * i] = HIDDEN;
        out[2 * i + 1] = HIDDEN;
        if (rimOut) rimOut[i] = 0;
        continue;
      }
      const pp = (r + 0.5) / rowsOf(cfg, q);
      const across = (lat.col[i] + 0.25 + (r & 1 ? 0.5 : 0)) / n;
      quadPoint(g, q, pp, across, out, 2 * i);
      if (rimOut) rimOut[i] = quadRim(q, pp, across);
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Contour lines (fixed curves in the same coordinates as the dots)

export interface ContourSet {
  /** Arcs across the fingers: [finger, u, v0..v1 samples]. */
  fingerArcs: { finger: number; u: number; vs: number[] }[];
  /** Curves over the palm: each is a list of (a, b) pairs. */
  palm: number[][];
}

/** A short arc across every finger every few millimetres (a ring contour: it bends towards the fingertip), and fine curved
 *  relief lines over the palm. */
export function buildContours(): ContourSet {
  const fingerArcs: ContourSet["fingerArcs"] = [];
  const vs = Array.from({ length: 11 }, (_, k) => -1 + (2 * k) / 10);
  for (let f = 0; f < 5; f++) for (let k = 1; k <= 6; k++) fingerArcs.push({ finger: f, u: 0.06 + k * 0.135, vs });
  const palm: number[][] = [];
  // across the palm, bending like a relief map (a little more in the middle than at the sides)
  for (let k = 1; k <= 8; k++) {
    const b0 = k / 9;
    const line: number[] = [];
    for (let j = 0; j <= 28; j++) {
      const a = j / 28;
      line.push(a, b0 + 0.045 * Math.sin(Math.PI * a) * (1 - b0) - 0.02 * Math.sin(2 * Math.PI * a) * b0);
    }
    palm.push(line);
  }
  // along the palm: three curves that follow the hand's length (the thenar curve is the left-most)
  for (const a0 of [0.2, 0.5, 0.8]) {
    const line: number[] = [];
    for (let j = 0; j <= 20; j++) {
      const b = 0.04 + (0.92 * j) / 20;
      line.push(a0 + 0.06 * Math.sin(Math.PI * b) * (a0 < 0.5 ? -1 : a0 > 0.5 ? 1 : 0), b);
    }
    palm.push(line);
  }
  return { fingerArcs, palm };
}

// ------------------------------------------------------------------------------------------------------------------
// Which dots are shown, and the frame / scan line

/** The share of the lattice that is shown: most of it as soon as the hand is found (so it is clearly visible), the rest as
 *  the real coverage (0..100) of the view grows. */
export function swarmShare(coveragePercent: number): number {
  const c = Math.max(0, Math.min(100, Number.isFinite(coveragePercent) ? coveragePercent : 0));
  return 0.6 + 0.4 * (c / 100);
}

/** How many dots to draw: the full number scaled by the speed guard's share, never fewer than a handful. */
export function particleCount(max: number, pointFraction: number): number {
  return Math.max(24, Math.round(max * Math.max(0, Math.min(1, pointFraction))));
}

/** The dots of `lat` to draw for a share (coverage) and the speed guard's point fraction: those with the lowest rank, so
 *  a smaller number is always a subset of a bigger one (nothing is re-drawn elsewhere when the guard steps down). */
export function visibleLimit(lat: Lattice, share: number, pointFraction: number): number {
  return Math.min(lat.count, particleCount(Math.round(lat.count * Math.max(0, Math.min(1, share))), pointFraction));
}

/** Where the scan line sits between the wrist (0) and the fingertips (1): the real coverage, never a timer. */
export function scanLineFraction(coveragePercent: number): number {
  const c = Math.max(0, Math.min(100, Number.isFinite(coveragePercent) ? coveragePercent : 0));
  return 0.06 + 0.88 * (c / 100);
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The scan frame's target: the hand's bounding box (with the wrist stub and the fingertip caps), grown by a margin (a share
 *  of the hand's length). */
export function frameTarget(lm: readonly Landmark[], margin = 0.09): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const p of lm) add(p.x, p.y);
  const len = Math.hypot(lm[12].x - lm[0].x, lm[12].y - lm[0].y) || 1;
  // the end of the wrist stub, and the rounded end of every fingertip
  const kx = (lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 4;
  const ky = (lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 4;
  const el = Math.hypot(lm[0].x - kx, lm[0].y - ky) || 1;
  add(lm[0].x + ((lm[0].x - kx) / el) * STUB_LENGTH * len, lm[0].y + ((lm[0].y - ky) / el) * STUB_LENGTH * len);
  for (const [prev, tip] of [[3, 4], [7, 8], [11, 12], [15, 16], [19, 20]]) {
    // the strip's cap is about 0.3 of the last bone past the tip landmark
    add(lm[tip].x + (lm[tip].x - lm[prev].x) * 0.3, lm[tip].y + (lm[tip].y - lm[prev].y) * 0.3);
  }
  const m = margin * len;
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
}

/** Keep the frame inside the camera picture (inset from its edge), so it never runs off the card. */
export function clampBox(b: Box, width: number, height: number, inset = 14): Box {
  const x0 = Math.max(inset, Math.min(b.x0, width - inset - 20));
  const y0 = Math.max(inset, Math.min(b.y0, height - inset - 20));
  return { x0, y0, x1: Math.max(x0 + 20, Math.min(b.x1, width - inset)), y1: Math.max(y0 + 20, Math.min(b.y1, height - inset)) };
}

/** Ease `cur` towards `target` (exponential, so a new target never jumps): the scan frame does not jitter with the landmarks. */
export function easeBox(cur: Box, target: Box, dtSeconds: number, rate = 9): Box {
  const k = 1 - Math.exp(-rate * Math.max(0, dtSeconds));
  return { x0: cur.x0 + (target.x0 - cur.x0) * k, y0: cur.y0 + (target.y0 - cur.y0) * k, x1: cur.x1 + (target.x1 - cur.x1) * k, y1: cur.y1 + (target.y1 - cur.y1) * k };
}
