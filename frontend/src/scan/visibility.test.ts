import { describe, expect, it } from "vitest";
import { visibilityAction } from "./visibility";

describe("page hidden / shown during a scan", () => {
  it("pauses the view being scanned when the page is hidden", () => {
    expect(visibilityAction({ visible: false, running: true, pausedByHide: false })).toBe("pause");
  });

  it("leaves a view alone that is not running (the next-angle card, a finished scan)", () => {
    expect(visibilityAction({ visible: false, running: false, pausedByHide: false })).toBe("none");
    expect(visibilityAction({ visible: true, running: false, pausedByHide: false })).toBe("none");
  });

  it("resumes only what the hide paused, once the page is visible again", () => {
    expect(visibilityAction({ visible: true, running: false, pausedByHide: true })).toBe("resume");
    expect(visibilityAction({ visible: false, running: false, pausedByHide: true })).toBe("none"); // still hidden
  });

  it("does nothing when a running view becomes visible again without having been paused", () => {
    expect(visibilityAction({ visible: true, running: true, pausedByHide: false })).toBe("none");
  });
});
