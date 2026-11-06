import { describe, expect, it } from "vitest";
import type { CoinObservation } from "../api/types";
import { drawCoinPulse } from "./draw";
import { drawFocusMask, maskCanvasSize, nextFocusAlpha, type FocusMaskParams, type FocusShape } from "./focusMask";

const P: FocusMaskParams = { margin: 0.06, feather: 0.05, fadeInMs: 350, fadeOutMs: 200, maxAlpha: 0.97 };

/** A 2D context that records what was drawn, with the composite operation and shadow in force at that moment. */
function mockCtx(width = 1280, height = 720) {
  const ops: { call: string; args: number[]; op: string; style: string; blur: number; lineWidth: number; alpha: number }[] = [];
  const saved: Record<string, unknown>[] = [];
  const KEYS = ["globalCompositeOperation", "fillStyle", "strokeStyle", "lineWidth", "lineJoin", "shadowBlur", "shadowColor", "globalAlpha"];
  const c: Record<string, unknown> & { canvas: { width: number; height: number } } = {
    canvas: { width, height },
    globalCompositeOperation: "source-over",
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineJoin: "miter",
    shadowBlur: 0,
    shadowColor: "rgba(0, 0, 0, 0)",
    globalAlpha: 1,
  };
  const rec = (call: string) => (...args: number[]) =>
    void ops.push({ call, args, op: String(c.globalCompositeOperation), style: String(c.fillStyle), blur: Number(c.shadowBlur), lineWidth: Number(c.lineWidth), alpha: Number(c.globalAlpha) });
  for (const m of ["fillRect", "fill", "stroke", "ellipse", "beginPath", "moveTo", "bezierCurveTo", "closePath", "scale"]) c[m] = rec(m);
  c.save = () => void saved.push(Object.fromEntries(KEYS.map((k) => [k, c[k]])));
  c.restore = () => Object.assign(c, saved.pop());
  return { ctx: c as unknown as CanvasRenderingContext2D, raw: c, ops, depth: () => saved.length };
}

const SQUARE = [
  { x: 400, y: 200, z: 0 },
  { x: 600, y: 200, z: 0 },
  { x: 600, y: 500, z: 0 },
  { x: 400, y: 500, z: 0 },
];
const shape = (coin: FocusShape["coin"] = null): FocusShape => ({ contour: SQUARE, handLength: 300, coin });
const COIN = { x: 500, y: 350, rx: 40, ry: 30, angleRad: 0.5 };

describe("focus mask drawing: everything but the hand and the coin goes black", () => {
  it("covers the whole canvas with black at the given opacity first", () => {
    const { ctx, ops } = mockCtx(1280, 720);
    drawFocusMask(ctx, shape(), 0.9, P);
    const first = ops.find((o) => o.call === "fillRect")!;
    expect(first.args).toEqual([0, 0, 1280, 720]);
    expect(first.style).toBe("rgba(0, 0, 0, 0.9)");
    expect(first.op).toBe("source-over");
    expect(ops.find((o) => o.call !== "scale")).toBe(first); // the first thing drawn, before any window is cut
  });

  it("then cuts the hand's window: the outline widened by the margin, in destination-out", () => {
    const { ctx, ops } = mockCtx();
    drawFocusMask(ctx, shape(), 0.9, P);
    const fill = ops.find((o) => o.call === "fill")!;
    const strokes = ops.filter((o) => o.call === "stroke");
    const solid = strokes.at(-1)!;
    expect(fill.op).toBe("destination-out");
    expect(fill.alpha).toBe(1);
    expect(solid.op).toBe("destination-out");
    expect(solid.alpha).toBe(1);
    expect(solid.lineWidth).toBeCloseTo(2 * 0.06 * 300); // the window reaches `margin` beyond the outline
    expect(ops.filter((o) => o.call === "bezierCurveTo")).toHaveLength(4); // the smooth contour, not a polygon
    expect(ops.filter((o) => o.call === "beginPath").length).toBe(1); // one path serves every pass
  });

  it("softens the edge with a few faint, widening strokes instead of a (many times costlier) blur", () => {
    const { ctx, ops, raw } = mockCtx();
    drawFocusMask(ctx, shape(), 0.9, P);
    const feather = ops.filter((o) => o.call === "stroke").slice(0, -1); // all but the solid one
    expect(feather).toHaveLength(3);
    const widths = feather.map((o) => o.lineWidth);
    expect(widths).toEqual([...widths].sort((a, b) => b - a)); // widest first
    expect(widths[0]).toBeCloseTo(2 * (0.06 + 0.05) * 300); // reaches `feather` beyond the margin
    expect(widths.at(-1)!).toBeGreaterThan(2 * 0.06 * 300);
    const alphas = feather.map((o) => o.alpha);
    expect(alphas).toEqual([...alphas].sort((a, b) => a - b)); // each step removes more black than the last
    expect(Math.max(...alphas)).toBeLessThan(1);
    expect(ops.every((o) => o.blur === 0)).toBe(true); // no shadow blur anywhere
    expect(raw.shadowBlur).toBe(0);
  });

  it("has no soft edge when the feather is zero", () => {
    const { ctx, ops } = mockCtx();
    drawFocusMask(ctx, shape(), 0.9, { ...P, feather: 0 });
    expect(ops.filter((o) => o.call === "stroke")).toHaveLength(1); // only the solid window
  });

  it("cuts the coin's window too, a little larger than the coin so its rim is never cut", () => {
    const { ctx, ops } = mockCtx();
    drawFocusMask(ctx, shape(COIN), 0.9, P);
    const e = ops.filter((o) => o.call === "ellipse");
    expect(e).toHaveLength(1);
    expect(e[0].op).toBe("destination-out");
    expect(e[0].args.slice(0, 2)).toEqual([500, 350]);
    expect(e[0].args[2]).toBeGreaterThan(COIN.rx);
    expect(e[0].args[3]).toBeGreaterThan(COIN.ry);
    expect(e[0].args[4]).toBe(0.5);
    expect(ops.filter((o) => o.call === "fill")).toHaveLength(2); // the hand and the coin
  });

  it("has no coin window when no coin was seen, and no stroke at all when margin and feather are zero", () => {
    const { ctx, ops } = mockCtx();
    drawFocusMask(ctx, shape(), 0.9, { ...P, margin: 0, feather: 0 });
    expect(ops.some((o) => o.call === "ellipse")).toBe(false);
    expect(ops.some((o) => o.call === "stroke")).toBe(false);
  });

  it("leaves the context as it found it, so the coin ring and the rest draw normally afterwards", () => {
    const { ctx, raw, depth } = mockCtx();
    drawFocusMask(ctx, shape(COIN), 0.9, P);
    expect(depth()).toBe(0); // every save was restored
    expect(raw.globalCompositeOperation).toBe("source-over");
    expect(raw.shadowBlur).toBe(0);
    expect(raw.lineWidth).toBe(1);
    expect(raw.globalAlpha).toBe(1);
  });

  it("draws nothing at zero opacity or without a usable outline", () => {
    const a = mockCtx();
    drawFocusMask(a.ctx, shape(COIN), 0, P);
    expect(a.ops).toEqual([]);
    const b = mockCtx();
    drawFocusMask(b.ctx, { contour: SQUARE.slice(0, 2), handLength: 300, coin: COIN }, 0.9, P);
    expect(b.ops).toEqual([]);
    const c = mockCtx();
    drawFocusMask(c.ctx, shape(COIN), Number.NaN, P);
    expect(c.ops).toEqual([]);
  });
});

describe("focus mask fade: the full picture is always one moment away", () => {
  it("comes in over fadeInMs while a hand is tracked, and no further than its maximum", () => {
    expect(nextFocusAlpha(0, true, 0, P)).toBe(0);
    expect(nextFocusAlpha(0, true, 175, P)).toBeCloseTo(0.97 / 2);
    expect(nextFocusAlpha(0, true, 350, P)).toBeCloseTo(0.97);
    expect(nextFocusAlpha(0.9, true, 1000, P)).toBe(0.97);
  });

  it("goes over fadeOutMs once the hand is lost, and not below nothing", () => {
    expect(nextFocusAlpha(0.97, false, 100, P)).toBeCloseTo(0.97 / 2);
    expect(nextFocusAlpha(0.97, false, 200, P)).toBeCloseTo(0);
    expect(nextFocusAlpha(0.2, false, 5000, P)).toBe(0);
  });

  it("a fade time of zero is instant, and a clock that stands still or runs back changes nothing", () => {
    expect(nextFocusAlpha(0, true, 16, { ...P, fadeInMs: 0 })).toBe(0.97);
    expect(nextFocusAlpha(0.97, false, 16, { ...P, fadeOutMs: 0 })).toBe(0);
    expect(nextFocusAlpha(0.4, true, -50, P)).toBe(0.4);
    expect(nextFocusAlpha(0.4, false, -50, P)).toBe(0.4);
  });
});

describe("the pulse ring around an accepted coin", () => {
  const coin = { center_x: 500, center_y: 350, major_axis_px: 80, minor_axis_px: 70, angle_deg: 10, accepted: true } as unknown as CoinObservation;

  it("starts at the coin's rim and swells and fades over its period", () => {
    const a = mockCtx();
    drawCoinPulse(a.ctx, coin, 0, 1);
    const b = mockCtx();
    drawCoinPulse(b.ctx, coin, 800, 1); // half way through the 1600 ms period
    const [ea] = a.ops.filter((o) => o.call === "ellipse");
    const [eb] = b.ops.filter((o) => o.call === "ellipse");
    expect(ea.args[2]).toBeCloseTo(40);
    expect(eb.args[2]).toBeGreaterThan(ea.args[2]);
    expect(eb.alpha).toBeLessThan(ea.alpha);
    expect(ea.alpha).toBeLessThanOrEqual(0.55);
  });

  it("leaves the context as it found it", () => {
    const { ctx, raw, depth } = mockCtx();
    drawCoinPulse(ctx, coin, 321, 1);
    expect(depth()).toBe(0);
    expect(raw.globalAlpha).toBe(1);
  });
});

describe("focus mask on a small canvas: the cost does not follow the camera resolution", () => {
  it("sizes the canvas to the cap on the longest side, with the video's aspect", () => {
    expect(maskCanvasSize(1280, 720, 480)).toEqual({ width: 480, height: 270, scale: 480 / 1280 });
    const tall = maskCanvasSize(1080, 1920, 480);
    expect(tall.height).toBe(480);
    expect(tall.width).toBe(270);
    expect(tall.scale).toBeCloseTo(0.25);
    expect(maskCanvasSize(720, 1280, 480)).toEqual({ width: 270, height: 480, scale: 480 / 1280 });
  });

  it("never enlarges a picture that is already small, and never makes an empty canvas", () => {
    expect(maskCanvasSize(320, 240, 480)).toEqual({ width: 320, height: 240, scale: 1 });
    expect(maskCanvasSize(0, 0, 480).width).toBeGreaterThanOrEqual(1);
    expect(maskCanvasSize(5000, 1, 480).height).toBeGreaterThanOrEqual(1);
  });

  it("draws the shape (in video pixels) through a scale, and fills the whole video area", () => {
    const { ctx, ops } = mockCtx(480, 270); // the small canvas
    const view = { width: 1280, height: 720, scale: 480 / 1280 };
    drawFocusMask(ctx, shape(COIN), 0.9, P, view);
    const sc = ops.find((o) => o.call === "scale")!;
    expect(sc.args).toEqual([480 / 1280, 480 / 1280]);
    const black = ops.find((o) => o.call === "fillRect")!;
    expect(black.args).toEqual([0, 0, 1280, 720]); // video pixels: after the scale this is the whole 480 x 270 canvas
    expect(ops.indexOf(sc)).toBeLessThan(ops.indexOf(black));
  });

  it("leaves the context as it found it, and keeps the widths in video pixels (the scale carries them down)", () => {
    const { ctx, ops, raw, depth } = mockCtx(480, 270);
    const view = { width: 1280, height: 720, scale: 0.375 };
    drawFocusMask(ctx, shape(), 0.9, P, view);
    expect(ops.filter((o) => o.call === "stroke").at(-1)!.lineWidth).toBeCloseTo(2 * 0.06 * 300);
    expect(depth()).toBe(0);
    expect(raw.globalAlpha).toBe(1);
    expect(raw.globalCompositeOperation).toBe("source-over");
  });
});
