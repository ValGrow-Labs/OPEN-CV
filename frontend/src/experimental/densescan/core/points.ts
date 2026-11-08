// Spacing, generation, validation and filtering of the dense surface points.
import type { BinaryMask, ImageScale, Quantity } from "../../common";
import { edgeDistance, insideMask, maskIndex } from "./edt";
import {
  DEFAULT_DOT_CONFIG,
  DEFAULT_VALIDATE,
  DUPLICATE_SHARE,
  ISOLATED_MIN_NEIGHBOURS,
  type DotConfig,
  type ImageRGBA,
  type SurfacePoint,
  type ValidateOptions,
} from "./types";

/** The step actually used, and what it means. A millimetre target is converted with the coin scale (valid at the coin's
 *  plane only) and never goes below one source pixel: a finer lattice would only interpolate the same pixels, so it would
 *  add points, not information. The step is an image SAMPLING interval, not a measurement accuracy. */
export function resolveSpacing(
  cfg: DotConfig,
  scale: ImageScale | null,
): { spacingPx: number; spacingMm: Quantity; limitedByResolution: boolean; note: string } {
  const mmPerPx = scale && scale.mmPerPx > 0 ? scale.mmPerPx : null;
  let requestedPx = cfg.spacingPx;
  let note = "";
  if (cfg.targetSpacingMm != null && cfg.targetSpacingMm > 0) {
    if (mmPerPx === null) {
      note = `A ${cfg.targetSpacingMm} mm target needs a coin scale, and there is none: the ${cfg.spacingPx} px step is used instead.`;
    } else {
      requestedPx = cfg.targetSpacingMm / mmPerPx;
    }
  }
  const limited = !(requestedPx >= 1);
  const spacingPx = limited ? 1 : requestedPx;
  if (limited) {
    note =
      (cfg.targetSpacingMm != null && mmPerPx !== null
        ? `A ${cfg.targetSpacingMm} mm target at ${mmPerPx.toFixed(3)} mm/px would be ${requestedPx.toFixed(2)} px; `
        : `A ${cfg.spacingPx} px step is below one pixel; `) +
      "clamped to 1 px. A finer lattice would only interpolate the same pixels: more dots, no more information, and no finer accuracy.";
  }
  const spacingMm: Quantity =
    mmPerPx === null
      ? { value: null, unit: "mm", basis: "none", note: "No coin scale: the step is known in pixels only." }
      : {
          value: spacingPx * mmPerPx,
          unit: "mm",
          basis: "model",
          note: "Coin-plane scale: exact only at the coin's plane; parts of the hand at other heights differ. A sampling step, not an accuracy.",
        };
  if (!note) note = `Step ${spacingPx.toFixed(2)} px${mmPerPx !== null ? ` (about ${(spacingPx * mmPerPx).toFixed(2)} mm at the coin's plane)` : ""}.`;
  return { spacingPx, spacingMm, limitedByResolution: limited, note };
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lattice points (plus optional seeded jitter) inside the hand mask, in source pixels, row by row from the top. Only
 *  points on hand pixels are generated, so none lands outside the hand or in a gap between fingers (gap pixels are
 *  background). Points close to the edge are kept here and rejected as `near_edge` by validation, so the counts stay honest. */
export function generateSurfacePoints(mask: BinaryMask, scaleToSource: number, cfg: DotConfig = DEFAULT_DOT_CONFIG): SurfacePoint[] {
  const s = scaleToSource > 0 ? scaleToSource : 1;
  const step = Math.max(1, cfg.spacingPx);
  const jitter = Math.max(0, Math.min(0.45, cfg.jitter)) * step;
  const edt = edgeDistance(mask);
  const srcW = mask.width * s;
  const srcH = mask.height * s;
  const rand = rng(cfg.seed);
  const out: SurfacePoint[] = [];
  // bounding box of the mask (rows/columns with any hand pixel), to skip empty lattice rows quickly
  let minX = mask.width,
    minY = mask.height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[y * mask.width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return out;
  const gx0 = Math.max(0, Math.floor((minX * s) / step));
  const gx1 = Math.min(Math.floor(srcW / step), Math.ceil(((maxX + 1) * s) / step));
  const gy0 = Math.max(0, Math.floor((minY * s) / step));
  const gy1 = Math.min(Math.floor(srcH / step), Math.ceil(((maxY + 1) * s) / step));
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      // jitter is drawn for every lattice node (inside or not), so the same seed always gives the same pattern
      const jx = jitter ? (rand() - 0.5) * 2 * jitter : 0;
      const jy = jitter ? (rand() - 0.5) * 2 * jitter : 0;
      const x = (gx + 0.5) * step + jx;
      const y = (gy + 0.5) * step + jy;
      const i = maskIndex(mask, s, x, y);
      if (i < 0 || !mask.data[i]) continue;
      out.push({
        id: out.length,
        x,
        y,
        gx,
        gy,
        region: "unknown",
        edgeDistPx: edt[i] * s,
        quality: 1,
        accepted: true,
        reject: null,
        depth: "none",
        z: null,
      });
    }
  }
  return out;
}

function luma(img: ImageRGBA, x: number, y: number): number {
  const xi = Math.min(img.width - 1, Math.max(0, x));
  const yi = Math.min(img.height - 1, Math.max(0, y));
  const k = (yi * img.width + xi) * 4;
  return 0.299 * img.data[k] + 0.587 * img.data[k + 1] + 0.114 * img.data[k + 2];
}

interface Local {
  sharp: number;
  over: number;
  under: number;
}

function localStats(img: ImageRGBA, cx: number, cy: number, r: number, o: ValidateOptions): Local {
  let lap = 0,
    n = 0,
    over = 0,
    under = 0;
  const x0 = Math.round(cx),
    y0 = Math.round(cy);
  for (let y = y0 - r; y <= y0 + r; y++) {
    for (let x = x0 - r; x <= x0 + r; x++) {
      const c = luma(img, x, y);
      const l = 4 * c - luma(img, x - 1, y) - luma(img, x + 1, y) - luma(img, x, y - 1) - luma(img, x, y + 1);
      lap += Math.abs(l);
      if (c >= o.overLuma) over++;
      if (c <= o.underLuma) under++;
      n++;
    }
  }
  return { sharp: lap / n, over: over / n, under: under / n };
}

/** Real, measurable checks on every point (nothing cosmetic): still inside the given mask, far enough from its edge,
 *  locally sharp relative to the hand's own median (and above an absolute floor), and not clipped. Sets `accepted`,
 *  `reject` (first failing reason) and `quality` (0..1). `image` is the source frame. */
export function validatePoints(
  points: SurfacePoint[],
  image: ImageRGBA,
  mask: BinaryMask,
  scaleToSource: number,
  opts: Partial<ValidateOptions> = {},
): SurfacePoint[] {
  const o: ValidateOptions = { ...DEFAULT_VALIDATE, ...opts };
  const stats = points.map((p) => localStats(image, p.x, p.y, o.windowRadius, o));
  const sharps = stats.map((s) => s.sharp).sort((a, b) => a - b);
  const median = sharps.length ? sharps[Math.floor(sharps.length / 2)] : 0;
  const blurFloor = Math.max(o.blurAbsMin, o.blurRel * median);
  return points.map((p, k) => {
    const st = stats[k];
    let reject: SurfacePoint["reject"] = null;
    if (!insideMask(mask, scaleToSource, p.x, p.y)) reject = "outside_mask";
    else if (p.edgeDistPx < o.edgeMarginPx) reject = "near_edge";
    else if (st.over >= o.clipShare) reject = "overexposed";
    else if (st.under >= o.clipShare) reject = "underexposed";
    else if (st.sharp < blurFloor) reject = "blurred";
    const edgeQ = Math.min(1, p.edgeDistPx / Math.max(1e-6, 2 * o.edgeMarginPx));
    const sharpQ = median > 0 ? Math.min(1, st.sharp / median) : 0;
    const expoQ = Math.max(0, 1 - (st.over + st.under) / Math.max(1e-6, o.clipShare));
    const quality = Math.max(0, Math.min(1, edgeQ * sharpQ * expoQ));
    return { ...p, accepted: reject === null, reject, quality };
  });
}

/** Duplicates (same lattice node, or closer than DUPLICATE_SHARE of the step) and isolated points (fewer than
 *  ISOLATED_MIN_NEIGHBOURS accepted 8-neighbours on the lattice) are marked rejected with their reason. Nothing is
 *  deleted: rejected points stay in the list so the counts can be checked. */
export function dedupeAndFilter(points: SurfacePoint[], cfg: DotConfig = DEFAULT_DOT_CONFIG): SurfacePoint[] {
  const step = Math.max(1, cfg.spacingPx);
  const minD2 = (DUPLICATE_SHARE * step) ** 2;
  const out = points.map((p) => ({ ...p }));
  const byNode = new Map<string, SurfacePoint>();
  const cell = (v: number) => Math.floor(v / step);
  const grid = new Map<string, SurfacePoint[]>();
  for (const p of out) {
    if (!p.accepted) continue;
    const node = `${p.gx},${p.gy}`;
    let dup = byNode.has(node);
    if (!dup) {
      const cx = cell(p.x),
        cy = cell(p.y);
      for (let dy = -1; dy <= 1 && !dup; dy++) {
        for (let dx = -1; dx <= 1 && !dup; dx++) {
          for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 < minD2) {
              dup = true;
              break;
            }
          }
        }
      }
    }
    if (dup) {
      p.accepted = false;
      p.reject = "duplicate";
      continue;
    }
    byNode.set(node, p);
    const key = `${cell(p.x)},${cell(p.y)}`;
    const list = grid.get(key);
    if (list) list.push(p);
    else grid.set(key, [p]);
  }
  // isolated: count accepted lattice neighbours (decided on the set before any isolated point is removed)
  const neighbours = new Map<SurfacePoint, number>();
  for (const p of out) {
    if (!p.accepted) continue;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && byNode.get(`${p.gx + dx},${p.gy + dy}`)?.accepted) n++;
    neighbours.set(p, n);
  }
  for (const [p, n] of neighbours) {
    if (n < ISOLATED_MIN_NEIGHBOURS) {
      p.accepted = false;
      p.reject = "isolated";
    }
  }
  return out;
}
