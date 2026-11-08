// Bundle adjustment for the EXPERIMENTAL board-free structure from motion (sfm/).
//
// Levenberg-Marquardt over all camera poses (rotation as a left increment exp([w]) R, translation), all 3D points, and
// shared intrinsics: one focal length (square pixels, principal point fixed at the picture centre) and radial k1 (k2
// optional), with a Huber robust loss (iteratively reweighted). The points are eliminated with the Schur complement; the
// reduced system (6 per camera + the shared parameters) is dense and solved by Cholesky.
//
// Optionally the COIN is fitted jointly: its 3D circle (centre, normal, log radius) becomes six more shared parameters
// and its outline edge points in every view become extra residuals (Sampson distance of each edge point to the
// projected coin outline, coin/sceneScale.ts outlineResiduals, "cylinder" model: the top rim and the bottom rim one
// thickness below, so an oblique view's wall is modelled). The coin then pulls the poses toward agreeing with one
// circle, and the scale D / (2 r) comes out of the same optimum as the poses (no separate fit on fixed poses).
//
// The gauge (a similarity of the whole scene) is left free; the damping keeps the steps finite.
import type { Pt } from "../common";
import { outlineResiduals } from "../coin/sceneScale";
import { choleskySolve, expSO3, m3mul, vcross, vunit, type M3, type V3 } from "./mat";
import { undistort, type Cam } from "./geometry";

export interface BACamera {
  R: M3;
  t: V3;
}

export interface CoinState {
  centre: V3;
  normal: V3;
  radius: number;
}

export interface CoinObservations {
  /** Camera index -> edge points of the coin outline in DISTORTED pixels (as found in the picture). */
  views: { cam: number; pts: readonly Pt[] }[];
  /** Thickness / diameter of the coin (the cylinder model's wall height per unit diameter). */
  thicknessRatio: number;
  state: CoinState;
}

export interface BAProblem {
  cams: BACamera[];
  cam: Cam;
  /** xyz per point (scene units). */
  points: Float64Array;
  obsCam: Int32Array;
  obsPt: Int32Array;
  obsU: Float64Array;
  obsV: Float64Array;
  coin?: CoinObservations | null;
}

export interface BAOptions {
  refineFocal?: boolean;
  refineK1?: boolean;
  refineK2?: boolean;
  /** Cameras whose pose is held fixed (e.g. the first while the focal length is still fixed). */
  fixedCams?: ReadonlySet<number>;
  huberPx?: number;
  coinHuberPx?: number;
  /** Weight of each coin edge residual relative to a feature residual (default 1). */
  coinWeight?: number;
  iterations?: number;
}

export interface BAResult {
  iterations: number;
  initialRmsPx: number;
  rmsPx: number;
  coinRmsPx: number | null;
  converged: boolean;
}

function planeBasis(n: V3): [V3, V3] {
  const a: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = vunit(vcross(n, a));
  return [u, vcross(n, u)];
}

/** Undistorted-pixel edge points of one view for the current intrinsics. */
function undistortPts(cam: Cam, pts: readonly Pt[]): Pt[] {
  return pts.map((p) => {
    const [x, y] = undistort(cam, p.x, p.y);
    return { x: cam.f * x + cam.cx, y: cam.f * y + cam.cy };
  });
}

/** Coin residuals of one view (pixels). */
function coinResiduals(cam: Cam, c: BACamera, pts: readonly Pt[], s: CoinState, ratio: number): number[] {
  const und = undistortPts(cam, pts);
  return outlineResiduals(und, { K: { fx: cam.f, fy: cam.f, cx: cam.cx, cy: cam.cy }, pose: { R: c.R, t: c.t } }, s.centre, s.normal, s.radius, "cylinder", 2 * s.radius * ratio);
}

const huberW = (r: number, d: number) => (r <= d ? 1 : d / r);
const huberRho = (r: number, d: number) => (r <= d ? r * r : 2 * d * r - d * d);

export function evaluate(p: BAProblem, o: BAOptions = {}): { cost: number; featRms: number; coinRms: number | null } {
  const d = o.huberPx ?? 2, dc = o.coinHuberPx ?? 1.5, cw = o.coinWeight ?? 1;
  let cost = 0, se = 0;
  const { cam } = p;
  for (let k = 0; k < p.obsCam.length; k++) {
    const c = p.cams[p.obsCam[k]], j = p.obsPt[k] * 3;
    const r = reproj(cam, c, p.points[j], p.points[j + 1], p.points[j + 2], p.obsU[k], p.obsV[k]);
    const n = Math.hypot(r[0], r[1]);
    cost += huberRho(n, d);
    se += n * n;
  }
  let coinRms: number | null = null;
  if (p.coin) {
    let cs = 0, cn = 0;
    for (const v of p.coin.views) {
      const rr = coinResiduals(cam, p.cams[v.cam], v.pts, p.coin.state, p.coin.thicknessRatio);
      for (const r of rr) {
        cost += cw * huberRho(Math.abs(r), dc);
        cs += r * r;
        cn++;
      }
    }
    coinRms = Math.sqrt(cs / Math.max(1, cn));
  }
  return { cost, featRms: Math.sqrt(se / Math.max(1, p.obsCam.length)), coinRms };
}

function reproj(cam: Cam, c: BACamera, X: number, Y: number, Z: number, u: number, v: number): [number, number] {
  const R = c.R, t = c.t;
  const xc = R[0] * X + R[1] * Y + R[2] * Z + t[0];
  const yc = R[3] * X + R[4] * Y + R[5] * Z + t[1];
  const zc = R[6] * X + R[7] * Y + R[8] * Z + t[2];
  if (zc <= 1e-9) return [1e3, 1e3];
  const x = xc / zc, y = yc / zc, r2 = x * x + y * y;
  const dd = 1 + cam.k1 * r2 + cam.k2 * r2 * r2;
  return [cam.f * dd * x + cam.cx - u, cam.f * dd * y + cam.cy - v];
}

interface Ctx {
  nc: number;
  np: number;
  no: number;
  nr: number;
  g0: number;
  rowLen: number;
  refineFocal: boolean;
  refineK1: boolean;
  refineK2: boolean;
  huber: number;
  fixedArr: Uint8Array;
  obsCam: Int32Array;
  obsPt: Int32Array;
  obsU: Float64Array;
  obsV: Float64Array;
  ptStart: Int32Array;
  ptObs: Int32Array;
  U: Float64Array;
  bc: Float64Array;
  Vp: Float64Array;
  bp: Float64Array;
  Wk: Float64Array;
  rowsBuf: Int32Array;
  WrBuf: Float64Array;
  Ybuf: Float64Array;
  slot: Int32Array;
}

/** Normal equations of the feature residuals (analytic Jacobians) into ctx.U / bc / Vp / bp / Wk. Kept in its own
 *  function (as are the Schur reduction and the back-substitution) so the JIT optimises each hot loop on its own. */
function assembleFeatures(c: Ctx, camR: Float64Array, camT: Float64Array, f: number, k1: number, k2: number, cx: number, cy: number, pts: Float64Array): void {
  const { nr, g0, rowLen, U, bc, Vp, bp, Wk, fixedArr, obsCam, obsPt, obsU, obsV, huber } = c;
  U.fill(0);
  bc.fill(0);
  Vp.fill(0);
  bp.fill(0);
  const Jrow = new Float64Array(rowLen), Jrow2 = new Float64Array(rowLen);
  for (let k = 0; k < c.no; k++) {
    const ci = obsCam[k], pi = obsPt[k];
    const ro = ci * 9, to = ci * 3;
    const X = pts[pi * 3], Y = pts[pi * 3 + 1], Z = pts[pi * 3 + 2];
    const R0 = camR[ro], R1 = camR[ro + 1], R2 = camR[ro + 2], R3 = camR[ro + 3], R4 = camR[ro + 4], R5 = camR[ro + 5], R6 = camR[ro + 6], R7 = camR[ro + 7], R8 = camR[ro + 8];
    const RX0 = R0 * X + R1 * Y + R2 * Z, RX1 = R3 * X + R4 * Y + R5 * Z, RX2 = R6 * X + R7 * Y + R8 * Z;
    const xc = RX0 + camT[to], yc = RX1 + camT[to + 1], zc = RX2 + camT[to + 2];
    if (zc <= 1e-9) {
      for (let a = 0; a < rowLen * 3; a++) Wk[k * rowLen * 3 + a] = 0;
      continue;
    }
    const iz = 1 / zc, x = xc * iz, y = yc * iz, r2 = x * x + y * y;
    const dd = 1 + k1 * r2 + k2 * r2 * r2;
    const ru = f * dd * x + cx - obsU[k], rv = f * dd * y + cy - obsV[k];
    const nrm = Math.sqrt(ru * ru + rv * rv);
    const w = nrm <= huber ? 1 : huber / nrm;
    const dr = k1 + 2 * k2 * r2;
    const ux = f * (dd + 2 * x * x * dr), uy = f * 2 * x * y * dr;
    const vx = uy, vy = f * (dd + 2 * y * y * dr);
    const u0 = ux * iz, u1 = uy * iz, u2 = -(ux * x + uy * y) * iz;
    const v0 = vx * iz, v1 = vy * iz, v2 = -(vx * x + vy * y) * iz;
    if (fixedArr[ci]) for (let a = 0; a < 6; a++) Jrow[a] = Jrow2[a] = 0;
    else {
      Jrow[0] = -u1 * RX2 + u2 * RX1; Jrow[1] = u0 * RX2 - u2 * RX0; Jrow[2] = -u0 * RX1 + u1 * RX0;
      Jrow[3] = u0; Jrow[4] = u1; Jrow[5] = u2;
      Jrow2[0] = -v1 * RX2 + v2 * RX1; Jrow2[1] = v0 * RX2 - v2 * RX0; Jrow2[2] = -v0 * RX1 + v1 * RX0;
      Jrow2[3] = v0; Jrow2[4] = v1; Jrow2[5] = v2;
    } // fmt: skip
    let q = 6;
    if (c.refineFocal) ((Jrow[q] = dd * x), (Jrow2[q] = dd * y), q++);
    if (c.refineK1) ((Jrow[q] = f * x * r2), (Jrow2[q] = f * y * r2), q++);
    if (c.refineK2) ((Jrow[q] = f * x * r2 * r2), (Jrow2[q] = f * y * r2 * r2), q++);
    const pu0 = u0 * R0 + u1 * R3 + u2 * R6, pu1 = u0 * R1 + u1 * R4 + u2 * R7, pu2 = u0 * R2 + u1 * R5 + u2 * R8;
    const pv0 = v0 * R0 + v1 * R3 + v2 * R6, pv1 = v0 * R1 + v1 * R4 + v2 * R7, pv2 = v0 * R2 + v1 * R5 + v2 * R8;
    const cb = 6 * ci;
    for (let a = 0; a < rowLen; a++) {
      const ia = a < 6 ? cb + a : g0 + a - 6;
      const ja = Jrow[a], jb = Jrow2[a];
      bc[ia] -= w * (ja * ru + jb * rv);
      const rowOff = ia * nr;
      for (let b = 0; b < rowLen; b++) U[rowOff + (b < 6 ? cb + b : g0 + b - 6)] += w * (ja * Jrow[b] + jb * Jrow2[b]);
      const wo = (k * rowLen + a) * 3;
      Wk[wo] = w * (ja * pu0 + jb * pv0);
      Wk[wo + 1] = w * (ja * pu1 + jb * pv1);
      Wk[wo + 2] = w * (ja * pu2 + jb * pv2);
    }
    const po = pi * 3, vo = pi * 9;
    bp[po] -= w * (pu0 * ru + pv0 * rv);
    bp[po + 1] -= w * (pu1 * ru + pv1 * rv);
    bp[po + 2] -= w * (pu2 * ru + pv2 * rv);
    Vp[vo] += w * (pu0 * pu0 + pv0 * pv0); Vp[vo + 1] += w * (pu0 * pu1 + pv0 * pv1); Vp[vo + 2] += w * (pu0 * pu2 + pv0 * pv2);
    Vp[vo + 4] += w * (pu1 * pu1 + pv1 * pv1); Vp[vo + 5] += w * (pu1 * pu2 + pv1 * pv2); Vp[vo + 8] += w * (pu2 * pu2 + pv2 * pv2);
  } // fmt: skip
  for (let pi = 0; pi < c.np; pi++) {
    const vo = pi * 9;
    Vp[vo + 3] = Vp[vo + 1]; Vp[vo + 6] = Vp[vo + 2]; Vp[vo + 7] = Vp[vo + 5]; // fmt: skip
  }
}

/** Schur complement of the points: S -= W V^-1 W^T, rhs -= W V^-1 bp. Fills Vinv / okPt. */
function schurReduce(c: Ctx, lambda: number, S: Float64Array, rhs: Float64Array, Vinv: Float64Array, okPt: Uint8Array): void {
  const { nr, g0, rowLen, Vp, bp, Wk, ptStart, ptObs, obsCam, rowsBuf, WrBuf, Ybuf, slot } = c;
  const inv = new Float64Array(9);
  for (let pi = 0; pi < c.np; pi++) {
    const vo = pi * 9;
    const a0 = Vp[vo] * (1 + lambda) + 1e-12, a1 = Vp[vo + 1], a2 = Vp[vo + 2], a4 = Vp[vo + 4] * (1 + lambda) + 1e-12, a5 = Vp[vo + 5], a8 = Vp[vo + 8] * (1 + lambda) + 1e-12;
    const det = a0 * (a4 * a8 - a5 * a5) - a1 * (a1 * a8 - a5 * a2) + a2 * (a1 * a5 - a4 * a2);
    if (!(Math.abs(det) > 1e-300)) continue;
    inv[0] = (a4 * a8 - a5 * a5) / det; inv[1] = (a2 * a5 - a1 * a8) / det; inv[2] = (a1 * a5 - a2 * a4) / det;
    inv[4] = (a0 * a8 - a2 * a2) / det; inv[5] = (a2 * a1 - a0 * a5) / det; inv[8] = (a0 * a4 - a1 * a1) / det;
    inv[3] = inv[1]; inv[6] = inv[2]; inv[7] = inv[5]; // fmt: skip
    okPt[pi] = 1;
    for (let a = 0; a < 9; a++) Vinv[vo + a] = inv[a];
    let nrow = 0;
    for (let q = ptStart[pi]; q < ptStart[pi + 1]; q++) {
      const k = ptObs[q], ci = obsCam[k];
      for (let a = 0; a < rowLen; a++) {
        const col = a < 6 ? 6 * ci + a : g0 + (a - 6);
        const wi = (k * rowLen + a) * 3;
        let at = slot[col];
        if (at < 0) {
          at = nrow++;
          slot[col] = at;
          rowsBuf[at] = col;
          WrBuf[at * 3] = WrBuf[at * 3 + 1] = WrBuf[at * 3 + 2] = 0;
        }
        WrBuf[at * 3] += Wk[wi];
        WrBuf[at * 3 + 1] += Wk[wi + 1];
        WrBuf[at * 3 + 2] += Wk[wi + 2];
      }
    }
    for (let r = 0; r < nrow; r++) {
      slot[rowsBuf[r]] = -1;
      const w0 = WrBuf[r * 3], w1 = WrBuf[r * 3 + 1], w2 = WrBuf[r * 3 + 2];
      Ybuf[r * 3] = w0 * inv[0] + w1 * inv[3] + w2 * inv[6];
      Ybuf[r * 3 + 1] = w0 * inv[1] + w1 * inv[4] + w2 * inv[7];
      Ybuf[r * 3 + 2] = w0 * inv[2] + w1 * inv[5] + w2 * inv[8];
    }
    const b0 = bp[pi * 3], b1 = bp[pi * 3 + 1], b2 = bp[pi * 3 + 2];
    for (let r = 0; r < nrow; r++) {
      const y0 = Ybuf[r * 3], y1 = Ybuf[r * 3 + 1], y2 = Ybuf[r * 3 + 2];
      const rr = rowsBuf[r];
      const row = rr * nr;
      rhs[rr] -= y0 * b0 + y1 * b1 + y2 * b2;
      for (let cc = 0; cc < nrow; cc++) S[row + rowsBuf[cc]] -= y0 * WrBuf[cc * 3] + y1 * WrBuf[cc * 3 + 1] + y2 * WrBuf[cc * 3 + 2];
    }
  }
}

/** Point updates from the reduced-system solution. */
function backSubstitute(c: Ctx, dc: Float64Array, Vinv: Float64Array, okPt: Uint8Array, dp: Float64Array): void {
  const { g0, rowLen, bp, Wk, ptStart, ptObs, obsCam } = c;
  for (let pi = 0; pi < c.np; pi++) {
    if (!okPt[pi]) continue;
    let r0 = bp[pi * 3], r1 = bp[pi * 3 + 1], r2 = bp[pi * 3 + 2];
    for (let q = ptStart[pi]; q < ptStart[pi + 1]; q++) {
      const k = ptObs[q], ci = obsCam[k];
      for (let a = 0; a < rowLen; a++) {
        const d = dc[a < 6 ? 6 * ci + a : g0 + (a - 6)];
        if (!d) continue;
        const wi = (k * rowLen + a) * 3;
        r0 -= Wk[wi] * d;
        r1 -= Wk[wi + 1] * d;
        r2 -= Wk[wi + 2] * d;
      }
    }
    const o = pi * 9;
    dp[pi * 3] = Vinv[o] * r0 + Vinv[o + 1] * r1 + Vinv[o + 2] * r2;
    dp[pi * 3 + 1] = Vinv[o + 3] * r0 + Vinv[o + 4] * r1 + Vinv[o + 5] * r2;
    dp[pi * 3 + 2] = Vinv[o + 6] * r0 + Vinv[o + 7] * r1 + Vinv[o + 8] * r2;
  }
}

/** Coin edge residuals (numeric Jacobians over the camera, the intrinsics and the coin), added to U / bc. */
function assembleCoin(p: BAProblem, gNames: readonly string[], g0: number, nr: number, U: Float64Array, bc: Float64Array, fixed: ReadonlySet<number>, cw: number, cHuber: number): void {
  const coin = p.coin!;
  const cam = p.cam;
  const s0 = coin.state;
  const [bu, bv] = planeBasis(s0.normal);
  const scale = Math.max(1e-6, s0.radius);
  const gIdx = (name: string) => g0 + gNames.indexOf(name);
  for (const view of coin.views) {
    const c0 = p.cams[view.cam];
    const base = coinResiduals(cam, c0, view.pts, s0, coin.thicknessRatio);
    const m = base.length;
    const cols: number[] = [];
    const J: number[][] = [];
    const push = (col: number, r: number[], h: number) => {
      cols.push(col);
      J.push(r.map((v, i) => (v - base[i]) / h));
    };
    if (!fixed.has(view.cam))
      for (let a = 0; a < 6; a++) {
        const h = a < 3 ? 1e-6 : 1e-5 * scale;
        const cc: BACamera = a < 3 ? { R: m3mul(expSO3([a === 0 ? h : 0, a === 1 ? h : 0, a === 2 ? h : 0]), c0.R), t: c0.t } : { R: c0.R, t: [c0.t[0] + (a === 3 ? h : 0), c0.t[1] + (a === 4 ? h : 0), c0.t[2] + (a === 5 ? h : 0)] };
        push(6 * view.cam + a, coinResiduals(cam, cc, view.pts, s0, coin.thicknessRatio), h);
      }
    for (const name of gNames) {
      let r: number[], h: number;
      if (name === "f") ((h = 1e-3), (r = coinResiduals({ ...cam, f: cam.f + h }, c0, view.pts, s0, coin.thicknessRatio)));
      else if (name === "k1") ((h = 1e-6), (r = coinResiduals({ ...cam, k1: cam.k1 + h }, c0, view.pts, s0, coin.thicknessRatio)));
      else if (name === "k2") ((h = 1e-6), (r = coinResiduals({ ...cam, k2: cam.k2 + h }, c0, view.pts, s0, coin.thicknessRatio)));
      else if (name === "na" || name === "nb") {
        h = 1e-6;
        const b = name === "na" ? bu : bv;
        r = coinResiduals(cam, c0, view.pts, { ...s0, normal: vunit([s0.normal[0] + h * b[0], s0.normal[1] + h * b[1], s0.normal[2] + h * b[2]]) }, coin.thicknessRatio);
      } else if (name === "lr") ((h = 1e-6), (r = coinResiduals(cam, c0, view.pts, { ...s0, radius: s0.radius * Math.exp(h) }, coin.thicknessRatio)));
      else {
        h = 1e-5 * scale;
        const ax = name === "cx" ? 0 : name === "cy" ? 1 : 2;
        const ce: V3 = [s0.centre[0], s0.centre[1], s0.centre[2]];
        ce[ax] += h;
        r = coinResiduals(cam, c0, view.pts, { ...s0, centre: ce }, coin.thicknessRatio);
      }
      push(gIdx(name), r, h);
    }
    for (let i = 0; i < m; i++) {
      const w = cw * huberW(Math.abs(base[i]), cHuber);
      for (let a = 0; a < cols.length; a++) {
        const ja = J[a][i];
        if (!ja) continue;
        bc[cols[a]] -= w * ja * base[i];
        for (let b = 0; b < cols.length; b++) U[cols[a] * nr + cols[b]] += w * ja * J[b][i];
      }
    }
  }
}

/** Run the bundle adjustment in place. */
export function bundleAdjust(p: BAProblem, o: BAOptions = {}): BAResult {
  const nc = p.cams.length, np = p.points.length / 3, no = p.obsCam.length;
  const cHuber = o.coinHuberPx ?? 1.5, cw = o.coinWeight ?? 1;
  const fixed = o.fixedCams ?? new Set<number>();
  const gNames: string[] = [];
  if (o.refineFocal) gNames.push("f");
  if (o.refineK1) gNames.push("k1");
  if (o.refineK2) gNames.push("k2");
  const intrCount = gNames.length;
  const withCoin = !!p.coin && p.coin.views.length >= 2;
  if (withCoin) gNames.push("cx", "cy", "cz", "na", "nb", "lr");
  const nr = 6 * nc + gNames.length;
  const g0 = 6 * nc;
  const rowLen = 6 + intrCount;
  const gIdx = (name: string) => g0 + gNames.indexOf(name);
  const ptStart = new Int32Array(np + 1);
  for (let k = 0; k < no; k++) ptStart[p.obsPt[k] + 1]++;
  for (let i = 0; i < np; i++) ptStart[i + 1] += ptStart[i];
  const ptObs = new Int32Array(no);
  {
    const fill = ptStart.slice(0, np);
    for (let k = 0; k < no; k++) ptObs[fill[p.obsPt[k]]++] = k;
  }
  let maxObsPerPt = 1;
  for (let i = 0; i < np; i++) maxObsPerPt = Math.max(maxObsPerPt, ptStart[i + 1] - ptStart[i]);
  const fixedArr = new Uint8Array(nc);
  for (const ci of fixed) fixedArr[ci] = 1;
  const ctx: Ctx = {
    nc, np, no, nr, g0, rowLen,
    refineFocal: !!o.refineFocal, refineK1: !!o.refineK1, refineK2: !!o.refineK2,
    huber: o.huberPx ?? 2, fixedArr,
    obsCam: p.obsCam, obsPt: p.obsPt, obsU: p.obsU, obsV: p.obsV, ptStart, ptObs,
    U: new Float64Array(nr * nr), bc: new Float64Array(nr), Vp: new Float64Array(np * 9), bp: new Float64Array(np * 3),
    Wk: new Float64Array(no * rowLen * 3),
    rowsBuf: new Int32Array(maxObsPerPt * rowLen), WrBuf: new Float64Array(maxObsPerPt * rowLen * 3), Ybuf: new Float64Array(maxObsPerPt * rowLen * 3),
    slot: new Int32Array(nr).fill(-1),
  }; // fmt: skip
  const init = evaluate(p, o);
  let cost = init.cost;
  let lambda = 1e-3;
  let it = 0, converged = false;
  const maxIt = o.iterations ?? 30;
  const camR = new Float64Array(9 * nc), camT = new Float64Array(3 * nc);
  const S = new Float64Array(nr * nr), rhs = new Float64Array(nr), Vinv = new Float64Array(np * 9), okPt = new Uint8Array(np), dp = new Float64Array(np * 3);
  for (; it < maxIt; it++) {
    for (let ci = 0; ci < nc; ci++) {
      for (let a = 0; a < 9; a++) camR[ci * 9 + a] = p.cams[ci].R[a];
      for (let a = 0; a < 3; a++) camT[ci * 3 + a] = p.cams[ci].t[a];
    }
    assembleFeatures(ctx, camR, camT, p.cam.f, p.cam.k1, p.cam.k2, p.cam.cx, p.cam.cy, p.points);
    if (withCoin) assembleCoin(p, gNames, g0, nr, ctx.U, ctx.bc, fixed, cw, cHuber);
    for (const ci of fixed) for (let a = 0; a < 6; a++) ctx.U[(6 * ci + a) * nr + 6 * ci + a] += 1;
    let accepted = false;
    for (let tries = 0; tries < 5 && !accepted; tries++) {
      S.set(ctx.U);
      rhs.set(ctx.bc);
      for (let i = 0; i < nr; i++) S[i * nr + i] += lambda * Math.max(ctx.U[i * nr + i], 1e-9) + 1e-12;
      okPt.fill(0);
      schurReduce(ctx, lambda, S, rhs, Vinv, okPt);
      const dc = choleskySolve(S, rhs, nr);
      if (!dc) {
        lambda *= 10;
        continue;
      }
      dp.fill(0);
      backSubstitute(ctx, dc, Vinv, okPt, dp);
      const saved = { cams: p.cams.map((c) => ({ R: c.R, t: c.t })), cam: { ...p.cam }, points: Float64Array.from(p.points), coin: p.coin ? { ...p.coin.state } : null };
      for (let ci = 0; ci < nc; ci++) {
        if (fixed.has(ci)) continue;
        const d = dc.subarray(6 * ci, 6 * ci + 6);
        p.cams[ci] = { R: m3mul(expSO3([d[0], d[1], d[2]]), p.cams[ci].R), t: [p.cams[ci].t[0] + d[3], p.cams[ci].t[1] + d[4], p.cams[ci].t[2] + d[5]] };
      }
      const newCam = { ...p.cam };
      if (o.refineFocal) newCam.f += dc[gIdx("f")];
      if (o.refineK1) newCam.k1 += dc[gIdx("k1")];
      if (o.refineK2) newCam.k2 += dc[gIdx("k2")];
      p.cam = newCam;
      for (let i = 0; i < p.points.length; i++) p.points[i] += dp[i];
      if (withCoin && p.coin) {
        const s0 = p.coin.state;
        const [bu, bv] = planeBasis(s0.normal);
        const a = dc[gIdx("na")], b = dc[gIdx("nb")];
        p.coin.state = {
          centre: [s0.centre[0] + dc[gIdx("cx")], s0.centre[1] + dc[gIdx("cy")], s0.centre[2] + dc[gIdx("cz")]],
          normal: vunit([s0.normal[0] + a * bu[0] + b * bv[0], s0.normal[1] + a * bu[1] + b * bv[1], s0.normal[2] + a * bu[2] + b * bv[2]]),
          radius: s0.radius * Math.exp(dc[gIdx("lr")]),
        };
      }
      const nc2 = evaluate(p, o).cost;
      if (Number.isFinite(nc2) && nc2 < cost) {
        const rel = (cost - nc2) / Math.max(cost, 1e-12);
        cost = nc2;
        lambda = Math.max(1e-9, lambda / 4);
        accepted = true;
        if (rel < 1e-6) converged = true;
      } else {
        p.cams = saved.cams;
        p.cam = saved.cam;
        p.points.set(saved.points);
        if (p.coin && saved.coin) p.coin.state = saved.coin;
        lambda *= 8;
      }
    }
    if (!accepted || converged) {
      converged = true;
      break;
    }
  }
  const fin = evaluate(p, o);
  return { iterations: it, initialRmsPx: init.featRms, rmsPx: fin.featRms, coinRmsPx: fin.coinRms, converged };
}
