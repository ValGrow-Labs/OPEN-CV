// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Measurement, Recommendation, ScanResponse } from "../api/types";
import { fitHand } from "./fitHand";
import { simpleNumbers, SimpleResults, sizeChipText } from "./SimpleResults";
import { COIN_MM, sweep } from "./testHands";

afterEach(cleanup);

const m = (key: string, value: number | null, extra: Partial<Measurement> = {}): Measurement => ({
  key,
  label: key,
  value_mm: value,
  uncertainty_mm: value === null ? null : 6,
  interval95_mm: null,
  status: value === null ? "invalid" : "low_confidence",
  source: "camera_landmarks",
  method: "",
  definition: "",
  calibrated: false,
  frames_used: 12,
  uncertainty_components_mm: {},
  reasons: [],
  ...extra,
});

const crease = (mm: number, status: "valid" | "low_confidence" | "invalid", t: number): Partial<Measurement> => ({
  crease_to_tip_mm: mm,
  crease_uncertainty_mm: 7.8,
  crease_interval95_mm: [mm - 15.3, mm + 15.3],
  crease_status: status,
  crease_t: t,
});

const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
  status: "recommended",
  size: "M",
  alternative_size: null,
  confidence_level: "likely",
  chart_id: "demo-length-v1",
  manufacturer: null,
  product_model: null,
  is_demo_chart: true,
  disclaimer: null,
  basis: [],
  explanation: [],
  needed_measurements: [],
  plausible_sizes: ["M"],
  by_measurement: [],
  ...over,
});

function response(over: Partial<ScanResponse> = {}): ScanResponse {
  return {
    status: "accepted",
    issues: [],
    calibration: null,
    measurements: [
      m("hand_length_mm", 167.4, { status: "valid" }),
      m("palm_length_mm", 95),
      m("mcp_span_mm", 72.2),
      m("thumb_length_mm", 55.04, { tip_source: { outline: 12 }, ...crease(54.6, "low_confidence", 0.05) }),
      m("index_length_mm", 91.3, { tip_source: { outline: 8, estimated: 4 }, ...crease(66.2, "invalid", 0.59) }),
      m("middle_length_mm", 102.2, { tip_source: { estimated: 12 }, ...crease(74.1, "low_confidence", 0.62) }),
      m("ring_length_mm", 94.4, crease(67.4, "low_confidence", 0.64)),
      m("little_length_mm", null, { reasons: ["uncertainty_too_large"], info_value_mm: 75.4, info_uncertainty_mm: 6.2, info_interval95_mm: [63, 88], info_frames: 12, ...crease(55.2, "invalid", 0.61) }),
      m("palm_breadth_mm", null, { status: "not_measured", source: "not_available" }),
      m("hand_circumference_mm", null, { status: "not_measured", source: "not_available" }),
    ],
    proportions: {},
    frames_received: 40,
    frames_accepted: 36,
    frame_rejection_counts: {},
    landmarks_px_median: null,
    coin_median: null,
    image_width: 1280,
    image_height: 720,
    recommendation: rec(),
    uncertainty_basis: "prior_assumptions",
    limitations: [],
    ...over,
  };
}

const fit = fitHand({ palm: sweep(30, [{}], { noiseM: 0.002 }), side: sweep(20, [{ yaw: 90 }], { coin: false }), back: sweep(30, [{}], { flip: 180 }), referenceDiameterMm: COIN_MM })!;

describe("the simple results page", () => {
  it("shows the 3D hand control in the order Point Cloud, Solid, Wireframe, with the drag caption", () => {
    render(<SimpleResults fit={fit} response={response()} onMore={() => {}} onRescan={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your hand");
    const modes = within(screen.getByRole("radiogroup", { name: "How to draw the model" })).getAllByRole("radio");
    expect(modes.map((x) => x.textContent)).toEqual(["Point Cloud", "Solid", "Wireframe"]);
    expect(modes[0].getAttribute("aria-checked")).toBe("true");
    fireEvent.click(modes[2]);
    expect(modes[2].getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(screen.getByRole("radiogroup", { name: "How to draw the model" }), { key: "ArrowLeft" });
    expect(modes[1].getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Drag to rotate")).toBeNull(); // only offered when the 3D view can be drawn (the e2e checks it with WebGL)
    expect(screen.getByRole("note").textContent).toMatch(/Estimated 3D model/);
    // no WebGL here: the flat drawing of the same fitted hand takes the place of the 3D view, and says so
    expect(screen.getByRole("img", { name: /flat drawing/ })).toBeTruthy();
    expect(document.querySelector(".mm-legend")).toBeNull(); // no capture markers or legend
  });

  it("shows hand length and width in cm, and says the width is knuckle to knuckle", () => {
    render(<SimpleResults fit={fit} response={response()} onMore={() => {}} onRescan={() => {}} />);
    expect(screen.getByTestId("hand-length").textContent).toBe("≈ 16.7 cm");
    expect(screen.getByTestId("hand-width").textContent).toBe("≈ 7.2 cm");
    expect(screen.getByText(/Width is knuckle to knuckle/)).toBeTruthy();
    expect(screen.queryByText(/^Palm breadth/)).toBeNull(); // the palm breadth is never shown as a measured row
    expect(document.querySelector('[data-testid="hand-width"]')?.previousElementSibling?.textContent).toBe("Hand width");
    expect(document.body.textContent).not.toMatch(/circumference/i);
  });

  it("defaults to crease to tip, tagged as an estimate with its caption, and offers knuckle to tip beside it", () => {
    render(<SimpleResults fit={fit} response={response()} onMore={() => {}} onRescan={() => {}} />);
    const choice = screen.getByRole("radiogroup", { name: "Finger length definition" });
    const radios = [...choice.querySelectorAll('[role="radio"]')];
    expect(radios.map((r) => r.textContent)).toEqual(["Crease to tip (est.)", "Knuckle to tip"]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    const rows = [...document.querySelectorAll(".mm-simple-fingers li")].map((li) => li.textContent);
    expect(rows).toEqual(["Thumb≈ 55 mm", "Index≈ 66 mmVery uncertain", "Middle≈ 74 mm", "Ring≈ 67 mm", "Little≈ 55 mmVery uncertain"]);
    expect(screen.getByText("estimate")).toBeTruthy();
    expect(screen.getByText(/from the crease at the base of the finger to the tip, estimated from your knuckle joint with a standard hand proportion; not validated/)).toBeTruthy();
    expect(screen.getByText(/Each is uncertain by about ±15 mm/)).toBeTruthy();
    expect(screen.queryByText(/from the knuckle joint to the fingertip/)).toBeNull();
  });

  it("switches to the knuckle-to-tip numbers (today's), with ≈, whole mm and Very uncertain only where the server hides the value", () => {
    render(<SimpleResults fit={fit} response={response()} onMore={() => {}} onRescan={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Knuckle to tip" }));
    const rows = [...document.querySelectorAll(".mm-simple-fingers li")].map((li) => li.textContent);
    expect(rows).toEqual(["Thumb≈ 55 mm", "Index≈ 91 mm", "Middle≈ 102 mm", "Ring≈ 94 mm", "Little≈ 75 mmVery uncertain"]);
    expect(screen.getByText(/Finger length is from the knuckle joint to the fingertip/)).toBeTruthy();
    expect(screen.getByText(/Each is uncertain by about ±12 mm/)).toBeTruthy();
    expect(screen.queryByText("estimate")).toBeNull();
    expect(screen.getByText(/not used for your size/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Crease to tip (est.)" }));
    expect(document.querySelector('[data-finger="index_length_mm"]')?.textContent).toMatch(/66 mm/);
  });

  it("an older server without the crease estimate gets the knuckle-to-tip rows and no choice", () => {
    const old = response({ measurements: response().measurements.map((x) => ({ ...x, crease_to_tip_mm: undefined, crease_status: undefined })) });
    render(<SimpleResults fit={fit} response={old} onMore={() => {}} onRescan={() => {}} />);
    expect(screen.queryByRole("radiogroup", { name: "Finger length definition" })).toBeNull();
    expect(simpleNumbers(old).definition).toBe("knuckle");
    expect(document.querySelector('[data-finger="index_length_mm"]')?.textContent).toMatch(/91 mm/);
  });

  it("says where the fingertips came from, per finger, without clutter", () => {
    const n = simpleNumbers(response());
    expect(n.fingers.map((f) => f.tip)).toEqual(["outline", "outline", "estimated", null, null]);
    expect(simpleNumbers(response(), "knuckle").fingers.map((f) => f.tip)).toEqual(n.fingers.map((f) => f.tip)); // the tip hint does not depend on the definition
    expect(n.tipLine).toBe("Fingertips: found on the hand outline for 2, estimated for 1.");
    const landmark = simpleNumbers(response({ measurements: response().measurements.map((x) => (x.key.endsWith("_length_mm") && x.tip_source ? { ...x, tip_source: { landmark: 12 } } : x)) }));
    expect(landmark.tipLine).toMatch(/model.s tip points/);
    expect(simpleNumbers(response({ measurements: response().measurements.map((x) => ({ ...x, tip_source: undefined })) })).tipLine).toBeNull();
  });

  it("shows the existing recommendation as one small chip, and the unvalidated line", () => {
    render(<SimpleResults fit={fit} response={response()} onMore={() => {}} onRescan={() => {}} />);
    expect(screen.getByTestId("size-chip").textContent).toBe("Suggested size M");
    expect(screen.getByText(/Unvalidated prototype/)).toBeTruthy();
    expect(screen.getByText(/not a guarantee of fit/)).toBeTruthy();
    expect(sizeChipText(rec({ size: null, closest_size: "L" }))).toMatch(/Closest size L/);
    expect(sizeChipText(null)).toMatch(/tape measurement/);
  });

  it("opens the detailed page with More details, or scans again", () => {
    const onMore = vi.fn();
    const onRescan = vi.fn();
    render(<SimpleResults fit={fit} response={response()} onMore={onMore} onRescan={onRescan} />);
    fireEvent.click(screen.getByRole("button", { name: /More details/ }));
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    expect(onMore).toHaveBeenCalled();
    expect(onRescan).toHaveBeenCalled();
  });

  it("still shows the numbers when the views could not be fitted (no 3D hand)", () => {
    render(<SimpleResults fit={null} response={response()} onMore={() => {}} onRescan={() => {}} />);
    expect(screen.queryByRole("radiogroup", { name: "How to draw the model" })).toBeNull();
    expect(screen.getByTestId("hand-length").textContent).toBe("≈ 16.7 cm");
  });

  it("shows 'not measured' only for a finger with no number at all, and never invents one", () => {
    const r = response({ measurements: response().measurements.map((x) => (x.key === "ring_length_mm" ? m("ring_length_mm", null) : x)) });
    expect(simpleNumbers(r, "knuckle").fingers[3]).toMatchObject({ mm: null, veryUncertain: false });
    render(<SimpleResults fit={null} response={r} onMore={() => {}} onRescan={() => {}} />);
    expect(document.querySelector('[data-finger="ring_length_mm"]')?.textContent).toBe("Ringnot measured");
  });
});

describe("next steps, the thumb hint and Copy results on the page", () => {
  it("has a short numbered Next steps section between the card and More details, in plain words", () => {
    render(<SimpleResults fit={fit} response={response()} onMore={() => {}} onRescan={() => {}} />);
    const section = screen.getByRole("region", { name: "Next steps" });
    const items = [...section.querySelectorAll("ol li")].map((li) => li.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/^Your estimated size is M \(not a firm size\)/);
    expect(items[2]).toMatch(/Tap More details/);
    expect(section.compareDocumentPosition(screen.getByRole("button", { name: /More details/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("region", { name: "Your measurements" }).compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("thumb-hint")).toBeNull();
  });

  it("shows the thumb hint when the thumb was turned out of the palm plane in this scan", () => {
    const r = response({ measurements: response().measurements.map((x) => (x.key === "thumb_length_mm" ? { ...x, finger_tilt_deg: 41 } : x)) });
    render(<SimpleResults fit={fit} response={r} onMore={() => {}} onRescan={() => {}} />);
    expect(screen.getByTestId("thumb-hint").textContent).toMatch(/turned about 40° out of the palm plane.*Spread it flat and scan again/);
  });

  it("copies a summary and says Copied; when copying is impossible it shows the text to copy by hand", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SimpleResults fit={null} response={response()} onMore={() => {}} onRescan={() => {}} />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Copy results" })));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0][0])).toContain("Hand length: ≈ 16.7 cm");
    expect(screen.getByRole("status").textContent).toBe("Copied");
    cleanup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
    render(<SimpleResults fit={null} response={response()} onMore={() => {}} onRescan={() => {}} />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Copy results" })));
    expect(screen.getByRole("status").textContent).toMatch(/not available/);
    expect((screen.getByLabelText("Results summary") as HTMLTextAreaElement).value).toContain("Hand length");
  });
});
