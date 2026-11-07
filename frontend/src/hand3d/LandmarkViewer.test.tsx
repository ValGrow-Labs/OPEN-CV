// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneProps, WorldHand } from "./LandmarkViewer";

const scenes: SceneProps[] = [];
const reset = vi.fn();
const topView = vi.fn();

vi.mock("./LandmarkViewerGL", () => ({
  default: (p: SceneProps) => {
    scenes.push(p);
    p.controlsRef.current = { reset, topView };
    return <div data-testid="scene" />;
  },
}));

const webgl = { on: true };

beforeEach(() => {
  scenes.length = 0;
  reset.mockClear();
  topView.mockClear();
  webgl.on = true;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((type: string) =>
    webgl.on && (type === "webgl2" || type === "webgl") ? ({ getExtension: () => null } as unknown as WebGLRenderingContext) : null) as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function load(over: { onUnavailable?: (m: string) => void; mirrored?: boolean } = {}) {
  const mod = await import("./LandmarkViewer");
  mod.resetViewerWebglCheck();
  const worldRef = { current: null } as MutableRefObject<WorldHand | null>;
  const view = render(<mod.LandmarkViewer worldRef={worldRef} {...over} />);
  return { mod, view, worldRef };
}

describe("the 3D landmark card", () => {
  it("says 'Loading 3D view' while the scene loads, with the honest caption already there", async () => {
    await load();
    expect(screen.getByRole("status").textContent).toMatch(/Loading 3D view/);
    expect(screen.getByText(/Estimated 3D landmark view\. Depth is MediaPipe's relative estimate, not a calibrated measurement\./)).toBeTruthy();
  });

  it("asks to show a hand once the scene is ready and nothing is tracked", async () => {
    await load();
    await screen.findByTestId("scene");
    act(() => scenes.at(-1)!.onReady());
    expect(screen.getByText("Show your hand to see it in 3D")).toBeTruthy();
    expect(screen.queryByText(/Loading 3D view/)).toBeNull();
  });

  it("shows the hand chip when a hand is tracked, and '2D points only' when there is no depth", async () => {
    await load();
    await screen.findByTestId("scene");
    act(() => scenes.at(-1)!.onReady());
    act(() => scenes.at(-1)!.onHand({ present: true, depth: true, handedness: "Left" }));
    expect(screen.getByText("Left hand")).toBeTruthy();
    expect(screen.queryByText(/Show your hand/)).toBeNull();
    expect(screen.queryByText(/2D points only/)).toBeNull();
    act(() => scenes.at(-1)!.onHand({ present: true, depth: false, handedness: "Right" }));
    expect(screen.getByText(/2D points only/)).toBeTruthy();
    expect(screen.getByText("Right hand")).toBeTruthy();
  });

  it("has Reset view and Top view buttons that drive the scene", async () => {
    await load();
    await screen.findByTestId("scene");
    expect((screen.getByRole("button", { name: "Reset view" }) as HTMLButtonElement).disabled).toBe(true); // not ready yet
    act(() => scenes.at(-1)!.onReady());
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    fireEvent.click(screen.getByRole("button", { name: "Top view" }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(topView).toHaveBeenCalledTimes(1);
  });

  it("passes the mirrored flag and the pose ref to the scene", async () => {
    const { worldRef } = await load({ mirrored: true });
    await screen.findByTestId("scene");
    expect(scenes.at(-1)!.mirrored).toBe(true);
    expect(scenes.at(-1)!.worldRef).toBe(worldRef);
  });

  it("shows a meaningful error and tells the parent once when WebGL is missing", async () => {
    webgl.on = false;
    const onUnavailable = vi.fn();
    await load({ onUnavailable });
    const alert = document.querySelector(".lv-error")!;
    expect(alert.textContent).toMatch(/3D view unavailable/);
    expect(alert.textContent).toMatch(/scan itself still works/);
    expect(scenes).toHaveLength(0); // no scene is loaded at all
    expect(screen.queryByRole("button", { name: "Reset view" })).toBeNull();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable.mock.calls[0][0]).toMatch(/3D view unavailable/);
  });

  it("shows the scene's own failure (a lost context) once, inside the card", async () => {
    const onUnavailable = vi.fn();
    await load({ onUnavailable });
    await screen.findByTestId("scene");
    act(() => scenes.at(-1)!.onFail("3D view stopped: test"));
    act(() => scenes.at(-1)?.onFail("3D view stopped: again"));
    expect(document.querySelector(".lv-error")!.textContent).toMatch(/stopped/);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
