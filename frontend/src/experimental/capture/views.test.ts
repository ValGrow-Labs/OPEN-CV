import { describe, expect, it } from "vitest";
import { DEFAULT_COIN_VIEWS, REQUIRED_VIEW_IDS, viewDef, viewsFor } from "./views";

describe("the guided views", () => {
  it("are the four required views in order: palm, thumb-side, little-finger-side, back of hand", () => {
    const v = viewsFor();
    expect(v.map((x) => x.id)).toEqual(["palm", "thumb", "little", "back"]);
    expect(v.every((x) => !x.optional)).toBe(true);
    expect([...REQUIRED_VIEW_IDS]).toEqual(["palm", "thumb", "little", "back"]);
  });

  it("add the two optional 45-degree obliques only when asked, after the required ones", () => {
    const v = viewsFor({ includeObliques: true });
    expect(v.map((x) => x.id)).toEqual(["palm", "thumb", "little", "back", "oblique_palm_thumb", "oblique_back_little"]);
    expect(v.filter((x) => x.optional).map((x) => x.id)).toEqual(["oblique_palm_thumb", "oblique_back_little"]);
  });

  it("need the coin on the palm and the back only by default, and the list is configurable", () => {
    expect([...DEFAULT_COIN_VIEWS]).toEqual(["palm", "back"]);
    expect(viewsFor().filter((x) => x.requiresCoin).map((x) => x.id)).toEqual(["palm", "back"]);
    expect(viewsFor({ coinViews: ["palm"] }).filter((x) => x.requiresCoin).map((x) => x.id)).toEqual(["palm"]);
    expect(viewsFor({ coinViews: [] }).some((x) => x.requiresCoin)).toBe(false);
  });

  it("judge posture the way the product does: palm face-on, profiles edge-on, back opposite to the palm", () => {
    expect(viewDef("palm").posture).toEqual({ kind: "face_on" });
    expect(viewDef("thumb").posture).toEqual({ kind: "edge_on" });
    expect(viewDef("little").posture).toEqual({ kind: "edge_on" });
    expect(viewDef("back").posture).toEqual({ kind: "opposite_of", view: "palm" });
    expect(viewDef("oblique_palm_thumb").posture).toEqual({ kind: "none" });
  });

  it("say plainly what each view is for, and never promise a measurement", () => {
    for (const v of viewsFor({ includeObliques: true })) {
      expect(v.instruction.length).toBeGreaterThan(30);
      expect(v.purpose.length).toBeGreaterThan(30);
      expect(`${v.instruction} ${v.purpose}`).not.toMatch(/accurate|exact|validated|guarantee/i);
    }
  });

  it("throw on an unknown view", () => {
    // @ts-expect-error not a view id
    expect(() => viewDef("sideways")).toThrow(/unknown view/);
  });
});
