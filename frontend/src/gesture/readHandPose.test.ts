// SYNTHETIC hands only (see synthetic.ts): these tests prove the reader's logic (rotation, mirroring, scale, noise
// invariance and the pose rules), not accuracy on real hands or real MediaPipe output.
import { describe, expect, it } from "vitest";
import { readHandPose } from "./readHandPose";
import { makeHand, oneFingerBent, POSES, type PoseSpec, type ViewSpec } from "./synthetic";
import type { FingerName, HandPoseLabel } from "./types";

const LABELS: Record<keyof typeof POSES, HandPoseLabel> = {
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

const ROTATIONS = [0, 37, 90, 180, 251, 330];
const FINGERS: FingerName[] = ["thumb", "index", "middle", "ring", "little"];

const read3d = (pose: PoseSpec, view: ViewSpec) => {
  const h = makeHand(pose, view);
  return readHandPose(h.landmarks, h.world);
};
const read2d = (pose: PoseSpec, view: ViewSpec) => readHandPose(makeHand(pose, view).landmarks, null);
const states = (r: ReturnType<typeof readHandPose>) => Object.fromEntries(r.fingers.map((f) => [f.name, f.state]));

describe("synthetic hands, 3D world landmarks: every pose, from any side, rotated and mirrored", () => {
  const VIEWS: { name: string; yawDeg: number; pitchDeg: number }[] = [
    { name: "palm to the camera", yawDeg: 0, pitchDeg: 0 },
    { name: "seen from the side", yawDeg: 90, pitchDeg: 0 },
    { name: "tilted", yawDeg: 40, pitchDeg: 25 },
    { name: "back of the hand", yawDeg: 180, pitchDeg: 0 },
  ];
  for (const [name, expected] of Object.entries(LABELS) as [keyof typeof POSES, HandPoseLabel][]) {
    it(`${name} is read as ${expected} in every view, in-plane rotation, hand and scale`, () => {
      for (const v of VIEWS) {
        for (const inPlaneDeg of ROTATIONS) {
          for (const mirror of [false, true]) {
            const r = read3d(POSES[name], { ...v, inPlaneDeg, mirror, scale: inPlaneDeg % 2 ? 1.2 : 4 });
            expect(r.label, `${name} / ${v.name} / ${inPlaneDeg} deg / ${mirror ? "left" : "right"}`).toBe(expected);
            expect(r.usedWorld).toBe(true);
            expect(r.fingers.map((f) => f.name)).toEqual(FINGERS);
            expect(r.confidence).toBeGreaterThan(0.3);
          }
        }
      }
    });
  }

  it("reports the finger states of the named poses", () => {
    expect(states(read3d(POSES.fist, {}))).toEqual({ thumb: "bent", index: "bent", middle: "bent", ring: "bent", little: "bent" });
    expect(states(read3d(POSES.fingers_together, {}))).toEqual({ thumb: "extended", index: "extended", middle: "extended", ring: "extended", little: "extended" });
    expect(states(read3d(POSES.pointing, {}))).toMatchObject({ index: "extended", middle: "bent", ring: "bent", little: "bent" });
    expect(states(read3d(POSES.relaxed, {}))).toMatchObject({ index: "half_bent", middle: "half_bent", ring: "half_bent", little: "half_bent" });
    expect(states(read3d(POSES.thumbs_up, {}))).toMatchObject({ thumb: "extended", index: "bent" });
  });

  it("estimates the flexion of a finger from the 3D joint angles (a lower-noise estimate that reads 75 to 100 per cent of the built total)", () => {
    const fist = read3d(POSES.fist, { yawDeg: 25, pitchDeg: 15, inPlaneDeg: 70 });
    for (const f of fist.fingers.filter((x) => x.name !== "thumb")) {
      expect(f.bendDeg).toBeGreaterThan(0.75 * 250); // built with 250 in total
      expect(f.bendDeg).toBeLessThan(255);
    }
    const half = read3d(POSES.relaxed, { yawDeg: 25, pitchDeg: 15, inPlaneDeg: 70 });
    for (const f of half.fingers.filter((x) => x.name !== "thumb")) {
      expect(f.bendDeg).toBeGreaterThan(75); // built with 100 in total
      expect(f.bendDeg).toBeLessThan(105);
    }
    const open = read3d(POSES.fingers_together, {});
    for (const f of open.fingers) expect(f.bendDeg).toBeLessThan(5);
    // The thumb is the angle between its first and last bone: MCP plus IP flexion (built 45 + 55 = 100 across the palm).
    expect(read3d(POSES.fist, {}).fingers[0].bendDeg).toBeGreaterThan(95);
  });

  it("flags the spread: together, mixed and apart", () => {
    expect(read3d(POSES.fingers_together, {}).spread).toBe("together");
    expect(read3d(POSES.open_palm_mild, {}).spread).toBe("mixed");
    expect(read3d(POSES.fingers_spread, {}).spread).toBe("apart");
    expect(read3d(POSES.fist, {}).spread).toBe("together"); // curled fingers say nothing: treated as together
  });

  it("flags the thumb out only when it is clear of the palm", () => {
    expect(read3d(POSES.fingers_spread, {}).thumbOut).toBe(true);
    expect(read3d(POSES.thumbs_up, {}).thumbOut).toBe(true);
    expect(read3d(POSES.fingers_together, {}).thumbOut).toBe(false);
    expect(read3d(POSES.fist, {}).thumbOut).toBe(false); // across the palm
  });

  for (const finger of FINGERS) {
    it(`bending only the ${finger} bends only the ${finger}`, () => {
      for (const view of [{}, { yawDeg: 90 }, { yawDeg: 40, pitchDeg: 25, inPlaneDeg: 130 }, { mirror: true, inPlaneDeg: 215 }] as ViewSpec[]) {
        const r = read3d(oneFingerBent(finger === "thumb" ? "thumb" : (finger as "index")), view);
        for (const f of r.fingers) expect(f.state, `${finger} bent: ${f.name}`).toBe(f.name === finger ? "bent" : "extended");
      }
    });
  }

  it("a fist with a loose thumb out is a thumbs-up, not a fist", () => {
    expect(read3d(POSES.thumbs_up, {}).label).toBe("thumb_extended");
    expect(read3d(POSES.fist, {}).label).toBe("fist");
  });

  it("does not depend on the size of the image", () => {
    for (const scale of [0.4, 1, 3, 12]) expect(read3d(POSES.fist, { scale }).label).toBe("fist");
  });
});

describe("synthetic hands, 2D image landmarks only", () => {
  it("says it used 2D landmarks and is less sure than with the world landmarks", () => {
    const h = makeHand(POSES.fingers_together, {});
    const two = readHandPose(h.landmarks, null);
    const three = readHandPose(h.landmarks, h.world);
    expect(two.usedWorld).toBe(false);
    expect(three.usedWorld).toBe(true);
    expect(two.confidence).toBeLessThan(three.confidence);
  });

  it("palm to the camera: open palm, spread, together, fist, thumb and pointing, whatever the rotation or hand", () => {
    const cases: [keyof typeof POSES, HandPoseLabel][] = [
      ["open_palm_thumb_out", "open_palm"],
      ["open_palm_mild", "open_palm"],
      ["fingers_spread", "fingers_spread"],
      ["fingers_together", "fingers_together"],
      ["fist", "fist"], // fingers bend toward the camera: needs the reach rule
      ["thumbs_up", "thumb_extended"],
      ["pointing", "pointing"],
      ["relaxed", "relaxed"],
      ["index_extended", "index_extended"],
    ];
    for (const [name, expected] of cases) {
      for (const inPlaneDeg of ROTATIONS) {
        for (const mirror of [false, true]) {
          expect(read2d(POSES[name], { inPlaneDeg, mirror }).label, `${name} / ${inPlaneDeg} / ${mirror ? "left" : "right"}`).toBe(expected);
        }
      }
    }
  });

  it("seen from the side, the flexion is visible in the picture: fist, pointing and single bent fingers", () => {
    for (const inPlaneDeg of ROTATIONS) {
      for (const mirror of [false, true]) {
        const v: ViewSpec = { yawDeg: 90, inPlaneDeg, mirror };
        expect(read2d(POSES.fist, v).label).toBe("fist");
        expect(read2d(POSES.pointing, v).label).toBe("pointing");
        for (const finger of ["index", "middle", "ring", "little"] as const) {
          const r = read2d(oneFingerBent(finger), v);
          for (const f of r.fingers.filter((x) => x.name !== "thumb")) expect(f.state, `${finger} bent: ${f.name}`).toBe(f.name === finger ? "bent" : "extended");
        }
      }
    }
  });

  it("a single finger bent toward the camera is caught by the reach rule", () => {
    for (const finger of ["index", "middle", "ring", "little"] as const) {
      const r = read2d(oneFingerBent(finger), {});
      for (const f of r.fingers.filter((x) => x.name !== "thumb")) expect(f.state, `${finger} bent: ${f.name}`).toBe(f.name === finger ? "bent" : "extended");
    }
  });
});

describe("unusable landmarks are never guessed", () => {
  const good = makeHand(POSES.fingers_together, {});

  it("fewer than 21 points", () => {
    expect(readHandPose(good.landmarks.slice(0, 10)).label).toBe("unknown");
    expect(readHandPose([]).label).toBe("unknown");
  });

  it("non-finite coordinates", () => {
    const bad = good.landmarks.map((p, i) => (i === 8 ? { x: NaN, y: p.y } : p));
    const r = readHandPose(bad);
    expect(r.label).toBe("unknown");
    expect(r.confidence).toBe(0);
    expect(r.text).toBe("Hand not clear");
  });

  it("a collapsed hand (every point the same)", () => {
    expect(readHandPose(good.landmarks.map(() => ({ x: 100, y: 100 }))).label).toBe("unknown");
  });

  it("falls back to the image landmarks when the world landmarks are unusable", () => {
    const badWorld = good.world.map((p, i) => (i === 3 ? { x: NaN, y: 0, z: 0 } : p));
    const r = readHandPose(good.landmarks, badWorld);
    expect(r.usedWorld).toBe(false);
    expect(r.label).toBe("fingers_together");
  });

  it("collapsed world landmarks give unknown, not a pose", () => {
    const flat = good.world.map(() => ({ x: 0.1, y: 0.1, z: 0.1 }));
    expect(readHandPose(good.landmarks, flat).label).toBe("unknown");
  });
});

describe("noise: raw readings over 200 frames (synthetic, 1.5 % of the hand length per coordinate)", () => {
  it("stays on the right label almost always in 3D", () => {
    for (const [name, expected] of Object.entries(LABELS) as [keyof typeof POSES, HandPoseLabel][]) {
      let right = 0;
      for (let i = 0; i < 200; i++) {
        const h = makeHand(POSES[name], { noiseFrac: 0.015, seed: 1000 + i, yawDeg: 20, inPlaneDeg: 33 });
        if (readHandPose(h.landmarks, h.world).label === expected) right++;
      }
      expect(right / 200, name).toBeGreaterThan(0.9);
    }
  });
});
