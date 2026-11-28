// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TiltGuide, innerTransform } from "./TiltGuide";

afterEach(cleanup);

describe("innerTransform", () => {
  it("is flat and centred for a palm parallel to the phone", () => {
    const t = innerTransform({ rollDeg: 0, pitchDeg: 0, totalDeg: 0 });
    expect(t).toContain("rotateX(0.0deg)");
    expect(t).toContain("rotateY(0.0deg)");
    expect(t).toContain("translate(0.0px, 0.0px)");
  });

  it("leans the inner rectangle the way the palm leans, and keeps it within bounds", () => {
    // right side away (negative roll): drawn with its right side receding, which is a positive CSS rotateY
    expect(innerTransform({ rollDeg: -20, pitchDeg: 0, totalDeg: 20 })).toContain("rotateY(20.0deg)");
    // top away (positive pitch): drawn with its top receding, which is a positive CSS rotateX
    expect(innerTransform({ rollDeg: 0, pitchDeg: 15, totalDeg: 15 })).toContain("rotateX(15.0deg)");
    const big = innerTransform({ rollDeg: 170, pitchDeg: -170, totalDeg: 90 });
    expect(big).toContain("rotateY(-50.0deg)");
    expect(big).toContain("rotateX(-50.0deg)");
  });
});

describe("TiltGuide", () => {
  const ref = { current: null };
  it("draws a phone rectangle with a smaller one inside, green when level", () => {
    const { container, rerender } = render(<TiltGuide tiltRef={ref} level={false} enabled />);
    const root = container.querySelector(".mm-tilt")!;
    expect(root).not.toBeNull();
    expect(root.querySelector(".mm-tilt-inner")).not.toBeNull();
    expect(root.classList.contains("is-level")).toBe(false);
    expect(root.getAttribute("aria-hidden")).toBe("true");
    rerender(<TiltGuide tiltRef={ref} level enabled />);
    expect(container.querySelector(".mm-tilt")!.classList.contains("is-level")).toBe(true);
  });

  it("is not drawn when it is turned off (the side view)", () => {
    const { container } = render(<TiltGuide tiltRef={ref} level enabled={false} />);
    expect(container.querySelector(".mm-tilt")).toBeNull();
  });
});
