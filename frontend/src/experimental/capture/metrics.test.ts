import { describe, expect, it } from "vitest";
import type { Point } from "../../api/types";
import {
  AUTO_CAPTURE_FRAMES,
  failedChecks,
  GoodRun,
  grayFromRgba,
  JITTER_WINDOW,
  laplacianVariance,
  MIN_SHARPNESS,
  postureCheck,
  regionSharpness,
  shrinkGray,
  smoothedTurn,
  steadiness,
  type PostureContext,
  type QualityChips,
} from "./metrics";
import { viewDef } from "./views";

/** A black-and-white checkerboard as RGBA (SYNTHETIC test picture). */
function checker(w: number, h: number, cell: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) * 255;
      const i = (y * w + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
  return px;
}

/** Box blur of an RGBA picture, `r` pixels each side, a few passes (SYNTHETIC blur). */
function blur(px: Uint8ClampedArray, w: number, h: number, r: number, passes = 3): Uint8ClampedArray {
  let src = Float32Array.from(px);
  for (let p = 0; p < passes; p++) {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          let n = 0;
          for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++) {
              const xx = Math.min(w - 1, Math.max(0, x + dx));
              const yy = Math.min(h - 1, Math.max(0, y + dy));
              s += src[(yy * w + xx) * 4 + c];
              n++;
            }
          dst[(y * w + x) * 4 + c] = s / n;
        }
    for (let i = 3; i < dst.length; i += 4) dst[i] = 255;
    src = dst;
  }
  return Uint8ClampedArray.from(src);
}

const hand = (dx = 0, dy = 0): Point[] => Array.from({ length: 21 }, (_, i) => ({ x: 100 + (i % 5) * 20 + dx, y: 100 + Math.floor(i / 5) * 25 + dy, z: 0 }));

describe("sharpness (Laplacian variance)", () => {
  it("is zero for a flat picture and large for a sharp one", () => {
    expect(laplacianVariance(new Float32Array(64 * 64).fill(0.5), 64, 64)).toBeCloseTo(0, 12);
    expect(regionSharpness(checker(64, 64, 4), 64, 64)).toBeGreaterThan(MIN_SHARPNESS * 50);
  });

  it("falls as the same picture is blurred, and a heavily blurred copy fails the provisional minimum", () => {
    const sharp = checker(96, 96, 6);
    const b1 = blur(sharp, 96, 96, 1);
    const b2 = blur(sharp, 96, 96, 3, 4);
    const s0 = regionSharpness(sharp, 96, 96);
    const s1 = regionSharpness(b1, 96, 96);
    const s2 = regionSharpness(b2, 96, 96);
    expect(s0).toBeGreaterThan(s1);
    expect(s1).toBeGreaterThan(s2);
    expect(s2).toBeLessThan(MIN_SHARPNESS);
    expect(s0).toBeGreaterThan(MIN_SHARPNESS);
  });

  it("does not depend on the camera's resolution above SHARPNESS_SIDE_PX (it is shrunk first)", () => {
    const base = regionSharpness(checker(256, 256, 16), 256, 256);
    const double = regionSharpness(checker(512, 512, 32), 512, 512); // the same picture at 2x
    const quad = regionSharpness(checker(1024, 1024, 64), 1024, 1024); // and 4x
    expect(Math.abs(double - base) / base).toBeLessThan(0.05);
    expect(Math.abs(quad - base) / base).toBeLessThan(0.05);
  });

  it("shrinks by area average and never enlarges", () => {
    const g = grayFromRgba(checker(8, 8, 1), 8, 8);
    expect(shrinkGray(g, 8, 8, 64).width).toBe(8);
    const s = shrinkGray(g, 8, 8, 4);
    expect(s.width).toBe(4);
    expect(s.gray[0]).toBeCloseTo(0.5, 5);
  });

  it("returns 0 for a picture too small to have an interior", () => {
    expect(laplacianVariance(new Float32Array(4), 2, 2)).toBe(0);
  });
});

describe("steadiness (landmark jitter)", () => {
  it("is unknown (and not steady) with fewer than two frames", () => {
    expect(steadiness([], 0.025)).toEqual({ jitter: null, steady: false });
    expect(steadiness([hand()], 0.025)).toEqual({ jitter: null, steady: false });
  });

  it("is steady for an unmoving hand and not for a moving one", () => {
    const still = Array.from({ length: JITTER_WINDOW }, () => hand());
    expect(steadiness(still, 0.025)).toMatchObject({ jitter: 0, steady: true });
    const moving = Array.from({ length: JITTER_WINDOW }, (_, i) => hand(i * 12, 0));
    const r = steadiness(moving, 0.025);
    expect(r.steady).toBe(false);
    expect(r.jitter).toBeGreaterThan(0.025);
  });

  it("uses only the last JITTER_WINDOW frames", () => {
    const old = Array.from({ length: 5 }, (_, i) => hand(i * 30, 0));
    const fresh = Array.from({ length: JITTER_WINDOW }, () => hand(500, 0));
    expect(steadiness([...old, ...fresh], 0.025).steady).toBe(true);
  });
});

describe("posture checks", () => {
  const ctx = (turns: Record<string, number | null> = {}): PostureContext => ({ minTurnAbs: 0.2, maxEdgeTurnAbs: 0.55, turnOf: (v) => turns[v] ?? null });

  it("judge nothing for an oblique, and say so", () => {
    expect(postureCheck({ kind: "none" }, null, ctx())).toMatchObject({ ok: true, verdict: "n/a" });
  });

  it("never pass a view they cannot judge", () => {
    expect(postureCheck({ kind: "face_on" }, null, ctx())).toMatchObject({ ok: false, verdict: "unknown" });
    expect(postureCheck({ kind: "opposite_of", view: "palm" }, 0.6, ctx())).toMatchObject({ ok: false, verdict: "unknown" }); // no palm turn yet
  });

  it("face-on needs the flat of the hand: |turn| at least the capture minimum", () => {
    expect(postureCheck({ kind: "face_on" }, 0.6, ctx()).ok).toBe(true);
    expect(postureCheck({ kind: "face_on" }, -0.6, ctx()).ok).toBe(true);
    expect(postureCheck({ kind: "face_on" }, 0.1, ctx())).toMatchObject({ ok: false, verdict: "wrong" });
  });

  it("edge-on needs a small |turn|", () => {
    expect(postureCheck({ kind: "edge_on" }, 0.1, ctx()).ok).toBe(true);
    expect(postureCheck({ kind: "edge_on" }, -0.5, ctx()).ok).toBe(true);
    expect(postureCheck({ kind: "edge_on" }, 0.7, ctx())).toMatchObject({ ok: false, verdict: "wrong" });
  });

  it("the back must show the OTHER side from the palm view: opposite sign, and not the same side again", () => {
    const rule = { kind: "opposite_of", view: "palm" } as const;
    expect(postureCheck(rule, -0.6, ctx({ palm: 0.6 })).ok).toBe(true);
    expect(postureCheck(rule, 0.6, ctx({ palm: 0.6 }))).toMatchObject({ ok: false, verdict: "wrong" });
    expect(postureCheck(rule, 0.1, ctx({ palm: 0.6 })).verdict).toBe("wrong"); // not face-on at all
  });

  it("smooth the turn by the median of the last frames, and need three of them", () => {
    expect(smoothedTurn([0.5, 0.5])).toBeNull();
    expect(smoothedTurn([0.1, 0.6, 0.62, 0.58, 0.61])).toBeCloseTo(0.6, 2);
    expect(smoothedTurn([0.6, 0.6, 0.6, NaN, 0.6, 0.6, 0.6])).toBeCloseTo(0.6, 5);
  });
});

describe("the run of good frames", () => {
  it("counts consecutive good frames and restarts on any bad one", () => {
    const r = new GoodRun();
    expect(r.push(true)).toBe(1);
    expect(r.push(true)).toBe(2);
    expect(r.push(false)).toBe(0);
    for (let i = 0; i < AUTO_CAPTURE_FRAMES; i++) r.push(true);
    expect(r.count).toBe(AUTO_CAPTURE_FRAMES);
    r.reset();
    expect(r.count).toBe(0);
  });
});

describe("the named reasons a frame is not good", () => {
  const good = (): QualityChips => ({
    handFound: true,
    inFrame: true,
    coin: { required: true, found: true, accepted: true, reasons: [] },
    posture: { ok: true, verdict: "ok", message: "" },
    steady: { jitter: 0.01, steady: true },
    sharpness: { value: 0.01, sharp: true },
  });

  it("is empty for a good frame", () => {
    expect(failedChecks(viewDef("palm"), good())).toEqual([]);
  });

  it("says there is no hand and stops there", () => {
    expect(failedChecks(viewDef("palm"), { ...good(), handFound: false })).toEqual(["No hand found."]);
  });

  it("names every failing check, with the coin only when it is required for the view", () => {
    const bad: QualityChips = {
      ...good(),
      inFrame: false,
      coin: { required: true, found: false, accepted: false, reasons: [] },
      steady: { jitter: 0.2, steady: false },
      sharpness: { value: 0, sharp: false },
      posture: { ok: false, verdict: "wrong", message: "Turn the hand further onto its edge." },
    };
    const reasons = failedChecks(viewDef("thumb"), bad);
    expect(reasons).toHaveLength(5);
    expect(reasons.join(" ")).toMatch(/inside the picture/);
    expect(reasons.join(" ")).toMatch(/coin is not found/);
    expect(reasons.join(" ")).toMatch(/further onto its edge/);
    expect(reasons.join(" ")).toMatch(/still/);
    expect(reasons.join(" ")).toMatch(/blurred/);
    const noCoinNeeded = failedChecks(viewDef("thumb"), { ...bad, coin: { required: false, found: false, accepted: false, reasons: [] } });
    expect(noCoinNeeded.join(" ")).not.toMatch(/coin/);
  });

  it("distinguishes a coin that is found but not accepted", () => {
    const r = failedChecks(viewDef("palm"), { ...good(), coin: { required: true, found: true, accepted: false, reasons: ["glare"] } });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/found but not accepted/);
  });
});
