// SIMULATED captures for the EXPERIMENTAL board-free reconstruction chain (boardfree/). TEST SUPPORT ONLY.
//
// The hand on a table with no printed board and a coin (sfm/scene.ts renderer, sfm/textures.ts table textures), the
// camera path of the board capture (multiview/scene.ts boardRig: top view, low ring at 12 degrees) or the continuous
// sweep of stage 3 (sfm/evaluate.ts rigFor: low-ring frames every 7.5 degrees plus an arc up to the top view). Rendered
// once per scene + camera set + skin tone (clean linear renders, optionally cached on disk), then blur and noise.
//
// What the chain receives (BoardFreeFrame): the picture, the capture guide's approximate direction (elevation,
// azimuth), and two DETECTOR STAND-INS, both labelled as such:
//   * landmarks: the synthetic 21 landmarks projected with the TRUE camera plus 2 px noise (a MediaPipe stand-in, as
//     recon/chain.test.ts does for the board route);
//   * coin edge points: from the renderer's coin label (sfm/coinEdges.ts; a stand-in for the coin detector, which
//     needs OpenCV.js and is another stage). A coin touching the hand or the border gives none (a detector would
//     reject a partly hidden coin).
// The truth (camera poses, intrinsics, hand masks, the exact dimensions) is kept apart (SimTruth) and only the tests read
// it. Every number obtained with this is SIMULATED.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pt } from "../common";
import { projectLandmarks, SKIN_TONES, type BoardCamera } from "../multiview/scene";
import type { RGBAImage } from "../multiview/image";
import { ARC_ELEVATIONS, rigFor, stillIndices } from "../sfm/evaluate";
import { coinEdgePoints } from "../sfm/coinEdges";
import { finishRender, makeSfmScene, renderClean, SFM_SURFACE, surfaceMask, type CleanRender, type SfmScene } from "../sfm/scene";
import type { TextureKind } from "../sfm/textures";
import type { BoardFreeFrame } from "./types";

export type SkinName = keyof typeof SKIN_TONES;

export interface SimCondition {
  texture: TextureKind;
  /** "sweep": continuous video-like pass (stage 3's only accepted capture); "stills": the board capture's 13 / 17 stills. */
  capture: "sweep" | "stills";
  sweepStepDeg?: number;
  /** Stills (capture "stills"), or the stills flagged for carving inside a sweep. Default 17. */
  views?: 13 | 17;
  skin?: SkinName;
  /** Coin: on the table beside the palm (default), beyond the fingertips, absent from the scene, or partly under the
   *  hand (hidden in most frames). */
  coin?: "table-side" | "table-tips" | "none" | "under-hand";
  hfovDeg?: number;
  k1?: number;
  k2?: number;
  blurSigmaPx?: number;
  noiseSigma?: number;
  landmarkNoisePx?: number;
  seed?: number;
}

export interface SimTruth {
  scene: SfmScene;
  cams: BoardCamera[];
  /** Exact hand mask (0/255) of frame i at full size. */
  handMask(i: number): Uint8Array;
}

export interface SimCapture {
  condition: SimCondition;
  frames: BoardFreeFrame[];
  truth: SimTruth;
  renderMs: number;
}

/** Renders kept in memory between tests (keyed by scene + cameras + skin) and optionally on disk (`dir`). */
export class SimCache {
  private m = new Map<string, { scene: SfmScene; cams: BoardCamera[]; clean: CleanRender[]; ms: number }>();
  constructor(private dir: string | null = null, private maxEntries = 1) {}

  key(c: SimCondition): string {
    return [c.texture, c.coin ?? "table-side", c.capture === "sweep" ? `sweep${c.sweepStepDeg ?? 7.5}` : `stills${c.views ?? 17}`, c.skin ?? "medium", c.hfovDeg ?? 64, c.k1 ?? -0.06, c.k2 ?? 0.02].join("|");
  }

  /** Render (or load) the clean pictures, yielding between pictures so a test runner's RPC stays alive. */
  async get(c: SimCondition): Promise<{ scene: SfmScene; cams: BoardCamera[]; clean: CleanRender[]; ms: number }> {
    const key = this.key(c);
    const hit = this.m.get(key);
    if (hit) return hit;
    while (this.m.size >= this.maxEntries) this.m.delete(this.m.keys().next().value as string);
    const t0 = performance.now();
    const scene = makeScene(c);
    const cams = camerasFor(scene, c);
    const clean: CleanRender[] = [];
    for (let i = 0; i < cams.length; i++) {
      await new Promise((r) => setTimeout(r, 0));
      clean.push(this.render(key, i, scene, cams[i], c));
    }
    const e = { scene, cams, clean, ms: performance.now() - t0 };
    this.m.set(key, e);
    return e;
  }

  private render(key: string, i: number, scene: SfmScene, cam: BoardCamera, c: SimCondition): CleanRender {
    const file = this.dir ? join(this.dir, `${key.replace(/[^a-z0-9.-]+/gi, "_")}_${i}.bin`) : null;
    const { width: w, height: h } = cam.intrinsics;
    if (file && existsSync(file)) {
      const buf = readFileSync(file);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const n = w * h;
      return { width: w, height: h, planes: [new Float32Array(ab, 0, n), new Float32Array(ab, 4 * n, n), new Float32Array(ab, 8 * n, n)], surface: new Uint8Array(ab, 12 * n, n) };
    }
    const r = renderClean(scene, cam.intrinsics, cam.pose, { skin: SKIN_TONES[c.skin ?? "medium"] });
    if (file && this.dir) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, Buffer.concat([Buffer.from(r.planes[0].buffer), Buffer.from(r.planes[1].buffer), Buffer.from(r.planes[2].buffer), Buffer.from(r.surface.buffer)]));
    }
    return r;
  }
}

function makeScene(c: SimCondition): SfmScene {
  const coin = c.coin ?? "table-side";
  const scene = makeSfmScene({ texture: c.texture, coin: coin === "table-tips" ? "table-tips" : "table-side" });
  if (coin === "none") {
    // no coin in the picture: moved far beyond the table (never visible)
    scene.coin.base = [1e5, 1e5, 0];
    scene.coinTopCentre = [1e5, 1e5, scene.coin.thicknessMm];
  } else if (coin === "under-hand") {
    // partly under the palm's little-finger edge: hidden by the hand in most frames
    const p = scene.hand.hand.params;
    const base: [number, number, number] = [scene.hand.placement.wristX + p.palmLength * 0.55, scene.hand.placement.wristY + p.palmBreadth / 2 - 4, 0];
    scene.coin.base = base;
    scene.coinTopCentre = [base[0], base[1], scene.coin.thicknessMm];
  }
  return scene;
}

function camerasFor(scene: SfmScene, c: SimCondition): BoardCamera[] {
  return rigFor(scene, { texture: c.texture, views: c.views ?? 17, capture: c.capture, sweepStepDeg: c.sweepStepDeg, hfovDeg: c.hfovDeg, k1: c.k1, k2: c.k2 });
}

/** The frames the chain receives (pictures + guide directions + detector stand-ins), and the truth kept apart. */
export async function simulateCapture(cache: SimCache, c: SimCondition): Promise<SimCapture> {
  const t0 = performance.now();
  const { scene, cams, clean } = await cache.get(c);
  const still = new Set(c.capture === "sweep" ? stillIndices(cams, c.views ?? 17) : cams.map((_, i) => i));
  const frames: BoardFreeFrame[] = cams.map((cam, i) => {
    const image: RGBAImage = finishRender(clean[i], { blurSigmaPx: c.blurSigmaPx ?? 0.7, noiseSigma: c.noiseSigma ?? 2.5, seed: (c.seed ?? 1) * 1000 + i });
    const landmarks: (Pt | null)[] = projectLandmarks(scene.landmarks, cam.intrinsics, cam.pose, { noisePx: c.landmarkNoisePx ?? 2, seed: 100 + i });
    return {
      id: cam.id,
      image,
      elevationDeg: cam.elevationDeg,
      azimuthDeg: cam.azimuthDeg,
      landmarks,
      coinEdges: coinEdgePoints(clean[i], { occluders: [SFM_SURFACE.hand], seed: i + 1 }),
      carve: still.has(i),
    };
  });
  return {
    condition: c,
    frames,
    truth: { scene, cams, handMask: (i: number) => surfaceMask(clean[i], SFM_SURFACE.hand) },
    renderMs: performance.now() - t0,
  };
}

export { ARC_ELEVATIONS };
