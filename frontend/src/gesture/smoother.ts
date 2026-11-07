// Hysteresis for the hand-pose reading, so the label and the finger states do not flicker from frame to frame.
//
// A new value (pose label, finger state, spread, thumb) replaces the current one only after it has been the latest
// reading for `holdMs` without a break. A value that keeps contradicting the shown one without ever holding (for
// example two labels alternating) is replaced by the latest reading after STALE_FACTOR x holdMs, so what is shown never
// stays far from what the hand is doing. The bend angles and the confidence are lightly smoothed.
import { BEND_SMOOTH_MS, CONFIDENCE_SMOOTH_MS, HOLD_MS_DEFAULT, LABEL_TEXT, STALE_FACTOR } from "./constants";
import { FINGER_ORDER, type FingerPose, type FingerState, type HandPoseLabel, type HandPoseReading } from "./types";

/** One value that changes only after it has held. */
class Held<T> {
  private candidate: { value: T; since: number } | null = null;
  private disagreeSince: number | null = null;
  constructor(
    public value: T,
    private holdMs: number,
    private staleMs: number,
  ) {}

  update(incoming: T, now: number): T {
    if (incoming === this.value) {
      this.candidate = null;
      this.disagreeSince = null;
      return this.value;
    }
    if (this.disagreeSince === null) this.disagreeSince = now;
    if (this.candidate && this.candidate.value === incoming) {
      if (now - this.candidate.since >= this.holdMs) return this.commit(incoming);
    } else {
      this.candidate = { value: incoming, since: now };
    }
    if (now - this.disagreeSince >= this.staleMs) return this.commit(incoming);
    return this.value;
  }

  private commit(value: T): T {
    this.value = value;
    this.candidate = null;
    this.disagreeSince = null;
    return value;
  }
}

export class PoseSmoother {
  private readonly holdMs: number;
  private readonly staleMs: number;
  private label: Held<HandPoseLabel> | null = null;
  private states: Held<FingerState>[] = [];
  private spread: Held<HandPoseReading["spread"]> | null = null;
  private thumbOut: Held<boolean> | null = null;
  private bend: number[] = [];
  private confidence = 0;
  private lastMs = 0;

  constructor(opts: { holdMs?: number } = {}) {
    this.holdMs = Math.max(0, opts.holdMs ?? HOLD_MS_DEFAULT);
    this.staleMs = this.holdMs * STALE_FACTOR;
  }

  /** Forget everything (call when no hand is tracked). */
  reset(): void {
    this.label = null;
    this.states = [];
    this.spread = null;
    this.thumbOut = null;
    this.bend = [];
    this.confidence = 0;
    this.lastMs = 0;
  }

  update(reading: HandPoseReading, nowMs: number): HandPoseReading {
    const dt = this.lastMs ? Math.max(0, nowMs - this.lastMs) : 0;
    this.lastMs = nowMs;
    const readable = reading.label !== "unknown";

    if (this.label === null) {
      // The first reading is shown at once.
      this.label = new Held(reading.label, this.holdMs, this.staleMs);
      this.states = reading.fingers.map((f) => new Held(f.state, this.holdMs, this.staleMs));
      this.spread = new Held(reading.spread, this.holdMs, this.staleMs);
      this.thumbOut = new Held(reading.thumbOut, this.holdMs, this.staleMs);
      this.bend = reading.fingers.map((f) => f.bendDeg);
      this.confidence = reading.confidence;
    } else {
      this.label.update(reading.label, nowMs);
      // An unreadable frame (garbage landmarks) says nothing about the fingers: keep what was shown.
      if (readable) {
        const a = 1 - Math.exp(-dt / BEND_SMOOTH_MS);
        reading.fingers.forEach((f, i) => {
          this.states[i].update(f.state, nowMs);
          this.bend[i] += (f.bendDeg - this.bend[i]) * a;
        });
        this.spread!.update(reading.spread, nowMs);
        this.thumbOut!.update(reading.thumbOut, nowMs);
      }
      const c = 1 - Math.exp(-dt / CONFIDENCE_SMOOTH_MS);
      this.confidence += (reading.confidence - this.confidence) * c;
    }

    const label = this.label.value;
    const fingers: FingerPose[] = FINGER_ORDER.map((name, i) => ({ name, state: this.states[i].value, bendDeg: this.bend[i] }));
    return {
      label,
      text: LABEL_TEXT[label],
      fingers,
      spread: this.spread!.value,
      thumbOut: this.thumbOut!.value,
      confidence: this.confidence,
      usedWorld: reading.usedWorld,
    };
  }
}
