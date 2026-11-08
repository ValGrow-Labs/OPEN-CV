// SIMULATED grid of the EXPERIMENTAL board-free structure from motion (sfm/). Opt in (it renders hundreds of 1280 x 720
// pictures and takes tens of minutes):
//   RUN_SFM_GRID=all            every block below
//   RUN_SFM_GRID=stills,sweep   chosen blocks (match, board, carve, thick, noise, hand, coin, fov, step, sweep, stills)
//   SFM_RENDER_CACHE=<dir>      keep the clean renders on disk between runs (optional)
// Prints markdown tables (copied into README.md). Every number is SIMULATED: a capsule hand on procedural textures,
// rendered without gloss, tone curve or compression; never real-world accuracy.
import { describe, expect, it } from "vitest";
import { camerasFromMarkers } from "../recon/chain";
import { detectMarkers } from "../board/detect";
import type { CameraPose } from "../common";
import { boardRig, makeBoardScene, renderView, sceneTarget } from "../multiview/scene";
import { cameraCentre, pixelToNormalized } from "../multiview/image";
import { lookAtPose, projectPoint, rotationAngleDeg } from "../reconstruction/linalg";
import { detectFeatures, matchFeatures } from "./features";
import { finishRender, makeSfmScene, renderClean, SFM_SURFACE, surfaceMask } from "./scene";
import { rigidOnly } from "./frame";
import { centreOf } from "./geometry";
import { m3mul, m3T, m3v, type V3 } from "./mat";
import { camOf, CARVE_HEADER, carveRow, carveWithPoses, RenderCache, rigFor, ROW_HEADER, rowOf, runCondition, type Condition, type ConditionResult } from "./evaluate";

const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
const sel = (env.RUN_SFM_GRID ?? "").split(",").map((s) => s.trim());
const on = (block: string) => sel.includes("all") || sel.includes(block);
const cache = new RenderCache(env.SFM_RENDER_CACHE ?? null);
const T = 4 * 3600_000;

/** Yield to the event loop between long synchronous steps (keeps the test runner's RPC alive). */
const tick = () => new Promise((r) => setTimeout(r, 0));

async function table(title: string, conds: Condition[]): Promise<ConditionResult[]> {
  const rows: ConditionResult[] = [];
  const lines = [`### ${title} (SIMULATED)`, "", ROW_HEADER];
  for (const c of conds) {
    await cache.warm(c);
    await tick();
    const r = runCondition(cache, c);
    rows.push(r);
    lines.push(rowOf(r));
    console.log(rowOf(r) + (r.sfm.ok ? "" : `  <- ${r.sfm.failure}`));
  }
  console.log(lines.join("\n"));
  return rows;
}

const sweep = (o: Partial<Condition> = {}): Condition => ({ texture: "speckle", views: 17, capture: "sweep", sweepStepDeg: 7.5, ...o });

describe.skipIf(!sel.some((s) => s))("SIMULATED board-free SfM grid (opt in: RUN_SFM_GRID)", () => {
  it.runIf(on("match"))("how far apart views can be and still match (speckle, hand excluded, upright descriptors)", async () => {
    const scene = makeSfmScene({ texture: "speckle" });
    const K = rigFor(scene, { texture: "speckle", views: 17 })[0].intrinsics;
    const tg = sceneTarget(scene.hand);
    const cam = (el: number, az: number) => {
      const e = (el * Math.PI) / 180, a = (az * Math.PI) / 180, d = el > 80 ? 400 : 340;
      return lookAtPose([tg[0] + d * Math.cos(e) * Math.cos(a), tg[1] + d * Math.cos(e) * Math.sin(a), tg[2] + d * Math.sin(e)], tg, el > 60 ? [Math.cos(a + Math.PI), Math.sin(a + Math.PI), 0] : [0, 0, 1]);
    };
    const feats = (pose: CameraPose, seed: number) => {
      const c = renderClean(scene, K, pose);
      return detectFeatures(finishRender(c, { seed }), { exclude: surfaceMask(c, SFM_SURFACE.hand), upright: true });
    };
    const hit = (pose: CameraPose, u: number, v: number) => {
      const [xn, yn] = pixelToNormalized(K, u, v);
      const R = pose.R, O = cameraCentre(pose);
      const d = [R[0] * xn + R[3] * yn + R[6], R[1] * xn + R[4] * yn + R[7], R[2] * xn + R[5] * yn + R[8]];
      if (d[2] >= 0) return null;
      const t = -O[2] / d[2];
      return [O[0] + d[0] * t, O[1] + d[1] * t, 0];
    };
    const lines = ["### Correct matches between two views (SIMULATED, speckle table, ratio 0.85)", "", "| from | to | change | matches | geometrically correct |", "|---|---|---|---|---|"];
    const pairs: [number, number, number, number][] = [
      [12, 0, 12, 5], [12, 0, 12, 7.5], [12, 0, 12, 10], [12, 0, 12, 15], [12, 0, 12, 22.5], [12, 0, 12, 30],
      [35, 0, 35, 10], [35, 0, 35, 15], [35, 0, 35, 20], [35, 0, 35, 30],
      [12, 0, 18, 0], [12, 0, 20, 0], [12, 0, 25, 0], [20, 0, 35, 0], [35, 0, 50, 0], [50, 0, 65, 0], [65, 0, 90, 0], [75, 0, 90, 0],
    ];
    for (const [e1, a1, e2, a2] of pairs) {
      await tick();
      const p1 = cam(e1, a1), p2 = cam(e2, a2);
      const f1 = feats(p1, 1), f2 = feats(p2, 2);
      const m = matchFeatures(f1, f2, { ratio: 0.85 });
      let good = 0;
      for (const [i, j] of m) {
        const X = hit(p1, f1.x[i], f1.y[i]);
        const q = X && projectPoint(X, K, p2);
        if (q && Math.hypot(q.u - f2.x[j], q.v - f2.y[j]) < 3) good++;
      }
      lines.push(`| ${e1} deg, az ${a1} | ${e2} deg, az ${a2} | ${e1 === e2 ? `azimuth ${a2 - a1} deg` : `elevation ${e2 - e1} deg`} | ${m.length} | ${good} |`);
    }
    console.log(lines.join("\n"));
  }, T);

  it.runIf(on("board"))("the board route on the same camera path (recon/chain camerasFromMarkers)", async () => {
    const scene = makeBoardScene();
    const lines = ["### The board route on the same camera path (SIMULATED)", "", "| views | hfov | registered | focal err | k1 (true) | rot max deg | centre max mm | detect + calibrate + pose s |", "|---|---|---|---|---|---|---|---|"];
    for (const [hfov, lowCount, highCount] of [[64, 12, 0], [64, 16, 0], [64, 16, 8], [55, 16, 0], [78, 16, 0]] as const) {
      await tick();
      const cams = boardRig(scene, { width: 1280, height: 720, hfovDeg: hfov, k1: -0.06, k2: 0.02, lowCount, highCount });
      const imgs = cams.map((c, i) => renderView(scene, c.intrinsics, c.pose, { seed: i + 1 }).image);
      const t0 = performance.now();
      const dets = imgs.map((im) => detectMarkers(im, {}));
      const est = camerasFromMarkers(cams.map((c, i) => ({ id: c.id, markers: dets[i].markers })), 1280, 720);
      const ms = performance.now() - t0;
      const K = est.cameras.intrinsics, Kt = cams[0].intrinsics;
      const errs = cams
        .map((c, i) => {
          const p = est.cameras.views[i].pose;
          if (!p || est.cameras.views[i].rejected) return null;
          const R = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => {
            const a = Math.floor(k / 3), b = k % 3;
            let s = 0;
            for (let j = 0; j < 3; j++) s += p.R[a * 3 + j] * c.pose.R[b * 3 + j];
            return s;
          });
          const ce = cameraCentre(p), ct = cameraCentre(c.pose);
          return { rot: rotationAngleDeg(R), cen: Math.hypot(ce[0] - ct[0], ce[1] - ct[1], ce[2] - ct[2]) };
        })
        .filter((e): e is { rot: number; cen: number } => !!e);
      lines.push(`| ${cams.length} | ${hfov} | ${errs.length}/${cams.length} | ${(((K.fx - Kt.fx) / Kt.fx) * 100).toFixed(3)} % | ${K.k1?.toFixed(3)} (-0.06) | ${Math.max(...errs.map((e) => e.rot)).toFixed(3)} | ${Math.max(...errs.map((e) => e.cen)).toFixed(2)} | ${(ms / 1000).toFixed(1)} |`);
      console.log(lines[lines.length - 1]);
    }
    console.log(lines.join("\n"));
  }, T);

  it.runIf(on("carve"))("carving with the board-free poses (best condition)", async () => {
    const c = sweep();
    await cache.warm(c);
    const r = runCondition(cache, c);
    const { cams } = cache.get(c);
    await tick();
    const out = [carveWithPoses(cache, c, cams.map((k) => k.pose), cams[0].intrinsics, "truth: exact poses and intrinsics")];
    await tick();
    if (r.joint) out.push(carveWithPoses(cache, c, r.joint.poses, camOf(r), "SfM + coin, joint bundle adjustment"));
    if (r.postHoc) out.push(carveWithPoses(cache, c, r.postHoc.poses, camOf(r), "SfM + coin, post-hoc coin fit"));
    if (r.joint) {
      // the same SfM poses with the table frame's in-plane definition (landmark yaw and origin) replaced by a rigid
      // alignment to the truth: separates the pose quality from the frame definition
      const P = r.joint.poses;
      const al = rigidOnly(P.filter((p) => p).map((p) => centreOf(p!.R, p!.t)), P.map((p, i) => (p ? centreOf(cams[i].pose.R, cams[i].pose.t) : null)).filter((p): p is V3 => !!p));
      const yaw = (Math.atan2(al.R[3], al.R[0]) * 180) / Math.PI;
      console.log(`table frame vs truth: yaw ${yaw.toFixed(3)} deg, translation ${al.t.map((v) => v.toFixed(2)).join(", ")} mm`);
      const aligned = P.map((p) => {
        if (!p) return null;
        const R = m3mul([...p.R], m3T(al.R));
        const Rt = m3v(R, al.t);
        return { R, t: [p.t[0] - Rt[0], p.t[1] - Rt[1], p.t[2] - Rt[2]] as [number, number, number] };
      });
      out.push(carveWithPoses(cache, c, aligned, camOf(r), "SfM + coin (joint), frame rigidly aligned to the truth"));
    }
    console.log(["### Carving the 17 stills (exact masks) with each set of poses (SIMULATED, mm, measured - true)", "", CARVE_HEADER, ...out.map(carveRow)].join("\n"));
    console.log(out.map((o) => `${o.source}: IoU per view ${o.ious.map((v) => (v === null ? "-" : v.toFixed(3))).join(",")}`).join("\n"));
    expect(out.length).toBe(4);
  }, T);

  it.runIf(on("thick"))("coin thickness assumed wrongly (rendered 1.5 mm)", async () => {
    await table("Coin thickness assumed 1.0 / 2.0 mm, rendered 1.5 mm (speckle sweep)", [sweep({ assumedCoinThicknessMm: 1.0 }), sweep({ assumedCoinThicknessMm: 2.0 })]);
  }, T);

  it.runIf(on("noise"))("blur and noise", async () => {
    await table("Blur and sensor noise (speckle sweep)", [sweep({ blurSigmaPx: 1.5 }), sweep({ blurSigmaPx: 2.5 }), sweep({ noiseSigma: 6 }), sweep({ noiseSigma: 12 }), sweep({ texture: "newspaper", blurSigmaPx: 1.5 })]);
  }, T);

  it.runIf(on("hand"))("hand features included vs excluded", async () => {
    await table("Hand features (speckle and weak sweep)", [sweep({ includeHand: true }), sweep({ texture: "weak", includeHand: true })]);
  }, T);

  it.runIf(on("coin"))("coin placement and edge noise", async () => {
    await table("Coin placement (speckle sweep)", [sweep({ coin: "table-tips" }), sweep({ coin: "hand" }), sweep({ coinEdgeNoisePx: 0.5 })]);
  }, T);

  it.runIf(on("fov"))("unknown field of view (prior 67.5 degrees)", async () => {
    await table("Field of view and distortion unknown (speckle sweep, focal prior from 67.5 degrees)", [sweep({ hfovDeg: 55 }), sweep({ hfovDeg: 78 }), sweep({ k1: -0.12, k2: 0.04 })]);
  }, T);

  it.runIf(on("step"))("sweep frame spacing", async () => {
    await table("Sweep frame spacing (speckle)", [5, 10, 15].map((s) => sweep({ sweepStepDeg: s })));
  }, T);

  it.runIf(on("sweep"))("continuous sweep, by table texture", async () => {
    const rows = await table("Sweep (7.5 degree frames on the low ring + arc to the top), by texture", (["speckle", "newspaper", "wood", "fabric", "weak", "plain"] as const).map((texture) => sweep({ texture })));
    expect(rows.length).toBe(6);
  }, T);

  it.runIf(on("stills"))("stills only (the board capture's 13 / 17 / 25 pictures)", async () => {
    const rows = await table("Stills only", (["speckle", "newspaper", "wood"] as const).flatMap((texture) => ([13, 17, 25] as const).map((views) => ({ texture, views }))));
    expect(rows.length).toBe(9);
  }, T);
});
