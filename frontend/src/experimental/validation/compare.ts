// Compare N capture exports of ONE physical phantom with its checked caliper reference (EXPERIMENTAL validation).
//
// Rules:
//   * errors are computed ONLY against the reference's agreed value; a reference that did not pass checkReference is not
//     accepted here;
//   * a value with basis "none", a null value, a value withheld by the page (board print scale wrong) or a dimension the
//     export lacks is MISSING, never zero; the share of captures that produced a value is reported;
//   * only accepted captures enter the error statistics (rejected ones are counted, with their reasons);
//   * the software-to-reference mapping is the explicit table of dimensions.ts; pairs whose definitions differ are kept
//     apart and flagged;
//   * every capture is a repeat measurement of the SAME object: n counts captures, not participants, and nothing here is
//     a population estimate. Repeatability is reported within and between sessions.
import type { Quantity } from "../common";
import { errorStats, median, type ErrorStats } from "../reconstruction/stats";
import { MAPPING, type MappingRow, type Relation } from "./dimensions";
import { quantityAt, type CaptureRecord, type CheckVerdict } from "./exportModel";
import { meshDimensions } from "./meshDimensions";
import { isSyntheticId, type CheckedDimension, type CheckedReference } from "./reference";

export type CaptureStatus = "accepted" | "rejected" | "refused" | "unreadable" | "excluded";

export interface CaptureValue {
  value: number | null;
  basis: Quantity["basis"] | null;
  /** Why the value is missing (null when present). */
  missing: string | null;
  note: string;
}

export interface CaptureSummary {
  name: string;
  status: CaptureStatus;
  reasons: string[];
  phantomId: string | null;
  sessionId: string;
  sessionRecorded: boolean;
  captureIndex: number | null;
  operatorCode: string | null;
  conditions: string[];
  calibrationRmsPx: number | null;
  focalPx: number | null;
  poseRmsPx: { median: number | null; max: number | null; views: number };
  viewsUsed: number;
  viewsRejected: { id: string; reason: string }[];
  markerResidualMaxPx: number | null;
  completeness: number | null;
  supportShare: Record<string, number> | null;
  processingMs: number | null;
  boardCheck: { ruler: string | null; flatness: string | null; coin: string | null } | null;
  coinPrintScale: number | null;
  problems: string[];
  values: Record<string, CaptureValue>;
}

export interface AgreementStats extends ErrorStats {
  /** Bland-Altman style limits (bias +- 1.96 SD of the errors), over repeated captures of ONE phantom. */
  loaLow: number | null;
  loaHigh: number | null;
}

export interface RepeatabilityResult {
  /** Pooled SD of the values within sessions (sessions with at least 2 values). */
  withinSessionSdMm: number | null;
  /** 2.77 x within-session SD: two captures of the same phantom in one session differ by less, 95 % of the time. */
  repeatabilityCoefficientMm: number | null;
  sessionsWithRepeats: number;
  sessionMeans: { session: string; n: number; meanMm: number }[];
  /** SD of the session means (needs at least 2 sessions). */
  betweenSessionSdMm: number | null;
  betweenSessionRangeMm: number | null;
}

export interface DimensionResult {
  dimension: string;
  relation: Relation;
  software: string;
  mappingNote: string;
  reference: Pick<CheckedDimension, "agreedMm" | "agreedMethod" | "floorSdMm" | "intraRaterSdMm" | "interRaterSdMm" | "definition" | "n">;
  capturesConsidered: number;
  capturesWithValue: number;
  /** capturesWithValue / capturesConsidered (accepted or not): how often the software produced a value at all. */
  shareProduced: number | null;
  /** Accepted captures with a value: the ones in the statistics. */
  n: number;
  stats: AgreementStats | null;
  errors: { capture: string; session: string; valueMm: number; errorMm: number }[];
  repeatability: RepeatabilityResult;
  /** |bias| is not larger than the reference's own error floor (cannot be told apart from reference error). */
  biasWithinReferenceFloor: boolean | null;
  missingReasons: { reason: string; count: number }[];
}

export interface ConditionResult {
  condition: string;
  captures: number;
  accepted: number;
  rejected: number;
  refused: number;
  dimensions: { dimension: string; relation: Relation; n: number; biasMm: number | null; maeMm: number | null; biasShiftVsBaselineMm: number | null }[];
}

export interface Distribution {
  n: number;
  median: number | null;
  p90: number | null;
  max: number | null;
}

export interface Comparison {
  phantomId: string;
  captures: CaptureSummary[];
  counts: Record<CaptureStatus, number> & { total: number };
  reasonCounts: { reason: string; count: number }[];
  dimensions: DimensionResult[];
  /** Reference dimensions with no software counterpart (phantom-only "extra_" ones, or not in the mapping). */
  referenceOnly: string[];
  /** Mapped software dimensions the reference did not measure. */
  notInReference: string[];
  conditions: ConditionResult[];
  processingMs: Distribution;
  calibrationRmsPx: Distribution;
  poseRmsPx: Distribution;
  completeness: Distribution;
  supportShare: Record<string, Distribution>;
  sessions: string[];
  notes: string[];
}

const isFail = (v: CheckVerdict | null): boolean => {
  if (!v || v.verdict === null) return false;
  const s = v.verdict.toLowerCase();
  return !["pass", "passed", "ok", "good", "warn", "warning", "caution", "not_checked", "not_entered", "unavailable", "skipped", "unknown"].includes(s);
};

/** Nearest-rank percentile. */
export function percentile(values: readonly number[], p: number): number | null {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

export const distribution = (values: readonly (number | null)[]): Distribution => {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  return { n: v.length, median: v.length ? median(v) : null, p90: percentile(v, 90), max: v.length ? Math.max(...v) : null };
};

function sampleSd(v: readonly number[]): number | null {
  if (v.length < 2) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

export function repeatabilityBySession(values: readonly { session: string; value: number }[]): RepeatabilityResult {
  const by = new Map<string, number[]>();
  for (const v of values) (by.get(v.session) ?? by.set(v.session, []).get(v.session)!).push(v.value);
  let num = 0, den = 0, withRepeats = 0;
  const sessionMeans: RepeatabilityResult["sessionMeans"] = [];
  for (const [session, vs] of by) {
    sessionMeans.push({ session, n: vs.length, meanMm: vs.reduce((s, x) => s + x, 0) / vs.length });
    const sd = sampleSd(vs);
    if (sd !== null) { num += (vs.length - 1) * sd * sd; den += vs.length - 1; withRepeats++; } // fmt: skip
  }
  const within = den > 0 ? Math.sqrt(num / den) : null;
  const means = sessionMeans.map((s) => s.meanMm);
  return {
    withinSessionSdMm: within,
    repeatabilityCoefficientMm: within === null ? null : 2.77 * within,
    sessionsWithRepeats: withRepeats,
    sessionMeans: sessionMeans.sort((a, b) => a.session.localeCompare(b.session)),
    betweenSessionSdMm: means.length >= 2 ? sampleSd(means) : null,
    betweenSessionRangeMm: means.length >= 2 ? Math.max(...means) - Math.min(...means) : null,
  };
}

function classify(c: CaptureRecord, phantomId: string, referenceSynthetic: boolean): { status: CaptureStatus; reasons: string[] } {
  if (!c.readable) return { status: "unreadable", reasons: c.problems.length ? c.problems : ["the capture could not be read"] };
  const syntheticCapture = (c.dataOrigin !== null && /synthetic|simulated/i.test(c.dataOrigin)) || isSyntheticId(c.run?.phantomId) || (c.run?.conditions ?? []).some((t) => /^(synthetic|simulated)$/i.test(t));
  if (syntheticCapture && !referenceSynthetic) return { status: "excluded", reasons: ["a SYNTHETIC / simulated capture: never compared with a physical reference"] };
  if (c.run?.phantomId && c.run.phantomId !== phantomId) return { status: "excluded", reasons: [`captured phantom ${c.run.phantomId}, not the reference's ${phantomId}`] };
  if (c.refused) return { status: "refused", reasons: [`refused: ${c.refused}${c.refusalWords ? ` (${c.refusalWords})` : ""}`] };
  const reasons: string[] = [];
  const rec = c.reconstruction;
  if (!rec) reasons.push("no reconstruction in the export");
  else {
    if (rec.ok === false) reasons.push(`reconstruction failed: ${rec.failure ?? "no reason given"}`);
    if (rec.accepted !== true) {
      if (rec.reasons.length) for (const r of rec.reasons) reasons.push(`quality: ${r.code}${r.words ? ` (${r.words})` : ""}`);
      else reasons.push("quality: not accepted (no reason given)");
    }
  }
  if (c.coinCheck?.scaleWrong) reasons.push("board print scale check failed: measurements withheld by the page");
  const bc = c.boardCheck;
  if (bc?.validForValidation === false) {
    // the page's own decision (validity.ts) wins; its reasons already cover the ruler, checklist, flatness and coin
    for (const r of bc.notValidReasons.length ? bc.notValidReasons : ["no reason given"]) if (!/refused|No measurements/.test(r) || !reasons.length) reasons.push(`not valid for validation (page): ${r}`);
  } else if (bc?.validForValidation !== true)
    for (const [k, v] of [["ruler", bc?.ruler ?? null], ["flatness", bc?.flatness ?? null], ["coin", bc?.coin ?? null]] as const)
      if (isFail(v)) reasons.push(`board check ${k}: ${v!.verdict}${v!.reasons.length ? ` (${v!.reasons.join("; ")})` : ""}`);
  return { status: reasons.length ? "rejected" : "accepted", reasons };
}

function valuesOf(c: CaptureRecord): Record<string, CaptureValue> {
  const out: Record<string, CaptureValue> = {};
  const withheld = c.coinCheck?.scaleWrong === true;
  const meshQ = c.reconstruction
    ? meshDimensions({
        mesh: c.mesh?.mesh ?? null,
        support: c.mesh?.support ?? null,
        supportLabels: c.mesh?.supportLabels ?? [],
        frame: c.handFrame,
        frameMissing: c.handFrameMissing,
        fingers: c.fingerAxes,
      })
    : {};
  for (const m of MAPPING) {
    let q: Quantity | null;
    let absent: string;
    if (!c.reconstruction) {
      out[m.dimension] = { value: null, basis: null, missing: c.refused ? "capture refused: nothing measured" : "no reconstruction in the export", note: "" };
      continue;
    }
    if (m.source.kind === "measurement") {
      q = quantityAt(c.reconstruction.measurements, m.source.path);
      absent = c.reconstruction.measurements ? `not in the export (measurements.${m.source.path})` : "no measurements in the export (no hand frame)";
    } else {
      q = meshQ[m.source.key] ?? null;
      absent = "not computed";
    }
    if (!q) out[m.dimension] = { value: null, basis: null, missing: absent, note: "" };
    else if (q.basis === "none" || q.value === null) out[m.dimension] = { value: null, basis: q.basis, missing: q.note ? `not available: ${q.note}` : "not available (basis none)", note: q.note };
    else if (q.unit !== "mm") out[m.dimension] = { value: null, basis: q.basis, missing: `unit ${q.unit}, not mm`, note: q.note };
    else if (withheld) out[m.dimension] = { value: null, basis: q.basis, missing: "withheld: the board print scale check failed", note: q.note };
    else out[m.dimension] = { value: q.value, basis: q.basis, missing: null, note: q.note };
  }
  return out;
}

export function summarizeCapture(c: CaptureRecord, phantomId: string, referenceSynthetic = false): CaptureSummary {
  const { status, reasons } = classify(c, phantomId, referenceSynthetic);
  const poses = c.views.map((v) => v.poseRmsPx).filter((x): x is number => x !== null);
  const usedViews = c.views.filter((v) => v.poseRmsPx !== null && !v.rejected);
  const residuals = c.views.flatMap((v) => v.markerResiduals.map((m) => m.rmsPx));
  return {
    name: c.name,
    status,
    reasons,
    phantomId: c.run?.phantomId ?? null,
    sessionId: c.run?.sessionId ?? "(session not recorded)",
    sessionRecorded: !!c.run?.sessionId,
    captureIndex: c.run?.captureIndex ?? null,
    operatorCode: c.run?.operatorCode ?? null,
    conditions: c.run?.conditions.length ? c.run.conditions : ["untagged"],
    calibrationRmsPx: c.calibration?.rmsPx ?? null,
    focalPx: c.calibration?.fx ?? null,
    poseRmsPx: { median: poses.length ? median(poses) : null, max: poses.length ? Math.max(...poses) : null, views: poses.length },
    viewsUsed: usedViews.length,
    viewsRejected: c.views.filter((v) => v.rejected).map((v) => ({ id: v.id, reason: v.rejected! })),
    markerResidualMaxPx: residuals.length ? Math.max(...residuals) : null,
    completeness: c.reconstruction?.completeness ?? null,
    supportShare: c.reconstruction?.supportShare ?? null,
    processingMs: c.timings.workerTotalMs ?? c.timings.chainTotalMs,
    boardCheck: c.boardCheck ? { ruler: c.boardCheck.ruler?.verdict ?? null, flatness: c.boardCheck.flatness?.verdict ?? null, coin: c.boardCheck.coin?.verdict ?? null } : null,
    coinPrintScale: c.coinCheck?.printScale ?? null,
    problems: c.problems,
    values: status === "unreadable" || status === "excluded" ? {} : valuesOf(c),
  };
}

function agreement(pairs: { estimate: number; reference: number }[]): AgreementStats | null {
  const s = errorStats(pairs);
  if (!s) return null;
  return { ...s, loaLow: s.n >= 2 ? s.bias - 1.96 * s.sd : null, loaHigh: s.n >= 2 ? s.bias + 1.96 * s.sd : null };
}

export function compareCaptures(captures: readonly CaptureRecord[], reference: CheckedReference): Comparison {
  const summaries = captures.map((c) => summarizeCapture(c, reference.phantomId, reference.synthetic));
  const counts = { accepted: 0, rejected: 0, refused: 0, unreadable: 0, excluded: 0, total: summaries.length } as Comparison["counts"];
  for (const s of summaries) counts[s.status]++;
  const reasonMap = new Map<string, number>();
  for (const s of summaries) for (const r of s.reasons) {
    const key = r.replace(/ \(.*\)$/, "");
    reasonMap.set(key, (reasonMap.get(key) ?? 0) + 1);
  }
  const considered = summaries.filter((s) => s.status !== "excluded" && s.status !== "unreadable");
  const accepted = summaries.filter((s) => s.status === "accepted");
  const refDims = new Map(reference.dimensions.map((d) => [d.name, d]));
  const mapped = MAPPING.filter((m) => refDims.has(m.dimension));
  const dimResult = (m: MappingRow, pool: readonly CaptureSummary[], all: readonly CaptureSummary[]): DimensionResult => {
    const ref = refDims.get(m.dimension)!;
    const withValue = all.filter((s) => s.values[m.dimension]?.value !== null && s.values[m.dimension] !== undefined);
    const used = pool.filter((s) => s.values[m.dimension]?.value !== null && s.values[m.dimension] !== undefined);
    const errors = used.map((s) => ({ capture: s.name, session: s.sessionId, valueMm: s.values[m.dimension].value!, errorMm: s.values[m.dimension].value! - ref.agreedMm }));
    const stats = agreement(errors.map((e) => ({ estimate: e.valueMm, reference: ref.agreedMm })));
    const miss = new Map<string, number>();
    for (const s of all) {
      const v = s.values[m.dimension];
      if (v && v.missing) miss.set(v.missing, (miss.get(v.missing) ?? 0) + 1);
    }
    return {
      dimension: m.dimension,
      relation: m.relation,
      software: m.software,
      mappingNote: m.note,
      reference: { agreedMm: ref.agreedMm, agreedMethod: ref.agreedMethod, floorSdMm: ref.floorSdMm, intraRaterSdMm: ref.intraRaterSdMm, interRaterSdMm: ref.interRaterSdMm, definition: ref.definition, n: ref.n },
      capturesConsidered: all.length,
      capturesWithValue: withValue.length,
      shareProduced: all.length ? withValue.length / all.length : null,
      n: used.length,
      stats,
      errors,
      repeatability: repeatabilityBySession(errors.map((e) => ({ session: e.session, value: e.valueMm }))),
      biasWithinReferenceFloor: stats ? Math.abs(stats.bias) <= ref.floorSdMm : null,
      missingReasons: [...miss.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    };
  };
  const dimensions = mapped.map((m) => dimResult(m, accepted, considered));

  // by condition
  const tags = [...new Set(considered.flatMap((s) => s.conditions))].sort((a, b) => (a === "baseline" ? -1 : b === "baseline" ? 1 : a.localeCompare(b)));
  const baselineBias = new Map(dimensions.map((d) => [d.dimension, null as number | null]));
  if (tags.includes("baseline")) {
    const base = accepted.filter((s) => s.conditions.includes("baseline"));
    for (const m of mapped) baselineBias.set(m.dimension, dimResult(m, base, base).stats?.bias ?? null);
  }
  const conditions: ConditionResult[] = tags.map((tag) => {
    const inTag = considered.filter((s) => s.conditions.includes(tag));
    const acc = inTag.filter((s) => s.status === "accepted");
    return {
      condition: tag,
      captures: inTag.length,
      accepted: acc.length,
      rejected: inTag.filter((s) => s.status === "rejected").length,
      refused: inTag.filter((s) => s.status === "refused").length,
      dimensions: mapped.map((m) => {
        const st = dimResult(m, acc, inTag).stats;
        const b = baselineBias.get(m.dimension) ?? null;
        return { dimension: m.dimension, relation: m.relation, n: st?.n ?? 0, biasMm: st?.bias ?? null, maeMm: st?.mae ?? null, biasShiftVsBaselineMm: tag !== "baseline" && st && b !== null ? st.bias - b : null };
      }),
    };
  });

  const labels = [...new Set(considered.flatMap((s) => Object.keys(s.supportShare ?? {})))];
  const notes = [
    `${counts.total} capture(s) of ONE phantom (${reference.phantomId}): n counts repeated captures of one rigid object, not participants; nothing here estimates accuracy on people.`,
    "Errors are value minus the reference's agreed value; only accepted captures enter the statistics; missing values are counted, never set to zero.",
  ];
  const noPhantom = considered.filter((s) => !s.phantomId).length;
  if (noPhantom) notes.push(`${noPhantom} capture(s) do not record a phantom id (run.phantom_id): they were assumed to show ${reference.phantomId}; record it on the page's validation mode.`);
  if (considered.some((s) => !s.sessionRecorded)) notes.push("Some captures carry no session id (run.session_id): they are pooled as one unknown session for repeatability.");
  return {
    phantomId: reference.phantomId,
    captures: summaries,
    counts,
    reasonCounts: [...reasonMap.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    dimensions,
    referenceOnly: reference.dimensions.filter((d) => !MAPPING.some((m) => m.dimension === d.name)).map((d) => d.name),
    notInReference: MAPPING.filter((m) => !refDims.has(m.dimension)).map((m) => m.dimension),
    conditions,
    processingMs: distribution(considered.map((s) => s.processingMs)),
    calibrationRmsPx: distribution(considered.map((s) => s.calibrationRmsPx)),
    poseRmsPx: distribution(considered.flatMap((s) => (s.poseRmsPx.median !== null ? [s.poseRmsPx.median] : []))),
    completeness: distribution(considered.map((s) => s.completeness)),
    supportShare: Object.fromEntries(labels.map((l) => [l, distribution(considered.map((s) => s.supportShare?.[l] ?? null))])),
    sessions: [...new Set(considered.map((s) => s.sessionId))].sort(),
    notes,
  };
}
