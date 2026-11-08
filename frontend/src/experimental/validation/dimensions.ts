// The dimension catalogue of the PHYSICAL PHANTOM validation (EXPERIMENTAL) and the explicit mapping from what the
// reconstruction reports to what the calipers measure. Every definition here is the protocol's: the reference file states
// the definition it used for each dimension, and the report prints both.
//
// Only like-for-like pairs are compared as such. Where the software's definition differs from the caliper's (the
// landmark-based wrist plane against the phantom's printed wrist datum, the joint-centre finger base against a base
// datum, the hull circumference upper bound against a tape), the pair is kept but FLAGGED: its error includes the
// definition gap and is reported in a separate table, never as a reconstruction error.
import type { FingerName } from "../reconstruction/measure";

export const FINGERS: readonly FingerName[] = ["thumb", "index", "middle", "ring", "little"];
export const GAP_PAIRS: readonly (readonly [FingerName, FingerName])[] = [
  ["thumb", "index"],
  ["index", "middle"],
  ["middle", "ring"],
  ["ring", "little"],
];

/** Fixed positions used by the mesh-derived dimensions (meshDimensions.ts) and by the caliper protocol. */
export const FINGER_SECTION_FROM_TIP_MM = 15;
export const GAP_PROXIMAL_TO_SHORTER_TIP_MM = 10;
export const KNUCKLE_SECTION_PROXIMAL_MM = 8;

export type InstrumentKind = "caliper" | "tape";

export interface DimensionSpec {
  name: string;
  /** The protocol's definition, written into templates and the report. */
  definition: string;
  /** The instrument family the protocol uses. Circumference needs a tape. */
  instrument: InstrumentKind;
}

const fingerLength = (f: FingerName): DimensionSpec => ({
  name: `finger_length_${f}`,
  definition: `${f} length: from the ${f}'s base datum mark on the phantom (the printed knuckle / MCP mark on the finger's axis) to the most distal point of the fingertip, measured parallel to the finger's axis.`,
  instrument: "caliper",
});
const fingerWidth = (f: FingerName): DimensionSpec => ({
  name: `finger_width_${f}_at_${FINGER_SECTION_FROM_TIP_MM}mm`,
  definition: `${f} width: across the finger, parallel to the board, perpendicular to the finger's axis, in the section ${FINGER_SECTION_FROM_TIP_MM} mm proximal to the fingertip (the most distal point along the axis).`,
  instrument: "caliper",
});
const fingerHeight = (f: FingerName): DimensionSpec => ({
  name: `finger_height_${f}_at_${FINGER_SECTION_FROM_TIP_MM}mm`,
  definition: `${f} height: vertical extent (lowest to highest point, perpendicular to the board) of the same section ${FINGER_SECTION_FROM_TIP_MM} mm proximal to the fingertip; board surface to the top when the finger rests on the board.`,
  instrument: "caliper",
});
const fingerGap = (a: FingerName, b: FingerName): DimensionSpec => ({
  name: `finger_gap_${a}_${b}`,
  definition: `clearance between the ${a} and the ${b}, parallel to the board along a line perpendicular to the hand axis, ${GAP_PROXIMAL_TO_SHORTER_TIP_MM} mm proximal to the tip of the shorter of the two fingers (0 when they touch).`,
  instrument: "caliper",
});

export const DIMENSIONS: readonly DimensionSpec[] = [
  {
    name: "hand_length",
    definition: "From the phantom's wrist datum line (printed or engraved across the wrist) to the most distal point of the middle fingertip, parallel to the hand axis.",
    instrument: "caliper",
  },
  {
    name: "palm_breadth",
    definition: "Palm breadth at the knuckle datum line: edge to edge across the palm, parallel to the board, perpendicular to the hand axis, thumb excluded.",
    instrument: "caliper",
  },
  {
    name: "palm_thickness",
    definition: "Palm thickness at the knuckle datum line: from the board surface (the phantom's base) to the top of the back of the hand, at the middle of the palm.",
    instrument: "caliper",
  },
  {
    name: "knuckle_section_width",
    definition: `Width of the cross-section ${KNUCKLE_SECTION_PROXIMAL_MM} mm proximal to the knuckle datum line, parallel to the board, perpendicular to the hand axis (the section the reconstruction uses for palm breadth).`,
    instrument: "caliper",
  },
  {
    name: "knuckle_section_height",
    definition: `Height above the board of the cross-section ${KNUCKLE_SECTION_PROXIMAL_MM} mm proximal to the knuckle datum line (board surface to the highest point of that section).`,
    instrument: "caliper",
  },
  {
    name: "circumference_knuckle",
    definition: `Circumference (non-stretch tape) around the cross-section ${KNUCKLE_SECTION_PROXIMAL_MM} mm proximal to the knuckle datum line, thumb excluded, tape touching without indenting.`,
    instrument: "tape",
  },
  ...FINGERS.map(fingerLength),
  ...FINGERS.map(fingerWidth),
  ...FINGERS.map(fingerHeight),
  ...GAP_PAIRS.map(([a, b]) => fingerGap(a, b)),
];

const BY_NAME = new Map(DIMENSIONS.map((d) => [d.name, d]));
export const dimensionSpec = (name: string): DimensionSpec | undefined => BY_NAME.get(name);
/** Phantom-only dimensions (no software counterpart) are allowed in the reference with the prefix "extra_". */
export const isPhantomOnly = (name: string): boolean => /^extra_[a-z0-9_]+$/.test(name);

export type Relation = "like_for_like" | "definition_differs";

export interface MappingRow {
  dimension: string;
  /** Where the software value comes from: a path into reconstruction.measurements, or a mesh-derived dimension. */
  source: { kind: "measurement"; path: string } | { kind: "mesh"; key: string };
  relation: Relation;
  software: string;
  note: string;
}

const LANDMARK_NOTE = "basis model: the position rests on the landmark hand frame (MediaPipe points triangulated on the board), not on the phantom's datum marks.";

export const MAPPING: readonly MappingRow[] = [
  {
    dimension: "hand_length",
    source: { kind: "measurement", path: "handLength" },
    relation: "definition_differs",
    software: "wrist plane through the triangulated WRIST landmark (MediaPipe point 0) to the farthest mesh point along the landmark hand axis",
    note: "the detector's wrist point is not the phantom's wrist datum line; the error includes the distance between the two wrist planes",
  },
  {
    dimension: "palm_breadth",
    source: { kind: "measurement", path: "palmBreadth" },
    relation: "definition_differs",
    software: `extent along the landmark across-palm axis of the section ${KNUCKLE_SECTION_PROXIMAL_MM} mm proximal to the landmark knuckle line`,
    note: `the caliper is AT the knuckle datum, the software ${KNUCKLE_SECTION_PROXIMAL_MM} mm proximal to it; knuckle_section_width is the like-for-like pair`,
  },
  {
    dimension: "palm_thickness",
    source: { kind: "measurement", path: "palmThickness" },
    relation: "definition_differs",
    software: `palm-to-back extent along the landmark palm normal over the central 60 % of the section ${KNUCKLE_SECTION_PROXIMAL_MM} mm proximal to the knuckle line (the board bounds the palm side)`,
    note: `different section position and a 60 % central window; knuckle_section_height is the like-for-like pair`,
  },
  {
    dimension: "circumference_knuckle",
    source: { kind: "measurement", path: "circumferenceKnuckle" },
    relation: "definition_differs",
    software: "length of the single closed loop of the hull section (UPPER BOUND: the palm-side half is the board plane, concavities are filled)",
    note: "a visual-hull loop is an upper bound, a tape follows the real surface; the error includes that bound",
  },
  ...FINGERS.map(
    (f): MappingRow => ({
      dimension: `finger_length_${f}`,
      source: { kind: "measurement", path: `fingerLengths.${f}` },
      relation: "definition_differs",
      software: "landmark MCP joint centre on the finger axis to the farthest mesh point near the axis",
      note: "the base is the detector's joint centre, not the phantom's base datum mark",
    }),
  ),
  {
    dimension: "knuckle_section_width",
    source: { kind: "mesh", key: "knuckle_section_width" },
    relation: "like_for_like",
    software: "horizontal extent (perpendicular to axis_y) of the mesh section 8 mm proximal to knuckle_y_mm, board-contact vertices excluded",
    note: LANDMARK_NOTE,
  },
  {
    dimension: "knuckle_section_height",
    source: { kind: "mesh", key: "knuckle_section_height" },
    relation: "like_for_like",
    software: "vertical extent above the board of the same section (the bottom is the board contact)",
    note: LANDMARK_NOTE,
  },
  ...FINGERS.flatMap((f): MappingRow[] => [
    {
      dimension: `finger_width_${f}_at_${FINGER_SECTION_FROM_TIP_MM}mm`,
      source: { kind: "mesh", key: `finger_width_${f}_at_${FINGER_SECTION_FROM_TIP_MM}mm` },
      relation: "like_for_like",
      software: `horizontal extent of the mesh section perpendicular to the finger axis ${FINGER_SECTION_FROM_TIP_MM} mm from the fingertip`,
      note: LANDMARK_NOTE,
    },
    {
      dimension: `finger_height_${f}_at_${FINGER_SECTION_FROM_TIP_MM}mm`,
      source: { kind: "mesh", key: `finger_height_${f}_at_${FINGER_SECTION_FROM_TIP_MM}mm` },
      relation: "like_for_like",
      software: "vertical extent (lowest to highest point) of the same section; board-contact points count only as the bottom",
      note: `${LANDMARK_NOTE} A visual hull fills any space under a finger that no view looked through.`,
    },
  ]),
  ...GAP_PAIRS.map(
    ([a, b]): MappingRow => ({
      dimension: `finger_gap_${a}_${b}`,
      source: { kind: "mesh", key: `finger_gap_${a}_${b}` },
      relation: "like_for_like",
      software: `horizontal clearance between the two finger sections in the vertical plane perpendicular to axis_y, ${GAP_PROXIMAL_TO_SHORTER_TIP_MM} mm proximal to the shorter finger's tip (0 when closed in the reconstruction)`,
      note: `${LANDMARK_NOTE} A gap no view looked through is closed by the hull.`,
    }),
  ),
];

/** Software outputs deliberately NOT mapped, with the reason (printed in the report). */
export const NOT_MAPPED: readonly { software: string; reason: string }[] = [
  { software: "measurements.surfaceArea", reason: "withheld on a board capture (the palm side is not observed); no hand-held instrument measures surface area" },
  { software: "reconstruction.free_surface_area_mm2", reason: "an upper bound of the back-and-sides hull area; needs a reference scan (use the surface-distance section instead)" },
  { software: "reconstruction.hull_volume_mm3", reason: "a visual hull volume is an upper bound; no volume reference is in the protocol" },
];

export const mappingFor = (dimension: string): MappingRow | undefined => MAPPING.find((m) => m.dimension === dimension);
