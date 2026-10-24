// Exposure compensation while scanning. Phone cameras expose for the whole picture; a dark
// background (a patterned sheet, a dark table) makes them brighten it until the coin and the palm
// are blown out and the coin is refused for glare. Where the browser lets us (Chrome on Android
// exposes `exposureCompensation`), the exposure is eased down while that happens, and up when
// the picture is dark, in small steps with a pause between them. Elsewhere nothing happens.
import type { LiveScanParams } from "../api/types";
import type { LiveCode } from "../vision/liveChecks";

export interface ExposureRange {
  min: number;
  max: number;
  step: number;
}

export type ExposureSettings = Pick<
  LiveScanParams,
  "auto_exposure" | "exposure_step_ev" | "exposure_min_ev" | "exposure_max_ev" | "exposure_hold_ms" | "exposure_min_share"
>;

// Exposure compensation is not in every browser's type definitions, so the track is read loosely.
type ExposureTrack = {
  getCapabilities?: () => { exposureCompensation?: Partial<ExposureRange> };
  getSettings?: () => { exposureCompensation?: number };
};

/** The track's exposure range, or null when the browser does not offer exposure compensation. */
export function exposureRange(track: MediaStreamTrack | null | undefined): ExposureRange | null {
  const t = track as unknown as ExposureTrack | null | undefined;
  const cap = t?.getCapabilities?.().exposureCompensation;
  if (!cap || typeof cap.min !== "number" || typeof cap.max !== "number" || !(cap.max > cap.min)) return null;
  return { min: cap.min, max: cap.max, step: typeof cap.step === "number" && cap.step > 0 ? cap.step : 0.1 };
}

const TOO_BRIGHT: LiveCode[] = ["coin_glare", "too_bright"];

/** Which way the exposure should move for the problem that dominates right now: -1, 0 or +1. */
export function exposureDirection(code: LiveCode | null, share: number, minShare: number): -1 | 0 | 1 {
  if (!code || share < minShare) return 0;
  if (TOO_BRIGHT.includes(code)) return -1;
  if (code === "too_dark") return 1;
  return 0;
}

/** The next exposure value: one step in `direction`, inside both our limits and the camera's. */
export function nextExposure(current: number, direction: -1 | 1, s: ExposureSettings, range: ExposureRange): number {
  const lo = Math.max(range.min, s.exposure_min_ev);
  const hi = Math.min(range.max, s.exposure_max_ev);
  const snapped = Math.round((current + direction * s.exposure_step_ev) / range.step) * range.step;
  return Math.min(hi, Math.max(lo, Number(snapped.toFixed(3))));
}

export class ExposureController {
  private range: ExposureRange | null = null;
  private value = 0;
  private lastMs = -Infinity;
  private broken = false;

  constructor(
    private s: ExposureSettings,
    private track: MediaStreamTrack | null,
  ) {
    if (!s.auto_exposure) return;
    this.range = exposureRange(track);
    const now = (track as unknown as ExposureTrack | null)?.getSettings?.().exposureCompensation;
    if (typeof now === "number") this.value = now;
  }

  /** When the exposure last changed (the problem readings before that describe the old picture). */
  get lastStepMs(): number {
    return this.lastMs;
  }

  /** Current exposure compensation in EV, or null when it cannot be controlled. */
  get ev(): number | null {
    return this.range && !this.broken ? this.value : null;
  }

  /** Called with the problem that dominates right now; moves the exposure at most once per hold. */
  consider(nowMs: number, code: LiveCode | null, share: number): void {
    if (!this.range || this.broken || !this.track) return;
    const dir = exposureDirection(code, share, this.s.exposure_min_share);
    if (dir === 0 || nowMs - this.lastMs < this.s.exposure_hold_ms) return;
    const next = nextExposure(this.value, dir, this.s, this.range);
    if (next === this.value) return;
    this.lastMs = nowMs;
    this.value = next;
    this.track.applyConstraints({ advanced: [{ exposureCompensation: next } as MediaTrackConstraintSet] }).catch(() => {
      this.broken = true; // this camera refuses: stop trying, the scan carries on
    });
  }
}
