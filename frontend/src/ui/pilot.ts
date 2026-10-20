import type { LengthUnit, ReferenceSummary } from "../api/types";

// Pilot-study helpers for the validation screen. The server repeats every check and computes
// the reference itself (glovesize/validation_records.py); these only guide the operator.

export const MM_PER_UNIT: Record<LengthUnit, number> = { mm: 1, cm: 10, in: 25.4 };

export const HAND_LENGTH_RANGE_MM: [number, number] = [100, 260];

export function toMm(value: number, unit: LengthUnit): number {
  return value * MM_PER_UNIT[unit];
}

export interface ReferenceCheck {
  reliability: ReferenceSummary["reliability"];
  valueMm: number;
  spreadMm: number;
}

/** Same rule as the server: two readings must agree within the tolerance; a third reading
 *  resolves a disagreement when the median agrees with one of the others. */
export function referenceCheck(readingsMm: number[], toleranceMm: number): ReferenceCheck | null {
  const s = [...readingsMm].sort((a, b) => a - b);
  const tol = toleranceMm + 1e-9;
  if (s.length === 0) return null;
  const spreadMm = s[s.length - 1] - s[0];
  if (s.length === 1) return { reliability: "single_reading", valueMm: s[0], spreadMm };
  if (s.length === 2) return { reliability: s[1] - s[0] <= tol ? "agreed" : "discrepant", valueMm: (s[0] + s[1]) / 2, spreadMm };
  return { reliability: Math.min(s[1] - s[0], s[2] - s[1]) <= tol ? "agreed" : "discrepant", valueMm: s[1], spreadMm };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I

/** A random participant code that carries no personal information. */
export function newParticipantCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return "P-" + Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}
