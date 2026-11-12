// The reference-coin picker of the MILLIMESH scan (step 2): which coins are shown, in what order, which one is
// chosen first, and how each is drawn. Pure: no DOM, so it can be tested on its own. The coins themselves (their
// sizes, sources and whether customers may use them) come from config/reference_objects.json via /api/config;
// nothing here changes a coin's size or whether the server accepts it.
import type { PublicConfig, ReferenceObject, ReferenceSelection } from "../api/types";

/** The picker's order. The Indian 2-rupee coin (2019 series) comes first and is the one chosen by default. */
export const PICKER_ORDER = ["inr_2_2019", "inr_1_2019", "us_quarter", "us_nickel", "us_dime", "us_penny", "lkr_5_2017"] as const;

/** The coin preselected when the customer has not chosen one on this device before. */
export const PICKER_DEFAULT = "inr_2_2019";

export type CoinTone = "silver" | "steel" | "copper";

/** How a coin is drawn and named on its card. The drawing is a generic metallic disc with the denomination,
 *  not a copy of the real coin's artwork. */
export interface CoinFace {
  /** Short name on the card ("Quarter", "₹2 (2019)"). */
  name: string;
  /** The denomination printed on the drawn disc. */
  mark: string;
  tone: CoinTone;
}

const FACES: Record<string, CoinFace> = {
  inr_2_2019: { name: "₹2 (2019)", mark: "₹2", tone: "steel" },
  inr_1_2019: { name: "₹1 (2019)", mark: "₹1", tone: "steel" },
  us_quarter: { name: "Quarter", mark: "25¢", tone: "silver" },
  us_nickel: { name: "Nickel", mark: "5¢", tone: "silver" },
  us_dime: { name: "Dime", mark: "10¢", tone: "silver" },
  us_penny: { name: "Penny", mark: "1¢", tone: "copper" },
  lkr_5_2017: { name: "Rs 5 (2017)", mark: "Rs5", tone: "steel" },
};

export interface PickerCoin {
  id: string;
  object: ReferenceObject;
  face: CoinFace;
  /** "23.00 mm" */
  diameterText: string;
  /** The customer may scan with it (enabled and not restricted to the pilot study: what /api/scan accepts). */
  selectable: boolean;
  /** Why it cannot be chosen, in words, or null. */
  unavailableReason: string | null;
}

/** Whether /api/scan accepts this coin from a customer (mirrors ui/settings.customerCoins and the server). */
export const customerSelectable = (o: ReferenceObject): boolean => o.enabled && o.availability !== "pilot";

function reasonFor(o: ReferenceObject): string | null {
  if (!o.enabled) return "Not available yet";
  if (o.availability === "pilot") return "Pilot study only";
  return null;
}

function faceFor(o: ReferenceObject): CoinFace {
  return FACES[o.id] ?? { name: o.label, mark: `${Math.round(o.diameter_mm)}`, tone: "silver" };
}

/** Every coin the picker shows: the configured ones in PICKER_ORDER first, then any other configured coin. */
export function pickerCoins(config: PublicConfig): PickerCoin[] {
  const objects = config.reference_objects.objects;
  const rank = (id: string) => {
    const i = (PICKER_ORDER as readonly string[]).indexOf(id);
    return i < 0 ? PICKER_ORDER.length : i;
  };
  return [...objects]
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((o) => ({
      id: o.id,
      object: o,
      face: faceFor(o),
      diameterText: `${o.diameter_mm.toFixed(2)} mm`,
      selectable: customerSelectable(o),
      unavailableReason: reasonFor(o),
    }));
}

/** The coin chosen when the picker opens: the customer's previous choice on this device if it can still be used,
 *  otherwise the 2-rupee coin, otherwise the configured default, otherwise the first usable coin. */
export function initialCoinId(config: PublicConfig, previous?: ReferenceSelection | null): string | null {
  const coins = pickerCoins(config).filter((c) => c.selectable);
  if (previous?.object_id && coins.some((c) => c.id === previous.object_id)) return previous.object_id;
  if (coins.some((c) => c.id === PICKER_DEFAULT)) return PICKER_DEFAULT;
  if (coins.some((c) => c.id === config.reference_objects.default)) return config.reference_objects.default;
  return coins[0]?.id ?? null;
}

/** The selection sent with the scan: coins whose size must be confirmed carry that confirmation. */
export function selectionFor(coin: ReferenceObject, sizeChecked: boolean): ReferenceSelection {
  return coin.size_check ? { object_id: coin.id, size_checked: sizeChecked } : { object_id: coin.id };
}
