// @vitest-environment jsdom
// The wrapper of the experimental mesh viewer: its states, buttons and honesty label, with the three.js scene stubbed
// (jsdom has no WebGL). The scene itself has NOT been looked at in a browser.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mesh } from "../common";
import type { MeshSceneProps } from "./MeshViewer";

const scenes: MeshSceneProps[] = [];
const reset = vi.fn();

vi.mock("./MeshViewerGL", () => ({
  default: (p: MeshSceneProps) => {
    scenes.push(p);
    p.controlsRef.current = { reset };
    return <div data-testid="scene" />;
  },
}));

const webgl = { on: true };
const mesh: Mesh = { vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]) };

beforeEach(() => {
  scenes.length = 0;
  reset.mockClear();
  webgl.on = true;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((type: string) =>
    webgl.on && (type === "webgl2" || type === "webgl") ? ({ getExtension: () => null } as unknown as WebGLRenderingContext) : null) as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function load(props: Record<string, unknown> = {}) {
  const mod = await import("./MeshViewer");
  mod.resetMeshViewerWebglCheck();
  render(<mod.MeshViewer {...props} />);
  return mod;
}

describe("the experimental mesh viewer card", () => {
  it("says 'No reconstruction to show' when there is nothing, and loads no scene", async () => {
    await load();
    expect(screen.getByText("No reconstruction to show")).toBeTruthy();
    expect(scenes).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Reset view" })).toBeNull();
  });

  it("shows the default honesty label, and replaces it with the label it is given", async () => {
    await load({ mesh });
    expect(screen.getByText("Experimental, not a validated measurement")).toBeTruthy();
    cleanup();
    await load({ mesh, label: "Experimental reconstruction. Synthetic/unvalidated." });
    expect(screen.getByText("Experimental reconstruction. Synthetic/unvalidated.")).toBeTruthy();
    expect(screen.queryByText("Experimental, not a validated measurement")).toBeNull();
  });

  it("shows 'Loading 3D view' until the scene is ready, then the controls work", async () => {
    await load({ mesh });
    expect(screen.getByText(/Loading 3D view/)).toBeTruthy();
    await screen.findByTestId("scene");
    expect((screen.getByRole("button", { name: "Reset view" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => scenes.at(-1)!.onReady());
    expect(screen.queryByText(/Loading 3D view/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("toggles the wireframe and tells the scene", async () => {
    await load({ mesh });
    await screen.findByTestId("scene");
    act(() => scenes.at(-1)!.onReady());
    const btn = screen.getByRole("button", { name: "Wireframe" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(scenes.at(-1)!.wireframe).toBe(false);
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(scenes.at(-1)!.wireframe).toBe(true);
  });

  it("offers colouring by observation only when a matching confidence array is supplied", async () => {
    await load({ mesh });
    await screen.findByTestId("scene");
    act(() => scenes.at(-1)!.onReady());
    expect((screen.getByRole("button", { name: "Colour by observation" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    scenes.length = 0;
    await load({ mesh, confidence: Float32Array.from([0, 0.5, 1, 1]) });
    await screen.findByTestId("scene");
    act(() => scenes.at(-1)!.onReady());
    const btn = screen.getByRole("button", { name: "Colour by observation" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(scenes.at(-1)!.colorByConfidence).toBe(false);
    fireEvent.click(btn);
    expect(scenes.at(-1)!.colorByConfidence).toBe(true);
    expect(screen.getByText(/weakly observed/)).toBeTruthy();
  });

  it("ignores a confidence array of the wrong length instead of colouring the wrong vertices", async () => {
    await load({ mesh, confidence: Float32Array.from([1, 1]) });
    await screen.findByTestId("scene");
    expect(scenes.at(-1)!.confidence).toBeNull();
  });

  it("shows a points-only reconstruction too", async () => {
    await load({ points: Float32Array.from([0, 0, 0, 1, 1, 1]) });
    await screen.findByTestId("scene");
    expect(scenes.at(-1)!.mesh).toBeNull();
    expect(scenes.at(-1)!.points).not.toBeNull();
  });

  it("without WebGL it says so inside the card and tells the parent once", async () => {
    webgl.on = false;
    const onUnavailable = vi.fn();
    await load({ mesh, onUnavailable });
    expect(document.querySelector(".mv-error")!.textContent).toMatch(/3D view unavailable/);
    expect(scenes).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Reset view" })).toBeNull();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("shows the scene's own failure (a lost context) once", async () => {
    const onUnavailable = vi.fn();
    await load({ mesh, onUnavailable });
    await screen.findByTestId("scene");
    act(() => scenes.at(-1)!.onFail("3D view stopped: test"));
    act(() => scenes.at(-1)?.onFail("3D view stopped: again"));
    expect(document.querySelector(".mv-error")!.textContent).toMatch(/stopped/);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
