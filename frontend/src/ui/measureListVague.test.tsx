// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Measurement } from "../api/types";
import { veryUncertainFinger } from "./format";
import { MeasureList } from "./measureList";

afterEach(cleanup);

const hidden: Measurement = {
  key: "ring_length_mm",
  label: "Ring finger length",
  value_mm: null,
  uncertainty_mm: null,
  interval95_mm: null,
  status: "invalid",
  source: "camera_landmarks",
  method: "",
  definition: "",
  calibrated: false,
  frames_used: 12,
  uncertainty_components_mm: {},
  reasons: ["uncertainty_too_large"],
  info_value_mm: 93.4,
  info_uncertainty_mm: 7.1,
  info_interval95_mm: [79.5, 107.3],
  info_frames: 12,
};

describe("every finger is shown (the server's status and the size rules are unchanged)", () => {
  it("shows a hidden finger's number with the wide interval, a Very uncertain tag and the not-for-size note", () => {
    const { container } = render(<MeasureList items={[{ key: hidden.key, label: "Ring finger", m: hidden }]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("93 mm");
    expect(text).toContain("±7.1 mm");
    expect(text).toContain("95%: 80 to 107 mm");
    expect(text).toContain("Very uncertain");
    expect(text).toContain("not used for your glove size");
    expect(text).not.toContain("Not measured");
    expect(text).not.toContain("Not reliable");
    expect(container.querySelector('[data-very-uncertain="true"]')).not.toBeNull();
  });

  it("keeps Not measured for what the camera cannot measure, and for a finger with no number at all", () => {
    const circumference: Measurement = { ...hidden, key: "hand_circumference_mm", status: "not_measured", info_value_mm: null, reasons: ["requires_validated_model_or_manual_entry"] };
    const nothing: Measurement = { ...hidden, info_value_mm: null, info_uncertainty_mm: null, info_interval95_mm: null };
    const { container } = render(
      <MeasureList items={[{ key: circumference.key, label: "Hand circumference", m: circumference }, { key: nothing.key, label: "Ring finger", m: nothing }]} />,
    );
    expect((container.textContent ?? "").match(/Not measured/g)?.length).toBe(2);
    expect(veryUncertainFinger(circumference)).toBeNull();
    expect(veryUncertainFinger(nothing)).toBeNull();
  });

  it("does not touch a finger that has a value, and never invents one for a non-finger key", () => {
    const shown: Measurement = { ...hidden, value_mm: 91, status: "low_confidence", info_value_mm: null, reasons: [] };
    expect(veryUncertainFinger(shown)).toBeNull();
    expect(veryUncertainFinger({ ...hidden, key: "palm_length_mm" })).toBeNull();
    const { container } = render(<MeasureList items={[{ key: shown.key, label: "Ring finger", m: shown }]} />);
    expect(container.textContent).toContain("91 mm");
    expect(container.textContent).toContain("Low confidence");
    expect(container.textContent).not.toContain("Very uncertain");
  });
});

describe("the crease-to-tip estimate on the detailed page", () => {
  const withCrease: Measurement = {
    ...hidden,
    value_mm: 91,
    status: "low_confidence",
    reasons: [],
    info_value_mm: null,
    crease_to_tip_mm: 66.2,
    crease_uncertainty_mm: 7.7,
    crease_interval95_mm: [51.1, 81.3],
    crease_status: "invalid",
    crease_t: 0.64,
  };

  it("adds a crease-to-tip line under a finger, and explains the assumed proportion in How it's measured", () => {
    const { container } = render(<MeasureList showHow items={[{ key: withCrease.key, label: "Ring finger", m: withCrease }]} />);
    expect(container.querySelector('[data-crease="ring_length_mm"]')?.textContent).toBe("Crease to tip (estimate): ≈ 66 mm ±7.7 mm (95%: 51 to 81 mm)");
    const how = container.textContent ?? "";
    expect(how).toContain("glove-industry finger length");
    expect(how).toContain("64% of the knuckle-to-middle-joint segment");
    expect(how).toContain("ASSUMED");
    expect(how).toContain("not validated");
    expect(how).toContain("91 mm"); // today's knuckle-to-tip value is still the headline
  });

  it("says nothing for a finger without it, or for a hand value", () => {
    const none = render(<MeasureList items={[{ key: hidden.key, label: "Ring finger", m: { ...hidden, value_mm: 90, status: "low_confidence" } }]} />);
    expect(none.container.querySelector("[data-crease]")).toBeNull();
    cleanup();
    const hand = render(<MeasureList items={[{ key: "hand_length_mm", label: "Hand length", m: { ...withCrease, key: "hand_length_mm" } }]} />);
    expect(hand.container.querySelector("[data-crease]")).toBeNull();
  });
});
