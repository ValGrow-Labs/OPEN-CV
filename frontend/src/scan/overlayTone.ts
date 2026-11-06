// The colour of the 3D hand: calm when nothing is tracked, green when the pose is fine, pale blue when it needs
// fixing. A tone is held for a minimum time before it changes (config live_scan.overlay_3d.tone_hold_ms), so
// the colour does not flicker while the live checks flip between frames.
export type OverlayTone = "ok" | "warn" | "idle";

export interface ToneState {
  tone: OverlayTone;
  /** When the current tone began (ms on the page's clock). */
  since: number;
}

export const INITIAL_TONE: ToneState = { tone: "idle", since: -Infinity };

/** The tone this frame asks for: nothing tracked is idle; a hand whose live checks pass is ok; otherwise warn. */
export function rawTone(handTracked: boolean, liveOk: boolean | undefined): OverlayTone {
  if (!handTracked) return "idle";
  return liveOk ? "ok" : "warn";
}

/** The tone to show: the requested one, but only once the current one has been held for ``holdMs``. */
export function holdTone(prev: ToneState, raw: OverlayTone, nowMs: number, holdMs: number): ToneState {
  if (raw === prev.tone) return prev;
  return nowMs - prev.since >= holdMs ? { tone: raw, since: nowMs } : prev;
}
