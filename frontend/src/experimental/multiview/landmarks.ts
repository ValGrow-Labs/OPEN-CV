// Triangulation of 2D hand landmarks across calibrated views (EXPERIMENTAL, multi-view board reconstruction).
//
// Input: per view the camera intrinsics, the board-to-camera pose and MediaPipe's 21 hand landmarks in PIXELS of that
// view's picture (null for a missing landmark, or no landmarks at all for a view without a detection). Output: the 21
// landmarks in board millimetres, per-landmark and per-view reprojection residuals, and a HAND-MOVED check.
//
// Method per landmark: linear DLT on the undistorted normalised coordinates (smallest eigenvector of A^T A), then
// Levenberg-Marquardt on the pixel reprojection error (distortion included). Observations more than a robust
// threshold off are dropped (a wrong detection in one view) and the point re-solved.
//
// Hand-moved check: every view is scored by the reprojection error of ITS landmarks against points triangulated from
// the OTHER views only (leave-one-view-out), so a view that disagrees cannot pull the reference toward itself. A view
// is named as disagreeing when its median error exceeds max(movedMinPx, movedFactor x the median over views), or when
// the MEAN error vector of its landmarks (a coherent shift, which a rigid movement causes and independent noise does
// not) exceeds max(shiftMinPx, shiftFactor x sigma / sqrt(n)); the check is repeated without the named views. A
// movement along a view's line of sight barely moves the landmarks in that view and is not seen there. It cannot tell WHY a view disagrees: the hand moved, the board pose of that view is
// wrong, or the landmark detector failed in it. All three must reject the view.
//
// Landmarks from a 2D detector are not the skin surface: MediaPipe places joints inside the finger, and its error is
// several pixels on real pictures and correlated between neighbouring joints. Nothing here was measured on real data.
import type { CameraPose, Intrinsics, Pt, Pt3 } from "../common";
import { fingersFromLandmarks, frameFromLandmarks, type FingerAxis, type HandFrame } from "../reconstruction/measure";
import { projectPoint, symmetricEigen, type Vec3 } from "../reconstruction/linalg";
import { pixelToNormalized } from "./image";

export interface LandmarkView {
  id?: string;
  intrinsics: Intrinsics;
  pose: CameraPose;
  /** 21 entries in pixels of this view (null = not detected); null / undefined = no detection in this view. */
  landmarks?: readonly (Pt | null)[] | null;
}

export interface TriangulationOptions {
  /** Views a landmark needs. Default 2. */
  minViews: number;
  /** Levenberg-Marquardt iterations per point. Default 15. */
  iterations: number;
  /** An observation is dropped when its residual exceeds max(outlierPx, outlierFactor x the median residual of the point). */
  outlierPx: number;
  outlierFactor: number;
  /** Hand-moved check: a view disagrees when its median leave-one-out error exceeds max(movedMinPx, movedFactor x the
   *  median over views). */
  movedMinPx: number;
  movedFactor: number;
  /** ... or when the mean leave-one-out error VECTOR of its landmarks (a coherent shift) is longer than
   *  max(shiftMinPx, shiftFactor x sigma / sqrt(landmarks), movedFactor x the median shift over views), sigma
   *  estimated from the typical error. */
  shiftMinPx: number;
  shiftFactor: number;
  /** Rounds of the hand-moved check (each re-run without the views named so far). Default 3. */
  movedRounds: number;
}

export const DEFAULT_TRIANGULATION_OPTIONS: TriangulationOptions = {
  minViews: 2,
  iterations: 15,
  outlierPx: 8,
  outlierFactor: 4,
  movedMinPx: 3,
  movedFactor: 3,
  shiftMinPx: 1.5,
  shiftFactor: 5,
  movedRounds: 3,
};

export interface TriangulatedLandmark {
  index: number;
  point: Pt3 | null;
  /** Views whose observation was used, and those dropped as outliers. */
  usedViews: number[];
  droppedViews: number[];
  /** RMS reprojection error over the used observations (px). */
  rmsPx: number | null;
  /** Residual per view (px; null when the view has no observation of this landmark), against the final point. */
  residualsPx: (number | null)[];
}

export interface ViewAgreement {
  id: string;
  index: number;
  observations: number;
  /** Against points from all accepted views. */
  medianPx: number | null;
  rmsPx: number | null;
  /** Leave-one-view-out: against points triangulated from the other accepted views only: the median error, and the
   *  length of the mean error vector (a coherent shift of the whole hand in this view). */
  looMedianPx: number | null;
  looShiftPx: number | null;
  disagrees: boolean;
}

export interface TriangulationResult {
  /** 21 points in board millimetres (null when fewer than minViews accepted views saw it). */
  points: (Pt3 | null)[];
  landmarks: TriangulatedLandmark[];
  views: ViewAgreement[];
  /** Views named by the hand-moved check (their ids); they are excluded from `points`. */
  disagreeingViews: string[];
  handMoved: boolean;
  /** The thresholds the check used in its last round (px): on the median error, and on the coherent shift (for a view
   *  with all 21 landmarks). */
  thresholdPx: number;
  shiftThresholdPx: number;
  notes: string[];
}

interface Obs {
  view: number;
  K: Intrinsics;
  pose: CameraPose;
  u: number;
  v: number;
}

/** One point from two or more calibrated observations: DLT, then Levenberg-Marquardt on pixel error. */
export function triangulatePoint(obs: readonly { K: Intrinsics; pose: CameraPose; u: number; v: number }[], iterations = 15): { X: Vec3; rmsPx: number } | null {
  if (obs.length < 2) return null;
  const A = new Array<number>(16).fill(0);
  for (const o of obs) {
    const [x, y] = pixelToNormalized(o.K, o.u, o.v);
    const R = o.pose.R, t = o.pose.t;
    // world scaled by 1/100 for conditioning: X = 100 X'
    const P = [100 * R[0], 100 * R[1], 100 * R[2], t[0], 100 * R[3], 100 * R[4], 100 * R[5], t[1], 100 * R[6], 100 * R[7], 100 * R[8], t[2]];
    const rows = [
      [x * P[8] - P[0], x * P[9] - P[1], x * P[10] - P[2], x * P[11] - P[3]],
      [y * P[8] - P[4], y * P[9] - P[5], y * P[10] - P[6], y * P[11] - P[7]],
    ];
    for (const r of rows) for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) A[i * 4 + j] += r[i] * r[j];
  }
  const { vectors } = symmetricEigen(A, 4);
  const v = vectors[3];
  if (Math.abs(v[3]) < 1e-12) return null;
  let X: Vec3 = [(100 * v[0]) / v[3], (100 * v[1]) / v[3], (100 * v[2]) / v[3]];
  // Levenberg-Marquardt, numeric Jacobian (3 unknowns)
  const resid = (P: Vec3): number[] | null => {
    const r: number[] = [];
    for (const o of obs) {
      const q = projectPoint(P, o.K, o.pose);
      if (!q) return null;
      r.push(q.u - o.u, q.v - o.v);
    }
    return r;
  };
  let r = resid(X);
  if (!r) return null;
  let cost = r.reduce((s, e) => s + e * e, 0);
  let lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    const J: number[][] = [];
    const h = 1e-3;
    for (let k = 0; k < 3; k++) {
      const Xp: Vec3 = [X[0], X[1], X[2]];
      Xp[k] += h;
      const rp = resid(Xp);
      if (!rp) return null;
      J.push(rp.map((e, i) => (e - r![i]) / h));
    }
    const JTJ = [0, 0, 0, 0, 0, 0, 0, 0, 0], JTr = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) for (let i = 0; i < r.length; i++) JTJ[a * 3 + b] += J[a][i] * J[b][i];
      for (let i = 0; i < r.length; i++) JTr[a] += J[a][i] * r[i];
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = JTJ.slice();
      for (let a = 0; a < 3; a++) M[a * 4] *= 1 + lambda;
      const d = solve3(M, [-JTr[0], -JTr[1], -JTr[2]]);
      if (!d) break;
      const Xn: Vec3 = [X[0] + d[0], X[1] + d[1], X[2] + d[2]];
      const rn = resid(Xn);
      const cn = rn ? rn.reduce((s, e) => s + e * e, 0) : Infinity;
      if (cn < cost) {
        X = Xn;
        r = rn!;
        const done = cost - cn < 1e-10 * (1 + cost);
        cost = cn;
        lambda = Math.max(lambda / 10, 1e-9);
        improved = true;
        if (done) it = iterations;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { X, rmsPx: Math.sqrt(cost / obs.length) };
}

function solve3(M: number[], b: number[]): number[] | null {
  const [a, bb, c, d, e, f, g, h, i] = M;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-18) return null;
  return [
    (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ];
}

const med = (a: number[]): number | null => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function reprojPx(X: Vec3, o: Obs): number | null {
  const q = projectPoint(X, o.K, o.pose);
  return q ? Math.hypot(q.u - o.u, q.v - o.v) : null;
}

/** Triangulate one landmark from the given observations with outlier dropping. */
function solveLandmark(obs: Obs[], o: TriangulationOptions): { X: Vec3; used: Obs[]; dropped: Obs[]; rmsPx: number } | null {
  let used = obs.slice();
  const dropped: Obs[] = [];
  for (let round = 0; round < 3; round++) {
    if (used.length < o.minViews) return null;
    const s = triangulatePoint(used, o.iterations);
    if (!s) return null;
    const res = used.map((ob) => reprojPx(s.X, ob) ?? Infinity);
    const m = med(res) ?? 0;
    const thr = Math.max(o.outlierPx, o.outlierFactor * m);
    let worst = -1;
    for (let i = 0; i < res.length; i++) if (res[i] > thr && (worst < 0 || res[i] > res[worst])) worst = i;
    if (worst < 0 || used.length - 1 < Math.max(o.minViews, 3)) return { X: s.X, used, dropped, rmsPx: s.rmsPx };
    dropped.push(used[worst]);
    used = used.filter((_, i) => i !== worst);
  }
  const s = triangulatePoint(used, o.iterations);
  return s ? { X: s.X, used, dropped, rmsPx: s.rmsPx } : null;
}

export function triangulateLandmarks(views: readonly LandmarkView[], options: Partial<TriangulationOptions> = {}): TriangulationResult {
  const o = { ...DEFAULT_TRIANGULATION_OPTIONS, ...options };
  const ids = views.map((v, i) => v.id ?? `view-${i}`);
  const obsOf = (lm: number, exclude: Set<number>): Obs[] => {
    const out: Obs[] = [];
    views.forEach((v, i) => {
      if (exclude.has(i)) return;
      const p = v.landmarks?.[lm];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out.push({ view: i, K: v.intrinsics, pose: v.pose, u: p.x, v: p.y });
    });
    return out;
  };
  const rejected = new Set<number>();
  let thresholdPx = o.movedMinPx;
  const notes: string[] = [];
  const looMedian = new Array<number | null>(views.length).fill(null);
  const looShift = new Array<number | null>(views.length).fill(null);
  const looCount = new Array<number>(views.length).fill(0);
  let shiftThresholdPx = o.shiftMinPx;
  for (let round = 0; round < o.movedRounds; round++) {
    // leave-one-view-out score for every view (rejected views are scored against the accepted ones): the median
    // error magnitude, and the length of the MEAN error vector (a rigid movement shifts all landmarks coherently,
    // while independent noise averages out over the landmarks)
    for (let vi = 0; vi < views.length; vi++) {
      const errs: number[] = [];
      let sx = 0, sy = 0;
      for (let lm = 0; lm < 21; lm++) {
        const mine = obsOf(lm, new Set()).find((ob) => ob.view === vi);
        if (!mine) continue;
        const ex = new Set(rejected);
        ex.add(vi);
        const s = solveLandmark(obsOf(lm, ex), o);
        if (!s) continue;
        const q = projectPoint(s.X, mine.K, mine.pose);
        if (!q) continue;
        errs.push(Math.hypot(q.u - mine.u, q.v - mine.v));
        sx += mine.u - q.u;
        sy += mine.v - q.v;
      }
      looMedian[vi] = med(errs);
      looCount[vi] = errs.length;
      looShift[vi] = errs.length ? Math.hypot(sx, sy) / errs.length : null;
    }
    const acceptedScores = looMedian.filter((s, i) => s !== null && !rejected.has(i)) as number[];
    const typical = med(acceptedScores) ?? 0;
    thresholdPx = Math.max(o.movedMinPx, o.movedFactor * typical);
    // per-landmark noise sigma from the typical median magnitude (median of a 2D Gaussian magnitude = 1.177 sigma)
    const sigma = typical / 1.177;
    // ... and relative to the typical coherent shift: when every view is shifted (wrong poses everywhere), only the
    // views that stand out are named
    const typicalShift = med(looShift.filter((x, i) => x !== null && !rejected.has(i)) as number[]) ?? 0;
    let added = false;
    looMedian.forEach((s, i) => {
      if (s === null || rejected.has(i)) return;
      const shiftThr = Math.max(o.shiftMinPx, (o.shiftFactor * sigma) / Math.sqrt(Math.max(1, looCount[i])), o.movedFactor * typicalShift);
      if (s > thresholdPx || (looCount[i] >= 5 && looShift[i]! > shiftThr)) {
        rejected.add(i);
        added = true;
      }
    });
    shiftThresholdPx = Math.max(o.shiftMinPx, (o.shiftFactor * sigma) / Math.sqrt(21), o.movedFactor * typicalShift);
    if (!added) break;
    if (views.length - rejected.size < 2) {
      notes.push("fewer than two views agree: no consistent triangulation");
      break;
    }
  }

  const landmarks: TriangulatedLandmark[] = [];
  const points: (Pt3 | null)[] = [];
  for (let lm = 0; lm < 21; lm++) {
    const s = solveLandmark(obsOf(lm, rejected), o);
    const all = obsOf(lm, new Set());
    const residualsPx = views.map((_, vi) => {
      const ob = all.find((x) => x.view === vi);
      return ob && s ? reprojPx(s.X, ob) : null;
    });
    points.push(s ? { x: s.X[0], y: s.X[1], z: s.X[2] } : null);
    landmarks.push({ index: lm, point: points[lm], usedViews: s ? s.used.map((u) => u.view) : [], droppedViews: s ? s.dropped.map((u) => u.view) : [], rmsPx: s ? s.rmsPx : null, residualsPx });
  }
  const viewsOut: ViewAgreement[] = views.map((_, vi) => {
    const r = landmarks.map((l) => l.residualsPx[vi]).filter((x): x is number => x !== null);
    return {
      id: ids[vi],
      index: vi,
      observations: r.length,
      medianPx: med(r),
      rmsPx: r.length ? Math.sqrt(r.reduce((s, e) => s + e * e, 0) / r.length) : null,
      looMedianPx: looMedian[vi],
      looShiftPx: looShift[vi],
      disagrees: rejected.has(vi),
    };
  });
  const missing = points.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) notes.push(`landmarks not triangulated (too few views): ${missing.join(", ")}`);
  const disagreeingViews = [...rejected].sort((a, b) => a - b).map((i) => ids[i]);
  if (disagreeingViews.length)
    notes.push(`views disagree with the others (hand moved, wrong board pose or a failed detection): ${disagreeingViews.join(", ")}`);
  return { points, landmarks, views: viewsOut, disagreeingViews, handMoved: disagreeingViews.length > 0, thresholdPx, shiftThresholdPx, notes };
}

/** The hand frame and finger axes for measureHand from triangulated landmarks (board mm). frameFromLandmarks takes
 *  the wrist (0) as origin, +y toward the middle MCP (9), +x from the index MCP (5) toward the little MCP (17) made
 *  orthogonal, +z = x cross y (out of the palm, matching the synthetic hand frame), and the knuckle line from the four
 *  MCPs; fingersFromLandmarks takes MCP (thumb: 2) to tip. Null / partial when the needed landmarks are missing. */
export function handFrameFromTriangulation(points: readonly (Pt3 | null)[]): { frame: HandFrame | null; fingers: FingerAxis[]; missing: number[] } {
  const missing = points.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  const needFrame = [0, 5, 9, 13, 17];
  if (needFrame.some((i) => !points[i])) return { frame: null, fingers: [], missing };
  const filled = points.map((p) => p ?? { x: NaN, y: NaN, z: NaN });
  const frame = frameFromLandmarks(filled);
  const ends: Record<FingerAxis["name"], [number, number]> = { thumb: [2, 4], index: [5, 8], middle: [9, 12], ring: [13, 16], little: [17, 20] };
  const fingers = fingersFromLandmarks(filled).filter((f) => points[ends[f.name][0]] && points[ends[f.name][1]]);
  return { frame, fingers, missing };
}
