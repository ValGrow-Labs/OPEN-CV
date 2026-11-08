// Browser-side measurements for the ?debug panel and the browser test: main-thread long tasks (PerformanceObserver
// "longtask", Chrome), animation-frame intervals, and the JS heap where the browser exposes it (performance.memory is
// Chrome-only and coarse; elsewhere it is reported as unavailable, never guessed).
import { summarise } from "./staged";

export interface LongTask {
  start: number;
  duration: number;
}

/** Collects long tasks (>= 50 ms on the main thread) from now on. `supported` is false where the browser has no longtask entries. */
export class LongTaskLog {
  readonly entries: LongTask[] = [];
  readonly supported: boolean;
  private observer: PerformanceObserver | null = null;

  constructor() {
    const types = (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes) || [];
    this.supported = types.includes("longtask");
    if (!this.supported) return;
    this.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) this.entries.push({ start: e.startTime, duration: e.duration });
    });
    this.observer.observe({ type: "longtask", buffered: false });
  }

  /** Long tasks that started in [from, to). */
  between(from: number, to: number): { count: number; totalMs: number; maxMs: number } {
    let count = 0;
    let totalMs = 0;
    let maxMs = 0;
    for (const e of this.entries) {
      if (e.start < from || e.start >= to) continue;
      count++;
      totalMs += e.duration;
      maxMs = Math.max(maxMs, e.duration);
    }
    return { count, totalMs: Math.round(totalMs), maxMs: Math.round(maxMs) };
  }

  dispose(): void {
    this.observer?.disconnect();
  }
}

/** Animation-frame intervals over `ms` milliseconds (what the page can draw while nothing else is asked of it). */
export function sampleFrames(ms: number): Promise<ReturnType<typeof summarise>> {
  return new Promise((resolve) => {
    const out: number[] = [];
    const start = performance.now();
    let last = start;
    const step = (now: number) => {
      out.push(now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(step);
      else resolve(summarise(out.slice(1)));
    };
    requestAnimationFrame(step);
  });
}

/** Used JS heap in MB from performance.memory (Chrome only), or null where the browser does not expose it. */
export function heapMb(): number | null {
  const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return m && Number.isFinite(m.usedJSHeapSize) ? Math.round((m.usedJSHeapSize / 1048576) * 10) / 10 : null;
}
