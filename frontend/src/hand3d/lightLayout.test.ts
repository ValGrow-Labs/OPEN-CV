import { describe, expect, it } from "vitest";
import { bracketBox, splitLabel } from "./lightLayout";

describe("bracketBox", () => {
  const stage = { width: 340, height: 430 };

  it("spans the two end points, to the right of the hand", () => {
    const b = bracketBox({ y1: 330, y2: 110, handRight: 280, ...stage });
    expect(b.top).toBe(110);
    expect(b.height).toBe(220);
    expect(b.x).toBe(296);
  });

  it("does not care which end point is first", () => {
    expect(bracketBox({ y1: 110, y2: 330, handRight: 280, ...stage })).toEqual(bracketBox({ y1: 330, y2: 110, handRight: 280, ...stage }));
  });

  it("stays inside the stage and never collapses", () => {
    const edge = bracketBox({ y1: -50, y2: 900, handRight: 500, ...stage });
    expect(edge.top).toBeGreaterThanOrEqual(2);
    expect(edge.top + edge.height).toBeLessThanOrEqual(stage.height);
    expect(edge.x).toBeLessThanOrEqual(stage.width - 4);
    const flat = bracketBox({ y1: 200, y2: 200, handRight: 100, ...stage });
    expect(flat.height).toBe(24);
    for (const v of Object.values(bracketBox({ y1: 0, y2: 0, handRight: 0, width: 1, height: 1 }))) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("splitLabel", () => {
  it("splits a name from a trailing number-and-mm value, keeping the text", () => {
    expect(splitLabel("Index 53 mm")).toEqual({ name: "Index", value: "53 mm" });
    expect(splitLabel("Hand length 219.4 mm")).toEqual({ name: "Hand length", value: "219.4 mm" });
    const { name, value } = splitLabel("Middle 56.0 mm");
    expect(`${name} ${value}`).toBe("Middle 56.0 mm");
  });

  it("leaves other labels whole", () => {
    expect(splitLabel("71")).toEqual({ name: "71", value: "" });
    expect(splitLabel("Index")).toEqual({ name: "Index", value: "" });
    expect(splitLabel("")).toEqual({ name: "", value: "" });
  });
});
