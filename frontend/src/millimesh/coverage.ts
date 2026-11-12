// Real scan coverage for the three MILLIMESH views (Palm, Side, Back). Pure functions, no DOM.
//
// A view's coverage is made of two halves, both computed only from frames the existing live checks ACCEPTED
// (hand found, in frame, sharp, steady, coin found and accepted where the view needs it; scan/scanController.ts):
//   * frames: accepted frames against the number the view collects for the sizing pipeline;
//   * angles: how many different directions the phone has seen the hand from. Each accepted frame's hand
//     orientation relative to the camera is read from MediaPipe's 3D (world) landmarks: the palm normal
//     (cross(index base - wrist, little base - wrist), turned to point out of the palm with the side the palm view
//     showed, or the handedness label) and the hand's own axes. The direction towards the camera, in the hand's own
//     frame, falls into one cell of the view's grid of angles; a cell counts once two accepted frames fall into it.
//     Landmarks are averaged over a few consecutive frames first, so depth noise on a phone held still does not
//     look like movement.
// Nothing here is a timer: holding the phone still in one place does not fill the angle half.
import type { FrameObservation, Point } from "../api/types";

export type PhaseId = "palm" | "side" | "back";

/** Angle cells of a view, in the hand's own frame (where the phone is relative to the hand). */
export type CellId =
  | "centre"
  | "toward_fingers"
  | "toward_wrist"
  | "thumb_side"
  | "little_side"
  | "edge_palm"
  | "edge_on"
  | "edge_back";

export interface PhaseGeometry {
  /** The facing angle (0 = palm straight at the camera, 90 = edge-on, 180 = back straight at the camera) the view
   *  is about, and how far from it a frame may be and still count for the angle half. */
  idealDeg: number;
  maxOffDeg: number;
  /** Cells this view can fill, and how many distinct ones complete its angle half. */
  cells: readonly CellId[];
  cellsNeeded: number;
  /** Whether a counted frame must carry a coin the coin engine accepted (the views measured for size). */
  coinRequired: boolean;
  /** Facing offset (degrees) under which a frame counts as straight on (the centre cell). */
  centreDeg: number;
}

export const PHASE_GEOMETRY: Record<PhaseId, PhaseGeometry> = {
  palm: {
    idealDeg: 0,
    maxOffDeg: 60,
    cells: ["centre", "toward_fingers", "toward_wrist", "thumb_side", "little_side"],
    cellsNeeded: 3,
    coinRequired: true,
    // The coin-tilt gate (calibration.max_tilt_deg, unchanged) keeps the palm within about 12 degrees of the
    // camera, so the palm's cells are small.
    centreDeg: 6,
  },
  side: {
    idealDeg: 90,
    maxOffDeg: 45,
    cells: ["edge_palm", "edge_on", "edge_back"],
    cellsNeeded: 2,
    coinRequired: false,
    centreDeg: 0,
  },
  back: {
    idealDeg: 180,
    maxOffDeg: 60,
    cells: ["centre", "toward_fingers", "toward_wrist", "thumb_side", "little_side"],
    cellsNeeded: 3,
    coinRequired: true,
    centreDeg: 6,
  },
};

/** Accepted frames a cell needs before it counts. */
export const FRAMES_PER_CELL = 2;
/** Consecutive accepted frames whose landmarks are averaged before the orientation is read. */
export const SMOOTH_FRAMES = 5;

type V3 = [number, number, number];
const sub = (a: Point, b: Point): V3 => [a.x - b.x, a.y - b.y, a.z - b.z];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 | null => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 && Number.isFinite(l) ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
/** Towards the camera, in MediaPipe's coordinates (x right, y down, z away from the camera). */
const TO_CAMERA: V3 = [0, 0, -1];

/** The actual hand from MediaPipe's label (it labels hands as if the picture were mirrored; ours are not). */
export function actualHand(label: FrameObservation["handedness"]): "left" | "right" | null {
  return label === "Left" ? "right" : label === "Right" ? "left" : null;
}

/** The sign the raw normal cross(index base - wrist, little base - wrist) has along the camera axis when the PALM
 *  faces the camera: for a right hand it points out of the palm (towards the camera, z < 0), for a left hand into
 *  it. Derived from the landmark layout; see coverage.test.ts. */
export function palmFacingZSign(hand: "left" | "right"): 1 | -1 {
  return hand === "right" ? -1 : 1;
}

export interface Orientation {
  /** 0 = palm straight at the camera, 90 = edge-on, 180 = back of the hand straight at the camera. */
  facingDeg: number;
  /** Where the camera is in the hand's own frame, projected on the palm plane (thumb side +, fingertips +). Unit
   *  length, or 0 when the camera is straight over the hand. */
  inPlane: { thumb: number; fingers: number };
  /** Which way the facing side was decided. */
  basis: "palm_reference" | "handedness" | "unknown";
}

const worldOrImage = (frame: FrameObservation): Point[] | null => {
  const pts = frame.world_landmarks && frame.world_landmarks.length === 21 ? frame.world_landmarks : frame.landmarks;
  return pts && pts.length >= 21 ? pts : null;
};

/** The hand's orientation relative to the camera from one frame's world landmarks (image landmarks when there are
 *  none). `palmZSign` is the sign of the raw normal's z the palm view showed (most reliable); without it the
 *  handedness label decides; without that the facing side is unknown and only 0..90 is returned. */
export function frameOrientation(frame: FrameObservation, palmZSign?: 1 | -1 | null): Orientation | null {
  const pts = worldOrImage(frame);
  if (!pts) return null;
  const n = norm(cross(sub(pts[5], pts[0]), sub(pts[17], pts[0])));
  const along = norm(sub(pts[9], pts[0]));
  if (!n || !along) return null;
  let sign: 1 | -1 | null = palmZSign ?? null;
  let basis: Orientation["basis"] = sign ? "palm_reference" : "unknown";
  if (!sign) {
    const hand = actualHand(frame.handedness);
    if (hand) {
      sign = palmFacingZSign(hand);
      basis = "handedness";
    }
  }
  // The normal out of the palm: with the palm towards the camera the raw normal's z has the sign `sign`, and the
  // normal out of the palm then points at the camera (z < 0).
  const nn: V3 = sign === 1 ? [-n[0], -n[1], -n[2]] : n;
  const c = Math.max(-1, Math.min(1, dot(nn, TO_CAMERA)));
  let facingDeg = (Math.acos(c) * 180) / Math.PI;
  if (!sign) facingDeg = Math.min(facingDeg, 180 - facingDeg); // side unknown: only how far from face-on
  // The hand's own frame: fingers axis (wrist -> middle base, made perpendicular to the normal), thumb axis.
  const d = dot(along, nn);
  const fingers = norm([along[0] - d * nn[0], along[1] - d * nn[1], along[2] - d * nn[2]]);
  if (!fingers) return { facingDeg, inPlane: { thumb: 0, fingers: 0 }, basis };
  // Thumb side: from the little-finger base towards the index base, perpendicular to the fingers axis.
  const lv = sub(pts[5], pts[17]);
  const dl = dot(lv, fingers);
  const dn = dot(lv, nn);
  const thumbAxis = norm([lv[0] - dl * fingers[0] - dn * nn[0], lv[1] - dl * fingers[1] - dn * nn[1], lv[2] - dl * fingers[2] - dn * nn[2]]);
  const pf = dot(TO_CAMERA, fingers);
  const pt = thumbAxis ? dot(TO_CAMERA, thumbAxis) : 0;
  const l = Math.hypot(pf, pt);
  return { facingDeg, inPlane: l > 1e-6 ? { thumb: pt / l, fingers: pf / l } : { thumb: 0, fingers: 0 }, basis };
}

/** The angle cell of one orientation for a view, or null when the frame is outside the view's range. */
export function cellOf(phase: PhaseId, o: Orientation): CellId | null {
  const g = PHASE_GEOMETRY[phase];
  if (Math.abs(o.facingDeg - g.idealDeg) > g.maxOffDeg) return null;
  if (phase === "side") {
    if (o.facingDeg < 75) return "edge_palm";
    if (o.facingDeg <= 105) return "edge_on";
    return "edge_back";
  }
  const off = Math.abs(o.facingDeg - g.idealDeg);
  if (off < g.centreDeg) return "centre";
  const { thumb, fingers } = o.inPlane;
  if (thumb === 0 && fingers === 0) return "centre";
  if (Math.abs(fingers) >= Math.abs(thumb)) return fingers >= 0 ? "toward_fingers" : "toward_wrist";
  return thumb >= 0 ? "thumb_side" : "little_side";
}

/** The sign of the raw normal's z over the palm view's frames (the clearly-tilted ones): which way the palm
 *  faced. Null when the frames do not say. */
export function palmZSignOf(frames: readonly FrameObservation[]): 1 | -1 | null {
  let pos = 0;
  let neg = 0;
  for (const f of frames) {
    const pts = worldOrImage(f);
    if (!pts) continue;
    const n = norm(cross(sub(pts[5], pts[0]), sub(pts[17], pts[0])));
    if (!n || Math.abs(n[2]) < 0.3) continue;
    if (n[2] > 0) pos++;
    else neg++;
  }
  if (pos === neg) return null;
  return pos > neg ? 1 : -1;
}

/** The frames with each one's landmarks averaged over the last `window` frames (a moving mean). */
export function smoothedFrames(frames: readonly FrameObservation[], window = SMOOTH_FRAMES): FrameObservation[] {
  return frames.map((f, i) => {
    const group = frames.slice(Math.max(0, i - window + 1), i + 1);
    const mean = (pick: (g: FrameObservation) => Point[] | null): Point[] | null => {
      const sets = group.map(pick);
      if (sets.some((x) => !x || x.length !== 21)) return null;
      return Array.from({ length: 21 }, (_, k) => ({
        x: sets.reduce((a, x) => a + x![k].x, 0) / sets.length,
        y: sets.reduce((a, x) => a + x![k].y, 0) / sets.length,
        z: sets.reduce((a, x) => a + x![k].z, 0) / sets.length,
      }));
    };
    return { ...f, landmarks: mean((g) => g.landmarks) ?? f.landmarks, world_landmarks: mean((g) => g.world_landmarks) ?? f.world_landmarks };
  });
}

export interface Coverage {
  phase: PhaseId;
  /** Accepted frames that count (coin accepted where the view needs one). */
  frames: number;
  /** Frames the sizing pipeline collects in this view. */
  framesTarget: number;
  /** The pipeline has what it needs for this view (its own completion rule was met). */
  pipelineReady: boolean;
  /** Frames per cell, for the cells this view can fill. */
  cellFrames: Partial<Record<CellId, number>>;
  cellsCovered: CellId[];
  cellsNeeded: number;
  /** 0..1 each. */
  framePart: number;
  anglePart: number;
  /** 0..100, an integer; 100 only when both halves are complete. */
  percent: number;
  complete: boolean;
  /** The first cell still missing (for guidance), or null. */
  nextCell: CellId | null;
}

export interface CoverageInput {
  phase: PhaseId;
  frames: readonly FrameObservation[];
  framesTarget: number;
  pipelineReady: boolean;
  /** Which way the palm faced in the palm view (palmZSignOf), for the side and back views. */
  palmZSign?: 1 | -1 | null;
}

/** Whether a frame counts for a view (it was accepted by the live checks; this adds the coin rule). */
export function countsFor(phase: PhaseId, f: FrameObservation): boolean {
  if (!PHASE_GEOMETRY[phase].coinRequired) return true;
  return !!f.coin && f.coin.accepted === true;
}

export function computeCoverage({ phase, frames, framesTarget, pipelineReady, palmZSign }: CoverageInput): Coverage {
  const g = PHASE_GEOMETRY[phase];
  const counted = frames.filter((f) => countsFor(phase, f));
  const smooth = smoothedFrames(counted);
  const cellFrames: Partial<Record<CellId, number>> = {};
  // In the palm view the side the palm showed is the side its own frames show.
  const sign = phase === "palm" ? (palmZSign ?? palmZSignOf(counted)) : (palmZSign ?? null);
  // A moving mean is read only once its window is full.
  for (const f of smooth.slice(Math.min(SMOOTH_FRAMES - 1, Math.max(0, smooth.length - 1)))) {
    const o = frameOrientation(f, sign);
    if (!o) continue;
    const c = cellOf(phase, o);
    if (c) cellFrames[c] = (cellFrames[c] ?? 0) + 1;
  }
  const cellsCovered = g.cells.filter((c) => (cellFrames[c] ?? 0) >= FRAMES_PER_CELL);
  const target = Math.max(1, framesTarget);
  const framePart = pipelineReady && counted.length > 0 ? 1 : Math.min(0.95, counted.length / target);
  const anglePart = Math.min(1, cellsCovered.length / g.cellsNeeded);
  const complete = framePart >= 1 && anglePart >= 1;
  const raw = Math.floor(100 * (0.5 * framePart + 0.5 * anglePart));
  const percent = complete ? 100 : Math.min(99, raw);
  const nextCell = anglePart >= 1 ? null : (g.cells.find((c) => !cellsCovered.includes(c)) ?? null);
  return { phase, frames: counted.length, framesTarget: target, pipelineReady, cellFrames, cellsCovered, cellsNeeded: g.cellsNeeded, framePart, anglePart, percent, complete, nextCell };
}

/** Plain guidance towards the next missing angle (the phone moves, the hand stays still). */
export function angleHint(phase: PhaseId, cell: CellId | null): string | null {
  if (!cell) return null;
  switch (cell) {
    case "centre":
      return phase === "back" ? "Hold your phone straight over the back of your hand" : "Hold your phone straight over your palm";
    case "toward_fingers":
      return "Move your phone a little towards your fingertips";
    case "toward_wrist":
      return "Move your phone a little towards your wrist";
    case "thumb_side":
      return "Move your phone a little towards your thumb";
    case "little_side":
      return "Move your phone a little towards your little finger";
    case "edge_palm":
      return "Tilt your phone a little towards your palm";
    case "edge_on":
      return "Hold your phone level with the edge of your hand";
    case "edge_back":
      return "Tilt your phone a little towards the back of your hand";
  }
}
