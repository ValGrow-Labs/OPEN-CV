// The guided views of the EXPERIMENTAL multi-view capture prototype (see README.md).
//
// Four required views in order (open palm, thumb-side profile, little-finger-side profile, back of hand) and two optional
// 45-degree obliques. Each says honestly what it is for. Which views need the coin is configurable (the product needs it on
// the palm and on the back of the hand; a profile shows the hand on its edge, where the coin is not on the visible palm).
//
// Nothing here is used by the customer flow, the scan or the coin pipeline.

export type ViewId = "palm" | "thumb" | "little" | "back" | "oblique_palm_thumb" | "oblique_back_little";

/** How the view's hand posture is judged from the 21 landmarks (the sign and size of the hand "turn", see vision/geometry.ts handTurn). */
export type PostureRule =
  /** The palm or back faces the camera: |turn| is at least the capture minimum. The first view cannot tell palm from back. */
  | { kind: "face_on" }
  /** Face-on, and the turn has the OPPOSITE sign to an earlier view's (the back of the same hand). */
  | { kind: "opposite_of"; view: ViewId }
  /** The hand is on its edge: |turn| is at most the side-view limit. Which edge (thumb or little finger) is not checked. */
  | { kind: "edge_on" }
  /** Nothing is judged about the posture (an oblique); the hand must still be found and in frame. */
  | { kind: "none" };

export interface ViewDef {
  id: ViewId;
  title: string;
  /** Short name for chips and file names. */
  short: string;
  instruction: string;
  /** What this view is for, said plainly. */
  purpose: string;
  optional: boolean;
  requiresCoin: boolean;
  posture: PostureRule;
}

export const REQUIRED_VIEW_IDS: readonly ViewId[] = ["palm", "thumb", "little", "back"];

/** The views that need the coin by default: where the coin lies flat on the visible skin, as in the product. */
export const DEFAULT_COIN_VIEWS: readonly ViewId[] = ["palm", "back"];

const BASE: Record<ViewId, Omit<ViewDef, "requiresCoin">> = {
  palm: {
    id: "palm",
    title: "Open palm",
    short: "palm",
    instruction: "Rest the coin flat in the middle of your open palm. Spread the fingers a little, keep them straight, and show the palm to the camera.",
    purpose: "The main silhouette of the hand from the palm side, and the coin that gives the image scale.",
    optional: false,
    posture: { kind: "face_on" },
  },
  thumb: {
    id: "thumb",
    title: "Thumb-side profile",
    short: "thumb-side",
    instruction: "Turn the hand onto its edge so the camera sees the thumb side. Keep the fingers straight and together, thumb relaxed.",
    purpose: "How thick the palm and the fingers are, seen from the side. The coin is not needed here.",
    optional: false,
    posture: { kind: "edge_on" },
  },
  little: {
    id: "little",
    title: "Little-finger-side profile",
    short: "little-side",
    instruction: "Turn the hand over onto the other edge so the camera sees the little-finger side. Keep the fingers straight and together.",
    purpose: "The same thickness seen from the other side, so the two profiles can be compared. The coin is not needed here.",
    optional: false,
    posture: { kind: "edge_on" },
  },
  back: {
    id: "back",
    title: "Back of hand",
    short: "back",
    instruction: "Turn the hand over so the back faces the camera. Rest the coin flat on the back of the hand and spread the fingers a little.",
    purpose: "The silhouette from the back, and a second view of the coin's scale on the other side of the hand.",
    optional: false,
    posture: { kind: "opposite_of", view: "palm" },
  },
  oblique_palm_thumb: {
    id: "oblique_palm_thumb",
    title: "45 degrees, palm and thumb side",
    short: "oblique-palm-thumb",
    instruction: "Tilt the hand about halfway between the palm view and the thumb-side view. Fingers straight.",
    purpose: "An extra angle that a pure silhouette reconstruction needs to tighten the shape. Optional.",
    optional: true,
    posture: { kind: "none" },
  },
  oblique_back_little: {
    id: "oblique_back_little",
    title: "45 degrees, back and little-finger side",
    short: "oblique-back-little",
    instruction: "Tilt the hand about halfway between the back view and the little-finger-side view. Fingers straight.",
    purpose: "A second extra angle on the other diagonal. Optional.",
    optional: true,
    posture: { kind: "none" },
  },
};

const ORDER: readonly ViewId[] = ["palm", "thumb", "little", "back", "oblique_palm_thumb", "oblique_back_little"];

export interface ViewSetOptions {
  /** Add the two optional 45-degree obliques after the four required views (default false). */
  includeObliques?: boolean;
  /** Which views need the coin (default: palm and back). */
  coinViews?: readonly ViewId[];
}

/** The ordered views to guide the person through. */
export function viewsFor(options: ViewSetOptions = {}): ViewDef[] {
  const coin = new Set(options.coinViews ?? DEFAULT_COIN_VIEWS);
  return ORDER.filter((id) => !BASE[id].optional || options.includeObliques).map((id) => ({ ...BASE[id], requiresCoin: coin.has(id) }));
}

export function viewDef(id: ViewId, options: ViewSetOptions = {}): ViewDef {
  const def = viewsFor({ ...options, includeObliques: true }).find((v) => v.id === id);
  if (!def) throw new Error(`unknown view ${id}`);
  return def;
}
