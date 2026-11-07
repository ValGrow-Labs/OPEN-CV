import { describe, expect, it } from "vitest";
import { overlayTags } from "./overlayTags";

const live = { handMm: 183.4, fingersMm: { thumb: 61.2, index: 72.4, middle: 79.6, ring: 73.1, little: 58.9 }, palmWidthMm: 80.1 };

describe("overlayTags", () => {
  it("has no labels until the coin has been measured", () => {
    expect(overlayTags(null)).toBeUndefined();
  });

  it("names each finger's length on its tip, with the column it prefers and the order it is kept in", () => {
    const tags = overlayTags(live)!;
    expect(tags.slice(0, 5)).toEqual([
      { joint: 4, label: "61 mm", name: "Thumb", side: "left", priority: 5 },
      { joint: 8, label: "72 mm", name: "Index", side: "left", priority: 1 },
      { joint: 12, label: "80 mm", name: "Middle", side: "right", priority: 2 },
      { joint: 16, label: "73 mm", name: "Ring", side: "right", priority: 3 },
      { joint: 20, label: "59 mm", name: "Pinky", side: "right", priority: 4 },
    ]);
  });

  it("puts the hand length (a bracket from the wrist to the middle fingertip) on the right and the palm width (knuckle to knuckle) on the left", () => {
    const tags = overlayTags(live)!;
    expect(tags).toHaveLength(7);
    expect(tags[5]).toEqual({ joint: 12, between: [0, 12], label: "183 mm", emphasis: true, name: "Length", side: "right", priority: 0 });
    expect(tags[6]).toEqual({ joint: 5, between: [5, 17], label: "80 mm", name: "Palm width", side: "left", priority: 6 });
  });

  it("keeps the hand length first and the palm width last when there is no room for everyone", () => {
    const tags = overlayTags(live)!;
    const order = [...tags].sort((a, b) => a.priority! - b.priority!).map((t) => t.name);
    expect(order).toEqual(["Length", "Index", "Middle", "Ring", "Pinky", "Thumb", "Palm width"]);
  });

  it("labels nothing for a value that is not there", () => {
    const tags = overlayTags({ ...live, palmWidthMm: Number.NaN, fingersMm: { ...live.fingersMm, thumb: Number.NaN } })!;
    expect(tags.map((t) => t.name)).toEqual(["Index", "Middle", "Ring", "Pinky", "Length"]);
    const old = overlayTags({ handMm: 183, fingersMm: live.fingersMm } as never)!; // a reading without a palm width
    expect(old.some((t) => t.name === "Palm width")).toBe(false);
  });
});
