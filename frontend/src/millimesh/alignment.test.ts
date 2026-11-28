import { describe, expect, it } from "vitest";
import {
  ALIGN_MESSAGES,
  CORNERS,
  GUIDE_ASPECT,
  NO_HAND,
  evaluateAlignment,
  guideBox,
  handBoxInView,
  isLevel,
  LEVEL_DEG,
  LEVEL_HOLD_DEG,
  phoneTilt,
  sameAlignment,
  tiltDeg,
} from "./alignment";
import type { Point } from "../api/types";
import type { Box } from "./swarm";

const VIEW = { width: 350, height: 540 };

/** A hand box placed relative to the guide: `inset` shrinks every side, `dx`/`dy` shift it (all in guide-size shares). */
function box(inset = 0.05, dx = 0, dy = 0): Box {
  const t = guideBox(VIEW.width, VIEW.height);
  const tw = t.x1 - t.x0;
  const th = t.y1 - t.y0;
  return { x0: t.x0 + (inset + dx) * tw, x1: t.x1 - (inset - dx) * tw, y0: t.y0 + (inset + dy) * th, y1: t.y1 - (inset - dy) * th };
}
const run = (hand: Box | null, over: { tilt?: number | null; phase?: "palm" | "side" | "back"; wasAligned?: boolean } = {}) =>
  evaluateAlignment({ hand, tilt: over.tilt ?? 0, view: VIEW, phase: over.phase ?? "palm", wasAligned: over.wasAligned });

describe("guideBox", () => {
  it("is centred, has the hand-like aspect and stays inside the view", () => {
    for (const [w, h] of [[350, 540], [360, 640], [900, 600], [1200, 500]]) {
      const t = guideBox(w, h);
      expect(t.x0).toBeGreaterThanOrEqual(0);
      expect(t.y0).toBeGreaterThanOrEqual(0);
      expect(t.x1).toBeLessThanOrEqual(w);
      expect(t.y1).toBeLessThanOrEqual(h);
      expect((t.x1 - t.x0) / (t.y1 - t.y0)).toBeCloseTo(GUIDE_ASPECT, 5);
      expect((t.x0 + t.x1) / 2).toBeCloseTo(w / 2, 5);
    }
  });
});

describe("evaluateAlignment", () => {
  it("lights all four corners when the hand fills the box", () => {
    const r = run(box(0.05));
    expect(r.aligned).toBe(true);
    expect(CORNERS.every((c) => r.corners[c])).toBe(true);
    expect(r.hint).toBe("aligned");
  });

  it("lights nothing while no hand is tracked", () => {
    expect(run(null)).toEqual(NO_HAND);
    expect(NO_HAND.aligned).toBe(false);
    expect(NO_HAND.hint).toBe("show_hand");
  });

  it("does not light the corners of a hand that is too small, and says to come closer", () => {
    const r = run(box(0.3));
    expect(r.aligned).toBe(false);
    expect(CORNERS.some((c) => r.corners[c])).toBe(false);
    expect(r.hint).toBe("closer");
  });

  it("is not lined up when the hand is too big, and says to move back", () => {
    const r = run(box(-0.2));
    expect(r.aligned).toBe(false);
    expect(r.hint).toBe("back");
  });

  it("lights only the corners the hand reaches, and says which way to move", () => {
    // a small hand pushed against the right edge, away from the left
    const r = run(box(0.08, 0.1));
    expect(r.aligned).toBe(false);
    expect(r.corners.tr && r.corners.br).toBe(true);
    expect(r.corners.tl || r.corners.bl).toBe(false);
    expect(r.hint).toBe("left");
    expect(run(box(0.08, -0.1)).hint).toBe("right");
    expect(run(box(0.08, 0, 0.1)).hint).toBe("up");
    expect(run(box(0.08, 0, -0.1)).hint).toBe("down");
  });

  it("tells a hand poking out of the box to move the other way", () => {
    // poking out of the left only (narrow overshoot on one side, the other side in reach)
    const t = guideBox(VIEW.width, VIEW.height);
    const tw = t.x1 - t.x0;
    const left = { ...box(0.05, 0, 0), x0: t.x0 - 0.15 * tw, x1: t.x1 - 0.2 * tw };
    expect(run(left).hint).toBe("right");
    const top = { ...box(0.05), y0: t.y0 - 0.2 * (t.y1 - t.y0), y1: t.y1 - 0.2 * (t.y1 - t.y0) };
    expect(run(top).hint).toBe("down");
  });

  it("asks for fingers up when the hand leans, and lights nothing extra for it", () => {
    const r = run(box(0.05), { tilt: 40 });
    expect(r.aligned).toBe(false);
    expect(r.hint).toBe("upright");
    expect(CORNERS.every((c) => r.corners[c])).toBe(true);
    expect(run(box(0.05), { tilt: -20 }).aligned).toBe(true);
    expect(run(box(0.05), { tilt: null }).aligned).toBe(true);
  });

  it("holds a lined-up hand a little longer, so the arrows do not flicker at the edge", () => {
    const edge = box(0.1, 0.05);
    expect(run(edge).aligned).toBe(false);
    expect(run(edge, { wasAligned: true }).aligned).toBe(true);
    expect(run(box(0.05), { tilt: 29 }).aligned).toBe(false);
    expect(run(box(0.05), { tilt: 29, wasAligned: true }).aligned).toBe(true);
    // but a clearly wrong position is wrong either way
    expect(run(box(0.4), { wasAligned: true }).aligned).toBe(false);
  });

  it("lets a narrow, edge-on hand in the Side view stay lined up, whatever its lean", () => {
    const narrow = box(0.05);
    const t = guideBox(VIEW.width, VIEW.height);
    const tw = t.x1 - t.x0;
    narrow.x0 = t.x0 + 0.3 * tw;
    narrow.x1 = t.x1 - 0.3 * tw;
    expect(run(narrow, { phase: "palm" }).aligned).toBe(false);
    expect(run(narrow, { phase: "side", tilt: 60 }).aligned).toBe(true);
    // it still has to stay inside the box and fill its height
    expect(run({ ...narrow, y0: t.y0 + 0.4 * (t.y1 - t.y0) }, { phase: "side" }).aligned).toBe(false);
  });

  it("has a message for every hint", () => {
    for (const h of ["show_hand", "closer", "back", "left", "right", "up", "down", "upright", "aligned"] as const) {
      expect(ALIGN_MESSAGES[h].length).toBeGreaterThan(5);
    }
  });
});

describe("hand box and tilt from landmarks", () => {
  const video = { width: 640, height: 480 };
  const view = { width: 350, height: 540 };
  // a hand with its wrist at the bottom and its fingers up, in video pixels
  const lm = Array.from({ length: 21 }, (_, i) => ({ x: 320 + (i % 5 - 2) * 12, y: 400 - (i / 21) * 260, z: 0 }));

  it("measures the hand box in the view, mirrored or not", () => {
    const plain = handBoxInView(lm, video, view, false)!;
    const mirrored = handBoxInView(lm, video, view, true)!;
    expect(plain.x1).toBeGreaterThan(plain.x0);
    expect(plain.y1).toBeGreaterThan(plain.y0);
    expect(mirrored.x0).toBeCloseTo(view.width - plain.x1, 3);
    expect(mirrored.x1).toBeCloseTo(view.width - plain.x0, 3);
  });

  it("returns null without a full hand or a size", () => {
    expect(handBoxInView(lm.slice(0, 5), video, view, false)).toBeNull();
    expect(handBoxInView(lm, { width: 0, height: 0 }, view, false)).toBeNull();
    expect(handBoxInView(lm, video, { width: 0, height: 0 }, false)).toBeNull();
  });

  it("reads 0 for fingers up and the sign of the lean", () => {
    const up = lm.map((p) => ({ ...p }));
    up[0] = { x: 320, y: 400, z: 0 };
    up[9] = { x: 320, y: 300, z: 0 };
    expect(tiltDeg(up, video, view, false)).toBeCloseTo(0, 5);
    const right = up.map((p) => ({ ...p }));
    right[9] = { x: 420, y: 400, z: 0 };
    expect(Math.abs(tiltDeg(right, video, view, false)!)).toBeCloseTo(90, 5);
    expect(tiltDeg(right, video, view, false)!).toBeCloseTo(-tiltDeg(right, video, view, true)!, 5);
    expect(tiltDeg(lm.slice(0, 5), video, view, false)).toBeNull();
  });
});

describe("sameAlignment", () => {
  it("compares the verdict, the hint and every corner", () => {
    const a = run(box(0.05));
    expect(sameAlignment(a, run(box(0.06)))).toBe(true);
    expect(sameAlignment(a, run(box(0.3)))).toBe(false);
    expect(sameAlignment(a, null)).toBe(false);
    expect(sameAlignment(null, null)).toBe(true);
  });
});

describe("phone tilt from world landmarks", () => {
  /** A palm plane z = kx - m*y: `roll` leans its right side away, `pitch` its top away (degrees). */
  const palm = (rollDeg: number, pitchDeg: number): Point[] => {
    const kx = Math.tan((rollDeg * Math.PI) / 180);
    const ky = Math.tan((pitchDeg * Math.PI) / 180);
    const pts: Point[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
    const set = (i: number, x: number, y: number) => (pts[i] = { x, y, z: kx * x - ky * y });
    set(0, 0, 0);
    set(5, -0.03, -0.08);
    set(9, 0, -0.09);
    set(13, 0.03, -0.08);
    set(17, 0.05, -0.06);
    return pts;
  };

  it("reads 0 for a palm parallel to the phone", () => {
    const t = phoneTilt(palm(0, 0), false)!;
    expect(t.totalDeg).toBeCloseTo(0, 5);
    expect(Math.abs(t.rollDeg)).toBeLessThan(1e-6);
    expect(Math.abs(t.pitchDeg)).toBeLessThan(1e-6);
  });

  it("gives the lean's size and direction as seen on the screen", () => {
    const right = phoneTilt(palm(25, 0), false)!;
    expect(right.rollDeg).toBeCloseTo(-25, 3); // the right side is farther away
    expect(right.totalDeg).toBeCloseTo(25, 3);
    const top = phoneTilt(palm(0, 20), false)!;
    expect(top.pitchDeg).toBeCloseTo(20, 3); // the top is farther away
    expect(top.totalDeg).toBeCloseTo(20, 3);
    // a front camera shows the picture mirrored, so left and right swap
    expect(phoneTilt(palm(25, 0), true)!.rollDeg).toBeCloseTo(25, 3);
    expect(phoneTilt(palm(0, 20), true)!.pitchDeg).toBeCloseTo(20, 3);
  });

  it("does not depend on which way the landmarks' normal happens to point", () => {
    const flipped = palm(25, 10).map((p) => ({ ...p, z: -p.z }));
    expect(phoneTilt(flipped, false)!.totalDeg).toBeCloseTo(phoneTilt(palm(25, 10), false)!.totalDeg, 3);
  });

  it("is null without a full set of landmarks or a palm to measure", () => {
    expect(phoneTilt(null, false)).toBeNull();
    expect(phoneTilt(palm(0, 0).slice(0, 10), false)).toBeNull();
    expect(phoneTilt(Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })), false)).toBeNull();
  });

  it("calls the phone level up to a limit, a little wider once it was level", () => {
    expect(isLevel(null)).toBe(true);
    expect(isLevel(phoneTilt(palm(LEVEL_DEG - 1, 0), false), false)).toBe(true);
    expect(isLevel(phoneTilt(palm(LEVEL_DEG + 2, 0), false), false)).toBe(false);
    expect(isLevel(phoneTilt(palm(LEVEL_DEG + 2, 0), false), true)).toBe(true);
    expect(isLevel(phoneTilt(palm(LEVEL_HOLD_DEG + 2, 0), false), true)).toBe(false);
  });
});
