// A minimal, LICENCE-CLEAN parametric prior: our own capsule-hand model (synthetic.ts), fitted to the outline of the
// carved hull and used to TRIM volume the views cannot confirm.
//
// What it is for: where the observations are incomplete (two opposite views give no thickness at all; from the side the
// thumb and palm overlap and leave phantom volume), a prior can bound the error. What it is NOT: a hand model of a
// real person. It carries a population-like default for what is not observed (the palm thickness), so any figure that
// comes from the prior rather than the data reflects that default, not the customer. The prior only ever removes
// volume from the hull (hull AND model-dilated-by-a-margin); it never adds surface the silhouettes ruled out.
//
// NOT used here: MANO and other learned or statistical hand models. Their licences restrict commercial use and are
// being reviewed separately; using one would also need a fitting method (landmarks or a network) and training or
// licensing decisions that are out of scope for this experiment. This module is the licence-free stand-in, and it needs
// the hull to be in a known hand frame (here the synthetic one); real captures would first need that alignment (from
// landmarks).
import type { Occupancy } from "./carving";
import { DEFAULT_HAND_PARAMS, makeCapsuleHand, type CapsuleHandParams } from "./synthetic";
import { FINGER_NAMES, type FingerName } from "./measure";

export interface PriorFit {
  params: CapsuleHandParams;
  /** Intersection over union of the fitted model's outline and the hull's outline in the palm plane (1 = identical). */
  outlineIoU: number;
  evaluations: number;
}

interface Scales {
  palmLength: number;
  palmBreadth: number;
  fingerLength: Record<FingerName, number>;
  radius: number;
}

const unit = (): Scales => ({ palmLength: 1, palmBreadth: 1, fingerLength: { thumb: 1, index: 1, middle: 1, ring: 1, little: 1 }, radius: 1 });

function scaled(base: CapsuleHandParams, s: Scales): CapsuleHandParams {
  const p: CapsuleHandParams = JSON.parse(JSON.stringify(base));
  p.palmLength = base.palmLength * s.palmLength;
  p.palmBreadth = base.palmBreadth * s.palmBreadth;
  for (const name of FINGER_NAMES) {
    if (name === "thumb") {
      p.thumb.length = base.thumb.length * s.fingerLength.thumb;
      p.thumb.radius = base.thumb.radius * s.radius;
      p.thumb.baseX = base.thumb.baseX * s.palmBreadth;
      p.thumb.baseY = base.thumb.baseY * s.palmLength;
    } else {
      p.fingers[name].length = base.fingers[name].length * s.fingerLength[name];
      p.fingers[name].radius = base.fingers[name].radius * s.radius;
      p.fingers[name].baseX = base.fingers[name].baseX * s.palmBreadth;
    }
  }
  return p;
}

/** The hull's outline along z (a pixel is "hand" if any voxel in its column is occupied), on a grid of ``stepMm``. */
function hullOutline(hull: Occupancy, stepMm: number): { w: number; h: number; x0: number; y0: number; data: Uint8Array } {
  const [nx, ny, nz] = hull.dims;
  const w = Math.floor((nx * hull.voxelMm) / stepMm);
  const h = Math.floor((ny * hull.voxelMm) / stepMm);
  const col = new Uint8Array(nx * ny);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) if (hull.occupancy[i + nx * (j + ny * k)]) col[i + nx * j] = 1;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = Math.min(nx - 1, Math.floor(((x + 0.5) * stepMm) / hull.voxelMm));
      const j = Math.min(ny - 1, Math.floor(((y + 0.5) * stepMm) / hull.voxelMm));
      data[y * w + x] = col[i + nx * j];
    }
  return { w, h, x0: hull.origin[0], y0: hull.origin[1], data };
}

// Spaced by 8 mm, less than the diameter of the thinnest capsule, so every capsule's outline is hit by some sample.
const Z_SAMPLES = [-10, -2, 6, 14, 22];

function modelOutlineIoU(params: CapsuleHandParams, target: ReturnType<typeof hullOutline>, stepMm: number): number {
  const sdf = makeCapsuleHand(params).sdf;
  let inter = 0, uni = 0;
  for (let y = 0; y < target.h; y++)
    for (let x = 0; x < target.w; x++) {
      const px = target.x0 + (x + 0.5) * stepMm, py = target.y0 + (y + 0.5) * stepMm;
      let inside = false;
      for (const z of Z_SAMPLES) {
        if (sdf(px, py, z) < 0) {
          inside = true;
          break;
        }
      }
      const t = target.data[y * target.w + x] > 0;
      if (inside && t) inter++;
      if (inside || t) uni++;
    }
  return uni === 0 ? 0 : inter / uni;
}

/** Fit the scales of the capsule model (palm length and breadth, the five finger lengths, a common finger radius) to the
 *  hull's outline by coordinate descent on the outline IoU. The palm thickness is NOT fitted (it is not observed by
 *  views that look along it): it stays what ``initial`` says, or ``thicknessMm`` if given. */
export function fitCapsulePrior(hull: Occupancy, initial: CapsuleHandParams = DEFAULT_HAND_PARAMS, opts: { rounds?: number; stepMm?: number; thicknessMm?: number } = {}): PriorFit {
  const stepMm = opts.stepMm ?? 3;
  const base: CapsuleHandParams = JSON.parse(JSON.stringify(initial));
  if (opts.thicknessMm) base.palmThickness = opts.thicknessMm;
  const target = hullOutline(hull, stepMm);
  const s = unit();
  let evaluations = 0;
  const score = (sc: Scales) => {
    evaluations++;
    return modelOutlineIoU(scaled(base, sc), target, stepMm);
  };
  let best = score(s);
  const dims: { get: () => number; set: (v: number) => void }[] = [
    { get: () => s.palmLength, set: (v) => (s.palmLength = v) },
    { get: () => s.palmBreadth, set: (v) => (s.palmBreadth = v) },
    { get: () => s.radius, set: (v) => (s.radius = v) },
    ...FINGER_NAMES.map((n) => ({ get: () => s.fingerLength[n], set: (v: number) => (s.fingerLength[n] = v) })),
  ];
  let step = 0.08;
  for (let round = 0; round < (opts.rounds ?? 4); round++) {
    for (const d of dims) {
      const v0 = d.get();
      for (const sign of [1, -1]) {
        let moved = false;
        // keep going in a direction while it improves (at most a few steps), else put the value back
        for (let tries = 0; tries < 4; tries++) {
          const cur = d.get();
          const cand = cur * (1 + sign * step);
          if (cand < 0.6 || cand > 1.6) break;
          d.set(cand);
          const sc = score(s);
          if (sc > best + 1e-6) {
            best = sc;
            moved = true;
          } else {
            d.set(cur);
            break;
          }
        }
        if (moved) break;
        d.set(v0);
      }
    }
    step *= 0.5;
  }
  return { params: scaled(base, s), outlineIoU: best, evaluations };
}

/** The hull AND the model dilated by ``marginMm``: volume outside the fitted model is removed. */
export function intersectWithPrior(hull: Occupancy, params: CapsuleHandParams, marginMm = 2): Occupancy {
  const sdf = makeCapsuleHand(params).sdf;
  const [nx, ny, nz] = hull.dims;
  const occupancy = new Uint8Array(hull.occupancy.length);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const idx = i + nx * (j + ny * k);
        if (!hull.occupancy[idx]) continue;
        const x = hull.origin[0] + (i + 0.5) * hull.voxelMm, y = hull.origin[1] + (j + 0.5) * hull.voxelMm, z = hull.origin[2] + (k + 0.5) * hull.voxelMm;
        if (sdf(x, y, z) <= marginMm) occupancy[idx] = 1;
      }
  return { ...hull, occupancy };
}

/** A prior for ReconstructOptions.prior: fit the model to the hull, then trim the hull with it. ``params`` is the
 *  starting model (population-like defaults); ``fit`` false skips the fitting and trims with ``params`` as given. */
export function capsulePrior(params: CapsuleHandParams = DEFAULT_HAND_PARAMS, opts: { fit?: boolean; marginMm?: number } = {}): (hull: Occupancy) => Occupancy {
  return (hull) => {
    const p = opts.fit === false ? params : fitCapsulePrior(hull, params).params;
    return intersectWithPrior(hull, p, opts.marginMm ?? 2);
  };
}
