// Keeps the phone's screen on while a scan runs (Screen Wake Lock API), so the guided angles are not
// interrupted by the screen dimming. Entirely optional: where the browser has no wake lock, or refuses
// it (low battery, permissions policy), nothing happens and the scan carries on.
//
// The lock is released by the browser whenever the page is hidden, so it is requested again when the
// page becomes visible and a lock is still wanted.

interface Sentinel {
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
}

export interface WakeLockNavigator {
  wakeLock?: { request(type: "screen"): Promise<Sentinel> };
}

export interface WakeLockDocument {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export class ScreenWakeLock {
  private wanted = false;
  private sentinel: Sentinel | null = null;
  private pending = false;
  private listening = false;

  constructor(
    private nav: WakeLockNavigator | undefined = typeof navigator === "undefined" ? undefined : (navigator as WakeLockNavigator),
    private doc: WakeLockDocument | undefined = typeof document === "undefined" ? undefined : document,
  ) {}

  /** Whether this browser offers the Screen Wake Lock API at all. */
  get supported(): boolean {
    return typeof this.nav?.wakeLock?.request === "function";
  }

  /** Whether a lock is currently held. */
  get held(): boolean {
    return this.sentinel !== null;
  }

  private onVisibility = (): void => {
    if (this.wanted && !this.sentinel && this.doc?.visibilityState === "visible") void this.request();
  };

  private async request(): Promise<boolean> {
    if (!this.supported || this.pending || this.sentinel) return this.held;
    this.pending = true;
    try {
      const s = await this.nav!.wakeLock!.request("screen");
      if (!this.wanted) {
        // released while the request was in flight
        void s.release().catch(() => undefined);
        return false;
      }
      this.sentinel = s;
      s.addEventListener?.("release", () => {
        if (this.sentinel === s) this.sentinel = null;
      });
      return true;
    } catch {
      return false; // refused: the scan does not need it
    } finally {
      this.pending = false;
    }
  }

  /** Ask for the lock and keep it for as long as it is wanted (re-acquired when the page is shown again). */
  async acquire(): Promise<boolean> {
    this.wanted = true;
    if (this.doc && !this.listening) {
      this.doc.addEventListener("visibilitychange", this.onVisibility);
      this.listening = true;
    }
    return this.request();
  }

  /** Let the screen sleep again. Safe to call at any time, any number of times. */
  async release(): Promise<void> {
    this.wanted = false;
    if (this.doc && this.listening) {
      this.doc.removeEventListener("visibilitychange", this.onVisibility);
      this.listening = false;
    }
    const s = this.sentinel;
    this.sentinel = null;
    if (s) {
      try {
        await s.release();
      } catch {
        /* already released by the browser */
      }
    }
  }
}
