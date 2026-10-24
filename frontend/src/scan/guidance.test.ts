import { describe, expect, it } from "vitest";
import { ExposureController, exposureDirection, exposureRange, nextExposure, type ExposureSettings } from "../camera/exposure";
import type { LiveCode } from "../vision/liveChecks";
import { dominantIssue, GuidanceDebouncer, type IssueSample } from "./guidance";

const SET = { guidance_window_ms: 1200, guidance_hold_ms: 1000, guidance_min_share: 0.35, guidance_keep_share: 0.2, guidance_switch_margin: 0.15 };

/** Feeds one frame every 60 ms; returns what was shown after each. */
function run(d: GuidanceDebouncer, frames: (LiveCode[])[], t0 = 0, dt = 60): (LiveCode | null)[] {
  return frames.map((codes, i) => d.update(t0 + i * dt, codes));
}
const changes = (shown: (LiveCode | null)[]) => shown.filter((s, i) => i > 0 && s !== shown[i - 1]).length;

describe("steady guidance", () => {
  it("does not flicker when the per-frame checks flip between two problems and 'fine'", () => {
    const d = new GuidanceDebouncer(SET);
    // A realistic jumble: mostly "coin_tilted", sometimes glare, sometimes fine.
    const pattern: LiveCode[][] = [["coin_tilted"], ["coin_tilted"], [], ["coin_glare"], ["coin_tilted"], [], ["coin_tilted"], ["coin_tilted"], ["coin_glare"], ["coin_tilted"]];
    const frames = Array.from({ length: 100 }, (_, i) => pattern[i % pattern.length]);
    const shown = run(d, frames);
    const perFrame = frames.filter((f, i) => i > 0 && (f[0] ?? null) !== (frames[i - 1][0] ?? null)).length;
    expect(perFrame).toBeGreaterThan(60); // the raw checks flip almost every frame
    expect(changes(shown)).toBeLessThanOrEqual(2); // what is shown settles on one message
    expect(shown.at(-1)).toBe("coin_tilted");
  });

  it("shows a real, persistent problem and clears it once the problem has gone", () => {
    const d = new GuidanceDebouncer(SET);
    const shown = run(d, [...Array(40).fill(["hand_out_of_frame"]), ...Array(80).fill([])]);
    expect(shown[30]).toBe("hand_out_of_frame");
    expect(shown.at(-1)).toBeNull();
  });

  it("says there is no hand at once, and starts over afterwards", () => {
    const d = new GuidanceDebouncer(SET);
    run(d, Array(30).fill(["coin_tilted"]));
    expect(d.update(5000, ["no_hand"])).toBe("no_hand");
    expect(d.update(5060, [])).toBeNull();
  });

  it("keeps a message for at least the hold time", () => {
    const d = new GuidanceDebouncer(SET);
    const shown = run(d, [...Array(40).fill(["coin_tilted"]), ...Array(150).fill([])], 0, 20);
    const first = shown.findIndex((s) => s === "coin_tilted");
    const last = shown.lastIndexOf("coin_tilted");
    expect((last - first) * 20).toBeGreaterThanOrEqual(1000 - 20);
  });

  it("does not take turns between two problems of similar weight", () => {
    const d = new GuidanceDebouncer(SET);
    // 60 / 40 for a while, then the weights drift to 45 / 55: not enough to overturn the shown one.
    const mix = (a: LiveCode, b: LiveCode, pa: number, n: number) =>
      Array.from({ length: n }, (_, i) => [(i % 20) / 20 < pa ? a : b] as LiveCode[]);
    const shown = run(d, [...mix("coin_tilted", "coin_glare", 0.6, 100), ...mix("coin_tilted", "coin_glare", 0.45, 200)]);
    expect(changes(shown)).toBeLessThanOrEqual(1);
    expect(shown.at(-1)).toBe("coin_tilted");
  });

  it("does switch once the other problem clearly dominates", () => {
    const d = new GuidanceDebouncer(SET);
    const shown = run(d, [...Array(80).fill(["coin_tilted"]), ...Array(120).fill(["coin_glare"])]);
    expect(shown.at(-1)).toBe("coin_glare");
  });

  it("keeps only the window's worth of bookkeeping however long the scan runs", () => {
    const d = new GuidanceDebouncer(SET);
    run(d, Array.from({ length: 5000 }, (_, i) => (i % 3 === 0 ? ["coin_tilted" as LiveCode] : [])));
    const internals = d as unknown as { log: unknown[]; counts: Map<unknown, number> };
    expect(internals.log.length).toBeLessThanOrEqual(1200 / 60 + 2);
    expect([...internals.counts.values()].reduce((a, b) => a + b, 0)).toBe(internals.log.length);
  });

  it("ignores a problem that shows in only a few frames", () => {
    const d = new GuidanceDebouncer(SET);
    const frames = Array.from({ length: 60 }, (_, i) => (i % 10 === 0 ? ["coin_glare" as LiveCode] : []));
    expect(run(d, frames).every((s) => s === null)).toBe(true);
  });
});

describe("dominant issue since a time", () => {
  const log: IssueSample[] = [
    { t: 0, code: "coin_glare" },
    { t: 100, code: "coin_glare" },
    { t: 200, code: null },
    { t: 300, code: "too_dark" },
    { t: 400, code: null },
  ];
  it("counts every sample from the cut-off on", () => {
    expect(dominantIssue(log, 0)).toEqual({ code: "coin_glare", share: 2 / 5 });
    expect(dominantIssue(log, 250)).toEqual({ code: "too_dark", share: 1 / 2 });
  });
  it("is nothing when the recent samples were all fine, or there are none", () => {
    expect(dominantIssue(log, 350)).toBeNull();
    expect(dominantIssue([], 0)).toBeNull();
  });
});

const EXP: ExposureSettings = {
  auto_exposure: true,
  exposure_step_ev: 0.5,
  exposure_min_ev: -2,
  exposure_max_ev: 1,
  exposure_hold_ms: 1500,
  exposure_min_share: 0.4,
};

function fakeTrack(range: { min: number; max: number; step: number } | null, start = 0, refuse = false) {
  const applied: number[] = [];
  const track = {
    getCapabilities: () => (range ? { exposureCompensation: range } : {}),
    getSettings: () => ({ exposureCompensation: start }),
    applyConstraints: (c: { advanced: { exposureCompensation: number }[] }) => {
      if (refuse) return Promise.reject(new Error("no"));
      applied.push(c.advanced[0].exposureCompensation);
      return Promise.resolve();
    },
  } as unknown as MediaStreamTrack;
  return { track, applied };
}

describe("exposure control", () => {
  const range = { min: -4, max: 4, step: 0.5 };

  it("reads the camera's range, or nothing when it has none", () => {
    expect(exposureRange(fakeTrack(range).track)).toEqual(range);
    expect(exposureRange(fakeTrack(null).track)).toBeNull();
    expect(exposureRange(null)).toBeNull();
  });

  it("moves toward a darker picture for glare, a brighter one for darkness, and ignores the rest", () => {
    expect(exposureDirection("coin_glare", 0.6, 0.4)).toBe(-1);
    expect(exposureDirection("too_bright", 0.6, 0.4)).toBe(-1);
    expect(exposureDirection("too_dark", 0.6, 0.4)).toBe(1);
    expect(exposureDirection("coin_tilted", 0.9, 0.4)).toBe(0);
    expect(exposureDirection("coin_glare", 0.2, 0.4)).toBe(0);
    expect(exposureDirection(null, 1, 0.4)).toBe(0);
  });

  it("steps within both our limits and the camera's", () => {
    expect(nextExposure(0, -1, EXP, range)).toBe(-0.5);
    expect(nextExposure(-2, -1, EXP, range)).toBe(-2); // our floor
    expect(nextExposure(1, 1, EXP, range)).toBe(1); // our ceiling
    expect(nextExposure(-0.5, -1, EXP, { min: -0.5, max: 0.5, step: 0.5 })).toBe(-0.5); // the camera's floor
  });

  it("eases the exposure down at most once per hold while the coin is blown out", () => {
    const { track, applied } = fakeTrack(range);
    const c = new ExposureController(EXP, track);
    c.consider(0, "coin_glare", 0.8);
    c.consider(500, "coin_glare", 0.8); // too soon
    c.consider(1600, "coin_glare", 0.8);
    c.consider(3200, "coin_glare", 0.8);
    c.consider(4800, "coin_glare", 0.8);
    c.consider(6400, "coin_glare", 0.8); // already at the floor (-2)
    expect(applied).toEqual([-0.5, -1, -1.5, -2]);
    expect(c.ev).toBe(-2);
  });

  it("remembers when it last moved, so later readings can be judged on the new picture only", () => {
    const { track } = fakeTrack(range);
    const c = new ExposureController(EXP, track);
    expect(c.lastStepMs).toBe(-Infinity);
    c.consider(4000, "coin_glare", 0.9);
    expect(c.lastStepMs).toBe(4000);
  });

  it("does nothing without the setting, without camera support, or after the camera refuses", async () => {
    const off = fakeTrack(range);
    new ExposureController({ ...EXP, auto_exposure: false }, off.track).consider(0, "coin_glare", 1);
    expect(off.applied).toEqual([]);
    const none = new ExposureController(EXP, fakeTrack(null).track);
    none.consider(0, "coin_glare", 1);
    expect(none.ev).toBeNull();
    const refusing = new ExposureController(EXP, fakeTrack(range, 0, true).track);
    refusing.consider(0, "coin_glare", 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(refusing.ev).toBeNull();
  });
});
