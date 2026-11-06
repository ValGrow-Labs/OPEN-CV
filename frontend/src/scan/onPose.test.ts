// @vitest-environment jsdom
// The controller reports the tracked hand of every camera frame (for the 3D camera overlay), and skips
// the 2D hand drawing when a 3D layer draws it instead.
import { describe, expect, it, vi } from "vitest";
import { goodFrame, publicConfig } from "../test/fixtures";
import { ScanController } from "./scanController";

const noop = new Proxy({}, { get: () => () => undefined, set: () => true });

function setup(detect: () => unknown, onPose: ((l: unknown, f: { width: number; height: number }) => void) | undefined, extra: object = {}, ctx: unknown = noop, cfg = publicConfig()) {
  const video = document.createElement("video");
  const overlay = document.createElement("canvas");
  const c = new ScanController(video, overlay, cfg, { mode: "scan", facing: "environment", onStatus: () => {}, onPose: onPose as never, ...extra });
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


// ---------------------------------------------------------------------------------------------------------
// The focus mask: with the 3D layer on, everything but the hand and the coin is drawn black on a canvas of its
// own (small, stretched over the video by CSS); the 2D drawing canvas keeps the coin ring and the pulse.
// ---------------------------------------------------------------------------------------------------------

/** A 2D context that records the names of the calls made on it, with the composite operation at the time. */
function recordingCtx() {
  const calls: string[] = [];
  const state: Record<string, unknown> = { canvas: { width: 1280, height: 720 }, globalCompositeOperation: "source-over" };
  const saved: unknown[] = [];
  const ctx = new Proxy(state, {
    get: (t, k) => {
      if (k === "save") return () => void saved.push(t.globalCompositeOperation); // like a real canvas
      if (k === "restore") return () => void (t.globalCompositeOperation = saved.pop());
      return k in t ? t[k as string] : (...a: unknown[]) => void calls.push(`${String(k)}:${t.globalCompositeOperation}:${a.join(",")}`);
    },
    set: (t, k, v) => ((t[k as string] = v), true),
  });
  return { ctx, calls, count: (name: string) => calls.filter((c) => c.startsWith(`${name}:`)).length };
}

/** A stand-in for the mask canvas: its pixel size is set by the controller, its context records. */
function fakeMaskCanvas() {
  const rec = recordingCtx();
  const canvas = { width: 300, height: 150, getContext: () => rec.ctx } as unknown as HTMLCanvasElement;
  return { canvas, ...rec };
}

const withOverlay = (patch: object) => {
  const cfg = publicConfig();
  return { ...cfg, live_scan: { ...cfg.live_scan, overlay_3d: { ...cfg.live_scan.overlay_3d, ...patch } } };
};

describe("ScanController focus mask", () => {
  const base = goodFrame();
  const coin = { ...base.coin!, found: true, accepted: true, candidates: [] };
  const hand = { landmarks: base.landmarks, world: null, handedness: "Right", handednessScore: 0.9 };

  /** Run frames 100 ms apart (the clock stands still within a frame); ``tracked`` says for each frame whether
   *  the tracker finds the hand. The mask has its own canvas; ``main`` is the 2D drawing canvas. */
  function run(extra: object, cfg = publicConfig(), tracked: boolean[] = [true, true, true, true], withMask = true) {
    let t = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => t);
    const main = recordingCtx();
    const mask = fakeMaskCanvas();
    let current: unknown = hand;
    const { frame, priv, c } = setup(() => current, undefined, { ...(withMask ? { maskCanvas: mask.canvas } : {}), ...extra }, main.ctx, cfg);
    priv.lastCoin = coin;
    const perFrame: number[] = [];
    for (const on of tracked) {
      t += 100;
      current = on ? hand : null;
      const before = mask.count("fillRect");
      frame();
      perFrame.push(mask.count("fillRect") - before);
    }
    clock.mockRestore();
    return { main, mask, perFrame, c, priv };
  }

  it("fades in over the first frames while a hand is tracked, with clear windows for the hand and the coin", () => {
    const { mask, perFrame } = run({ overlay3d: true });
    expect(perFrame[0]).toBe(0); // nothing yet: no time has passed since the layer began
    expect(perFrame.slice(1)).toEqual([1, 1, 1]); // then one black fill per frame
    expect(mask.calls.some((c) => c.startsWith("fill:destination-out"))).toBe(true); // the hand's window
    expect(mask.calls.some((c) => c.startsWith("ellipse:destination-out"))).toBe(true); // the coin's window
  });

  it("draws on a canvas of its own, never larger than focus_mask_max_px, with the video's aspect", () => {
    const { mask } = run({ overlay3d: true }); // the video here is 1280 x 720
    expect(mask.canvas.width).toBe(480);
    expect(mask.canvas.height).toBe(270);
    const black = mask.calls.find((c) => c.startsWith("fillRect:"))!;
    expect(black).toBe("fillRect:source-over:0,0,1280,720"); // in video pixels: the transform scales it onto the canvas
    expect(mask.calls.some((c) => c.startsWith("scale:") && c.endsWith(`${480 / 1280},${480 / 1280}`))).toBe(true);
  });

  it("the cost does not depend on the video size: a 1080 x 1920 video gets the same small canvas", () => {
    let t = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => t);
    const mask = fakeMaskCanvas();
    const hand2 = { landmarks: base.landmarks, world: null, handedness: "Right", handednessScore: 0.9 };
    const { frame, priv } = setup(() => hand2, undefined, { overlay3d: true, maskCanvas: mask.canvas }, recordingCtx().ctx);
    priv.prepareCanvas = () => ({ ctx: recordingCtx().ctx, w: 1080, h: 1920, scale: 1 });
    priv.lastCoin = coin;
    for (let i = 0; i < 3; i++) {
      t += 100;
      frame();
    }
    clock.mockRestore();
    expect(Math.max(mask.canvas.width, mask.canvas.height)).toBe(480);
    expect(mask.canvas.width / mask.canvas.height).toBeCloseTo(1080 / 1920, 2); // same aspect as the video
  });

  it("honours the configured size", () => {
    const { mask } = run({ overlay3d: true }, withOverlay({ focus_mask_max_px: 256 }) as never);
    expect(Math.max(mask.canvas.width, mask.canvas.height)).toBe(256);
  });

  it("keeps the black off the 2D drawing canvas: only the coin ring and the pulse are drawn there", () => {
    const { main } = run({ overlay3d: true });
    expect(main.count("fillRect")).toBe(0);
    expect(main.calls.some((c) => c.includes("destination-out"))).toBe(false);
    expect(main.count("ellipse")).toBeGreaterThanOrEqual(2); // the coin ring and the pulse
  });

  it("is not drawn when config turns it off: the 3D layer sits over the normal picture", () => {
    const { mask } = run({ overlay3d: true }, withOverlay({ focus_mask: false }) as never);
    expect(mask.count("fillRect")).toBe(0);
  });

  it("is not drawn without the 3D layer: the old 2D drawing and the full picture", () => {
    const { mask, main } = run({ overlay3d: false });
    expect(mask.count("fillRect")).toBe(0);
    expect(main.count("fillRect")).toBe(0);
  });

  it("is simply off without a mask canvas, and nothing else changes", () => {
    const { main, perFrame } = run({ overlay3d: true }, publicConfig(), [true, true, true], false);
    expect(perFrame).toEqual([0, 0, 0]);
    expect(main.count("ellipse")).toBeGreaterThanOrEqual(2); // the coin ring and the pulse are still drawn
  });

  it("goes away at once when the 3D layer is handed back to 2D mid-scan: the mask canvas is wiped", () => {
    const { mask, c, priv } = run({ overlay3d: true });
    expect(mask.count("fillRect")).toBeGreaterThan(0);
    const wipes = mask.count("clearRect");
    c.setOverlay3d(false);
    expect(priv.focusAlpha).toBe(0);
    expect(mask.count("clearRect")).toBe(wipes + 1); // the picture is whole again right away
    const fills = mask.count("fillRect");
    (priv.processScanFrame as () => void).call(c);
    expect(mask.count("fillRect")).toBe(fills);
    expect(mask.count("clearRect")).toBe(wipes + 1); // and not wiped again and again
  });

  it("fades out when the hand is lost, so the customer can find their hand, then wipes the canvas and stops drawing", () => {
    // fade in 350 ms, out 200 ms, frames 100 ms apart: black for one frame after the hand goes, then gone.
    const { mask, perFrame, priv } = run({ overlay3d: true }, publicConfig(), [true, true, true, true, true, false, false, false, false]);
    expect(perFrame.slice(5)).toEqual([1, 0, 0, 0]); // the first lost frame still has some black (fading), then none
    expect(priv.focusAlpha).toBe(0);
    expect(priv.focusShape).toBeNull();
    const last = mask.calls.map((c, i) => (c.startsWith("fillRect:") ? i : -1)).filter((i) => i >= 0).at(-1)!;
    expect(mask.calls.slice(last).some((c) => c.startsWith("clearRect:"))).toBe(true); // wiped after the last black
  });

  it("shows the full picture while no hand has been found", () => {
    const { perFrame } = run({ overlay3d: true }, publicConfig(), [false, false, false]);
    expect(perFrame).toEqual([0, 0, 0]);
  });

  it("collects exactly the same frames and reports the same guidance with the mask on or off", () => {
    // Display only: the same camera frames and coin results must give the same frames for the server and the
    // same guidance for the customer, whether the black is drawn or not.
    const frames = (cfg: ReturnType<typeof publicConfig>, extra: object) => {
      let tick = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => (tick += 7));
      const statuses: { live: unknown; collected: unknown }[] = [];
      const mask = fakeMaskCanvas();
      const { c, priv, frame } = setup(() => hand, undefined, { ...extra, maskCanvas: mask.canvas, onStatus: (s: { live: unknown; collected: unknown }) => statuses.push({ live: s.live, collected: s.collected }) }, recordingCtx().ctx, cfg);
      for (let i = 0; i < 6; i++) {
        frame();
        (priv.onCoin as (...a: unknown[]) => void).call(c, { coin: { ...coin, accepted: true }, tracked: false }, { x: 0, y: 0 }, { hand, now: 1000 + i * 200, w: base.image_width, h: base.image_height, brightness: base.brightness, prevLandmarks: null });
      }
      clock.mockRestore();
      return { frames: priv.frames, statuses, drawn: mask.count("fillRect") };
    };
    const off = frames(withOverlay({ focus_mask: false }) as never, { overlay3d: true });
    const on = frames(publicConfig(), { overlay3d: true });
    expect(off.drawn).toBe(0);
    expect(on.drawn).toBeGreaterThan(0); // the mask really was drawn in one run and not in the other
    expect((off.frames as unknown[]).length).toBeGreaterThan(0); // the test really collects frames
    expect(on.frames).toEqual(off.frames);
    expect(on.statuses).toEqual(off.statuses);
  });

  it("a pulse ring swells around an accepted coin in 3D mode, and not for a coin that is not accepted", () => {
    const rings = (accepted: boolean) => {
      let t = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => (t += 100));
      const rec = recordingCtx();
      const { frame, priv } = setup(() => hand, undefined, { overlay3d: true }, rec.ctx);
      priv.lastCoin = { ...coin, accepted };
      frame();
      clock.mockRestore();
      return rec.calls.filter((c) => c.startsWith("ellipse:source-over")).length;
    };
    expect(rings(true)).toBe(2); // the coin ring and the pulse
    expect(rings(false)).toBe(1); // only the (dashed, amber) coin ring
  });

  it("no pulse under reduced motion", () => {
    const had = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", { value: () => ({ matches: true }), configurable: true, writable: true });
    try {
      let t = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => (t += 100));
      const rec = recordingCtx();
      const { frame, priv } = setup(() => hand, undefined, { overlay3d: true }, rec.ctx);
      priv.lastCoin = coin;
      frame();
      clock.mockRestore();
      expect(rec.calls.filter((c) => c.startsWith("ellipse:source-over")).length).toBe(1);
    } finally {
      if (had) Object.defineProperty(window, "matchMedia", had);
      else delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });

  it("2D mode draws no pulse: it keeps drawing exactly as before", () => {
    const rec = recordingCtx();
    const { frame, priv } = setup(() => hand, undefined, { overlay3d: false }, rec.ctx);
    priv.lastCoin = coin;
    frame();
    expect(rec.calls.filter((c) => c.startsWith("ellipse:source-over")).length).toBe(1);
  });
});
