// The real fingertip from the hand outline.
//
// MediaPipe's tip landmark sits inside the fingertip, so a finger chain that ends on it reads short. Here the skin
// tip is found in the picture: a skin colour model is learnt from pixels inside the finger's own distal segment
// (DIP to tip landmark), then a few parallel rays are marched outward from the landmark tip along the finger axis
// and stopped where the colour leaves the model (at the strongest colour step). The median over the rays is the
// extension beyond the landmark. When there is no clear boundary (a skin-coloured or cluttered background, nail
// polish, low contrast, blur, rays that disagree) the answer is "landmark": the model's tip is kept, with a reason.
//
// Pure typed-array code (no DOM, no OpenCV): it runs in the coin worker (vision/coinWorker.ts) off the page's main
// thread, on small crops around the fingertips, and the same functions run under Node in the tests. UNVALIDATED:
// its numbers come from rendered fingers and two real photos without ground truth (docs/FINGER_ACCURACY_AUDIT.md).
import type { RgbaImage } from "./coinDetector";

export interface Pt {
  x: number;
  y: number;
}

export interface TipEstimate {
  /** True: a clear outline boundary was found. False: keep the landmark tip (see reason). */
  ok: boolean;
  /** Distance of the skin tip beyond the landmark tip, along the finger axis, crop pixels (0 when not ok). */
  extensionPx: number;
  /** extensionPx / distal segment length (scale free; what is applied to every frame of the view). */
  ratio: number;
  reason?: TipReason;
  rays: number;
}

export type TipReason =
  | "ok"
  | "segment_too_short"
  | "skin_model_unclear"
  | "no_boundary"
  | "boundary_before_landmark"
  | "rays_disagree"
  | "outside_crop";

/** Tunables. The values were set on the rendered test fingers of fingertip.eval.test.ts (in-sample): ASSUMED. */
export const TIP_PARAMS = {
  /** Skin model sampled from this part of the distal segment (fractions of its length from the DIP) ... */
  modelFrom: 0.1,
  modelTo: 0.72,
  /** ... within this lateral distance of the axis (fraction of the segment length; a finger is ~0.75 L wide). */
  modelHalfWidth: 0.16,
  /** Ray offsets across the finger (fractions of the segment length; inside the ~0.37 L half width). */
  rayOffsets: [-0.15, -0.075, 0, 0.075, 0.15],
  /** Rays start this far in front of the DIP (fraction of the segment), inside the finger. */
  rayStart: 0.45,
  /** Colour tolerance floors (Lab units): below these a very uniform finger would flag every texture as a boundary. */
  sigmaFloorL: 7,
  sigmaFloorAB: 3,
  /** Weight of lightness against colour in the distance (shading changes along a finger). */
  lightnessWeight: 0.35,
  /** Distance (in model sigmas) beyond which a pixel is "not skin". */
  threshold: 4,
  /** Samples (0.5 px apart) in a row beyond the threshold that confirm an exit. */
  run: 5,
  /** At least this many rays must agree, within this spread (fraction of the segment length, MAD). */
  minRays: 3,
  maxSpread: 0.09,
  /** A skin model whose own colour spread is above this (Lab, a/b) is not one skin colour (polish, ring, clutter). */
  maxModelSigmaAB: 7,
  /** Gradient search half-window around the exit, px. */
  edgeWindow: 3,
};

const LIN = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function labOf(r: number, g: number, b: number, out: Float32Array, o: number): void {
  const lr = LIN[r];
  const lg = LIN[g];
  const lb = LIN[b];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

/** The crop in CIE Lab (3 floats per pixel), lightly blurred (3x3 box) against sensor noise. */
export function toLab(img: RgbaImage): Float32Array {
  const { data, width: w, height: h } = img;
  const raw = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) labOf(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], raw, i * 3);
  const tmp = new Float32Array(raw.length);
  const out = new Float32Array(raw.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(w - 1, x + 1);
      for (let c = 0; c < 3; c++) tmp[(y * w + x) * 3 + c] = (raw[(y * w + x0) * 3 + c] + raw[(y * w + x) * 3 + c] + raw[(y * w + x1) * 3 + c]) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = (tmp[(y0 * w + x) * 3 + c] + tmp[(y * w + x) * 3 + c] + tmp[(y1 * w + x) * 3 + c]) / 3;
  }
  return out;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function mad(v: number[], med: number): number {
  return 1.4826 * median(v.map((x) => Math.abs(x - med)));
}

function sampleLab(lab: Float32Array, w: number, h: number, x: number, y: number, out: number[]): boolean {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return false;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  for (let c = 0; c < 3; c++) {
    const a = lab[(y0 * w + x0) * 3 + c] * (1 - fx) + lab[(y0 * w + x1) * 3 + c] * fx;
    const b = lab[(y1 * w + x0) * 3 + c] * (1 - fx) + lab[(y1 * w + x1) * 3 + c] * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
  return true;
}

const fail = (reason: TipReason, rays = 0): TipEstimate => ({ ok: false, extensionPx: 0, ratio: 0, reason, rays });

/**
 * Where the skin ends beyond the landmark tip, for one finger.
 * @param img    a crop of the camera picture around the fingertip (RGBA)
 * @param dip    the DIP landmark (thumb: IP) in crop pixels
 * @param tip    the tip landmark in crop pixels
 * @param maxExtFrac the largest believable extension, as a fraction of the distal segment (config)
 */
export function measureTip(img: RgbaImage, dip: Pt, tip: Pt, maxExtFrac: number, lab: Float32Array = toLab(img)): TipEstimate {
  const P = TIP_PARAMS;
  const { width: w, height: h } = img;
  const dx = tip.x - dip.x;
  const dy = tip.y - dip.y;
  const L = Math.hypot(dx, dy);
  if (!(L >= 12)) return fail("segment_too_short");
  const ux = dx / L;
  const uy = dy / L;
  const nx = -uy;
  const ny = ux;
  const at = (s: number, t: number): Pt => ({ x: dip.x + ux * s + nx * t, y: dip.y + uy * s + ny * t });

  // 1. The skin colour of this finger, from inside its own distal segment (median and MAD, per channel).
  const ch: [number[], number[], number[]] = [[], [], []];
  const px = [0, 0, 0];
  for (let s = P.modelFrom * L; s <= P.modelTo * L; s += 1) {
    for (let t = -P.modelHalfWidth * L; t <= P.modelHalfWidth * L; t += 1) {
      const p = at(s, t);
      if (!sampleLab(lab, w, h, p.x, p.y, px)) return fail("outside_crop");
      ch[0].push(px[0]);
      ch[1].push(px[1]);
      ch[2].push(px[2]);
    }
  }
  const mean = ch.map((v) => median(v));
  const sigma = ch.map((v, c) => Math.max(mad(v, mean[c]), c === 0 ? P.sigmaFloorL : P.sigmaFloorAB));
  if (sigma[1] > P.maxModelSigmaAB || sigma[2] > P.maxModelSigmaAB) return fail("skin_model_unclear");
  const dist = (p: Pt): number => {
    if (!sampleLab(lab, w, h, p.x, p.y, px)) return NaN;
    const dl = ((px[0] - mean[0]) / sigma[0]) * Math.sqrt(P.lightnessWeight);
    const da = (px[1] - mean[1]) / sigma[1];
    const db = (px[2] - mean[2]) / sigma[2];
    return Math.sqrt(dl * dl + da * da + db * db);
  };

  // 2. Rays outward along the axis; the boundary is the strongest colour step where the colour leaves the model.
  const sTip = L;
  const sEnd = sTip + maxExtFrac * L + P.run * 0.5 + P.edgeWindow + 2;
  const found: number[] = [];
  let outside = false;
  for (const off of P.rayOffsets) {
    const t = off * L;
    const prof: number[] = [];
    const ss: number[] = [];
    for (let s = P.rayStart * L; s <= sEnd; s += 0.5) {
      const d = dist(at(s, t));
      if (Number.isNaN(d)) {
        outside = true;
        break;
      }
      prof.push(d);
      ss.push(s);
    }
    // first exit: `run` samples in a row beyond the threshold
    let exit = -1;
    for (let i = 0; i + P.run <= prof.length; i++) {
      let all = true;
      for (let j = 0; j < P.run; j++) {
        if (prof[i + j] <= P.threshold) {
          all = false;
          break;
        }
      }
      if (all) {
        exit = i;
        break;
      }
    }
    if (exit < 0) continue;
    // the strongest step of the profile around the exit
    const lo = Math.max(1, exit - Math.round(P.edgeWindow / 0.5));
    const hi = Math.min(prof.length - 2, exit + Math.round(P.edgeWindow / 0.5));
    let best = exit;
    let bestG = -Infinity;
    for (let i = lo; i <= hi; i++) {
      const g = prof[i + 1] - prof[i - 1];
      if (g > bestG) {
        bestG = g;
        best = i;
      }
    }
    found.push(ss[best] - sTip);
  }
  if (found.length < P.minRays) return fail(outside && found.length === 0 ? "outside_crop" : "no_boundary", found.length);

  const ext = median(found);
  if (mad(found, ext) > P.maxSpread * L) return fail("rays_disagree", found.length);
  if (ext < 0) return fail("boundary_before_landmark", found.length);
  if (ext > maxExtFrac * L) return fail("no_boundary", found.length);
  return { ok: true, extensionPx: ext, ratio: ext / L, reason: "ok", rays: found.length };
}

/** A cheap sharpness score (mean gradient magnitude of the luma) for choosing the sharpest frames. */
export function sharpness(img: RgbaImage): number {
  const { data, width: w, height: h } = img;
  if (w < 3 || h < 3) return 0;
  const luma = (i: number) => 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  let sum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = luma(y * w + x + 1) - luma(y * w + x - 1);
      const gy = luma((y + 1) * w + x) - luma((y - 1) * w + x);
      sum += Math.abs(gx) + Math.abs(gy);
      n++;
    }
  }
  return n ? sum / n : 0;
}

export interface FingerTipResult {
  ok: boolean;
  /** Extension as a fraction of the distal segment (applied to every frame of the view). */
  ratio: number;
  /** How many of the measured frames found a boundary, and how many were measured. */
  found: number;
  of: number;
  reason: TipReason | "too_few_frames" | "frames_disagree";
}

/** Several frames' measurements of one finger -> one extension (median), or the landmark tip with a reason.
 *  Needs at least two frames with a boundary and at least half of the measured frames, within `maxSpread`. */
export function combineTipResults(results: TipEstimate[], maxSpread = 0.12): FingerTipResult {
  const good = results.filter((r) => r.ok);
  const of = results.length;
  if (good.length < 2 || good.length * 2 < of) {
    const reasons = results.filter((r) => !r.ok && r.reason).map((r) => r.reason as TipReason);
    const top = [...new Set(reasons)].sort((a, b) => reasons.filter((r) => r === b).length - reasons.filter((r) => r === a).length)[0];
    return { ok: false, ratio: 0, found: good.length, of, reason: good.length < 2 && of < 2 ? "too_few_frames" : top ?? "no_boundary" };
  }
  const ratios = good.map((r) => r.ratio);
  const med = median(ratios);
  if (mad(ratios, med) > maxSpread) return { ok: false, ratio: 0, found: good.length, of, reason: "frames_disagree" };
  return { ok: true, ratio: med, found: good.length, of, reason: "ok" };
}
