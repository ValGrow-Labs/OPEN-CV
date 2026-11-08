// Procedural, seeded table textures for the SIMULATED board-free structure-from-motion study (sfm/).
//
// A texture maps a table point (x, y in millimetres, table plane z = 0) to a LINEAR albedo (r, g, b in 0..1). The
// `footprintMm` argument is the size of the area one sample stands for (from the renderer's ray differentials): octaves
// of detail finer than it are faded out instead of aliased, as a camera's pixel and lens would integrate them.
//
// These are test patterns. Real wood, cloth and newsprint have gloss, fibres, print dot screens and folds; none of that
// is modelled. Every number obtained with them is SIMULATED.

export type Albedo = [number, number, number];
export type TextureKind = "speckle" | "wood" | "fabric" | "newspaper" | "weak" | "plain";
export const TEXTURED_KINDS: readonly TextureKind[] = ["speckle", "wood", "fabric", "newspaper"];

export interface TableTexture {
  kind: TextureKind;
  albedo: (x: number, y: number, footprintMm: number) => Albedo;
}

/** Integer hash -> [0, 1). */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) on a unit lattice. */
export function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fade weight of a detail of frequency `freq` (cycles/mm) for a sample footprint (mm): 1 well below Nyquist, 0 above. */
function band(freq: number, footprintMm: number): number {
  const q = freq * footprintMm; // cycles per sample
  if (q <= 0.25) return 1;
  if (q >= 0.5) return 0;
  return (0.5 - q) / 0.25;
}

/** Fractal noise, zero mean, roughly in [-0.5, 0.5]; octaves above the footprint's Nyquist limit are faded out. */
export function fbm(x: number, y: number, seed: number, baseFreq: number, octaves: number, footprintMm: number, gain = 0.55): number {
  let s = 0, amp = 1, f = baseFreq, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const w = band(f, footprintMm);
    if (w > 0) s += w * amp * (valueNoise(x * f + o * 17.3, y * f - o * 9.1, seed + o * 101) - 0.5);
    norm += amp;
    amp *= gain;
    f *= 2.03;
  }
  return s / norm * 1.6;
}

const clamp01 = (v: number) => (v < 0.01 ? 0.01 : v > 0.95 ? 0.95 : v);
const mix = (a: Albedo, b: Albedo, t: number): Albedo => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (e0: number, e1: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Granite / speckled laminate: blobs at several scales (the best case for features). */
function speckle(seed: number): TableTexture["albedo"] {
  const light: Albedo = [0.62, 0.6, 0.56], dark: Albedo = [0.07, 0.07, 0.08], mid: Albedo = [0.32, 0.27, 0.22];
  return (x, y, fp) => {
    const n1 = fbm(x, y, seed, 1 / 9, 5, fp);
    const n2 = fbm(x, y, seed + 7, 1 / 2.5, 3, fp);
    let a = mix(light, mid, smooth(-0.05, 0.15, n1));
    a = mix(a, dark, smooth(0.12, 0.3, n2) * band(1 / 2.5, fp) + smooth(0.28, 0.4, n1) * 0.7);
    return [clamp01(a[0]), clamp01(a[1]), clamp01(a[2])];
  };
}

/** Wood grain: bent bands along +x with fine fibre noise and a few knots. */
function wood(seed: number): TableTexture["albedo"] {
  const base: Albedo = [0.42, 0.24, 0.12], lateWood: Albedo = [0.2, 0.1, 0.05];
  return (x, y, fp) => {
    const warp = 9 * fbm(x, y, seed, 1 / 120, 3, fp);
    const yy = y + warp + 3 * Math.sin(x / 70 + valueNoise(x / 200, y / 200, seed + 3) * 4);
    // annual rings: ~5 mm apart with random widths
    const ring = yy / 5 + 2 * valueNoise(yy / 23, 0.5, seed + 11);
    const r = ring - Math.floor(ring);
    const w = band(1 / 5, fp);
    let t = (smooth(0.55, 0.75, r) - smooth(0.8, 0.98, r)) * w;
    t += 0.5 * fbm(x * 0.15, y * 3, seed + 5, 1 / 3, 4, fp); // fibres: stretched along x
    // knots
    const kx = Math.floor(x / 90), ky = Math.floor(y / 60);
    const ox = (kx + 0.2 + 0.6 * hash2(kx, ky, seed + 9)) * 90, oy = (ky + 0.2 + 0.6 * hash2(ky, kx, seed + 13)) * 60;
    const dk = Math.hypot((x - ox) / 1.6, y - oy);
    if (hash2(kx, ky, seed + 21) < 0.35) t += Math.max(0, 1 - dk / 7) * 1.2 + 0.4 * Math.max(0, Math.sin(dk * 1.2)) * Math.max(0, 1 - dk / 18) * band(0.2, fp);
    const a = mix(base, lateWood, Math.max(0, Math.min(1, t)));
    return [clamp01(a[0]), clamp01(a[1]), clamp01(a[2])];
  };
}

/** Woven cloth with a plaid: thread-scale weave plus irregular stripes repeating every 48 mm (a repetitive pattern). */
function fabric(seed: number): TableTexture["albedo"] {
  const stripes = (u: number) => {
    const p = ((u % 48) + 48) % 48;
    return p < 6 ? 0.9 : p < 9 ? 0.2 : p < 21 ? 0.55 : p < 23 ? 0.05 : p < 36 ? 0.7 : 0.35;
  };
  const c1: Albedo = [0.55, 0.08, 0.08], c2: Albedo = [0.05, 0.1, 0.3], c3: Albedo = [0.75, 0.7, 0.55];
  return (x, y, fp) => {
    const sx = stripes(x), sy = stripes(y + 13);
    const weave = band(1 / 1.4, fp) * 0.25 * Math.sin((2 * Math.PI * x) / 1.4) * Math.sin((2 * Math.PI * y) / 1.4);
    const slub = 0.15 * fbm(x, y, seed, 1 / 6, 4, fp);
    let a = mix(c1, c2, sx);
    a = mix(a, c3, 0.5 * sy);
    const k = 1 + weave + slub;
    return [clamp01(a[0] * k), clamp01(a[1] * k), clamp01(a[2] * k)];
  };
}

/** Newsprint: columns of text lines (word blocks), headlines and half-tone photos. */
function newspaper(seed: number): TableTexture["albedo"] {
  const paper: Albedo = [0.72, 0.7, 0.64], ink: Albedo = [0.06, 0.06, 0.07];
  const colW = 48, gutter = 4, lineH = 3.2, xh = 1.9;
  return (x, y, fp) => {
    const col = Math.floor(x / colW);
    const cx = x - col * colW;
    if (cx > colW - gutter) return paper;
    // blocks down a column: text, headline or photo (each 40 mm tall)
    const blk = Math.floor(y / 40);
    const kind = hash2(col, blk, seed);
    const by = y - blk * 40;
    if (kind < 0.12) {
      // photo: smooth grey-scale picture
      if (by < 2 || by > 38) return paper;
      const g = 0.5 + 1.4 * fbm(x, y, seed + 31 + blk, 1 / 14, 4, fp);
      return mix(ink, paper, Math.max(0, Math.min(1, g)));
    }
    const big = kind < 0.24;
    const lh = big ? 9 : lineH, h = big ? 6 : xh;
    const line = Math.floor(by / lh);
    const ly = by - line * lh;
    if (ly > h) return paper;
    // words: random lengths along the line
    const wordRow = hash2(col * 977 + blk, line, seed + 3);
    let pos = cx, wi = 0, start = 0;
    const scale = big ? 3.2 : 1;
    // walk the words (at most ~14 per line)
    while (wi < 30) {
      const len = (3 + 9 * hash2(wi, Math.floor(wordRow * 1e6), seed + 5)) * scale;
      const space = 1.4 * scale;
      if (pos < start + len) break;
      start += len + space;
      if (pos < start) return paper; // in the space
      wi++;
    }
    pos -= start;
    // letters: vertical-ish strokes with gaps, faded to grey when below the footprint
    const letterW = (big ? 3.4 : 1.15);
    const lp = pos / letterW - Math.floor(pos / letterW);
    const glyph = hash2(Math.floor(pos / letterW), line * 31 + wi, seed + 7);
    const stroke = (lp < 0.22 || (glyph > 0.5 && lp > 0.55 && lp < 0.75) || (ly < h * 0.25 && glyph > 0.3)) ? 1 : 0;
    const wDetail = band(1 / letterW, fp);
    const cover = wDetail * stroke + (1 - wDetail) * 0.42;
    return mix(paper, ink, cover);
  };
}

/** A smooth, nearly uniform surface (matte table): +-4 % mottling of a light grey. */
function weak(seed: number): TableTexture["albedo"] {
  return (x, y, fp) => {
    const n = 0.04 * fbm(x, y, seed, 1 / 25, 5, fp) * 2;
    const v = 0.6 * (1 + n);
    return [v, v * 0.98, v * 0.95];
  };
}

const plain: TableTexture["albedo"] = () => [0.8, 0.8, 0.79];

export function makeTexture(kind: TextureKind, seed = 1): TableTexture {
  const albedo = kind === "speckle" ? speckle(seed) : kind === "wood" ? wood(seed) : kind === "fabric" ? fabric(seed) : kind === "newspaper" ? newspaper(seed) : kind === "weak" ? weak(seed) : plain;
  return { kind, albedo };
}
