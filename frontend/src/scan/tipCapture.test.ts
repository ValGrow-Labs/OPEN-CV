import { describe, expect, it } from "vitest";
import type { FrameObservation, Point } from "../api/types";
import type { CoinEngine } from "../vision/coinEngine";
import { renderFinger } from "../vision/fingerRender";
import { runTipJob } from "../vision/tipJob";
import { applyRefinedTips, TIP_FINGERS, TipCapture, type TipCrop } from "./tipCapture";

function frame(shiftX = 0): FrameObservation {
  const lm: Point[] = Array.from({ length: 21 }, (_, i) => ({ x: 100 + i * 3 + shiftX, y: 400 - i * 10, z: 0 }));
  // a straight distal segment pointing up for every finger: dip -> tip is (0, -30)
  for (const { tip, dip } of TIP_FINGERS) {
    lm[dip] = { x: 200 + tip * 10 + shiftX, y: 300, z: 0 };
    lm[tip] = { x: 200 + tip * 10 + shiftX, y: 270, z: 0 };
  }
  return { timestamp_ms: 0, image_width: 1280, image_height: 720, landmarks: lm, world_landmarks: null, handedness: null, handedness_score: null, coin: null, brightness: 120 };
}

describe("applyRefinedTips", () => {
  it("moves each tip outward along its own distal segment, in every frame", () => {
    const frames = [frame(0), frame(5)];
    applyRefinedTips(frames, { 8: { ok: true, ratio: 0.2, found: 3, of: 4, reason: "ok" } }, 0.35);
    for (const f of frames) {
      const t = f.refined_tips?.["8"];
      expect(t?.source).toBe("outline");
      expect(t?.x).toBeCloseTo(f.landmarks[8].x, 6);
      expect(t?.y).toBeCloseTo(270 - 0.2 * 30, 6); // 6 px beyond the landmark tip, up the finger
      expect(t?.extension_px).toBeCloseTo(6, 6);
      expect(f.refined_tips?.["12"]).toBeUndefined(); // a finger that was not measured gets no entry
    }
  });

  it("keeps the landmark tip, with the reason, when there was no clear outline; and caps the ratio", () => {
    const f = frame();
    applyRefinedTips([f], { 12: { ok: false, ratio: 0, found: 0, of: 4, reason: "no_boundary" }, 16: { ok: true, ratio: 0.9, found: 4, of: 4, reason: "ok" } }, 0.35);
    expect(f.refined_tips?.["12"]).toMatchObject({ source: "landmark", extension_px: 0, reason: "no_boundary", x: f.landmarks[12].x, y: f.landmarks[12].y });
    expect(f.refined_tips?.["16"].extension_px).toBeLessThanOrEqual(0.35 * 30 + 1e-9);
  });
});

describe("TipCapture", () => {
  const crop = (insideMm: number, blur: number): TipCrop => {
    const r = renderFinger({ size: 150, skin: [226, 170, 140], background: "white", pxPerMm: 2.8, distalSkinMm: 24, insideMm, widthMm: 17, angleDeg: 20, blurSigma: blur, noise: 0, seed: 5 });
    return { tipIndex: 8, image: r.image, dip: r.dip, tip: r.tip, sharp: 0 };
  };
  const engine: CoinEngine = {
    kind: "page",
    run: () => Promise.reject(new Error("not used")),
    tips: (job) => Promise.resolve(runTipJob(job)),
  };

  it("keeps only the sharpest crops and writes refined tips on every frame of the view", async () => {
    const tc = new TipCapture();
    for (let i = 0; i < 7; i++) tc.keep([crop(4, i < 3 ? 4 : 0)]);
    expect(tc.keptFrames).toBe(4);
    const frames = [frame(), frame(3), frame(6)];
    const summary = await tc.finalize(engine, frames, 0.35);
    expect(summary?.byFinger[8].ok).toBe(true);
    for (const f of frames) expect(f.refined_tips?.["8"].source).toBe("outline");
    expect(tc.keptFrames).toBe(0); // measured once, then released
  });

  it("leaves the frames alone without an engine, without crops, or when measuring fails", async () => {
    const tc = new TipCapture();
    const f = [frame()];
    expect(await tc.finalize(engine, f, 0.35)).toBeNull(); // nothing kept
    tc.keep([crop(4, 0)]);
    expect(await tc.finalize(null, f, 0.35)).toBeNull();
    tc.keep([crop(4, 0)]);
    const broken: CoinEngine = { ...engine, tips: () => Promise.reject(new Error("worker died")) };
    expect(await tc.finalize(broken, f, 0.35)).toBeNull();
    expect(f[0].refined_tips).toBeUndefined();
  });

  it("gives up after the time budget", async () => {
    const tc = new TipCapture();
    tc.keep([crop(4, 0)]);
    const slow: CoinEngine = { ...engine, tips: () => new Promise(() => undefined) };
    const f = [frame()];
    expect(await tc.finalize(slow, f, 0.35, 20)).toBeNull();
    expect(f[0].refined_tips).toBeUndefined();
  });
});
