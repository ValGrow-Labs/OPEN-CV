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
