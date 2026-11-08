// Measurement and basis formatting, reason wording, calibration, coin and per-view words of the EXPERIMENTAL board page.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REFUSAL_WORDS } from "../chain";
import { calibrationView, coinView, formatValue, measurementRows, MAX_PRINT_SCALE_ERROR, NOT_FROM_BOARD_WORDS, PRINT_SCALE_WARNING, reasonDetail, reasonWords, REASON_WORDS, refusalWords, RESULT_CAPTION, UPPER_BOUND_WORDS, viewRows } from "./format";
import { fakeCaptures, fakeMeasurements, fakeOutcome, rawMeasurements } from "./testFixtures";

const ROOT = resolve(__dirname, "../..");

describe("reason words", () => {
  it("words every reason code the reconstruction can give", () => {
    // the codes as the code pushes them: quality.ts gates and multiview/reconstruct.ts
    const src = readFileSync(resolve(ROOT, "reconstruction/quality.ts"), "utf8") + readFileSync(resolve(ROOT, "multiview/reconstruct.ts"), "utf8");
    const codes = new Set<string>();
    for (const m of src.matchAll(/reasons\.push\(([^)]*)\)/g)) for (const c of m[1].matchAll(/"([a-z_]+)"/g)) codes.add(c[1]);
    expect([...codes].sort()).toEqual(
      [
        "fragmented_mesh",
        "hand_frame_from_one_view",
        "hull_truncated_by_volume",
        "mesh_not_watertight",
        "no_hand_frame",
        "reprojection_mismatch",
        "sides_not_observed",
        "surface_not_constrained",
        "surface_poorly_observed",
        "too_few_views",
        "views_disagree",
        "views_disagree_broadly",
        "views_do_not_surround_hand",
      ].sort(),
    );
    for (const c of codes) {
      expect(REASON_WORDS[c], c).toBeTruthy();
      expect(reasonWords(c)).not.toContain("_");
    }
  });

  it("passes a failure sentence through and names an unknown code plainly", () => {
    expect(reasonWords("the silhouettes have no common volume (cameras or masks inconsistent)")).toBe("The silhouettes have no common volume (cameras or masks inconsistent).");
    expect(reasonWords("brand_new_gate")).toBe("Unexplained reason: brand_new_gate.");
  });

  it("adds the measured value behind a gate", () => {
    const q = fakeOutcome().chain.reconstruction!.quality;
    expect(reasonDetail("sides_not_observed", q)).toBe("Lowest view 33.2° above the hand's plane (limit 20°).");
    expect(reasonDetail("reprojection_mismatch", q)).toBe("Outline overlap: mean 0.950 (needs 0.9), worst 0.900 (needs 0.8).");
    expect(reasonDetail("views_disagree", q)).toBeNull();
    expect(reasonDetail("sides_not_observed", null)).toBeNull();
  });

  it("shows a refusal in the chain's own words", () => {
    for (const code of Object.keys(REFUSAL_WORDS) as (keyof typeof REFUSAL_WORDS)[]) expect(refusalWords(code, null)).toBe(REFUSAL_WORDS[code]);
    expect(refusalWords(null, null)).toBeNull();
  });

  it("never calls the result validated or accurate", () => {
    const all = [...Object.values(REASON_WORDS), RESULT_CAPTION(14), PRINT_SCALE_WARNING].join(" ").toLowerCase();
    expect(all).not.toMatch(/\baccurate\b|\bvalidated\b(?! against)/);
    expect(RESULT_CAPTION(14)).toBe(
      "EXPERIMENTAL: a visual-hull reconstruction from 14 photos. The palm side rests on the board and is not observed. Not validated against physical measurements.",
    );
  });

  it("keeps the page's own words free of claims", () => {
    const dir = resolve(__dirname);
    const text = readdirSync(dir)
      .filter((f) => /\.(tsx?)$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
      .map((f) => readFileSync(resolve(dir, f), "utf8"))
      .join("\n")
      .toLowerCase();
    expect(text).not.toMatch(/\b(is|are) (accurate|validated)\b|\bclinically\b|\bprecise measurement\b/);
  });
});

describe("measurements", () => {
  it("formats values with their unit and never shows a number for a missing value", () => {
    const m = fakeMeasurements();
    expect(formatValue(m.handLength)).toBe("187.4 mm");
    expect(formatValue(rawMeasurements().surfaceArea)).toBe("46,123 mm²");
    expect(formatValue(m.surfaceArea)).toBe("not available"); // a board capture gives no hand surface area
    expect(formatValue(m.circumferenceKnuckle)).toBe("214.6 mm");
    expect(formatValue({ value: 12, unit: "mm", basis: "none", note: "" })).toBe("not available");
    expect(formatValue(null)).toBe("not available");
  });

  it("lists the ten rows with the basis in words", () => {
    const rows = measurementRows(fakeMeasurements(), { missingNote: "x" });
    expect(rows.map((r) => r.key)).toEqual(["handLength", "palmBreadth", "palmThickness", "circumferenceKnuckle", "thumb", "index", "middle", "ring", "little", "surfaceArea"]);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.handLength).toMatchObject({ value: "187.4 mm", shown: true, basis: expect.stringMatching(/^model: /) });
    // a board capture: no hand surface area (said in the table, not only behind "why"), the circumference an upper bound
    expect(by.surfaceArea).toMatchObject({ label: "Hand surface area", value: "not available", shown: false, basis: "not available", bound: null, flag: NOT_FROM_BOARD_WORDS });
    expect(by.circumferenceKnuckle).toMatchObject({ value: "214.6 mm", shown: true, bound: "upper", flag: UPPER_BOUND_WORDS });
    expect(by.circumferenceKnuckle.basis).toMatch(/^model: /);
    expect(by.circumferenceKnuckle.note).toMatch(/^UPPER BOUND/);
    expect(by.handLength).toMatchObject({ bound: null, flag: null });
    expect(UPPER_BOUND_WORDS).toMatch(/^UPPER BOUND: .*at most this value/);
  });

  it("says 'not available' everywhere without measurements (no hand frame)", () => {
    const rows = measurementRows(null, { missingNote: "no hand frame: no (or too few) triangulated landmarks" });
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(r.value).toBe("not available");
      expect(r.shown).toBe(false);
      expect(r.note).toBe("");
      expect(r.value).not.toMatch(/\d/);
    }
  });

  it("withholds every number when the print scale is wrong", () => {
    const rows = measurementRows(fakeMeasurements(), { missingNote: "x", withheld: "Withheld: wrong print scale" });
    for (const r of rows) {
      expect(r.value).not.toMatch(/\d/);
      expect(r.shown).toBe(false);
    }
    expect(rows.find((r) => r.key === "handLength")).toMatchObject({ value: "withheld", note: "Withheld: wrong print scale" });
    expect(rows.find((r) => r.key === "surfaceArea")?.value).toBe("not available");
    expect(rows.find((r) => r.key === "circumferenceKnuckle")).toMatchObject({ value: "withheld", bound: "upper" });
  });
});

describe("calibration and coin", () => {
  it("describes a self-calibration", () => {
    const v = calibrationView(fakeOutcome().chain.cameras!.calibration);
    expect(v).toMatchObject({ assumed: false, focalPx: "1023.2 px", k1: "-0.0635", rmsPx: "0.78 px" });
    expect(v.method).toMatch(/self-calibration/);
    expect(v.focalStd).toMatch(/^± 1\.1 px \(0\.11 %/);
  });

  it("warns when the focal length is assumed", () => {
    const v = calibrationView({ ok: true, method: "assumed_hfov", assumed: true, intrinsics: { fx: 958, fy: 958, cx: 640, cy: 360, width: 1280, height: 720 }, hfovDeg: 67.5, focalRangePx: [880, 1050], reason: "views too similar", closedFormFocalPx: null, degeneracy: null });
    expect(v.assumed).toBe(true);
    expect(v.method).toMatch(/^ASSUMED/);
    expect(v.warnings.join(" ")).toMatch(/assumed \(views too similar\)/);
  });

  it("accepts a print within 2 % and withholds beyond it", () => {
    const ok = coinView({ ok: true, viewId: "v01", referenceDiameterMm: 23, thicknessMm: null, diameterMm: 23.1, printScale: 23 / 23.1 }, "Indian 2-rupee coin");
    expect(ok).toMatchObject({ checked: true, scaleWrong: false });
    expect(ok.printScale).toBe("99.6 % (-0.4 %)");
    // printed at 97 % ("fit to page"): the 23 mm coin spans 23 / 0.97 = 23.7 board mm, so reference / measured = 0.97
    const scale = 1 - MAX_PRINT_SCALE_ERROR - 0.01;
    const bad = coinView({ ok: true, viewId: "v01", referenceDiameterMm: 23, thicknessMm: null, diameterMm: 23 / scale, printScale: scale }, "Indian 2-rupee coin");
    expect(bad.scaleWrong).toBe(true);
    expect(bad.words).toContain("The board was probably not printed at 100 %; every millimetre is scaled wrongly.");
  });

  it("says so when the coin could not be measured", () => {
    const v = coinView({ ok: false, viewId: "v01", referenceDiameterMm: 23, thicknessMm: null, reason: "view_too_oblique", detail: "x" }, "coin");
    expect(v).toMatchObject({ checked: false, scaleWrong: false, printScale: null });
    expect(v.words).toMatch(/too low to measure the coin.*30\.0 mm with a ruler/);
    expect(coinView(null, "coin").words).toMatch(/No coin entry/);
  });
});

describe("per-view table", () => {
  it("reports markers, angles, use and the hand-moved check per view", () => {
    const caps = fakeCaptures();
    const rows = viewRows(caps, fakeOutcome(), (c) => c.bin);
    expect(rows[0]).toMatchObject({ id: caps[0].id, markers: "10", elevation: "88.5°", used: "used (outline overlap 0.951)", handMoved: "agrees (median 1.2 px)" });
    expect(rows[1].markers).toBe("10 (+1 misread)");
    expect(rows[1].used).toMatch(/^not used: named by the hand-moved check/);
    expect(rows[1].handMoved).toMatch(/^disagrees: the hand may have moved/);
    expect(rows[2]).toMatchObject({ used: "not used: only 2 consistent marker(s) (needs 3)", landmarks: "none found", handMoved: "not checked (no landmarks)", elevation: "12° live" });
  });

  it("before a build, and after a refusal", () => {
    const caps = fakeCaptures();
    expect(viewRows(caps, null, (c) => c.bin)[0].used).toBe("not built yet");
    expect(viewRows(caps, fakeOutcome({ refused: true }), (c) => c.bin)[0].used).toBe("has a pose; nothing reconstructed (refused)");
  });
});
