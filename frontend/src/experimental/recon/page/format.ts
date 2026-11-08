// Words and numbers for the result of the EXPERIMENTAL board reconstruction: every quality reason in plain language, the
// measurements with their basis (direct / model / not available: never a number for a value that is not there), the
// camera calibration, the coin print-scale check and the per-view table. Pure functions (unit-tested).
import type { Quantity } from "../../common";
import type { HandMeasurements } from "../../reconstruction/measure";
import type { ReconstructionQuality } from "../../reconstruction/quality";
import { REFUSAL_WORDS, type ChainRefusal, type ChainResult } from "../chain";
import type { Capture, CoinCheckSummary, ReconOutcome } from "./types";

/** Largest print-scale error before the measurements are withheld. */
export const MAX_PRINT_SCALE_ERROR = 0.02;

export const PRINT_SCALE_WARNING = "The board was probably not printed at 100 %; every millimetre is scaled wrongly.";

export const RESULT_CAPTION = (n: number) =>
  `EXPERIMENTAL: a visual-hull reconstruction from ${n} photo${n === 1 ? "" : "s"}. The palm side rests on the board and is not observed. Not validated against physical measurements.`;

/** Every reason code the chain can give (reconstruction/quality.ts gates, multiview/reconstruct.ts), in words. */
export const REASON_WORDS: Record<string, string> = {
  too_few_views: "Too few pictures were used for the 3D shape.",
  views_do_not_surround_hand: "The pictures do not surround the hand: some direction round it has no view, so that side of the hand is not bounded.",
  surface_poorly_observed: "Less than half of the surface was seen on an outline in any picture: most of the shape is inferred, not observed.",
  surface_not_constrained: "Too much of the surface is not constrained by any picture.",
  mesh_not_watertight: "The surface is not closed (it has holes), so sections and circumferences cannot be trusted.",
  fragmented_mesh: "The surface fell apart into separate pieces (often a hand that moved or a wrong outline in some picture).",
  reprojection_mismatch:
    "The 3D shape does not match the hand's outline in some pictures: a camera position, the calibration, an outline, or a hand that moved is wrong.",
  hull_truncated_by_volume:
    "Part of the surface lies on the edge of the search box, not on the hand: the hand probably reaches outside the hand area (keep it inside, fingertips short of the coin).",
  sides_not_observed: "No picture looks at the hand from low enough, so its thickness is not bounded (the lowest view is too high).",
  no_hand_frame:
    "The hand's landmarks could not be placed in 3D (MediaPipe did not find the hand in enough pictures), so there is no hand frame: lengths, breadth, thickness and circumference cannot be measured.",
  hand_frame_from_one_view:
    "The hand's landmarks were found in only one picture looking down, so they were placed on the 3D shape from that picture, with each joint assumed at half the hand's height above the board. Lengths, breadth and circumference rest on that assumption (model estimates).",
  views_disagree: "In some pictures the hand's landmarks disagree with the other pictures (the hand may have moved, or a camera position is wrong); those pictures were left out.",
  views_disagree_broadly:
    "The landmarks disagree in more than a quarter of the pictures: the hand moved or the camera positions are wrong. Nothing was left out; the result is unreliable.",
  "no mesh": "No surface could be built.",
};

/** A reason in words (an unknown code is shown as itself, never hidden). */
export function reasonWords(code: string): string {
  return REASON_WORDS[code] ?? (code.includes(" ") ? `${code.charAt(0).toUpperCase()}${code.slice(1)}.` : `Unexplained reason: ${code}.`);
}

const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)} %`;

/** The measured value behind a quality reason, when the quality report has it. */
export function reasonDetail(code: string, q: ReconstructionQuality | null): string | null {
  if (!q) return null;
  const m = q.metrics, t = q.thresholds;
  switch (code) {
    case "too_few_views":
      return `${m.views} used (needs ${t.minViews}).`;
    case "views_do_not_surround_hand":
      return `Largest gap round the hand ${Math.round(m.maxAzimuthGapDeg)}° (limit ${t.maxAzimuthGapDeg}°).`;
    case "surface_poorly_observed":
      return `Observed share ${pct(m.completeness)} (needs ${pct(t.minCompleteness)}).`;
    case "surface_not_constrained":
      return m.unconstrainedSurface === null ? null : `Unconstrained share ${pct(m.unconstrainedSurface)} (limit ${pct(t.maxUnconstrainedSurface)}).`;
    case "mesh_not_watertight":
      return `${m.topology.holes} hole(s), ${m.topology.boundaryEdges} open edge(s).`;
    case "fragmented_mesh":
      return `${m.topology.components} pieces (limit ${t.maxComponents}).`;
    case "reprojection_mismatch":
      return `Outline overlap: mean ${m.meanIoU.toFixed(3)} (needs ${t.minMeanIoU}), worst ${m.minIoU.toFixed(3)} (needs ${t.minMinIoU}).`;
    case "hull_truncated_by_volume":
      return m.truncatedSurface === null ? null : `${pct(m.truncatedSurface, 1)} of the surface on the box edges (limit ${pct(t.maxTruncatedSurface)}).`;
    case "sides_not_observed":
      return `Lowest view ${m.lowestElevationDeg.toFixed(1)}° above the hand's plane (limit ${t.maxLowestElevationDeg}°).`;
    default:
      return null;
  }
}

export function refusalWords(code: ChainRefusal | null, words: string | null): string | null {
  if (!code) return null;
  return words ?? REFUSAL_WORDS[code] ?? code;
}

// ------------------------------------------------------------------------------------------------ measurements

export const BASIS_WORDS: Record<Quantity["basis"], string> = {
  direct: "direct: read off the reconstructed surface",
  model: "model: also rests on an estimate (the hand frame from MediaPipe landmarks, an assumed knuckle line)",
  none: "not available",
};

export function formatValue(q: Quantity | null | undefined): string {
  if (!q || q.value === null || q.basis === "none" || !Number.isFinite(q.value)) return "not available";
  if (q.unit === "mm2") return `${Math.round(q.value).toLocaleString("en-GB")} mm²`;
  if (q.unit === "mm") return `${q.value.toFixed(1)} mm`;
  return `${q.value.toFixed(2)} ${q.unit}`;
}

export interface MeasurementRow {
  key: string;
  label: string;
  /** The value in words: a number with its unit, "not available", or "withheld". */
  value: string;
  shown: boolean;
  basis: string;
  note: string;
  /** "upper" when the value is only an upper bound (the board capture's knuckle circumference): shown next to it. */
  bound: "upper" | null;
  /** A short limitation said in the table itself, not only behind "why" (an upper bound; not available from a board
   *  capture). */
  flag: string | null;
}

/** The visible words for an upper bound and for a value a board capture cannot give (from multiview/reconstruct.ts
 *  boardLimits' notes). */
export const UPPER_BOUND_WORDS = "UPPER BOUND: the palm side of this loop is the board plane (not observed) and the visual hull fills the hollows, so the hand's real circumference is at most this value, probably less.";
export const NOT_FROM_BOARD_WORDS = "Not available from a board capture: the palm side rests on the board and is not observed.";

function flagOf(q: Quantity | null): { bound: "upper" | null; flag: string | null } {
  const note = q?.note ?? "";
  if (/^UPPER BOUND/.test(note) && q && q.value !== null) return { bound: "upper", flag: UPPER_BOUND_WORDS };
  if (/^not available from a board capture/i.test(note)) return { bound: null, flag: NOT_FROM_BOARD_WORDS };
  return { bound: null, flag: null };
}

const ROWS: { key: string; label: string; get: (m: HandMeasurements) => Quantity }[] = [
  { key: "handLength", label: "Hand length (wrist to fingertip)", get: (m) => m.handLength },
  { key: "palmBreadth", label: "Palm breadth", get: (m) => m.palmBreadth },
  { key: "palmThickness", label: "Palm thickness", get: (m) => m.palmThickness },
  { key: "circumferenceKnuckle", label: "Knuckle circumference", get: (m) => m.circumferenceKnuckle },
  { key: "thumb", label: "Thumb length", get: (m) => m.fingerLengths.thumb },
  { key: "index", label: "Index finger length", get: (m) => m.fingerLengths.index },
  { key: "middle", label: "Middle finger length", get: (m) => m.fingerLengths.middle },
  { key: "ring", label: "Ring finger length", get: (m) => m.fingerLengths.ring },
  { key: "little", label: "Little finger length", get: (m) => m.fingerLengths.little },
  { key: "surfaceArea", label: "Hand surface area", get: (m) => m.surfaceArea },
];

/** The measurement table. With no measurements every row says "not available" (the reason, `missingNote`, is shown once
 *  above the table by the page, not on every row); with `withheld` set
 *  (e.g. a wrongly scaled print) no number is shown at all. */
export function measurementRows(m: HandMeasurements | null, opts: { missingNote: string; withheld?: string | null }): MeasurementRow[] {
  return ROWS.map((r) => {
    const q = m ? r.get(m) : null;
    const available = !!q && q.value !== null && q.basis !== "none" && Number.isFinite(q.value);
    const f = flagOf(q);
    if (opts.withheld && available) return { key: r.key, label: r.label, value: "withheld", shown: false, basis: BASIS_WORDS[q!.basis], note: opts.withheld, ...f };
    return {
      key: r.key,
      label: r.label,
      value: available ? formatValue(q) : "not available",
      shown: available,
      basis: available ? BASIS_WORDS[q!.basis] : BASIS_WORDS.none,
      // without any measurements the reason is said once above the table, not on every row
      note: q ? q.note || (available ? "" : "no value") : "",
      ...f,
    };
  });
}

// ------------------------------------------------------------------------------------------------ calibration, coin

export interface CalibrationView {
  method: string;
  assumed: boolean;
  focalPx: string;
  focalStd: string | null;
  k1: string;
  k2: string | null;
  rmsPx: string;
  warnings: string[];
}

export function calibrationView(cal: NonNullable<ChainResult["cameras"]>["calibration"]): CalibrationView {
  const K = cal.intrinsics;
  if (cal.assumed)
    return {
      method: `ASSUMED field of view (${cal.hfovDeg.toFixed(1)}°): not measured`,
      assumed: true,
      focalPx: `${K.fx.toFixed(1)} px (assumed; anywhere in ${cal.focalRangePx[0].toFixed(0)} to ${cal.focalRangePx[1].toFixed(0)} px)`,
      focalStd: null,
      k1: "not estimated",
      k2: null,
      rmsPx: "not available",
      warnings: [`The focal length is assumed (${cal.reason}): every millimetre could be scaled wrongly, so nothing is measured.`],
    };
  return {
    method: "self-calibration from the printed markers in every picture (Zhang)",
    assumed: false,
    focalPx: `${K.fx.toFixed(1)} px`,
    focalStd: cal.std?.fx ? `± ${cal.std.fx.toFixed(1)} px (${((cal.std.fx / K.fx) * 100).toFixed(2)} %, one sigma)` : null,
    k1: (K.k1 ?? 0).toFixed(4),
    k2: K.k2 !== undefined ? K.k2.toFixed(4) : null,
    rmsPx: `${cal.rmsPx.toFixed(2)} px`,
    warnings: [...(cal.warnings ?? []), ...(cal.degeneracy?.degenerate ? cal.degeneracy.reasons : [])],
  };
}

export const COIN_REASON_WORDS: Record<string, string> = {
  view_too_oblique: "The top view is too low to measure the coin (it needs to be 45° or more above the board).",
  outside_image: "The coin's place is outside the top picture.",
  no_edge: "No coin edge was found at the coin's place: is the coin between the four grey ticks?",
  fit_failed: "The coin's outline could not be fitted.",
  poor_fit: "The coin's outline does not fit a circle well (glare, a shadow, or the coin is not flat).",
  low_contrast: "The coin hardly differs from the paper (glare or a very light coin on white paper).",
  not_a_disc: "What lies at the coin's place is not round.",
  implausible_size: "The coin's size is implausible: a different coin, or a badly scaled print.",
  not_calibrated: "The camera was not calibrated, so the coin could not be measured.",
  no_top_pose: "The top view has no board pose, so the coin could not be measured.",
};

export interface CoinView {
  checked: boolean;
  measured: string;
  printScale: string | null;
  offPercent: number | null;
  /** True when the print scale is off by more than MAX_PRINT_SCALE_ERROR: measurements must not be shown as valid. */
  scaleWrong: boolean;
  words: string;
}

export function coinView(c: CoinCheckSummary | null, coinLabel: string): CoinView {
  const unchecked = "Print scale not checked: make sure each black square measures 30.0 mm with a ruler.";
  if (!c) return { checked: false, measured: "not measured", printScale: null, offPercent: null, scaleWrong: false, words: `No coin entry from the served settings. ${unchecked}` };
  if (!c.ok || c.printScale === undefined || c.diameterMm === undefined)
    return { checked: false, measured: "not measured", printScale: null, offPercent: null, scaleWrong: false, words: `${COIN_REASON_WORDS[c.reason ?? ""] ?? c.detail ?? "The coin could not be measured."} ${unchecked}` };
  const off = (c.printScale - 1) * 100;
  const wrong = Math.abs(c.printScale - 1) > MAX_PRINT_SCALE_ERROR;
  return {
    checked: true,
    measured: `${c.diameterMm.toFixed(2)} mm on the board (${coinLabel}: ${c.referenceDiameterMm} mm${c.thicknessMm ? "" : "; its thickness is not in the settings, so the raised top face is not modelled"})`,
    printScale: `${(c.printScale * 100).toFixed(1)} % (${off >= 0 ? "+" : ""}${off.toFixed(1)} %)`,
    offPercent: off,
    scaleWrong: wrong,
    words: wrong
      ? `${PRINT_SCALE_WARNING} (the coin implies ${(c.printScale * 100).toFixed(1)} %). Reprint at 100 % / actual size; the measurements are withheld.`
      : `The coin agrees with a print at 100 % within ${(MAX_PRINT_SCALE_ERROR * 100).toFixed(0)} % (a check of the scale, not a validation).${c.thicknessMm ? "" : " The coin's raised edge makes it read slightly large (its thickness is not in the settings), so a small negative offset is expected."}`,
  };
}

// ------------------------------------------------------------------------------------------------ per-view table

export interface ViewRow {
  id: string;
  position: string;
  liveMarkers: number;
  markers: string;
  elevation: string;
  azimuth: string;
  landmarks: string;
  used: string;
  handMoved: string;
}

export function viewRows(captures: readonly Capture[], outcome: ReconOutcome | null, binText: (c: Capture) => string): ViewRow[] {
  const chain = outcome?.chain ?? null;
  const rec = chain?.reconstruction ?? null;
  const tri = rec?.landmarks ?? null;
  return captures.map((c, i) => {
    const cam = chain?.cameras?.views[i] ?? null;
    const rv = rec?.views.find((v) => v.id === c.id) ?? null;
    const agree = tri?.views.find((v) => v.id === c.id) ?? null;
    let used: string;
    if (!chain) used = "not built yet";
    else if (cam && !cam.pose) used = `not used: ${cam.rejected ?? "no pose"}`;
    else if (cam?.rejected) used = `not used: ${cam.rejected}`;
    else if (!rec) used = chain.refused ? "has a pose; nothing reconstructed (refused)" : "not reconstructed";
    else if (rv && !rv.used) used = `not used: ${rv.rejected ?? "left out"}`;
    else if (rv) used = `used${rv.reprojectionIoU !== null ? ` (outline overlap ${rv.reprojectionIoU.toFixed(3)})` : ""}`;
    else used = "not used";
    let handMoved: string;
    const withLandmarks = captures.filter((x) => x.landmarks).length;
    if (!c.landmarks) handMoved = "not checked (no landmarks)";
    else if (withLandmarks < 2) handMoved = "not checked (only this view has landmarks)";
    else if (!tri || !agree) handMoved = rec ? "not checked" : "—";
    else if (tri.disagreeingViews.includes(c.id)) handMoved = `disagrees: the hand may have moved (median ${agree.looMedianPx?.toFixed(1) ?? "?"} px)`;
    else handMoved = `agrees${agree.medianPx !== null ? ` (median ${agree.medianPx.toFixed(1)} px)` : ""}`;
    const live = `${Math.round(c.elevationDeg)}° live`;
    return {
      id: c.id,
      position: binText(c),
      liveMarkers: c.markers,
      markers: cam ? `${cam.markers}${cam.inconsistentMarkers.length ? ` (+${cam.inconsistentMarkers.length} misread)` : ""}` : `${c.markers} (live)`,
      elevation: cam?.elevationDeg != null ? `${cam.elevationDeg.toFixed(1)}°` : live,
      azimuth: cam?.azimuthDeg != null ? `${cam.azimuthDeg.toFixed(1)}°` : `${Math.round(c.azimuthDeg)}° live`,
      landmarks: c.landmarks ? `${c.landmarks.length}` : "none found",
      used,
      handMoved,
    };
  });
}

/** Support-label shares as percentages, in the viewer's words. */
export const SUPPORT_WORDS: Record<string, string> = {
  observed: "observed (an outline passes through it)",
  implied: "implied (inside every outline, no outline touches it)",
  support_plane: "bounded by the board, not observed (the palm side)",
  volume_cut: "cut where the forearm leaves the volume",
  truncated: "truncated by the search box (a failure)",
};

export function supportShareRows(share: Record<string, number> | null): { label: string; percent: string }[] {
  if (!share) return [];
  return Object.entries(share).map(([k, v]) => ({ label: SUPPORT_WORDS[k] ?? k, percent: `${(v * 100).toFixed(1)} %` }));
}

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}
