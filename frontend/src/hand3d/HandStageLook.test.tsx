// @vitest-environment jsdom
// The overlay's look: "glow" (default, the existing hologram) or "clean" (only the live landmark skeleton).
// The scenes are replaced by stand-ins here (jsdom has no WebGL): this tests the wiring, not the drawing.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandStageProps } from "./HandStage";

const seen: Record<string, unknown>[] = [];

vi.mock("./HandStageGL", () => ({
  default: (props: Record<string, unknown>) => {
    seen.push(props);
    return <div data-testid="scene" data-look={String(props.look ?? "none")} />;
  },
}));
vi.mock("./HandOverlayCleanGL", () => ({
  default: (props: Record<string, unknown>) => <div data-testid="clean-overlay" data-tone={String(props.tone ?? "")} data-mirror={String(!!props.mirror)} />,
}));

import { HandStage, resetWebglCheck } from "./HandStage";
import HandOverlayGL from "./HandOverlayGL";

beforeEach(() => {
  seen.length = 0;
  resetWebglCheck();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as unknown as RenderingContext);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("HandStage passes the look through to the scene", () => {
  it("does not add a look by default (the glow look stays the default everywhere)", async () => {
    render(<HandStage mode="overlay" />);
    await waitFor(() => expect(screen.getByTestId("scene")).toBeTruthy());
    expect(screen.getByTestId("scene").getAttribute("data-look")).toBe("none");
  });

  it("passes look='clean' to the overlay scene, and keeps every other prop", async () => {
    const tags = [{ joint: 8, label: "71 mm" }];
    render(<HandStage mode="overlay" look="clean" tone="warn" mirror tags={tags} />);
    await waitFor(() => expect(screen.getByTestId("scene")).toBeTruthy());
    expect(screen.getByTestId("scene").getAttribute("data-look")).toBe("clean");
    const props = seen.at(-1)!;
    expect(props.mode).toBe("overlay");
    expect(props.tone).toBe("warn");
    expect(props.mirror).toBe(true);
    expect(props.tags).toBe(tags);
  });

  it("the stage modes ignore the look (result and calculating screens are unchanged)", async () => {
    const pose = Array.from({ length: 21 }, (_, i) => ({ x: i, y: i }));
    const { container } = render(<HandStage mode="static" landmarks={pose} look="clean" />);
    await waitFor(() => expect(screen.getByTestId("scene")).toBeTruthy());
    expect(container.querySelector(".hand-stage-overlay")).toBeNull();
  });
});

describe("HandOverlayGL chooses the scene by look", () => {
  const base = { mode: "overlay" } as HandStageProps;

  it("renders the clean skeleton overlay for look='clean', with the props passed on", () => {
    render(<HandOverlayGL {...base} look="clean" tone="ok" mirror />);
    const clean = screen.getByTestId("clean-overlay");
    expect(clean.getAttribute("data-tone")).toBe("ok");
    expect(clean.getAttribute("data-mirror")).toBe("true");
  });

  it("does not render the clean overlay for the default or for look='glow'", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onDegrade = vi.fn();
    const first = render(<HandOverlayGL {...base} onDegrade={onDegrade} />);
    expect(screen.queryByTestId("clean-overlay")).toBeNull();
    first.unmount();
    render(<HandOverlayGL {...base} look="glow" onDegrade={onDegrade} />);
    expect(screen.queryByTestId("clean-overlay")).toBeNull();
    // jsdom has no WebGL, so the glow scene cannot start and says so (its own, unchanged behaviour)
    expect(warn).toHaveBeenCalled();
  });
});
