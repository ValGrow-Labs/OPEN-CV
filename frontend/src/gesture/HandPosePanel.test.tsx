// @vitest-environment jsdom
// The pose panel: the pose in words, five finger rows, an honest empty state, and a spoken line that does not chatter.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HandPosePanel } from "./HandPosePanel";
import { readHandPose } from "./readHandPose";
import { makeHand, POSES } from "./synthetic";

const reading = (name: keyof typeof POSES) => {
  const h = makeHand(POSES[name], {});
  return readHandPose(h.landmarks, h.world);
};

describe("HandPosePanel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("asks for a hand when there is no reading", () => {
    render(<HandPosePanel reading={null} />);
    expect(screen.getByText("Show your hand")).toBeTruthy();
    expect(document.querySelectorAll(".hpp-finger")).toHaveLength(0);
  });

  it("says the pose and lists the five fingers, thumb first, with their state", () => {
    render(<HandPosePanel reading={reading("pointing")} />);
    expect(screen.getByText("Pointing")).toBeTruthy();
    const rows = [...document.querySelectorAll(".hpp-finger")];
    expect(rows.map((r) => r.querySelector(".hpp-name")!.textContent)).toEqual(["Thumb", "Index", "Middle", "Ring", "Pinky"]);
    expect(rows.map((r) => r.querySelector(".hpp-state")!.textContent)).toEqual(["bent", "extended", "bent", "bent", "bent"]);
    expect(rows[1].className).toContain("is-extended");
    const bars = [...document.querySelectorAll<HTMLElement>(".hpp-bar > span")].map((b) => parseInt(b.style.width, 10));
    expect(bars[1]).toBeLessThan(10); // the straight index barely fills
    expect(bars[2]).toBeGreaterThan(70); // the curled middle nearly fills
  });

  it("an unreadable hand shows 'Hand not clear' and no finger rows (nothing is guessed)", () => {
    render(<HandPosePanel reading={readHandPose([])} />);
    expect(screen.getByText("Hand not clear")).toBeTruthy();
    expect(document.querySelectorAll(".hpp-finger")).toHaveLength(0);
  });

  it("only the pose line is a live region", () => {
    render(<HandPosePanel reading={reading("fist")} />);
    const live = document.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0].className).toContain("hpp-pose");
    expect(live[0].getAttribute("aria-live")).toBe("polite");
  });

  it("the pose line changes at most about four times a second", () => {
    const { rerender } = render(<HandPosePanel reading={reading("fist")} />);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.getByText("Closed fist")).toBeTruthy();
    rerender(<HandPosePanel reading={reading("pointing")} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByText("Pointing")).toBeNull(); // too soon after the last change
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("Pointing")).toBeTruthy();
  });
});
