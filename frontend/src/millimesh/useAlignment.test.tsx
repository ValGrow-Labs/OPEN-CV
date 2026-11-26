// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guideBox, handBoxInView, type AlignResult } from "./alignment";
import { useAlignment } from "./useAlignment";
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

/** Renders the hook and lets a test read its latest result. */
function setup(pose: readonly Landmark[] | null, phase: "palm" | "side" | "back" = "palm") {
  const poseRef = { current: pose };
  const frameRef = { current: { width: VIEW.width, height: VIEW.height } };
  const latest: { current: AlignResult | null } = { current: null };
  function Probe() {
    const viewRef = useRef<HTMLDivElement>(null);
    latest.current = useAlignment({ poseRef, frameRef, viewRef, mirror: false, phase });
    return <div ref={viewRef} />;
  }
  const view = render(<Probe />);
  return { poseRef, latest, ...view };
}
const lit = (r: AlignResult | null) => (r ? (["tl", "tr", "bl", "br"] as const).filter((c) => r.corners[c]) : []);

describe("useAlignment", () => {
  it("lights nothing with no hand in the picture", async () => {
    const { latest } = setup(null);
    await waitFor(() => expect(latest.current).not.toBeNull());
    expect(lit(latest.current)).toEqual([]);
    expect(latest.current?.aligned).toBe(false);
    expect(latest.current?.hint).toBe("show_hand");
  });

  it("lights all four corners when the hand fills the guide", async () => {
    const { latest } = setup(handFilling(0.9));
    await waitFor(() => expect(latest.current?.aligned).toBe(true));
    expect(lit(latest.current)).toHaveLength(4);
  });

  it("lights none for a hand that is too small, and says which way to move a hand that is off to the side", async () => {
    const small = setup(handFilling(0.5));
    await waitFor(() => expect(small.latest.current?.hint).toBe("closer"));
    expect(lit(small.latest.current)).toEqual([]);
    small.unmount();

    const shifted = setup(handFilling(0.8, 70));
    await waitFor(() => expect(shifted.latest.current?.hint).toBe("left"));
    expect(shifted.latest.current?.aligned).toBe(false);
  });

  it("goes back to not lined up when the hand is moved away or lost", async () => {
    const { latest, poseRef } = setup(handFilling(0.9));
    await waitFor(() => expect(latest.current?.aligned).toBe(true));
    act(() => {
      poseRef.current = handFilling(0.45);
    });
    await waitFor(() => expect(latest.current?.aligned).toBe(false));
    act(() => {
      poseRef.current = null;
    });
    await waitFor(() => expect(lit(latest.current)).toEqual([]), { timeout: 3000 });
  });

  it("stops its timer when it is removed", async () => {
    const clear = vi.spyOn(window, "clearInterval");
    const { unmount, latest } = setup(handFilling(0.9));
    await waitFor(() => expect(latest.current).not.toBeNull());
    unmount();
    expect(clear).toHaveBeenCalled();
  });
});
