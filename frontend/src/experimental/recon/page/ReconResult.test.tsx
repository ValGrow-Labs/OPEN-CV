// @vitest-environment jsdom
// The result display of the EXPERIMENTAL board reconstruction (jsdom, the three.js scene stubbed): a refusal in its words
// with no mesh and no numbers; "not available" shown as such; withheld numbers for a wrongly scaled print; reasons in words.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconResult, type ReconResultProps } from "./ReconResult";
import { boardFlatness, flatnessOfCameras } from "../boardFlatness";
import { rulerCheck } from "./boardCheck";
import { fakeCaptures, fakeOutcome } from "./testFixtures";

vi.mock("../../reconstruction/MeshViewer", () => ({
  MeshViewer: (p: { label?: string }) => <div data-testid="mesh-viewer">{p.label}</div>,
}));

afterEach(cleanup);

const props = (patch: Partial<ReconResultProps> = {}): ReconResultProps => ({
  outcome: fakeOutcome(),
  error: null,
  captures: fakeCaptures(),
  coinLabel: "Indian 2-rupee coin, 2019 series (silver)",
  binText: (c) => c.bin,
  wallMs: 5200,
  heap: { before: 40, after: 120 },
  includePhotos: false,
  onIncludePhotos: vi.fn(),
  onExport: vi.fn(),
  exportInfo: null,
  photosLost: false,
  onBack: vi.fn(),
  onStartOver: vi.fn(),
  ...patch,
});

describe("ReconResult", () => {
  it("shows a refusal in its words, with no viewer and no measurement numbers", () => {
    render(<ReconResult {...props({ outcome: fakeOutcome({ refused: true }) })} />);
    const verdict = screen.getByTestId("recon-verdict");
    expect(verdict.dataset.kind).toBe("refused");
    expect(verdict.textContent).toContain("Refused: no 3D hand and no measurements");
    expect(verdict.textContent).toContain("focal length could not be measured from these pictures");
    expect(screen.queryByTestId("mesh-viewer")).toBeNull();
    expect(screen.queryByTestId("recon-measurements")).toBeNull();
    // the calibration and the views are still reported
    expect(screen.getByTestId("calibration")).toBeTruthy();
    expect(screen.getByTestId("view-table").textContent).toContain("nothing reconstructed (refused)");
  });

  it("shows the viewer with the honest caption, the measurements with their basis and 'not available'", () => {
    render(<ReconResult {...props()} />);
    expect(screen.getByTestId("mesh-viewer").textContent).toBe(
      "EXPERIMENTAL: a visual-hull reconstruction from 1 photo. The palm side rests on the board and is not observed. Not validated against physical measurements.",
    );
    const table = screen.getByTestId("recon-measurements");
    const row = (key: string) => table.querySelector(`tr[data-key="${key}"]`) as HTMLElement;
    expect(within(row("handLength")).getByText("187.4 mm")).toBeTruthy();
    expect(row("handLength").textContent).toMatch(/model: /);
    expect(row("circumferenceKnuckle").textContent).toContain("214.6 mm");
    expect(row("circumferenceKnuckle").querySelector(".rc-bound")?.textContent).toBe("upper bound");
    expect(row("circumferenceKnuckle").textContent).toContain("UPPER BOUND: the palm side of this loop is the board plane");
    expect(row("surfaceArea").dataset.shown).toBe("0");
    expect(row("surfaceArea").textContent).toContain("not available");
    expect(row("surfaceArea").textContent).toContain("Not available from a board capture");
    expect(screen.getByTestId("coin-check").textContent).toContain("99.6 %");
    expect(screen.getByTestId("calibration").textContent).toContain("1023.2 px");
    expect(screen.getByTestId("timings").textContent).toMatch(/observed .*25\.0 %/);
  });

  it("words every quality reason when the checks fail", () => {
    render(<ReconResult {...props({ outcome: fakeOutcome({ accepted: false }) })} />);
    expect(screen.getByTestId("recon-verdict").dataset.kind).toBe("rejected");
    const items = screen.getByTestId("recon-reasons").querySelectorAll("li");
    expect([...items].map((li) => li.dataset.code)).toEqual(["sides_not_observed", "views_disagree"]);
    expect(items[0].textContent).toMatch(/thickness is not bounded.*Lowest view 33\.2°/);
    expect(screen.getByTestId("recon-reasons").textContent).not.toContain("_");
  });

  it("shows every measurement as not available without a hand frame", () => {
    render(<ReconResult {...props({ outcome: fakeOutcome({ measurements: false }) })} />);
    const cells = screen.getByTestId("recon-measurements").querySelectorAll("tbody td:first-of-type");
    expect(cells).toHaveLength(10);
    for (const c of cells) expect(c.textContent).toBe("not available");
  });

  it("withholds the numbers and warns when the print scale is off by more than 2 %", () => {
    const coin = { ok: true, viewId: "v01-top", referenceDiameterMm: 23, thicknessMm: null, diameterMm: 23.9, printScale: 23 / 23.9 };
    render(<ReconResult {...props({ outcome: fakeOutcome({ coin }) })} />);
    expect(screen.getByTestId("print-scale-warning").textContent).toContain("The board was probably not printed at 100 %; every millimetre is scaled wrongly.");
    const table = screen.getByTestId("recon-measurements");
    for (const td of table.querySelectorAll("tbody td:first-of-type")) expect(td.textContent).not.toMatch(/\d/);
    expect(table.textContent).toContain("withheld");
  });

  it("exports without photos unless the box is ticked", () => {
    const p = props();
    render(<ReconResult {...p} />);
    const box = screen.getByTestId("include-photos") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(p.onIncludePhotos).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("export-zip"));
    expect(p.onExport).toHaveBeenCalled();
  });

  it("shows an error from the worker", () => {
    render(<ReconResult {...props({ outcome: null, error: "out of memory" })} />);
    expect(screen.getByTestId("recon-verdict").textContent).toContain("out of memory");
    expect(screen.queryByTestId("recon-measurements")).toBeNull();
  });

  it("marks the measurements 'not valid for validation' when the board is not flat, and keeps them visible", () => {
    const bent = Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 9, 10, 11].map((i) => [i, 2.4]));
    const views = ["a", "b", "c"].map((id) => ({ id, hasPose: true, markerResiduals: Object.entries(bent).map(([k, v]) => ({ id: Number(k), rmsPx: v, used: true })) }));
    const flatness = boardFlatness(views, { imageLongSidePx: 1280 });
    expect(flatness.verdict).toBe("fail");
    render(<ReconResult {...props({ flatness })} />);
    expect(screen.getByTestId("not-valid-warning").textContent).toMatch(/^Not valid for validation: the board is probably not flat/);
    const table = screen.getByTestId("recon-measurements").querySelector("table")!;
    expect(table.dataset.valid).toBe("0");
    expect(table.querySelector('tr[data-key="handLength"]')!.textContent).toContain("187.4 mm"); // still shown
    expect(table.querySelector('tr[data-key="handLength"] .rc-invalid-tag')?.textContent).toBe("not valid");
    expect(screen.getByTestId("flatness").dataset.verdict).toBe("fail");
    expect(screen.getByTestId("flatness").textContent).toMatch(/not flat \(curled, folded or lifted\)/);
  });

  it("in validation mode shows the ruler check, the flatness and every reason the capture is not valid", () => {
    const outcome = fakeOutcome();
    const flatness = flatnessOfCameras(outcome.chain.cameras); // 2 views with a pose: not checked
    const ruler = rulerCheck({ squareXmm: 30, squareYmm: 30, longSpanMm: 270, shortSpanMm: 70 });
    render(<ReconResult {...props({ outcome, validationMode: true, ruler, flatness, valid: { valid: false, reasons: ["The board's flatness could not be checked from the pictures."] } })} />);
    expect(screen.getByTestId("validity").dataset.valid).toBe("0");
    expect(screen.getByTestId("validity").textContent).toContain("flatness could not be checked");
    expect(screen.getByTestId("result-ruler").textContent).toMatch(/^Pass: printed at actual size \(across 100\.00 %, down 100\.00 %\)/);
    expect(screen.getByTestId("flatness").dataset.verdict).toBe("not_checked");
    expect(screen.getByTestId("not-valid-warning")).toBeTruthy();
  });

  it("does not mark a valid capture", () => {
    render(<ReconResult {...props({ validationMode: true, valid: { valid: true, reasons: [] } })} />);
    expect(screen.queryByTestId("not-valid-warning")).toBeNull();
    expect(screen.getByTestId("validity").textContent).toMatch(/^Valid for validation \(conditions met; not a claim of accuracy\)/);
  });
});
