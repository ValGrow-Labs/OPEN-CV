// Print-scale check for the EXPERIMENTAL marker board: measure the coin lying on the printed coin target in BOARD
// millimetres. A sheet printed with "fit to page" is uniformly scaled (typically 94 to 97 %); markers then measure, say,
// 28.5 mm instead of 30.0 mm, every pose length is off by the same factor, and nothing in the board itself can tell.
// A coin of known physical diameter can: measured in board millimetres it reads reference / s, so the print scale is
//   s = referenceDiameterMm / measuredDiameterMm   (physical mm per board mm; 1 = printed at 100 %).
//
// Method: rectify the region around `coinTarget` onto the board plane with the view's pose (fine scale, default
// 8 px/mm); cast rays from the target centre; on each ray find the step edge (mean outside minus mean inside, a robust
// detector for the LOW contrast of a silver coin on white paper, and insensitive to the thin grey printed outline);
// take the outermost strong step (the silhouette, not the rim or the relief); sub-sample by the centroid of the step
// response; fit a circle robustly (algebraic start, geometric Gauss-Newton, outliers trimmed by MAD); re-cast the rays
// from the fitted centre and fit again.
//
// COIN THICKNESS. The coin is about 1.5 mm thick, so its top face is not on the board plane. Rectifying with the plane's
// homography projects the top edge onto z = 0 from the camera centre: a homothety about the camera's foot point with
// ratio k = Zc / (Zc - h) (Zc = camera height above the board). The top circle therefore appears k times too large and
// shifted away from the camera, and the near side wall (between the base and the top edge) is part of the silhouette:
// the outline is the convex hull of the true base circle and the enlarged, shifted top circle. A plain circle fitted to
// it over-reads the diameter by roughly h / Zc times the diameter plus a share of the shift (about 0.1 to 0.3 mm from
// straight above at 350 mm; several millimetres from a low view). With `coinThicknessMm` given, the fit uses that hull
// model (signed distance of an "uneven capsule") with the camera centre from the pose, and reports the base diameter.
// Views below `minElevationDeg` are refused: there the wall dominates and the edge is not a reliable silhouette.
//
// EXPERIMENTAL; scale errors in README.md are SIMULATED (rendered coin, ideal cylinder, no real coin relief or glare).

import type { CameraPose, Intrinsics, Pt } from "../common";
import { cameraCenter, project } from "../geometry/camera";
import { isGray, sampleBilinear, toGray, type GrayImage, type RgbaImage } from "./image";
import { BOARD, type BoardLayout } from "./spec";

export interface CoinCheckOptions {
  /** The coin's physical diameter, mm (an input: e.g. the coin chosen by the user; never assumed here). */
  referenceDiameterMm: number;
  /** The coin's physical thickness, mm. When given, the raised top face is modelled (recommended). */
  coinThicknessMm?: number;
  layout?: BoardLayout;
  /** Rectification scale, pixels per board mm (default 8). */
  pxPerMm?: number;
  /** Edge search range as multiples of the reference radius (default 0.65 to 1.45: print scales of about 0.7 to 1.5). */
  searchRange?: [number, number];
  /** Refuse views whose camera is lower than this above the board plane, seen from the coin (default 45 degrees). */
  minElevationDeg?: number;
  /** Rays cast from the centre (default 180). */
  rays?: number;
  /** Quality gates: largest RMS edge residual (default 0.25 board mm), smallest median edge step (default 4 grey
   *  levels), smallest difference between the coin's interior and the surrounding paper (default 6 grey levels; a
   *  printed ring or an empty target has none). */
  maxResidualMm?: number;
  minEdgeContrast?: number;
  minFillContrast?: number;
  /** Keep the rectified image and the edge points in the result (diagnostics). */
  keepRectified?: boolean;
}

export type CoinCheckResult =
  | {
      ok: true;
      /** The coin's diameter in board mm (thickness-corrected when `coinThicknessMm` was given). */
      diameterMm: number;
      /** A plain circle fitted to the silhouette, board mm (no thickness model). */
      circleDiameterMm: number;
      /** physical mm per board mm: referenceDiameterMm / diameterMm (1 = printed at 100 %). */
      printScale: number;
      /** RMS distance of the accepted edge points to the fitted outline, board mm. */
      residualMm: number;
      /** Coin centre (base) in board mm and its offset from the printed target centre. */
      center: { x: number; y: number };
      centerOffsetMm: number;
      edgePoints: number;
      edgePointsUsed: number;
      polarity: "darker" | "brighter";
      /** Median step response at the edge, grey levels (outside minus inside over about one image pixel). */
      edgeContrast: number;
      /** Mean grey difference between the paper around the coin and the coin's interior (signed by polarity). */
      fillContrast: number;
      elevationDeg: number;
      /** Camera height above the board, board mm. */
      cameraHeightMm: number;
      /** circleDiameterMm - diameterMm: what the raised top face adds to a plain circle fit (0 without a thickness). */
      thicknessEffectMm: number;
      rectified?: GrayImage;
      /** The second-pass edge points, board mm (with keepRectified). */
      edgePointsMm?: Pt[];
    }
  | {
      ok: false;
      reason: "view_too_oblique" | "outside_image" | "no_edge" | "fit_failed" | "poor_fit" | "low_contrast" | "not_a_disc" | "implausible_size";
      detail: string;
      elevationDeg?: number;
    };

// ------------------------------------------------------------------------------------------------ fitting

interface Circle {
  x: number;
  y: number;
  r: number;
}

/** Algebraic (Kasa) circle fit. */
export function fitCircleAlgebraic(pts: readonly Pt[]): Circle | null {
  const n = pts.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12) return null;
  const a = 0.5 * (suuu + suvv);
  const b = 0.5 * (svvv + svuu);
  const uc = (a * svv - b * suv) / det;
  const vc = (b * suu - a * suv) / det;
  return { x: uc + mx, y: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

/** Gauss-Newton on a residual function of k parameters with numeric derivatives; returns the refined parameters. */
function gaussNewton(p0: number[], resid: (p: readonly number[]) => number[], iters = 30): number[] {
  let p = [...p0];
  let r = resid(p);
  let cost = r.reduce((s, x) => s + x * x, 0);
  for (let it = 0; it < iters; it++) {
    const k = p.length;
    const J: number[][] = [];
    for (let j = 0; j < k; j++) {
      const e = 1e-5 * Math.max(1, Math.abs(p[j]));
      const pp = [...p], pm = [...p];
      pp[j] += e;
      pm[j] -= e;
      const rp = resid(pp), rm = resid(pm);
      J.push(rp.map((x, i) => (x - rm[i]) / (2 * e)));
    }
    const A = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => J[a].reduce((s, x, i) => s + x * J[b][i], 0) + (a === b ? 1e-12 : 0)));
    const g = Array.from({ length: k }, (_, a) => -J[a].reduce((s, x, i) => s + x * r[i], 0));
    const step = solveSmall(A, g);
    if (!step) break;
    let t = 1;
    let improved = false;
    for (let h = 0; h < 8; h++) {
      const cand = p.map((x, j) => x + t * step[j]);
      const rc = resid(cand);
      const cc = rc.reduce((s, x) => s + x * x, 0);
      if (cc < cost) {
        const rel = (cost - cc) / Math.max(cost, 1e-300);
        p = cand;
        r = rc;
        cost = cc;
        improved = true;
        if (rel < 1e-12) return p;
        break;
      }
      t /= 2;
    }
    if (!improved) break;
  }
  return p;
}

function solveSmall(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-300) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Signed distance from p to the convex hull of two discs (a, r1) and (b, r2) ("uneven capsule"). */
export function sdTwoDiscHull(p: Pt, a: Pt, r1: number, b: Pt, r2: number): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const h = Math.hypot(dx, dy);
  if (h <= Math.abs(r1 - r2) + 1e-12) {
    // one disc contains the other
    return r1 >= r2 ? Math.hypot(p.x - a.x, p.y - a.y) - r1 : Math.hypot(p.x - b.x, p.y - b.y) - r2;
  }
  const ux = dx / h, uy = dy / h;
  const along = (p.x - a.x) * ux + (p.y - a.y) * uy;
  const perp = Math.abs(-(p.x - a.x) * uy + (p.y - a.y) * ux);
  const sb = (r1 - r2) / h;
  const ca = Math.sqrt(1 - sb * sb);
  const k = -sb * perp + ca * along;
  if (k < 0) return Math.hypot(perp, along) - r1;
  if (k > ca * h) return Math.hypot(perp, along - h) - r2;
  return ca * perp + sb * along - r1;
}

function robustFit(pts: Pt[], residual: (p: readonly number[], q: Pt) => number, p0: number[]): { p: number[]; used: Pt[]; rms: number } | null {
  let used = pts;
  let p = p0;
  for (let round = 0; round < 4; round++) {
    if (used.length < 8) return null;
    const cur = used;
    p = gaussNewton(p, (q) => cur.map((pt) => residual(q, pt)));
    const res = pts.map((pt) => Math.abs(residual(p, pt)));
    const sorted = [...res].sort((x, y) => x - y);
    const mad = 1.4826 * sorted[sorted.length >> 1];
    const lim = Math.max(0.05, 3 * mad);
    const next = pts.filter((_, i) => res[i] <= lim);
    if (next.length === used.length) {
      used = next;
      break;
    }
    used = next;
  }
  if (used.length < 8) return null;
  const rms = Math.sqrt(used.reduce((s, pt) => s + residual(p, pt) ** 2, 0) / used.length);
  return { p, used, rms };
}

// ------------------------------------------------------------------------------------------------ main

/** Measure the coin on the printed target in BOARD millimetres; `pose` is the view's board pose (board mm -> camera). */
export function checkCoinScale(img: RgbaImage | GrayImage, K: Intrinsics, pose: CameraPose, opts: CoinCheckOptions): CoinCheckResult {
  const layout = opts.layout ?? BOARD;
  const ppm = opts.pxPerMm ?? 8;
  const nRays = opts.rays ?? 180;
  const [sLo, sHi] = opts.searchRange ?? [0.65, 1.45];
  const refR = opts.referenceDiameterMm / 2;
  if (!(refR > 0)) throw new Error("referenceDiameterMm must be positive");
  const target = layout.coinTarget.center;
  const C = cameraCenter(pose);
  const horiz = Math.hypot(C[0] - target.x, C[1] - target.y);
  const elevationDeg = (Math.atan2(C[2], horiz) * 180) / Math.PI;
  if (elevationDeg < (opts.minElevationDeg ?? 45))
    return { ok: false, reason: "view_too_oblique", detail: `camera ${elevationDeg.toFixed(1)} degrees above the board seen from the coin; use a view from higher up`, elevationDeg };

  // rectified board patch around the target (board mm; rows run down = -y)
  const g = isGray(img) ? img : toGray(img);
  const half = sHi * refR + 2.5;
  const N = Math.ceil(2 * half * ppm);
  const rect = new Float32Array(N * N);
  let outside = 0;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const bx = target.x - half + (i + 0.5) / ppm;
      const by = target.y + half - (j + 0.5) / ppm;
      const q = project(K, pose, [bx, by, 0]);
      if (!q || q.x < 0 || q.y < 0 || q.x > g.width - 1 || q.y > g.height - 1) {
        outside++;
        rect[j * N + i] = NaN;
        continue;
      }
      rect[j * N + i] = sampleBilinear(g, q.x, q.y);
    }
  if (outside > 0.02 * N * N) return { ok: false, reason: "outside_image", detail: `${((100 * outside) / (N * N)).toFixed(0)} % of the coin region is outside the image`, elevationDeg };
  for (let k = 0; k < rect.length; k++) if (Number.isNaN(rect[k])) rect[k] = 0;
  const rimg: GrayImage = { width: N, height: N, data: rect };
  const toRect = (p: Pt): Pt => ({ x: (p.x - target.x + half) * ppm - 0.5, y: (target.y + half - p.y) * ppm - 0.5 });

  // edges along rays from a centre (board mm)
  // Step window: about one image pixel (narrow, so the coin's rim and relief do not leak into the edge; wide enough
  // to average the noise), from the image scale at the coin.
  const qc = project(K, pose, [target.x, target.y, 0]);
  const qd = project(K, pose, [target.x + 1, target.y, 0]);
  const qe = project(K, pose, [target.x, target.y + 1, 0]);
  const imgPxPerMm = qc && qd && qe ? Math.min(Math.hypot(qd.x - qc.x, qd.y - qc.y), Math.hypot(qe.x - qc.x, qe.y - qc.y)) : 3;
  const w = Math.max(0.2, Math.min(1, 0.8 / imgPxPerMm)); // step window, mm
  const dr = 0.05; // profile step, mm
  const castRays = (centre: Pt, rLo: number, rHi: number, polarity: number | null) => {
    const out: { pt: Pt; score: number; sign: number }[] = [];
    const nS = Math.floor((rHi - rLo) / dr) + 1;
    const nW = Math.round(w / dr);
    for (let k = 0; k < nRays; k++) {
      const th = (2 * Math.PI * k) / nRays;
      const cx = Math.cos(th), cy = Math.sin(th);
      // profile from rLo - w to rHi + w
      const prof: number[] = [];
      for (let s = -nW; s < nS + nW; s++) {
        const r = rLo + s * dr;
        const q = toRect({ x: centre.x + r * cx, y: centre.y + r * cy });
        prof.push(sampleBilinear(rimg, q.x, q.y));
      }
      // running sums for window means
      const cum = [0];
      for (const v of prof) cum.push(cum[cum.length - 1] + v);
      const score: number[] = [];
      for (let s = 0; s < nS; s++) {
        const c = s + nW; // index of radius rLo + s dr in prof
        const inner = (cum[c] - cum[c - nW]) / nW;
        const outer = (cum[c + nW] - cum[c]) / nW;
        score.push(outer - inner);
      }
      let best = 0, bestS = -1, bestSign = 0;
      const signs = polarity === null ? [1, -1] : [polarity];
      for (const sg of signs) {
        let m = 0;
        for (let s = 0; s < nS; s++) m = Math.max(m, sg * score[s]);
        if (m > best) {
          best = m;
          bestSign = sg;
        }
      }
      if (!(best > 0)) continue;
      // the OUTERMOST local maximum above half the ray's best (the silhouette, not the rim or the relief)
      for (let s = nS - 2; s >= 1; s--) {
        const v = bestSign * score[s];
        if (v >= 0.5 * best && v >= bestSign * score[s - 1] && v >= bestSign * score[s + 1]) {
          bestS = s;
          break;
        }
      }
      if (bestS < 0) continue;
      // Sub-sample position: the parabolic peak of the step response. (The centroid would be exact for a clean step
      // but is pulled outward on the side facing the camera, where the coin's dark side wall makes the edge a bar.
      // The response is smooth here: the window spans about one image pixel and the profile is oversampled.)
      const peak = bestSign * score[bestS];
      const g0 = bestSign * score[bestS - 1], g2 = bestSign * score[bestS + 1];
      const den = g0 - 2 * peak + g2;
      const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (g0 - g2)) / den)) : 0;
      // score index s compares [r - w, r - dr] with [r, r + w - dr]: its split point is r - dr / 2
      const r = rLo + (bestS + off) * dr - dr / 2;
      out.push({ pt: { x: centre.x + r * cx, y: centre.y + r * cy }, score: peak, sign: bestSign });
    }
    return out;
  };

  let edges = castRays(target, sLo * refR, sHi * refR, null);
  if (edges.length < nRays / 3) return { ok: false, reason: "no_edge", detail: `edge found on ${edges.length} of ${nRays} rays`, elevationDeg };
  const pos = edges.filter((e) => e.sign > 0).length;
  const polarity = pos >= edges.length - pos ? 1 : -1; // +1: the coin is darker than the paper
  edges = edges.filter((e) => e.sign === polarity);
  const circleResidual = (p: readonly number[], q: Pt) => Math.hypot(q.x - p[0], q.y - p[1]) - p[2];
  const c0 = fitCircleAlgebraic(edges.map((e) => e.pt));
  if (!c0) return { ok: false, reason: "fit_failed", detail: "algebraic circle fit failed", elevationDeg };
  let fit = robustFit(edges.map((e) => e.pt), circleResidual, [c0.x, c0.y, c0.r]);
  if (!fit) return { ok: false, reason: "fit_failed", detail: "too few consistent edge points", elevationDeg };
  // second pass from the fitted centre, in a narrower band
  const r1 = fit.p[2];
  edges = castRays({ x: fit.p[0], y: fit.p[1] }, Math.max(sLo * refR, 0.75 * r1), Math.min(sHi * refR, 1.25 * r1), polarity);
  if (edges.length < nRays / 3) return { ok: false, reason: "no_edge", detail: `second pass: edge found on ${edges.length} of ${nRays} rays`, elevationDeg };
  const pts = edges.map((e) => e.pt);
  fit = robustFit(pts, circleResidual, fit.p);
  if (!fit) return { ok: false, reason: "fit_failed", detail: "second pass: too few consistent edge points", elevationDeg };
  const circleD = 2 * fit.p[2];

  let diameter = circleD;
  let centre = { x: fit.p[0], y: fit.p[1] };
  let rms = fit.rms;
  let used = fit.used.length;
  if (opts.coinThicknessMm && opts.coinThicknessMm > 0) {
    // thickness in board mm (physical / scale); the scale from the plain fit is close enough for this small term
    const hB = opts.coinThicknessMm * (circleD / opts.referenceDiameterMm);
    const Zc = C[2];
    if (Zc > hB * 1.5) {
      const kk = Zc / (Zc - hB);
      const F = { x: C[0], y: C[1] };
      const hullResidual = (p: readonly number[], q: Pt) => {
        const a = { x: p[0], y: p[1] };
        const b = { x: F.x + kk * (a.x - F.x), y: F.y + kk * (a.y - F.y) };
        return sdTwoDiscHull(q, a, p[2], b, kk * p[2]);
      };
      // start: the base circle is smaller and shifted toward the camera
      const start = [F.x + (fit.p[0] - F.x) / kk, F.y + (fit.p[1] - F.y) / kk, fit.p[2] / kk];
      const hf = robustFit(pts, hullResidual, start);
      if (hf) {
        diameter = 2 * hf.p[2];
        centre = { x: hf.p[0], y: hf.p[1] };
        rms = hf.rms;
        used = hf.used.length;
      }
    }
  }
  const contrasts = edges.map((e) => e.score).sort((a, b) => a - b);
  const edgeContrast = contrasts[contrasts.length >> 1];
  // interior versus surrounding paper: a coin is a filled disc; a printed ring or an empty target is not
  const ring = (r0: number, r1: number) => {
    let acc = 0, n = 0;
    for (let k = 0; k < 120; k++)
      for (let f = 0; f <= 4; f++) {
        const r = r0 + ((r1 - r0) * f) / 4;
        const th = (2 * Math.PI * k) / 120;
        const q = toRect({ x: centre.x + r * Math.cos(th), y: centre.y + r * Math.sin(th) });
        if (q.x < 0 || q.y < 0 || q.x > N - 1 || q.y > N - 1) continue;
        acc += sampleBilinear(rimg, q.x, q.y);
        n++;
      }
    return n ? acc / n : NaN;
  };
  const R = diameter / 2;
  const fillContrast = polarity * (ring(1.15 * R, Math.min(1.35 * R, half - 0.5)) - ring(0.45 * R, 0.8 * R));
  if (!(fillContrast >= (opts.minFillContrast ?? 6)))
    return { ok: false, reason: "not_a_disc", detail: `the inside of the edge differs from the paper by only ${fillContrast.toFixed(1)} grey levels (no coin, or only the printed outline)`, elevationDeg };
  if (!(edgeContrast >= (opts.minEdgeContrast ?? 4))) return { ok: false, reason: "low_contrast", detail: `median edge step ${edgeContrast.toFixed(1)} grey levels`, elevationDeg };
  if (!(rms <= (opts.maxResidualMm ?? 0.25)))
    return { ok: false, reason: "poor_fit", detail: `edge points scatter ${rms.toFixed(2)} mm about the fitted outline (low contrast, glare, a finger or the coin off the target)`, elevationDeg };
  const printScale = opts.referenceDiameterMm / diameter;
  if (!(printScale > 0.6 && printScale < 1.6)) return { ok: false, reason: "implausible_size", detail: `measured ${diameter.toFixed(2)} board mm`, elevationDeg };
  return {
    ok: true,
    diameterMm: diameter,
    circleDiameterMm: circleD,
    printScale,
    residualMm: rms,
    center: centre,
    centerOffsetMm: Math.hypot(centre.x - target.x, centre.y - target.y),
    edgePoints: pts.length,
    edgePointsUsed: used,
    polarity: polarity > 0 ? "darker" : "brighter",
    edgeContrast,
    fillContrast,
    elevationDeg,
    cameraHeightMm: C[2],
    thicknessEffectMm: circleD - diameter,
    rectified: opts.keepRectified ? rimg : undefined,
    edgePointsMm: opts.keepRectified ? pts : undefined,
  };
}
