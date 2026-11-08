// The board PRINT check before a capture (EXPERIMENTAL validation mode): ruler readings of the printed sheet against the
// layout, and a checklist of how the sheet lies. Pure (unit-tested). The expected lengths are computed FROM the layout
// (board/spec.ts), never typed in: one marker's black square, the outer span of the top row (left edge of its first
// marker to the right edge of its last) and the outer span of the right column (top edge of its upper marker to the
// bottom edge of its lower).
//
// PROVISIONAL TOLERANCES (a design choice for the first phantom session, not validated):
//   square        +- 0.3 mm on each side (about 1 %, the width of a ruler's tick)
//   spans         +- 0.5 % of the expected span
//   x / y scale   the horizontal scale (top-row span) and the vertical scale (right-column span) agree within 0.5 %:
//                 catches a printer that scales one direction only. Read to 0.5 mm, the 70 mm column alone is
//                 uncertain by about 0.7 %: read it carefully (between the ticks, or with calipers).
import { BOARD, type BoardLayout } from "../../board/spec";

export interface RulerExpected {
  square_mm: number;
  long_span_mm: number;
  short_span_mm: number;
}

export interface RulerReadings {
  squareXmm: number | null;
  squareYmm: number | null;
  longSpanMm: number | null;
  shortSpanMm: number | null;
}

export type RulerVerdict = "pass" | "reprint" | "not_entered";

export interface RulerCheck {
  readings: RulerReadings;
  expected: RulerExpected;
  verdict: RulerVerdict;
  /** Reasons in words (one per failed reading, or the pass sentence). */
  reasons: string[];
  /** Horizontal and vertical print scales implied by the spans (1 = 100 %), when entered. */
  scaleX: number | null;
  scaleY: number | null;
}

export const RULER_TOLERANCE = { squareMm: 0.3, spanFraction: 0.005, anisotropyFraction: 0.005 } as const;

export const REPRINT_WORDS = "Reprint at 100 % / actual size";

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const num = (v: number) => String(round(v, 2));

/** The expected ruler readings of a correctly printed board, from its layout. */
export function expectedRuler(layout: BoardLayout = BOARD): RulerExpected {
  const s = layout.markerMm;
  const maxY = Math.max(...layout.markers.map((m) => m.y));
  const minY = Math.min(...layout.markers.map((m) => m.y));
  const maxX = Math.max(...layout.markers.map((m) => m.x));
  const top = layout.markers.filter((m) => m.y === maxY);
  // the right column: markers at the rightmost x that belong to neither row
  const column = layout.markers.filter((m) => m.x === maxX && m.y !== maxY && m.y !== minY);
  return {
    square_mm: round(s),
    long_span_mm: round(Math.max(...top.map((m) => m.x)) + s - Math.min(...top.map((m) => m.x))),
    short_span_mm: column.length ? round(Math.max(...column.map((m) => m.y)) + s - Math.min(...column.map((m) => m.y))) : NaN,
  };
}

/** Parse a ruler reading typed by a person ("30", "29.8", "29,8"); null for empty or implausible input. */
export function parseMm(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d{1,4}(\.\d{1,3})?$/.test(t)) return null;
  const v = Number(t);
  return v > 0 && v < 1000 ? v : null;
}

export function rulerCheck(readings: RulerReadings, layout: BoardLayout = BOARD): RulerCheck {
  const expected = expectedRuler(layout);
  const { squareXmm, squareYmm, longSpanMm, shortSpanMm } = readings;
  if ([squareXmm, squareYmm, longSpanMm, shortSpanMm].some((v) => v === null || !Number.isFinite(v)))
    return { readings, expected, verdict: "not_entered", reasons: ["Enter all four ruler readings (in millimetres)."], scaleX: null, scaleY: null };
  const T = RULER_TOLERANCE;
  const reasons: string[] = [];
  const sq = (label: string, v: number) => {
    if (Math.abs(v - expected.square_mm) > T.squareMm) reasons.push(`The marker square's ${label} reads ${num(v)} mm, expected ${expected.square_mm.toFixed(1)} ± ${T.squareMm} mm.`);
  };
  sq("width", squareXmm!);
  sq("height", squareYmm!);
  const span = (label: string, v: number, e: number) => {
    if (Math.abs(v - e) > T.spanFraction * e) reasons.push(`The ${label} reads ${num(v)} mm, expected ${e.toFixed(1)} mm ± ${(T.spanFraction * 100).toFixed(1)} % (± ${(T.spanFraction * e).toFixed(2)} mm).`);
  };
  span("top row's outer span", longSpanMm!, expected.long_span_mm);
  span("right column's outer span", shortSpanMm!, expected.short_span_mm);
  const scaleX = longSpanMm! / expected.long_span_mm;
  const scaleY = shortSpanMm! / expected.short_span_mm;
  if (Math.abs(scaleX - scaleY) > T.anisotropyFraction)
    reasons.push(
      `The print is scaled differently across and down the page (${(scaleX * 100).toFixed(1)} % across, ${(scaleY * 100).toFixed(1)} % down; they must agree within ${(T.anisotropyFraction * 100).toFixed(1)} %).`,
    );
  if (reasons.length) return { readings, expected, verdict: "reprint", reasons: [...reasons, `${REPRINT_WORDS}: a scaled print makes every millimetre wrong.`], scaleX, scaleY };
  return {
    readings,
    expected,
    verdict: "pass",
    reasons: [`Every reading is within the provisional tolerance (square ± ${T.squareMm} mm, spans ± ${(T.spanFraction * 100).toFixed(1)} %, across and down within ${(T.anisotropyFraction * 100).toFixed(1)} %).`],
    scaleX,
    scaleY,
  };
}

// ------------------------------------------------------------------------------------------------ the checklist

export type ChecklistKey = "matte" | "flat" | "noGlare";

export const CHECKLIST: { key: ChecklistKey; words: string; waivedBy?: string }[] = [
  { key: "matte", words: "Printed on plain matte paper, not glossy." },
  { key: "flat", words: "Lying flat (taped at the corners or on a clipboard): no curl, no folds.", waivedBy: "board_curl" },
  { key: "noGlare", words: "No glare spot on the markers from the main light.", waivedBy: "glare" },
];

export type Checklist = Record<ChecklistKey, boolean>;

export const EMPTY_CHECKLIST: Checklist = { matte: false, flat: false, noGlare: false };

/** Checklist items not ticked; an item is waived when the run is tagged with the condition it deliberately breaks. */
export function checklistMissing(list: Checklist, conditions: readonly string[]): ChecklistKey[] {
  return CHECKLIST.filter((c) => !list[c.key] && !(c.waivedBy && conditions.includes(c.waivedBy))).map((c) => c.key);
}
