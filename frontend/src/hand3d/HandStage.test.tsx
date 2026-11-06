// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HandStage, webglAvailable } from "./HandStage";

// jsdom prints "not implemented" for canvas contexts; a phone without WebGL answers null.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("HandStage wrapper (jsdom has no WebGL)", () => {
  it("reports no WebGL here", () => {
    expect(webglAvailable()).toBe(false);
  });

  it("renders the static fallback, labelled as a picture, and does not throw", () => {
    const { container } = render(<HandStage mode="scan" />);
    const stage = screen.getByRole("img", { name: "A glowing 3D model of a hand" });
    expect(stage.classList.contains("hand-stage")).toBe(true);
    expect(container.querySelector(".hand-stage-fallback")).not.toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("uses the given label and class for every mode", () => {
    const pose = Array.from({ length: 21 }, (_, i) => ({ x: i, y: i }));
    for (const mode of ["scan", "static", "live"] as const) {
      const { unmount } = render(<HandStage mode={mode} landmarks={pose} label={`hand ${mode}`} className="mine" />);
      const stage = screen.getByRole("img", { name: `hand ${mode}` });
      expect(stage.classList.contains("mine")).toBe(true);
      unmount();
    }
  });

  it("does not load the scene when WebGL is missing, and does when it exists", () => {
    const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
    getContext.mockReturnValue({} as unknown as RenderingContext);
    expect(webglAvailable()).toBe(true);
    getContext.mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(webglAvailable()).toBe(false); // a throwing context is "no WebGL", not a crash
  });
});
