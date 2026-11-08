// The report renderer on TEST FIXTURES: what it refuses, what it labels, what it leaves out.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fixtureCaptureZip } from "./__fixtures__/fixtures";
import { compareCaptures } from "./compare";
import { aggregateDevices } from "./device";
import { parseCaptureZip } from "./exportModel";
import { checkReference } from "./reference";
import { LIMITATIONS, renderReport, REPORT_TITLE, SyntheticReferenceRefused, type ReportInput } from "./report";

const refJson = JSON.parse(readFileSync(path.join(__dirname, "__fixtures__", "reference.fixture.json"), "utf8"));
const check = checkReference(refJson);
const captures = [parseCaptureZip("c1.zip", fixtureCaptureZip({ handLength: 181.3, palmWidth: 85.5, withFrame: true })), parseCaptureZip("c2.zip", fixtureCaptureZip({ accepted: false }))];
const base = (patch: Partial<ReportInput> = {}): ReportInput => ({
  referenceCheck: check,
  referenceSource: "ref.json",
  capturesSource: "caps/",
  captureFiles: 2,
  comparison: compareCaptures(captures, check.reference!),
  surfaces: null,
  surfaceSource: null,
  devices: aggregateDevices([]),
  test: true,
  generatedAt: "2026-11-08T12:00:00.000Z",
  command: "test",
  ...patch,
});

describe("renderReport", () => {
  it("refuses a synthetic reference without --test", () => {
    expect(() => renderReport(base({ test: false }))).toThrow(SyntheticReferenceRefused);
  });

  it("labels --test output SYNTHETIC TEST and has every section", () => {
    const r = renderReport(base());
    expect(r.numeric).toBe(true);
    expect(r.markdown.split("\n")[0]).toBe(`# SYNTHETIC TEST: ${REPORT_TITLE}`);
    expect(REPORT_TITLE).toBe("PHYSICAL PHANTOM VALIDATION (experimental, one rigid phantom; not human-hand accuracy; the system is not validated)");
    for (const h of ["## 1. Reference", "## 2. Captures", "## 3. Per dimension", "## 4. Repeatability", "## 5. By condition", "## 6. Surface distance", "## 7. Processing time", "## 8. Device performance", "## 9. Definition mismatches", "## 10. Limitations"])
      expect(r.markdown).toContain(h);
    expect(r.markdown).toContain("No reference mesh supplied");
    expect(r.markdown).toContain("no runs");
    for (const l of LIMITATIONS) expect(r.markdown).toContain(l);
    expect(r.json.synthetic_test).toBe(true);
    // the like-for-like table has knuckle_section_width; hand_length sits under the mismatches
    const sec3 = r.markdown.slice(r.markdown.indexOf("## 3."), r.markdown.indexOf("## 4."));
    expect(sec3).toMatch(/\| knuckle_section_width \| 85.00 \|/);
    expect(sec3).not.toMatch(/\| hand_length \|/);
    const sec9 = r.markdown.slice(r.markdown.indexOf("## 9."));
    expect(sec9).toMatch(/\| hand_length \| 180.30 \|/);
  });

  it("writes nothing numeric when the reference or the captures are missing", () => {
    const patches: Partial<ReportInput>[] = [{ referenceCheck: null }, { captureFiles: 0, comparison: null }, { referenceCheck: checkReference({ ...refJson, units: "cm" }) }];
    for (const patch of patches) {
      const r = renderReport(base(patch));
      expect(r.numeric).toBe(false);
      expect(r.markdown).toContain("## Nothing numeric to report");
      expect(r.markdown).not.toContain("## 3.");
      expect(r.markdown).not.toMatch(/^\|/m); // no tables of numbers
    }
    expect(renderReport(base({ referenceCheck: checkReference({ ...refJson, units: "cm" }) })).markdown).toMatch(/REFUSED: units must be "mm"/);
  });
});
