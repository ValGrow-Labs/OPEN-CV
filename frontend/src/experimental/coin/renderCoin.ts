// TEST RENDERER for the EXPERIMENTAL coin study: a coin (an ideal cylinder) lying on a flat surface, seen by a pinhole
// camera with radial distortion, with known truth.
//
// World frame (millimetres): the surface is the plane z = 0; the coin's BASE centre is the origin, its axis +z, its top
// face at z = thickness. Optional occluders are capsules (a crude finger). The surface is skin (coin on the palm), paper
// or wood (coin on a table), with a smooth procedural texture. The coin face is silver with a faint relief, the wall a
// darker grey, a soft contact shadow surrounds it, and an optional specular highlight ("glare") sits on the face.
// Pixels are supersampled adaptively (pixel-corner grid; pixels whose corners see different materials get ss x ss
// jittered samples), then Gaussian blur and sensor noise. Deterministic for a seed.
//
// To keep 12 MP scenes cheap, render a CROP: `cropIntrinsics` shifts the principal point, so the crop's pixels are
// exactly those of the full frame (distortion is still computed about the full frame's principal point).
//
// An IDEAL scene: no coin edge serrations or rim bevel, no real relief, no real specular model, no rolling shutter,
// no JPEG, no tone curve, no real lens. Everything measured on it is SIMULATED.

import type { CameraPose, Intrinsics } from "../common";
import { gaussianBlurPlane } from "../board/image";
import { cameraCenter } from "../geometry/camera";
import { seededRandom, transpose, type V3 } from "../geometry/linalg";
import type { RgbaImage } from "../../vision/coinDetector";

export type Rgb = readonly [number, number, number];

export type SurfaceKind = "skin" | "paper" | "wood";

/** Illustrative surface colours (sRGB 0..255), not measured. */
export const SURFACE_COLORS: Record<SurfaceKind | "skinDark", Rgb> = {
  skin: [214, 166, 140],
  skinDark: [112, 74, 56],
  paper: [236, 234, 229],
  wood: [150, 104, 68],
};

export interface Capsule {
  a: V3;
  b: V3;
  radius: number;
  color?: Rgb;
}

export interface CoinSceneOptions {
  diameterMm: number;
  thicknessMm: number;
  surface?: SurfaceKind;
  surfaceColor?: Rgb;
  face?: Rgb;
  wall?: Rgb;
  /** Contact shadow width outside the coin (mm, default 1) and strength (0..1, default 0.25). */
  shadowMm?: number;
  shadowStrength?: number;
  /** Specular highlight on the face: centre in face coordinates (mm from the coin centre), Gaussian width (mm), peak
   *  added brightness (grey levels; saturates at 255). */
  glare?: { x: number; y: number; sigmaMm: number; strength: number };
  occluders?: readonly Capsule[];
  supersample?: number;
  blurSigmaPx?: number;
  noiseSigma?: number;
  seed?: number;
}

/** Intrinsics of the sub-window [x0, x0 + w) x [y0, y0 + h) of a full frame (same pixels, shifted principal point). */
export function cropIntrinsics(K: Intrinsics, x0: number, y0: number, w: number, h: number): Intrinsics {
  return { ...K, cx: K.cx - x0, cy: K.cy - y0, width: w, height: h };
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Ray-capsule intersection: the smallest positive ray parameter, or Infinity; writes the outward normal into `nrm`. */
function hitCapsule(o: V3, d: V3, cap: Capsule, nrm: number[]): number {
  const ba = [cap.b[0] - cap.a[0], cap.b[1] - cap.a[1], cap.b[2] - cap.a[2]];
  const oa = [o[0] - cap.a[0], o[1] - cap.a[1], o[2] - cap.a[2]];
  const baba = ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2];
  const bard = ba[0] * d[0] + ba[1] * d[1] + ba[2] * d[2];
  const baoa = ba[0] * oa[0] + ba[1] * oa[1] + ba[2] * oa[2];
  const rdoa = d[0] * oa[0] + d[1] * oa[1] + d[2] * oa[2];
  const oaoa = oa[0] * oa[0] + oa[1] * oa[1] + oa[2] * oa[2];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const r = cap.radius;
  const a = baba * dd - bard * bard;
  const b = baba * rdoa - baoa * bard;
  const c = baba * oaoa - baoa * baoa - r * r * baba;
  let t = Infinity;
  const h = b * b - a * c;
  if (h >= 0 && a > 1e-12) {
    const tt = (-b - Math.sqrt(h)) / a;
    const y = baoa + tt * bard;
    if (tt > 0 && y > 0 && y < baba) t = tt;
  }
  if (!Number.isFinite(t)) {
    // end caps
    for (const end of [cap.a, cap.b]) {
      const oc = [o[0] - end[0], o[1] - end[1], o[2] - end[2]];
      const bb = (d[0] * oc[0] + d[1] * oc[1] + d[2] * oc[2]) / dd;
      const cc = (oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - r * r) / dd;
      const hh = bb * bb - cc;
      if (hh >= 0) {
        const tt = -bb - Math.sqrt(hh);
        if (tt > 0 && tt < t) t = tt;
      }
    }
  }
  if (Number.isFinite(t)) {
    const p = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
    const s = Math.max(0, Math.min(1, ((p[0] - cap.a[0]) * ba[0] + (p[1] - cap.a[1]) * ba[1] + (p[2] - cap.a[2]) * ba[2]) / baba));
    const q = [cap.a[0] + s * ba[0], cap.a[1] + s * ba[1], cap.a[2] + s * ba[2]];
    const n = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const nn = Math.hypot(n[0], n[1], n[2]) || 1;
    nrm[0] = n[0] / nn;
    nrm[1] = n[1] / nn;
    nrm[2] = n[2] / nn;
  }
  return t;
}

/** Render the coin scene for intrinsics `K` (its width x height) and pose `Xc = R X + t` (world mm). */
export function renderCoinScene(K: Intrinsics, pose: CameraPose, o: CoinSceneOptions): RgbaImage {
  const W = K.width, H = K.height;
  const ss = Math.max(1, Math.round(o.supersample ?? 4));
  const seed = o.seed ?? 1;
  const rnd = seededRandom(seed);
  const C = cameraCenter(pose);
  const Rt = transpose(pose.R);
  const R = o.diameterMm / 2;
  const h = o.thicknessMm;
  const kind = o.surface ?? "skin";
  const base = o.surfaceColor ?? SURFACE_COLORS[kind];
  const face = o.face ?? [176, 176, 181];
  const wall = o.wall ?? [122, 122, 128];
  const shadowMm = o.shadowMm ?? 1;
  const shadowStrength = o.shadowStrength ?? 0.25;
  const occ = o.occluders ?? [];
  const L = [0.3 / 1.068, 0.2 / 1.068, 1 / 1.068];
  const k1 = K.k1 ?? 0, k2 = K.k2 ?? 0;
  const distorted = !!(k1 || k2);
  const col = [0, 0, 0];
  const nrm = [0, 0, 0];
  let key = 0;

  const shade = (dx: number, dy: number, dz: number) => {
    const d: V3 = [dx, dy, dz];
    let best = Infinity;
    let what = 0; // 0 surface, 1 face, 2 wall, 3 + i occluder
    const occN = [0, 0, 1];
    for (let i = 0; i < occ.length; i++) {
      const t = hitCapsule(C, d, occ[i], nrm);
      if (t < best) {
        best = t;
        what = 3 + i;
        occN[0] = nrm[0];
        occN[1] = nrm[1];
        occN[2] = nrm[2];
      }
    }
    let fx = 0, fy = 0;
    if (dz < 0) {
      const t = (h - C[2]) / dz;
      const px = C[0] + t * dx, py = C[1] + t * dy;
      if (t > 0 && t < best && px * px + py * py <= R * R) {
        best = t;
        what = 1;
        fx = px;
        fy = py;
      }
    }
    {
      const a = dx * dx + dy * dy;
      const b = C[0] * dx + C[1] * dy;
      const c = C[0] * C[0] + C[1] * C[1] - R * R;
      const disc = b * b - a * c;
      if (a > 0 && disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / a;
        const z = C[2] + t * dz;
        if (t > 0 && t < best && z >= 0 && z <= h) {
          best = t;
          what = 2;
          fx = C[0] + t * dx;
          fy = C[1] + t * dy;
        }
      }
    }
    const tp = dz < -1e-12 ? -C[2] / dz : Infinity;
    if (what >= 3 && best < tp) {
      const cap = occ[what - 3];
      const c3 = cap.color ?? SURFACE_COLORS.skin;
      const lam = Math.max(0, occN[0] * L[0] + occN[1] * L[1] + occN[2] * L[2]);
      const f = 0.45 + 0.55 * lam;
      col[0] = c3[0] * f;
      col[1] = c3[1] * f;
      col[2] = c3[2] * f;
      key = what;
      return;
    }
    if (what === 1 && best < tp) {
      const r = Math.sqrt(fx * fx + fy * fy) / R;
      const th = Math.atan2(fy, fx);
      let f = 1 + 0.04 * (fx / R) + 0.03 * Math.sin(7 * th) * Math.cos(9 * r);
      if (r > 0.9) f *= 1.06; // raised rim catches more light
      let g = 0;
      if (o.glare) {
        const q = ((fx - o.glare.x) ** 2 + (fy - o.glare.y) ** 2) / (2 * o.glare.sigmaMm ** 2);
        g = o.glare.strength * Math.exp(-q);
      }
      col[0] = face[0] * f + g;
      col[1] = face[1] * f + g;
      col[2] = face[2] * f + g;
      key = 1;
      return;
    }
    if (what === 2 && best < tp) {
      const f = 0.85 + 0.15 * Math.max(0, (fx * L[0] + fy * L[1]) / R / 0.36);
      col[0] = wall[0] * f;
      col[1] = wall[1] * f;
      col[2] = wall[2] * f;
      key = 2;
      return;
    }
    if (!Number.isFinite(tp)) {
      col[0] = col[1] = col[2] = 90;
      key = 0;
      return;
    }
    const X = C[0] + tp * dx, Y = C[1] + tp * dy;
    let f: number;
    if (kind === "skin") f = 1 + 0.1 * (valueNoise(X / 4, Y / 4, seed + 3) - 0.5) + 0.05 * (valueNoise(X / 0.8, Y / 0.8, seed + 5) - 0.5);
    else if (kind === "paper") f = 1 + 0.02 * (valueNoise(X / 2, Y / 2, seed + 3) - 0.5);
    else f = 0.85 + 0.3 * valueNoise(X / 30, Y / 3, seed + 7);
    const dr = Math.sqrt(X * X + Y * Y) - R;
    if (dr >= 0 && dr < shadowMm) f *= 1 - shadowStrength * (1 - dr / shadowMm) ** 2;
    col[0] = base[0] * f;
    col[1] = base[1] * f;
    col[2] = base[2] * f;
    key = 0;
  };

  const rayAt = (u: number, v: number) => {
    let x = (u - K.cx) / K.fx, y = (v - K.cy) / K.fy;
    if (distorted) {
      const xd = x, yd = y;
      for (let it = 0; it < 30; it++) {
        const r2 = x * x + y * y;
        const dd = 1 + k1 * r2 + k2 * r2 * r2;
        const nx = xd / dd, ny = yd / dd;
        const done = Math.abs(nx - x) + Math.abs(ny - y) < 1e-13;
        x = nx;
        y = ny;
        if (done) break;
      }
    }
    shade(Rt[0] * x + Rt[1] * y + Rt[2], Rt[3] * x + Rt[4] * y + Rt[5], Rt[6] * x + Rt[7] * y + Rt[8]);
  };

  const acc = new Float32Array(W * H * 3);
  const rowLen = W + 1;
  let rowA = { key: new Int32Array(rowLen), col: new Float32Array(rowLen * 3) };
  let rowB = { key: new Int32Array(rowLen), col: new Float32Array(rowLen * 3) };
  const shadeRow = (row: typeof rowA, j: number) => {
    for (let i = 0; i <= W; i++) {
      rayAt(i - 0.5, j - 0.5);
      row.key[i] = key;
      row.col[i * 3] = col[0];
      row.col[i * 3 + 1] = col[1];
      row.col[i * 3 + 2] = col[2];
    }
  };
  const inv = 1 / (ss * ss);
  shadeRow(rowA, 0);
  for (let py = 0; py < H; py++) {
    shadeRow(rowB, py + 1);
    for (let px = 0; px < W; px++) {
      const k0 = rowA.key[px];
      const k = (py * W + px) * 3;
      if (k0 === rowA.key[px + 1] && k0 === rowB.key[px] && k0 === rowB.key[px + 1] && !(k0 === 1 && o.glare)) {
        for (let c = 0; c < 3; c++) acc[k + c] = 0.25 * (rowA.col[px * 3 + c] + rowA.col[px * 3 + 3 + c] + rowB.col[px * 3 + c] + rowB.col[px * 3 + 3 + c]);
        continue;
      }
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          rayAt(px - 0.5 + (sx + rnd.uniform()) / ss, py - 0.5 + (sy + rnd.uniform()) / ss);
          r += Math.min(255, col[0]);
          g += Math.min(255, col[1]);
          b += Math.min(255, col[2]);
        }
      acc[k] = r * inv;
      acc[k + 1] = g * inv;
      acc[k + 2] = b * inv;
    }
    const t = rowA;
    rowA = rowB;
    rowB = t;
  }
  const planes = [0, 1, 2].map((c) => {
    const p = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) p[i] = Math.min(255, acc[i * 3 + c]);
    if (o.blurSigmaPx) gaussianBlurPlane(p, W, H, o.blurSigmaPx);
    return p;
  });
  const noise = o.noiseSigma ?? 0;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = planes[0][i] + (noise ? noise * rnd.gaussian() : 0);
    out[i * 4 + 1] = planes[1][i] + (noise ? noise * rnd.gaussian() : 0);
    out[i * 4 + 2] = planes[2][i] + (noise ? noise * rnd.gaussian() : 0);
    out[i * 4 + 3] = 255;
  }
  return { width: W, height: H, data: out };
}

/** Share of the coin's top rim hidden from the camera by the occluders (truth for occlusion tests). */
export function occludedRimShare(pose: CameraPose, o: Pick<CoinSceneOptions, "diameterMm" | "thicknessMm" | "occluders">, n = 360): number {
  const C = cameraCenter(pose);
  const R = o.diameterMm / 2;
  const nrm = [0, 0, 0];
  let hidden = 0;
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const P = [R * Math.cos(th), R * Math.sin(th), o.thicknessMm];
    const d: V3 = [P[0] - C[0], P[1] - C[1], P[2] - C[2]];
    if ((o.occluders ?? []).some((cap) => hitCapsule(C, d, cap, nrm) < 1)) hidden++;
  }
  return hidden / n;
}
