// Coin outline edge points for the SIMULATED sfm/ study. Test support, NOT a coin detector.
//
// The coin's outline is taken from the renderer's exact surface labels (standing in for the coin detector and its
// sub-pixel edges, coin/measureCoin.ts, which needs OpenCV.js and is another stage's work): each pair of 4-neighbouring
// pixels with one coin pixel and one non-coin pixel gives an edge point at the midpoint of their centres (a +-0.5 px
// quantisation error across the edge, unbiased), optionally with extra Gaussian noise. A view where the coin touches an
// OCCLUDER (the hand in front of a coin lying on the table) or the picture border, or shows fewer than `minPoints` edge
// points, gives none (a coin detector would reject a partly hidden coin).
import type { Pt } from "../common";
import { gaussian, makeRng } from "../reconstruction/rng";
import { SFM_SURFACE, type CleanRender } from "./scene";

export function coinEdgePoints(c: CleanRender, opts: { occluders?: readonly number[]; noisePx?: number; seed?: number; minPoints?: number; border?: number } = {}): Pt[] | null {
  const { width: w, height: h, surface } = c;
  const occ = new Set(opts.occluders ?? [SFM_SURFACE.hand]);
  const coin = SFM_SURFACE.coin;
  const border = opts.border ?? 2;
  const rng = makeRng(opts.seed ?? 1);
  const noise = opts.noisePx ?? 0;
  const out: Pt[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (surface[p] !== coin) continue;
      if (x < border || y < border || x >= w - border || y >= h - border) return null; // touches the border
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const q = (y + dy) * w + x + dx;
        const s = surface[q];
        if (occ.has(s)) return null; // partly hidden: a detector would reject the coin in this view
        if (s === coin) continue;
        const nx = noise ? noise * gaussian(rng) : 0;
        out.push({ x: x + 0.5 + dx * 0.5 + nx * (dx ? 1 : 0), y: y + 0.5 + dy * 0.5 + nx * (dy ? 1 : 0) });
      }
    }
  return out.length >= (opts.minPoints ?? 24) ? out : null;
}
