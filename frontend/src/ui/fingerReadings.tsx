// Finger readings for the validation screen (protocol FL-1, docs/PILOT_PROTOCOL.md): two readings per datum, crease to tip
// (the glove-industry definition) and knuckle to tip, typed by the operator. The server converts units, checks agreement and
// computes every error; this only collects numbers and catches obvious typos before they are sent.
import type { FingerName, FingerReading, LengthUnit, ValidationReference } from "../api/types";
import { toMm } from "./pilot";

export const FINGER_NAMES: readonly FingerName[] = ["thumb", "index", "middle", "ring", "little"];
const LABEL: Record<FingerName, string> = { thumb: "Thumb", index: "Index", middle: "Middle", ring: "Ring", little: "Little" };
/** Plausible adult ranges in mm, the same as the server's (validation_records.RANGES_MM). */
export const FINGER_RANGES_MM = { crease_to_tip: [25, 130], knuckle_to_tip: [35, 150] } as const;

type Datum = keyof typeof FINGER_RANGES_MM;
export type FingerInputs = Record<FingerName, Record<Datum, [string, string]>>;

export function emptyFingers(): FingerInputs {
  const out = {} as FingerInputs;
  for (const f of FINGER_NAMES) out[f] = { crease_to_tip: ["", ""], knuckle_to_tip: ["", ""] };
  return out;
}

const num = (s: string): number | undefined => {
  const v = Number(s.trim().replace(",", "."));
  return s.trim() !== "" && Number.isFinite(v) && v > 0 ? v : undefined;
};

/** The fingers that have at least one reading, as the API expects them; undefined when none were typed. */
export function fingersPayload(inputs: FingerInputs, unit: LengthUnit): ValidationReference["fingers"] {
  const out: Partial<Record<FingerName, FingerReading>> = {};
  for (const f of FINGER_NAMES) {
    const entry: FingerReading = {};
    for (const d of ["crease_to_tip", "knuckle_to_tip"] as const) {
      const vals = inputs[f][d].map(num).filter((v): v is number => v !== undefined);
      if (vals.length) entry[d] = vals.map((value) => ({ value, unit }));
    }
    if (entry.crease_to_tip || entry.knuckle_to_tip) out[f] = entry;
  }
  return Object.keys(out).length ? out : undefined;
}

/** What is wrong with the typed values (unreadable, or outside the plausible range in this unit), for the submit blockers. */
export function fingerProblems(inputs: FingerInputs, unit: LengthUnit): string[] {
  const out: string[] = [];
  for (const f of FINGER_NAMES) {
    for (const d of ["crease_to_tip", "knuckle_to_tip"] as const) {
      for (const raw of inputs[f][d]) {
        if (raw.trim() === "") continue;
        const v = num(raw);
        const [lo, hi] = FINGER_RANGES_MM[d];
        if (v === undefined) out.push(`${LABEL[f].toLowerCase()} ${d.replace(/_/g, " ")}: not a number`);
        else if (toMm(v, unit) < lo || toMm(v, unit) > hi) out.push(`${LABEL[f].toLowerCase()} ${d.replace(/_/g, " ")} in a plausible range (check the unit)`);
      }
    }
  }
  return out;
}

/** "index_crease_to_tip_mm" -> "Index, crease to tip". */
export function fingerKeyLabel(key: string): string {
  const [finger, ...rest] = key.replace(/_mm$/, "").split("_");
  return `${finger.charAt(0).toUpperCase()}${finger.slice(1)}, ${rest.join(" ")}`;
}

interface Props {
  value: FingerInputs;
  unit: LengthUnit;
  onChange: (next: FingerInputs) => void;
}

/** A compact table: one row per finger, two readings of each datum. Collapsed until the operator opens it. */
export function FingerReadingsFields({ value, unit, onChange }: Props) {
  const set = (f: FingerName, d: Datum, i: 0 | 1) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const pair = [...value[f][d]] as [string, string];
    pair[i] = e.target.value;
    onChange({ ...value, [f]: { ...value[f], [d]: pair } });
  };
  const filled = FINGER_NAMES.filter((f) => [...value[f].crease_to_tip, ...value[f].knuckle_to_tip].some((s) => s.trim())).length;
  return (
    <details className="field finger-readings" open={filled > 0}>
      <summary>
        Finger lengths ({unit}, optional, protocol FL-1){filled ? ` · ${filled} finger${filled === 1 ? "" : "s"}` : ""}
      </summary>
      <p className="small muted">
        Caliper, finger straight, repositioned between the two readings. Crease to tip: the crease at the base of the finger on
        the palm side (the thumb: its base crease) to the skin tip. Knuckle to tip: the top of the knuckle on the back of the
        hand to the skin tip.
      </p>
      <table className="finger-readings-table">
        <thead>
          <tr>
            <th scope="col">Finger</th>
            <th scope="col" colSpan={2}>
              Crease to tip
            </th>
            <th scope="col" colSpan={2}>
              Knuckle to tip
            </th>
          </tr>
        </thead>
        <tbody>
          {FINGER_NAMES.map((f) => (
            <tr key={f}>
              <th scope="row">{LABEL[f]}</th>
              {(["crease_to_tip", "knuckle_to_tip"] as const).map((d) =>
                ([0, 1] as const).map((i) => (
                  <td key={`${d}-${i}`}>
                    <input
                      className="input num"
                      inputMode="decimal"
                      aria-label={`${LABEL[f]} ${d.replace(/_/g, " ")}, ${i === 0 ? "first" : "second"} (${unit})`}
                      value={value[f][d][i]}
                      onChange={set(f, d, i)}
                    />
                  </td>
                )),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
