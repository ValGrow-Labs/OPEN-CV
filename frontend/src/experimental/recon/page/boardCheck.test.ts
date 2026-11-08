// The board print check (ruler readings against the layout, the sheet checklist), the test-run details and the validity
// of a capture for the physical validation. Pure functions.
import { describe, expect, it } from "vitest";
import { BOARD, type BoardLayout } from "../../board/spec";
import type { BoardFlatness } from "../boardFlatness";
import { checklistMissing, EMPTY_CHECKLIST, expectedRuler, parseMm, REPRINT_WORDS, rulerCheck, type RulerReadings } from "./boardCheck";
import { EMPTY_RUN, runJson, runProblems, toggleCondition, type RunDetails } from "./runDetails";
import { validity, type ValidityInput } from "./validity";

const E = expectedRuler();
const exact: RulerReadings = { squareXmm: E.square_mm, squareYmm: E.square_mm, longSpanMm: E.long_span_mm, shortSpanMm: E.short_span_mm };

describe("ruler check", () => {
  it("computes the expected lengths from the layout (board v1: 30 mm squares, 7 x 30 + 6 x 10 = 270 mm, 2 x 30 + 10 = 70 mm)", () => {
    expect(E).toEqual({ square_mm: 30, long_span_mm: 270, short_span_mm: 70 });
    // and follows the layout when it changes (nothing typed in)
    const bigger: BoardLayout = { ...BOARD, markerMm: 32, markers: BOARD.markers.map((m) => ({ ...m })) };
    expect(expectedRuler(bigger).square_mm).toBe(32);
    expect(expectedRuler(bigger).long_span_mm).toBe(272);
  });

  it("passes readings at actual size, with ruler-sized deviations", () => {
    expect(rulerCheck(exact).verdict).toBe("pass");
    const r = rulerCheck({ squareXmm: 30.2, squareYmm: 29.8, longSpanMm: 270.5, shortSpanMm: 70.0 });
    expect(r.verdict).toBe("pass");
    expect(r.scaleX).toBeCloseTo(270.5 / 270, 6);
    expect(r.reasons[0]).toMatch(/within the provisional tolerance/);
  });

  it("asks for a reprint when the print was scaled ('fit to page', 97 %)", () => {
    const s = 0.97;
    const r = rulerCheck({ squareXmm: 30 * s, squareYmm: 30 * s, longSpanMm: 270 * s, shortSpanMm: 70 * s });
    expect(r.verdict).toBe("reprint");
    expect(r.reasons.join(" ")).toContain("square's width reads 29.1 mm");
    expect(r.reasons[r.reasons.length - 1]).toContain(REPRINT_WORDS);
  });

  it("catches a printer that scales one direction only (spans each within 0.5 %, but 0.8 % apart)", () => {
    const r = rulerCheck({ squareXmm: 30, squareYmm: 30, longSpanMm: 270 * 1.004, shortSpanMm: 70 * 0.996 });
    expect(r.verdict).toBe("reprint");
    expect(r.reasons[0]).toMatch(/scaled differently across and down/);
  });

  it("says 'not entered' until all four readings are there, and parses typed numbers", () => {
    expect(rulerCheck({ ...exact, shortSpanMm: null }).verdict).toBe("not_entered");
    expect(parseMm("29,8")).toBe(29.8);
    expect(parseMm(" 270 ")).toBe(270);
    for (const bad of ["", "abc", "-3", "0", "1e3", "30mm"]) expect(parseMm(bad)).toBeNull();
  });

  it("requires every checklist line unless the run tests that condition on purpose", () => {
    expect(checklistMissing(EMPTY_CHECKLIST, [])).toEqual(["matte", "flat", "noGlare"]);
    expect(checklistMissing({ matte: true, flat: false, noGlare: false }, ["board_curl", "glare"])).toEqual([]);
    expect(checklistMissing({ matte: false, flat: true, noGlare: true }, ["board_curl"])).toEqual(["matte"]);
  });
});

describe("test-run details", () => {
  const good: RunDetails = { phantomId: "PH01", sessionId: "S2026-11-08a", captureIndex: 3, operatorCode: "OP01", conditions: ["baseline"], notes: "first take" };

  it("accepts codes and refuses a plain name as the operator", () => {
    expect(runProblems(good)).toEqual([]);
    expect(runProblems({ ...good, operatorCode: "Alice" }).join(" ")).toMatch(/Never a name/);
    expect(runProblems({ ...good, operatorCode: "A" }).length).toBe(1);
    expect(runProblems(EMPTY_RUN).length).toBe(4); // phantom, session, operator, conditions
    expect(runProblems({ ...good, captureIndex: 0 }).join(" ")).toMatch(/Capture index/);
    expect(runProblems({ ...good, notes: "x".repeat(501) }).join(" ")).toMatch(/at most 500/);
  });

  it("keeps conditions in the listed order and writes the export's run object", () => {
    expect(toggleCondition(toggleCondition(["glare"], "baseline", true), "glare", false)).toEqual(["baseline"]);
    expect(toggleCondition(["low_light"], "glare", true)).toEqual(["glare", "low_light"]);
    expect(runJson(good)).toEqual({ phantom_id: "PH01", session_id: "S2026-11-08a", capture_index: 3, operator_code: "OP01", conditions: ["baseline"], notes: "first take" });
    expect(runJson(null)).toEqual({ phantom_id: null, session_id: null, capture_index: null, operator_code: null, conditions: [], notes: "" });
  });
});

describe("validity for validation", () => {
  const flat = (verdict: BoardFlatness["verdict"]) => ({ verdict }) as BoardFlatness;
  const base: ValidityInput = {
    validationMode: true,
    run: { phantomId: "PH01", sessionId: "S1", captureIndex: 1, operatorCode: "OP01", conditions: ["baseline"], notes: "" },
    ruler: rulerCheck(exact),
    checklist: { matte: true, flat: true, noGlare: true },
    flatness: flat("pass"),
    coin: { scaleWrong: false },
    refused: false,
    hasMeasurements: true,
  };

  it("is valid only when every condition is met", () => {
    expect(validity(base)).toEqual({ valid: true, reasons: [] });
    expect(validity({ ...base, flatness: flat("warn") }).valid).toBe(true);
  });

  it("names every reason a capture is not valid", () => {
    expect(validity({ ...base, flatness: flat("fail") }).reasons).toEqual(["The board is probably not flat in the pictures (curled, folded or lifted)."]);
    expect(validity({ ...base, flatness: flat("not_checked") }).valid).toBe(false);
    expect(validity({ ...base, ruler: rulerCheck({ ...exact, squareXmm: 29 }) }).reasons[0]).toMatch(/reprinted/);
    expect(validity({ ...base, ruler: null }).reasons[0]).toMatch(/not entered/);
    expect(validity({ ...base, checklist: { matte: false, flat: true, noGlare: true } }).reasons[0]).toMatch(/checklist is not complete \(printed on plain matte paper/);
    expect(validity({ ...base, coin: { scaleWrong: true } }).valid).toBe(false);
    expect(validity({ ...base, refused: true }).reasons).toContain("The reconstruction refused: nothing was measured.");
    expect(validity({ ...base, run: { ...base.run!, operatorCode: "Bob" } }).reasons[0]).toMatch(/test-run details are incomplete/);
    // outside validation mode the run details are not required
    expect(validity({ ...base, validationMode: false, run: null }).valid).toBe(true);
  });
});
