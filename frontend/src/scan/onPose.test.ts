// @vitest-environment jsdom
// The controller reports the tracked hand of every camera frame (for the 3D camera overlay), and skips
// the 2D hand drawing when a 3D layer draws it instead.
import { describe, expect, it, vi } from "vitest";
import { goodFrame, publicConfig } from "../test/fixtures";
import { ScanController } from "./scanController";

const noop = new Proxy({}, { get: () => () => undefined, set: () => true });

function setup(detect: () => unknown, onPose: ((l: unknown, f: { width: number; height: number }) => void) | undefined, extra: object = {}, ctx: unknown = noop) {
  const video = document.createElement("video");
  const overlay = document.createElement("canvas");
  const c = new ScanController(video, overlay, publicConfig(), { mode: "scan", facing: "environment", onStatus: () => {}, onPose: onPose as never, ...extra });
  const priv = c as unknown as Record<string, unknown>;
  priv.tracker = { detect };
  priv.running = true;
  priv.prepareCanvas = () => ({ ctx, w: 1280, h: 720, scale: 1 });
  return { c, priv, frame: () => (priv.processScanFrame as () => void).call(c) };
}

describe("ScanController onPose", () => {
  it("is called every frame with the hand's landmarks, and with null when the hand is gone", () => {
    const landmarks = goodFrame().landmarks;
    let hand: unknown = { landmarks, world: null, handedness: "Right", handednessScore: 0.9 };
    const onPose = vi.fn();
    const { frame } = setup(() => hand, onPose);

    frame();
    expect(onPose).toHaveBeenCalledTimes(1);
    expect(onPose.mock.calls[0][1]).toEqual({ width: 1280, height: 720 }); // the frame the pixels belong to
    const got = onPose.mock.calls[0][0] as { x: number; y: number }[];
    expect(got).toHaveLength(21); // the smoothed landmarks drawn on the overlay
    expect(Math.abs(got[0].x - landmarks[0].x)).toBeLessThan(1e-6); // first frame: unsmoothed

    hand = null;
    frame();
    expect(onPose).toHaveBeenCalledTimes(2);
    expect(onPose.mock.calls[1][0]).toBeNull();
  });

  it("is optional", () => {
    const { frame } = setup(() => null, undefined);
    expect(() => frame()).not.toThrow();
  });

  it("draws the 2D outline and skeleton unless a 3D layer draws the hand", () => {
    const landmarks = goodFrame().landmarks;
    const hand = { landmarks, world: null, handedness: "Right", handednessScore: 0.9 };
    const drawn = (extra: object) => {
      let calls = 0;
      const ctx = new Proxy({}, { get: () => () => void calls++, set: () => true });
      setup(() => hand, undefined, extra, ctx).frame();
      return calls;
    };
    const with2d = drawn({});
    const with3d = drawn({ overlay3d: true });
    expect(with2d).toBeGreaterThan(with3d);
    expect(with3d).toBeLessThan(with2d / 2); // only the search window is left on the 2D layer
  });

  it("can hand the hand back to the 2D layer mid-scan", () => {
    const landmarks = goodFrame().landmarks;
    const hand = { landmarks, world: null, handedness: "Right", handednessScore: 0.9 };
    let calls = 0;
    const ctx = new Proxy({}, { get: () => () => void calls++, set: () => true });
    const { frame, c } = setup(() => hand, undefined, { overlay3d: true }, ctx);
    frame();
    const only3d = calls;
    calls = 0;
    c.setOverlay3d(false);
    frame(); // the very next frame draws the outline, skeleton and tags again
    expect(calls).toBeGreaterThan(only3d);
  });

  it("survives a pose consumer that throws: the scan loop goes on", () => {
    const hand = { landmarks: goodFrame().landmarks, world: null, handedness: "Right", handednessScore: 0.9 };
    const onStatus = vi.fn();
    const boom = vi.fn(() => {
      throw new Error("scene failed");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { frame, priv } = setup(() => hand, boom, { onStatus });
      expect(() => frame()).not.toThrow();
      expect(() => frame()).not.toThrow();
      expect(boom).toHaveBeenCalledTimes(2); // still called every frame
      expect(onStatus).toHaveBeenCalled(); // and the rest of the frame (guidance, status) still ran
      expect(priv.running).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it("collects exactly the same frames and reports the same guidance with the 3D layer on or off", () => {
    // The 3D layer only reads landmarks. Drive the same camera frames and coin results through two
    // controllers, one drawing in 3D and one in 2D (and one whose pose consumer throws): what would be sent
    // to the server, and what the customer is told, must be identical.
    const base = goodFrame();
    const coin = { ...base.coin!, found: true, candidates: [] };
    const hand = { landmarks: base.landmarks, world: base.world_landmarks, handedness: "Right", handednessScore: 0.9 };
    const run = (extra: object, onPose?: () => void) => {
      // A fixed clock: status updates are throttled by wall-clock time, which must not decide the comparison.
      let tick = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => (tick += 7));
      const statuses: { live: unknown; collected: unknown; liveMm: unknown }[] = [];
      const { c, priv, frame } = setup(() => hand, onPose, {
        ...extra,
        onStatus: (s: { live: unknown; collected: unknown; liveMm: unknown }) => statuses.push({ live: s.live, collected: s.collected, liveMm: s.liveMm }),
      });
      for (let i = 0; i < 6; i++) {
        frame();
        (priv.onCoin as (...a: unknown[]) => void).call(c, { coin, tracked: false }, { x: 0, y: 0 }, { hand, now: 1000 + i * 200, w: base.image_width, h: base.image_height, brightness: base.brightness, prevLandmarks: null });
      }
      clock.mockRestore();
      return { frames: priv.frames, statuses: statuses.map((s) => ({ live: s.live, collected: s.collected })) };
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const off = run({ overlay3d: false });
      const on = run({ overlay3d: true }, () => undefined);
      const throwing = run({ overlay3d: true }, () => {
        throw new Error("scene failed");
      });
      expect((off.frames as unknown[]).length).toBeGreaterThan(0); // the test really collects frames
      expect(on.frames).toEqual(off.frames);
      expect(throwing.frames).toEqual(off.frames);
      expect(on.statuses).toEqual(off.statuses);
      expect(throwing.statuses).toEqual(off.statuses);
    } finally {
      err.mockRestore();
    }
  });
});

