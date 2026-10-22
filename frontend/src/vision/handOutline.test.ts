// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { goodFrame } from "../test/fixtures";
import { computeHandOutline, drawSmoothContour } from "./handOutline";

describe("handOutline", () => {
  it("computes a closed contour around a detected hand", () => {
    const f = goodFrame();
    const result = computeHandOutline(f.landmarks);
    expect(result.contour.length).toBeGreaterThan(20);
    expect(result.quality).toBeGreaterThan(0.7);
    expect(result.fingersSeparated).toBe(true);
    expect(result.minAdjacentTipGapPx).toBeGreaterThan(15);
  });

  it("detects when adjacent fingers touch or overlap", () => {
    const f = goodFrame();
    // Move middle fingertip (12) right on top of index fingertip (8)
    f.landmarks[12].x = f.landmarks[8].x;
    f.landmarks[12].y = f.landmarks[8].y;

    const result = computeHandOutline(f.landmarks);
    expect(result.fingersSeparated).toBe(false);
    expect(result.quality).toBeLessThan(0.7);
    expect(result.minAdjacentTipGapPx).toBeLessThan(5);
  });

  it("handles empty or insufficient landmarks safely", () => {
    expect(computeHandOutline([]).contour).toEqual([]);
    expect(computeHandOutline([]).quality).toBe(0);
  });

  it("draws smooth contour on a canvas context without errors", () => {
    const f = goodFrame();
    const { contour } = computeHandOutline(f.landmarks);

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    expect(() => {
      drawSmoothContour(ctx, contour, "#3ddc97", "rgba(61,220,151,0.1)", 2.5);
    }).not.toThrow();

    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.bezierCurveTo).toHaveBeenCalled();
  });
});
