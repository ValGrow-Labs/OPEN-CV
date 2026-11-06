// @vitest-environment jsdom
// The controller reports the tracked hand of every camera frame (for the small live 3D hand).
import { describe, expect, it, vi } from "vitest";
import { goodFrame, publicConfig } from "../test/fixtures";
import { ScanController } from "./scanController";

const noop = new Proxy({}, { get: () => () => undefined, set: () => true });

function setup(detect: () => unknown, onPose: ((l: unknown) => void) | undefined) {
  const video = document.createElement("video");
  const overlay = document.createElement("canvas");
  const c = new ScanController(video, overlay, publicConfig(), { mode: "scan", facing: "environment", onStatus: () => {}, onPose: onPose as never });
  const priv = c as unknown as Record<string, unknown>;
  priv.tracker = { detect };
  priv.running = true;
  priv.prepareCanvas = () => ({ ctx: noop, w: 1280, h: 720, scale: 1 });
  return { frame: () => (priv.processScanFrame as () => void).call(c) };
}

describe("ScanController onPose", () => {
  it("is called every frame with the hand's landmarks, and with null when the hand is gone", () => {
    const landmarks = goodFrame().landmarks;
    let hand: unknown = { landmarks, world: null, handedness: "Right", handednessScore: 0.9 };
    const onPose = vi.fn();
    const { frame } = setup(() => hand, onPose);

    frame();
    expect(onPose).toHaveBeenCalledTimes(1);
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
});
