import { describe, expect, it } from "vitest";
import type { CaptureView } from "../api/types";
import { captureParams, goodFrame, publicConfig } from "../test/fixtures";
import {
  canSkipRemaining,
  nextView,
  orientationChanged,
  orientationOf,
  SAME_WAY_UP_HINT,
  tagFrames,
  viewsForScan,
  viewStepLabel,
  viewStepOf,
  withViewFrames,
} from "./views";

const views = captureParams.views;
const [palm, back, side] = views;

describe("configured capture views", () => {
  it("are palm, back of hand and side, all required; the side one is capture-only", () => {
    expect(views.map((v) => v.id)).toEqual(["palm", "back", "side"]);
    expect(views.map((v) => v.required)).toEqual([true, true, true]);
    expect(views.map((v) => v.used_for_size)).toEqual([true, true, false]);
    expect(palm.messages).toEqual({});
    expect(back.note).toBe("A second angle lets us check the first one.");
    expect(side.note).toMatch(/Not used for your size yet/);
  });
});

describe("views for a scan", () => {
  it("are the ones asked for, or just the primary one", () => {
    const cfg = publicConfig();
    expect(viewsForScan(cfg, views).map((v) => v.id)).toEqual(["palm", "back", "side"]);
    expect(viewsForScan(cfg).map((v) => v.id)).toEqual(["palm"]);
    expect(viewsForScan(cfg, []).map((v) => v.id)).toEqual(["palm"]);
    expect(viewsForScan({ ...cfg, capture: { ...cfg.capture, views: [] } })).toEqual([]);
  });

  it("walk palm -> back -> side, then there is no next view", () => {
    expect(nextView(views, 0)?.id).toBe("back");
    expect(nextView(views, 1)?.id).toBe("side");
    expect(nextView(views, 2)).toBeNull();
    expect(nextView([palm], 0)).toBeNull();
  });
});

describe("skipping the remaining views (config-driven)", () => {
  const optional = (...ids: string[]) => views.map((v) => ({ ...v, required: v.id === "palm" || !ids.includes(v.id) }));

  it("is never possible while a view still to come is required", () => {
    expect(canSkipRemaining(views, 1)).toBe(false); // from back: back and side are required
    expect(canSkipRemaining(views, 2)).toBe(false); // from side: required
    expect(canSkipRemaining(optional("back"), 1)).toBe(false); // the side view after it is still required
  });

  it("is possible once none of the remaining views is required", () => {
    expect(canSkipRemaining(optional("back", "side"), 1)).toBe(true);
    expect(canSkipRemaining(optional("side"), 2)).toBe(true);
    expect(canSkipRemaining(optional("back", "side"), 3)).toBe(true); // nothing left
  });

  it("numbers the steps through the guided angles", () => {
    expect(viewStepOf(views, 1)).toBe("Step 2 of 3");
    expect(viewStepOf(views, 2)).toBe("Step 3 of 3");
  });
});

describe("tagging frames", () => {
  it("adds the view id to every frame without touching the rest", () => {
    const f = goodFrame();
    const tagged = tagFrames([f, f], "back");
    expect(tagged.map((x) => x.view)).toEqual(["back", "back"]);
    expect(tagged[0].landmarks).toEqual(f.landmarks);
    expect(f.view).toBeUndefined(); // the input is not modified
  });

  it("replaces the frames of a view that is scanned again and keeps the others", () => {
    const a = tagFrames([goodFrame()], "palm");
    const b = tagFrames([goodFrame(), goodFrame()], "back");
    let all = withViewFrames([], "palm", a);
    all = withViewFrames(all, "back", b);
    expect(all.map((f) => f.view)).toEqual(["palm", "back", "back"]);
    all = withViewFrames(all, "back", tagFrames([goodFrame()], "back"));
    expect(all.map((f) => f.view)).toEqual(["palm", "back"]);
  });
});

describe("scan step chip", () => {
  const short = "Show palm";
  it("keeps the palm wording for the primary view and for later steps", () => {
    expect(viewStepLabel(palm, palm, 0, short)).toBe(short);
    expect(viewStepLabel(back, palm, 1, "Place coin")).toBe("Place coin");
    expect(viewStepLabel(undefined, palm, 0, short)).toBe(short);
  });
  it("names the other views", () => {
    expect(viewStepLabel(back, palm, 0, short)).toBe("Show back of hand");
    expect(viewStepLabel(side as CaptureView, palm, 0, short)).toBe("Show side view");
  });
});

describe("phone orientation between views", () => {
  const portrait = { width: 720, height: 1280 };
  const landscape = { width: 1280, height: 720 };

  it("names the orientation of a frame size", () => {
    expect(orientationOf(portrait)).toBe("portrait");
    expect(orientationOf(landscape)).toBe("landscape");
    expect(orientationOf({ width: 800, height: 800 })).toBe("square");
  });

  it("notices a phone turned between two views", () => {
    expect(orientationChanged(portrait, landscape)).toBe(true);
    expect(orientationChanged(landscape, portrait)).toBe(true);
  });

  it("stays quiet when the phone is held the same way, whatever the resolution", () => {
    expect(orientationChanged(portrait, portrait)).toBe(false);
    expect(orientationChanged(portrait, { width: 1080, height: 1920 })).toBe(false);
    expect(orientationChanged(landscape, { width: 1920, height: 1080 })).toBe(false);
  });

  it("never nags on unknown or square sizes", () => {
    expect(orientationChanged(null, landscape)).toBe(false);
    expect(orientationChanged(portrait, undefined)).toBe(false);
    expect(orientationChanged(portrait, { width: 0, height: 0 })).toBe(false); // video not ready
    expect(orientationChanged(portrait, { width: 600, height: 600 })).toBe(false);
  });

  it("has the hint wording", () => {
    expect(SAME_WAY_UP_HINT).toBe("Keep your phone the same way up for every view");
  });
});
