// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Recommendation, ScanResponse } from "../api/types";
import { calibrationParams as cal, captureParams as cap, goodFrame, publicConfig } from "../test/fixtures";
import { estimatedDistanceMm, evaluateFrame } from "../vision/liveChecks";
import { MeasurementsScreen } from "./MeasurementsScreen";
import { fingerBendDetail } from "../ui/format";
import { ResultsScreen } from "./ResultsScreen";
import { ScanScreen } from "./ScanScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("coin confirmation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  });

  it("asks which coin is used before requesting the camera", async () => {
    const getUserMedia = vi.fn(() => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })));
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    const onReferenceConfirm = vi.fn();
    render(
      <ScanScreen
        config={publicConfig()}
        chartId="demo-length-v1"
        reference={{ object_id: "us_quarter" }}
        showIntro={false}
        onCancel={() => {}}
        onResult={() => {}}
        onReferenceConfirm={onReferenceConfirm}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Which coin are you holding?" })).toBeTruthy();
    expect(screen.getByText("24.26 mm (0.955 in) across")).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Yes, this is my coin/ }));
    expect(onReferenceConfirm).toHaveBeenCalledWith({ object_id: "us_quarter" });
    await screen.findByRole("alert");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe("new live checks", () => {
  it("rejects a coin flagged as ambiguous", () => {
    const f = goodFrame();
    f.coin!.accepted = false;
    f.coin!.reasons = ["coin_ambiguous"];
    expect(evaluateFrame(f, null, cap, cal).codes).toContain("coin_ambiguous");
  });

  it("asks to move back when the coin implies a very close camera", () => {
    const f = goodFrame();
    const scale = { referenceDiameterMm: 24.26, assumedHfovDeg: [55, 80] as [number, number] };
    const d = estimatedDistanceMm(f.coin!.major_axis_px, 24.26, f.image_width, f.image_height, [55, 80]);
    expect(evaluateFrame(f, null, cap, cal, scale).codes).not.toContain("too_close");
    f.coin!.major_axis_px *= d / 200; // as if the hand were ~200 mm away
    f.coin!.minor_axis_px = f.coin!.major_axis_px;
    expect(evaluateFrame(f, null, cap, cal, scale).codes).toContain("too_close");
  });
});

const uncertainRec: Recommendation = {
  status: "needs_more_data",
  size: null,
  alternative_size: null,
  confidence_level: "uncertain",
  chart_id: "demo-length-v1",
  manufacturer: null,
  product_model: null,
  is_demo_chart: true,
  disclaimer: "DEMO",
  basis: ["hand length"],
  explanation: ["That is consistent with sizes S, M, L, so we can't recommend one size from this scan."],
  needed_measurements: ["hand_length_mm"],
  plausible_sizes: ["S", "M", "L"],
  by_measurement: [],
};

const accepted: ScanResponse = {
  status: "accepted",
  issues: [],
  calibration: null,
  measurements: [],
  proportions: {},
  frames_received: 24,
  frames_accepted: 24,
  frame_rejection_counts: {},
  landmarks_px_median: null,
  coin_median: null,
  image_width: 1280,
  image_height: 720,
  recommendation: uncertainRec,
  uncertainty_basis: "prior_assumptions",
  limitations: [],
};

describe("a scan refused because the hand is the wrong size for the selected coin", () => {
  const rejected: ScanResponse = {
    ...accepted,
    status: "rejected",
    recommendation: null,
    measurements: [],
    frames_received: 18,
    frames_accepted: 0,
    issues: [
      { code: "insufficient_frames", severity: "error", message: "Not enough good-quality frames were captured. Please scan again.", frames_affected: null },
      {
        code: "implausible_scale",
        severity: "error",
        message: "With the selected coin (Indian 2-rupee coin, 23.0 mm) your hand measured about 98 mm, which is too small (expected 120 to 240 mm). Check that the coin on your hand is the one you selected.",
        frames_affected: 8,
      },
    ],
  };
  const show = (onChangeCoin?: () => void, onRescan = () => {}) => {
    const cfg = publicConfig();
    return render(
      <MeasurementsScreen config={cfg} chart={cfg.charts[0]} result={rejected} mirrored={false} onRescan={onRescan} onChangeCoin={onChangeCoin} onContinue={() => {}} busy={false} error={null} />,
    );
  };

  it("says what was measured, and drops the generic line that only repeats the problem", () => {
    show(() => {});
    expect(screen.getByText(/your hand measured about 98 mm, which is too small/)).toBeTruthy();
    expect(screen.queryByText(/Not enough good-quality frames/)).toBeNull();
  });

  it("offers 'Choose my coin again' first, and still 'Scan again'", () => {
    const changeCoin = vi.fn();
    const rescan = vi.fn();
    show(changeCoin, rescan);
    fireEvent.click(screen.getByRole("button", { name: "Choose my coin again" }));
    expect(changeCoin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it("keeps the generic line when nothing explains the refusal, and only 'Scan again'", () => {
    const cfg = publicConfig();
    const plain = { ...rejected, issues: [rejected.issues[0]] };
    render(<MeasurementsScreen config={cfg} chart={cfg.charts[0]} result={plain} mirrored={false} onRescan={() => {}} onChangeCoin={() => {}} onContinue={() => {}} busy={false} error={null} />);
    expect(screen.getByText(/Not enough good-quality frames/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Choose my coin again" })).toBeNull();
  });
});

describe("a hand the camera cannot measure still gets a size (every hand has to work)", () => {
  const refused: ScanResponse = {
    ...accepted,
    status: "rejected",
    recommendation: null,
    measurements: [],
    frames_received: 18,
    frames_accepted: 0,
    issues: [{ code: "fingers_bent", severity: "error", message: "Straighten your fingers and keep them flat.", frames_affected: 18 }],
  };
  const open = (onContinue = vi.fn()) => {
    const cfg = publicConfig();
    render(
      <MeasurementsScreen config={cfg} chart={cfg.charts[0]} result={refused} mirrored={false} onRescan={() => {}} onContinue={onContinue} busy={false} error={null} />,
    );
    return onContinue;
  };

  it("offers a tape measurement right under the reasons, with no second 'Rescan' button", () => {
    open();
    expect(screen.getByText("Or measure with a tape instead")).toBeTruthy();
    expect(screen.getByText(/a finger that cannot be straightened, a bandage, a very small or very large hand/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /See my size/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rescan" })).toBeNull();
    expect(screen.getByRole("button", { name: "Scan again" })).toBeTruthy();
  });

  it.each([
    ["a small child's hand (3.0 in)", "3.0", 76.2],
    ["an average hand (7.0 in)", "7.0", 177.8],
    ["a very large hand (11.0 in)", "11.0", 279.4],
  ])("takes %s", (_label, typed, mm) => {
    const onContinue = open();
    fireEvent.change(screen.getByLabelText("Hand length"), { target: { value: typed } });
    fireEvent.click(screen.getByRole("button", { name: /See my size/ }));
    expect(onContinue).toHaveBeenCalledWith({ hand_length_mm: expect.closeTo(mm, 1) });
  });

  it("still refuses a typing slip, using the configured range", () => {
    const onContinue = open();
    fireEvent.change(screen.getByLabelText("Hand length"), { target: { value: "25" } }); // 25 in
    expect(screen.getByText(/Enter a value between 2\.4 and 11\.8 in \(60-300 mm\)/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /See my size/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("the results say the size comes from the tape, not from camera frames", () => {
    const rec: Recommendation = { ...uncertainRec, status: "recommended", size: "S", confidence_level: "likely", plausible_sizes: ["S"], by_measurement: [] };
    const { container } = render(<ResultsScreen recommendation={rec} result={refused} extraMeasurements={[]} onRescan={() => {}} onBack={() => {}} onStartOver={() => {}} />);
    expect(screen.getByText("Based on the tape measurement you entered.")).toBeTruthy();
    expect(screen.queryByText(/camera frames that passed every quality check/)).toBeNull();
    expect(container.textContent).not.toContain("Scan evidence");
  });
});

describe("uncertain recommendations", () => {
  it("offers a tape measurement of hand length and converts inches to mm", () => {
    const cfg = publicConfig();
    const onContinue = vi.fn();
    render(
      <MeasurementsScreen config={cfg} chart={cfg.charts[0]} result={accepted} mirrored={false} onRescan={() => {}} onContinue={onContinue} busy={false} error={null} />,
    );
    expect(screen.getByText(/sizes S, M, L are all possible/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Hand length"), { target: { value: "7.25" } });
    fireEvent.click(screen.getByRole("button", { name: /See my size/ }));
    expect(onContinue).toHaveBeenCalledWith({ hand_length_mm: expect.closeTo(184.15, 2) });
  });

  it("mentions the closest size on the tape-measurement card", () => {
    const cfg = publicConfig();
    const result = { ...accepted, recommendation: { ...uncertainRec, plausible_sizes: ["XS", "S", "M", "L"], closest_size: "S", closest_alternative: "M" } };
    render(
      <MeasurementsScreen config={cfg} chart={cfg.charts[0]} result={result} mirrored={false} onRescan={() => {}} onContinue={() => {}} busy={false} error={null} />,
    );
    expect(screen.getByText(/sizes XS, S, M, L are all possible/)).toBeTruthy();
    expect(screen.getByText(/Your reading is closest to size S\./)).toBeTruthy();
  });

  it("shows the measured bend of a finger that was refused as not straight", () => {
    const bends = { index: { bend_2d_deg: 12.4, bend_3d_deg: 63.2, limit_2d_deg: 30, limit_3d_deg: 60 } };
    expect(fingerBendDetail(bends, "index_length_mm", ["finger_bent"])).toBe(
      "Measured bend: 12° in the image (limit 30°), 63° in the depth estimate (limit 60°).",
    );
    expect(fingerBendDetail(bends, "index_length_mm", [])).toBeUndefined(); // only for a refused finger
    expect(fingerBendDetail(bends, "thumb_length_mm", ["finger_bent"])).toBeUndefined();
    expect(fingerBendDetail(undefined, "index_length_mm", ["finger_bent"])).toBeUndefined();
  });

  it("says which size the camera reading is closest to, without recommending it", () => {
    const rec: Recommendation = {
      ...uncertainRec,
      plausible_sizes: ["XS", "S", "M", "L"],
      closest_size: "S",
      closest_alternative: "M",
      by_measurement: [{ key: "hand_length_mm", value_mm: 174, uncertainty_mm: 7.7, size: "S", plausible_sizes: ["XS", "S", "M", "L"] }],
    };
    const { container } = render(
      <ResultsScreen recommendation={rec} result={accepted} extraMeasurements={[]} onRescan={() => {}} onBack={() => {}} onStartOver={() => {}} />,
    );
    expect(container.querySelector(".size-plate .size")!.textContent).toBe("S");
    expect(container.querySelector(".size-plate-or")!.textContent).toBe("or M");
    expect(screen.getByText("Most likely size")).toBeTruthy();
    expect(screen.getByText(/but could also be XS, M, L/).textContent).toMatch(/A tape measurement would settle it\./);
    expect(container.querySelector(".size-tile")).toBeNull(); // still no *recommended* size
    expect(screen.queryByText("Recommended size")).toBeNull();
    expect(screen.getByText("More information needed")).toBeTruthy();
    expect(screen.getByLabelText("Sizes that are still possible").textContent).toMatch(/XS.*S.*M.*L/);
  });

  it("shows no size, the still-possible sizes and a way to add a measurement", () => {
    const { container } = render(
      <ResultsScreen recommendation={uncertainRec} result={accepted} extraMeasurements={[]} onRescan={() => {}} onBack={() => {}} onStartOver={() => {}} />,
    );
    expect(screen.getByText("More information needed")).toBeTruthy();
    expect(container.querySelector(".size-tile")).toBeNull();
    expect(screen.getByLabelText("Sizes that are still possible").textContent).toMatch(/S.*M.*L/);
    expect(screen.getByRole("button", { name: "Add a tape measurement" })).toBeTruthy();
  });
});
