// Which coin the EXPERIMENTAL dense-scan page uses. The coin's denomination and diameter come only from the served
// GET /api/config (the backend reads config/reference_objects.json): nothing here hard-codes a size. The production
// default (config reference_objects.default) is not changed; this experiment only PREFERS a coin when the served config
// lists it as enabled, and a ?coin=<id> URL parameter overrides both.
import type { PublicConfig, ReferenceObject } from "../../../api/types";

/** The owner's test coin for this experiment (the 2019 silver 2-rupee coin), used only when the served config enables it. */
export const PREFERRED_COIN_ID = "inr_2_2019";

export interface CoinChoice {
  id: string;
  /** How it was chosen: the ?coin= parameter, the experiment's preferred coin, or the config's default. */
  via: "url" | "preferred" | "default";
  /** A visible note when the ?coin= parameter could not be used. */
  note: string | null;
}

/** The coins this experiment offers: every coin the served config enables (pilot coins included, marked by the page). */
export function selectableCoins(config: PublicConfig): ReferenceObject[] {
  return config.reference_objects.objects.filter((o) => o.enabled);
}

export function resolveCoin(config: PublicConfig, requested: string | null | undefined): CoinChoice {
  const coins = selectableCoins(config);
  const has = (id: string) => coins.some((o) => o.id === id);
  const fallback: CoinChoice = has(PREFERRED_COIN_ID)
    ? { id: PREFERRED_COIN_ID, via: "preferred", note: null }
    : { id: config.reference_objects.default, via: "default", note: null };
  const wanted = requested?.trim();
  if (!wanted) return fallback;
  if (has(wanted)) return { id: wanted, via: "url", note: null };
  const exists = config.reference_objects.objects.some((o) => o.id === wanted);
  const label = coins.find((o) => o.id === fallback.id)?.label ?? fallback.id;
  return {
    ...fallback,
    note: `The coin "${wanted}" in the address is ${exists ? "disabled" : "not"} in the served settings${exists ? "" : " (unknown id)"}, so it was ignored: using ${label}.`,
  };
}

/** A diameter as written on a coin: 23 -> "23", 24.26 -> "24.26". */
export function mmText(v: number): string {
  return Number(v.toFixed(2)).toString();
}

/** The size confirmation a customer ticks for a coin with size_check, worded from the served label and diameter. */
export function sizeCheckWording(ref: Pick<ReferenceObject, "label" | "diameter_mm">): string {
  return `My coin is the ${mmText(ref.diameter_mm)} mm one: ${ref.label}`;
}

/** What the export and the debug hook record about the coin used: straight from the served config entry. */
export function coinRecord(ref: ReferenceObject, sizeConfirmed: boolean) {
  return {
    id: ref.id,
    label: ref.label,
    diameter_mm: ref.diameter_mm,
    diameter_uncertainty_mm: ref.diameter_uncertainty_mm,
    diameter_uncertainty_basis: "assumed allowance (config)",
    source: ref.source,
    size_check: !!ref.size_check,
    size_check_confirmed: !!ref.size_check && sizeConfirmed,
    customer_hint: ref.customer_hint ?? null,
  };
}
