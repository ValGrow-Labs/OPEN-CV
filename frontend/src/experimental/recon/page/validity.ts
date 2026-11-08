// Is a capture valid for the physical validation? (EXPERIMENTAL; pure, unit-tested.) Valid means only "taken under the
// conditions the validation plan asks for", never "accurate". A capture is NOT valid when: the board print check was not
// entered or failed (reprint), the sheet checklist is incomplete, the flatness from the pictures failed or could not be
// checked, the coin says the print scale is wrong, nothing was measured, or (in validation mode) the run details are
// incomplete. The measurements stay visible on the page, marked; nothing is hidden.
import type { BoardFlatness } from "../boardFlatness";
import { checklistMissing, CHECKLIST, type Checklist, type RulerCheck } from "./boardCheck";
import type { CoinView } from "./format";
import { runProblems, type RunDetails } from "./runDetails";

export interface ValidityInput {
  validationMode: boolean;
  run: RunDetails | null;
  ruler: RulerCheck | null;
  checklist: Checklist | null;
  flatness: BoardFlatness | null;
  coin: Pick<CoinView, "scaleWrong">;
  refused: boolean;
  hasMeasurements: boolean;
}

export function validity(i: ValidityInput): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!i.ruler || i.ruler.verdict === "not_entered") reasons.push("The board print check (ruler readings) was not entered.");
  else if (i.ruler.verdict === "reprint") reasons.push("The ruler check failed: the board must be reprinted at 100 % / actual size.");
  const missing = i.checklist ? checklistMissing(i.checklist, i.run?.conditions ?? []) : CHECKLIST.map((c) => c.key);
  if (missing.length) reasons.push(`The sheet checklist is not complete (${missing.map((k) => CHECKLIST.find((c) => c.key === k)!.words.replace(/\.$/, "").toLowerCase()).join("; ")}).`);
  if (!i.flatness || i.flatness.verdict === "not_checked") reasons.push("The board's flatness could not be checked from the pictures.");
  else if (i.flatness.verdict === "fail") reasons.push("The board is probably not flat in the pictures (curled, folded or lifted).");
  if (i.coin.scaleWrong) reasons.push("The coin says the board was not printed at 100 %.");
  if (i.refused) reasons.push("The reconstruction refused: nothing was measured.");
  else if (!i.hasMeasurements) reasons.push("No measurements (no hand frame).");
  if (i.validationMode) {
    const p = i.run ? runProblems(i.run) : ["The test-run details were not entered."];
    if (p.length) reasons.push(`The test-run details are incomplete: ${p.join(" ")}`);
  }
  return { valid: reasons.length === 0, reasons };
}
