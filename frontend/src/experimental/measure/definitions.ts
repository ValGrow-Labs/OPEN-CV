// What each value of the EXPERIMENTAL measurement engine measures (definition), how (method) and from which datums.
// The definitions of the existing values are those of reconstruction/measure.ts (unchanged); finger widths use the
// construction of validation/meshDimensions.ts.
import type { FingerName } from "../reconstruction/measure";
import type { MeasureKind } from "./types";
import type { Station } from "./sections";

export interface ValueDefinition {
  key: string;
  label: string;
  unit: "mm" | "mm2";
  kind: MeasureKind;
  definition: string;
  method: string;
  meshRegion: string;
  landmarks: number[];
}

export const FINGER_LANDMARKS: Record<FingerName, [number, number]> = { thumb: [2, 4], index: [5, 8], middle: [9, 12], ring: [13, 16], little: [17, 20] };
const FRAME_LANDMARKS = [0, 5, 9, 13, 17];

/** Finger-width stations. `tip15` = the caliper protocol's station (validation/dimensions.ts FINGER_SECTION_FROM_TIP_MM);
 *  `base25` = a quarter of the way from the base point (MCP joint centre) to the tip: on the proximal phalanx, where a
 *  ring sits. The 25 % is an ASSUMED proportion, not an anatomical landmark. */
export const WIDTH_STATIONS: { id: "tip15" | "base25"; station: Station; words: string }[] = [
  { id: "tip15", station: { kind: "fromTip", mm: 15 }, words: "15 mm proximal to the fingertip (the caliper protocol's station)" },
  { id: "base25", station: { kind: "fraction", of: "base_to_tip", f: 0.25 }, words: "25 % of the way from the base point (MCP joint centre) to the fingertip (proximal phalanx; the 25 % is an ASSUMED proportion)" },
];

const SECTION = "the plane perpendicular to the hand axis 8 mm proximal to the knuckle line (knuckle line = mean of the four MCP landmarks along the hand axis)";

export const BASE_DEFINITIONS: ValueDefinition[] = [
  {
    key: "hand_length",
    label: "Hand length",
    unit: "mm",
    kind: "length",
    definition: "wrist plane (through the wrist landmark, normal to the hand axis wrist -> middle MCP) to the farthest mesh point along the hand axis (the middle fingertip on a normal hand)",
    method: "maximum of (vertex - wrist landmark) . hand axis over all mesh vertices (reconstruction/measure.ts)",
    meshRegion: "the whole mesh (in practice the middle fingertip)",
    landmarks: [0, 9],
  },
  {
    key: "palm_breadth",
    label: "Palm breadth",
    unit: "mm",
    kind: "extent",
    definition: `extent across the palm (along the frame's x axis, index MCP -> little MCP) of the largest loop cut by ${SECTION}, thumb excluded`,
    method: "mesh section (plane cut, loops chained), extent along x of the largest loop (reconstruction/measure.ts)",
    meshRegion: "knuckle section loop",
    landmarks: FRAME_LANDMARKS,
  },
  {
    key: "palm_thickness",
    label: "Palm thickness",
    unit: "mm",
    kind: "extent",
    definition: `palm-to-back extent (along the palm normal) of the central 60 % in width of the loop cut by ${SECTION}`,
    method: "mesh section, extent along the palm normal of the central 60 % of the loop (reconstruction/measure.ts)",
    meshRegion: "knuckle section loop, central 60 %",
    landmarks: FRAME_LANDMARKS,
  },
  {
    key: "knuckle_circumference",
    label: "Knuckle circumference",
    unit: "mm",
    kind: "loop",
    definition: `length of the single closed loop cut by ${SECTION} ("around the knuckles" of glove sizing, thumb excluded)`,
    method: "mesh section; perimeter of the loop when the plane cuts exactly one closed loop (reconstruction/measure.ts)",
    meshRegion: "knuckle section loop (on a board capture its palm-side half is the board plane)",
    landmarks: FRAME_LANDMARKS,
  },
];

export function fingerLengthDefinition(f: FingerName): ValueDefinition {
  const [a, b] = FINGER_LANDMARKS[f];
  return {
    key: `finger_length_${f}`,
    label: `${f[0].toUpperCase()}${f.slice(1)} finger length`,
    unit: "mm",
    kind: "length",
    definition: `base point on the ${f}'s axis (landmark ${a}, the joint centre) to the farthest mesh point inside a 12 mm (thumb 14 mm) cylinder around the axis landmark ${a} -> ${b}. Joint centre to skin tip, NOT the palm-crease-to-tip length of a tape`,
    method: "maximum of (vertex - base) . axis over the vertices inside the cylinder (reconstruction/measure.ts)",
    meshRegion: `the ${f}'s fingertip`,
    landmarks: [a, b],
  };
}

export function fingerWidthDefinition(f: FingerName, st: (typeof WIDTH_STATIONS)[number]): ValueDefinition {
  const [a, b] = FINGER_LANDMARKS[f];
  return {
    key: `finger_width_${f}_${st.id}`,
    label: `${f[0].toUpperCase()}${f.slice(1)} finger width (${st.id})`,
    unit: "mm",
    kind: "extent",
    definition: `extent, parallel to the support plane and perpendicular to the ${f}'s axis (landmarks ${a} -> ${b}), of the mesh section perpendicular to that axis ${st.words}; observed surface only (board contact and cut faces never count)`,
    method: "mesh section (plane cut, labelled loops), the loop around the axis; withheld if open, merged with another finger, or too few observed points (measure/sections.ts, as validation/meshDimensions.ts)",
    meshRegion: `the ${f}'s section ${st.words}`,
    landmarks: [a, b],
  };
}

export const SURFACE_AREA_DEFINITION: ValueDefinition = {
  key: "surface_area",
  label: "Hand surface area",
  unit: "mm2",
  kind: "area",
  definition: "sum of the triangle areas of the whole mesh, only when the reconstruction passed its completeness gates",
  method: "mesh area (reconstruction/meshing.ts meshArea)",
  meshRegion: "the whole mesh",
  landmarks: [],
};
