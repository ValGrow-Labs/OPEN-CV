// Test support for the EXPERIMENTAL marker board: render the printed board as a camera would see it, with known truth.
//
// Every pixel is supersampled (stratified, seeded jitter): each sample's ray is inverse-projected through the lens
// model of geometry/camera.ts (radial k1, k2), intersected with the occluders (ellipsoids standing in for a hand, a
// coin as a short cylinder) and with the board plane z = 0, and coloured from the board specification (`boardIsBlack`
// logic, the coin-target outline, paper, table). Then lighting, Gaussian blur, optional motion blur and sensor noise.
// Deterministic for a given seed.
//
// WORLD UNITS. The renderer works in PHYSICAL millimetres. A sheet printed at scale s (1 = "actual size", 0.94 = a
// typical "fit to page") puts board point (x, y) at physical (s x, s y, 0). The pose given to `renderBoardView` maps
// physical millimetres to the camera. Detectors and pose estimators work in BOARD millimetres; the same camera in board
// units is `toBoardUnits(pose, s)` = { R, t / s } (an image cannot tell the two apart; only the coin can).
//
// This is a renderer of an IDEAL scene: a flat matte sheet, Lambertian skin blobs, a cylinder coin. It has no glare,
// no paper curl, no rolling shutter, no JPEG, no real lens. Results on its images are SIMULATED and say nothing about
// real phones or real prints.

import type { CameraPose, Intrinsics, Pt, Pt3 } from "../common";
import { cameraCenter, lookAt, project } from "../geometry/camera";
import { seededRandom, transpose, type V3 } from "../geometry/linalg";
import { gaussianBlurPlane, type RgbaImage } from "./image";
import { BOARD, markerCorners, onCoinOutline, type BoardLayout } from "./spec";

export type Rgb = readonly [number, number, number];

/** An ellipsoid in physical millimetres, its axes along world x, y, z after a rotation `yawDeg` about z. */
export interface Ellipsoid {
  center: Pt3;
  radii: Pt3;
  yawDeg?: number;
  color?: Rgb;
}

/** A coin lying on the board: a cylinder standing on z = 0. */
export interface CoinRender {
  /** Where it lies, BOARD millimetres (default: the printed coin target's centre). */
  center?: { x: number; y: number };
  /** Physical diameter and thickness, mm. */
  diameterMm: number;
  thicknessMm: number;
  face?: Rgb;
  wall?: Rgb;
  /** A soft contact shadow on the paper, this wide (mm) outside the coin, darkening by up to `shadowStrength` (0 to 1). */
  shadowMm?: number;
  shadowStrength?: number;
}

export interface RenderOptions {
  layout?: BoardLayout;
  /** Physical millimetres per board millimetre (1 = printed at 100 %). */
  printScale?: number;
  /** Samples per pixel side (default 3, i.e. 9 samples per pixel). */
  supersample?: number;
  paper?: Rgb;
  ink?: Rgb;
  outline?: Rgb;
  table?: Rgb;
  /** Seen above the horizon (no plane hit). */
  background?: Rgb;
  /** Multiplicative light: level * (1 + gradientX (2u/W - 1) + gradientY (2v/H - 1)) * (1 - vignette r^2), r = 1 at a corner. */
  light?: { level?: number; gradientX?: number; gradientY?: number; vignette?: number };
  blurSigmaPx?: number;
  motionBlur?: { lengthPx: number; angleDeg: number };
  /** Gaussian sensor noise, grey levels per channel. */
  noiseSigma?: number;
  occluders?: readonly Ellipsoid[];
  coin?: CoinRender;
  /** Research only: draw a RING of this diameter (board mm) at the coin target instead of the layout's placement
   *  ticks (0 = no coin marks at all). Default: the layout's ticks, as printed. */
  coinOutlineDiameterMm?: number;
  seed?: number;
}

/** The camera in board millimetres, given the camera in physical millimetres and the print scale. */
export function toBoardUnits(pose: CameraPose, printScale = 1): CameraPose {
  return { R: [...pose.R], t: [pose.t[0] / printScale, pose.t[1] / printScale, pose.t[2] / printScale] };
}

/** A camera on a sphere around `target` (physical mm): elevation above the board plane, azimuth measured in the board
 *  plane from +x toward +y (0 = camera on the right, fingertip side; 90 = top edge; 180 = left, open edge; 270 =
 *  bottom edge), looking at the target with a level horizon (landscape phone). */
export function orbitPose(target: Pt3, distanceMm: number, elevationDeg: number, azimuthDeg: number): CameraPose {
  const e = (elevationDeg * Math.PI) / 180;
  const a = (azimuthDeg * Math.PI) / 180;
  const eye: V3 = [
    target.x + distanceMm * Math.cos(e) * Math.cos(a),
    target.y + distanceMm * Math.cos(e) * Math.sin(a),
    target.z + distanceMm * Math.sin(e),
  ];
  const up: V3 = elevationDeg > 89.9 ? [-Math.cos(a), -Math.sin(a), 0] : [0, 0, 1];
  return lookAt(eye, [target.x, target.y, target.z], up);
}

/** A crude hand resting palm-down on the board (physical mm, print scale 1): forearm entering at the open left edge,
 *  palm, four fingers toward +x and a thumb. Only an occluder for marker-visibility tests, not a hand model. */
export function handOccluders(dx = 0, dy = 0): Ellipsoid[] {
  const skin: Rgb = [196, 146, 118];
  const e = (x: number, y: number, z: number, rx: number, ry: number, rz: number, yawDeg = 0): Ellipsoid => ({
    center: { x: x + dx, y: y + dy, z },
    radii: { x: rx, y: ry, z: rz },
    yawDeg,
    color: skin,
  });
  return [
    e(15, 105, 18, 55, 30, 18), // forearm and wrist
    e(95, 105, 15, 45, 42, 15), // palm
    e(165, 131, 9, 32, 8.5, 9, 6), // index
    e(172, 112, 9, 37, 8.5, 9, 1), // middle
    e(167, 94, 9, 34, 8.5, 9, -4), // ring
    e(152, 78, 8, 27, 7.5, 8, -10), // little
    e(110, 150, 10, 30, 10, 10, 40), // thumb
  ];
}

/** The board's printed marker corners projected into the image (TL, TR, BR, BL), or null for a corner behind the camera.
 *  `pose` is in BOARD millimetres (use toBoardUnits for a physical pose). */
export function projectedMarkerCorners(K: Intrinsics, boardPose: CameraPose, layout: BoardLayout = BOARD): Map<number, (Pt | null)[]> {
  const out = new Map<number, (Pt | null)[]>();
  for (const m of layout.markers) out.set(m.id, markerCorners(m, layout.markerMm).map((c) => project(K, boardPose, c)));
  return out;
}

// ------------------------------------------------------------------------------------------------ fast board lookup

const PAPER_ID = 0;
const INK_ID = 1;
const OUTLINE_ID = 2;

/** A fast exact lookup of the printed board's colour (0 paper, 1 ink, 2 coin outline) at a board point; -1 off the sheet. */
export function makeBoardSampler(layout: BoardLayout = BOARD, outlineDiameterMm?: number): (x: number, y: number) => number {
  const B = 10; // bucket size, mm
  const nx = Math.ceil(layout.paper.widthMm / B) + 1;
  const ny = Math.ceil(layout.paper.heightMm / B) + 1;
  const buckets: number[][] = Array.from({ length: nx * ny }, () => []);
  layout.markers.forEach((m, i) => {
    for (let bx = Math.floor(m.x / B); bx <= Math.floor((m.x + layout.markerMm) / B); bx++)
      for (let by = Math.floor(m.y / B); by <= Math.floor((m.y + layout.markerMm) / B); by++)
        if (bx >= 0 && by >= 0 && bx < nx && by < ny) buckets[by * nx + bx].push(i);
  });
  const S = layout.markerMm;
  const n = layout.cellsPerSide;
  const nb = layout.bitsPerSide;
  const cell = S / n;
  const { center } = layout.coinTarget;
  const ring = outlineDiameterMm !== undefined;
  const rOut = (outlineDiameterMm ?? 0) / 2;
  return (x: number, y: number) => {
    if (x < 0 || y < 0 || x > layout.paper.widthMm || y > layout.paper.heightMm) return -1;
    const list = buckets[Math.floor(y / B) * nx + Math.floor(x / B)];
    for (let k = 0; k < list.length; k++) {
      const m = layout.markers[list[k]];
      const u = x - m.x;
      const v = m.y + S - y;
      if (u < 0 || v < 0 || u >= S || v >= S) continue;
      const c = Math.floor(u / cell);
      const r = Math.floor(v / cell);
      if (r === 0 || c === 0 || r === n - 1 || c === n - 1) return INK_ID;
      const i = (r - 1) * nb + (c - 1);
      return ((m.code >> (nb * nb - 1 - i)) & 1) === 1 ? PAPER_ID : INK_ID;
    }
    if (!ring) return onCoinOutline(x, y, layout) ? OUTLINE_ID : PAPER_ID;
    const dr = Math.sqrt((x - center.x) * (x - center.x) + (y - center.y) * (y - center.y)) - rOut;
    return rOut > 0 && dr >= -0.2 && dr <= 0.2 ? OUTLINE_ID : PAPER_ID;
  };
}

// ------------------------------------------------------------------------------------------------ renderer

function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

interface PreparedEllipsoid {
  c: V3;
  inv: V3;
  cos: number;
  sin: number;
  color: Rgb;
  bbox: [number, number, number, number];
}

function imageBox(K: Intrinsics, pose: CameraPose, lo: V3, hi: V3): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = project(K, pose, [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
    if (!p) return [-Infinity, -Infinity, Infinity, Infinity];
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const m = 0.15 * Math.max(x1 - x0, y1 - y0) + 3; // margin for distortion between the box corners
  return [x0 - m, y0 - m, x1 + m, y1 + m];
}

/**
 * Render the board as seen by a camera with intrinsics `K` (lens distortion included) at `pose` (PHYSICAL mm to
 * camera). Returns an RGBA image of K.width x K.height.
 */
export function renderBoardView(K: Intrinsics, pose: CameraPose, opts: RenderOptions = {}): RgbaImage {
  const W = K.width;
  const H = K.height;
  const layout = opts.layout ?? BOARD;
  const s = opts.printScale ?? 1;
  const ss = Math.max(1, Math.round(opts.supersample ?? 3));
  const paper = opts.paper ?? [226, 224, 218];
  const ink = opts.ink ?? [28, 28, 32];
  const outline = opts.outline ?? [182, 182, 182];
  const table = opts.table ?? [118, 96, 78];
  const background = opts.background ?? [150, 154, 160];
  const seed = opts.seed ?? 1;
  const rnd = seededRandom(seed);
  const sampler = makeBoardSampler(layout, opts.coinOutlineDiameterMm);
  const C = cameraCenter(pose);
  const Rt = transpose(pose.R);

  const distorted = !!(K.k1 || K.k2);
  const k1 = K.k1 ?? 0;
  const k2 = K.k2 ?? 0;

  const ells: PreparedEllipsoid[] = (opts.occluders ?? []).map((e) => {
    const yaw = ((e.yawDeg ?? 0) * Math.PI) / 180;
    const rxy = Math.max(e.radii.x, e.radii.y);
    return {
      c: [e.center.x, e.center.y, e.center.z],
      inv: [1 / e.radii.x, 1 / e.radii.y, 1 / e.radii.z],
      cos: Math.cos(yaw),
      sin: Math.sin(yaw),
      color: e.color ?? [196, 146, 118],
      bbox: imageBox(K, pose, [e.center.x - rxy, e.center.y - rxy, e.center.z - e.radii.z], [e.center.x + rxy, e.center.y + rxy, e.center.z + e.radii.z]),
    };
  });

  const coin = opts.coin;
  const coinC = coin ? { x: s * (coin.center ?? layout.coinTarget.center).x, y: s * (coin.center ?? layout.coinTarget.center).y } : null;
  const coinR = coin ? coin.diameterMm / 2 : 0;
  const coinH = coin ? coin.thicknessMm : 0;
  const face = coin?.face ?? [176, 176, 181];
  const wall = coin?.wall ?? [122, 122, 128];
  const shadowMm = coin?.shadowMm ?? 0;
  const shadowStrength = coin?.shadowStrength ?? 0.25;
  const Lx = 0.3 / 1.068, Ly = 0.2 / 1.068, Lz = 1 / 1.068; // light direction (unit)

  const acc = new Float32Array(W * H * 3);
  const inv = 1 / (ss * ss);
  const cand = new Int32Array(ells.length + 1);
  let candN = 0;
  const col = new Float64Array(3);
  // Material of the last shaded ray (0 background, 1 table, 2 paper, 3 ink, 4 outline, 5 coin face, 6 coin wall,
  // 10 + i ellipsoid i) and its board-plane point (board mm; NaN when the plane was not the visible surface).
  let key = 0;
  let planeX = NaN;
  let planeY = NaN;

  // Colour of one ray (direction D in world); writes col.
  const shade = (dx: number, dy: number, dz: number) => {
    let best = Infinity;
    let kind = 0; // 0 plane / background, 1 ellipsoid, 2 coin face, 3 coin wall
    let hitE = -1;
    let hx = 0, hy = 0, hz = 0;
    for (let q = 0; q < candN; q++) {
      const e = ells[cand[q]];
      // local coordinates: rotate by -yaw, scale by 1/radii
      const ox = C[0] - e.c[0], oy = C[1] - e.c[1], oz = C[2] - e.c[2];
      const lox = (e.cos * ox + e.sin * oy) * e.inv[0];
      const loy = (-e.sin * ox + e.cos * oy) * e.inv[1];
      const loz = oz * e.inv[2];
      const ldx = (e.cos * dx + e.sin * dy) * e.inv[0];
      const ldy = (-e.sin * dx + e.cos * dy) * e.inv[1];
      const ldz = dz * e.inv[2];
      const a = ldx * ldx + ldy * ldy + ldz * ldz;
      const b = lox * ldx + loy * ldy + loz * ldz;
      const c = lox * lox + loy * loy + loz * loz - 1;
      const disc = b * b - a * c;
      if (disc < 0) continue;
      const lam = (-b - Math.sqrt(disc)) / a;
      if (lam > 0 && lam < best) {
        best = lam;
        kind = 1;
        hitE = cand[q];
        hx = lox + lam * ldx;
        hy = loy + lam * ldy;
        hz = loz + lam * ldz;
      }
    }
    if (coinC) {
      if (dz < 0) {
        const lt = (coinH - C[2]) / dz;
        const px = C[0] + lt * dx - coinC.x, py = C[1] + lt * dy - coinC.y;
        if (lt > 0 && lt < best && px * px + py * py <= coinR * coinR) {
          best = lt;
          kind = 2;
          hx = px;
          hy = py;
        }
      }
      const ox = C[0] - coinC.x, oy = C[1] - coinC.y;
      const a = dx * dx + dy * dy;
      const b = ox * dx + oy * dy;
      const c = ox * ox + oy * oy - coinR * coinR;
      const disc = b * b - a * c;
      if (a > 0 && disc >= 0) {
        const lw = (-b - Math.sqrt(disc)) / a;
        const z = C[2] + lw * dz;
        if (lw > 0 && lw < best && z >= 0 && z <= coinH) {
          best = lw;
          kind = 3;
          hx = ox + lw * dx;
          hy = oy + lw * dy;
        }
      }
    }
    const lp = dz < -1e-12 ? -C[2] / dz : Infinity;
    planeX = NaN;
    planeY = NaN;
    if (kind === 1 && best < lp) {
      key = 10 + hitE;
      const e = ells[hitE];
      // normal in local scaled space -> world (inverse-transpose of the scaling, then rotate by +yaw)
      const nlx = hx * e.inv[0], nly = hy * e.inv[1], nlz = hz * e.inv[2];
      const nx = e.cos * nlx - e.sin * nly, ny = e.sin * nlx + e.cos * nly;
      const nn = Math.sqrt(nx * nx + ny * ny + nlz * nlz) || 1;
      const lam = Math.max(0, (nx * Lx + ny * Ly + nlz * Lz) / nn);
      const f = 0.42 + 0.58 * lam;
      col[0] = e.color[0] * f;
      col[1] = e.color[1] * f;
      col[2] = e.color[2] * f;
      return;
    }
    if (kind === 2 && best < lp) {
      key = 5;
      const r = Math.sqrt(hx * hx + hy * hy) / coinR;
      const th = Math.atan2(hy, hx);
      let f = 1 + 0.05 * (hx / coinR) + 0.035 * Math.sin(7 * th) * Math.cos(9 * r);
      if (r > 0.88) f *= 1.07;
      col[0] = face[0] * f;
      col[1] = face[1] * f;
      col[2] = face[2] * f;
      return;
    }
    if (kind === 3 && best < lp) {
      key = 6;
      const f = 0.85 + 0.15 * Math.max(0, (hx * Lx + hy * Ly) / coinR / 0.36);
      col[0] = wall[0] * f;
      col[1] = wall[1] * f;
      col[2] = wall[2] * f;
      return;
    }
    if (!Number.isFinite(lp)) {
      key = 0;
      col[0] = background[0];
      col[1] = background[1];
      col[2] = background[2];
      return;
    }
    const X = C[0] + lp * dx;
    const Y = C[1] + lp * dy;
    planeX = X / s;
    planeY = Y / s;
    const id = sampler(planeX, planeY);
    key = id < 0 ? 1 : id === INK_ID ? 3 : id === OUTLINE_ID ? 4 : 2;
    if (id < 0) {
      const f = 0.85 + 0.3 * valueNoise(X / 35, Y / 9, seed + 7);
      col[0] = table[0] * f;
      col[1] = table[1] * f;
      col[2] = table[2] * f;
      return;
    }
    const base = id === INK_ID ? ink : id === OUTLINE_ID ? outline : paper;
    let f = 1;
    if (coinC && shadowMm > 0) {
      const d = Math.sqrt((X - coinC.x) * (X - coinC.x) + (Y - coinC.y) * (Y - coinC.y)) - coinR;
      if (d >= 0 && d < shadowMm) f = 1 - shadowStrength * (1 - d / shadowMm) ** 2;
    }
    col[0] = base[0] * f;
    col[1] = base[1] * f;
    col[2] = base[2] * f;
  };

  // Adaptive supersampling. The pixel-corner grid is shaded once; a pixel whose four corners show the same material
  // and that is not near a thin feature (the coin outline; marker cells when a pixel spans more than 1 mm of board)
  // takes the mean of its corners (every material's shading is smooth); every other pixel gets ss x ss stratified,
  // jittered samples.
  const rayAt = (u: number, v: number) => {
    let x: number, y: number;
    if (distorted) {
      // fixed-point inversion of the radial model (as geometry/camera.ts undistortNormalized, without allocation)
      const xd = (u - K.cx) / K.fx, yd = (v - K.cy) / K.fy;
      x = xd;
      y = yd;
      for (let it = 0; it < 30; it++) {
        const r2 = x * x + y * y;
        const d = 1 + k1 * r2 + k2 * r2 * r2;
        const nx = xd / d, ny = yd / d;
        const done = Math.abs(nx - x) + Math.abs(ny - y) < 1e-13;
        x = nx;
        y = ny;
        if (done) break;
      }
    } else {
      x = (u - K.cx) / K.fx;
      y = (v - K.cy) / K.fy;
    }
    shade(Rt[0] * x + Rt[1] * y + Rt[2], Rt[3] * x + Rt[4] * y + Rt[5], Rt[6] * x + Rt[7] * y + Rt[8]);
  };
  const setCand = (u: number, v: number) => {
    candN = 0;
    for (let q = 0; q < ells.length; q++) {
      const b = ells[q].bbox;
      if (u >= b[0] && u <= b[2] && v >= b[1] && v <= b[3]) cand[candN++] = q;
    }
  };
  const rowLen = W + 1;
  let rowA = { key: new Int32Array(rowLen), col: new Float32Array(rowLen * 3), X: new Float64Array(rowLen), Y: new Float64Array(rowLen) };
  let rowB = { key: new Int32Array(rowLen), col: new Float32Array(rowLen * 3), X: new Float64Array(rowLen), Y: new Float64Array(rowLen) };
  const shadeRow = (row: typeof rowA, j: number) => {
    for (let i = 0; i <= W; i++) {
      setCand(i - 0.5, j - 0.5);
      rayAt(i - 0.5, j - 0.5);
      row.key[i] = key;
      row.col[i * 3] = col[0];
      row.col[i * 3 + 1] = col[1];
      row.col[i * 3 + 2] = col[2];
      row.X[i] = planeX;
      row.Y[i] = planeY;
    }
  };
  const oc = layout.coinTarget.center;
  const od = opts.coinOutlineDiameterMm; // research ring; undefined = the layout's ticks
  const tk = layout.coinTarget.ticks;
  const markerNear = makeMarkerProximity(layout);
  shadeRow(rowA, 0);
  for (let py = 0; py < H; py++) {
    shadeRow(rowB, py + 1);
    for (let px = 0; px < W; px++) {
      const k0 = rowA.key[px];
      let uniform = k0 === rowA.key[px + 1] && k0 === rowB.key[px] && k0 === rowB.key[px + 1];
      if (uniform && k0 >= 1 && k0 <= 4) {
        const x0 = rowA.X[px], y0 = rowA.Y[px], x1 = rowA.X[px + 1], y1 = rowA.Y[px + 1];
        const x2 = rowB.X[px], y2 = rowB.Y[px], x3 = rowB.X[px + 1], y3 = rowB.Y[px + 1];
        const d03 = (x0 - x3) * (x0 - x3) + (y0 - y3) * (y0 - y3);
        const d12 = (x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2);
        const foot = Math.sqrt(d03 > d12 ? d03 : d12);
        if (!(foot < 1e6)) uniform = false;
        else {
          const rr = Math.sqrt((x0 - oc.x) * (x0 - oc.x) + (y0 - oc.y) * (y0 - oc.y));
          const nearMark = od !== undefined ? Math.abs(rr - od / 2) < foot + 0.5 : rr > tk.innerMm - foot - 0.5 && rr < tk.innerMm + tk.lengthMm + foot + 0.5;
          if (nearMark) uniform = false;
          else if (foot > 1 && markerNear(x0, y0, foot + 1)) uniform = false;
        }
      }
      const k = (py * W + px) * 3;
      if (uniform) {
        for (let c = 0; c < 3; c++) acc[k + c] = 0.25 * (rowA.col[px * 3 + c] + rowA.col[px * 3 + 3 + c] + rowB.col[px * 3 + c] + rowB.col[px * 3 + 3 + c]);
        continue;
      }
      setCand(px, py);
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          rayAt(px - 0.5 + (sx + rnd.uniform()) / ss, py - 0.5 + (sy + rnd.uniform()) / ss);
          r += col[0];
          g += col[1];
          b += col[2];
        }
      acc[k] = r * inv;
      acc[k + 1] = g * inv;
      acc[k + 2] = b * inv;
    }
    const t = rowA;
    rowA = rowB;
    rowB = t;
  }

  // Lighting (multiplicative, image space).
  const L = opts.light ?? {};
  const level = L.level ?? 1;
  const gx = L.gradientX ?? 0, gy = L.gradientY ?? 0, vig = L.vignette ?? 0;
  if (level !== 1 || gx || gy || vig) {
    const halfDiag2 = (W / 2) ** 2 + (H / 2) ** 2;
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        const r2 = ((px - W / 2) ** 2 + (py - H / 2) ** 2) / halfDiag2;
        const f = level * (1 + gx * ((2 * px) / W - 1) + gy * ((2 * py) / H - 1)) * (1 - vig * r2);
        const k = (py * W + px) * 3;
        acc[k] *= f;
        acc[k + 1] *= f;
        acc[k + 2] *= f;
      }
  }

  // Blur per channel.
  const planes = [0, 1, 2].map((c) => {
    const p = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) p[i] = acc[i * 3 + c];
    return p;
  });
  for (const p of planes) {
    if (opts.motionBlur && opts.motionBlur.lengthPx > 0) motionBlurPlane(p, W, H, opts.motionBlur.lengthPx, opts.motionBlur.angleDeg);
    if (opts.blurSigmaPx) gaussianBlurPlane(p, W, H, opts.blurSigmaPx);
  }

  const noise = opts.noiseSigma ?? 0;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = planes[0][i] + (noise ? noise * rnd.gaussian() : 0);
    out[i * 4 + 1] = planes[1][i] + (noise ? noise * rnd.gaussian() : 0);
    out[i * 4 + 2] = planes[2][i] + (noise ? noise * rnd.gaussian() : 0);
    out[i * 4 + 3] = 255;
  }
  return { width: W, height: H, data: out };
}

/** Linear motion blur: the mean along a segment of `lengthPx` through each pixel (bilinear taps every half pixel). */
function motionBlurPlane(data: Float32Array, W: number, H: number, lengthPx: number, angleDeg: number): void {
  const n = Math.max(2, Math.ceil(lengthPx * 2) + 1);
  const ca = Math.cos((angleDeg * Math.PI) / 180);
  const sa = Math.sin((angleDeg * Math.PI) / 180);
  const src = Float32Array.from(data);
  const at = (x: number, y: number) => {
    const xc = Math.min(W - 1, Math.max(0, x));
    const yc = Math.min(H - 1, Math.max(0, y));
    const x0 = Math.min(W - 2, Math.floor(xc));
    const y0 = Math.min(H - 2, Math.floor(yc));
    const fx = xc - x0, fy = yc - y0;
    const i = y0 * W + x0;
    return (src[i] * (1 - fx) + src[i + 1] * fx) * (1 - fy) + (src[i + W] * (1 - fx) + src[i + W + 1] * fx) * fy;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let k = 0; k < n; k++) {
        const t = (k / (n - 1) - 0.5) * lengthPx;
        acc += at(x + t * ca, y + t * sa);
      }
      data[y * W + x] = acc / n;
    }
}

/** Is the board point (x, y) within `margin` mm of a marker's printed square? */
function makeMarkerProximity(layout: BoardLayout): (x: number, y: number, margin: number) => boolean {
  const S = layout.markerMm;
  return (x, y, margin) => {
    for (const m of layout.markers) if (x > m.x - margin && x < m.x + S + margin && y > m.y - margin && y < m.y + S + margin) return true;
    return false;
  };
}

/** Is a board point (BOARD mm, on z = 0) hidden from the camera by one of the occluders (physical mm)? For truth
 *  visibility in tests. */
export function occludedFromCamera(pose: CameraPose, boardPt: Pt, occluders: readonly Ellipsoid[], printScale = 1): boolean {
  const C = cameraCenter(pose);
  const P: V3 = [boardPt.x * printScale, boardPt.y * printScale, 0];
  const d: V3 = [P[0] - C[0], P[1] - C[1], P[2] - C[2]]; // lambda in (0, 1) reaches the point
  for (const e of occluders) {
    const yaw = ((e.yawDeg ?? 0) * Math.PI) / 180;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const ox = C[0] - e.center.x, oy = C[1] - e.center.y, oz = C[2] - e.center.z;
    const lo: V3 = [(cs * ox + sn * oy) / e.radii.x, (-sn * ox + cs * oy) / e.radii.y, oz / e.radii.z];
    const ld: V3 = [(cs * d[0] + sn * d[1]) / e.radii.x, (-sn * d[0] + cs * d[1]) / e.radii.y, d[2] / e.radii.z];
    const a = ld[0] ** 2 + ld[1] ** 2 + ld[2] ** 2;
    const b = lo[0] * ld[0] + lo[1] * ld[1] + lo[2] * ld[2];
    const c = lo[0] ** 2 + lo[1] ** 2 + lo[2] ** 2 - 1;
    const disc = b * b - a * c;
    if (disc < 0) continue;
    const l1 = (-b - Math.sqrt(disc)) / a;
    const l2 = (-b + Math.sqrt(disc)) / a;
    if ((l1 > 0 && l1 < 1) || (l2 > 0 && l2 < 1)) return true;
  }
  return false;
}
