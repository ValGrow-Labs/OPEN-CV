// Steady live guidance. The per-frame checks decide which frames are usable; this decides what the
// customer is *told*. Frame by frame the checks flip (a flat coin reads "tilted" now and "fine" a
// moment later), and a message that changes every few hundred milliseconds cannot be acted on.
// The message shown is the problem that dominates the last `guidance_window_ms`, kept for at least
// `guidance_hold_ms`, and replaced by another problem only when that one clearly dominates.
import type { LiveScanParams } from "../api/types";
import type { LiveCode } from "../vision/liveChecks";

export type GuidanceSettings = Pick<
  LiveScanParams,
  "guidance_window_ms" | "guidance_hold_ms" | "guidance_min_share" | "guidance_keep_share" | "guidance_switch_margin"
>;

export interface IssueSample {
  t: number;
  /** The most important problem of that camera frame; null when the frame was fine. */
  code: LiveCode | null;
}

/** The problem that shows up in most samples taken at or after `sinceMs`, and its share of them. */
export function dominantIssue(log: readonly IssueSample[], sinceMs: number): { code: LiveCode; share: number } | null {
  const counts = new Map<LiveCode, number>();
  let n = 0;
  for (const e of log) {
    if (e.t < sinceMs) continue;
    n++;
    if (e.code) counts.set(e.code, (counts.get(e.code) ?? 0) + 1);
  }
  let best: LiveCode | null = null;
  for (const [code, c] of counts) if (best === null || c > counts.get(best)!) best = code;
  return best ? { code: best, share: counts.get(best)! / n } : null;
}

export class GuidanceDebouncer {
  private log: IssueSample[] = [];
  // Running counts of the codes in `log`, so a frame costs the same however long the window is.
  private counts = new Map<LiveCode | null, number>();
  private current: LiveCode | null = null;
  private since = -Infinity;

  constructor(private s: GuidanceSettings) {}

  reset(): void {
    this.log = [];
    this.counts.clear();
    this.current = null;
    this.since = -Infinity;
  }

  private share(code: LiveCode | null): number {
    return this.log.length === 0 ? 0 : (this.counts.get(code) ?? 0) / this.log.length;
  }

  private add(e: IssueSample): void {
    this.log.push(e);
    this.counts.set(e.code, (this.counts.get(e.code) ?? 0) + 1);
  }

  private drop(): void {
    const e = this.log.shift()!;
    this.counts.set(e.code, (this.counts.get(e.code) ?? 1) - 1);
  }

  /** `codes` are this frame's problems, most important first (empty: the frame is fine).
   *  Returns the problem to show, or null when all is well. */
  update(now: number, codes: LiveCode[]): LiveCode | null {
    // No hand is not a judgement call: say so at once and start over when it comes back.
    if (codes.includes("no_hand")) {
      this.reset();
      return "no_hand";
    }
    this.add({ t: now, code: codes[0] ?? null });
    const oldest = now - this.s.guidance_window_ms;
    while (this.log.length && this.log[0].t < oldest) this.drop();

    let best: LiveCode | null = null;
    for (const [code, c] of this.counts) if (code !== null && c > 0 && (best === null || c > this.counts.get(best)!)) best = code;
    // A share means little until the window holds a fair stretch of frames (a third of it).
    const enough = now - this.log[0].t >= this.s.guidance_window_ms / 3;
    const candidate = enough && best !== null && this.share(best) >= this.s.guidance_min_share ? best : null;

    if (candidate === this.current) return this.current;
    // Whatever is shown stays for a minimum time, and while it is still a real part of the picture.
    if (now - this.since < this.s.guidance_hold_ms) return this.current;
    if (this.current !== null) {
      if (candidate === null && this.share(this.current) >= this.s.guidance_keep_share) return this.current;
      // Two problems of similar weight must not take turns: the newcomer has to clearly dominate.
      if (candidate !== null && this.share(candidate) < this.share(this.current) + this.s.guidance_switch_margin) return this.current;
    }
    this.current = candidate;
    this.since = now;
    return this.current;
  }
}
