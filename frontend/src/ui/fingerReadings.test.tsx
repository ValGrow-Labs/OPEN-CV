// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FingerReadingsFields, emptyFingers, fingerKeyLabel, fingerProblems, fingersPayload, type FingerInputs } from "./fingerReadings";

afterEach(cleanup);

const withValues = (edit: (f: FingerInputs) => void): FingerInputs => {
  const f = emptyFingers();
  edit(f);
  return f;
};

describe("fingersPayload", () => {
  it("sends nothing when no finger was typed", () => {
    expect(fingersPayload(emptyFingers(), "mm")).toBeUndefined();
  });

  it("sends only the fingers and datums that have readings, in the chosen unit", () => {
    const f = withValues((v) => {
      v.index.crease_to_tip = ["70", "70,5"];
      v.thumb.knuckle_to_tip = ["", "6.1"];
    });
    expect(fingersPayload(f, "cm")).toEqual({
      index: { crease_to_tip: [{ value: 70, unit: "cm" }, { value: 70.5, unit: "cm" }] },
      thumb: { knuckle_to_tip: [{ value: 6.1, unit: "cm" }] },
    });
  });
});

describe("fingerProblems", () => {
  it("is empty for plausible readings and blank boxes", () => {
    const f = withValues((v) => {
      v.middle.crease_to_tip = ["78", "78.5"];
      v.middle.knuckle_to_tip = ["101", ""];
    });
    expect(fingerProblems(f, "mm")).toEqual([]);
  });

  it("catches a unit mix-up and a typo", () => {
    const f = withValues((v) => {
      v.ring.crease_to_tip = ["7.5", ""]; // cm typed while the unit is mm
      v.little.knuckle_to_tip = ["abc", ""];
    });
    const p = fingerProblems(f, "mm");
    expect(p).toContain("ring crease to tip in a plausible range (check the unit)");
    expect(p).toContain("little knuckle to tip: not a number");
    // the same value is fine in centimetres
    expect(fingerProblems(withValues((v) => (v.ring.crease_to_tip = ["7.5", ""])), "cm")).toEqual([]);
  });
});

describe("fingerKeyLabel", () => {
  it("reads a summary key as words", () => {
    expect(fingerKeyLabel("index_crease_to_tip_mm")).toBe("Index, crease to tip");
    expect(fingerKeyLabel("thumb_knuckle_to_tip_mm")).toBe("Thumb, knuckle to tip");
  });
});

describe("FingerReadingsFields", () => {
  function Harness() {
    const [v, setV] = useState(emptyFingers);
    return (
      <>
        <FingerReadingsFields value={v} unit="mm" onChange={setV} />
        <output data-testid="payload">{JSON.stringify(fingersPayload(v, "mm") ?? null)}</output>
      </>
    );
  }

  it("has two readings of each datum for all five fingers, and typing fills the payload", () => {
    render(<Harness />);
    expect(screen.getAllByRole("textbox")).toHaveLength(20);
    fireEvent.change(screen.getByLabelText("Index crease to tip, first (mm)"), { target: { value: "71" } });
    fireEvent.change(screen.getByLabelText("Index crease to tip, second (mm)"), { target: { value: "71.5" } });
    expect(JSON.parse(screen.getByTestId("payload").textContent!)).toEqual({
      index: { crease_to_tip: [{ value: 71, unit: "mm" }, { value: 71.5, unit: "mm" }] },
    });
    expect(screen.getByText(/1 finger/)).toBeTruthy();
  });
});
