// @vitest-environment jsdom
// The wrapper of the experimental mesh viewer: its states, modes, presets, toggles, legends and honesty label, with the
// three.js scene stubbed (jsdom has no WebGL). The scene itself is looked at in Chromium by e2e/experiment-viewer.spec.ts.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mesh } from "../common";
import type { MeshSceneProps } from "./MeshViewer";
import type { ViewPreset } from "./meshViewerModel";

const scenes: MeshSceneProps[] = [];
const reset = vi.fn();
const view = vi.fn<(p: ViewPreset) => void>();

vi.mock("./MeshViewerGL", () => ({
  default: (p: MeshSceneProps) => {
    scenes.push(p);
    p.controlsRef.current = { reset, view };
    return <div data-testid="scene" />;
  },
}));

const webgl = { on: true };
// a tetrahedron resting on z = 0 (vertex 0..2 on the board plane, 3 above)
const mesh: Mesh = { vertices: Float32Array.from([0, 0, 0, 100, 0, 0, 0, 50, 0, 0, 0, 20]), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) };
const support = Uint8Array.from([2, 2, 0, 1]);
const confidence = Float32Array.from([0, 0.5, 1, 1]);
const landmarks = Array.from({ length: 21 }, (_, i) => [i * 4, i % 5, 10] as const);
// palm-down hand frame in the board frame: fingers +x, little finger +y, palm normal -z
const palmDown = { origin: [0, 0, 10], x: [0, 1, 0], y: [1, 0, 0], z: [0, 0, -1] };

beforeEach(() => {
  scenes.length = 0;
  reset.mockClear();
  view.mockClear();
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

async function ready(props: Record<string, unknown> = {}) {
  const mod = await load(props);
  await screen.findByTestId("scene");
  act(() => scenes.at(-1)!.onReady());
  return mod;
}

const btn = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const group = (name: string) => screen.getByRole("group", { name });
const last = () => scenes.at(-1)!;

describe("the experimental mesh viewer card: states", () => {
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
    await load({ mesh, label: "SIMULATED: synthetic capsule hand, not a real scan" });
    expect(screen.getByText("SIMULATED: synthetic capsule hand, not a real scan")).toBeTruthy();
    expect(screen.queryByText("Experimental, not a validated measurement")).toBeNull();
  });

  it("shows 'Loading 3D view' until the scene is ready; every control waits for it", async () => {
    await load({ mesh });
    expect(screen.getByText(/Loading 3D view/)).toBeTruthy();
    await screen.findByTestId("scene");
    expect(btn("Reset view").disabled).toBe(true);
    expect(btn("Top (+z)").disabled).toBe(true);
    expect(btn("Wireframe").disabled).toBe(true);
    act(() => last().onReady());
    expect(screen.queryByText(/Loading 3D view/)).toBeNull();
    fireEvent.click(btn("Reset view"));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("without WebGL it says so inside the card, shows no controls and tells the parent once", async () => {
    webgl.on = false;
    const onUnavailable = vi.fn();
    await load({ mesh, onUnavailable });
    expect(document.querySelector(".mv-error")!.textContent).toMatch(/3D view unavailable/);
    expect(scenes).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Reset view" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Display mode" })).toBeNull();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("shows the scene's own failure (a lost context) once", async () => {
    const onUnavailable = vi.fn();
    await load({ mesh, onUnavailable });
    await screen.findByTestId("scene");
    act(() => last().onFail("3D view stopped: test"));
    act(() => scenes.at(-1)?.onFail("3D view stopped: again"));
    expect(document.querySelector(".mv-error")!.textContent).toMatch(/stopped/);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});

describe("display and colour modes", () => {
  it("Surface by default; Wireframe and Point cloud switch the scene's display with aria-pressed", async () => {
    await ready({ mesh });
    expect(btn("Surface").getAttribute("aria-pressed")).toBe("true");
    expect(last().display).toBe("surface");
    fireEvent.click(btn("Wireframe"));
    expect(btn("Wireframe").getAttribute("aria-pressed")).toBe("true");
    expect(btn("Surface").getAttribute("aria-pressed")).toBe("false");
    expect(last().display).toBe("wireframe");
    fireEvent.click(btn("Point cloud"));
    expect(last().display).toBe("points");
    expect(screen.getByTestId("mv-facts").textContent).toMatch(/Point cloud shows the mesh's vertices/);
  });

  it("a points-only reconstruction starts in Point cloud; Surface and Wireframe are unavailable", async () => {
    await ready({ points: Float32Array.from([0, 0, 0, 1, 1, 1]) });
    expect(last().mesh).toBeNull();
    expect(last().points).not.toBeNull();
    expect(last().display).toBe("points");
    expect(btn("Surface").disabled).toBe(true);
    expect(btn("Wireframe").disabled).toBe(true);
    expect(btn("Support").disabled).toBe(true);
  });

  it("colour by support only when matching labels are supplied, with the legend in words and shares", async () => {
    await ready({ mesh, support });
    expect(btn("Confidence").disabled).toBe(true);
    fireEvent.click(btn("Support"));
    expect(last().colour).toBe("support");
    expect(last().support).toBe(support);
    const legend = within(screen.getByTestId("mv-legend"));
    expect(legend.getByText("observed")).toBeTruthy();
    expect(legend.getByText("implied")).toBeTruthy();
    expect(legend.getByText("bounded by the board, not observed")).toBeTruthy();
    expect(legend.getByText("cut at the forearm")).toBeTruthy();
    expect(legend.getByText(/truncated/)).toBeTruthy();
    expect(screen.getByTestId("mv-legend").textContent).toMatch(/bounded by the board, not observed\s*50 %/);
  });

  it("colour by confidence with a ramp legend; ignores a confidence array of the wrong length", async () => {
    await ready({ mesh, confidence });
    fireEvent.click(btn("Confidence"));
    expect(last().colour).toBe("confidence");
    expect(screen.getByTestId("mv-legend").textContent).toMatch(/weakly observed \(0\).*directly observed \(1\)/);
    expect(screen.getByTestId("mv-legend").textContent).toMatch(/75 % of vertices at 0.5 or more/);
    cleanup();
    scenes.length = 0;
    await ready({ mesh, confidence: Float32Array.from([1, 1]), support: Uint8Array.from([0]) });
    expect(last().confidence).toBeNull();
    expect(last().support).toBeNull();
    expect(btn("Confidence").disabled).toBe(true);
    expect(btn("Support").disabled).toBe(true);
  });

  it("a separate cloud's own labels drive Support in Point cloud mode, and the mesh's labels in Surface mode", async () => {
    const points = Float32Array.from([0, 0, 0, 5, 5, 5, 9, 9, 9]);
    await ready({ mesh, points, pointLabels: Uint8Array.from([0, 0, 3]) });
    expect(btn("Support").disabled).toBe(true); // Surface: no vertex labels
    fireEvent.click(btn("Point cloud"));
    expect(btn("Support").disabled).toBe(false);
    fireEvent.click(btn("Support"));
    expect(last().colour).toBe("support");
    expect(screen.getByTestId("mv-legend").textContent).toMatch(/cut at the forearm\s*33 %/);
    fireEvent.click(btn("Surface"));
    expect(last().colour).toBe("plain"); // falls back while the mode is unavailable
    fireEvent.click(btn("Point cloud"));
    expect(last().colour).toBe("support"); // and comes back
  });

  it("toggling modes never hands the scene new geometry", async () => {
    await ready({ mesh, support, confidence, landmarks });
    const first = last();
    fireEvent.click(btn("Wireframe"));
    fireEvent.click(btn("Support"));
    fireEvent.click(btn("Confidence"));
    fireEvent.click(btn("Landmark skeleton (diagnostic)"));
    fireEvent.click(btn("Top (+z)"));
    const now = last();
    expect(now.mesh).toBe(first.mesh);
    expect(now.support).toBe(first.support);
    expect(now.confidence).toBe(first.confidence);
    expect(now.landmarks).toBe(first.landmarks);
    expect(now.bounds).toBe(first.bounds);
    expect(now.grid).toBe(first.grid);
  });
});

describe("views", () => {
  it("without a hand frame: board-axis presets, and it says so", async () => {
    await ready({ mesh });
    const names = within(group("Preset views")).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Top (+z)", "Underside (−z)", "+x end", "−x end", "+y side", "−y side"]);
    expect(screen.getByTestId("mv-facts").textContent).toMatch(/No hand frame given: named by the board axes/);
  });

  it("with a hand frame: the seven anatomical presets drive the scene and show as pressed", async () => {
    await ready({ mesh, handFrame: palmDown });
    const names = within(group("Preset views")).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Top", "Palm", "Back", "Thumb side", "Little-finger side", "Fingertips", "Wrist"]);
    expect(screen.getByTestId("mv-facts").textContent).toMatch(/Named from the hand frame/);
    fireEvent.click(btn("Fingertips"));
    expect(view).toHaveBeenCalledTimes(1);
    expect(view.mock.calls[0][0].id).toBe("fingertips");
    expect(view.mock.calls[0][0].toCamera).toEqual([1, 0, 0]);
    expect(btn("Fingertips").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("mv-viewname").textContent).toBe("Fingertips view");
    act(() => last().onViewChange("free")); // turned by hand
    expect(btn("Fingertips").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("mv-viewname").textContent).toBe("Free view");
    fireEvent.click(btn("Reset view"));
    expect(screen.getByTestId("mv-viewname").textContent).toBe("Home view");
  });

  it("Palm view of a palm-down hand says the palm side is bounded by the board, not observed, and offers support colours", async () => {
    await ready({ mesh, support, handFrame: palmDown });
    expect(screen.queryByTestId("mv-board-note")).toBeNull();
    fireEvent.click(btn("Palm"));
    expect(view.mock.calls[0][0].toCamera).toEqual([0, 0, -1]); // from under the board
    const note = screen.getByTestId("mv-board-note");
    expect(note.textContent).toMatch(/Palm side: bounded by the board, not observed/);
    fireEvent.click(within(note).getByRole("button", { name: "Show support colours" }));
    expect(last().colour).toBe("support");
    fireEvent.click(btn("Back"));
    expect(screen.queryByTestId("mv-board-note")).toBeNull();
  });

  it("the underside (no frame) carries the board note only when board-bounded vertices exist", async () => {
    await ready({ mesh });
    fireEvent.click(btn("Underside (−z)"));
    expect(screen.queryByTestId("mv-board-note")).toBeNull();
    cleanup();
    await ready({ mesh, support });
    fireEvent.click(btn("Underside (−z)"));
    expect(screen.getByTestId("mv-board-note").textContent).toMatch(/^Underside: bounded by the board, not observed./);
  });
});

describe("skeleton, scale and size", () => {
  it("the landmark skeleton is optional, off by default, labelled diagnostic, and toggles", async () => {
    await ready({ mesh, landmarks });
    const b = btn("Landmark skeleton (diagnostic)");
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(last().skeleton).toBe(false);
    expect(last().landmarks).toHaveLength(63);
    fireEvent.click(b);
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(last().skeleton).toBe(true);
    expect(screen.getByTestId("mv-legend").textContent).toMatch(/Landmark skeleton \(diagnostic\): 21 points drawn on top, not part of the mesh/);
  });

  it("without 21 valid landmarks the skeleton button is disabled", async () => {
    await ready({ mesh, landmarks: [[0, 0, 0]] });
    expect(btn("Landmark skeleton (diagnostic)").disabled).toBe(true);
    expect(last().landmarks).toBeNull();
  });

  it("reads out the bounding size, the grid scale and the triangle count", async () => {
    await ready({ mesh, handFrame: palmDown });
    const facts = screen.getByTestId("mv-facts").textContent!;
    expect(facts).toMatch(/100 × 50.0 × 20.0 mm \(x × y × z\)/);
    expect(facts).toMatch(/length 100, breadth 50.0, thickness 20.0 mm \(bounding extents, not measurements\)/);
    expect(facts).toMatch(/Grid: 5 mm squares, darker every 25 mm, on the board plane \(z = 0\)/);
    expect(facts).toMatch(/4 triangles, 4 vertices/);
  });

  it("uses the unit it is given", async () => {
    await ready({ points: Float32Array.from([0, 0, 0, 300, 200, 0]), unit: "px" });
    expect(screen.getByTestId("mv-facts").textContent).toMatch(/300 × 200 × 0.00 px/);
  });
});
