// The three phases of the MILLIMESH capture (Palm, Side, Back): their wording and how they map onto the capture views of
// config/measurement.json (capture.views). Pure, so it can be tested without a camera.
import type { CaptureView, PublicConfig } from "../api/types";
import type { LiveCode } from "../vision/liveChecks";
import type { PhaseId } from "./coverage";

export interface PhaseText {
  id: PhaseId;
  /** The tab. */
  tab: string;
  /** The card title. */
  title: string;
  /** The card instruction. */
  instruction: string;
  /** Said before the phase starts (the sheet between phases). */
  intro: string;
}

export const PHASE_ORDER: readonly PhaseId[] = ["palm", "side", "back"];

export const PHASES: Record<PhaseId, PhaseText> = {
  palm: {
    id: "palm",
    tab: "Palm",
    title: "Palm Scan",
    instruction: "Slowly move your phone around your hand to capture the surface.",
    intro: "Open your palm to the camera and rest the coin on it, between your thumb and index finger. Keep your hand still and move only the phone.",
  },
  side: {
    id: "side",
    tab: "Side",
    title: "Side Scan",
    instruction: "Tilt and move around the side of your hand.",
    intro: "Turn your hand on its edge, thumb side up, and keep it still. Move only the phone, around the side of your hand.",
  },
  back: {
    id: "back",
    tab: "Back",
    title: "Back Scan",
    instruction: "Move around the back of your hand.",
    intro: "Turn your hand over, with the coin resting on the back of it. Keep your hand still and move only the phone.",
  },
};

/** The capture views in the order the customer scans them: palm, side, back. The server groups frames by view id and
 *  needs all three, so the order does not matter to it; the back view is checked against the palm, which comes first. */
export function orderedViews(config: PublicConfig): CaptureView[] {
  const by = new Map(config.capture.views.map((v) => [v.id, v]));
  const ordered = PHASE_ORDER.map((id) => by.get(id)).filter((v): v is CaptureView => !!v);
  // A config without these ids is scanned in its own order rather than not at all.
  return ordered.length === config.capture.views.length ? ordered : [...config.capture.views];
}

export const isPhase = (id: string): id is PhaseId => (PHASE_ORDER as readonly string[]).includes(id);

/** What the customer is told while frames are being rejected. The live checks' own words, except for where the coin goes:
 *  in this flow it rests between the thumb and the index finger. */
export function guidanceText(code: LiveCode | undefined, phase: PhaseId, fallback: string): string {
  if (phase === "palm" && (code === "coin_missing" || code === "coin_not_found" || code === "coin_not_on_palm")) {
    return "Rest the coin on your palm, between your thumb and index finger";
  }
  return fallback;
}
