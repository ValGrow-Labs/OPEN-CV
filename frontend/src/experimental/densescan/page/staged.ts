// The core's buildPointSet, run stage by stage so the page can time generation and validation separately (the ?debug
// timings). It calls the SAME core functions in the SAME order as core/pointset.ts buildPointSet; a unit test checks that
// both give identical point sets, so this can never drift into a second implementation.
import {
  countPoints,
  dedupeAndFilter,
  DEFAULT_DOT_CONFIG,
  estimateRelativeDepth,
  generateSurfacePoints,
  labelRegions,
  resolveSpacing,
  validatePoints,
  type BuildPointSetInput,
  type DotConfig,
  type PointSet,
} from "../core";

export interface StageTimings {
  generateMs: number;
  validateMs: number;
  filterMs: number;
  regionsMs: number;
  depthMs: number;
  totalMs: number;
}

export function stagedPointSet(input: BuildPointSetInput, now: () => number = () => performance.now()): { set: PointSet; timings: StageTimings } {
  const t0 = now();
  const cfg: DotConfig = { ...DEFAULT_DOT_CONFIG, ...input.config };
  const scale = input.scale ?? null;
  const sp = resolveSpacing(cfg, scale);
  const used: DotConfig = { ...cfg, spacingPx: sp.spacingPx };
  let pts = generateSurfacePoints(input.mask, input.scaleToSource, used);
  const t1 = now();
  if (input.image) {
    pts = validatePoints(pts, input.image, input.mask, input.scaleToSource, { edgeMarginPx: used.edgeMarginPx, ...input.validate });
  } else {
    pts = pts.map((p) => (p.edgeDistPx < used.edgeMarginPx ? { ...p, accepted: false, reject: "near_edge" as const, quality: 0 } : p));
  }
  const t2 = now();
  pts = dedupeAndFilter(pts, used);
  const t3 = now();
  if (input.landmarks) pts = labelRegions(pts, input.landmarks);
  const t4 = now();
  if (input.landmarks3d) pts = estimateRelativeDepth(pts, input.landmarks3d);
  const t5 = now();
  const set: PointSet = {
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    points: pts,
    config: used,
    mmPerPx: scale && scale.mmPerPx > 0 ? scale.mmPerPx : null,
    spacing: { px: sp.spacingPx, mm: sp.spacingMm, limitedByResolution: sp.limitedByResolution, note: sp.note },
    counts: countPoints(pts),
    mask: input.mask,
    scaleToSource: input.scaleToSource,
  };
  return { set, timings: { generateMs: t1 - t0, validateMs: t2 - t1, filterMs: t3 - t2, regionsMs: t4 - t3, depthMs: t5 - t4, totalMs: now() - t0 } };
}

/** Summary of per-frame costs (ms): count, median, 95th percentile, max. */
export function summarise(values: readonly number[]): { frames: number; medianMs: number | null; p95Ms: number | null; maxMs: number | null; meanMs: number | null } {
  if (!values.length) return { frames: 0, medianMs: null, p95Ms: null, maxMs: null, meanMs: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
  const r = (v: number) => Math.round(v * 100) / 100;
  return { frames: s.length, medianMs: r(at(0.5)), p95Ms: r(at(0.95)), maxMs: r(s[s.length - 1]), meanMs: r(s.reduce((a, b) => a + b, 0) / s.length) };
}
