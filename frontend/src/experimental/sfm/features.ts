// Corner features and binary descriptors for the EXPERIMENTAL board-free structure from motion (sfm/), plain TypeScript.
//
//   detectFeatures: Shi-Tomasi corners (smallest eigenvalue of the structure tensor) on a lightly smoothed grey image,
//     non-maximum suppression, spatial bucketing (an even spread over the picture), sub-pixel refinement by a quadratic
//     fit of the response; an optional exclusion mask (the hand: it may move between views); several scales (a 2x
//     pyramid) so a texture seen from a different distance or at a grazing angle still matches.
//   orientation: the intensity centroid of a disc around the corner (ORB); descriptor: 256 binary intensity tests of a
//     Gaussian-sampled pattern rotated by that orientation (rotation-aware BRIEF), on a Gaussian-smoothed image.
//   matchFeatures: Hamming distance, nearest neighbour with Lowe's ratio test, kept only when mutual.
//
// Pixel convention: a feature at (x, y) uses pixel centres at +0.5 (x = i + 0.5 for the centre of column i), the
// convention of the intrinsics (cx = width / 2) and of the masks elsewhere in experimental/.
import { gaussianBlurPlane, type RGBAImage } from "../multiview/image";
import { makeRng, gaussian } from "../reconstruction/rng";

export interface Features {
  /** Sub-pixel positions (pixel centres at +0.5), full-resolution pixels. */
  x: Float32Array;
  y: Float32Array;
  /** Pyramid level of each feature (0 = full size). */
  level: Uint8Array;
  angle: Float32Array;
  /** 8 x 32 bits per feature. */
  desc: Uint32Array;
  count: number;
}

export interface DetectOptions {
  /** Most features kept per picture (default 2500). */
  maxFeatures?: number;
  /** Pyramid levels (default 2: full and half size). */
  levels?: number;
  /** Bucketing grid (cells across x down); each cell keeps at most maxFeatures / cells (default 24 x 14). */
  grid?: [number, number];
  /** Relative response threshold (share of the strongest response; default 0.003) and an absolute floor. */
  quality?: number;
  minResponse?: number;
  /** Non-maximum suppression radius in pixels (default 3). */
  nmsRadius?: number;
  /** 0/255 per full-resolution pixel: features within `maskDilatePx` of a 255 pixel are not used. */
  exclude?: Uint8Array | null;
  maskDilatePx?: number;
  /** Skip the orientation (upright descriptors): right for a phone held upright, as in this capture. Default false. */
  upright?: boolean;
}

const PATCH = 15; // descriptor patch half-size (pixels of the level)
const ORIENT_R = 12;

/** The 256 test pairs (x1, y1, x2, y2) of the descriptor, fixed and seeded. */
const PAIRS: Int8Array = (() => {
  const rng = makeRng(20261108);
  const p = new Int8Array(256 * 4);
  for (let k = 0; k < 256 * 4; k++) {
    let v: number;
    do v = Math.round(gaussian(rng) * (PATCH * 2) / 5);
    while (Math.abs(v) > PATCH - 2);
    p[k] = v;
  }
  return p;
})();

export function toGrey(img: RGBAImage): Float32Array {
  const g = new Float32Array(img.width * img.height);
  const d = img.data;
  for (let p = 0; p < g.length; p++) g[p] = 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
  return g;
}

function halve(src: Float32Array, w: number, h: number): { data: Float32Array; w: number; h: number } {
  const W = w >> 1, H = h >> 1;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const a = 2 * y * w + 2 * x;
      out[y * W + x] = 0.25 * (src[a] + src[a + 1] + src[a + w] + src[a + w + 1]);
    }
  return { data: out, w: W, h: H };
}

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) last = x;
      if (x - last <= r) tmp[y * w + x] = 1;
    }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) last = x;
      if (last - x <= r) tmp[y * w + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 255;
    }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 255;
    }
  }
  return out;
}

interface Cand {
  x: number;
  y: number;
  r: number;
  level: number;
}

function cornersOfLevel(g: Float32Array, w: number, h: number, level: number, o: Required<Omit<DetectOptions, "exclude">>, excl: Uint8Array | null, fullW: number): Cand[] {
  const s = gaussianBlurPlane(Float32Array.from(g), w, h, 0.8);
  const Ixx = new Float32Array(w * h), Iyy = new Float32Array(w * h), Ixy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = (s[p + 1 - w] + 2 * s[p + 1] + s[p + 1 + w] - s[p - 1 - w] - 2 * s[p - 1] - s[p - 1 + w]) / 8;
      const gy = (s[p + w - 1] + 2 * s[p + w] + s[p + w + 1] - s[p - w - 1] - 2 * s[p - w] - s[p - w + 1]) / 8;
      Ixx[p] = gx * gx;
      Iyy[p] = gy * gy;
      Ixy[p] = gx * gy;
    }
  gaussianBlurPlane(Ixx, w, h, 1.3);
  gaussianBlurPlane(Iyy, w, h, 1.3);
  gaussianBlurPlane(Ixy, w, h, 1.3);
  const R = new Float32Array(w * h);
  let maxR = 0;
  for (let p = 0; p < w * h; p++) {
    const a = Ixx[p], c = Iyy[p], b = Ixy[p];
    const v = (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
    R[p] = v;
    if (v > maxR) maxR = v;
  }
  const thr = Math.max(o.minResponse, o.quality * maxR);
  const border = PATCH + 3;
  const out: Cand[] = [];
  const nr = Math.max(1, Math.round(o.nmsRadius / (level ? 2 : 1)));
  const sc = 1 << level;
  for (let y = border; y < h - border; y++)
    for (let x = border; x < w - border; x++) {
      const p = y * w + x;
      const v = R[p];
      if (v < thr) continue;
      let isMax = true;
      for (let dy = -nr; dy <= nr && isMax; dy++)
        for (let dx = -nr; dx <= nr; dx++) {
          if (!dx && !dy) continue;
          const q = R[p + dy * w + dx];
          if (q > v || (q === v && (dy < 0 || (dy === 0 && dx < 0)))) {
            isMax = false;
            break;
          }
        }
      if (!isMax) continue;
      // sub-pixel: quadratic fit in x and y separately
      const l = R[p - 1], r = R[p + 1], u = R[p - w], d = R[p + w];
      const ddx = l - 2 * v + r, ddy = u - 2 * v + d;
      const ox = ddx < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / ddx)) : 0;
      const oy = ddy < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (u - d)) / ddy)) : 0;
      const fx = (x + ox + 0.5) * sc, fy = (y + oy + 0.5) * sc;
      if (excl) {
        const ix = Math.min(fullW - 1, Math.floor(fx)), iy = Math.floor(fy);
        if (excl[iy * fullW + ix]) continue;
      }
      out.push({ x: fx, y: fy, r: v, level });
    }
  return out;
}

/** Corners + descriptors of one picture. */
export function detectFeatures(img: RGBAImage, opts: DetectOptions = {}): Features {
  const o = { maxFeatures: 2500, levels: 2, grid: [24, 14] as [number, number], quality: 0.003, minResponse: 0.5, nmsRadius: 3, maskDilatePx: 8, ...opts };
  const W = img.width, H = img.height;
  const excl = o.exclude ? dilate(o.exclude, W, H, o.maskDilatePx) : null;
  const pyr: { data: Float32Array; w: number; h: number }[] = [{ data: toGrey(img), w: W, h: H }];
  for (let l = 1; l < o.levels; l++) pyr.push(halve(pyr[l - 1].data, pyr[l - 1].w, pyr[l - 1].h));
  const smooth = pyr.map((p) => gaussianBlurPlane(Float32Array.from(p.data), p.w, p.h, 1.6));
  // candidates of every level, bucketed in full-resolution cells
  const [gx, gy] = o.grid;
  const cells: Cand[][] = Array.from({ length: gx * gy }, () => []);
  pyr.forEach((p, l) => {
    for (const c of cornersOfLevel(p.data, p.w, p.h, l, o as Required<Omit<DetectOptions, "exclude">>, excl, W)) {
      const ci = Math.min(gx - 1, Math.floor((c.x / W) * gx)) + gx * Math.min(gy - 1, Math.floor((c.y / H) * gy));
      cells[ci].push(c);
    }
  });
  const perCell = Math.max(2, Math.ceil(o.maxFeatures / (gx * gy)));
  let kept: Cand[] = [];
  for (const cell of cells) {
    cell.sort((a, b) => b.r * (1 << (2 * b.level)) - a.r * (1 << (2 * a.level)));
    kept.push(...cell.slice(0, perCell));
  }
  if (kept.length > o.maxFeatures) {
    kept.sort((a, b) => b.r - a.r);
    kept = kept.slice(0, o.maxFeatures);
  }
  const n = kept.length;
  const f: Features = { x: new Float32Array(n), y: new Float32Array(n), level: new Uint8Array(n), angle: new Float32Array(n), desc: new Uint32Array(n * 8), count: n };
  kept.forEach((c, k) => {
    const sc = 1 << c.level;
    const lw = pyr[c.level].w, lh = pyr[c.level].h;
    const S = smooth[c.level];
    const cx = c.x / sc - 0.5, cy = c.y / sc - 0.5; // level pixel coordinates (centre at integer)
    // orientation: intensity centroid of a disc
    let m10 = 0, m01 = 0;
    const ix = Math.round(cx), iy = Math.round(cy);
    for (let dy = -ORIENT_R; dy <= ORIENT_R; dy++)
      for (let dx = -ORIENT_R; dx <= ORIENT_R; dx++) {
        if (dx * dx + dy * dy > ORIENT_R * ORIENT_R) continue;
        const xx = Math.min(lw - 1, Math.max(0, ix + dx)), yy = Math.min(lh - 1, Math.max(0, iy + dy));
        const v = S[yy * lw + xx];
        m10 += dx * v;
        m01 += dy * v;
      }
    const ang = o.upright ? 0 : Math.atan2(m01, m10);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const sample = (px: number, py: number) => {
      const X = cx + ca * px - sa * py, Y = cy + sa * px + ca * py;
      const x0 = Math.floor(X), y0 = Math.floor(Y);
      const ax = X - x0, ay = Y - y0;
      const xa = Math.min(lw - 1, Math.max(0, x0)), xb = Math.min(lw - 1, Math.max(0, x0 + 1));
      const ya = Math.min(lh - 1, Math.max(0, y0)), yb = Math.min(lh - 1, Math.max(0, y0 + 1));
      return (S[ya * lw + xa] * (1 - ax) + S[ya * lw + xb] * ax) * (1 - ay) + (S[yb * lw + xa] * (1 - ax) + S[yb * lw + xb] * ax) * ay;
    };
    for (let b = 0; b < 256; b++) {
      const a = sample(PAIRS[b * 4], PAIRS[b * 4 + 1]), bb = sample(PAIRS[b * 4 + 2], PAIRS[b * 4 + 3]);
      if (a < bb) f.desc[k * 8 + (b >> 5)] |= 1 << (b & 31);
    }
    f.x[k] = c.x;
    f.y[k] = c.y;
    f.level[k] = c.level;
    f.angle[k] = ang;
  });
  return f;
}

const popcnt = (v: number): number => {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
};

export interface MatchOptions {
  /** Lowe ratio (best / second best distance), default 0.8. */
  ratio?: number;
  /** Largest Hamming distance accepted (of 256), default 80. */
  maxDistance?: number;
}

/** Mutual nearest neighbours passing the ratio test: pairs [indexInA, indexInB]. */
export function matchFeatures(a: Features, b: Features, opts: MatchOptions = {}): [number, number][] {
  const ratio = opts.ratio ?? 0.8, maxD = opts.maxDistance ?? 80;
  const da = a.desc, db = b.desc;
  const bestAB = new Int32Array(a.count).fill(-1), distAB = new Int32Array(a.count);
  const bestBA = new Int32Array(b.count).fill(-1), distBA = new Int32Array(b.count).fill(1 << 30);
  for (let i = 0; i < a.count; i++) {
    let b1 = 1 << 30, b2 = 1 << 30, bi = -1;
    const o = i * 8;
    const a0 = da[o], a1 = da[o + 1], a2 = da[o + 2], a3 = da[o + 3], a4 = da[o + 4], a5 = da[o + 5], a6 = da[o + 6], a7 = da[o + 7];
    for (let j = 0; j < b.count; j++) {
      const q = j * 8;
      const d =
        popcnt(a0 ^ db[q]) + popcnt(a1 ^ db[q + 1]) + popcnt(a2 ^ db[q + 2]) + popcnt(a3 ^ db[q + 3]) +
        popcnt(a4 ^ db[q + 4]) + popcnt(a5 ^ db[q + 5]) + popcnt(a6 ^ db[q + 6]) + popcnt(a7 ^ db[q + 7]); // fmt: skip
      if (d < b1) {
        b2 = b1;
        b1 = d;
        bi = j;
      } else if (d < b2) b2 = d;
      if (d < distBA[j]) {
        distBA[j] = d;
        bestBA[j] = i;
      }
    }
    if (bi >= 0 && b1 <= maxD && b1 < ratio * b2) {
      bestAB[i] = bi;
      distAB[i] = b1;
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < a.count; i++) if (bestAB[i] >= 0 && bestBA[bestAB[i]] === i) out.push([i, bestAB[i]]);
  return out;
}
