// Can the hand hold the same pose across views? A comparison of the hand's own structure between captures.
//
// The test uses quantities that do not change when the hand is turned: bone lengths relative to a reference bone, the
// bend (flexion) angle at each finger joint, and how cupped the palm is. These need 3D landmarks (MediaPipe WORLD
// landmarks, metres, a model estimate). From 2D image landmarks, bone lengths shrink when a bone turns away from the
// camera, so a comparison of views taken from different directions would blame the camera movement on the hand; such
// input is accepted but marked `reliable: false`.
//
// The tolerances are stated assumptions (MediaPipe's own noise is of the same order); they are not validated limits.
// EXPERIMENTAL.

import type { Pt3 } from "../common";
import { cross, dot, norm, sub, type V3 } from "./linalg";

/** MediaPipe hand: 0 wrist; 1-4 thumb; 5-8 index; 9-12 middle; 13-16 ring; 17-20 pinky. */
export const FINGER_CHAINS: Record<string, readonly number[]> = {
  thumb: [0, 1, 2, 3, 4],
  index: [0, 5, 6, 7, 8],
  middle: [0, 9, 10, 11, 12],
  ring: [0, 13, 14, 15, 16],
  pinky: [0, 17, 18, 19, 20],
};

const BONES: readonly (readonly [number, number])[] = [
  ...Object.values(FINGER_CHAINS).flatMap((c) => c.slice(1).map((j, i) => [c[i], j] as const)),
  [5, 9],
  [9, 13],
  [13, 17],
];

export interface ViewLandmarks {
  id: string;
  /** "world": metres, rotation-invariant comparison is valid. "image": pixels; the comparison is NOT reliable across directions. */
  kind: "world" | "image";
  /** 21 landmarks. */
  points: readonly Pt3[];
}

export interface PoseConsistencyOptions {
  /** A view is flagged when a bone's length ratio differs from the median view's by more than this (default 0.08 = 8 %). */
  boneRatioTol?: number;
  /** ... when a joint's bend differs from the median view's by more than this many degrees (default 20). */
  flexionTolDeg?: number;
  /** ... when the palm's cupping (out-of-plane distance of the knuckles / hand size) differs by more than this (default 0.06). */
  palmCupTol?: number;
}

export type ConsistencyReason = "bones_changed" | "fingers_flexed" | "palm_cupped";

export interface ViewConsistency {
  id: string;
  /** Largest relative difference of a bone's length ratio from the median view. */
  boneRatioDeviation: number;
  /** Largest difference of a joint's bend from the median view, degrees. */
  flexionDeviationDeg: number;
  /** Difference of palm cupping from the median view (fraction of hand size). */
  palmCupDeviation: number;
  flagged: boolean;
  reasons: ConsistencyReason[];
}

export interface PoseConsistencyResult {
  reliable: boolean;
  views: ViewConsistency[];
  flaggedIds: string[];
  tolerances: Required<PoseConsistencyOptions>;
  notes: string[];
}

const v3 = (p: Pt3): V3 => [p.x, p.y, p.z];
const dist = (a: Pt3, b: Pt3): number => norm(sub(v3(a), v3(b)));

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Bone lengths divided by the wrist-to-middle-knuckle length (landmarks 0 and 9), in the order of BONES. */
export function boneRatios(points: readonly Pt3[]): number[] {
  const ref = dist(points[0], points[9]);
  if (!(ref > 0)) throw new Error("degenerate hand: wrist and middle knuckle coincide");
  return BONES.map(([a, b]) => dist(points[a], points[b]) / ref);
}

/** The bend at each inner joint of each finger, in degrees (0 = straight): the angle between consecutive bones. */
export function flexionAngles(points: readonly Pt3[]): number[] {
  const out: number[] = [];
  for (const chain of Object.values(FINGER_CHAINS)) {
    for (let i = 1; i < chain.length - 1; i++) {
      const u = sub(v3(points[chain[i]]), v3(points[chain[i - 1]]));
      const w = sub(v3(points[chain[i + 1]]), v3(points[chain[i]]));
      const c = Math.max(-1, Math.min(1, dot(u, w) / (norm(u) * norm(w))));
      out.push((Math.acos(c) * 180) / Math.PI);
    }
  }
  return out;
}

/** How far the knuckles 9 and 13 lie from the plane through the wrist and the index and pinky knuckles, as a fraction of the hand size. */
export function palmCupping(points: readonly Pt3[]): number {
  const p0 = v3(points[0]);
  const n = cross(sub(v3(points[5]), p0), sub(v3(points[17]), p0));
  const len = norm(n);
  if (!(len > 0)) return 0;
  const ref = dist(points[0], points[9]);
  const off = [9, 13].map((i) => Math.abs(dot(sub(v3(points[i]), p0), n)) / len);
  return Math.max(...off) / ref;
}

export function poseConsistency(views: readonly ViewLandmarks[], options: PoseConsistencyOptions = {}): PoseConsistencyResult {
  const tolerances = { boneRatioTol: options.boneRatioTol ?? 0.08, flexionTolDeg: options.flexionTolDeg ?? 20, palmCupTol: options.palmCupTol ?? 0.06 };
  if (views.length < 2) throw new Error("need at least two views to compare");
  for (const v of views) if (v.points.length !== 21) throw new Error(`view ${v.id}: expected 21 landmarks`);

  const ratios = views.map((v) => boneRatios(v.points));
  const flex = views.map((v) => flexionAngles(v.points));
  const cup = views.map((v) => palmCupping(v.points));
  // The reference each view is compared with: the median view; with only two views, the other view (so the whole
  // difference counts, not half of it).
  const two = views.length === 2;
  const medRatio = ratios[0].map((_, k) => median(ratios.map((r) => r[k])));
  const medFlex = flex[0].map((_, k) => median(flex.map((f) => f[k])));
  const medCup = median(cup);

  const results: ViewConsistency[] = views.map((v, i) => {
    const refRatio = two ? ratios[1 - i] : medRatio;
    const refFlex = two ? flex[1 - i] : medFlex;
    const refCup = two ? cup[1 - i] : medCup;
    const boneRatioDeviation = Math.max(...ratios[i].map((r, k) => Math.abs(r / refRatio[k] - 1)));
    const flexionDeviationDeg = Math.max(...flex[i].map((f, k) => Math.abs(f - refFlex[k])));
    const palmCupDeviation = Math.abs(cup[i] - refCup);
    const reasons: ConsistencyReason[] = [];
    if (boneRatioDeviation > tolerances.boneRatioTol) reasons.push("bones_changed");
    if (flexionDeviationDeg > tolerances.flexionTolDeg) reasons.push("fingers_flexed");
    if (palmCupDeviation > tolerances.palmCupTol) reasons.push("palm_cupped");
    return { id: v.id, boneRatioDeviation, flexionDeviationDeg, palmCupDeviation, flagged: reasons.length > 0, reasons };
  });

  const reliable = views.every((v) => v.kind === "world");
  const notes = [
    "Each view is compared with the MEDIAN view; with only two views each is compared with the other, so neither can be called the odd one out and both are flagged together.",
    "Tolerances are assumptions of the same order as MediaPipe's own landmark noise, not validated limits.",
  ];
  if (!reliable) notes.push("Some views are 2D image landmarks: bone lengths foreshorten with the viewing direction, so differences may be caused by the camera, not the hand. Use world landmarks.");
  return { reliable, views: results, flaggedIds: results.filter((r) => r.flagged).map((r) => r.id), tolerances, notes };
}
