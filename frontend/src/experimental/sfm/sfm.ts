// EXPERIMENTAL incremental structure from motion WITHOUT a printed board (stage 3 of docs/hand3d-research/MASTER_AUDIT.md).
//
//   pictures -> corners + rotation-aware binary descriptors (features.ts), the hand region left out (it may move)
//            -> pairwise matching (mutual nearest neighbour + ratio test) and geometric verification (RANSAC F and H)
//            -> tracks (union-find) -> initial pair: homography decomposition when the matches lie on one plane (the
//               table: F is then undetermined), essential matrix otherwise, with the focal length from the field-of-view
//               prior; both homography solutions are tried and the one that registers more views is kept
//            -> incremental registration (P3P + RANSAC + refinement against the triangulated points), triangulation of
//               new tracks, bundle adjustment after each view (focal length and k1 freed once five views are in; k2 at
//               the end), outlier removal
//            -> optional joint coin fit in the final bundle adjustment (bundle.ts).
//
// The result is up to an unknown similarity (rotation, translation, SCALE): frame.ts fits the table plane and applies
// the coin's scale. Nothing here knows the true focal length, distortion or any pose. SIMULATED evaluation only (see
// README.md); never run on a real capture.
import type { Pt } from "../common";
import type { RGBAImage } from "../multiview/image";
import { makeRng } from "../reconstruction/rng";
import { fitCoinCircle3D } from "../coin/sceneScale";
import { bundleAdjust, type BACamera, type BAProblem, type CoinState } from "./bundle";
import { detectFeatures, matchFeatures, type DetectOptions, type Features } from "./features";
import { centreOf, decomposeHomography, pnpRansac, poseFromEssential, projectEssential, projectPx, ransacFundamental, ransacHomography, triangulate, triangulationAngleDeg, undistort, type Cam } from "./geometry";
import { m3mul, m3T, m3v, vsub, type M3, type V3 } from "./mat";

export interface SfmView {
  id: string;
  image: RGBAImage;
  /** 0/255 per pixel: features here are not used for the camera geometry (the hand). */
  exclude?: Uint8Array | null;
  /** Capture-guide metadata (the direction the guide asked for: elevation above the table and azimuth round the hand,
   *  approximate), used only to choose which pairs to match. */
  elevationDeg?: number;
  azimuthDeg?: number | null;
  /** Coin outline edge points in this picture (distorted pixels), if the coin was found. */
  coinEdges?: readonly Pt[] | null;
}

export interface SfmOptions {
  /** Field-of-view prior (degrees, along the long side) for the initial focal length. Default 67.5 (middle of 55-80). */
  hfovPriorDeg?: number;
  detect?: DetectOptions;
  /** Match every pair (default false: pairs chosen from the capture metadata when present). */
  allPairs?: boolean;
  /** Pairs are matched when their guide directions are at most this far apart (degrees on the viewing sphere).
   *  Default 65 (neighbouring stills of a 30-degree ring). */
  pairWindowDeg?: number;
  /** Fewest verified matches for a pair to be used (default 30). */
  minPairMatches?: number;
  /** Verification and registration thresholds in pixels (default 4 and 3). */
  verifyPx?: number;
  inlierPx?: number;
  /** Refine k2 in the final bundle adjustment (default true). */
  refineK2?: boolean;
  /** Coin: fit it jointly in the final bundle adjustment (default true when edges are given). */
  coinJoint?: boolean;
  coinDiameterMm?: number;
  coinThicknessMm?: number;
  coinWeight?: number;
  /** Share of the views that must be registered for the result to be accepted (default 0.9). */
  minRegisteredShare?: number;
  seed?: number;
  /** Progress / diagnostics. */
  log?: (s: string) => void;
}

export interface SfmPoint {
  X: V3;
  /** (view index, pixel) observations kept after outlier removal. */
  obs: { view: number; u: number; v: number }[];
}

export interface SfmResult {
  /** A reconstruction was produced (it may still be refused below). */
  ok: boolean;
  failure?: string;
  /** Usable: ok AND at least `minRegisteredShare` of the views registered. A partial registration is refused: in the
   *  SIMULATED grid every partial run (wood grain, the plaid cloth, frames 10 or 15 degrees apart) was also wrong, some
   *  with a low reprojection RMS (a self-consistent but false geometry from a repetitive texture). */
  accepted: boolean;
  refusal: string | null;
  cam: Cam;
  /** World-to-camera poses in the SfM frame (arbitrary similarity), null when the view was not registered. */
  poses: (BACamera | null)[];
  points: SfmPoint[];
  rmsPx: number;
  registered: number;
  init: { pair: [number, number]; model: "homography" | "essential"; focalPrior: number } | null;
  pairStats: { a: number; b: number; matches: number; verified: number }[];
  featureCounts: number[];
  /** Coin: the post-hoc fit (coin/sceneScale.ts fitCoinCircle3D on the final SfM poses) and the joint fit. */
  coinPostHoc: { circle: CoinState; rmsPx: number; views: number } | null;
  coinJoint: { circle: CoinState; rmsPx: number; views: number } | null;
  timingsMs: { features: number; matching: number; init: number; incremental: number; finalBA: number; coin: number; total: number };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Pairs to match: those whose guide directions (elevation, azimuth) are within `windowDeg` on the viewing sphere, or
 *  all pairs when the metadata is missing or `all` is set. */
export function candidatePairs(views: readonly SfmView[], all = false, windowDeg = 65): [number, number][] {
  const out: [number, number][] = [];
  const meta = views.every((v) => v.elevationDeg !== undefined);
  const dir = (v: SfmView): V3 => {
    const e = ((v.elevationDeg ?? 0) * Math.PI) / 180, a = ((v.azimuthDeg ?? 0) * Math.PI) / 180;
    return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
  };
  const cosW = Math.cos((windowDeg * Math.PI) / 180);
  for (let i = 0; i < views.length; i++)
    for (let j = i + 1; j < views.length; j++) {
      if (all || !meta) {
        out.push([i, j]);
        continue;
      }
      const a = dir(views[i]), b = dir(views[j]);
      if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] >= cosW - 1e-9) out.push([i, j]);
    }
  return out;
}

class UnionFind {
  p: Int32Array;
  constructor(n: number) {
    this.p = new Int32Array(n).map((_, i) => i);
  }
  find(a: number): number {
    while (this.p[a] !== a) a = this.p[a] = this.p[this.p[a]];
    return a;
  }
  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p[ra] = rb;
  }
}

interface Track {
  /** view index -> feature index */
  obs: Map<number, number>;
  X: V3 | null;
}

export function runSfm(views: readonly SfmView[], opts: SfmOptions = {}): SfmResult {
  const t0 = now();
  const log = opts.log ?? (() => {});
  const W = views[0].image.width, H = views[0].image.height;
  const fPrior = W / 2 / Math.tan(((opts.hfovPriorDeg ?? 67.5) * Math.PI) / 360);
  let cam: Cam = { f: fPrior, cx: W / 2, cy: H / 2, k1: 0, k2: 0 };
  const verifyPx = opts.verifyPx ?? 4, inlierPx = opts.inlierPx ?? 3;
  const rng = makeRng(opts.seed ?? 1);
  const timings = { features: 0, matching: 0, init: 0, incremental: 0, finalBA: 0, coin: 0, total: 0 };
  let pairStats: SfmResult["pairStats"] = [];
  let featureCounts: number[] = [];
  const fail = (failure: string): SfmResult => {
    timings.total = now() - t0;
    return { ok: false, failure, accepted: false, refusal: failure, cam, poses: views.map(() => null), points: [], rmsPx: NaN, registered: 0, init: null, pairStats, featureCounts, coinPostHoc: null, coinJoint: null, timingsMs: timings };
  };

  // 1. features
  const feats: Features[] = views.map((v) => detectFeatures(v.image, { ...(opts.detect ?? {}), exclude: v.exclude ?? null }));
  const t1 = now();
  timings.features = t1 - t0;
  featureCounts = feats.map((f) => f.count);
  log(`features ${feats.map((f) => f.count).join(",")} in ${(timings.features / 1000).toFixed(1)} s`);

  // 2. matching + verification
  const pairs = candidatePairs(views, opts.allPairs, opts.pairWindowDeg ?? 65);
  const verified: { a: number; b: number; m: [number, number][] }[] = [];
  const norm = (vi: number, k: number): [number, number] => undistort(cam, feats[vi].x[k], feats[vi].y[k]);
  for (const [a, b] of pairs) {
    const m = matchFeatures(feats[a], feats[b]);
    let keep: [number, number][] = [];
    if (m.length >= 15) {
      const pa = m.map(([i]) => norm(a, i)), pb = m.map(([, j]) => norm(b, j));
      const F = ransacFundamental(pa, pb, verifyPx / cam.f, rng, 600);
      const Hm = ransacHomography(pa, pb, verifyPx / cam.f, rng, 400);
      const inl = new Set<number>(F && F.inliers.length >= 15 ? F.inliers : Hm ? Hm.inliers : []);
      keep = m.filter((_, i) => inl.has(i));
    }
    pairStats.push({ a, b, matches: m.length, verified: keep.length });
    if (keep.length >= (opts.minPairMatches ?? 30)) verified.push({ a, b, m: keep });
  }
  const t2 = now();
  timings.matching = t2 - t1;
  log(`matched ${pairs.length} pairs, ${verified.length} verified, in ${(timings.matching / 1000).toFixed(1)} s`);
  if (!verified.length) return fail("no_matches");

  // 3. tracks
  const offs: number[] = [];
  let total = 0;
  for (const f of feats) (offs.push(total), (total += f.count));
  const uf = new UnionFind(total);
  for (const p of verified) for (const [i, j] of p.m) uf.union(offs[p.a] + i, offs[p.b] + j);
  const byRoot = new Map<number, Track>();
  const conflict = new Set<number>();
  for (const p of verified)
    for (const [i, j] of p.m)
      for (const [vi, k] of [[p.a, i], [p.b, j]] as const) {
        const r = uf.find(offs[vi] + k);
        let t = byRoot.get(r);
        if (!t) byRoot.set(r, (t = { obs: new Map(), X: null }));
        const prev = t.obs.get(vi);
        if (prev !== undefined && prev !== k) conflict.add(r);
        t.obs.set(vi, k);
      }
  const tracks: Track[] = [];
  for (const [r, t] of byRoot) if (!conflict.has(r) && t.obs.size >= 2) tracks.push(t);
  log(`${tracks.length} tracks (${conflict.size} dropped for conflicts)`);

  // 4. initial pair: among the pairs with at least half the best match count, the widest guide separation (parallax)
  const ranked = [...verified].sort((p, q) => q.m.length - p.m.length);
  const sep = (p: { a: number; b: number }) => {
    const va = views[p.a], vb = views[p.b];
    if (va.elevationDeg === undefined || vb.elevationDeg === undefined) return 0;
    const d = (v: SfmView): V3 => {
      const e = ((v.elevationDeg ?? 0) * Math.PI) / 180, a = ((v.azimuthDeg ?? 0) * Math.PI) / 180;
      return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
    };
    const x = d(va), y = d(vb);
    return Math.acos(Math.min(1, x[0] * y[0] + x[1] * y[1] + x[2] * y[2]));
  };
  const strong = ranked.filter((p) => p.m.length >= 0.5 * ranked[0].m.length);
  const initPair = strong.reduce((best, p) => (sep(p) > sep(best) + 1e-9 ? p : best), strong[0]);
  const pa = initPair.m.map(([i]) => norm(initPair.a, i)), pb = initPair.m.map(([, j]) => norm(initPair.b, j));
  const F = ransacFundamental(pa, pb, inlierPx / cam.f, rng, 1500);
  const Hm = ransacHomography(pa, pb, inlierPx / cam.f, rng, 1500);
  const planar = !!Hm && (!F || Hm.inliers.length >= 0.85 * F.inliers.length);
  const candidates: { R: M3; t: V3 }[] = [];
  if (planar && Hm) {
    const ia = Hm.inliers.map((i) => pa[i]), ib = Hm.inliers.map((i) => pb[i]);
    for (const s of decomposeHomography(Hm.M, ia, ib).slice(0, 2)) candidates.push({ R: s.R, t: s.t });
  } else if (F) {
    const ia = F.inliers.map((i) => pa[i]), ib = F.inliers.map((i) => pb[i]);
    const e = poseFromEssential(projectEssential(F.M), ia, ib);
    candidates.push({ R: e.R, t: e.t });
  }
  if (!candidates.length) return fail("no_initial_pair");
  log(`init pair ${views[initPair.a].id}-${views[initPair.b].id}: ${initPair.m.length} matches, ${planar ? "homography (planar)" : "essential"}, ${candidates.length} candidate(s)`);

  // 5. incremental reconstruction from one initial candidate
  const obsPx = (vi: number, k: number): [number, number] => [feats[vi].x[k], feats[vi].y[k]];
  const runFrom = (cand: { R: M3; t: V3 }, maxViews: number) => {
    const poses: (BACamera | null)[] = views.map(() => null);
    let c: Cam = { ...cam };
    const tr: Track[] = tracks.map((t) => ({ obs: new Map(t.obs), X: null }));
    const I: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const tn = Math.hypot(...cand.t) || 1;
    poses[initPair.a] = { R: I, t: [0, 0, 0] };
    poses[initPair.b] = { R: cand.R, t: [cand.t[0] / tn, cand.t[1] / tn, cand.t[2] / tn] };
    const triangulateNew = (minAngle: number) => {
      for (const t of tr) {
        if (t.X) continue;
        const o: { R: readonly number[]; t: V3; x: number; y: number; vi: number }[] = [];
        for (const [vi, k] of t.obs) {
          const p = poses[vi];
          if (!p) continue;
          const [x, y] = undistort(c, feats[vi].x[k], feats[vi].y[k]);
          o.push({ R: p.R, t: p.t, x, y, vi });
        }
        if (o.length < 2) continue;
        const X = triangulate(o);
        if (!X) continue;
        let ok = true;
        for (const q of o) {
          const pr = projectPx(c, q.R, q.t, X);
          const [u, v] = obsPx(q.vi, t.obs.get(q.vi)!);
          if (!pr || Math.hypot(pr[0] - u, pr[1] - v) > inlierPx * 1.5) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (triangulationAngleDeg(X, o.map((q) => centreOf(q.R, q.t))) < minAngle) continue;
        t.X = X;
      }
    };
    const ba = (refineFocal: boolean, refineK1: boolean, refineK2: boolean, iterations = 15, fixFirst = false) => {
      const ptIdx: number[] = [];
      const camIdx: number[] = [];
      const map = new Map<number, number>();
      poses.forEach((p, i) => {
        if (p) (map.set(i, camIdx.length), camIdx.push(i));
      });
      const obsCam: number[] = [], obsPt: number[] = [], obsU: number[] = [], obsV: number[] = [];
      const pts: number[] = [];
      tr.forEach((t, ti) => {
        if (!t.X) return;
        let n = 0;
        for (const [vi] of t.obs) if (map.has(vi)) n++;
        if (n < 2) return;
        const pi = ptIdx.length;
        ptIdx.push(ti);
        pts.push(...t.X);
        for (const [vi, k] of t.obs) {
          if (!map.has(vi)) continue;
          obsCam.push(map.get(vi)!);
          obsPt.push(pi);
          obsU.push(feats[vi].x[k]);
          obsV.push(feats[vi].y[k]);
        }
      });
      const prob: BAProblem = { cams: camIdx.map((i) => poses[i]!), cam: c, points: Float64Array.from(pts), obsCam: Int32Array.from(obsCam), obsPt: Int32Array.from(obsPt), obsU: Float64Array.from(obsU), obsV: Float64Array.from(obsV) };
      const r = bundleAdjust(prob, { refineFocal, refineK1, refineK2, iterations, fixedCams: fixFirst ? new Set([map.get(initPair.a)!]) : undefined });
      camIdx.forEach((vi, j) => (poses[vi] = prob.cams[j]));
      c = prob.cam;
      ptIdx.forEach((ti, j) => (tr[ti].X = [prob.points[j * 3], prob.points[j * 3 + 1], prob.points[j * 3 + 2]]));
      return r;
    };
    const filterOutliers = (px: number) => {
      let removed = 0;
      for (const t of tr) {
        if (!t.X) continue;
        for (const [vi, k] of [...t.obs]) {
          const p = poses[vi];
          if (!p) continue;
          const pr = projectPx(c, p.R, p.t, t.X);
          const [u, v] = obsPx(vi, k);
          if (!pr || Math.hypot(pr[0] - u, pr[1] - v) > px) {
            t.obs.delete(vi);
            removed++;
          }
        }
        let n = 0;
        for (const [vi] of t.obs) if (poses[vi]) n++;
        if (n < 2) t.X = null;
      }
      return removed;
    };
    triangulateNew(1.0);
    ba(false, false, false, 10, true);
    filterOutliers(inlierPx * 2);
    const failed = new Set<number>();
    let registered = 2;
    let lastBA = 2;
    while (registered < maxViews) {
      // the unregistered view seeing the most triangulated points
      let best = -1, bestN = 0;
      views.forEach((_, vi) => {
        if (poses[vi] || failed.has(vi)) return;
        let n = 0;
        for (const t of tr) if (t.X && t.obs.has(vi)) n++;
        if (n > bestN) ((bestN = n), (best = vi));
      });
      if (best < 0 || bestN < 12) break;
      const X: V3[] = [], x: [number, number][] = [];
      for (const t of tr)
        if (t.X && t.obs.has(best)) {
          X.push(t.X);
          x.push(undistort(c, feats[best].x[t.obs.get(best)!], feats[best].y[t.obs.get(best)!]));
        }
      const pnp = pnpRansac(X, x, inlierPx / c.f, rng, 500);
      if (!pnp || pnp.inliers.length < 12 || pnp.inliers.length < 0.25 * X.length) {
        failed.add(best);
        continue;
      }
      poses[best] = { R: pnp.R, t: pnp.t };
      registered++;
      failed.clear();
      triangulateNew(1.5);
      // global bundle adjustment on a geometric schedule (every view at first, then each time the set grows ~15 %)
      if (registered <= 8 || registered >= 1.15 * lastBA) {
        const many = registered >= 5;
        ba(many, many, false, 10);
        filterOutliers(inlierPx * 1.5);
        lastBA = registered;
      }
      triangulateNew(1.5);
    }
    return {
      poses,
      get cam() {
        return c;
      },
      set cam(v: Cam) {
        c = v;
      },
      tracks: tr,
      registered,
      ba,
      filterOutliers,
      triangulateNew,
    };
  };

  const t3 = now();
  timings.init = t3 - t2;
  let state = runFrom(candidates[0], candidates.length > 1 ? Math.min(6, views.length) : views.length);
  if (candidates.length > 1) {
    const alt = runFrom(candidates[1], Math.min(6, views.length));
    const score = (s: typeof state) => s.registered * 1000 - s.ba(false, false, false, 1).rmsPx;
    const pick = score(alt) > score(state) ? 1 : 0;
    log(`homography candidates registered ${state.registered} / ${alt.registered} views; using #${pick}`);
    state = runFrom(candidates[pick], views.length);
  }
  const t4 = now();
  timings.incremental = t4 - t3;
  if (state.registered < 3) return fail("too_few_views_registered");

  // 6. final bundle adjustment: focal, k1, k2; outliers; again
  state.ba(true, true, false, 30);
  state.filterOutliers(inlierPx);
  state.triangulateNew(1.5);
  let fin = state.ba(true, true, opts.refineK2 ?? true, 40);
  state.filterOutliers(inlierPx);
  fin = state.ba(true, true, opts.refineK2 ?? true, 40);
  cam = state.cam;
  const t5 = now();
  timings.finalBA = t5 - t4;

  // 7. coin: post-hoc fit on the final poses, then (optionally) the joint bundle adjustment
  let coinPostHoc: SfmResult["coinPostHoc"] = null, coinJoint: SfmResult["coinJoint"] = null;
  const coinViews = views.map((v, i) => ({ i, pts: v.coinEdges })).filter((v) => v.pts && v.pts.length >= 12 && state.poses[v.i]);
  if (coinViews.length >= 2) {
    const D = opts.coinDiameterMm ?? 23.0, T = opts.coinThicknessMm ?? 1.5;
    const und = (pts: readonly Pt[]) =>
      pts.map((p) => {
        const [x, y] = undistort(cam, p.x, p.y);
        return { x: cam.f * x + cam.cx, y: cam.f * y + cam.cy };
      });
    const fit = fitCoinCircle3D(
      coinViews.map((v) => ({ K: { fx: cam.f, fy: cam.f, cx: cam.cx, cy: cam.cy }, pose: { R: state.poses[v.i]!.R, t: state.poses[v.i]!.t }, points: und(v.pts!) })),
      { diameterMm: D, thicknessMm: T, model: "cylinder" },
    );
    log(`coin post-hoc fit on ${coinViews.length} views: ${fit.ok ? `radius ${fit.circle!.radius.toFixed(4)} units, rms ${fit.circle!.rmsPx.toFixed(2)} px` : `failed (${fit.reason})`}`);
    if (fit.ok && fit.circle) {
      coinPostHoc = { circle: { centre: [...fit.circle.center] as V3, normal: [...fit.circle.normal] as V3, radius: fit.circle.radius }, rmsPx: fit.circle.rmsPx, views: coinViews.length };
      if (opts.coinJoint ?? true) {
        // joint: rebuild the problem with the coin observations
        const camIdx: number[] = [];
        const map = new Map<number, number>();
        state.poses.forEach((p, i) => {
          if (p) (map.set(i, camIdx.length), camIdx.push(i));
        });
        const obsCam: number[] = [], obsPt: number[] = [], obsU: number[] = [], obsV: number[] = [];
        const pts: number[] = [];
        const ptIdx: number[] = [];
        state.tracks.forEach((t, ti) => {
          if (!t.X) return;
          const o = [...t.obs].filter(([vi]) => map.has(vi));
          if (o.length < 2) return;
          const pi = ptIdx.length;
          ptIdx.push(ti);
          pts.push(...t.X);
          for (const [vi, k] of o) {
            obsCam.push(map.get(vi)!);
            obsPt.push(pi);
            obsU.push(feats[vi].x[k]);
            obsV.push(feats[vi].y[k]);
          }
        });
        const prob: BAProblem = {
          cams: camIdx.map((i) => state.poses[i]!),
          cam,
          points: Float64Array.from(pts),
          obsCam: Int32Array.from(obsCam),
          obsPt: Int32Array.from(obsPt),
          obsU: Float64Array.from(obsU),
          obsV: Float64Array.from(obsV),
          coin: { views: coinViews.map((v) => ({ cam: map.get(v.i)!, pts: v.pts! })), thicknessRatio: T / D, state: { ...coinPostHoc.circle } },
        };
        const r = bundleAdjust(prob, { refineFocal: true, refineK1: true, refineK2: opts.refineK2 ?? true, iterations: 30, coinWeight: opts.coinWeight ?? 1 });
        camIdx.forEach((vi, j) => (state.poses[vi] = prob.cams[j]));
        ptIdx.forEach((ti, j) => (state.tracks[ti].X = [prob.points[j * 3], prob.points[j * 3 + 1], prob.points[j * 3 + 2]]));
        cam = prob.cam;
        state.cam = cam;
        fin = { ...fin, rmsPx: r.rmsPx };
        coinJoint = { circle: prob.coin!.state, rmsPx: r.coinRmsPx ?? NaN, views: coinViews.length };
      }
    }
  }
  const t6 = now();
  timings.coin = t6 - t5;

  const points: SfmPoint[] = [];
  for (const t of state.tracks) {
    if (!t.X) continue;
    const obs = [...t.obs].filter(([vi]) => state.poses[vi]).map(([vi, k]) => ({ view: vi, u: feats[vi].x[k], v: feats[vi].y[k] }));
    if (obs.length >= 2) points.push({ X: t.X, obs });
  }
  timings.total = now() - t0;
  log(`registered ${state.registered}/${views.length}, ${points.length} points, rms ${fin.rmsPx.toFixed(3)} px, f ${cam.f.toFixed(1)} k1 ${cam.k1.toFixed(4)} k2 ${cam.k2.toFixed(4)}`);
  const share = state.registered / views.length;
  const accepted = share >= (opts.minRegisteredShare ?? 0.9);
  return {
    ok: true,
    accepted,
    refusal: accepted ? null : `only ${state.registered} of ${views.length} views registered`,
    cam,
    poses: state.poses,
    points,
    rmsPx: fin.rmsPx,
    registered: state.registered,
    init: { pair: [initPair.a, initPair.b], model: planar ? "homography" : "essential", focalPrior: fPrior },
    pairStats,
    featureCounts,
    coinPostHoc,
    coinJoint,
    timingsMs: timings,
  };
}

/** Camera centre of a pose (world). */
export const poseCentre = (p: BACamera): V3 => centreOf(p.R, p.t);
/** Relative rotation between two poses (R_b R_a^T) and a translation-free helper for evaluation. */
export const relRot = (a: BACamera, b: BACamera): M3 => m3mul(b.R, m3T(a.R));
export { m3v, vsub };
