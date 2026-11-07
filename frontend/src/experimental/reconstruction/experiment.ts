// The SYNTHETIC experiment: reconstruct the capsule hand from rendered silhouettes under controlled input errors and
// compare every dimension with the exact analytic truth. This proves that the mathematics works and shows how errors in
// the inputs (mask boundary, focal length, camera pose, number of views) propagate. It does NOT say anything about real
// hands, real phones, real segmentation or real accuracy. Every table made here carries the word SYNTHETIC.
import type { CarveView } from "./carving";
import { extractMesh, meshArea, sdfToField } from "./meshing";
import { FINGER_NAMES, type FingerName } from "./measure";
import { reconstructHand } from "./pipeline";
import { capsulePrior } from "./prior";
import { DEFAULT_HAND_PARAMS, EIGHT_VIEWS, FOUR_VIEWS, jitterMask, makeCapsuleHand, perturbPose, renderCaptures, scaleFocal, type CapsuleHand, type CapsuleHandParams, type RigViewName } from "./synthetic";
import { errorStats } from "./stats";

export interface NoiseSpec {
  /** Peak boundary displacement of every silhouette, pixels. */
  jitterPx?: number;
  /** Focal length used for carving relative to the true one (1.02 = 2 % too long). */
  focalFactor?: number;
  /** Camera orientation error (degrees) and centre error (mm) applied to every view, random directions. */
  poseRotDeg?: number;
  poseTransMm?: number;
  seed?: number;
}

export interface Scenario {
  label: string;
  views: RigViewName[];
  noise: NoiseSpec;
  /** Trim the hull with a fitted capsule prior (see prior.ts). */
  prior?: boolean;
  /** Carving tolerance: silhouettes a voxel may fall outside of (default 0). */
  tolerance?: number;
}

export type MetricName = "handLength" | "palmBreadth" | "palmThickness" | "circumference" | "surfaceArea" | FingerName;

export interface ScenarioResult {
  scenario: Scenario;
  ok: boolean;
  accepted: boolean;
  reasons: string[];
  /** estimate - truth for every metric (null when it could not be measured). Millimetres, except surfaceArea (mm^2). */
  errors: Record<MetricName, number | null>;
  estimates: Record<MetricName, number | null>;
  meshCompleteness: number | null;
  meanIoU: number | null;
  totalMs: number;
}

export const METRICS: MetricName[] = ["handLength", "palmBreadth", "palmThickness", "circumference", "surfaceArea", ...FINGER_NAMES];

export interface ExperimentConfig {
  hand?: CapsuleHand;
  voxelMm?: number;
  imageSize?: number;
  seed?: number;
}

const referenceAreaCache = new Map<string, number>();

/** The surface area of the capsule hand from a fine reference mesh of its SDF (no analytic formula exists). */
export function referenceSurfaceArea(hand: CapsuleHand, voxelMm = 0.8): number {
  const key = JSON.stringify([hand.params, voxelMm]);
  const hit = referenceAreaCache.get(key);
  if (hit !== undefined) return hit;
  const b = hand.bounds;
  const field = sdfToField(hand.sdf, { min: [b.min[0] - 2, b.min[1] - 2, b.min[2] - 2], max: [b.max[0] + 2, b.max[1] + 2, b.max[2] + 2] }, voxelMm);
  const area = meshArea(extractMesh(field, 0));
  referenceAreaCache.set(key, area);
  return area;
}

export function truthOf(hand: CapsuleHand): Record<MetricName, number> {
  return {
    handLength: hand.truth.handLengthMm,
    palmBreadth: hand.truth.palmBreadthMm,
    palmThickness: hand.truth.palmThicknessMm,
    circumference: hand.truth.circumferenceMm,
    surfaceArea: referenceSurfaceArea(hand),
    ...hand.truth.fingerLengthsMm,
  };
}

export function runScenario(sc: Scenario, cfg: ExperimentConfig = {}): ScenarioResult {
  const hand = cfg.hand ?? makeCapsuleHand(DEFAULT_HAND_PARAMS);
  const size = cfg.imageSize ?? 256;
  const seed = sc.noise.seed ?? cfg.seed ?? 1;
  const clean = renderCaptures(hand, sc.views, { width: size, height: size });
  const views: CarveView[] = clean.map((c, i) => ({
    mask: sc.noise.jitterPx ? jitterMask(c.mask, sc.noise.jitterPx, seed * 100 + i) : c.mask,
    intrinsics: sc.noise.focalFactor ? scaleFocal(c.intrinsics, sc.noise.focalFactor) : c.intrinsics,
    pose: sc.noise.poseRotDeg || sc.noise.poseTransMm ? perturbPose(c.pose, sc.noise.poseRotDeg ?? 0, sc.noise.poseTransMm ?? 0, seed * 1000 + i) : c.pose,
  }));
  const r = reconstructHand(views, hand.bounds, {
    voxelMm: cfg.voxelMm ?? 1.5,
    tolerance: sc.tolerance,
    frame: hand.frame,
    fingers: hand.fingerAxes,
    ignoreGate: true, // the table reports the area ungated, and `accepted` separately
    prior: sc.prior ? capsulePrior({ ...DEFAULT_HAND_PARAMS, palmThickness: 22, palmBreadth: 82 } as CapsuleHandParams) : undefined,
  });
  const truth = truthOf(hand);
  const est = {} as Record<MetricName, number | null>;
  const err = {} as Record<MetricName, number | null>;
  const m = r.measurements;
  if (m) {
    est.handLength = m.handLength.value;
    est.palmBreadth = m.palmBreadth.value;
    est.palmThickness = m.palmThickness.value;
    est.circumference = m.circumferenceKnuckle.value;
    est.surfaceArea = m.surfaceArea.value;
    for (const f of FINGER_NAMES) est[f] = m.fingerLengths[f].value;
  }
  for (const k of METRICS) {
    est[k] = est[k] ?? null;
    err[k] = est[k] === null ? null : (est[k] as number) - truth[k];
  }
  return {
    scenario: sc,
    ok: r.ok,
    accepted: r.quality?.accepted ?? false,
    reasons: r.quality?.reasons ?? (r.failure ? [r.failure] : []),
    errors: err,
    estimates: est,
    meshCompleteness: r.quality?.metrics.completeness ?? null,
    meanIoU: r.quality?.metrics.meanIoU ?? null,
    totalMs: r.timingsMs.total,
  };
}

export const NOISE_LEVELS: { label: string; noise: NoiseSpec }[] = [
  { label: "none", noise: {} },
  { label: "mask edge +-1 px", noise: { jitterPx: 1 } },
  { label: "mask edge +-2 px", noise: { jitterPx: 2 } },
  { label: "focal +2 %", noise: { focalFactor: 1.02 } },
  { label: "pose 1 deg, 2 mm", noise: { poseRotDeg: 1, poseTransMm: 2 } },
  { label: "pose 2 deg, 4 mm", noise: { poseRotDeg: 2, poseTransMm: 4 } },
  { label: "all: 1 px, +2 %, 1 deg", noise: { jitterPx: 1, focalFactor: 1.02, poseRotDeg: 1, poseTransMm: 2 } },
];

export const VIEW_SETS: { label: string; views: RigViewName[] }[] = [
  { label: "2 views (palm, back)", views: ["palm", "back"] },
  { label: "4 views (palm, thumb, little, back)", views: FOUR_VIEWS },
  { label: "8 views (4 + 4 oblique)", views: EIGHT_VIEWS },
];

/** The scenarios of the full grid: every view set under every noise level, plus the prior on the 2- and 4-view sets with
 *  no noise and with the combined noise, plus a carving tolerance against pose error. 29 reconstructions. */
export function syntheticGridScenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const vs of VIEW_SETS) for (const nl of NOISE_LEVELS) out.push({ label: `${vs.label} / ${nl.label}`, views: vs.views, noise: nl.noise });
  for (const vs of VIEW_SETS.slice(0, 2))
    for (const nl of [NOISE_LEVELS[0], NOISE_LEVELS[NOISE_LEVELS.length - 1]]) out.push({ label: `${vs.label} + capsule prior / ${nl.label}`, views: vs.views, noise: nl.noise, prior: true });
  // does a carving tolerance rescue a hull built from slightly wrong poses?
  for (const tol of [1, 2]) out.push({ label: `${VIEW_SETS[2].label} / pose 1 deg, 2 mm / carving tolerance ${tol}`, views: VIEW_SETS[2].views, noise: NOISE_LEVELS[4].noise, tolerance: tol });
  return out;
}

export function runSyntheticGrid(cfg: ExperimentConfig = {}): ScenarioResult[] {
  return syntheticGridScenarios().map((sc) => runScenario(sc, cfg));
}

const f1 = (v: number | null) => (v === null ? "n/a" : (v >= 0 ? "+" : "") + v.toFixed(1));

/** A markdown table of the signed errors (estimate minus truth), labelled SYNTHETIC. */
export function formatGridTable(rows: ScenarioResult[]): string {
  const head = "| scenario | accepted | length mm | breadth mm | thickness mm | circumf. mm | thumb mm | index mm | middle mm | ring mm | little mm | area mm2 | ms |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const lines = rows.map((r) => {
    const e = r.errors;
    const gate = r.accepted ? "yes" : `no (${r.reasons.join(", ") || "n/a"})`;
    return `| ${r.scenario.label} | ${gate} | ${f1(e.handLength)} | ${f1(e.palmBreadth)} | ${f1(e.palmThickness)} | ${f1(e.circumference)} | ${f1(e.thumb)} | ${f1(e.index)} | ${f1(e.middle)} | ${f1(e.ring)} | ${f1(e.little)} | ${f1(e.surfaceArea)} | ${Math.round(r.totalMs)} |`;
  });
  return `SYNTHETIC results (signed error = estimate - exact truth of a capsule hand; says nothing about real hands)\n\n${head}\n${lines.join("\n")}`;
}

/** MAE, RMSE and bias over a set of scenarios for one metric (all synthetic). */
export function metricStats(rows: ScenarioResult[], metric: MetricName) {
  return errorStats(rows.filter((r) => r.errors[metric] !== null).map((r) => ({ estimate: r.errors[metric] as number, reference: 0 })));
}

export interface RepeatabilityRow {
  metric: MetricName;
  repeats: number;
  mean: number;
  sd: number;
  range: number;
  /** Mean error against the truth over the repeats (the bias, which repeatability alone does not show). */
  bias: number;
}

/** Reconstruct the same synthetic hand ``n`` times, each with a different noise seed, and report how much each
 *  dimension varies (SYNTHETIC repeatability: a pure measure of the pipeline's sensitivity to the injected noise). */
export function runRepeatability(sc: Scenario, n: number, cfg: ExperimentConfig = {}): RepeatabilityRow[] {
  const hand = cfg.hand ?? makeCapsuleHand(DEFAULT_HAND_PARAMS);
  const truth = truthOf(hand);
  const runs = Array.from({ length: n }, (_, i) => runScenario({ ...sc, noise: { ...sc.noise, seed: (sc.noise.seed ?? 1) + i } }, { ...cfg, hand }));
  return METRICS.map((metric) => {
    const v = runs.map((r) => r.estimates[metric]).filter((x): x is number => x !== null);
    const mean = v.reduce((a, b) => a + b, 0) / (v.length || 1);
    const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
    return { metric, repeats: v.length, mean, sd, range: v.length ? Math.max(...v) - Math.min(...v) : 0, bias: mean - truth[metric] };
  });
}
