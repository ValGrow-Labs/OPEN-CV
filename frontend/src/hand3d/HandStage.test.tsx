// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HandStage, resetWebglCheck, webglAvailable } from "./HandStage";

// jsdom prints "not implemented" for canvas contexts; a phone without WebGL answers null.
beforeEach(() => {
  resetWebglCheck();
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
    resetWebglCheck();
    getContext.mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(webglAvailable()).toBe(false); // a throwing context is "no WebGL", not a crash
  });

  it("asks for a WebGL context once, not on every render", () => {
    const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
    getContext.mockReturnValue({} as unknown as RenderingContext);
    expect(webglAvailable()).toBe(true);
    const calls = getContext.mock.calls.length;
    for (let i = 0; i < 50; i++) expect(webglAvailable()).toBe(true);
    expect(getContext.mock.calls.length).toBe(calls);
  });
});

describe("theme (dark by default, light for the result page)", () => {
  const pose = Array.from({ length: 21 }, (_, i) => ({ x: i, y: i }));

  it("is the dark stage unless asked: no light class", () => {
    for (const mode of ["scan", "static", "live"] as const) {
      const { container, unmount } = render(<HandStage mode={mode} landmarks={pose} />);
      expect(container.querySelector(".hand-stage--light")).toBeNull();
      expect(container.querySelector(".hand-stage")).not.toBeNull();
      unmount();
    }
    const { container } = render(<HandStage mode="static" theme="dark" landmarks={pose} />);
    expect(container.querySelector(".hand-stage--light")).toBeNull();
  });

  it("theme=light adds hand-stage--light next to the existing classes for the stage modes", () => {
    for (const mode of ["static", "scan"] as const) {
      const { container, unmount } = render(<HandStage mode={mode} theme="light" landmarks={pose} className="mine" label={`light ${mode}`} />);
      const stage = screen.getByRole("img", { name: `light ${mode}` });
      expect(stage.classList.contains("hand-stage")).toBe(true);
      expect(stage.classList.contains("hand-stage--light")).toBe(true);
      expect(stage.classList.contains("mine")).toBe(true);
      expect(container.querySelector(".hand-stage-fallback")).not.toBeNull(); // no WebGL here: the CSS fallback
      unmount();
    }
  });

  it("the live tile and the overlay ignore the theme", () => {
    const live = render(<HandStage mode="live" theme="light" />);
    expect(live.container.querySelector(".hand-stage--light")).toBeNull();
    live.unmount();
    const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
    getContext.mockReturnValue({} as unknown as RenderingContext);
    const overlay = render(<HandStage mode="overlay" theme="light" onDegrade={() => undefined} />);
    expect(overlay.container.querySelector(".hand-stage--light")).toBeNull();
    expect(overlay.container.querySelector(".hand-stage-overlay")).not.toBeNull();
  });
});

describe("overlay mode (the camera view as a 3D measuring display)", () => {
  it("without WebGL renders nothing and tells the screen once, so it keeps its 2D drawing", () => {
    const onDegrade = vi.fn();
    const { container, rerender } = render(<HandStage mode="overlay" onDegrade={onDegrade} />);
    expect(container.firstChild).toBeNull();
    rerender(<HandStage mode="overlay" onDegrade={onDegrade} tags={[{ joint: 8, label: "71" }]} />);
    expect(onDegrade).toHaveBeenCalledTimes(1);
    expect(onDegrade).toHaveBeenCalledWith("disabled");
  });

  it("is decorative and inert: aria-hidden, no role, nothing to click, when it can run", async () => {
    const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
    getContext.mockReturnValue({} as unknown as RenderingContext);
    const onDegrade = vi.fn();
    const { container } = render(<HandStage mode="overlay" className="mine" onDegrade={onDegrade} />);
    const layer = container.querySelector(".hand-stage-overlay") as HTMLElement | null;
    expect(layer).not.toBeNull();
    expect(layer!.getAttribute("aria-hidden")).toBe("true");
    expect(layer!.getAttribute("role")).toBeNull();
    expect(layer!.classList.contains("mine")).toBe(true);
    expect(screen.queryByRole("img")).toBeNull();
    // the stand-in context is not a GPU: the scene cannot start, so the layer switches itself off
    // (never a blank, frozen canvas) and tells the screen exactly once
    await waitFor(() => expect(onDegrade).toHaveBeenCalledTimes(1), { timeout: 8000 });
    expect(onDegrade).toHaveBeenCalledWith("disabled");
    await waitFor(() => expect(container.querySelector("canvas")).toBeNull());
  }, 20000);

  it("an overlay that cannot start does not break the page around it", async () => {
    const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
    getContext.mockReturnValue({} as unknown as RenderingContext);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(
      <div>
        <p>the rest of the scan screen</p>
        <HandStage mode="overlay" />
      </div>,
    );
    await waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 8000 });
    expect(screen.getByText("the rest of the scan screen")).toBeTruthy();
  }, 20000);
});
