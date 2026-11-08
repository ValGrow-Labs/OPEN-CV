// SIMULATED photos of a hand resting palm-down on a TABLE with NO printed board, and a coin, for the EXPERIMENTAL
// board-free structure-from-motion study (sfm/). Test support only.
//
// Reuses the capsule hand, its placement, landmarks and exact dimensions of multiview/scene.ts (makeBoardScene with no
// coin: its "board frame" here is simply the TABLE frame, table plane z = 0, millimetres) and the camera path of the
// board capture (boardRig: one top view, a low ring at about 12 degrees, optionally a ring at 35 degrees). Its renderer
// draws the printed board, so this file has its own: a procedural table texture (textures.ts) anti-aliased with ray
// differentials, the coin as a cylinder (on the table, or flat on the back of the hand), the hand with Lambertian shading
// and a soft cast shadow, a smooth "room" beyond the table, vignetting, radial distortion (in the ray grid), Gaussian
// blur and sensor noise. Rendering is split into a clean linear render (expensive, cached by the tests) and a cheap
// finish (blur + noise) so blur and noise can be varied without re-rendering.
//
// It is a TEST RENDERER: no gloss, no sub-surface scattering, no tone curve, no video compression, a capsule hand.
// Every number obtained with it is SIMULATED.
import type { CameraPose, Intrinsics, Pt3 } from "../common";
import { makeBoardScene, type BoardScene, type RGB, SKIN_TONES } from "../multiview/scene";
import { gaussianBlurPlane, linearToSrgb255, rayBox, rayGrid, SRGB_TO_LINEAR, type RGBAImage } from "../multiview/image";
import { normalize, type Vec3 } from "../reconstruction/linalg";
import { gaussian, makeRng } from "../reconstruction/rng";
import { makeTexture, type TableTexture, type TextureKind } from "./textures";

/** The 2019 Indian 2-rupee coin (config/reference_objects.json `inr_2_2019`): 23.00 mm. Thickness UNVERIFIED (not in
 *  the settings): 1.5 mm assumed, +-0.5 mm. */
export const INR2_DIAMETER_MM = 23.0;
export const INR2_THICKNESS_ASSUMED_MM = 1.5;

export type CoinPlacement = "table-side" | "table-tips" | "hand";

export interface SfmCoin {
  /** Centre of the coin's BOTTOM face (table mm); the coin lies flat (axis +z). */
  base: Vec3;
  diameterMm: number;
  thicknessMm: number;
  color: RGB;
  placement: CoinPlacement;
}

export interface SfmScene {
  hand: BoardScene;
  texture: TableTexture;
  coin: SfmCoin;
  /** The coin's top-face centre (table mm): the centre of the circle whose diameter fixes the scale. */
  coinTopCentre: Vec3;
  landmarks: Pt3[];
}

export interface SfmSceneOptions {
  texture?: TextureKind;
  textureSeed?: number;
  coin?: CoinPlacement;
  coinDiameterMm?: number;
  coinThicknessMm?: number;
}

/** Height of the hand's top surface above (x, y) (ray cast straight down onto the SDF), 0 if no hand there. */
export function handTopZ(scene: BoardScene, x: number, y: number): number {
  let z = scene.handBoundsBoard.max[2] + 5;
  for (let s = 0; s < 400 && z > 0; s++) {
    const d = scene.sdfBoard(x, y, z);
    if (d < 0.01) return z;
    z -= Math.max(d, 0.02);
  }
  return 0;
}

export function makeSfmScene(opts: SfmSceneOptions = {}): SfmScene {
  const hand = makeBoardScene({ coin: null });
  const texture = makeTexture(opts.texture ?? "speckle", opts.textureSeed ?? 1);
  const D = opts.coinDiameterMm ?? INR2_DIAMETER_MM, T = opts.coinThicknessMm ?? INR2_THICKNESS_ASSUMED_MM;
  const placement = opts.coin ?? "table-side";
  const wx = hand.placement.wristX, wy = hand.placement.wristY;
  const p = hand.hand.params;
  let base: Vec3;
  if (placement === "table-side") {
    // flat on the table beside the palm, little-finger side (board +y), close to the middle of the pictures
    base = [wx + p.palmLength * 0.6, wy + p.palmBreadth / 2 + 24, 0];
  } else if (placement === "table-tips") {
    base = [wx + p.palmLength + p.fingers.middle.length + 30, wy, 0];
  } else {
    // flat on the back of the hand, over the palm centre
    const x = wx + p.palmLength * 0.5, y = wy + 4;
    base = [x, y, handTopZ(hand, x, y)];
  }
  const coin: SfmCoin = { base, diameterMm: D, thicknessMm: T, color: [0.74, 0.68, 0.58], placement };
  return { hand, texture, coin, coinTopCentre: [base[0], base[1], base[2] + T], landmarks: hand.landmarks };
}

export interface CleanRender {
  width: number;
  height: number;
  /** Linear RGB planes before blur and noise. */
  planes: [Float32Array, Float32Array, Float32Array];
  /** 0 room, 1 table, 3 hand, 4 coin. */
  surface: Uint8Array;
}

export const SFM_SURFACE = { room: 0, table: 1, hand: 3, coin: 4 } as const;

export interface SfmRenderOptions {
  skin?: RGB;
  lightDir?: Vec3;
  diffuse?: number;
  ambient?: number;
  shadowHardness?: number;
  illumVariation?: number;
  vignette?: number;
  /** Table radius (mm) around the hand; beyond it the rays see a smooth room. Default 650. */
  tableRadiusMm?: number;
}

const toLin = (c: RGB): Vec3 => [SRGB_TO_LINEAR[Math.round(c[0] * 255)], SRGB_TO_LINEAR[Math.round(c[1] * 255)], SRGB_TO_LINEAR[Math.round(c[2] * 255)]];
const mulRtV = (R: readonly number[], v: ArrayLike<number>): Vec3 => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];

/** The clean linear render of one view (no blur, no noise). */
export function renderClean(scene: SfmScene, K: Intrinsics, pose: CameraPose, opts: SfmRenderOptions = {}): CleanRender {
  const w = K.width, h = K.height, N = w * h;
  const hs = scene.hand;
  const skin = toLin(opts.skin ?? SKIN_TONES.medium);
  const coinLin = toLin(scene.coin.color);
  const L = normalize(opts.lightDir ?? [-0.45, 0.35, 0.82]);
  const dif = opts.diffuse ?? 0.75, amb = opts.ambient ?? 0.3;
  const hard = opts.shadowHardness ?? 10;
  const illumVar = opts.illumVariation ?? 0.12;
  const vignette = opts.vignette ?? 0.15;
  const tableR = opts.tableRadiusMm ?? 650;
  const centre: Vec3 = [hs.placement.wristX + 90, hs.placement.wristY, 0];
  const { R: HR, t: Ht } = hs.handToBoard;
  const sdfH = hs.hand.sdf;
  const hb = hs.hand.bounds;
  const hbMin = [hb.min[0], hb.min[1], hb.min[2]], hbMax = [hb.max[0], hb.max[1], hb.max[2]];
  const Lh = mulRtV(HR, L);
  const cb = scene.coin.base, cr = scene.coin.diameterMm / 2, cz0 = cb[2], cz1 = cb[2] + scene.coin.thicknessMm;
  const grid = rayGrid(K, pose);
  const O = grid.origin;
  const Oh = mulRtV(HR, [O[0] - Ht[0], O[1] - Ht[1], O[2] - Ht[2]]);
  const planes: [Float32Array, Float32Array, Float32Array] = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const surface = new Uint8Array(N);
  const tx = new Float32Array(N).fill(NaN), ty = new Float32Array(N).fill(NaN);
  const shade = new Float32Array(N); // lighting factor of table pixels (texture applied in a second pass)

  const illum = (x: number, y: number) => 1 + illumVar * Math.sin(x / 95 + 0.6) * Math.cos(y / 70 - 0.4);
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
  /** The coin also shadows the table a little (a cylinder test toward the light). */
  const coinShadow = (x: number, y: number, z: number): number => {
    if (z >= cz1) return 1;
    const s = (cz1 - z) / L[2];
    const qx = x + L[0] * s - cb[0], qy = y + L[1] * s - cb[1];
    return qx * qx + qy * qy <= cr * cr ? 0.35 : 1;
  };

  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const p = j * w + i;
      const dx = grid.dirs[p * 3], dy = grid.dirs[p * 3 + 1], dz = grid.dirs[p * 3 + 2];
      const tPlane = dz < -1e-9 ? -O[2] / dz : Infinity;
      // coin: top disc and side wall
      let tCoin = Infinity, coinTop = false, cnx = 0, cny = 0;
      if (dz < 0) {
        const tt = (cz1 - O[2]) / dz;
        const x = O[0] + dx * tt - cb[0], y = O[1] + dy * tt - cb[1];
        if (tt > 0 && x * x + y * y <= cr * cr) ((tCoin = tt), (coinTop = true));
      }
      {
        const a = dx * dx + dy * dy;
        if (a > 1e-12) {
          const ox = O[0] - cb[0], oy = O[1] - cb[1];
          const b = ox * dx + oy * dy, c = ox * ox + oy * oy - cr * cr;
          const disc = b * b - a * c;
          if (disc >= 0) {
            const tt = (-b - Math.sqrt(disc)) / a;
            const z = O[2] + dz * tt;
            if (tt > 0 && z >= cz0 && z <= cz1 && tt < tCoin) {
              tCoin = tt;
              coinTop = false;
              cnx = (ox + dx * tt) / cr;
              cny = (oy + dy * tt) / cr;
            }
          }
        }
      }
      let tHand = Infinity;
      const dh0 = HR[0] * dx + HR[3] * dy + HR[6] * dz, dh1 = HR[1] * dx + HR[4] * dy + HR[7] * dz, dh2 = HR[2] * dx + HR[5] * dy + HR[8] * dz;
      const box = rayBox(Oh, [dh0, dh1, dh2], hbMin, hbMax);
      if (box) {
        let t = box[0];
        const tEnd = Math.min(box[1], tPlane, tCoin);
        for (let s = 0; s < 220 && t <= tEnd; s++) {
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
        surface[p] = SFM_SURFACE.hand;
        const hx = Oh[0] + dh0 * tHand, hy = Oh[1] + dh1 * tHand, hz = Oh[2] + dh2 * tHand;
        const e = 0.15;
        let nx = sdfH(hx + e, hy, hz) - sdfH(hx - e, hy, hz);
        let ny = sdfH(hx, hy + e, hz) - sdfH(hx, hy - e, hz);
        let nz = sdfH(hx, hy, hz + e) - sdfH(hx, hy, hz - e);
        const nn = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nn; ny /= nn; nz /= nn; // fmt: skip
        const ndl = nx * Lh[0] + ny * Lh[1] + nz * Lh[2];
        const sh = ndl > 0 ? softShadow(hx + nx * 0.3, hy + ny * 0.3, hz + nz * 0.3) : 0;
        const bx = O[0] + dx * tHand, by = O[1] + dy * tHand, bz = O[2] + dz * tHand;
        const k = illum(bx, by) * (amb + dif * Math.max(0, ndl) * sh * coinShadow(bx, by, bz));
        r = skin[0] * k; g = skin[1] * k * 0.98; b = skin[2] * k * 0.95; // fmt: skip
      } else if (tCoin < Infinity) {
        surface[p] = SFM_SURFACE.coin;
        const x = O[0] + dx * tCoin, y = O[1] + dy * tCoin, z = O[2] + dz * tCoin;
        const ndl = coinTop ? L[2] : Math.max(0, cnx * L[0] + cny * L[1]);
        const ph = mulRtV(HR, [x - Ht[0], y - Ht[1], z - Ht[2]]);
        // a faint embossed ring so the coin face is not perfectly flat in colour
        const rr = Math.hypot(x - cb[0], y - cb[1]);
        const emb = coinTop && rr > cr * 0.8 && rr < cr * 0.86 ? 0.85 : 1;
        const k = illum(x, y) * (amb + dif * ndl * softShadow(ph[0], ph[1], ph[2])) * emb * (coinTop ? 1 : 0.8);
        r = coinLin[0] * k; g = coinLin[1] * k; b = coinLin[2] * k; // fmt: skip
      } else if (tPlane < Infinity && Math.hypot(O[0] + dx * tPlane - centre[0], O[1] + dy * tPlane - centre[1]) < tableR) {
        surface[p] = SFM_SURFACE.table;
        const x = O[0] + dx * tPlane, y = O[1] + dy * tPlane;
        tx[p] = x;
        ty[p] = y;
        const ph = mulRtV(HR, [x - Ht[0], y - Ht[1], -Ht[2]]);
        shade[p] = illum(x, y) * (amb + dif * L[2] * softShadow(ph[0], ph[1], ph[2]) * coinShadow(x, y, 0));
        continue;
      } else {
        surface[p] = SFM_SURFACE.room;
        const k = 0.7 + 0.3 * Math.max(-0.3, Math.min(1, dz + 0.3));
        r = 0.36 * k; g = 0.35 * k; b = 0.32 * k; // fmt: skip
      }
      planes[0][p] = r; planes[1][p] = g; planes[2][p] = b; // fmt: skip
    }

  // texture pass: 2 x 2 supersampling of the table texture from ray differentials (the pixel's footprint on the table)
  const alb = scene.texture.albedo;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const p = j * w + i;
      if (surface[p] !== SFM_SURFACE.table) continue;
      const x = tx[p], y = ty[p];
      const diff = (q: number, qq: number, s: number): [number, number] | null => (Number.isFinite(tx[q]) && Number.isFinite(tx[qq]) ? [(tx[qq] - tx[q]) / s, (ty[qq] - ty[q]) / s] : null);
      const di = (i > 0 && i < w - 1 && diff(p - 1, p + 1, 2)) || (i < w - 1 && diff(p, p + 1, 1)) || (i > 0 && diff(p - 1, p, 1)) || [0, 0];
      const dj = (j > 0 && j < h - 1 && diff(p - w, p + w, 2)) || (j < h - 1 && diff(p, p + w, 1)) || (j > 0 && diff(p - w, p, 1)) || [0, 0];
      const fp = Math.max(Math.hypot(di[0], di[1]), Math.hypot(dj[0], dj[1])) / 2;
      let ar = 0, ag = 0, ab = 0;
      for (const [a, c] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
        const v = alb(x + a * di[0] + c * dj[0], y + a * di[1] + c * dj[1], fp);
        ar += v[0]; ag += v[1]; ab += v[2]; // fmt: skip
      }
      const k = shade[p] / 4;
      planes[0][p] = ar * k; planes[1][p] = ag * k; planes[2][p] = ab * k; // fmt: skip
    }
  if (vignette > 0)
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const ux = (i + 0.5 - K.cx) / (w / 2), uy = (j + 0.5 - K.cy) / (w / 2);
        const v = 1 - vignette * (ux * ux + uy * uy) * 0.5;
        const p = j * w + i;
        planes[0][p] *= v; planes[1][p] *= v; planes[2][p] *= v; // fmt: skip
      }
  return { width: w, height: h, planes, surface };
}

export interface FinishOptions {
  /** Optical blur, Gaussian sigma in pixels (default 0.7). */
  blurSigmaPx?: number;
  /** Sensor noise, sigma in 8-bit sRGB units (default 2.5). */
  noiseSigma?: number;
  seed?: number;
}

/** Blur + noise + sRGB encoding of a clean render (the clean render is not modified). */
export function finishRender(c: CleanRender, o: FinishOptions = {}): RGBAImage {
  const { width: w, height: h } = c;
  const sigma = o.blurSigmaPx ?? 0.7;
  const pl = c.planes.map((p) => gaussianBlurPlane(Float32Array.from(p), w, h, sigma));
  const rng = makeRng(o.seed ?? 1);
  const noise = o.noiseSigma ?? 2.5;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    for (let k = 0; k < 3; k++) data[p * 4 + k] = Math.round(linearToSrgb255(pl[k][p]) + (noise > 0 ? noise * gaussian(rng) : 0));
    data[p * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** Binary mask (0/255) of one surface class. */
export function surfaceMask(c: CleanRender, cls: number): Uint8Array {
  const m = new Uint8Array(c.width * c.height);
  for (let p = 0; p < m.length; p++) if (c.surface[p] === cls) m[p] = 255;
  return m;
}
