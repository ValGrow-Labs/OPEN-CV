// The "3D reconstruction" of the MILLIMESH flow: an ESTIMATE, not a measured scan.
//
// A hand held in the air while the phone moves has no fixed reference for the camera's position, so the three
// views cannot be turned into a measured surface (docs/hand3d-research/MASTER_AUDIT.md). What this does instead:
//   1. from each view (palm, side, back) take the best accepted frames (the ones closest to the view's own ideal
//      facing, with the coin accepted where the view needs it) and the per-landmark median of their MediaPipe world
//      landmarks;
//   2. rotate the side and back sets onto the palm set (a rigid fit, Horn's method) and average the three, weighted
//      by how well each agrees with the palm (the depth of a single view is the weakest part of MediaPipe's output);
//   3. fit the generic hand surface of hand3d/handModel.ts (bones as tapered capsules, a palm slab, a forearm stub)
//      to those 21 fused joints. Its thickness is the model's own, not measured;
//   4. the size comes from the coin: the palm frames' hand length in pixels over the coin's pixels, times its real
//      diameter (the same scaling the measurements use, but without their depth correction or gates).
// Solid, Wireframe and Point Cloud are three drawings of that one fitted model. The coloured markers show the
// direction each view's best frames looked at the hand from (put on the surface of the fitted hand where that
// direction meets it); they are not measured points.
import type { FrameObservation, Point } from "../api/types";
import type { Vec3 } from "../hand3d/handModel";
import { countsFor, frameOrientation, palmZSignOf, type PhaseId } from "./coverage";

export const ESTIMATE_LABEL = "Estimated 3D model — fitted to your three views, not a measured scan";

/** Best frames kept per view. */
export const BEST_FRAMES = 12;

type V3 = [number, number, number];

export interface PhaseFit {
  /** Accepted frames the view supplied, and how many of them were used for the fit. */
  frames: number;
  used: number;
  /** RMS distance (mm) between this view's landmarks and the palm's after the rigid fit; 0 for the palm. */
  agreementMm: number;
}

export interface Marker {
  phase: PhaseId;
  /** On the surface of the fitted hand (model units: hand length 1, wrist at the origin, y up, palm towards +z). */
  position: Vec3;
  /** Which way the view looked at the hand from (unit vector, model space). */
  direction: Vec3;
  frames: number;
}

export interface FittedHand {
  /** 21 joints in model units (wrist to middle fingertip = 1), y up, the palm towards +z. */
  pose: Vec3[];
  /** Hand length (wrist to middle fingertip) the coin implies, mm; null when the palm frames carried no coin. */
  handLengthMm: number | null;
  hand: "left" | "right" | null;
  phases: Record<PhaseId, PhaseFit | null>;
  markers: Marker[];
  /** How much the views disagree (RMS mm, worst of side/back against the palm); null with only the palm. */
  agreementMm: number | null;
}

// ---------------------------------------------------------------------------------------------------------
// Small linear algebra

const points3 = (f: FrameObservation): Point[] | null => (f.world_landmarks && f.world_landmarks.length === 21 ? f.world_landmarks : f.landmarks.length === 21 ? f.landmarks : null);

function median(xs: number[]): number {
  const t = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!t.length) return 0;
  const m = t.length >> 1;
  return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2;
}

/** The per-landmark, per-axis median of several 21-point sets. */
export function medianSet(sets: Point[][]): V3[] {
  return Array.from({ length: 21 }, (_, k) => [median(sets.map((s) => s[k].x)), median(sets.map((s) => s[k].y)), median(sets.map((s) => s[k].z))] as V3);
}

const centroid = (a: V3[]): V3 => [a.reduce((s, p) => s + p[0], 0) / a.length, a.reduce((s, p) => s + p[1], 0) / a.length, a.reduce((s, p) => s + p[2], 0) / a.length];

type M3 = [V3, V3, V3];

/** Jacobi eigen-decomposition of a symmetric 4x4 matrix: eigenvalues and eigenvectors (columns). */
function jacobi4(m: number[][]): { values: number[]; vectors: number[][] } {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 40; sweep++) {
    let off = 0;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) off += a[i][j] * a[i][j];
    if (off < 1e-24) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2], a[3][3]], vectors: v };
}

/** The rotation that best takes the points `from` onto `to` (both centred on their own centroids): Horn's method. */
export function bestRotation(from: V3[], to: V3[]): M3 {
  const cf = centroid(from);
  const ct = centroid(to);
  let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0;
  for (let i = 0; i < from.length; i++) {
    const b = [from[i][0] - cf[0], from[i][1] - cf[1], from[i][2] - cf[2]];
    const t = [to[i][0] - ct[0], to[i][1] - ct[1], to[i][2] - ct[2]];
    sxx += b[0] * t[0]; sxy += b[0] * t[1]; sxz += b[0] * t[2];
    syx += b[1] * t[0]; syy += b[1] * t[1]; syz += b[1] * t[2];
    szx += b[2] * t[0]; szy += b[2] * t[1]; szz += b[2] * t[2];
  }
  const n = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const { values, vectors } = jacobi4(n);
  let best = 0;
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i;
  const q = [vectors[0][best], vectors[1][best], vectors[2][best], vectors[3][best]];
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const [w, x, y, z] = q.map((c) => c / l);
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

const apply = (r: M3, p: V3): V3 => [r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2], r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2], r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2]];
const dist3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// ---------------------------------------------------------------------------------------------------------
// Choosing the best frames of a view

/** The frames of a view that count (coin accepted where the view needs one), best first: the ones whose facing is
 *  closest to what the view is about. Ties and unreadable frames keep their order. */
export function bestFrames(phase: PhaseId, frames: readonly FrameObservation[], palmZSign: 1 | -1 | null, limit = BEST_FRAMES): FrameObservation[] {
  const ideal = phase === "palm" ? 0 : phase === "side" ? 90 : 180;
  const scored = frames
    .filter((f) => countsFor(phase, f) && points3(f))
    .map((f, i) => {
      const o = frameOrientation(f, palmZSign);
      return { f, i, off: o ? Math.abs(o.facingDeg - ideal) : 180 };
    });
  scored.sort((a, b) => a.off - b.off || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.f);
}

/** The scale from the coin: hand length (mm) of the palm frames (median of wrist-to-middle-fingertip pixels over the
 *  coin's own pixels times its diameter). No depth correction: an estimate for the picture, not a measurement. */
export function coinScaledHandLengthMm(frames: readonly FrameObservation[], coinDiameterMm: number): number | null {
  const v: number[] = [];
  for (const f of frames) {
    const c = f.coin;
    if (!c || !(c.major_axis_px > 0) || !c.accepted) continue;
    const w = f.landmarks[0];
    const t = f.landmarks[12];
    v.push((Math.hypot(t.x - w.x, t.y - w.y) / c.major_axis_px) * coinDiameterMm);
  }
  return v.length ? median(v) : null;
}

// ---------------------------------------------------------------------------------------------------------
// The fit

/** Half-extent of the fitted hand slab along the hand's lateral, finger and normal axes (hand lengths): where a
 *  view direction is said to meet the surface. */
const SLAB = { lateral: 0.27, along: 0.3, normal: 0.07 };

/** Markers closer together than this (hand lengths) are drawn side by side so each stays visible. */
export const MARKER_MIN_GAP = 0.1;

/** Move markers that sit (nearly) on top of each other apart, over the surface, until each is at least `gap` from the others.
 *  Views that looked from nearly the same direction therefore get neighbouring markers instead of one on top of another;
 *  the direction each marker stands for is kept as it was. */
export function spreadMarkers(markers: Marker[], gap = MARKER_MIN_GAP): Marker[] {
  const out = markers.map((m) => ({ ...m, position: { ...m.position } }));
  for (let i = 1; i < out.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = out[i].position;
      const b = out[j].position;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      const d = Math.hypot(dx, dy, dz);
      if (d >= gap) continue;
      if (d > 1e-6) {
        const k = (gap - d) / d;
        a.x += dx * k;
        a.y += dy * k;
        a.z += dz * k;
      } else {
        const ang = Math.PI / 2 + (i * 2 * Math.PI) / 3; // markers on the same spot fan out in a triangle
        a.x += Math.cos(ang) * gap;
        a.y += Math.sin(ang) * gap;
      }
    }
  }
  return out;
}

const toModel = (p: V3): Vec3 => ({ x: p[0], y: -p[1], z: -p[2] });

export interface FitInput {
  palm: readonly FrameObservation[];
  side: readonly FrameObservation[];
  back: readonly FrameObservation[];
  referenceDiameterMm: number;
}

/** Fit the hand model to the three views. Null when the palm view has no usable frame. */
export function fitHand({ palm, side, back, referenceDiameterMm }: FitInput): FittedHand | null {
  const palmSign = palmZSignOf(palm.filter((f) => countsFor("palm", f)));
  const palmBest = bestFrames("palm", palm, palmSign);
  if (!palmBest.length) return null;
  const base = medianSet(palmBest.map((f) => points3(f)!));
  const wLen = dist3(base[0], base[12]);
  if (!(wLen > 1e-9)) return null;

  type Part = { phase: PhaseId; set: V3[]; rot: M3; weight: number; fit: PhaseFit };
  const parts: Part[] = [
    { phase: "palm", set: base, rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], weight: 0.5, fit: { frames: palm.filter((f) => countsFor("palm", f)).length, used: palmBest.length, agreementMm: 0 } },
  ];
  const mmPerUnit = (() => {
    const mm = coinScaledHandLengthMm(palmBest, referenceDiameterMm);
    return mm === null ? null : mm / wLen;
  })();
  const phaseFits: Record<PhaseId, PhaseFit | null> = { palm: parts[0].fit, side: null, back: null };
  for (const [phase, frames] of [["side", side], ["back", back]] as const) {
    const counted = frames.filter((f) => countsFor(phase, f));
    const chosen = bestFrames(phase, frames, palmSign);
    if (!chosen.length) continue;
    const set = medianSet(chosen.map((f) => points3(f)!));
    const rot = bestRotation(set, base);
    const cs = centroid(set);
    const cb = centroid(base);
    const aligned = set.map((p) => {
      const r = apply(rot, sub3(p, cs));
      return [r[0] + cb[0], r[1] + cb[1], r[2] + cb[2]] as V3;
    });
    const rms = Math.sqrt(aligned.reduce((s, p, i) => s + dist3(p, base[i]) ** 2, 0) / 21);
    const rel = rms / wLen; // disagreement as a share of the hand length
    const weight = 0.25 / (1 + (rel / 0.08) ** 2);
    const fit: PhaseFit = { frames: counted.length, used: chosen.length, agreementMm: mmPerUnit === null ? 0 : rms * mmPerUnit };
    parts.push({ phase, set: aligned, rot, weight, fit });
    phaseFits[phase] = fit;
  }

  // Weighted mean of the aligned sets (weights of the palm and the others that agree with it).
  const total = parts.reduce((s, p) => s + p.weight, 0);
  const fused: V3[] = Array.from({ length: 21 }, (_, k) => [
    parts.reduce((s, p) => s + p.weight * p.set[k][0], 0) / total,
    parts.reduce((s, p) => s + p.weight * p.set[k][1], 0) / total,
    parts.reduce((s, p) => s + p.weight * p.set[k][2], 0) / total,
  ]);
  const len = dist3(fused[0], fused[12]) || 1;
  const pose: Vec3[] = fused.map((p) => {
    const m = toModel(sub3(p, fused[0]));
    return { x: m.x / len, y: m.y / len, z: m.z / len };
  });

  // The hand's own axes in model space, with the palm towards the viewer (+z).
  const P = (i: number): V3 => [pose[i].x, pose[i].y, pose[i].z];
  let n = unit3(cross3(sub3(P(5), P(0)), sub3(P(17), P(0))));
  if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
  const along0 = sub3(P(9), P(0));
  const f = unit3(sub3(along0, [n[0] * dot3(along0, n), n[1] * dot3(along0, n), n[2] * dot3(along0, n)]));
  const l = unit3(cross3(f, n));
  const centre: V3 = [0, 5, 9, 13, 17].reduce<V3>((s, i) => [s[0] + P(i)[0] / 5, s[1] + P(i)[1] / 5, s[2] + P(i)[2] / 5], [0, 0, 0]);

  const markers: Marker[] = [];
  for (const part of parts) {
    // The camera looks along +z in its own frame, from (0, 0, -1) as seen from the hand; in the palm frame that
    // direction is the rotation of it. Model space flips y and z of the camera frame.
    const worldDir = apply(part.rot, [0, 0, -1]);
    const d = unit3([worldDir[0], -worldDir[1], -worldDir[2]]);
    const k = 1 / Math.sqrt((dot3(d, l) / SLAB.lateral) ** 2 + (dot3(d, f) / SLAB.along) ** 2 + (dot3(d, n) / SLAB.normal) ** 2);
    markers.push({
      phase: part.phase,
      position: { x: centre[0] + d[0] * k, y: centre[1] + d[1] * k, z: centre[2] + d[2] * k },
      direction: { x: d[0], y: d[1], z: d[2] },
      frames: part.fit.used,
    });
  }

  const hand = palm.length ? ((): "left" | "right" | null => {
    const h = palm.find((x) => x.handedness)?.handedness ?? null;
    return h === "Left" ? "right" : h === "Right" ? "left" : null;
  })() : null;
  const agreements = [phaseFits.side, phaseFits.back].filter((x): x is PhaseFit => !!x).map((x) => x.agreementMm);
  return {
    pose,
    handLengthMm: mmPerUnit === null ? null : wLen * mmPerUnit,
    hand,
    phases: phaseFits,
    markers: spreadMarkers(markers),
    agreementMm: agreements.length && mmPerUnit !== null ? Math.max(...agreements) : null,
  };
}
