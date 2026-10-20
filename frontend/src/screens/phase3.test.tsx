// @vitest-environment jsdom
// Pilot-study validation screen and helpers. All summaries and records below are SYNTHETIC
// test fixtures; none of them is a real measurement.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchValidationRecords, setOperatorToken, submitValidationScan } from "../api/client";
import type { ValidationSummary } from "../api/types";
import { publicConfig } from "../test/fixtures";
import { newParticipantCode, referenceCheck, toMm } from "../ui/pilot";
import { ValidationScreen } from "./ValidationScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setOperatorToken(null);
});

describe("pilot helpers", () => {
  it("converts units explicitly", () => {
    expect(toMm(7.25, "in")).toBeCloseTo(184.15, 6);
    expect(toMm(18.4, "cm")).toBeCloseTo(184, 6);
    expect(toMm(184, "mm")).toBe(184);
  });

  it.each([
    [[184], "single_reading", 184],
    [[184, 186], "agreed", 185],
    [[184, 187], "discrepant", 185.5],
    [[184, 189, 188], "agreed", 188],
    [[180, 184, 188], "discrepant", 184],
  ] as const)("applies the repeat rule to %j", (readings, reliability, value) => {
    expect(referenceCheck([...readings], 2)).toEqual(expect.objectContaining({ reliability, valueMm: value }));
  });

  it("generates random, non-identifying participant codes", () => {
    const codes = new Set(Array.from({ length: 50 }, newParticipantCode));
    expect(codes.size).toBe(50);
    for (const c of codes) expect(c).toMatch(/^P-[A-HJ-NP-Z2-9]{6}$/);
  });
});

const summary: ValidationSummary = {
  config_fingerprint: "abc123def456",
  calibration: { status: "uncalibrated", validated: false },
  real_world: {
    label: "Real participants, physical reference measurements",
    participants: 2,
    hands: 2,
    scans: { total: 5, accepted: 4, rejected: 1, rejected_pct: 20, rejection_reasons: { coin_not_found: 1 }, accepted_without_estimate: 0 },
    references: { agreed: 5 },
    accuracy: {
      measurement: "hand_length_mm",
      scope: "standard-condition scans",
      by_scan: {
        n: 3,
        mean_signed_error_mm: -1.25,
        mae_mm: 3.25,
        rmse_mm: 3.4,
        median_abs_error_mm: 3,
        max_abs_error_mm: 4,
        error_sd_mm: 4.1,
        histogram: { bin_edges_mm: [-4, -2, 0, 2, 4], counts: [1, 0, 0, 2], below: 0, above: 0 },
        errors_mm: [-4, 2.5, 3.25],
      },
      by_hand: { n: 2, mean_signed_error_mm: -0.5, mae_mm: 3, rmse_mm: 3.1, median_abs_error_mm: 3, max_abs_error_mm: 4 },
      n_hands: 2,
      within_reported_95_interval: { count: 3, of: 3 },
      sample_note: "Only 2 hand(s): read the individual results.",
    },
    conditions: {},
    by_reference_source: {
      operator: { scans: 5, hands_scored: 2, by_hand: { n: 2, mae_mm: 3 } },
      participant: { scans: 0, hands_scored: 0, by_hand: { n: 0 } },
    },
    by_participant: [
      {
        participant_code: "P-AAAAAA",
        hand: "right",
        reference_mm: 185,
        reference_reliability: "agreed",
        scans: 3,
        rejected: 1,
        standard_scored: 2,
        standard_mean_signed_error_mm: 3,
        standard_mae_mm: 3,
        standard_error_range_mm: [2, 4],
        other_conditions_scored: 0,
        other_conditions_mean_signed_error_mm: null,
      },
    ],
    by_distance: {
      scope: "all conditions",
      min_hands_per_band: 3,
      operator_measured: {
        rows: [
          { band: "30-40 cm", scans: 4, rejected: 0, scans_scored: 4, hands_scored: 3, mean_signed_error_mm: 0.67, mae_mm: 2, sufficient: true },
          { band: "50 cm and over", scans: 1, rejected: 0, scans_scored: 1, hands_scored: 1, mean_signed_error_mm: 6, mae_mm: 6, sufficient: false },
        ],
        without_distance: 0,
        note: "Measured by the operator.",
      },
      coin_implied: { rows: [], without_distance: 5, note: "Assumed field of view." },
    },
    repeatability: {
      hands_with_repeats: 1,
      within_hand_sd_mm: 0.71,
      repeatability_coefficient_mm: 1.96,
      per_hand: [],
      condition_shifts: { distance_far: { n_hands: 1, mean_shift_mm: 2.5, max_abs_shift_mm: 2.5, exceeds_repeatability: true } },
      note: "Repeatability is not accuracy: the same wrong value can be repeated consistently.",
    },
  },
  excluded: { software_test: 4, unreadable_lines: 0 },
  record_flags: {},
};

const enabled = (over = {}) => publicConfig({ validation_mode_enabled: true, ...over });
const okFetch = () => vi.fn().mockResolvedValue(new Response(JSON.stringify({ records: [], summary }), { status: 200 }));

describe("validation screen", () => {
  it("is unavailable unless the server enables it", () => {
    render(<ValidationScreen config={publicConfig()} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onClose={() => {}} />);
    expect(screen.getByText("Validation mode is off")).toBeTruthy();
  });

  it("shows server-computed real-participant results with the sample caveat", async () => {
    vi.stubGlobal("fetch", okFetch());
    render(<ValidationScreen config={enabled()} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("3.25")).toBeTruthy());
    expect(screen.getByText("-1.25")).toBeTruthy();
    expect(screen.getByText(/Only 2 hand\(s\)/)).toBeTruthy();
    expect(screen.getByText(/software test 4/)).toBeTruthy();
    expect(screen.getByText(/5 \(4 passed, 1 rejected, 20%\)/)).toBeTruthy();
    expect(screen.getByText(/Repeatability is not accuracy/)).toBeTruthy();
    expect(screen.getByText(/uncalibrated, not validated/)).toBeTruthy();
    // Per-participant and distance tables.
    const perParticipant = screen.getByRole("table", { name: "Errors per participant" });
    expect(perParticipant.textContent).toMatch(/P-AAAAAA.*right.*3.*1.*2.*\+3\.00.*3\.00.*\+2\.0 to \+4\.0/);
    const distance = screen.getByRole("table", { name: "Operator-measured distance" });
    expect(distance.textContent).toContain("+0.67");
    // A band with too few hands shows no error figure.
    expect(distance.textContent).toContain("too few hands");
    expect(distance.textContent).not.toContain("+6.00");
  });

  it("only allows a real-participant scan with consent, a hand and agreeing readings", async () => {
    vi.stubGlobal("fetch", okFetch());
    render(<ValidationScreen config={enabled()} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onClose={() => {}} />);
    const scan = screen.getByRole("button", { name: "Scan and record" }) as HTMLButtonElement;
    expect(scan.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Real participant/));
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect((screen.getByLabelText("Participant code") as HTMLInputElement).value).toMatch(/^P-/);
    fireEvent.click(screen.getByLabelText("Right"));
    fireEvent.change(screen.getByLabelText("Device and camera"), { target: { value: "Laptop webcam" } });
    fireEvent.change(screen.getByLabelText("Reading 1"), { target: { value: "184" } });
    expect(screen.getByText(/Take a second reading/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reading 2"), { target: { value: "187" } });
    expect(screen.getByText(/Readings differ by 3.0 mm/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reading 3"), { target: { value: "186.5" } });
    expect(screen.getByText(/Readings agree/)).toBeTruthy();
    expect(scan.disabled).toBe(true); // consent still missing
    expect(screen.getByText(/Still needed: the participant's consent/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Participant consented/));
    expect(scan.disabled).toBe(false);
  });

  it("flags a reading entered in the wrong unit", () => {
    vi.stubGlobal("fetch", okFetch());
    render(<ValidationScreen config={enabled()} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Reading 1"), { target: { value: "7.25" } });
    expect(screen.getByText(/outside 100-260 mm/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "in" } });
    expect(screen.queryByText(/outside 100-260 mm/)).toBeNull();
  });

  it("asks for the operator token before loading records in token mode", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ValidationScreen config={enabled({ operator_access: "token" })} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onClose={() => {}} />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Operator token"), { target: { value: "secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Use token" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
  });
});

describe("validation client", () => {
  it("sends the operator header and surfaces the server's validation message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ records: [], summary }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: [{ loc: ["body"], msg: "Value error, check the value and the unit", type: "value_error" }] }), {
          status: 422,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await fetchValidationRecords();
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>)["X-Glovesize-Operator"]).toBe("1");
    const err = await submitValidationScan({} as never).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("check the value and the unit");
  });
});

describe("blinded session", () => {
  afterEach(() => window.sessionStorage.clear());

  it("hides estimates, errors and results from the scan operator", async () => {
    vi.stubGlobal("fetch", okFetch());
    render(<ValidationScreen config={enabled()} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("3.25")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/Blinded session/));
    expect(screen.queryByText("3.25")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
    expect(screen.getAllByText("Hidden during a blinded session.")).toHaveLength(2);
    expect(window.sessionStorage.getItem("glovesize.validationBlind.v1")).toBe("1");
  });

  it("defaults the reference tool to calipers", () => {
    vi.stubGlobal("fetch", okFetch());
    render(<ValidationScreen config={enabled()} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onClose={() => {}} />);
    expect((screen.getByLabelText("Tool") as HTMLSelectElement).value).toBe("calipers");
  });
});
