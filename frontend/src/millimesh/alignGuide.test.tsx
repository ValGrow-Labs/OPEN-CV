// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlignGuide } from "./AlignGuide";
import { guideBox, handBoxInView, type AlignResult } from "./alignment";
import type { Landmark } from "../hand3d/handModel";

const VIEW = { width: 350, height: 540 };

/** A rough open hand, wrist at the origin and fingers up (y negative), scaled and placed so the box around it is `fill` of the
 *  guide box's height and centred in it. The video is the view's size, so video pixels are view pixels. */
function handFilling(fill: number, dx = 0): Landmark[] {
  const unit: [number, number][] = [
    [0, 0],
    [-0.22, -0.15], [-0.4, -0.3], [-0.52, -0.42], [-0.62, -0.52],
    [-0.2, -0.55], [-0.2, -0.75], [-0.2, -0.9], [-0.2, -1.02],
    [-0.02, -0.57], [-0.02, -0.8], [-0.02, -0.97], [-0.02, -1.1],
    [0.16, -0.54], [0.16, -0.74], [0.16, -0.89], [0.16, -1.0],
    [0.32, -0.48], [0.32, -0.64], [0.32, -0.76], [0.32, -0.86],
  ];
  const at = (s: number, ox: number, oy: number) => unit.map(([x, y]) => ({ x: ox + x * s, y: oy + y * s, z: 0 }));
  const t = guideBox(VIEW.width, VIEW.height);
  const probe = handBoxInView(at(100, 0, 0), VIEW, VIEW, false)!;
  const s = (100 * fill * (t.y1 - t.y0)) / (probe.y1 - probe.y0);
  const box = handBoxInView(at(s, 0, 0), VIEW, VIEW, false)!;
  const ox = (t.x0 + t.x1) / 2 - (box.x0 + box.x1) / 2 + dx;
  const oy = (t.y0 + t.y1) / 2 - (box.y0 + box.y1) / 2;
  return at(s, ox, oy);
}

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: VIEW.width, height: VIEW.height, x: 0, y: 0, top: 0, left: 0, right: VIEW.width, bottom: VIEW.height, toJSON: () => ({}) });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(pose: readonly Landmark[] | null, phase: "palm" | "side" | "back" = "palm") {
  const poseRef = { current: pose };
  const frameRef = { current: { width: VIEW.width, height: VIEW.height } };
  const seen: AlignResult[] = [];
  const view = render(<AlignGuide poseRef={poseRef} frameRef={frameRef} mirror={false} phase={phase} onChange={(r) => seen.push(r)} />);
  const svg = () => view.container.querySelector("svg.mm-align") as SVGSVGElement;
  return { poseRef, seen, svg, ...view };
}

describe("AlignGuide", () => {
  it("draws a solid box and a boxed arrow at each of its four corners, none lit with no hand", async () => {
    const { svg } = setup(null);
    await waitFor(() => expect(svg().querySelectorAll(".mm-align-tag")).toHaveLength(4));
    expect(svg().querySelectorAll(".mm-align-box")).toHaveLength(1);
    expect(svg().querySelectorAll(".mm-align-tag.is-on")).toHaveLength(0);
    expect(svg().getAttribute("data-aligned")).toBe("false");
    expect(svg().getAttribute("aria-hidden")).toBe("true");
  });

  it("lights all four arrows green when the hand fills the box", async () => {
    const { svg, seen } = setup(handFilling(0.9));
    await waitFor(() => expect(svg().getAttribute("data-aligned")).toBe("true"));
    expect(svg().querySelectorAll(".mm-align-tag.is-on")).toHaveLength(4);
    expect(svg().classList.contains("is-aligned")).toBe(true);
    expect(seen.at(-1)?.aligned).toBe(true);
  });

  it("lights none of them for a hand that is too small, and some of them when it is moved to a side", async () => {
    const small = setup(handFilling(0.5));
    await waitFor(() => expect(small.seen.length).toBeGreaterThan(0));
    expect(small.svg().getAttribute("data-aligned")).toBe("false");
    expect(small.svg().querySelectorAll(".mm-align-tag.is-on")).toHaveLength(0);
    small.unmount();

    const shifted = setup(handFilling(0.8, 70));
    await waitFor(() => expect(shifted.seen.length).toBeGreaterThan(0));
    expect(shifted.svg().getAttribute("data-aligned")).toBe("false");
    expect(shifted.seen.at(-1)?.hint).toBe("left");
  });

  it("goes back to not lined up when the hand is moved away or lost", async () => {
    const { svg, poseRef } = setup(handFilling(0.9));
    await waitFor(() => expect(svg().getAttribute("data-aligned")).toBe("true"));
    act(() => {
      poseRef.current = handFilling(0.45);
    });
    await waitFor(() => expect(svg().getAttribute("data-aligned")).toBe("false"));
    act(() => {
      poseRef.current = null;
    });
    await waitFor(() => expect(svg().querySelectorAll(".mm-align-tag.is-on")).toHaveLength(0), { timeout: 3000 });
  });

  it("stops its timer when it is removed", async () => {
    const clear = vi.spyOn(window, "clearInterval");
    const { unmount, svg } = setup(handFilling(0.9));
    await waitFor(() => expect(svg()).not.toBeNull());
    unmount();
    expect(clear).toHaveBeenCalled();
  });
});
