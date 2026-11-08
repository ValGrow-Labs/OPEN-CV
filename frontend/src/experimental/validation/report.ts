// The PHYSICAL PHANTOM VALIDATION report (EXPERIMENTAL): Markdown for people and a JSON with every number. It prints only
// what was measured: with no reference or no captures it writes nothing numeric and says what is missing. A synthetic
// reference (phantom id starting with "synthetic") is refused unless the caller passes `test`, and then every line says
// SYNTHETIC TEST.
import type { Comparison, DimensionResult, Distribution } from "./compare";
import type { DeviceReport } from "./device";
import { MAPPING, NOT_MAPPED } from "./dimensions";
import type { ReferenceCheck } from "./reference";
import type { DistanceStats, SurfaceDistanceResult } from "./surfaceDistance";

export const REPORT_TITLE = "PHYSICAL PHANTOM VALIDATION (experimental, one rigid phantom; not human-hand accuracy; the system is not validated)";
export const SYNTHETIC_PREFIX = "SYNTHETIC TEST";

export const LIMITATIONS: readonly string[] = [
  "ONE phantom: every capture is a repeat measurement of the same object. n counts captures, not people; no figure here is a population estimate.",
  "The phantom is RIGID: no soft tissue, no skin compression under the calipers, no breathing or tremor, no movement between views.",
  "No posture variation: the fingers cannot spread, bend or lift, so the error from posture and from re-placing a hand is not measured.",
  "The phantom is not a person: its colour, texture, specular highlights, nails, hair and edges differ from skin; segmentation on real hands may behave differently.",
  "The reference values carry their own error (the rater SDs above): an error below that floor cannot be resolved.",
  "Software values whose definition differs from the caliper's are reported apart; their error includes the definition gap.",
  "A good result on this phantom is necessary, not sufficient: it says nothing about human-hand accuracy, glove sizing, other phones or other print runs of the board.",
];

export interface ReportInput {
  referenceCheck: ReferenceCheck | null;
  referenceSource: string | null;
  capturesSource: string | null;
  captureFiles: number;
  comparison: Comparison | null;
  /** One surface-distance result per accepted capture with a mesh; null when no reference mesh was supplied. */
  surfaces: { capture: string; result: SurfaceDistanceResult }[] | null;
  surfaceSource: string | null;
  devices: DeviceReport;
  test: boolean;
  generatedAt: string;
  command: string;
}

export class SyntheticReferenceRefused extends Error {}

/** What is missing for a numeric report (empty when everything needed is there). */
export function missingInputs(input: Pick<ReportInput, "referenceCheck" | "comparison" | "captureFiles">): string[] {
  const out: string[] = [];
  if (!input.referenceCheck) out.push("no physical reference supplied (--reference <file.json>): record the caliper readings first (see the validation README)");
  else if (!input.referenceCheck.ok) out.push(`the reference was REFUSED: ${input.referenceCheck.reasons.join("; ")}`);
  if (input.captureFiles === 0) out.push("no capture exports supplied (--captures <folder of ZIPs from /experiment/recon/>)");
  return out;
}

const f = (x: number | null | undefined, d = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
const sgn = (x: number | null | undefined, d = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);
const pct = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(100 * x).toFixed(0)} %`);
const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = (head: string[], rows: string[][]): string[] => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)];
const distRow = (label: string, d: Distribution, unit: string, k = 1, digits = 2): string[] => [label, String(d.n), `${f(d.median === null ? null : d.median * k, digits)} ${unit}`, `${f(d.p90 === null ? null : d.p90 * k, digits)} ${unit}`, `${f(d.max === null ? null : d.max * k, digits)} ${unit}`];

function dimRows(dims: readonly DimensionResult[]): string[][] {
  return dims.map((d) => [
    d.dimension,
    f(d.reference.agreedMm),
    f(d.reference.floorSdMm),
    `${d.n} (${d.capturesWithValue}/${d.capturesConsidered} produced, ${pct(d.shareProduced)})`,
    sgn(d.stats?.bias),
    f(d.stats?.mae),
    f(d.stats?.rmse),
    f(d.stats?.sd),
    f(d.stats?.maxAbs),
    d.stats && d.stats.loaLow !== null ? `${sgn(d.stats.loaLow)} to ${sgn(d.stats.loaHigh)}` : "n/a",
    d.biasWithinReferenceFloor === null ? "n/a" : d.biasWithinReferenceFloor ? "yes" : "no",
  ]);
}

const DIM_HEAD = ["dimension", "reference (mm)", "reference floor SD", "n used (produced)", "bias", "MAE", "RMSE", "SD of errors", "max abs", "limits of agreement", "|bias| within floor"];

function distanceRow(label: string, s: DistanceStats, signed = true): string[] {
  return [label, String(s.n), f(s.meanMm), f(s.rmsMm), f(s.medianMm), f(s.p95Mm), f(s.maxMm), signed ? sgn(s.signedMeanMm) : "n/a"];
}

export function renderReport(input: ReportInput): { markdown: string; json: Record<string, unknown>; numeric: boolean } {
  const ref = input.referenceCheck?.reference ?? null;
  if (input.referenceCheck?.synthetic && !input.test)
    throw new SyntheticReferenceRefused(`the reference's phantom id starts with "synthetic": a test reference is never written as a physical report (pass --test to label it ${SYNTHETIC_PREFIX})`);
  const title = input.test ? `${SYNTHETIC_PREFIX}: ${REPORT_TITLE}` : REPORT_TITLE;
  const banner = input.test ? [`> **${SYNTHETIC_PREFIX}.** This report was produced with --test (synthetic or fixture inputs). It is NOT a physical result and must never be copied into docs/hand3d-research/validation/physical/.`, ""] : [];
  const missing = missingInputs(input);
  const L: string[] = [`# ${title}`, "", ...banner];
  L.push(`Generated ${input.generatedAt} by \`${input.command}\`.`, "");
  L.push(`Inputs: reference ${input.referenceSource ?? "none"}; captures ${input.capturesSource ?? "none"} (${input.captureFiles} file(s)); reference mesh ${input.surfaceSource ?? "none"}.`, "");
  if (missing.length || !input.comparison || !ref) {
    L.push("## Nothing numeric to report", "", "This report contains no numbers because:", "", ...missing.map((m) => `* ${m}`), "");
    if (input.referenceCheck?.warnings.length) L.push("Reference warnings:", "", ...input.referenceCheck.warnings.map((w) => `* ${w}`), "");
    L.push("## Limitations", "", ...LIMITATIONS.map((l) => `* ${l}`), "");
    return { markdown: L.join("\n"), json: { title, synthetic_test: input.test, generated_at: input.generatedAt, numeric: false, missing, limitations: LIMITATIONS }, numeric: false };
  }
  const cmp = input.comparison;

  // 1. reference
  L.push("## 1. Reference (caliper and tape readings of the phantom)", "");
  L.push(`Phantom **${ref.phantomId}**: ${ref.description}. Measured ${ref.date} by ${ref.measurers.join(", ")} (codes).`);
  L.push(`Agreed value: the ${ref.protocol.agreed_value} of all readings. At least ${ref.protocol.min_readings_per_measurer} readings per measurer; spread tolerance ${ref.protocol.spread_tolerance_mm} mm${Object.keys(ref.protocol.spread_tolerance_by_dimension_mm).length ? ` (per dimension: ${Object.entries(ref.protocol.spread_tolerance_by_dimension_mm).map(([k, v]) => `${k} ${v} mm`).join(", ")})` : ""}; second measurer: ${ref.protocol.second_measurer === "all" ? "all dimensions" : ref.protocol.second_measurer.join(", ")}.`);
  L.push(ref.cadFile ? `CAD / reference file: ${ref.cadFile}${ref.printScanned ? " (the printed part was scanned)" : " (nominal CAD; the print was not scanned)"}.` : "No CAD file recorded.", "");
  L.push(...table(["instrument", "type", "resolution", "check", "nominal", "reading"], ref.instruments.map((i) => [i.id, i.type, `${i.resolution_mm} mm`, i.calibration_check.reference, `${i.calibration_check.nominal_mm} mm`, `${i.calibration_check.reading_mm} mm`])), "");
  L.push("Error floor: the reference cannot resolve a camera error smaller than its own spread. `floor SD` = sqrt(intra-rater SD^2 + inter-rater SD^2).", "");
  L.push(...table(["dimension", "agreed (mm)", "readings", "intra-rater SD", "inter-rater SD", "floor SD", "instrument", "definition"], ref.dimensions.map((d) => [d.name, f(d.agreedMm), String(d.n), f(d.intraRaterSdMm, 3), f(d.interRaterSdMm, 3), f(d.floorSdMm, 3), d.instrument, d.definition + (d.position ? ` (${d.position})` : "")])), "");
  if (input.referenceCheck!.warnings.length) L.push("Reference warnings:", "", ...input.referenceCheck!.warnings.map((w) => `* ${w}`), "");

  // 2. captures
  const c = cmp.counts;
  L.push("## 2. Captures: accepted and rejected", "");
  L.push(`${c.total} capture(s): ${c.accepted} accepted, ${c.rejected} rejected, ${c.refused} refused, ${c.unreadable} unreadable, ${c.excluded} excluded. Only accepted captures enter the error statistics.`, "");
  if (cmp.reasonCounts.length) L.push(...table(["reason", "captures"], cmp.reasonCounts.map((r) => [r.reason, String(r.count)])), "");
  L.push(
    ...table(
      ["capture", "session", "conditions", "status", "calibration rms px", "pose rms px (median / max)", "views used", "completeness", "time s", "reasons"],
      cmp.captures.map((s) => [s.name, s.sessionId, s.conditions.join(", "), s.status, f(s.calibrationRmsPx), `${f(s.poseRmsPx.median)} / ${f(s.poseRmsPx.max)}`, String(s.viewsUsed), pct(s.completeness), f(s.processingMs === null ? null : s.processingMs / 1000, 1), s.reasons.join("; ") || "-"]),
    ),
    "",
  );
  for (const n of cmp.notes) L.push(`* ${n}`);
  L.push("");

  // 3. per dimension
  const like = cmp.dimensions.filter((d) => d.relation === "like_for_like");
  const differs = cmp.dimensions.filter((d) => d.relation === "definition_differs");
  L.push("## 3. Per dimension (like-for-like definitions)", "");
  L.push("Error = software value minus the reference's agreed value (mm). Limits of agreement = bias +- 1.96 SD of the errors over repeated captures of this one phantom.", "");
  L.push(...(like.length ? table(DIM_HEAD, dimRows(like)) : ["No like-for-like dimension was measured in the reference."]), "");
  const missingRows = cmp.dimensions.flatMap((d) => d.missingReasons.map((m) => [d.dimension, m.reason, String(m.count)]));
  if (missingRows.length) L.push("Why values are missing (counted as missing, never as zero):", "", ...table(["dimension", "reason", "captures"], missingRows), "");
  if (cmp.referenceOnly.length) L.push(`Reference-only dimensions (no software counterpart): ${cmp.referenceOnly.join(", ")}.`, "");
  if (cmp.notInReference.length) L.push(`Software dimensions the reference did not measure: ${cmp.notInReference.join(", ")}.`, "");

  // 4. repeatability
  L.push("## 4. Repeatability", "");
  L.push("Within-session SD: pooled SD of the values of accepted captures within each session. Repeatability coefficient = 2.77 x that SD (two captures of the same phantom in one session differ by less, 95 % of the time, if errors are normal). Between-session: SD and range of the session means.", "");
  L.push(
    ...table(
      ["dimension", "sessions (with repeats)", "within-session SD", "repeatability coefficient", "between-session SD", "between-session range"],
      cmp.dimensions.map((d) => [d.dimension + (d.relation === "definition_differs" ? " (definition differs)" : ""), `${d.repeatability.sessionMeans.length} (${d.repeatability.sessionsWithRepeats})`, f(d.repeatability.withinSessionSdMm), f(d.repeatability.repeatabilityCoefficientMm), f(d.repeatability.betweenSessionSdMm), f(d.repeatability.betweenSessionRangeMm)]),
    ),
    "",
  );

  // 5. conditions
  L.push("## 5. By condition", "");
  L.push(...table(["condition", "captures", "accepted", "rejected", "refused"], cmp.conditions.map((k) => [k.condition, String(k.captures), String(k.accepted), String(k.rejected), String(k.refused)])), "");
  const condRows = cmp.conditions.flatMap((k) => k.dimensions.filter((d) => d.n > 0).map((d) => [k.condition, d.dimension + (d.relation === "definition_differs" ? " (definition differs)" : ""), String(d.n), sgn(d.biasMm), f(d.maeMm), sgn(d.biasShiftVsBaselineMm)]));
  L.push(...(condRows.length ? table(["condition", "dimension", "n", "bias", "MAE", "bias shift vs baseline"], condRows) : ["No accepted capture with a value in any condition."]), "");

  // 6. surface
  L.push("## 6. Surface distance to the reference mesh", "");
  const surfaces = input.surfaces;
  if (!surfaces) L.push("No reference mesh supplied (--mesh <reference.stl|.ply>).", "");
  else if (!surfaces.length) L.push("A reference mesh was supplied but no accepted capture has a mesh to compare.", "");
  else {
    const okOnes = surfaces.filter((x) => x.result.ok);
    L.push(`Reference: ${input.surfaceSource} (${surfaces[0].result.referenceKind === "scan" ? "scan of the printed part" : "nominal CAD"}). One row per accepted capture; distances in mm.`, "");
    L.push(
      ...table(
        ["capture", "alignment", "ICP rms", "recon->ref mean", "RMS", "p95", "max", "signed mean (+ outside)", "ref->recon mean", "Hausdorff", "coverage"],
        surfaces.map(({ capture, result: r }) =>
          r.ok
            ? [capture, `${r.alignment!.method} (tilt ${f(r.alignment!.baseTiltDeg, 1)} deg)`, f(r.alignment!.icpRmsMm), f(r.meshToReference.meanMm), f(r.meshToReference.rmsMm), f(r.meshToReference.p95Mm), f(r.meshToReference.maxMm), sgn(r.meshToReference.signedMeanMm), f(r.referenceToMesh.meanMm), f(r.hausdorffMm), `${pct(r.coverage.share)} within ${r.coverage.thresholdMm} mm`]
            : [capture, `not computed: ${r.reason}`, "", "", "", "", "", "", "", "", ""],
        ),
      ),
      "",
    );
    if (okOnes.length) {
      const first = okOnes[0];
      const r = first.result;
      L.push(`Detail for ${first.capture} (every support label separately; board-plane, cut and box vertices are never in the main figures):`, "");
      L.push(...table(["direction / label", "n", "mean", "RMS", "median", "p95", "max", "signed mean (+ outside)"], [distanceRow("reconstruction -> reference (observed + implied)", r.meshToReference), ...Object.entries(r.perLabel).map(([k, v]) => distanceRow(`vertices labelled ${k}`, v)), distanceRow("reference (base excluded) -> reconstruction", r.referenceToMesh, false)]), "");
      L.push(`Coverage: share of the compared reference area (${f(r.coverage.referenceAreaMm2, 0)} mm2; excluded: base ${f(r.coverage.baseAreaExcludedMm2, 0)} mm2, facing the reconstruction's cut faces ${f(r.coverage.cutAreaExcludedMm2, 0)} mm2) within ${r.coverage.thresholdMm} mm of the reconstruction.`, "");
    }
    L.push(...[...new Set(surfaces.flatMap((x) => x.result.notes))].map((n) => `* ${n}`), "");
  }

  // 7. processing
  L.push("## 7. Processing time and capture quality figures", "");
  L.push(...table(["figure", "captures", "median", "p90", "max"], [distRow("processing time (page worker total)", cmp.processingMs, "s", 1 / 1000, 1), distRow("calibration rms", cmp.calibrationRmsPx, "px"), distRow("pose rms (median per capture)", cmp.poseRmsPx, "px"), distRow("mesh completeness", cmp.completeness, "%", 100, 0), ...Object.entries(cmp.supportShare).map(([k, d]) => distRow(`support share ${k}`, d, "%", 100, 0))]), "");

  // 8. devices
  L.push("## 8. Device performance (measured values, no compatibility verdict)", "");
  if (!input.devices.runs) L.push("no runs (no device.json was found).", "");
  else {
    L.push(input.devices.statement, "");
    L.push(
      ...table(
        ["device / browser (from the user agent)", "runs", "capture s (median / max)", "build s (median / max)", "export s (median / max)", "peak heap MB (median / max)", "runs with errors", "context losses (runs with one / runs recorded)", "export ok"],
        input.devices.devices.map((d) => [d.key, String(d.runs), `${f(d.captureMs.median === null ? null : d.captureMs.median / 1000, 1)} / ${f(d.captureMs.max === null ? null : d.captureMs.max / 1000, 1)}`, `${f(d.buildMs.median === null ? null : d.buildMs.median / 1000, 1)} / ${f(d.buildMs.max === null ? null : d.buildMs.max / 1000, 1)}`, `${f(d.exportMs.median === null ? null : d.exportMs.median / 1000, 1)} / ${f(d.exportMs.max === null ? null : d.exportMs.max / 1000, 1)}`, `${f(d.peakHeapMb.median, 0)} / ${f(d.peakHeapMb.max, 0)}`, String(d.runsWithErrors), `${d.contextLosses} (${d.runsWithContextLoss} / ${d.contextLossKnown})`, `${d.exportOk} of ${d.exportKnown}`]),
      ),
      "",
    );
    const errs = input.devices.devices.flatMap((d) => d.errors.map((e) => [d.key, e.message, String(e.count)]));
    if (errs.length) L.push(...table(["device / browser", "error", "runs"], errs), "");
  }

  // 9. mismatches
  L.push("## 9. Definition mismatches", "");
  L.push("These software values are not defined like the caliper dimension they sit next to. Their error includes the definition gap and is NOT a reconstruction error.", "");
  L.push(...(differs.length ? table(DIM_HEAD, dimRows(differs)) : ["None of the mismatched dimensions was measured in the reference."]), "");
  L.push(...table(["dimension", "software definition", "why it differs"], MAPPING.filter((m) => m.relation === "definition_differs").map((m) => [m.dimension, m.software, m.note])), "");
  L.push("Not mapped at all:", "", ...NOT_MAPPED.map((n) => `* ${n.software}: ${n.reason}`), "");

  // 10. limitations
  L.push("## 10. Limitations", "", ...LIMITATIONS.map((l) => `* ${l}`), "");
  if (input.test) L.push(`_${SYNTHETIC_PREFIX}: not a physical result._`, "");

  const json = {
    title,
    synthetic_test: input.test,
    generated_at: input.generatedAt,
    command: input.command,
    numeric: true,
    inputs: { reference: input.referenceSource, captures: input.capturesSource, capture_files: input.captureFiles, reference_mesh: input.surfaceSource },
    reference: ref,
    reference_warnings: input.referenceCheck!.warnings,
    mapping: MAPPING,
    not_mapped: NOT_MAPPED,
    comparison: cmp,
    surface_distance: input.surfaces,
    devices: input.devices,
    limitations: LIMITATIONS,
  };
  return { markdown: L.join("\n"), json, numeric: true };
}
