// @vitest-environment jsdom
// The two read-only hooks the MILLIMESH scan uses (onFrameAccepted, holdCompletion). They are strictly additive: without
// them nothing changes, they never change which frames are accepted, a hook that throws cannot stop the scan, and the
// completion hold can only ask for MORE accepted frames (never fewer, never a frame that failed the live checks).
import { describe, expect, it, vi } from "vitest";
import type { FrameObservation } from "../api/types";
import { goodFrame, publicConfig } from "../test/fixtures";
import { ScanController, type ScanControllerOptions } from "./scanController";

function setup(opts: Partial<ScanControllerOptions> = {}, ok: () => boolean = () => true) {
  const config = publicConfig();
  config.capture = { ...config.capture, frames_target: 3, frames_min_accepted: 2 };
  const completed: FrameObservation[][] = [];
  const statuses: string[] = [];
  const c = new ScanController(document.createElement("video"), document.createElement("canvas"), config, {
    mode: "scan",
    facing: "environment",
    onStatus: (s) => statuses.push(s.phase),
    onComplete: (frames) => completed.push(frames),
    ...opts,
  });
  const priv = c as unknown as Record<string, unknown>;
  priv.running = true;
  priv.evaluate = () => ({ ok: ok(), codes: ok() ? [] : ["coin_blurry"], message: "" });
  const f = goodFrame();
  const hand = { landmarks: f.landmarks, world: f.world_landmarks, handedness: f.handedness, handednessScore: f.handedness_score };
  const res = { coin: { ...f.coin!, found: true, candidates: [] }, tracked: false };
  let now = 1000;
  /** One coin result for one camera frame (the frame time moves on by more than min_frame_interval_ms). */
  const coin = () => {
    now += 200;
    (priv.onCoin as (r: unknown, roi: unknown, snap: unknown) => void).call(c, res, { x: 0, y: 0 }, { hand, now, w: 1280, h: 720, brightness: 120, prevLandmarks: null });
  };
  return { c, priv, coin, completed, statuses };
}

describe("ScanController onFrameAccepted", () => {
  it("is called with every frame the live checks accepted, and with the very frames onComplete hands over", () => {
    const seen: FrameObservation[] = [];
    const { coin, completed } = setup({ onFrameAccepted: (f) => seen.push(f) });
    coin();
    coin();
    expect(seen).toHaveLength(2);
    coin();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toHaveLength(3);
    expect(seen).toHaveLength(3);
    seen.forEach((f, i) => expect(completed[0][i]).toBe(f));
  });

  it("is not called for a frame that failed the live checks", () => {
    let pass = false;
    const onFrameAccepted = vi.fn();
    const { coin, priv } = setup({ onFrameAccepted }, () => pass);
    coin();
    coin();
    expect(onFrameAccepted).not.toHaveBeenCalled();
    expect((priv.frames as unknown[]).length).toBe(0);
    pass = true;
    coin();
    expect(onFrameAccepted).toHaveBeenCalledTimes(1);
  });

  it("is optional: the scan completes exactly as before without it", () => {
    const { coin, completed } = setup();
    coin();
    coin();
    coin();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toHaveLength(3);
  });

  it("survives a hook that throws: the frame is still collected and the scan still completes", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { coin, completed } = setup({
      onFrameAccepted: () => {
        throw new Error("display failed");
      },
    });
    coin();
    coin();
    coin();
    expect(completed[0]).toHaveLength(3);
    err.mockRestore();
  });

  it("cannot alter what is collected: the hook gets the same frame object the scan keeps", () => {
    const { coin, priv } = setup({ onFrameAccepted: (f) => void (f.landmarks.length === 21) });
    coin();
    expect((priv.frames as FrameObservation[])[0].landmarks).toHaveLength(21);
  });
});

describe("ScanController onCollectionReset", () => {
  it("is called when the collected frames are dropped, and the count really starts again", () => {
    const onCollectionReset = vi.fn();
    const { c, coin, priv } = setup({ onCollectionReset, onFrameAccepted: () => undefined });
    coin();
    coin();
    expect((priv.frames as unknown[]).length).toBe(2);
    c.resetCollection();
    expect(onCollectionReset).toHaveBeenCalledTimes(1);
    expect((priv.frames as unknown[]).length).toBe(0);
  });

  it("is optional and a throwing hook cannot break the reset", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const a = setup();
    expect(() => a.c.resetCollection()).not.toThrow();
    const b = setup({
      onCollectionReset: () => {
        throw new Error("boom");
      },
    });
    b.coin();
    expect(() => b.c.resetCollection()).not.toThrow();
    expect((b.priv.frames as unknown[]).length).toBe(0);
    err.mockRestore();
  });
});

describe("ScanController holdCompletion", () => {
  it("keeps the view open past its frame target while it returns true, then completes with every accepted frame", () => {
    let hold = true;
    const holdCompletion = vi.fn(() => hold);
    const { coin, completed, priv } = setup({ holdCompletion });
    for (let i = 0; i < 6; i++) coin();
    expect(completed).toHaveLength(0); // the target (3) was passed twice over, the view is still collecting
    expect((priv.frames as unknown[]).length).toBe(6);
    expect(priv.running).toBe(true);
    hold = false;
    coin();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toHaveLength(7); // only more frames, never fewer
  });

  it("is asked only once the view has what it needs by the usual rule", () => {
    const holdCompletion = vi.fn((_frames: readonly FrameObservation[]) => false);
    const { coin } = setup({ holdCompletion });
    coin();
    coin();
    expect(holdCompletion).not.toHaveBeenCalled(); // 2 of 3 frames: the usual rule says not yet
    coin();
    expect(holdCompletion).toHaveBeenCalledTimes(1);
    expect(holdCompletion.mock.calls[0][0]).toHaveLength(3);
  });

  it("never completes a view by itself: with no accepted frames nothing can complete, hold or not", () => {
    const { coin, completed } = setup({ holdCompletion: () => false }, () => false);
    for (let i = 0; i < 5; i++) coin();
    expect(completed).toHaveLength(0);
  });

  it("a hook that throws counts as no hold", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { coin, completed } = setup({
      holdCompletion: () => {
        throw new Error("boom");
      },
    });
    for (let i = 0; i < 3; i++) coin();
    expect(completed).toHaveLength(1);
    err.mockRestore();
  });

  it("only returning exactly true holds", () => {
    const { coin, completed } = setup({ holdCompletion: (() => "yes") as never });
    for (let i = 0; i < 3; i++) coin();
    expect(completed).toHaveLength(1);
  });
});
