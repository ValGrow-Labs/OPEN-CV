// Error statistics for validation: pure functions, no data, no claims. They turn pairs of (reconstructed, reference)
// numbers into the figures a validation report needs. They say nothing until they are fed real paired measurements
// (a reconstruction and an anthropometric instrument reading of the SAME hand); fed synthetic pairs their output is
// synthetic and must be labelled so.

export interface ErrorStats {
  n: number;
  /** Mean of (estimate - reference): the systematic offset. Positive = over-estimates. */
  bias: number;
  /** Mean absolute error. */
  mae: number;
  /** Root-mean-square error. */
  rmse: number;
  /** Sample standard deviation of the errors (spread after removing bias). */
  sd: number;
  maxAbs: number;
  /** 95th percentile of the absolute error. */
  p95Abs: number;
}

export interface Pair {
  estimate: number;
  reference: number;
}

export function errorStats(pairs: readonly Pair[]): ErrorStats | null {
  const e = pairs.filter((p) => Number.isFinite(p.estimate) && Number.isFinite(p.reference)).map((p) => p.estimate - p.reference);
  const n = e.length;
  if (n === 0) return null;
  const bias = e.reduce((s, x) => s + x, 0) / n;
  const mae = e.reduce((s, x) => s + Math.abs(x), 0) / n;
  const rmse = Math.sqrt(e.reduce((s, x) => s + x * x, 0) / n);
  const sd = n > 1 ? Math.sqrt(e.reduce((s, x) => s + (x - bias) ** 2, 0) / (n - 1)) : 0;
  const abs = e.map(Math.abs).sort((a, b) => a - b);
  const p95Abs = abs[Math.min(n - 1, Math.ceil(0.95 * n) - 1)];
  return { n, bias, mae, rmse, sd, maxAbs: abs[n - 1], p95Abs };
}

/** Share of attempts that failed (no usable reconstruction), with the counts. */
export function failureRate(results: readonly { ok: boolean }[]): { attempts: number; failures: number; rate: number } {
  const failures = results.filter((r) => !r.ok).length;
  return { attempts: results.length, failures, rate: results.length ? failures / results.length : NaN };
}

export interface Repeatability {
  n: number;
  mean: number;
  sd: number;
  range: number;
  /** Coefficient of variation in percent (sd / mean). */
  cvPercent: number;
  /** Repeatability limit: 2.77 * sd, the difference two repeats of the same hand stay within 95 % of the time (normal errors assumed). */
  repeatabilityLimit95: number;
}

/** Repeated measurements of the SAME hand with the same method. */
export function repeatability(values: readonly number[]): Repeatability | null {
  const v = values.filter(Number.isFinite);
  const n = v.length;
  if (n < 2) return null;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd, range: Math.max(...v) - Math.min(...v), cvPercent: mean !== 0 ? (100 * sd) / Math.abs(mean) : NaN, repeatabilityLimit95: 2.77 * sd };
}

export function median(values: readonly number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
