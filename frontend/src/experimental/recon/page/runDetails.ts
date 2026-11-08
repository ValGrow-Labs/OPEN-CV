// Test-run details of a validation capture (EXPERIMENTAL, `?validation`): which phantom, which session, which capture,
// who operated (a CODE, never a name), the test conditions and free notes. Held in memory only: the page stores nothing
// in the browser. Pure (unit-tested).

export const CONDITIONS = ["baseline", "glare", "shadow", "board_curl", "partial_markers", "far", "near", "low_light", "other"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const CONDITION_WORDS: Record<Condition, string> = {
  baseline: "baseline",
  glare: "glare",
  shadow: "shadow",
  board_curl: "board curl",
  partial_markers: "partial markers",
  far: "far",
  near: "near",
  low_light: "low light",
  other: "other",
};

export interface RunDetails {
  phantomId: string;
  sessionId: string;
  /** 1, 2, 3 ... within the session; incremented in memory after each export. */
  captureIndex: number;
  operatorCode: string;
  conditions: Condition[];
  notes: string;
}

export const EMPTY_RUN: RunDetails = { phantomId: "", sessionId: "", captureIndex: 1, operatorCode: "", conditions: [], notes: "" };

export const NOTES_MAX = 500;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** An operator code: 2 to 12 letters, digits, "-" or "_", with at least one digit (e.g. OP01), so a plain name is refused. */
const OPERATOR_RE = /^(?=.*\d)[A-Za-z0-9_-]{2,12}$/;

/** What is missing or wrong, in words (empty = complete). */
export function runProblems(r: RunDetails): string[] {
  const out: string[] = [];
  if (!ID_RE.test(r.phantomId.trim())) out.push("Phantom id: letters, digits, '.', '_' or '-' (up to 32), e.g. PH01.");
  if (!ID_RE.test(r.sessionId.trim())) out.push("Session id: letters, digits, '.', '_' or '-' (up to 32), e.g. S2026-11-08a.");
  if (!Number.isInteger(r.captureIndex) || r.captureIndex < 1 || r.captureIndex > 9999) out.push("Capture index: a whole number from 1.");
  if (!OPERATOR_RE.test(r.operatorCode.trim())) out.push("Operator code: a code with at least one digit (2 to 12 letters, digits, '-' or '_'), e.g. OP01. Never a name.");
  if (r.conditions.length === 0) out.push("Tick at least one condition (baseline when nothing is changed on purpose).");
  if (r.notes.length > NOTES_MAX) out.push(`Notes: at most ${NOTES_MAX} characters.`);
  return out;
}

export function toggleCondition(list: readonly Condition[], c: Condition, on: boolean): Condition[] {
  const set = new Set(list);
  if (on) set.add(c);
  else set.delete(c);
  return CONDITIONS.filter((x) => set.has(x));
}

/** The `run` object of reconstruction.json (exact field names read by the offline report tool). */
export function runJson(r: RunDetails | null): { phantom_id: string | null; session_id: string | null; capture_index: number | null; operator_code: string | null; conditions: string[]; notes: string } {
  if (!r) return { phantom_id: null, session_id: null, capture_index: null, operator_code: null, conditions: [], notes: "" };
  const s = (v: string) => (v.trim() ? v.trim() : null);
  return { phantom_id: s(r.phantomId), session_id: s(r.sessionId), capture_index: r.captureIndex, operator_code: s(r.operatorCode), conditions: [...r.conditions], notes: r.notes.slice(0, NOTES_MAX) };
}
