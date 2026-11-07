// SYNTHETIC hands only. The smoother's hysteresis, stale rule and reset, and flicker counts over noisy frames.
import { describe, expect, it } from "vitest";
import { readHandPose } from "./readHandPose";
import { PoseSmoother } from "./smoother";
import { makeHand, POSES, type PoseSpec, type ViewSpec } from "./synthetic";
import type { HandPoseReading } from "./types";

const FRAME_MS = 33;
const read = (pose: PoseSpec, view: ViewSpec, use3d: boolean) => {
  const h = makeHand(pose, view);
  return readHandPose(h.landmarks, use3d ? h.world : null);
};
const flips = (labels: string[]) => labels.reduce((n, l, i) => (i > 0 && l !== labels[i - 1] ? n + 1 : n), 0);

describe("PoseSmoother hysteresis", () => {
  const open = read(POSES.fingers_together, {}, true);
  const fist = read(POSES.fist, {}, true);
  const spread = read(POSES.fingers_spread, {}, true);

  it("shows the first reading at once", () => {
    expect(new PoseSmoother().update(fist, 1000).label).toBe("fist");
  });

  it("a new label must hold for holdMs before it replaces the current one", () => {
    const s = new PoseSmoother({ holdMs: 250 });
    let t = 0;
    s.update(open, t);
    let shown = "";
    for (t = FRAME_MS; t < 240; t += FRAME_MS) shown = s.update(fist, t).label;
    expect(shown).toBe("fingers_together"); // 231 ms: not yet
    for (; t < 400; t += FRAME_MS) shown = s.update(fist, t).label;
    expect(shown).toBe("fist");
  });

  it("a brief glitch of a different label never shows", () => {
    const s = new PoseSmoother({ holdMs: 250 });
    let t = 0;
    s.update(open, t);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      t += FRAME_MS;
      const r = i === 20 || i === 21 ? fist : open; // two frames of fist
      seen.add(s.update(r, t).label);
    }
    expect([...seen]).toEqual(["fingers_together"]);
  });

  it("two labels alternating never hold, yet the shown label is replaced by the latest after four hold times", () => {
    const s = new PoseSmoother({ holdMs: 250 });
    let t = 0;
    s.update(open, t);
    const labels: string[] = [];
    for (let i = 0; i < 80; i++) {
      t += FRAME_MS;
      const r = i % 2 ? spread : fist; // never the same label twice in a row, never the shown label either
      labels.push(s.update(r, t).label);
    }
    expect(labels[0]).toBe("fingers_together");
    expect(labels.at(-1)).not.toBe("fingers_together"); // replaced by one of the contradicting labels after 1000 ms
    expect(labels.findIndex((l) => l !== "fingers_together") * FRAME_MS).toBeGreaterThanOrEqual(900);
  });

  it("finger states follow the same hold, and bend angles are lightly smoothed", () => {
    const s = new PoseSmoother({ holdMs: 250 });
    let t = 0;
    const first = s.update(open, t);
    expect(first.fingers.every((f) => f.state === "extended")).toBe(true);
    let after = first;
    for (t = FRAME_MS; t < 120; t += FRAME_MS) after = s.update(fist, t);
    expect(after.fingers[1].state).toBe("extended"); // not held long enough
    expect(after.fingers[1].bendDeg).toBeGreaterThan(first.fingers[1].bendDeg); // moving toward the fist...
    expect(after.fingers[1].bendDeg).toBeLessThan(fist.fingers[1].bendDeg); // ...but not there yet
    for (; t < 600; t += FRAME_MS) after = s.update(fist, t);
    expect(after.fingers[1].state).toBe("bent");
    expect(after.fingers[1].bendDeg).toBeGreaterThan(fist.fingers[1].bendDeg - 5);
  });

  it("an unreadable frame does not wipe the fingers, and unknown shows only after it holds", () => {
    const s = new PoseSmoother({ holdMs: 250 });
    const unknown = readHandPose([]);
    let t = 0;
    s.update(fist, t);
    let r: HandPoseReading = s.update(unknown, (t += FRAME_MS));
    expect(r.label).toBe("fist");
    expect(r.fingers.every((f) => f.state === "bent")).toBe(true);
    for (let i = 0; i < 12; i++) r = s.update(unknown, (t += FRAME_MS));
    expect(r.label).toBe("unknown");
    expect(r.fingers.every((f) => f.state === "bent")).toBe(true); // still the last real fingers
  });

  it("reset forgets everything", () => {
    const s = new PoseSmoother();
    s.update(open, 0);
    s.reset();
    expect(s.update(fist, 10).label).toBe("fist"); // the next reading is shown at once, like a new hand
  });

  it("passes the usedWorld flag and confidence through", () => {
    const s = new PoseSmoother();
    const r = s.update(read(POSES.fist, {}, false), 0);
    expect(r.usedWorld).toBe(false);
    expect(r.confidence).toBeGreaterThan(0);
  });
});

describe("flicker over 200 noisy frames (synthetic, 1.5 % of the hand length per coordinate, 30 fps)", () => {
  const report: string[] = [];
  const cases: [keyof typeof POSES, boolean][] = [];
  for (const name of Object.keys(POSES) as (keyof typeof POSES)[]) for (const d3 of [true, false]) cases.push([name, d3]);

  it("the smoothed label barely flips, and flips far less than the raw label", () => {
    let rawTotal = 0;
    let smoothedTotal = 0;
    for (const [name, d3] of cases) {
      const s = new PoseSmoother();
      const raw: string[] = [];
      const smooth: string[] = [];
      for (let i = 0; i < 200; i++) {
        const r = read(POSES[name], { noiseFrac: 0.015, seed: 4000 + i, yawDeg: d3 ? 20 : 0, inPlaneDeg: 33 }, d3);
        raw.push(r.label);
        smooth.push(s.update(r, i * FRAME_MS).label);
      }
      const rf = flips(raw);
      const sf = flips(smooth);
      rawTotal += rf;
      smoothedTotal += sf;
      report.push(`${name} ${d3 ? "3D" : "2D"}: raw flips ${rf}, smoothed flips ${sf}`);
      expect(sf, `${name} ${d3 ? "3D" : "2D"}`).toBeLessThanOrEqual(Math.max(2, Math.ceil(rf / 4)));
    }
    console.log(report.join("\n") + `\nTOTAL raw flips ${rawTotal}, smoothed flips ${smoothedTotal}`);
    expect(smoothedTotal).toBeLessThanOrEqual(rawTotal);
  });

  it("the smoothed 3D label of every named pose ends on the right label", () => {
    const expected: Record<keyof typeof POSES, string> = {
      open_palm_thumb_out: "open_palm",
      open_palm_mild: "open_palm",
      fingers_spread: "fingers_spread",
      fingers_together: "fingers_together",
      fist: "fist",
      thumbs_up: "thumb_extended",
      relaxed_thumb_out: "thumb_extended",
      pointing: "pointing",
      index_extended: "index_extended",
      relaxed: "relaxed",
    };
    for (const name of Object.keys(POSES) as (keyof typeof POSES)[]) {
      const s = new PoseSmoother();
      let last = "";
      for (let i = 0; i < 200; i++) {
        last = s.update(read(POSES[name], { noiseFrac: 0.015, seed: 7000 + i, yawDeg: 20, inPlaneDeg: 33 }, true), i * FRAME_MS).label;
      }
      expect(last, name).toBe(expected[name]);
    }
  });

  it("follows a hand that opens and closes (synthetic sequence)", () => {
    const s = new PoseSmoother();
    let t = 0;
    const phase = (pose: PoseSpec, ms: number) => {
      let label = "";
      for (let e = 0; e < ms; e += FRAME_MS) {
        t += FRAME_MS;
        label = s.update(read(pose, { noiseFrac: 0.01, seed: t, yawDeg: 15 }, true), t).label;
      }
      return label;
    };
    expect(phase(POSES.fingers_together, 600)).toBe("fingers_together");
    expect(phase(POSES.fist, 600)).toBe("fist");
    expect(phase(POSES.pointing, 600)).toBe("pointing");
    expect(phase(POSES.fingers_spread, 600)).toBe("fingers_spread");
  });
});
