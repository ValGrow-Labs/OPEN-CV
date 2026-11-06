import { describe, expect, it } from "vitest";
import { overlayTags } from "./overlayTags";

const live = { handMm: 183.4, fingersMm: { thumb: 61.2, index: 72.4, middle: 79.6, ring: 73.1, little: 58.9 } };

describe("overlayTags", () => {
  it("has no labels until the coin has been measured", () => {
    expect(overlayTags(null)).toBeUndefined();
  });

  it("puts each finger's length on its tip and the hand length halfway up the hand", () => {
    const tags = overlayTags(live)!;
    expect(tags).toHaveLength(6);
    expect(tags.slice(0, 5)).toEqual([
      { joint: 4, label: "61 mm" },
      { joint: 8, label: "72 mm" },
      { joint: 12, label: "80 mm" },
      { joint: 16, label: "73 mm" },
      { joint: 20, label: "59 mm" },
    ]);
    expect(tags[5]).toEqual({ joint: 12, between: [0, 12], label: "183 mm", emphasis: true });
  });
});
