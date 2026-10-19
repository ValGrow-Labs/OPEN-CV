import { describe, expect, it } from "vitest";
import { calibrationParams as cal, captureParams as cap, goodFrame } from "../test/fixtures";
import { evaluateFrame } from "./liveChecks";

describe("live capture checks", () => {
  it("accepts a clean frame", () => {
    const r = evaluateFrame(goodFrame(), null, cap, cal);
    expect(r.ok).toBe(true);
    expect(r.codes).toEqual([]);
  });

  it("asks for a hand when none is detected", () => {
    const r = evaluateFrame(null, null, cap, cal);
    expect(r.codes).toEqual(["no_hand"]);
    expect(r.message).toMatch(/palm/i);
  });

  it("flags a hand outside the frame", () => {
    const f = goodFrame();
    f.landmarks[12].y = -10;
    expect(evaluateFrame(f, null, cap, cal).codes).toContain("hand_out_of_frame");
  });

  it("flags a hand that is too small", () => {
    const f = goodFrame();
    const c = f.landmarks[9];
    f.landmarks = f.landmarks.map((p) => ({ x: c.x + (p.x - c.x) * 0.3, y: c.y + (p.y - c.y) * 0.3, z: 0 }));
    expect(evaluateFrame(f, null, cap, cal).codes).toContain("hand_too_small");
  });

  it("flags a bent middle finger", () => {
    const f = goodFrame();
    f.landmarks[12].x += 60;
    expect(evaluateFrame(f, null, cap, cal).codes).toContain("fingers_bent");
  });

  it("requires the coin and forwards coin quality reasons", () => {
    const f = goodFrame();
    f.coin = null;
    expect(evaluateFrame(f, null, cap, cal).codes).toContain("coin_missing");
    const g = goodFrame();
    g.coin!.reasons = ["coin_glare"];
    g.coin!.accepted = false;
    const r = evaluateFrame(g, null, cap, cal);
    expect(r.codes).toContain("coin_glare");
    expect(r.ok).toBe(false);
  });

  it("requires the coin to be on the palm", () => {
    const f = goodFrame();
    f.coin!.center_y -= 400;
    expect(evaluateFrame(f, null, cap, cal).codes).toContain("coin_not_on_palm");
  });

  it("rejects a strongly tilted coin", () => {
    const f = goodFrame();
    f.coin!.minor_axis_px = f.coin!.major_axis_px * Math.cos((30 * Math.PI) / 180);
    expect(evaluateFrame(f, null, cap, cal).codes).toContain("coin_tilted");
  });

  it("checks lighting", () => {
    const f = goodFrame();
    f.brightness = 10;
    expect(evaluateFrame(f, null, cap, cal).codes).toContain("too_dark");
    f.brightness = 250;
    expect(evaluateFrame(f, null, cap, cal).codes).toContain("too_bright");
  });

  it("asks to hold still when landmarks jump between frames", () => {
    const f = goodFrame();
    const moved = f.landmarks.map((p) => ({ ...p, x: p.x + 40 }));
    expect(evaluateFrame(f, moved, cap, cal).codes).toEqual(["hold_still"]);
    expect(evaluateFrame(f, f.landmarks, cap, cal).ok).toBe(true);
  });
});
