// Test renderer: one finger-shaped skin blob with a KNOWN skin tip, on several backgrounds, with blur and noise.
// Only for tests and the evaluation of vision/fingertip.ts (rendered fingers are not real fingers).
import type { RgbaImage } from "./coinDetector";

export type Background = "white" | "grey" | "dark" | "wood" | "skin" | "cluttered" | "green";
export const BACKGROUNDS: Background[] = ["white", "grey", "dark", "wood", "green", "cluttered", "skin"];
export const SKIN_TONES: Record<string, [number, number, number]> = {
  light: [236, 190, 170],
  medium: [198, 134, 100],
  dark: [112, 74, 54],
};

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FingerScene {
  size: number;
  skin: [number, number, number];
  background: Background;
  /** pixels per millimetre */
  pxPerMm: number;
  /** distal segment as drawn: DIP to the SKIN tip, mm; the landmark tip is `insideMm` before the skin tip */
  distalSkinMm: number;
  insideMm: number;
  widthMm: number;
  angleDeg: number;
  blurSigma: number;
  noise: number;
  /** a painted nail near the tip (polish colour) */
  nail?: [number, number, number] | null;
  seed: number;
}

export interface RenderedFinger {
  image: RgbaImage;
  dip: { x: number; y: number };
  /** the landmark tip (inside the finger) */
  tip: { x: number; y: number };
  /** the true skin tip */
  skinTip: { x: number; y: number };
  /** true extension of the skin tip beyond the landmark tip, px */
  trueExtensionPx: number;
  distalPx: number;
}

export function renderFinger(sc: FingerScene): RenderedFinger {
  const n = sc.size;
  const rand = rng(sc.seed);
  const a = (sc.angleDeg * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const c = n / 2;
  const sk = sc.pxPerMm * sc.distalSkinMm;
  const dip = { x: c - ux * sk * 0.5 - ux * 0, y: c - uy * sk * 0.5 };
  const skinTip = { x: dip.x + ux * sk, y: dip.y + uy * sk };
  const tip = { x: dip.x + ux * (sk - sc.insideMm * sc.pxPerMm), y: dip.y + uy * (sk - sc.insideMm * sc.pxPerMm) };
  const r = (sc.widthMm * sc.pxPerMm) / 2;
  const base = { x: dip.x - ux * sk * 1.2, y: dip.y - uy * sk * 1.2 }; // the finger continues well past the DIP
  const capCentre = { x: skinTip.x - ux * r, y: skinTip.y - uy * r };

  // background parameters
  const clutter: { x0: number; y0: number; x1: number; y1: number; col: [number, number, number] }[] = [];
  for (let i = 0; i < 14; i++) {
    const x0 = rand() * n;
    const y0 = rand() * n;
    clutter.push({ x0, y0, x1: x0 + 10 + rand() * 50, y1: y0 + 6 + rand() * 40, col: [rand() * 255, rand() * 255, rand() * 255] });
  }
  const bgAt = (x: number, y: number): [number, number, number] => {
    switch (sc.background) {
      case "white":
        return [238, 238, 236];
      case "grey":
        return [128, 128, 130];
      case "dark":
        return [28, 30, 34];
      case "green":
        return [60, 130, 70];
      case "wood": {
        const k = 0.5 + 0.5 * Math.sin(y * 0.35 + Math.sin(x * 0.05) * 2);
        return [150 + 30 * k, 100 + 22 * k, 58 + 14 * k];
      }
      case "skin":
        return [sc.skin[0] - 4, sc.skin[1] - 3, sc.skin[2] - 3];
      case "cluttered": {
        for (const r2 of clutter) if (x >= r2.x0 && x <= r2.x1 && y >= r2.y0 && y <= r2.y1) return r2.col;
        return [170 + 40 * Math.sin(x * 0.2), 160, 150 + 40 * Math.cos(y * 0.2)];
      }
    }
  };
  const nailCentre = { x: skinTip.x - ux * r * 1.1, y: skinTip.y - uy * r * 1.1 };

  const colorAt = (x: number, y: number): [number, number, number] => {
    // finger frame
    const s = (x - base.x) * ux + (y - base.y) * uy;
    const t = -(x - base.x) * uy + (y - base.y) * ux;
    const sCap = (capCentre.x - base.x) * ux + (capCentre.y - base.y) * uy;
    let inside = false;
    if (s >= 0 && s <= sCap) inside = Math.abs(t) <= r;
    else if (s > sCap) inside = Math.hypot(x - capCentre.x, y - capCentre.y) <= r;
    if (!inside) return bgAt(x, y);
    const edge = Math.min(1, Math.abs(t) / r);
    const shade = 1 - 0.16 * edge * edge - 0.05 * Math.max(0, (s - sCap) / r);
    let col: [number, number, number] = [sc.skin[0] * shade, sc.skin[1] * shade, sc.skin[2] * shade];
    if (sc.nail && Math.hypot((x - nailCentre.x) / (r * 0.55), (y - nailCentre.y) / (r * 0.8)) <= 1) col = sc.nail;
    return col;
  };

  const SS = 3;
  const buf = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let r0 = 0;
      let g0 = 0;
      let b0 = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const col = colorAt(x + (i + 0.5) / SS, y + (j + 0.5) / SS);
          r0 += col[0];
          g0 += col[1];
          b0 += col[2];
        }
      }
      const k = (y * n + x) * 3;
      buf[k] = r0 / (SS * SS);
      buf[k + 1] = g0 / (SS * SS);
      buf[k + 2] = b0 / (SS * SS);
    }
  }
  const blurred = sc.blurSigma > 0 ? gaussian(buf, n, sc.blurSigma) : buf;
  const data = new Uint8ClampedArray(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const noise = sc.noise ? (rand() + rand() + rand() - 1.5) * 2 * sc.noise : 0;
      data[i * 4 + ch] = Math.round(blurred[i * 3 + ch] + noise);
    }
    data[i * 4 + 3] = 255;
  }
  return { image: { data, width: n, height: n }, dip, tip, skinTip, trueExtensionPx: sc.insideMm * sc.pxPerMm, distalPx: Math.hypot(tip.x - dip.x, tip.y - dip.y) };
}

function gaussian(src: Float32Array, n: number, sigma: number): Float32Array {
  const rad = Math.ceil(sigma * 3);
  const k: number[] = [];
  let sum = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  const kk = k.map((v) => v / sum);
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let i = -rad; i <= rad; i++) acc += kk[i + rad] * src[(y * n + Math.min(n - 1, Math.max(0, x + i))) * 3 + c];
        tmp[(y * n + x) * 3 + c] = acc;
      }
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let i = -rad; i <= rad; i++) acc += kk[i + rad] * tmp[(Math.min(n - 1, Math.max(0, y + i)) * n + x) * 3 + c];
        out[(y * n + x) * 3 + c] = acc;
      }
    }
  }
  return out;
}
