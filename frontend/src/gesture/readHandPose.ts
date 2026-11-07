// Reads the current hand pose and the bend of every finger from the 21 MediaPipe hand landmarks.
//
// Landmark indices: 0 wrist; thumb 1 CMC, 2 MCP, 3 IP, 4 tip; index 5-8; middle 9-12; ring 13-16; little 17-20
// (MCP, PIP, DIP, tip for the four fingers).
//
// EVERYTHING here is derived from joint angles and distances normalised by the palm length (wrist to middle knuckle),
// never from absolute x/y directions, so the result is the same for a left or right hand, a mirrored picture and any
// rotation of the hand in the image.
//
// With the 3D world landmarks the flexion is the true 3D geometry (out-of-palm elevation of the proximal phalanx plus
// the angle to the PIP-to-tip chord). Without them (image landmarks only) the angles are 2D and UNDER-READ a finger that
// bends toward the camera (its projection shortens): when a finger's projected bones are much shorter than a straight
// finger's, only a reach rule (tip to wrist distance in palm lengths) is used, which catches the common fist seen from the
// front. The confidence is lower in 2D. Display only; it never touches a measurement.
import {
  CONFIDENCE_2D,
  CONFIDENCE_WORLD,
  FINGER_BENT_MIN_DEG,
  FINGER_EXTENDED_MAX_DEG,
  LABEL_TEXT,
  MARGIN_SPAN_DEG,
  REACH_BEND_FULL_DEG,
  REACH_EXTENDED,
  REACH_FIST,
  FORESHORTEN_CHORD_MIN,
  FORESHORTEN_PROX_MIN,
  SPREAD_APART_MIN_DEG,
  SPREAD_TOGETHER_MAX_DEG,
  SPREAD_TOGETHER_PAIR_MAX_DEG,
  THUMB_BENT_MIN_DEG,
  THUMB_EXTENDED_MAX_DEG,
  THUMB_OUT_MIN_DEG,
  THUMB_OUT_MIN_REACH,
} from "./constants";
import { FINGER_ORDER, type FingerName, type FingerPose, type FingerState, type HandPoseLabel, type HandPoseReading } from "./types";

interface V3 {
  x: number;
  y: number;
  z: number;
}

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: V3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: V3): V3 => {
  const n = norm(a);
  return n > 0 ? { x: a.x / n, y: a.y / n, z: a.z / n } : { x: NaN, y: NaN, z: NaN };
};

/** The angle between two vectors in degrees (0 = same direction); NaN if either has no length. */
function angleDeg(a: V3, b: V3): number {
  if (!(norm(a) > 0) || !(norm(b) > 0)) return NaN;
  return (Math.atan2(norm(cross(a, b)), dot(a, b)) * 180) / Math.PI;
}

/** Joint indices of the four fingers: knuckle (MCP), PIP, DIP, tip. */
const CHAINS: Readonly<Record<Exclude<FingerName, "thumb">, readonly [number, number, number, number]>> = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  little: [17, 18, 19, 20],
};
const FOUR: readonly Exclude<FingerName, "thumb">[] = ["index", "middle", "ring", "little"];

function finite3(p: { x: number; y: number; z?: number }, needZ: boolean): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && (!needZ || Number.isFinite(p.z));
}

function usable(points: readonly { x: number; y: number; z?: number }[] | null | undefined, needZ: boolean): boolean {
  return !!points && points.length >= 21 && points.slice(0, 21).every((p) => !!p && finite3(p, needZ));
}

export function stateOf(bendDeg: number, thumb: boolean): FingerState {
  const ext = thumb ? THUMB_EXTENDED_MAX_DEG : FINGER_EXTENDED_MAX_DEG;
  const bent = thumb ? THUMB_BENT_MIN_DEG : FINGER_BENT_MIN_DEG;
  return bendDeg < ext ? "extended" : bendDeg >= bent ? "bent" : "half_bent";
}

/** A reading for a hand that cannot be read (missing, non-finite or collapsed landmarks). Never a guess. */
export function unknownReading(usedWorld = false): HandPoseReading {
  return {
    label: "unknown",
    text: LABEL_TEXT.unknown,
    fingers: FINGER_ORDER.map((name) => ({ name, state: "extended" as FingerState, bendDeg: 0 })),
    spread: "together",
    thumbOut: false,
    confidence: 0,
    usedWorld,
  };
}

export function readHandPose(
  landmarks: readonly { x: number; y: number; z?: number }[],
  world?: readonly { x: number; y: number; z: number }[] | null,
): HandPoseReading {
  const useWorld = usable(world, true);
  let pts: V3[];
  if (useWorld) pts = world!.slice(0, 21).map((p) => ({ x: p.x, y: p.y, z: p.z }));
  else if (usable(landmarks, false)) pts = landmarks.slice(0, 21).map((p) => ({ x: p.x, y: p.y, z: 0 })); // 2D only
  else return unknownReading(false);

  const wrist = pts[0];
  const palmLen = norm(sub(pts[9], wrist));
  if (!(palmLen > 0)) return unknownReading(useWorld); // collapsed hand

  // ---- Flexion of each finger ----------------------------------------------------------------------------------
  // Fingers: how far the proximal phalanx (knuckle to PIP) leaves the palm, plus the angle between it and the PIP-to-tip
  // chord. The chord is long (about 45 mm), so the angle is far less noisy than the three short-bone joint angles; it
  // under-reads a fully curled finger by roughly 15 to 25 per cent, which keeps the order and the thresholds below.
  // The thumb: the angle between its first bone (CMC to MCP) and its last (IP to tip) = MCP plus IP flexion for a hinge.
  const bend: Record<FingerName, number> = { thumb: 0, index: 0, middle: 0, ring: 0, little: 0 };
  const palmNormal = useWorld ? unit(cross(sub(pts[5], wrist), sub(pts[17], wrist))) : null;
  for (const f of FOUR) {
    const [mcp, pip, , tip] = CHAINS[f];
    const prox = sub(pts[pip], pts[mcp]);
    const chord = sub(pts[tip], pts[pip]);
    let total: number;
    if (palmNormal) {
      // 3D: out-of-palm elevation of the proximal phalanx (immune to the fan of the knuckles and to splaying).
      const elevation = Math.asin(Math.min(1, Math.abs(dot(prox, palmNormal)) / norm(prox))) * (180 / Math.PI);
      total = elevation + angleDeg(prox, chord);
    } else {
      total = angleDeg(sub(pts[mcp], wrist), prox) + angleDeg(prox, chord);
      // A finger bending toward the camera shortens in the picture: when its projected bones are much shorter than a
      // straight finger's, the in-plane angle means nothing and only the reach rule (tip to wrist, in palm lengths) speaks.
      const foreshortened = norm(prox) < FORESHORTEN_PROX_MIN * palmLen || norm(chord) < FORESHORTEN_CHORD_MIN * palmLen;
      const reach = norm(sub(pts[tip], wrist)) / palmLen;
      const ext = REACH_EXTENDED[f];
      const deficiency = Math.min(1, Math.max(0, (ext - reach) / (ext - REACH_FIST[f])));
      // Squared: from the front a half-bent finger already loses much of its reach, so a linear rule over-reads it.
      const byReach = deficiency * deficiency * REACH_BEND_FULL_DEG;
      total = foreshortened ? byReach : Math.max(total, byReach);
    }
    bend[f] = total;
  }
  bend.thumb = angleDeg(sub(pts[2], pts[1]), sub(pts[4], pts[3]));
  if (!FINGER_ORDER.every((n) => Number.isFinite(bend[n]))) return unknownReading(useWorld);

  const fingers: FingerPose[] = FINGER_ORDER.map((name) => ({ name, state: stateOf(bend[name], name === "thumb"), bendDeg: bend[name] }));
  const st = (n: FingerName) => fingers[FINGER_ORDER.indexOf(n)].state;
  const ext = (n: FingerName) => st(n) === "extended";
  const bentF = (n: FingerName) => st(n) === "bent";

  // ---- Spread of the extended neighbours ---------------------------------------------------------------------
  const gaps: number[] = [];
  for (let i = 0; i < FOUR.length - 1; i++) {
    const a = FOUR[i];
    const b = FOUR[i + 1];
    if (!ext(a) || !ext(b)) continue; // curled fingers say nothing about spreading
    const da = sub(pts[CHAINS[a][3]], pts[CHAINS[a][0]]);
    const db = sub(pts[CHAINS[b][3]], pts[CHAINS[b][0]]);
    const g = angleDeg(da, db);
    if (Number.isFinite(g)) gaps.push(g);
  }
  // Averaging the gaps halves the jitter of the angle between two noisy fingertip directions, so the decisions use the
  // MEAN gap, with a guard on single gaps: together = a small mean and no wide gap; apart = a wide mean and no closed gap.
  const meanGap = gaps.reduce((a, g) => a + g, 0) / (gaps.length || 1);
  const spread: HandPoseReading["spread"] =
    gaps.length === 0 || (meanGap < SPREAD_TOGETHER_MAX_DEG && Math.max(...gaps) < SPREAD_TOGETHER_PAIR_MAX_DEG)
      ? "together"
      : meanGap >= SPREAD_APART_MIN_DEG && Math.min(...gaps) >= SPREAD_TOGETHER_MAX_DEG
        ? "apart"
        : "mixed";

  // ---- Thumb out: away from the index metacarpal and clear of the palm --------------------------------------
  const thumbAway = angleDeg(sub(pts[4], pts[1]), sub(pts[5], wrist));
  const thumbReach = norm(sub(pts[4], pts[5])) / palmLen;
  const thumbOut = st("thumb") !== "bent" && thumbAway >= THUMB_OUT_MIN_DEG && thumbReach >= THUMB_OUT_MIN_REACH;

  // ---- Label, in a fixed order of precedence -----------------------------------------------------------------
  const others = (["middle", "ring", "little"] as const);
  const allFourExt = FOUR.every(ext);
  let label: HandPoseLabel;
  if (FOUR.every(bentF) && !thumbOut) label = "fist"; // a thumbs-up (thumb out) is "thumb extended", below
  else if (ext("index") && others.every((n) => !ext(n)) && others.filter(bentF).length >= 2) label = "pointing";
  else if (ext("index") && others.filter((n) => !ext(n)).length >= 2) label = "index_extended";
  else if (thumbOut && !allFourExt) label = "thumb_extended";
  else if (allFourExt && spread === "apart") label = "fingers_spread";
  else if (allFourExt && spread === "together" && !thumbOut) label = "fingers_together";
  else if (allFourExt) label = "open_palm";
  else label = "relaxed";

  // ---- Confidence: lower for 2D angles, lower when a finger sits near a threshold ---------------------------
  let margin = 1;
  for (const f of fingers) {
    const thumb = f.name === "thumb";
    const lo = thumb ? THUMB_EXTENDED_MAX_DEG : FINGER_EXTENDED_MAX_DEG;
    const hi = thumb ? THUMB_BENT_MIN_DEG : FINGER_BENT_MIN_DEG;
    margin = Math.min(margin, Math.min(Math.abs(f.bendDeg - lo), Math.abs(f.bendDeg - hi)) / MARGIN_SPAN_DEG);
  }
  const base = useWorld ? CONFIDENCE_WORLD : CONFIDENCE_2D;
  const confidence = Math.max(0, Math.min(1, base * (0.4 + 0.6 * Math.min(1, margin))));

  return { label, text: LABEL_TEXT[label], fingers, spread, thumbOut, confidence, usedWorld: useWorld };
}
