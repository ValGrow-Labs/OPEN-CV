// The physical-reference checker on TEST FIXTURES (invented numbers, worked out by hand).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkReference, parseCsv, referenceFromCsv, referenceTemplate, type ReferenceFile } from "./reference";

const dir = path.join(__dirname, "__fixtures__");
const load = (n: string) => JSON.parse(readFileSync(path.join(dir, n), "utf8"));
const fixture = (): ReferenceFile => load("reference.fixture.json");
const edit = (f: (r: ReferenceFile) => void): ReferenceFile => {
  const r = fixture();
  f(r);
  return r;
};

describe("checkReference: a complete fixture", () => {
  const c = checkReference(fixture());
  it("passes and computes agreed values and rater SDs", () => {
    expect(c.reasons).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.synthetic).toBe(true); // fixture ids start with "synthetic"
    const hl = c.reference!.dimensions.find((d) => d.name === "hand_length")!;
    // M01 180.0, 180.2 (mean 180.1); M02 180.4, 180.6 (mean 180.5)
    expect(hl.agreedMm).toBeCloseTo(180.3, 10);
    expect(hl.agreedMethod).toBe("mean");
    expect(hl.intraRaterSdMm).toBeCloseTo(Math.sqrt(0.02), 10); // each measurer's SD is 0.1414
    expect(hl.interRaterSdMm).toBeCloseTo(Math.sqrt(0.08), 10); // SD of 180.1 and 180.5
    expect(hl.floorSdMm).toBeCloseTo(Math.sqrt(0.1), 10);
    expect(hl.spreadToleranceMm).toBe(0.5);
    const circ = c.reference!.dimensions.find((d) => d.name === "circumference_knuckle")!;
    expect(circ.agreedMm).toBe(211);
    expect(circ.spreadToleranceMm).toBe(2); // per-dimension tolerance recorded
    expect(c.reference!.dimensions.find((d) => d.name === "extra_block_height")!.phantomOnly).toBe(true);
    expect(c.warnings.some((w) => /TEST reference/.test(w))).toBe(true);
  });
});

describe("checkReference: refusals (never fills a value)", () => {
  const reasonsOf = (r: unknown) => {
    const c = checkReference(r);
    expect(c.ok).toBe(false);
    expect(c.reference).toBeNull();
    return c.reasons.join("\n");
  };
  it("one reading per measurer", () => expect(reasonsOf(edit((r) => (r.dimensions![0].readings = r.dimensions![0].readings.filter((_, i) => i !== 1))))).toMatch(/M01 took 1 reading\(s\); the protocol needs at least 2/));
  it("spread over tolerance", () => expect(reasonsOf(edit((r) => (r.dimensions![0].readings[1].value_mm = 181.0)))).toMatch(/M01's readings spread 1.00 mm, over the 0.5 mm tolerance/));
  it("no second measurer", () => expect(reasonsOf(edit((r) => (r.dimensions![1].readings = r.dimensions![1].readings.filter((x) => x.measurer === "M01"))))).toMatch(/knuckle_section_width: the protocol needs a second measurer/));
  it("measurers disagree", () => expect(reasonsOf(edit((r) => r.dimensions![0].readings.slice(2).forEach((x) => (x.value_mm! += 0.5))))).toMatch(/means differ by 0.90 mm, over the 0.5 mm inter-rater tolerance/));
  it("a missing value", () => expect(reasonsOf(edit((r) => (r.dimensions![0].readings[0].value_mm = null)))).toMatch(/is null \(missing or not a positive number; it is not filled in\)/));
  it("a name instead of a code", () => {
    const why = reasonsOf(edit((r) => (r.measurers = [{ code: "Alice" }, { code: "M02" }])));
    expect(why).toMatch(/codes are letters then digits/);
    expect(reasonsOf(edit((r) => ((r.measurers[0] as unknown as Record<string, string>).full_name = "x")))).toMatch(/no names in the data/);
  });
  it("units, date, schema", () => {
    expect(reasonsOf(edit((r) => (r.units = "cm")))).toMatch(/units must be "mm"/);
    expect(reasonsOf(edit((r) => (r.date = "last tuesday")))).toMatch(/ISO date/);
    expect(reasonsOf(edit((r) => (r.schema = "v0")))).toMatch(/schema must be/);
  });
  it("no gauge block, a failed calibration check, no tolerance", () => {
    expect(reasonsOf(edit((r) => (r.instruments[0].calibration_check.reference = "other")))).toMatch(/no instrument has a gauge-block/);
    expect(reasonsOf(edit((r) => (r.instruments[0].calibration_check.reading_mm = 100.05)))).toMatch(/off by 0.050 mm, tolerance 0.020 mm/);
    expect(reasonsOf(edit((r) => delete (r.protocol as Partial<ReferenceFile["protocol"]>).spread_tolerance_mm))).toMatch(/spread_tolerance_mm is required/);
    expect(reasonsOf(edit((r) => (r.protocol.min_readings_per_measurer = 1)))).toMatch(/at least 2/);
  });
  it("a circumference with a caliper, an unknown dimension, a missing definition", () => {
    expect(reasonsOf(edit((r) => (r.dimensions![2].instrument = "cal-1")))).toMatch(/circumference is measured with a tape/);
    expect(reasonsOf(edit((r) => (r.dimensions![0].name = "wrist_width")))).toMatch(/unknown name/);
    expect(reasonsOf(edit((r) => (r.dimensions![0].definition = "")))).toMatch(/no definition stated/);
  });
  it("the blank template until readings are entered", () => {
    const why = reasonsOf(referenceTemplate());
    expect(why).toMatch(/phantom.id is missing/);
    expect(why).toMatch(/is null/);
  });
});

describe("CSV import", () => {
  it("reads quoted fields and builds the dimensions; the median is used when asked", () => {
    const header = load("reference-header.fixture.json");
    const { reference, problems } = referenceFromCsv(header, readFileSync(path.join(dir, "readings.fixture.csv"), "utf8"));
    expect(problems).toEqual([]);
    expect(reference.dimensions!.map((d) => d.name)).toEqual(["palm_breadth", "palm_thickness"]);
    expect(reference.dimensions![0].definition).toBe("fixture: breadth, at the knuckle datum");
    const c = checkReference(reference);
    expect(c.reasons).toEqual([]);
    expect(c.reference!.dimensions[0].agreedMm).toBeCloseTo(84.2, 10); // median of 84.1, 84.2, 84.3, 84.2
    expect(c.reference!.dimensions[1].agreedMm).toBeCloseTo(24.075, 10); // median of 24.0, 24.1, 24.05, 24.15
  });

  it("flags inconsistent rows and keeps empty values as missing", () => {
    const header = load("reference-header.fixture.json");
    const csv = "dimension,measurer,value_mm,instrument,definition\npalm_breadth,M01,84.1,cal-1,a\npalm_breadth,M01,,cal-1,b\n";
    const { reference, problems } = referenceFromCsv(header, csv);
    expect(problems).toContain("dimension palm_breadth: different definitions on different CSV rows");
    expect(reference.dimensions![0].readings[1].value_mm).toBeNull();
    expect(checkReference(reference).ok).toBe(false);
  });

  it("parses RFC 4180 quotes", () => {
    expect(parseCsv('a,"b,c","d ""e"""\n1,2,3\n')).toEqual([["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
  });
});
