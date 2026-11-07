import { describe, expect, it } from "vitest";
import { boneOf, CONNECTIONS, FINGER_JOINTS, FINGER_NAMES, fingerOf, JOINT_COUNT, PALM_POLYGON, PART_COLOURS } from "./landmarkTopology";

describe("the MediaPipe hand topology", () => {
  it("has 21 joints and 21 bones with valid, distinct indices", () => {
    expect(JOINT_COUNT).toBe(21);
    expect(CONNECTIONS).toHaveLength(21);
    const seen = new Set<string>();
    for (const [a, b] of CONNECTIONS) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(JOINT_COUNT);
      expect(a).not.toBe(b);
      seen.add(`${Math.min(a, b)}-${Math.max(a, b)}`);
    }
    expect(seen.size).toBe(21);
    for (const j of PALM_POLYGON) expect(j).toBeLessThan(JOINT_COUNT);
  });

  it("reaches every joint (the hand is one connected skeleton)", () => {
    const reach = new Set([0]);
    for (let pass = 0; pass < JOINT_COUNT; pass++) {
      for (const [a, b] of CONNECTIONS) {
        if (reach.has(a)) reach.add(b);
        if (reach.has(b)) reach.add(a);
      }
    }
    expect(reach.size).toBe(JOINT_COUNT);
  });

  it("gives each finger its four joints and a colour of its own", () => {
    const owned = new Set<number>();
    for (const f of FINGER_NAMES) {
      expect(FINGER_JOINTS[f]).toHaveLength(4);
      for (const j of FINGER_JOINTS[f]) {
        expect(fingerOf(j)).toBe(f);
        owned.add(j);
      }
    }
    expect(owned.size).toBe(20);
    expect(fingerOf(0)).toBe("palm");
    const colours = new Set(FINGER_NAMES.map((f) => PART_COLOURS[f]));
    expect(colours.size).toBe(5);
    expect(colours.has(PART_COLOURS.palm)).toBe(false);
  });

  it("colours a bone by its finger and the knuckle bones as palm", () => {
    expect(boneOf(1, 2)).toBe("thumb");
    expect(boneOf(0, 1)).toBe("thumb");
    expect(boneOf(7, 8)).toBe("index");
    expect(boneOf(11, 12)).toBe("middle");
    expect(boneOf(15, 16)).toBe("ring");
    expect(boneOf(19, 20)).toBe("pinky");
    for (const [a, b] of [[0, 5], [5, 9], [9, 13], [13, 17], [0, 17]] as const) expect(boneOf(a, b)).toBe("palm");
    // every bone inside a finger takes that finger
    for (const [a, b] of CONNECTIONS) {
      const p = boneOf(a, b);
      if (p !== "palm") expect(p).toBe(fingerOf(Math.max(a, b)));
    }
  });
});
