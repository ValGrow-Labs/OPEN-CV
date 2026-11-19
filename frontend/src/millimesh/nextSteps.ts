// What the simple results page says to do next, and the plain-text summary it can copy. Pure functions of the server's response, so they
// are tested without drawing. Plain words, honest: an unvalidated prototype, no firm size, no shop integration.
import type { Measurement, Recommendation, ScanResponse } from "../api/types";
import { THUMB_HINT_DEG } from "../vision/liveChecks";
import type { SimpleNumbers } from "./SimpleResults";

const by = (r: ScanResponse, key: string): Measurement | undefined => r.measurements.find((m) => m.key === key);

/** How far out of the palm plane the thumb was in this scan (median over its frames, the model's depth estimate), when it was
 *  clearly turned: at least THUMB_HINT_DEG (ASSUMED limit). Null otherwise. */
export function thumbTiltDeg(r: ScanResponse): number | null {
  const t = by(r, "thumb_length_mm")?.finger_tilt_deg;
  return t != null && Number.isFinite(t) && t >= THUMB_HINT_DEG ? t : null;
}

/** The per-scan thumb hint, or null when the thumb was not clearly tilted. The angle is rounded to 5 degrees: it is a rough estimate. */
export function thumbHint(r: ScanResponse): string | null {
  const t = thumbTiltDeg(r);
  if (t === null) return null;
  const about = Math.round(t / 5) * 5;
  return `Your thumb was turned about ${about}° out of the palm plane in this scan (a rough depth estimate), which makes the thumb reading less reliable. Spread it flat and scan again.`;
}

/** Step 1: the existing recommendation in one sentence, never firmer than it is. */
export function sizeStep(rec: Recommendation | null | undefined): string {
  if (!rec) return "The camera could not suggest a size from this scan. Compare your hand length with the size chart of the glove you want.";
  if (rec.size && rec.alternative_size) {
    return `Your estimated size is ${rec.size}, close to ${rec.alternative_size} (borderline, not a firm size). Compare both with the size chart of the glove you want.`;
  }
  if (rec.size) return `Your estimated size is ${rec.size} (not a firm size). Compare it with the size chart of the glove you want.`;
  if (rec.closest_size) {
    const near = rec.closest_alternative ? `, then ${rec.closest_alternative}` : "";
    return `Your closest size is ${rec.closest_size}${near} (not a firm size: the camera is too uncertain to pick one). Compare it with the size chart of the glove you want.`;
  }
  return "The camera cannot pick a size for this chart on its own. Compare your measurements with the size chart of the glove you want.";
}

/** Step 2, only when the recommendation says it needs a tape or ruler measurement. */
export function tapeStep(rec: Recommendation | null | undefined): string | null {
  const needed = rec?.needed_measurements ?? [];
  const circ = needed.some((k) => /circumference/i.test(k));
  const length = needed.some((k) => /hand_length|length/i.test(k)) && !circ;
  if (circ) return "For a firmer size, measure around your hand at the knuckles with a soft tape and enter it under More details.";
  if (length) return "For a firmer size, measure your hand from the wrist crease to the tip of your middle finger with a ruler and enter it under More details.";
  return null;
}

export const REPEAT_STEP = "For a more consistent reading, scan again with your hand flat, fingers spread, thumb out and the whole coin visible: two scans should agree within a few millimetres.";
export const DETAILS_STEP = "Tap More details to see how each value was measured and how uncertain it is.";

/** The numbered steps for this scan (3 or 4 of them). */
export function nextSteps(r: ScanResponse): string[] {
  return [sizeStep(r.recommendation), tapeStep(r.recommendation), REPEAT_STEP, DETAILS_STEP].filter((s): s is string => s !== null);
}

/** A plain-text summary to copy: the numbers as shown (chosen finger definition), the size chip, and that it is an estimate. */
export function summaryText(n: SimpleNumbers, chip: string, now: Date = new Date()): string {
  const cm = (v: number | null) => (v === null ? "not measured" : `≈ ${v.toFixed(1)} cm`);
  const rows = n.fingers.map((f) => `${f.label}: ${f.mm === null ? "not measured" : `≈ ${Math.round(f.mm)} mm`}${f.veryUncertain ? " (very uncertain)" : ""}`);
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return [
    "MILLIMESH hand estimate (unvalidated prototype)",
    `Date: ${date}`,
    `Hand length: ${cm(n.handLengthCm)}`,
    `Hand width (knuckle to knuckle): ${cm(n.handWidthCm)}`,
    `Finger length, ${n.definition === "crease" ? "crease to tip (estimate)" : "knuckle to tip"}:`,
    ...rows.map((x) => `  ${x}`),
    chip,
    "Estimate from a phone camera, not validated and not a guarantee of fit.",
  ].join("\n");
}

/** Copy text to the clipboard: the async API when there is one, else the old selection trick; false when neither worked. */
export async function copyText(text: string, doc: Document = document, nav: Navigator = navigator): Promise<boolean> {
  try {
    if (nav.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection trick */
  }
  try {
    const ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    doc.body.appendChild(ta);
    ta.select();
    const ok = typeof doc.execCommand === "function" && doc.execCommand("copy");
    doc.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
