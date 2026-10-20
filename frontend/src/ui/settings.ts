// Per-device conveniences (selected reference object and product). Storage may be
// unavailable (private mode, blocked site data), so every access is guarded.
import type { PublicConfig, ReferenceSelection } from "../api/types";

const REF_KEY = "glovesize.reference.v1";
const CHART_KEY = "glovesize.chart.v1";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: setting lasts for this session only */
  }
}

/** Coins offered to customers: enabled and not restricted to the pilot study. */
export const customerCoins = (config: PublicConfig) =>
  config.reference_objects.objects.filter((o) => o.enabled && o.availability !== "pilot");

export function loadReference(config: PublicConfig): ReferenceSelection {
  const fallback = { object_id: config.reference_objects.default };
  const raw = read(REF_KEY);
  if (!raw) return fallback;
  try {
    const sel = JSON.parse(raw) as ReferenceSelection;
    if (sel.object_id) {
      const obj = customerCoins(config).find((o) => o.id === sel.object_id);
      return obj ? { object_id: obj.id } : fallback;
    }
    if (typeof sel.custom_diameter_mm === "number" && sel.custom_diameter_mm >= 10 && sel.custom_diameter_mm <= 60) {
      return { custom_diameter_mm: sel.custom_diameter_mm, custom_label: sel.custom_label };
    }
  } catch {
    /* corrupt value */
  }
  return fallback;
}

export function saveReference(sel: ReferenceSelection): void {
  write(REF_KEY, JSON.stringify(sel));
}

export function loadChart(config: PublicConfig): string {
  const id = read(CHART_KEY);
  return id && config.charts.some((c) => c.chart_id === id) ? id : config.default_chart_id;
}

export function saveChart(id: string): void {
  write(CHART_KEY, id);
}

export function referenceLabel(config: PublicConfig, sel: ReferenceSelection): { label: string; diameter: number } {
  if (sel.custom_diameter_mm !== undefined) {
    return { label: sel.custom_label || "Custom reference", diameter: sel.custom_diameter_mm };
  }
  const obj = config.reference_objects.objects.find((o) => o.id === sel.object_id);
  return { label: obj?.label ?? "Unknown reference", diameter: obj?.diameter_mm ?? NaN };
}

const INTRO_KEY = "glovesize.introSeen.v1";
const COIN_KEY = "glovesize.coinConfirmed.v1";

/** The coin is confirmed once per browser session (sessionStorage), and again if it changes. */
export function coinConfirmed(sel: ReferenceSelection): boolean {
  try {
    return window.sessionStorage.getItem(COIN_KEY) === JSON.stringify(sel);
  } catch {
    return false;
  }
}

export function markCoinConfirmed(sel: ReferenceSelection): void {
  try {
    window.sessionStorage.setItem(COIN_KEY, JSON.stringify(sel));
  } catch {
    /* storage unavailable: the customer will be asked again next time */
  }
}

export function introSeen(): boolean {
  return read(INTRO_KEY) === "1";
}

export function markIntroSeen(): void {
  write(INTRO_KEY, "1");
}
