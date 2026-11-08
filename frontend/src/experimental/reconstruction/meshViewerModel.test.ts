// The pure helpers of the experimental mesh viewer: preset directions, frames, colours, bounds, grid, landmarks.
import { describe, expect, it } from "vitest";
import {
  boundsOf,
  cleanFrame,
  cleanLandmarks,
  confidenceColours,
  frameExtents,
  gridFor,
  gridStep,
  gridWords,
  HAND_BONES,
  homeView,
  isPalmDown,
  shareAtLeast,
  supportColours,
  supportCounts,
  SUPPORT_LEGEND,
  viewPresets,
  viewerFrameOf,
} from "./meshViewerModel";

const palmDown = cleanFrame({ origin: [0, 0, 12], x: [0, 1, 0], y: [1, 0, 0], z: [0, 0, -1] })!;
const n = (v: number[]) => v.map((x) => x + 0); // -0 to 0
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("frames and presets", () => {
  it("rejects missing, non-finite or degenerate frames and normalises the axes", () => {
    expect(cleanFrame(null)).toBeNull();
    expect(cleanFrame({ origin: [0, 0, 0], x: [1, 0, 0], y: [1, 0, 0], z: [0, 0, 1] })).toBeNull();
    expect(cleanFrame({ origin: [0, 0, NaN], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] })).toBeNull();
    expect(cleanFrame({ origin: [0, 0, 0], x: [0, 0, 0], y: [0, 1, 0], z: [0, 0, 1] })).toBeNull();
    const f = cleanFrame({ origin: [1, 2, 3], x: [2, 0, 0], y: [0, 3, 0], z: [0, 0, 4] })!;
    expect(f.x).toEqual([1, 0, 0]);
    expect(f.z).toEqual([0, 0, 1]);
    expect(viewerFrameOf({ origin: [0, 0, 0], axisX: [1, 0, 0], axisY: [0, 1, 0], axisZ: [0, 0, 1] }).y).toEqual([0, 1, 0]);
  });

  it("knows a palm-down hand", () => {
    expect(isPalmDown(palmDown)).toBe(true);
    expect(isPalmDown(cleanFrame({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }))).toBe(false);
    expect(isPalmDown(null)).toBe(false);
  });

  it("anatomical presets look from the right side, with an orthogonal screen-up", () => {
    const p = Object.fromEntries(viewPresets(palmDown).map((v) => [v.id, v]));
    expect(Object.keys(p)).toEqual(["top", "palm", "back", "thumb", "little", "fingertips", "wrist"]);
    expect(n(p.top.toCamera)).toEqual([0, 0, 1]);
    expect(n(p.palm.toCamera)).toEqual([0, 0, -1]); // palm-down: the palm is seen from under the board
    expect(n(p.back.toCamera)).toEqual([0, 0, 1]);
    expect(n(p.thumb.toCamera)).toEqual([0, -1, 0]);
    expect(n(p.little.toCamera)).toEqual([0, 1, 0]);
    expect(n(p.fingertips.toCamera)).toEqual([1, 0, 0]);
    expect(n(p.wrist.toCamera)).toEqual([-1, 0, 0]);
    for (const v of Object.values(p)) {
      expect(Math.abs(dot(v.toCamera, v.up))).toBeLessThan(1e-9);
      expect(Math.hypot(...v.up)).toBeCloseTo(1, 9);
    }
    expect(n(p.top.up)).toEqual([1, 0, 0]); // fingers up on screen
    expect(n(p.fingertips.up)).toEqual([0, 0, 1]); // board up
    expect(p.palm.facesBoard).toBe(true);
    expect(p.back.facesBoard).toBe(false);
  });

  it("without a frame the presets are named by the board axes", () => {
    const p = viewPresets(null);
    expect(p.map((v) => v.label)).toEqual(["Top (+z)", "Underside (−z)", "+x end", "−x end", "+y side", "−y side"]);
    expect(p.find((v) => v.id === "bottom")!.facesBoard).toBe(true);
    for (const v of p) expect(Math.abs(dot(v.toCamera, v.up))).toBeLessThan(1e-9);
  });

  it("the home view is above the board and comes from the wrist side", () => {
    const h = homeView(palmDown);
    expect(h.toCamera[2]).toBeGreaterThan(0.6);
    expect(h.toCamera[0]).toBeLessThan(0); // -fingers = wrist side
    expect(Math.abs(dot(h.toCamera, h.up))).toBeLessThan(1e-9);
    expect(homeView(null).toCamera[2]).toBeGreaterThan(0.6);
  });
});

describe("colours and counts", () => {
  it("support colours follow the legend table; unknown codes are drawn as truncated", () => {
    const c = supportColours(Uint8Array.from([0, 2, 9]));
    const hex = (i: number) => "#" + [0, 1, 2].map((k) => Math.round(c[i * 3 + k] * 255).toString(16).padStart(2, "0")).join("");
    expect(hex(0)).toBe(SUPPORT_LEGEND[0].colour);
    expect(hex(1)).toBe(SUPPORT_LEGEND[2].colour);
    expect(hex(2)).toBe(SUPPORT_LEGEND[4].colour);
    expect(SUPPORT_LEGEND.map((s) => s.words)).toEqual(["observed", "implied", "bounded by the board, not observed", "cut at the forearm", "truncated (a failure)"]);
  });

  it("confidence colours clamp and treat non-finite as 0", () => {
    const c = confidenceColours(Float32Array.from([-1, 0, 1, 2, NaN]));
    expect(Array.from(c.slice(0, 3))).toEqual(Array.from(c.slice(3, 6)));
    expect(Array.from(c.slice(6, 9))).toEqual(Array.from(c.slice(9, 12)));
    expect(Array.from(c.slice(12, 15))).toEqual(Array.from(c.slice(0, 3)));
  });

  it("counts labels and shares", () => {
    expect(supportCounts(Uint8Array.from([0, 0, 1, 2, 3, 4, 7]))).toEqual([2, 1, 1, 1, 2]);
    expect(shareAtLeast(Float32Array.from([0, 0.5, 1, 0.2]), 0.5)).toBe(0.5);
    expect(shareAtLeast(new Float32Array(), 0.5)).toBe(0);
  });
});

describe("bounds, extents and the grid", () => {
  it("bounds skip non-finite points", () => {
    const b = boundsOf(Float32Array.from([0, 0, 0, 10, 20, 30, NaN, 1e9, 0]))!;
    expect(b.min).toEqual([0, 0, 0]);
    expect(b.max).toEqual([10, 20, 30]);
    expect(b.center).toEqual([5, 10, 15]);
    expect(boundsOf(new Float32Array())).toBeNull();
  });

  it("extents along a hand frame", () => {
    const e = frameExtents(Float32Array.from([0, 0, 0, 200, 90, 40]), palmDown)!;
    expect(e).toEqual({ length: 200, breadth: 90, thickness: 40 });
  });

  it("grid steps are round and the grid sits on the board plane for a resting hand", () => {
    expect(gridStep(240)).toBe(10);
    expect(gridStep(140)).toBe(5);
    expect(gridStep(3000)).toBe(100);
    expect(gridStep(0.9)).toBe(0.05);
    const g = gridFor(boundsOf(Float32Array.from([-20, -50, 0.4, 210, 45, 48]))!);
    expect(g.onBoard).toBe(true);
    expect(g.planeZ).toBe(0);
    expect(g.z).toBeLessThan(0); // a hair under the board face, so the two never fight
    expect(g.step).toBe(10);
    expect(g.x0).toBeLessThanOrEqual(-20);
    expect(g.x1).toBeGreaterThanOrEqual(210);
    expect(gridWords(g, "mm")).toBe("Grid: 10 mm squares, darker every 50 mm, on the board plane (z = 0)");
    const off = gridFor(boundsOf(Float32Array.from([0, 0, 500, 100, 100, 600]))!);
    expect(off.onBoard).toBe(false);
    expect(gridWords(off, "mm")).toMatch(/just under the lowest point \(z = 500.0 mm\)/);
  });
});

describe("landmarks", () => {
  it("accepts 21 triples or 63 numbers, rejects anything else", () => {
    const triples = Array.from({ length: 21 }, (_, i) => [i, i, i]);
    expect(cleanLandmarks(triples)).toHaveLength(63);
    expect(cleanLandmarks(new Float32Array(63))).toHaveLength(63);
    expect(cleanLandmarks(new Float32Array(60))).toBeNull();
    expect(cleanLandmarks([[0, 0, 0]])).toBeNull();
    expect(cleanLandmarks(triples.map((p, i) => (i === 3 ? [NaN, 0, 0] : p)))).toBeNull();
    expect(cleanLandmarks(null)).toBeNull();
  });

  it("the MediaPipe topology has 21 bones over 21 joints", () => {
    expect(HAND_BONES).toHaveLength(21);
    const used = new Set(HAND_BONES.flat());
    expect(used.size).toBe(21);
  });
});
