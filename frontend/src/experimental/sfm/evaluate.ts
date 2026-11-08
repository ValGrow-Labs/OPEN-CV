// SIMULATED evaluation of the EXPERIMENTAL board-free structure from motion (sfm/): render a capture of the capsule
// hand on a table (scene.ts), run runSfm with nothing known, put the result in the metric table frame (frame.ts) and
// compare with the truth. Every number it produces is SIMULATED.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CameraPose, Intrinsics } from "../common";
import { triangulateLandmarks } from "../multiview/landmarks";
import { reconstructFromBoardViews, type BoardViewInput } from "../multiview/reconstruct";
import type { HandMeasurements } from "../reconstruction/measure";
import { boardRig, projectLandmarks, sceneTarget, type BoardCamera } from "../multiview/scene";
import { lookAtPose, type Vec3 } from "../reconstruction/linalg";
import { coinEdgePoints } from "./coinEdges";
import { camToIntrinsics, fitPlaneRansac, makeTableFrame, poseErrors, poseToTable, rigidOnly, similarityAlign, triangulatePixels, type PoseErrors, type TableFrame } from "./frame";
import { centreOf } from "./geometry";
import { m3v, vdot, vsub, type V3 } from "./mat";
import { finishRender, makeSfmScene, renderClean, SFM_SURFACE, surfaceMask, type CleanRender, type CoinPlacement, type SfmScene } from "./scene";
import { runSfm, type SfmOptions, type SfmResult, type SfmView } from "./sfm";
import type { TextureKind } from "./textures";

export interface Condition {
  texture: TextureKind;
  /** The stills of the board capture: 13 = top + 12 low; 17 = top + 16 low; 25 = top + 16 low + 8 at 35 degrees.
   *  With capture "sweep" these are the stills kept for the carving; the geometry uses every sweep frame. */
  views: 13 | 17 | 25;
  /** "stills" (default): only the stills above. "sweep": a continuous low ring (frames every `sweepStepDeg`) plus an
   *  arc from the ring up to the top view (elevations 18, 24, 30, 36, 45, 55, 65, 75 at azimuth 270), as video frames
   *  would give; the stills are among its frames. */
  capture?: "stills" | "sweep";
  sweepStepDeg?: number;
  hfovDeg?: number;
  k1?: number;
  k2?: number;
  blurSigmaPx?: number;
  noiseSigma?: number;
  /** Use features on the hand too (default false: the hand is excluded). */
  includeHand?: boolean;
  coin?: CoinPlacement;
  /** The coin thickness the fit ASSUMES (mm); default the rendered one (1.5 mm, itself unverified). */
  assumedCoinThicknessMm?: number;
  /** Extra Gaussian noise on the coin edge points (px). */
  coinEdgeNoisePx?: number;
  /** Landmark noise (px) for the table frame's in-plane axes (default 2, as recon/chain.test.ts). */
  landmarkNoisePx?: number;
  seed?: number;
}

export const ARC_ELEVATIONS = [18, 24, 30, 36, 45, 55, 65, 75];
const ARC_AZIMUTH = 270;

export function rigFor(scene: SfmScene, c: Condition): BoardCamera[] {
  const common = { width: 1280, height: 720, hfovDeg: c.hfovDeg ?? 64, k1: c.k1 ?? -0.06, k2: c.k2 ?? 0.02 };
  if (c.capture === "sweep") {
    const step = c.sweepStepDeg ?? 7.5;
    const n = Math.round(360 / step);
    const ring = boardRig(scene.hand, { ...common, lowCount: n, highCount: 0 }); // top + low ring
    const tgt = sceneTarget(scene.hand);
    const K = ring[0].intrinsics;
    const arc: BoardCamera[] = ARC_ELEVATIONS.map((el) => {
      const e = (el * Math.PI) / 180, a = (ARC_AZIMUTH * Math.PI) / 180;
      const eye: Vec3 = [tgt[0] + 340 * Math.cos(e) * Math.cos(a), tgt[1] + 340 * Math.cos(e) * Math.sin(a), tgt[2] + 340 * Math.sin(e)];
      // image "up": world +z on the ring, turning continuously into the top view's +y as the arc rises
      const up: Vec3 = el < 60 ? [0, 0, 1] : [0, 1, 0];
      return { id: `arc-${el}`, intrinsics: K, pose: lookAtPose(eye, tgt, up), elevationDeg: el, azimuthDeg: ARC_AZIMUTH };
    });
    return [...ring, ...arc];
  }
  if (c.views === 13) return boardRig(scene.hand, { ...common, lowCount: 12, highCount: 0 });
  if (c.views === 17) return boardRig(scene.hand, { ...common, lowCount: 16, highCount: 0 });
  return boardRig(scene.hand, { ...common, lowCount: 16, highCount: 8 });
}

/** A cache of clean renders keyed by scene + camera set (rendering is the slow part); optionally also on disk
 *  (`dir`, e.g. from the SFM_RENDER_CACHE environment variable) so repeated research runs skip the rendering. */
export class RenderCache {
  private m = new Map<string, { scene: SfmScene; cams: BoardCamera[]; clean: CleanRender[] }>();
  /** `maxEntries`: camera sets kept in memory (each 57-view set of clean 1280 x 720 renders is ~700 MB). */
  constructor(private dir: string | null = null, private maxEntries = 1) {}
  get(c: Condition): { scene: SfmScene; cams: BoardCamera[]; clean: CleanRender[] } {
    const key = this.keyOf(c);
    let e = this.m.get(key);
    if (!e) {
      const scene = makeSfmScene({ texture: c.texture, coin: c.coin });
      const cams = rigFor(scene, c);
      while (this.m.size >= this.maxEntries) this.m.delete(this.m.keys().next().value as string);
      e = { scene, cams, clean: cams.map((cam, i) => this.render(key, i, scene, cam)) };
      this.m.set(key, e);
    }
    return e;
  }
  /** Render a condition's pictures one at a time, yielding to the event loop between them (a test runner's RPC stays
   *  alive during long renders); afterwards `get` returns them from memory. */
  async warm(c: Condition): Promise<void> {
    const key = this.keyOf(c);
    if (this.m.has(key)) return;
    while (this.m.size >= this.maxEntries) this.m.delete(this.m.keys().next().value as string);
    const scene = makeSfmScene({ texture: c.texture, coin: c.coin });
    const cams = rigFor(scene, c);
    const clean: CleanRender[] = [];
    for (let i = 0; i < cams.length; i++) {
      await new Promise((r) => setTimeout(r, 0));
      clean.push(this.render(key, i, scene, cams[i]));
    }
    this.m.set(key, { scene, cams, clean });
  }
  private keyOf(c: Condition): string {
    return `${c.texture}|${c.coin ?? "table-side"}|${c.capture === "sweep" ? `sweep${c.sweepStepDeg ?? 7.5}` : c.views}|${c.hfovDeg ?? 64}|${c.k1 ?? -0.06}|${c.k2 ?? 0.02}`;
  }
  private render(key: string, i: number, scene: SfmScene, cam: BoardCamera): CleanRender {
    const file = this.dir ? join(this.dir, `${key.replace(/[^a-z0-9.-]+/gi, "_")}_${i}.bin`) : null;
    const { width: w, height: h } = cam.intrinsics;
    if (file && existsSync(file)) {
      const buf = readFileSync(file);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const n = w * h;
      return { width: w, height: h, planes: [new Float32Array(ab, 0, n), new Float32Array(ab, 4 * n, n), new Float32Array(ab, 8 * n, n)], surface: new Uint8Array(ab, 12 * n, n) };
    }
    const c = renderClean(scene, cam.intrinsics, cam.pose);
    if (file && this.dir) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, Buffer.concat([Buffer.from(c.planes[0].buffer), Buffer.from(c.planes[1].buffer), Buffer.from(c.planes[2].buffer), Buffer.from(c.surface.buffer)]));
    }
    return c;
  }
}

export interface MetricResult {
  /** Coin scale (mm per SfM unit) relative to the truth (similarity of the camera centres): +0.01 = 1 % too large. */
  scaleErr: number;
  /** Poses in the metric table frame compared with the truth with NO alignment (what the carving would get). */
  direct: PoseErrors;
  /** After a rigid (6 dof, no scale) alignment: the metric pose quality without the frame-definition error. */
  rigid: PoseErrors;
  frame: TableFrame;
  poses: (CameraPose | null)[];
}

export interface ConditionResult {
  condition: Condition;
  sfm: SfmResult;
  views: number;
  registered: number;
  focalTrue: number;
  focalErr: number;
  k1: number;
  k2: number;
  /** Up to scale: similarity-aligned pose errors. */
  similarity: PoseErrors;
  /** Table plane after the similarity alignment: normal angle to the true normal (deg), height at the hand (mm). */
  planeAngleDeg: number;
  planeHeightMm: number;
  postHoc: MetricResult | null;
  joint: MetricResult | null;
  /** Scale from the coin fitted post hoc on the final (joint-refined) poses. */
  timeMs: number;
  renderMs: number;
}

export function sfmViews(cache: RenderCache, c: Condition): { views: SfmView[]; scene: SfmScene; cams: BoardCamera[]; clean: CleanRender[] } {
  const { scene, cams, clean } = cache.get(c);
  const views: SfmView[] = cams.map((cam, i) => ({
    id: cam.id,
    image: finishRender(clean[i], { blurSigmaPx: c.blurSigmaPx ?? 0.7, noiseSigma: c.noiseSigma ?? 2.5, seed: (c.seed ?? 1) * 1000 + i }),
    exclude: c.includeHand ? null : surfaceMask(clean[i], SFM_SURFACE.hand),
    elevationDeg: cam.elevationDeg,
    azimuthDeg: cam.azimuthDeg,
    coinEdges: coinEdgePoints(clean[i], { occluders: scene.coin.placement === "hand" ? [] : [SFM_SURFACE.hand], noisePx: c.coinEdgeNoisePx ?? 0, seed: i + 1 }),
  }));
  return { views, scene, cams, clean };
}

export function runCondition(cache: RenderCache, c: Condition, sfmOpts: SfmOptions = {}): ConditionResult {
  const r0 = performance.now();
  const { views, scene, cams } = sfmViews(cache, c);
  const renderMs = performance.now() - r0;
  const t0 = performance.now();
  const sweep = c.capture === "sweep";
  const sfm = runSfm(views, {
    coinDiameterMm: scene.coin.diameterMm,
    coinThicknessMm: c.assumedCoinThicknessMm ?? scene.coin.thicknessMm,
    seed: c.seed ?? 1,
    pairWindowDeg: sweep ? Math.max(16, 2.2 * (c.sweepStepDeg ?? 7.5)) : 65,
    detect: { upright: true },
    ...sfmOpts,
  });
  const timeMs = performance.now() - t0;
  const truth = cams.map((k) => k.pose);
  const focalTrue = cams[0].intrinsics.fx;
  const reg = sfm.poses.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  const empty: PoseErrors = { rotDeg: [], centreMm: [], maxRotDeg: NaN, meanRotDeg: NaN, maxCentreMm: NaN, meanCentreMm: NaN };
  const base = { condition: c, sfm, views: views.length, registered: sfm.ok ? sfm.registered : 0, focalTrue, focalErr: (sfm.cam.f - focalTrue) / focalTrue, k1: sfm.cam.k1, k2: sfm.cam.k2, timeMs, renderMs };
  if (!sfm.ok || reg.length < 3)
    return { ...base, similarity: empty, planeAngleDeg: NaN, planeHeightMm: NaN, postHoc: null, joint: null };
  const estC = reg.map((i) => centreOf(sfm.poses[i]!.R, sfm.poses[i]!.t));
  const trueC = reg.map((i) => centreOf(truth[i].R, truth[i].t));
  const sim = similarityAlign(estC, trueC);
  const similarity = poseErrors(sfm.poses.map((p) => (p ? { R: p.R, t: p.t } : null)), truth, sim);
  // table plane from the triangulated points
  const P = sfm.points.map((p) => p.X);
  const medDepth = median(estC.map((C) => Math.hypot(...vsub(C, P[0] ?? C))));
  const plane = fitPlaneRansac(P, 0.002 * medDepth, 1);
  let planeAngleDeg = NaN, planeHeightMm = NaN;
  if (plane) {
    const nA = m3v(sim.R, plane.n);
    const p0 = m3v(sim.R, [plane.n[0] * plane.d * sim.s, plane.n[1] * plane.d * sim.s, plane.n[2] * plane.d * sim.s]);
    const q: V3 = [p0[0] + sim.t[0], p0[1] + sim.t[1], p0[2] + sim.t[2]];
    planeAngleDeg = (Math.acos(Math.min(1, Math.abs(nA[2]))) * 180) / Math.PI;
    // height of the plane above the true table at the hand's middle (x, y of the camera target)
    const tgt = cams[0].pose ? targetOf(scene) : [0, 0, 0];
    planeHeightMm = nA[2] !== 0 ? (vdot(nA, q) - nA[0] * tgt[0] - nA[1] * tgt[1]) / nA[2] : NaN;
  }
  // metric frames: wrist and middle knuckle landmarks triangulated with the SfM poses (MediaPipe stand-in: projected
  // synthetic landmarks with pixel noise)
  const lmPx = cams.map((k, i) => projectLandmarks(scene.landmarks, k.intrinsics, k.pose, { noisePx: c.landmarkNoisePx ?? 2, seed: 100 + i }));
  const wrist = triangulatePixels(sfm.cam, sfm.poses, lmPx.map((l) => l[0]));
  const mcp = triangulatePixels(sfm.cam, sfm.poses, lmPx.map((l) => l[9]));
  const metric = (radius: number | undefined): MetricResult | null => {
    if (!plane || !wrist || !mcp || !radius) return null;
    const mmPerUnit = scene.coin.diameterMm / (2 * radius);
    // the frame convention: the wrist landmark at its board-frame (x, y) and the fingers toward +x, as on the board (a
    // naming convention only; the carving volume below is built from the triangulated landmarks, not from the truth)
    const frame = makeTableFrame(plane, mmPerUnit, estC, wrist, mcp, [scene.landmarks[0].x, scene.landmarks[0].y]);
    const poses = sfm.poses.map((p) => (p ? poseToTable(frame, p) : null));
    const direct = poseErrors(poses, truth, { s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
    const rc = reg.map((i) => centreOf(poses[i]!.R, poses[i]!.t));
    const rigid = poseErrors(poses, truth, rigidOnly(rc, trueC));
    return { scaleErr: mmPerUnit / sim.s - 1, direct, rigid, frame, poses };
  };
  const joint = sfm.coinJoint ? metric(sfm.coinJoint.circle.radius) : null;
  const postHoc = sfm.coinPostHoc ? metric(sfm.coinPostHoc.circle.radius) : null;
  return { ...base, similarity, planeAngleDeg, planeHeightMm, postHoc, joint };
}

function targetOf(scene: SfmScene): Vec3 {
  const p = scene.hand.placement;
  return [p.wristX + 90, p.wristY, 0];
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
};

export function camOf(r: ConditionResult) {
  return camToIntrinsics(r.sfm.cam, 1280, 720);
}

const f1 = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");
const pct = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)} %`);

/** One markdown table row (and its header). */
export const ROW_HEADER =
  "| texture | capture (views) | hand feats | coin | blur | noise | registered | rms px | focal err | k1 (true) | rot max deg (sim) | centre max mm (sim) | plane deg | scale err post-hoc | scale err joint | rot max deg (metric, rigid) | centre max mm (metric, rigid) | rot max deg (table frame) | centre max mm (table frame) | time s |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";

export function rowOf(r: ConditionResult): string {
  const c = r.condition;
  const m = r.joint ?? r.postHoc;
  return `| ${c.texture} | ${c.capture === "sweep" ? `sweep ${c.sweepStepDeg ?? 7.5} deg (${r.views})` : r.views} | ${c.includeHand ? "in" : "out"} | ${c.coin ?? "table-side"} | ${c.blurSigmaPx ?? 0.7} | ${c.noiseSigma ?? 2.5} | ${r.registered}/${r.views}${r.sfm.ok && !r.sfm.accepted ? " (refused)" : !r.sfm.ok ? " (failed)" : ""} | ${f1(r.sfm.rmsPx)} | ${r.registered ? pct(r.focalErr) : "n/a"} | ${f1(r.k1, 3)} (${c.k1 ?? -0.06}) | ${f1(r.similarity.maxRotDeg, 3)} | ${f1(r.similarity.maxCentreMm)} | ${f1(r.planeAngleDeg, 3)} | ${pct(r.postHoc?.scaleErr)} | ${pct(r.joint?.scaleErr)} | ${f1(m?.rigid.maxRotDeg ?? NaN, 3)} | ${f1(m?.rigid.maxCentreMm ?? NaN)} | ${f1(m?.direct.maxRotDeg ?? NaN, 3)} | ${f1(m?.direct.maxCentreMm ?? NaN)} | ${(r.timeMs / 1000).toFixed(1)} |`;
}

// ---------------------------------------------------------------------------------------------------------------
// Carving with the board-free poses

export interface CarveOutcome {
  source: string;
  accepted: boolean;
  reasons: string[];
  /** Measured minus true (mm); null when not measured. */
  errors: Record<string, number | null>;
  measurements: HandMeasurements | null;
  volume: { min: Vec3; max: Vec3 };
  /** Reprojection IoU of the mesh per view (the gate needs mean >= 0.9 and min >= 0.8). */
  ious: (number | null)[];
  ms: number;
}

/** The still views used for the carving: the top view and the low-ring frames at the stills' azimuths (every 30 degrees
 *  for 13, every 22.5 for 17). */
export function stillIndices(cams: readonly BoardCamera[], views: 13 | 17 | 25): number[] {
  const step = views === 13 ? 30 : 22.5;
  return cams
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.elevationDeg === 90 || (c.elevationDeg === 12 && c.azimuthDeg !== null && Math.abs(((c.azimuthDeg + step / 2) % step) - step / 2) < 1e-6))
    .map(({ i }) => i);
}

/** Carve the hand from the still views with given (table-frame, metric) poses and intrinsics, with the EXACT hand masks
 *  (the board segmentation needs the printed board) and noisy projected landmarks (2 px), at half resolution. */
export function carveWithPoses(cache: RenderCache, c: Condition, poses: readonly (CameraPose | null)[], K: Intrinsics, source: string, opts: { voxelMm?: number; landmarkNoisePx?: number } = {}): CarveOutcome {
  const t0 = performance.now();
  const { scene, cams, clean } = cache.get(c);
  const idx = stillIndices(cams, c.views).filter((i) => poses[i]);
  const Kh: Intrinsics = { ...K, fx: K.fx / 2, fy: K.fy / 2, cx: K.cx / 2, cy: K.cy / 2, width: K.width / 2, height: K.height / 2 };
  const inputs: BoardViewInput[] = idx.map((i) => {
    const full = surfaceMask(clean[i], SFM_SURFACE.hand);
    const w = clean[i].width / 2, h = clean[i].height / 2;
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = 2 * y * clean[i].width + 2 * x;
        m[y * w + x] = (full[a] ? 1 : 0) + (full[a + 1] ? 1 : 0) + (full[a + clean[i].width] ? 1 : 0) + (full[a + clean[i].width + 1] ? 1 : 0) >= 2 ? 255 : 0;
      }
    // landmarks are "detected" in the true picture: projected with the TRUE camera, then halved
    const lm = projectLandmarks(scene.landmarks, cams[i].intrinsics, cams[i].pose, { noisePx: opts.landmarkNoisePx ?? 2, seed: 100 + i }).map((p) => (p ? { x: p.x / 2, y: p.y / 2 } : null));
    return { id: cams[i].id, intrinsics: Kh, pose: poses[i]!, mask: { width: w, height: h, data: m }, landmarks: lm };
  });
  // the volume from the landmarks triangulated with these poses (table frame), not from the truth
  const tri = triangulateLandmarks(inputs.map((v) => ({ id: v.id!, intrinsics: v.intrinsics, pose: v.pose, landmarks: v.landmarks ?? null })));
  const pts = tri.points.filter((p): p is NonNullable<typeof p> => !!p);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const wrist = tri.points[0];
  const volume = { min: [(wrist ? wrist.x : Math.min(...xs)) - 25, Math.min(...ys) - 28, 0] as Vec3, max: [Math.max(...xs) + 22, Math.max(...ys) + 28, 80] as Vec3 };
  const rec = reconstructFromBoardViews(inputs, { voxelMm: opts.voxelMm ?? 1.5, volume });
  const T = scene.hand.truth;
  const m = rec.measurements;
  const e = (q: { value: number | null } | undefined, t: number) => (q && q.value !== null ? q.value - t : null);
  const errors: Record<string, number | null> = {
    handLength: e(m?.handLength, T.handLength),
    palmBreadth: e(m?.palmBreadth, T.palmBreadth),
    palmThickness: e(m?.palmThickness, T.palmThickness),
    circumference: e(m?.circumferenceKnuckle, T.circumference),
  };
  for (const f of ["thumb", "index", "middle", "ring", "little"] as const) errors[f] = e(m?.fingerLengths[f], T.fingerLengths[f]);
  return { source, accepted: rec.accepted, reasons: rec.reasons, errors, measurements: m, volume, ious: rec.views.map((v) => v.reprojectionIoU), ms: performance.now() - t0 };
}

export function carveRow(o: CarveOutcome): string {
  const v = (k: string) => (o.errors[k] === null ? "n/a" : `${o.errors[k]! >= 0 ? "+" : ""}${o.errors[k]!.toFixed(1)}`);
  return `| ${o.source} | ${o.accepted ? "yes" : "no"} [${o.reasons.join(", ")}] | ${v("handLength")} | ${v("palmBreadth")} | ${v("palmThickness")} | ${v("circumference")} | ${["thumb", "index", "middle", "ring", "little"].map(v).join(" / ")} |`;
}
export const CARVE_HEADER = "| poses | gates passed | length | breadth | thickness | knuckle circ. (upper bound) | fingers T / I / M / R / L |\n|---|---|---|---|---|---|---|";
