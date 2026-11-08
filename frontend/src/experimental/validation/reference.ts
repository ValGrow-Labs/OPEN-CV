// The PHYSICAL REFERENCE of a manufactured phantom (EXPERIMENTAL validation tooling): caliper and tape readings taken by
// people, stored as JSON (or a CSV of readings plus a JSON header), and the checker that decides whether the reference
// is complete and consistent enough to compare a reconstruction against.
//
// Rules the checker enforces (it REFUSES with reasons; it never fills, rounds or guesses a missing value):
//   * units are millimetres; the date is an ISO date; the phantom has an id and a description;
//   * measurers are CODES (letters then digits, e.g. M01), never names;
//   * every instrument has a resolution and a calibration check (nominal vs reading, within tolerance); at least one
//     check is against a gauge block; a circumference is taken with a tape;
//   * every dimension has a stated definition, a known name (or the "extra_" prefix for phantom-only dimensions), an
//     instrument, and at least `min_readings_per_measurer` (>= 2) readings by each measurer who measured it;
//   * each measurer's readings of a dimension stay within the spread tolerance (configurable, recorded in the output);
//   * a second measurer on every dimension the protocol says needs one, and their means agree within the inter-rater
//     tolerance;
//   * no reading is null, empty, non-numeric, zero or negative.
// It computes per dimension: the agreed value (mean or median of all readings, as the protocol says, recorded), the
// intra-rater SD (pooled within-measurer SD) and the inter-rater SD (SD of the measurer means), and their combination
// as the reference error floor: a camera error below that floor cannot be resolved by this reference.
import { DIMENSIONS, dimensionSpec, isPhantomOnly } from "./dimensions";
import { median } from "../reconstruction/stats";

export const REFERENCE_SCHEMA = "glovesize.phantom-reference/1";

export interface CalibrationCheck {
  /** What the instrument was checked against. */
  reference: "gauge_block" | "steel_rule" | "other";
  nominal_mm: number;
  reading_mm: number;
  /** Largest acceptable |reading - nominal|; default twice the instrument resolution. */
  tolerance_mm?: number;
  date?: string;
}

export interface InstrumentRecord {
  id: string;
  type: "caliper" | "tape" | "anthropometer" | "height_gauge" | "other";
  model?: string;
  resolution_mm: number;
  calibration_check: CalibrationCheck;
}

export interface ReadingRecord {
  measurer: string;
  value_mm: number | null;
  note?: string;
}

export interface DimensionRecord {
  name: string;
  definition: string;
  /** Where on the phantom (e.g. "8 mm proximal to the knuckle datum"), if not already in the definition. */
  position?: string;
  instrument: string;
  readings: ReadingRecord[];
}

export interface ReferenceProtocol {
  /** At least 2 (the default); a protocol may ask for more (3 for thickness, say), never fewer. */
  min_readings_per_measurer?: number;
  /** Largest allowed spread (max - min) of one measurer's readings of one dimension. Required: fixed before measuring. */
  spread_tolerance_mm: number;
  spread_tolerance_by_dimension_mm?: Record<string, number>;
  /** Largest allowed difference between two measurers' means; default the dimension's spread tolerance. */
  inter_rater_tolerance_mm?: number;
  agreed_value: "mean" | "median";
  /** Dimensions that need a second measurer: "all" (default) or a list of names. */
  second_measurer?: "all" | string[];
}

export interface ReferenceFile {
  schema: string;
  phantom: {
    id: string;
    description: string;
    /** The CAD or reference-scan file of this phantom, if any. */
    cad_file?: string | null;
    /** True when the printed part itself was scanned (then a reference mesh is the part, not the nominal CAD). */
    print_scanned?: boolean;
    notes?: string;
  };
  date: string;
  units: string;
  instruments: InstrumentRecord[];
  measurers: { code: string; role?: string }[];
  protocol: ReferenceProtocol;
  dimensions?: DimensionRecord[];
  /** Path (relative to the JSON) of a CSV of readings, instead of `dimensions` (resolved by the CLI). */
  readings_csv?: string;
  notes?: string;
}

export interface MeasurerSummary {
  code: string;
  n: number;
  mean: number;
  sd: number | null;
  spread: number;
}

export interface CheckedDimension {
  name: string;
  definition: string;
  position: string | null;
  instrument: string;
  instrumentType: InstrumentRecord["type"];
  instrumentResolutionMm: number;
  phantomOnly: boolean;
  agreedMm: number;
  agreedMethod: "mean" | "median";
  n: number;
  measurers: MeasurerSummary[];
  /** Pooled within-measurer SD (mm). */
  intraRaterSdMm: number;
  /** SD of the measurer means (mm); null with one measurer. */
  interRaterSdMm: number | null;
  /** sqrt(intra^2 + inter^2): the reference's own error floor (mm). */
  floorSdMm: number;
  spreadToleranceMm: number;
  interRaterToleranceMm: number;
  secondMeasurerRequired: boolean;
}

export interface CheckedReference {
  phantomId: string;
  description: string;
  date: string;
  cadFile: string | null;
  printScanned: boolean;
  instruments: InstrumentRecord[];
  measurers: string[];
  protocol: Required<Omit<ReferenceProtocol, "spread_tolerance_by_dimension_mm" | "inter_rater_tolerance_mm">> & {
    spread_tolerance_by_dimension_mm: Record<string, number>;
    inter_rater_tolerance_mm: number | null;
  };
  dimensions: CheckedDimension[];
  /** The phantom id starts with "synthetic": a test reference, never a physical one. */
  synthetic: boolean;
}

export interface ReferenceCheck {
  ok: boolean;
  reasons: string[];
  warnings: string[];
  synthetic: boolean;
  /** Present only when ok. */
  reference: CheckedReference | null;
}

export const MEASURER_CODE = /^[A-Z]{1,4}[0-9]{1,4}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export const isSyntheticId = (id: unknown): boolean => typeof id === "string" && /^synthetic/i.test(id.trim());

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;

function sampleSd(v: readonly number[]): number | null {
  if (v.length < 2) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

/** Check a reference (already parsed JSON, with `dimensions` present). Never throws on bad content: it refuses. */
export function checkReference(input: unknown): ReferenceCheck {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const refuse = (synthetic: boolean): ReferenceCheck => ({ ok: false, reasons, warnings, synthetic, reference: null });
  if (!isObj(input)) {
    reasons.push("the reference is not a JSON object");
    return refuse(false);
  }
  const r = input as Partial<ReferenceFile> & Record<string, unknown>;
  if (r.schema !== REFERENCE_SCHEMA) reasons.push(`schema must be "${REFERENCE_SCHEMA}" (found ${JSON.stringify(r.schema)})`);
  const phantom = isObj(r.phantom) ? r.phantom : null;
  if (!phantom) reasons.push("phantom is missing");
  const phantomId = phantom && isStr(phantom.id) ? phantom.id.trim() : "";
  if (phantom && !phantomId) reasons.push("phantom.id is missing");
  if (phantom && !isStr(phantom.description)) reasons.push("phantom.description is missing");
  const synthetic = isSyntheticId(phantomId);
  if (r.units !== "mm") reasons.push(`units must be "mm" (found ${JSON.stringify(r.units)})`);
  if (!isStr(r.date) || !ISO_DATE.test(r.date) || Number.isNaN(Date.parse(r.date))) reasons.push(`date must be an ISO date such as 2026-11-20 (found ${JSON.stringify(r.date)})`);

  // measurers
  const measurers: string[] = [];
  if (!Array.isArray(r.measurers) || r.measurers.length === 0) reasons.push("measurers: at least one measurer code is needed");
  else
    for (const m of r.measurers) {
      const code = isObj(m) ? m.code : undefined;
      if (typeof code !== "string" || !MEASURER_CODE.test(code)) reasons.push(`measurer ${JSON.stringify(code)}: codes are letters then digits (e.g. M01), never names`);
      else if (measurers.includes(code)) reasons.push(`measurer ${code} is listed twice`);
      else measurers.push(code);
      if (isObj(m)) for (const k of Object.keys(m)) if (/name/i.test(k)) reasons.push(`measurer ${String(code)}: field "${k}" is not allowed (codes only, no names in the data)`);
    }

  // instruments
  const instruments = new Map<string, InstrumentRecord>();
  let gaugeBlock = false;
  if (!Array.isArray(r.instruments) || r.instruments.length === 0) reasons.push("instruments: at least one instrument is needed");
  else
    for (const raw of r.instruments) {
      if (!isObj(raw) || !isStr(raw.id)) {
        reasons.push("an instrument has no id");
        continue;
      }
      const ins = raw as unknown as InstrumentRecord;
      const where = `instrument ${ins.id}`;
      if (instruments.has(ins.id)) reasons.push(`${where} is listed twice`);
      if (!["caliper", "tape", "anthropometer", "height_gauge", "other"].includes(ins.type)) reasons.push(`${where}: type must be caliper, tape, anthropometer, height_gauge or other`);
      if (!isNum(ins.resolution_mm) || ins.resolution_mm <= 0) reasons.push(`${where}: resolution_mm is missing`);
      const c = ins.calibration_check;
      if (!isObj(c)) reasons.push(`${where}: calibration_check is missing (e.g. a gauge block reading taken that day)`);
      else if (!isNum(c.nominal_mm) || !isNum(c.reading_mm) || c.nominal_mm <= 0) reasons.push(`${where}: calibration_check needs nominal_mm and reading_mm`);
      else {
        const tol = isNum(c.tolerance_mm) ? c.tolerance_mm : isNum(ins.resolution_mm) ? 2 * ins.resolution_mm : NaN;
        const dev = Math.abs(c.reading_mm - c.nominal_mm);
        if (!(dev <= tol + 1e-9)) reasons.push(`${where}: calibration check reads ${c.reading_mm} mm on a ${c.nominal_mm} mm ${c.reference ?? "reference"} (off by ${dev.toFixed(3)} mm, tolerance ${Number.isFinite(tol) ? tol.toFixed(3) : "?"} mm)`);
        if (c.reference === "gauge_block") gaugeBlock = true;
      }
      instruments.set(ins.id, ins);
    }
  if (instruments.size && !gaugeBlock) reasons.push("no instrument has a gauge-block calibration check");

  // protocol
  const p = isObj(r.protocol) ? (r.protocol as Partial<ReferenceProtocol>) : null;
  if (!p) reasons.push("protocol is missing (spread tolerance, agreed value method)");
  const minReadings = p?.min_readings_per_measurer ?? 2;
  if (!Number.isInteger(minReadings) || minReadings < 2) reasons.push("protocol.min_readings_per_measurer must be an integer of at least 2");
  if (p && (!isNum(p.spread_tolerance_mm) || p.spread_tolerance_mm <= 0)) reasons.push("protocol.spread_tolerance_mm is required (fixed before measuring) and must be positive");
  if (p && p.agreed_value !== "mean" && p.agreed_value !== "median") reasons.push('protocol.agreed_value must be "mean" or "median"');
  if (p?.inter_rater_tolerance_mm !== undefined && (!isNum(p.inter_rater_tolerance_mm) || p.inter_rater_tolerance_mm <= 0)) reasons.push("protocol.inter_rater_tolerance_mm must be positive");
  const byDim = isObj(p?.spread_tolerance_by_dimension_mm) ? (p!.spread_tolerance_by_dimension_mm as Record<string, number>) : {};
  for (const [k, v] of Object.entries(byDim)) if (!isNum(v) || v <= 0) reasons.push(`protocol.spread_tolerance_by_dimension_mm.${k} must be positive`);
  const second = p?.second_measurer ?? "all";
  if (second !== "all" && !(Array.isArray(second) && second.every((s) => typeof s === "string"))) reasons.push('protocol.second_measurer must be "all" or a list of dimension names');

  // dimensions
  if (r.readings_csv !== undefined && r.dimensions !== undefined) reasons.push("give either dimensions or readings_csv, not both");
  if (!Array.isArray(r.dimensions) || r.dimensions.length === 0) reasons.push(r.readings_csv ? "readings_csv was not loaded (load it with referenceFromCsv first)" : "dimensions: no measured dimension");
  const checked: CheckedDimension[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(r.dimensions) ? r.dimensions : []) {
    if (!isObj(raw) || !isStr(raw.name)) {
      reasons.push("a dimension has no name");
      continue;
    }
    const d = raw as unknown as DimensionRecord;
    const where = `dimension ${d.name}`;
    if (seen.has(d.name)) reasons.push(`${where} appears twice`);
    seen.add(d.name);
    const spec = dimensionSpec(d.name);
    const phantomOnly = isPhantomOnly(d.name);
    if (!spec && !phantomOnly) reasons.push(`${where}: unknown name (use a catalogue name, or the prefix "extra_" for a phantom-only dimension)`);
    if (!isStr(d.definition)) reasons.push(`${where}: no definition stated`);
    const ins = instruments.get(d.instrument);
    if (!ins) reasons.push(`${where}: instrument ${JSON.stringify(d.instrument)} is not in the instruments list`);
    if (spec?.instrument === "tape" && ins && ins.type !== "tape") reasons.push(`${where}: a circumference is measured with a tape (instrument ${ins.id} is a ${ins.type})`);
    const readings = Array.isArray(d.readings) ? d.readings : [];
    if (readings.length === 0) reasons.push(`${where}: no readings`);
    const byMeasurer = new Map<string, number[]>();
    let bad = false;
    for (const rd of readings) {
      const code = isObj(rd) ? rd.measurer : undefined;
      const v = isObj(rd) ? rd.value_mm : undefined;
      if (typeof code !== "string" || !measurers.includes(code)) {
        reasons.push(`${where}: reading by ${JSON.stringify(code)}, who is not in the measurers list`);
        bad = true;
        continue;
      }
      if (!isNum(v) || v <= 0) {
        reasons.push(`${where}: a reading by ${code} is ${JSON.stringify(v)} (missing or not a positive number; it is not filled in)`);
        bad = true;
        continue;
      }
      (byMeasurer.get(code) ?? byMeasurer.set(code, []).get(code)!).push(v);
    }
    const tol = isNum(byDim[d.name]) ? byDim[d.name] : p?.spread_tolerance_mm ?? NaN;
    const interTol = isNum(p?.inter_rater_tolerance_mm) ? p!.inter_rater_tolerance_mm! : tol;
    const summaries: MeasurerSummary[] = [];
    for (const [code, vals] of byMeasurer) {
      if (vals.length < minReadings) reasons.push(`${where}: ${code} took ${vals.length} reading(s); the protocol needs at least ${minReadings}`);
      const spread = Math.max(...vals) - Math.min(...vals);
      if (Number.isFinite(tol) && spread > tol + 1e-9) reasons.push(`${where}: ${code}'s readings spread ${spread.toFixed(2)} mm, over the ${tol} mm tolerance (re-measure)`);
      summaries.push({ code, n: vals.length, mean: vals.reduce((s, x) => s + x, 0) / vals.length, sd: sampleSd(vals), spread });
    }
    const needsSecond = second === "all" || (Array.isArray(second) && second.includes(d.name));
    if (needsSecond && byMeasurer.size < 2 && readings.length > 0) reasons.push(`${where}: the protocol needs a second measurer; only ${[...byMeasurer.keys()].join(", ") || "none"} measured it`);
    if (summaries.length >= 2) {
      const means = summaries.map((s) => s.mean);
      const diff = Math.max(...means) - Math.min(...means);
      if (Number.isFinite(interTol) && diff > interTol + 1e-9) reasons.push(`${where}: the measurers' means differ by ${diff.toFixed(2)} mm, over the ${interTol} mm inter-rater tolerance (inconsistent; re-measure)`);
    }
    if (bad || summaries.length === 0 || !ins) continue;
    const all = summaries.flatMap((s) => byMeasurer.get(s.code)!);
    const agreed = p?.agreed_value === "median" ? median(all) : all.reduce((s, x) => s + x, 0) / all.length;
    // pooled within-measurer variance: sum (n_i - 1) s_i^2 / sum (n_i - 1)
    let num = 0, den = 0;
    for (const s of summaries) if (s.sd !== null) { num += (s.n - 1) * s.sd * s.sd; den += s.n - 1; } // fmt: skip
    const intra = den > 0 ? Math.sqrt(num / den) : 0;
    const inter = summaries.length >= 2 ? sampleSd(summaries.map((s) => s.mean)) : null;
    if (ins && all.some((v) => Math.abs(v / ins.resolution_mm - Math.round(v / ins.resolution_mm)) > 1e-6))
      warnings.push(`${where}: some readings have more digits than the ${ins.resolution_mm} mm resolution of ${ins.id}`);
    checked.push({
      name: d.name,
      definition: d.definition,
      position: isStr(d.position) ? d.position : null,
      instrument: ins.id,
      instrumentType: ins.type,
      instrumentResolutionMm: ins.resolution_mm,
      phantomOnly,
      agreedMm: agreed,
      agreedMethod: p?.agreed_value === "median" ? "median" : "mean",
      n: all.length,
      measurers: summaries,
      intraRaterSdMm: intra,
      interRaterSdMm: inter,
      floorSdMm: Math.sqrt(intra * intra + (inter ?? 0) ** 2),
      spreadToleranceMm: tol,
      interRaterToleranceMm: interTol,
      secondMeasurerRequired: needsSecond,
    });
  }
  if (Array.isArray(second)) for (const s of second) if (!seen.has(s)) warnings.push(`protocol.second_measurer names ${s}, which was not measured`);
  if (synthetic) warnings.push(`phantom id "${phantomId}" starts with "synthetic": this is a TEST reference, not a physical one`);
  if (reasons.length) return refuse(synthetic);
  return {
    ok: true,
    reasons,
    warnings,
    synthetic,
    reference: {
      phantomId,
      description: String(phantom!.description),
      date: String(r.date),
      cadFile: isStr(phantom!.cad_file) ? phantom!.cad_file : null,
      printScanned: phantom!.print_scanned === true,
      instruments: [...instruments.values()],
      measurers,
      protocol: {
        min_readings_per_measurer: minReadings,
        spread_tolerance_mm: p!.spread_tolerance_mm!,
        spread_tolerance_by_dimension_mm: byDim,
        inter_rater_tolerance_mm: p!.inter_rater_tolerance_mm ?? null,
        agreed_value: p!.agreed_value!,
        second_measurer: second,
      },
      dimensions: checked,
      synthetic,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// CSV import

/** Split CSV text into rows of fields (RFC 4180 quotes; comma separated; blank lines skipped). */
export function parseCsv(textIn: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = textIn.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; } // fmt: skip
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") { row.push(field); field = ""; } // fmt: skip
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** Build the dimensions of a reference from a CSV of readings. Columns (header row, any order): dimension, measurer,
 *  value_mm (required), definition, position, instrument, note (optional; definition, position and instrument must be the
 *  same on every row of a dimension, and stated at least once). Empty values are kept as null, so the checker refuses
 *  them; nothing is filled in. Returns the merged reference and the problems found while reading. */
export function referenceFromCsv(header: Omit<ReferenceFile, "dimensions">, csv: string): { reference: ReferenceFile; problems: string[] } {
  const problems: string[] = [];
  const rows = parseCsv(csv);
  const { readings_csv: _drop, ...rest } = header;
  void _drop;
  const reference: ReferenceFile = { ...rest, dimensions: [] };
  if (rows.length < 2) {
    problems.push("the readings CSV has no data rows");
    return { reference, problems };
  }
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  for (const req of ["dimension", "measurer", "value_mm"]) if (col(req) < 0) problems.push(`the readings CSV has no "${req}" column`);
  if (problems.length) return { reference, problems };
  const dims = new Map<string, DimensionRecord & { _defs: Set<string>; _pos: Set<string>; _ins: Set<string> }>();
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? "").trim() : "");
    const name = get("dimension");
    if (!name) {
      problems.push(`CSV line ${line}: no dimension name`);
      return;
    }
    const d = dims.get(name) ?? { name, definition: "", instrument: "", readings: [], _defs: new Set<string>(), _pos: new Set<string>(), _ins: new Set<string>() };
    dims.set(name, d);
    if (get("definition")) d._defs.add(get("definition"));
    if (get("position")) d._pos.add(get("position"));
    if (get("instrument")) d._ins.add(get("instrument"));
    const raw = get("value_mm");
    const value = raw === "" ? null : Number(raw.replace(/\s/g, ""));
    if (raw !== "" && !Number.isFinite(value)) problems.push(`CSV line ${line}: value_mm "${raw}" is not a number`);
    const reading: ReadingRecord = { measurer: get("measurer"), value_mm: raw !== "" && Number.isFinite(value) ? value : null };
    if (get("note")) reading.note = get("note");
    d.readings.push(reading);
  });
  for (const d of dims.values()) {
    if (d._defs.size > 1) problems.push(`dimension ${d.name}: different definitions on different CSV rows`);
    if (d._pos.size > 1) problems.push(`dimension ${d.name}: different positions on different CSV rows`);
    if (d._ins.size > 1) problems.push(`dimension ${d.name}: different instruments on different CSV rows`);
    const rec: DimensionRecord = { name: d.name, definition: [...d._defs][0] ?? "", instrument: [...d._ins][0] ?? "", readings: d.readings };
    if (d._pos.size) rec.position = [...d._pos][0];
    reference.dimensions!.push(rec);
  }
  return { reference, problems };
}

/** A blank reference to fill in: every catalogue dimension with its definition and empty readings (the checker refuses it
 *  until real readings are entered). */
export function referenceTemplate(): ReferenceFile {
  return {
    schema: REFERENCE_SCHEMA,
    phantom: { id: "", description: "", cad_file: null, print_scanned: false },
    date: "",
    units: "mm",
    instruments: [
      { id: "caliper-1", type: "caliper", model: "", resolution_mm: 0.01, calibration_check: { reference: "gauge_block", nominal_mm: 0, reading_mm: 0, date: "" } },
      { id: "tape-1", type: "tape", model: "", resolution_mm: 1, calibration_check: { reference: "steel_rule", nominal_mm: 0, reading_mm: 0, date: "" } },
    ],
    measurers: [{ code: "M01" }, { code: "M02" }],
    protocol: { min_readings_per_measurer: 2, spread_tolerance_mm: 0, agreed_value: "mean", second_measurer: "all" },
    dimensions: DIMENSIONS.map((d) => ({
      name: d.name,
      definition: d.definition,
      instrument: d.instrument === "tape" ? "tape-1" : "caliper-1",
      readings: ["M01", "M01", "M02", "M02"].map((measurer) => ({ measurer, value_mm: null })),
    })),
  };
}
