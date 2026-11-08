// SIMULATED photos of a hand resting palm-down on the printed board, for end-to-end tests of the EXPERIMENTAL
// multi-view reconstruction. Deterministic (seeded), ray-marched, plain TypeScript.
//
// What is in a picture: the synthetic capsule hand of reconstruction/synthetic.ts (an SDF with exact dimensions) placed
// palm-down on the board, a coin lying on the printed coin target, the printed board itself (markers and the coin
// outline from board/spec.ts), a table outside the paper and a "room" beyond it, Lambertian shading with an ambient term
// and a configurable skin colour, a soft cast shadow of the hand from a directional light, a smooth illumination
// variation and vignetting, radial distortion, Gaussian blur and sensor noise.
//
// It is a TEST RENDERER. Real skin has sub-surface scattering, specular highlights, texture, hair, nails and veins; real
// paper has gloss and curl; real phones apply tone curves, sharpening and video compression. None of that is modelled.
// The capsule hand is not a real hand. Every number obtained with these pictures is SIMULATED.
//
// Frames: the board frame of board/spec.ts (mm; origin bottom-left of the upright page, +x right, +y up the page, +z
// out of the paper). The hand frame of synthetic.ts (origin at the wrist-plane centre, +y toward the fingers, +z out
// of the palm, +x toward the little finger). The hand-to-board transform maps the palm plane z = palmThickness / 2 onto
// the board plane z = 0 (palm down: hand +z is board -z), the fingers toward board +x and hand +x (little finger) to
// board +y. Parts of the capsule hand that would lie below the paper (the thick wrist stub, the lifted thumb tip) are
// simply hidden by the paper: the visible solid is the hand intersected with z >= 0.
import type { CameraPose, Intrinsics, Pt, Pt3 } from "../common";
import { BOARD, boardIsBlack, onCoinOutline, type BoardLayout } from "../board/spec";
import { lookAtPose, normalize, projectPoint, type Vec3 } from "../reconstruction/linalg";
import { extractMesh, meshArea, sdfToField } from "../reconstruction/meshing";
import { gaussian, makeRng } from "../reconstruction/rng";
import { DEFAULT_HAND_PARAMS, makeCapsuleHand, type CapsuleHand, type CapsuleHandParams } from "../reconstruction/synthetic";
import type { FingerName } from "../reconstruction/measure";
import { gaussianBlurPlane, linearToSrgb255, rayBox, rayGrid, SRGB_TO_LINEAR, type RGBAImage } from "./image";

export type RGB = readonly [number, number, number];

/** Skin colours (sRGB, 0..1) used by the SIMULATED tests: light to very dark. Illustrative values, not measured. */
export const SKIN_TONES: Record<"light" | "medium" | "tan" | "dark" | "veryDark", RGB> = {
  light: [0.86, 0.68, 0.58],
  medium: [0.76, 0.56, 0.43],
  tan: [0.6, 0.42, 0.3],
  dark: [0.4, 0.26, 0.19],
  veryDark: [0.25, 0.16, 0.12],
};

/** The capsule hand used on the board: the default proportions with a longer wrist stub, so the forearm runs off the
 *  open left edge of the paper as a real one would (the stub does not change any measured dimension). */
export const BOARD_HAND_PARAMS: CapsuleHandParams = { ...DEFAULT_HAND_PARAMS, wristLength: 100 };

export interface HandPlacement {
  /** Board position of the hand-frame origin (the wrist-plane centre), mm. */
  wristX: number;
  wristY: number;
  /** Rotation about the board normal (degrees, counter-clockwise seen from above); 0 = fingers toward +x. */
  yawDeg?: number;
  /** Extra translation (mm, board frame): use it to simulate a hand that moved between views. */
  offset?: Vec3;
}

export const DEFAULT_PLACEMENT: HandPlacement = { wristX: 25, wristY: 122, yawDeg: 0 };

export interface CoinSpec {
  /** Diameter and thickness (mm). Default a 23.25 x 2.33 mm coin on BOARD.coinTarget. */
  diameterMm: number;
  thicknessMm: number;
  color: RGB;
}

/** A rigid transform board = R * hand + t (R row-major). */
export interface RigidTransform {
  R: number[];
  t: Vec3;
}

export interface BoardScene {
  hand: CapsuleHand;
  placement: HandPlacement;
  handToBoard: RigidTransform;
  layout: BoardLayout;
  coin: CoinSpec | null;
  /** Signed distance (mm) of the hand in BOARD coordinates (negative inside); the paper is not part of it. */
  sdfBoard: (x: number, y: number, z: number) => number;
  /** Axis-aligned bounds of the hand in board coordinates (from the hand's own bounds; z clipped at 0). */
  handBoundsBoard: { min: Vec3; max: Vec3 };
  /** The 21 synthetic landmarks in board millimetres (MediaPipe order: wrist, thumb 1-4, index 5-8, middle 9-12, ring
   *  13-16, little 17-20). Derived from the capsule parameters; see `capsuleLandmarksHandFrame`. */
  landmarks: Pt3[];
  /** Exact dimensions (mm), identical in any rigid placement. */
  truth: SceneTruth;
}

export interface SceneTruth {
  handLength: number;
  palmBreadth: number;
  palmThickness: number;
  circumference: number;
  fingerLengths: Record<FingerName, number>;
  knuckleY: number;
}

const mulRV = (R: readonly number[], v: ArrayLike<number>): Vec3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const mulRtV = (R: readonly number[], v: ArrayLike<number>): Vec3 => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];

/** The 21 landmarks of a capsule hand in its own frame. The capsule hand has no joints, so these are DEFINED on it:
 *  MCP = finger capsule base (on the knuckle plane), PIP and DIP at 45 % and 75 % of the capsule axis, TIP = the end
 *  of the capsule axis (the centre of the tip sphere, so MCP->TIP is exactly the finger axis); thumb MCP = thumb capsule
 *  base, IP at 55 %, TIP at the end, CMC half-way between the wrist and the thumb base. The WRIST landmark is placed on
 *  the hand axis through the middle MCP (x = middle finger base x) so the landmark hand frame (wrist -> middle MCP, as
 *  frameFromLandmarks builds it) equals the exact hand frame of the capsule hand. */
export function capsuleLandmarksHandFrame(p: CapsuleHandParams = BOARD_HAND_PARAMS): Vec3[] {
  const out: Vec3[] = new Array(21);
  const wrist: Vec3 = [p.fingers.middle.baseX, 0, 0];
  out[0] = wrist;
  const t = p.thumb;
  const ang = (t.angleDeg * Math.PI) / 180, lift = (t.liftDeg * Math.PI) / 180;
  const td = normalize([-Math.sin(ang) * Math.cos(lift), Math.cos(ang) * Math.cos(lift), Math.sin(lift)]);
  const ta: Vec3 = [t.baseX, t.baseY, 0];
  const at = (a: Vec3, d: Vec3, s: number): Vec3 => [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s];
  out[1] = [(wrist[0] + ta[0]) / 2, (wrist[1] + ta[1]) / 2, 0];
  out[2] = ta;
  out[3] = at(ta, td, 0.55 * t.length);
  out[4] = at(ta, td, t.length);
  const names = ["index", "middle", "ring", "little"] as const;
  names.forEach((name, k) => {
    const f = p.fingers[name];
    const s = (f.splayDeg * Math.PI) / 180;
    const d: Vec3 = [Math.sin(s), Math.cos(s), 0];
    const a: Vec3 = [f.baseX, p.palmLength, 0];
    out[5 + 4 * k] = a;
    out[6 + 4 * k] = at(a, d, 0.45 * f.length);
    out[7 + 4 * k] = at(a, d, 0.75 * f.length);
    out[8 + 4 * k] = at(a, d, f.length);
  });
  return out;
}

export function makeBoardScene(opts: { params?: CapsuleHandParams; placement?: HandPlacement; layout?: BoardLayout; coin?: Partial<CoinSpec> | null } = {}): BoardScene {
  const params = opts.params ?? BOARD_HAND_PARAMS;
  const hand = makeCapsuleHand(params);
  const placement = { ...DEFAULT_PLACEMENT, ...(opts.placement ?? {}) };
  const layout = opts.layout ?? BOARD;
  const yaw = ((placement.yawDeg ?? 0) * Math.PI) / 180;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // base map: board x = hand y, board y = hand x, board z = -hand z; then the yaw about board z.
  const B = [0, 1, 0, 1, 0, 0, 0, 0, -1];
  const Z = [c, -s, 0, s, c, 0, 0, 0, 1];
  const R = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i * 3 + j] += Z[i * 3 + k] * B[k * 3 + j];
  const off = placement.offset ?? [0, 0, 0];
  const t: Vec3 = [placement.wristX + off[0], placement.wristY + off[1], params.palmThickness / 2 + off[2]];
  const sdfH = hand.sdf;
  const sdfBoard = (x: number, y: number, z: number) => {
    const px = x - t[0], py = y - t[1], pz = z - t[2];
    return sdfH(R[0] * px + R[3] * py + R[6] * pz, R[1] * px + R[4] * py + R[7] * pz, R[2] * px + R[5] * py + R[8] * pz);
  };
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const hp: Vec3 = [k & 1 ? hand.bounds.max[0] : hand.bounds.min[0], k & 2 ? hand.bounds.max[1] : hand.bounds.min[1], k & 4 ? hand.bounds.max[2] : hand.bounds.min[2]];
    const bp = mulRV(R, hp);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], bp[a] + t[a]);
      max[a] = Math.max(max[a], bp[a] + t[a]);
    }
  }
  min[2] = Math.max(min[2], 0);
  const landmarks = capsuleLandmarksHandFrame(params).map((p) => {
    const b = mulRV(R, p);
    return { x: b[0] + t[0], y: b[1] + t[1], z: b[2] + t[2] };
  });
  const coin = opts.coin === null ? null : { diameterMm: 23.25, thicknessMm: 2.33, color: [0.78, 0.66, 0.42] as RGB, ...(opts.coin ?? {}) };
  const tr = hand.truth;
  return {
    hand,
    placement,
    handToBoard: { R, t },
    layout,
    coin,
    sdfBoard,
    handBoundsBoard: { min, max },
    landmarks,
    truth: { handLength: tr.handLengthMm, palmBreadth: tr.palmBreadthMm, palmThickness: tr.palmThicknessMm, circumference: tr.circumferenceMm, fingerLengths: { ...tr.fingerLengthsMm }, knuckleY: tr.knuckleYMm },
  };
}

/** The same scene with the hand moved by ``offset`` (board mm): for "the hand moved between views" tests. */
export function moveHand(scene: BoardScene, offset: Vec3): BoardScene {
  const o = scene.placement.offset ?? [0, 0, 0];
  return makeBoardScene({ params: scene.hand.params, placement: { ...scene.placement, offset: [o[0] + offset[0], o[1] + offset[1], o[2] + offset[2]] }, layout: scene.layout, coin: scene.coin });
}

// ---------------------------------------------------------------------------------------------------------------
// Cameras

export interface BoardCamera {
  id: string;
  intrinsics: Intrinsics;
  pose: CameraPose;
  elevationDeg: number;
  azimuthDeg: number | null;
}

export interface RigSpec {
  width?: number;
  height?: number;
  /** Horizontal field of view (deg) of the picture's long side. Default 62 (a phone's main camera in landscape). */
  hfovDeg?: number;
  k1?: number;
  k2?: number;
  /** Camera distance from the look-at point (mm). Default 340; the top view uses topHeightMm. */
  distanceMm?: number;
  topHeightMm?: number;
  top?: boolean;
  lowElevationDeg?: number;
  lowCount?: number;
  highElevationDeg?: number;
  highCount?: number;
  /** The board point the cameras aim at; default the middle of the hand. */
  target?: Vec3;
}

export function sceneTarget(scene: BoardScene): Vec3 {
  // the middle of the hand between the wrist plane and the fingertips, across thumb to little finger, mid-height
  const p = scene.hand.params;
  const hb = scene.hand.bounds;
  const hp: Vec3 = [(hb.min[0] + hb.max[0]) / 2, (p.palmLength + scene.truth.handLength) / 2 - 15, 0];
  const b = mulRV(scene.handToBoard.R, hp);
  return [b[0] + scene.handToBoard.t[0], b[1] + scene.handToBoard.t[1], 10];
}

/** One view straight above, a low ring all round and optionally a higher ring (the capture design of the audit). */
export function boardRig(scene: BoardScene, spec: RigSpec = {}): BoardCamera[] {
  const width = spec.width ?? 640, height = spec.height ?? 360;
  const f = width / 2 / Math.tan(((spec.hfovDeg ?? 62) * Math.PI) / 360);
  const K: Intrinsics = { fx: f, fy: f, cx: width / 2, cy: height / 2, width, height };
  if (spec.k1) K.k1 = spec.k1;
  if (spec.k2) K.k2 = spec.k2;
  const target = spec.target ?? sceneTarget(scene);
  const dist = spec.distanceMm ?? 340;
  const out: BoardCamera[] = [];
  if (spec.top ?? true) {
    const eye: Vec3 = [target[0], target[1], target[2] + (spec.topHeightMm ?? 400)];
    out.push({ id: "top", intrinsics: K, pose: lookAtPose(eye, target, [0, 1, 0]), elevationDeg: 90, azimuthDeg: null });
  }
  const ring = (elev: number, n: number, tag: string) => {
    const e = (elev * Math.PI) / 180;
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      const eye: Vec3 = [target[0] + dist * Math.cos(e) * Math.cos(a), target[1] + dist * Math.cos(e) * Math.sin(a), target[2] + dist * Math.sin(e)];
      out.push({ id: `${tag}-${String(Math.round((a * 180) / Math.PI)).padStart(3, "0")}`, intrinsics: K, pose: lookAtPose(eye, target, [0, 0, 1]), elevationDeg: elev, azimuthDeg: (a * 180) / Math.PI });
    }
  };
  if ((spec.lowCount ?? 16) > 0) ring(spec.lowElevationDeg ?? 12, spec.lowCount ?? 16, `e${spec.lowElevationDeg ?? 12}`);
  if ((spec.highCount ?? 0) > 0) ring(spec.highElevationDeg ?? 35, spec.highCount ?? 0, `e${spec.highElevationDeg ?? 35}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

export interface RenderOptions {
  skin?: RGB;
  /** sRGB 0..1 */
  table?: RGB;
  room?: RGB;
  /** Linear albedo of the paper, the ink and the coin outline. */
  paperAlbedo?: number;
  inkAlbedo?: number;
  outlineAlbedo?: number;
  /** Direction TOWARD the light, board frame (normalised internally). Default from the upper left, 50 deg high. */
  lightDir?: Vec3;
  lightColor?: RGB;
  /** Diffuse and ambient strength (linear). */
  diffuse?: number;
  ambient?: number;
  /** Penumbra sharpness of the soft shadow (larger = harder). Default 10. */
  shadowHardness?: number;
  /** Strength of a smooth illumination variation over the board (0 = uniform). Default 0.15. */
  illumVariation?: number;
  /** Vignetting strength at the picture corners (0 = none). Default 0.15. */
  vignette?: number;
  /** Optical blur (Gaussian sigma in pixels). Default 0.7. */
  blurSigmaPx?: number;
  /** Sensor noise (sigma in 8-bit sRGB units). Default 2.5. */
  noiseSigma?: number;
  seed?: number;
  /** Distance (mm) from the board centre beyond which a ray that went down sees the room instead of the table. */
  tableRadiusMm?: number;
}

export interface RenderedView {
  image: RGBAImage;
  /** The exact hand mask (pixel centre ray hits the hand before the paper, the table or the coin). */
  mask: { width: number; height: number; data: Uint8Array };
  /** What each pixel centre's ray hit: 0 room, 1 table, 2 paper, 3 hand, 4 coin. */
  surface: Uint8Array;
}

export const SURFACE = { room: 0, table: 1, paper: 2, hand: 3, coin: 4 } as const;

const toLin = (c: RGB): Vec3 => [SRGB_TO_LINEAR[Math.round(c[0] * 255)], SRGB_TO_LINEAR[Math.round(c[1] * 255)], SRGB_TO_LINEAR[Math.round(c[2] * 255)]];

export function renderView(scene: BoardScene, K: Intrinsics, pose: CameraPose, opts: RenderOptions = {}): RenderedView {
  const w = K.width, h = K.height;
  const skin = toLin(opts.skin ?? SKIN_TONES.medium);
  const table = toLin(opts.table ?? [0.45, 0.47, 0.5]);
  const room = toLin(opts.room ?? [0.62, 0.6, 0.55]);
  const coinLin = scene.coin ? toLin(scene.coin.color) : ([0, 0, 0] as Vec3);
  const paperA = opts.paperAlbedo ?? 0.8, inkA = opts.inkAlbedo ?? 0.035, outlineA = opts.outlineAlbedo ?? 0.4;
  const L = normalize(opts.lightDir ?? [-0.45, 0.35, 0.82]);
  const lightC = toLin(opts.lightColor ?? [1, 0.98, 0.95]);
  const dif = opts.diffuse ?? 0.75, amb = opts.ambient ?? 0.3;
  const hard = opts.shadowHardness ?? 10;
  const illumVar = opts.illumVariation ?? 0.15;
  const vignette = opts.vignette ?? 0.15;
  const tableR = opts.tableRadiusMm ?? 700;
  const layout = scene.layout;
  const PW = layout.paper.widthMm, PH = layout.paper.heightMm;
  const bc: Vec3 = [PW / 2, PH / 2, 0];
  const { R: HR, t: Ht } = scene.handToBoard;
  const sdfH = scene.hand.sdf;
  const hb = scene.hand.bounds; // hand frame
  const hbMin = [hb.min[0], hb.min[1], hb.min[2]], hbMax = [hb.max[0], hb.max[1], hb.max[2]];
  const Lh = mulRtV(HR, L);
  const coin = scene.coin;
  const ccx = layout.coinTarget.center.x, ccy = layout.coinTarget.center.y;
  const cr = coin ? coin.diameterMm / 2 : 0, chgt = coin ? coin.thicknessMm : 0;
  const grid = rayGrid(K, pose);
  const O = grid.origin;
  const Oh = mulRtV(HR, [O[0] - Ht[0], O[1] - Ht[1], O[2] - Ht[2]]);
  const planes = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  const mask = new Uint8Array(w * h);
  const surface = new Uint8Array(w * h);

  const illum = (x: number, y: number) => 1 + illumVar * Math.sin(x / 95 + 0.6) * Math.cos(y / 70 - 0.4);
  /** Soft shadow factor (0 = full shadow, 1 = lit) at a hand-frame point toward the light (iq's penumbra estimate). */
  const softShadow = (px: number, py: number, pz: number): number => {
    const hit = rayBox([px, py, pz], Lh, hbMin, hbMax);
    if (!hit) return 1;
    let t = Math.max(hit[0], 0.4);
    let res = 1;
    for (let s = 0; s < 96 && t < hit[1]; s++) {
      const d = sdfH(px + Lh[0] * t, py + Lh[1] * t, pz + Lh[2] * t);
      if (d < 0.01) return 0;
      res = Math.min(res, (hard * d) / t);
      t += Math.min(Math.max(d, 0.3), 8);
    }
    return Math.max(0, Math.min(1, res));
  };

  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const p = j * w + i;
      const dx = grid.dirs[p * 3], dy = grid.dirs[p * 3 + 1], dz = grid.dirs[p * 3 + 2];
      // board plane
      const tPlane = dz < -1e-9 ? -O[2] / dz : Infinity;
      // coin (a short cylinder standing on the board)
      let tCoin = Infinity, coinNz = 0, coinNx = 0, coinNy = 0;
      if (coin) {
        if (dz < 0) {
          const tt = (chgt - O[2]) / dz;
          const x = O[0] + dx * tt - ccx, y = O[1] + dy * tt - ccy;
          if (tt > 0 && x * x + y * y <= cr * cr) ((tCoin = tt), (coinNz = 1));
        }
        const a = dx * dx + dy * dy;
        if (a > 1e-12) {
          const ox = O[0] - ccx, oy = O[1] - ccy;
          const b = ox * dx + oy * dy, c = ox * ox + oy * oy - cr * cr;
          const disc = b * b - a * c;
          if (disc >= 0) {
            const tt = (-b - Math.sqrt(disc)) / a;
            const z = O[2] + dz * tt;
            if (tt > 0 && z >= 0 && z <= chgt && tt < tCoin) {
              tCoin = tt;
              coinNz = 0;
              coinNx = (ox + dx * tt) / cr;
              coinNy = (oy + dy * tt) / cr;
            }
          }
        }
      }
      // hand: sphere tracing in the hand frame, limited to the hand's box and to the space above the paper
      let tHand = Infinity;
      const dh0 = HR[0] * dx + HR[3] * dy + HR[6] * dz, dh1 = HR[1] * dx + HR[4] * dy + HR[7] * dz, dh2 = HR[2] * dx + HR[5] * dy + HR[8] * dz;
      const box = rayBox(Oh, [dh0, dh1, dh2], hbMin, hbMax);
      if (box) {
        let t = box[0];
        const tEnd = Math.min(box[1], tPlane, tCoin);
        for (let s = 0; s < 200 && t <= tEnd; s++) {
          const d = sdfH(Oh[0] + dh0 * t, Oh[1] + dh1 * t, Oh[2] + dh2 * t);
          if (d < 0.02) {
            tHand = t;
            break;
          }
          t += Math.max(d, 0.03);
        }
      }
      let r = 0, g = 0, b = 0;
      if (tHand < Infinity) {
        mask[p] = 255;
        surface[p] = SURFACE.hand;
        const hx = Oh[0] + dh0 * tHand, hy = Oh[1] + dh1 * tHand, hz = Oh[2] + dh2 * tHand;
        const e = 0.15;
        let nx = sdfH(hx + e, hy, hz) - sdfH(hx - e, hy, hz);
        let ny = sdfH(hx, hy + e, hz) - sdfH(hx, hy - e, hz);
        let nz = sdfH(hx, hy, hz + e) - sdfH(hx, hy, hz - e);
        const nn = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nn; ny /= nn; nz /= nn; // fmt: skip
        const ndl = nx * Lh[0] + ny * Lh[1] + nz * Lh[2];
        const sh = ndl > 0 ? softShadow(hx + nx * 0.3, hy + ny * 0.3, hz + nz * 0.3) : 0;
        const bx = O[0] + dx * tHand, by = O[1] + dy * tHand;
        const k = illum(bx, by) * (amb + dif * Math.max(0, ndl) * sh);
        r = skin[0] * k * lightC[0]; g = skin[1] * k * lightC[1]; b = skin[2] * k * lightC[2]; // fmt: skip
      } else if (tCoin < Infinity) {
        surface[p] = SURFACE.coin;
        const ndl = coinNz ? L[2] : Math.max(0, coinNx * L[0] + coinNy * L[1]);
        const x = O[0] + dx * tCoin, y = O[1] + dy * tCoin, z = O[2] + dz * tCoin;
        const ph = mulRtV(HR, [x - Ht[0], y - Ht[1], z - Ht[2]]);
        const k = illum(x, y) * (amb + dif * ndl * softShadow(ph[0], ph[1], ph[2]));
        r = coinLin[0] * k * lightC[0]; g = coinLin[1] * k * lightC[1]; b = coinLin[2] * k * lightC[2]; // fmt: skip
      } else if (tPlane < Infinity && Math.hypot(O[0] + dx * tPlane - bc[0], O[1] + dy * tPlane - bc[1]) < tableR) {
        const x = O[0] + dx * tPlane, y = O[1] + dy * tPlane;
        const onPaper = x >= 0 && y >= 0 && x <= PW && y <= PH;
        let alb: Vec3;
        if (onPaper) {
          surface[p] = SURFACE.paper;
          const a = boardIsBlack(x, y, layout) ? inkA : onCoinOutline(x, y, layout) ? outlineA : paperA;
          alb = [a, a, a];
        } else {
          surface[p] = SURFACE.table;
          const grain = 1 + 0.05 * Math.sin(x / 6 + 2 * Math.sin(y / 31));
          alb = [table[0] * grain, table[1] * grain, table[2] * grain];
        }
        const ph = mulRtV(HR, [x - Ht[0], y - Ht[1], -Ht[2]]);
        const k = illum(x, y) * (amb + dif * L[2] * softShadow(ph[0], ph[1], ph[2]));
        r = alb[0] * k * lightC[0]; g = alb[1] * k * lightC[1]; b = alb[2] * k * lightC[2]; // fmt: skip
      } else {
        surface[p] = SURFACE.room;
        const az = Math.atan2(dy, dx);
        const band = 0.85 + 0.15 * Math.sign(Math.sin(az * 9));
        const k = (0.75 + 0.35 * Math.max(-0.3, Math.min(1, dz + 0.3))) * band;
        r = room[0] * k; g = room[1] * k; b = room[2] * k; // fmt: skip
      }
      if (vignette > 0) {
        const ux = (i + 0.5 - K.cx) / (w / 2), uy = (j + 0.5 - K.cy) / (w / 2);
        const v = 1 - vignette * (ux * ux + uy * uy) * 0.5;
        r *= v; g *= v; b *= v; // fmt: skip
      }
      planes[0][p] = r; planes[1][p] = g; planes[2][p] = b; // fmt: skip
    }

  const sigma = opts.blurSigmaPx ?? 0.7;
  for (const pl of planes) gaussianBlurPlane(pl, w, h, sigma);
  const rng = makeRng(opts.seed ?? 1);
  const noise = opts.noiseSigma ?? 2.5;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    for (let c = 0; c < 3; c++) data[p * 4 + c] = Math.round(linearToSrgb255(planes[c][p]) + (noise > 0 ? noise * gaussian(rng) : 0));
    data[p * 4 + 3] = 255;
  }
  return { image: { width: w, height: h, data }, mask: { width: w, height: h, data: mask }, surface };
}

// ---------------------------------------------------------------------------------------------------------------
// Landmarks and reference areas

/** The 21 landmarks seen by a camera (pixels, distortion applied), with Gaussian pixel noise; null when a landmark is
 *  behind the camera or outside the picture, or dropped at random with ``dropProbability`` (a partial detection). */
export function projectLandmarks(points: readonly Pt3[], K: Intrinsics, pose: CameraPose, opts: { noisePx?: number; seed?: number; dropProbability?: number } = {}): (Pt | null)[] {
  const rng = makeRng(opts.seed ?? 7);
  return points.map((P) => {
    const q = projectPoint([P.x, P.y, P.z], K, pose);
    const nx = gaussian(rng), ny = gaussian(rng), drop = rng();
    if (!q) return null;
    if (opts.dropProbability && drop < opts.dropProbability) return null;
    const u = q.u + (opts.noisePx ?? 0) * nx, v = q.v + (opts.noisePx ?? 0) * ny;
    if (u < 0 || v < 0 || u >= K.width || v >= K.height) return null;
    return { x: u, y: v };
  });
}

/** Surface areas (mm^2) of the hand solid that a board reconstruction can represent: the hand intersected with the
 *  carving volume (above the paper, x >= the volume's minimum). ``closedMm2`` includes the flat faces where the volume
 *  cuts it (the contact with the board and the forearm cut), as a hull mesh does; ``freeMm2`` leaves them out (the
 *  hand's own skin above the board inside the volume). From a fine marching-tetrahedra mesh of the exact SDF. */
export function referenceAreasInVolume(scene: BoardScene, volume: { min: Vec3; max: Vec3 }, voxelMm = 0.8): { closedMm2: number; freeMm2: number } {
  const { min, max } = volume;
  const sdf = (x: number, y: number, z: number) => Math.max(scene.sdfBoard(x, y, z), min[2] - z, min[0] - x, x - max[0], min[1] - y, y - max[1], z - max[2]);
  const pad = 2;
  const field = sdfToField(sdf, { min: [min[0] - pad, min[1] - pad, min[2] - pad], max: [max[0] + pad, max[1] + pad, max[2] + pad] }, voxelMm);
  const mesh = extractMesh(field, 0);
  const closed = meshArea(mesh);
  const V = mesh.vertices, I = mesh.indices;
  let free = 0;
  const tol = 0.3;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const onFace = (k: number, v: number) => Math.abs(V[a + k] - v) < tol && Math.abs(V[b + k] - v) < tol && Math.abs(V[c + k] - v) < tol;
    if (onFace(2, min[2]) || onFace(0, min[0])) continue;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const wx = V[c] - V[a], wy = V[c + 1] - V[a + 1], wz = V[c + 2] - V[a + 2];
    free += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
  }
  return { closedMm2: closed, freeMm2: free };
}
