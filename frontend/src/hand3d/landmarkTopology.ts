// The MediaPipe hand: 21 landmarks, how they connect, and which finger each belongs to (pure: no DOM, no three.js).
//
//   0 wrist
//   1-4 thumb (CMC, MCP, IP, tip)      5-8 index (MCP, PIP, DIP, tip)     9-12 middle
//   13-16 ring                         17-20 pinky
//
// The connection list is the same one the rest of the app draws (vision/geometry.ts HAND_CONNECTIONS); it is
// copied here so the viewer depends on nothing the scan code changes.

export const JOINT_COUNT = 21;

export type FingerName = "thumb" | "index" | "middle" | "ring" | "pinky";
export type Part = FingerName | "palm";

export const FINGER_NAMES: readonly FingerName[] = ["thumb", "index", "middle", "ring", "pinky"];

/** Landmark indices of each finger, base to tip. */
export const FINGER_JOINTS: Record<FingerName, readonly number[]> = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

export const CONNECTIONS: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

/** The outline of the palm (wrist, thumb base, then the four knuckles across to the little finger). */
export const PALM_POLYGON: readonly number[] = [0, 1, 5, 9, 13, 17];

/** The finger a landmark belongs to; the wrist (0) belongs to the palm. */
export function fingerOf(joint: number): Part {
  if (joint >= 17) return "pinky";
  if (joint >= 13) return "ring";
  if (joint >= 9) return "middle";
  if (joint >= 5) return "index";
  if (joint >= 1) return "thumb";
  return "palm";
}

/** The part a bone belongs to: a bone inside a finger takes that finger; the bones across the knuckles
 *  (0-5, 5-9, 9-13, 13-17, 0-17) are the palm; wrist to thumb base (0-1) is the thumb's. */
export function boneOf(a: number, b: number): Part {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const across = (lo === 0 && (hi === 5 || hi === 17)) || (hi - lo === 4 && lo >= 5 && lo % 4 === 1);
  if (across) return "palm";
  return fingerOf(hi);
}

/** Colours, chosen to be told apart on a light card (the app's one blue stays the index finger). */
export const PART_COLOURS: Record<Part, number> = {
  thumb: 0xf08c00,
  index: 0x1f5eea,
  middle: 0x0ca678,
  ring: 0x9c36b5,
  pinky: 0xd6336c,
  palm: 0x5f7091,
};

export const PART_LABELS: Record<Part, string> = {
  thumb: "Thumb",
  index: "Index",
  middle: "Middle",
  ring: "Ring",
  pinky: "Pinky",
  palm: "Palm",
};
