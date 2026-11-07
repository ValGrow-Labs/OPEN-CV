// The SIMULATED reconstruction of the prototype page: the experimental pipeline run on its synthetic capsule hand (not anyone's
// hand), compared with that hand's exact analytic truth. It proves that the mathematics works and nothing else: no real
// camera, no real hand, no real segmentation, no real accuracy. The page labels every part of it SIMULATED.
import type { Mesh } from "../common";
import {
  DEFAULT_HAND_PARAMS,
  FINGER_NAMES,
  FOUR_VIEWS,
  makeCapsuleHand,
  reconstructHand,
  renderCaptures,
  truthOf,
  type CarveView,
  type MetricName,
} from "../reconstruction";

export const SIMULATED_TITLE = "SIMULATED reconstruction (synthetic hand, not your hand)";
export const SIMULATED_SENTENCE = "This proves the mathematics only. It uses a computer-made hand with known dimensions, perfect cameras and perfect masks. It says nothing about real hands, real phones or real accuracy.";
export const SIMULATED_VIEWER_LABEL = "SIMULATED: a synthetic capsule hand, not a real measurement";

export interface SimulatedRow {
  metric: MetricName;
  label: string;
  unit: "mm" | "mm2";
  truth: number;
  estimate: number | null;
  error: number | null;
  /** direct: geometry of the reconstruction; model: needs an assumed axis or landmark plane. */
  basis: "direct" | "model" | "none";
}

export interface SimulatedResult {
  views: string[];
  voxelMm: number;
  ok: boolean;
  accepted: boolean;
  reasons: string[];
  mesh: Mesh | null;
  confidence: Float32Array | null;
  rows: SimulatedRow[];
  timingMs: number;
}

const LABELS: Record<string, string> = {
  handLength: "Hand length",
  palmBreadth: "Palm breadth",
  palmThickness: "Palm thickness",
  circumference: "Circumference at the knuckles",
  surfaceArea: "Surface area",
  thumb: "Thumb length",
  index: "Index finger length",
  middle: "Middle finger length",
  ring: "Ring finger length",
  little: "Little finger length",
};

/** Run the synthetic reconstruction (about half a second to a few seconds on a phone, on the page's main thread). */
export function runSimulatedReconstruction(voxelMm = 2): SimulatedResult {
  const hand = makeCapsuleHand(DEFAULT_HAND_PARAMS);
  const clean = renderCaptures(hand, FOUR_VIEWS, { width: 256, height: 256 });
  const views: CarveView[] = clean.map((c) => ({ mask: c.mask, intrinsics: c.intrinsics, pose: c.pose }));
  const r = reconstructHand(views, hand.bounds, { voxelMm, frame: hand.frame, fingers: hand.fingerAxes });
  const truth = truthOf(hand);
  const m = r.measurements;
  const pick = (metric: MetricName): { value: number | null; basis: "direct" | "model" | "none" } => {
    if (!m) return { value: null, basis: "none" };
    const q =
      metric === "handLength" ? m.handLength
      : metric === "palmBreadth" ? m.palmBreadth
      : metric === "palmThickness" ? m.palmThickness
      : metric === "circumference" ? m.circumferenceKnuckle
      : metric === "surfaceArea" ? m.surfaceArea
      : m.fingerLengths[metric as (typeof FINGER_NAMES)[number]];
    return { value: q.value, basis: q.basis };
  };
  const metrics: MetricName[] = ["handLength", "palmBreadth", "palmThickness", "circumference", "surfaceArea", ...FINGER_NAMES];
  const rows: SimulatedRow[] = metrics.map((metric) => {
    const p = pick(metric);
    return {
      metric,
      label: LABELS[metric] ?? metric,
      unit: metric === "surfaceArea" ? "mm2" : "mm",
      truth: truth[metric],
      estimate: p.value,
      error: p.value === null ? null : p.value - truth[metric],
      basis: p.basis,
    };
  });
  return {
    views: FOUR_VIEWS.map(String),
    voxelMm,
    ok: r.ok,
    accepted: r.quality?.accepted ?? false,
    reasons: r.quality?.reasons ?? (r.failure ? [r.failure] : []),
    mesh: r.mesh,
    confidence: r.confidence,
    rows,
    timingMs: r.timingsMs.total,
  };
}
