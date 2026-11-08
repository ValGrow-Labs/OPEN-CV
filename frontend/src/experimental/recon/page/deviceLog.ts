// Device performance log of the EXPERIMENTAL board-capture page, for the physical validation: how long capture, build
// and export took on THIS device, the JS heap over time (Chrome's performance.memory every 2 s; null where the browser
// has none), the device's own figures (memory class, cores, screen), the camera track's settings (without its device
// and group ids), uncaught errors and unhandled rejections (messages only: paths and URLs replaced), WebGL context
// losses, worker failures and whether the export was prepared. In memory only; written as device.json in the export.
// Nothing here is sent anywhere.

export interface DeviceJson {
  user_agent: string | null;
  screen: { width: number; height: number; device_pixel_ratio: number } | null;
  device_memory_gb: number | null;
  hardware_concurrency: number | null;
  camera: { width: number | null; height: number | null; settings: Record<string, unknown> | null };
  capture_ms: number | null;
  build_ms: number | null;
  export_ms: number | null;
  heap_samples_mb: number[] | null;
  peak_heap_mb: number | null;
  errors: string[];
  webgl_context_lost: number;
  export_ok: boolean | null;
  started_at: string;
  finished_at: string | null;
}

export const HEAP_SAMPLE_MS = 2000;
const MAX_ERRORS = 50;
const MAX_SAMPLES = 3600;

/** A message without file paths or URLs from this machine (no stack traces are ever kept). */
export function sanitizeMessage(raw: unknown): string {
  let s = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : (() => {
    try {
      return JSON.stringify(raw) ?? String(raw);
    } catch {
      return String(raw);
    }
  })();
  s = s.split("\n")[0];
  s = s.replace(/\b(?:https?|file|blob|webpack|chrome-extension):\/\/\S+/gi, "<url>");
  s = s.replace(/\b[A-Za-z]:[\\/][^\s"'<>)]*/g, "<path>"); // C:\Users\... or C:/Users/...
  s = s.replace(/(^|[\s("'])\/(?:[^\s/"'<>)]+\/)+[^\s"'<>)]*/g, "$1<path>"); // /home/... /Users/...
  return s.slice(0, 300);
}

/** The camera track's settings without identifiers (deviceId, groupId). */
export function cameraSettings(settings: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!settings) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) if (k !== "deviceId" && k !== "groupId" && (typeof v === "number" || typeof v === "string" || typeof v === "boolean")) out[k] = v;
  return out;
}

export interface DeviceEnv {
  userAgent: string | null;
  screen: { width: number; height: number; devicePixelRatio: number } | null;
  deviceMemory: number | null;
  hardwareConcurrency: number | null;
}

export function readEnv(): DeviceEnv {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }) : null;
  const scr = typeof screen !== "undefined" ? screen : null;
  return {
    userAgent: nav?.userAgent ?? null,
    screen: scr ? { width: scr.width, height: scr.height, devicePixelRatio: typeof devicePixelRatio === "number" ? devicePixelRatio : 1 } : null,
    deviceMemory: typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null,
    hardwareConcurrency: typeof nav?.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
  };
}

/** Used JS heap in MB (Chrome's coarse performance.memory), or null where the browser does not expose it. */
export function readHeapMb(perf: unknown = typeof performance !== "undefined" ? performance : null): number | null {
  const m = (perf as { memory?: { usedJSHeapSize?: number } } | null)?.memory;
  return m && typeof m.usedJSHeapSize === "number" && Number.isFinite(m.usedJSHeapSize) ? Math.round((m.usedJSHeapSize / 1048576) * 10) / 10 : null;
}

type Listen = Pick<Window, "addEventListener" | "removeEventListener">;

export class DeviceLog {
  readonly startedAt: string;
  private captureStart: number | null = null;
  captureMs: number | null = null;
  buildMs: number | null = null;
  exportMs: number | null = null;
  exportOk: boolean | null = null;
  heapSamples: number[] | null = null;
  errors: string[] = [];
  webglContextLost = 0;
  camera: DeviceJson["camera"] = { width: null, height: null, settings: null };
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: [string, EventListener, boolean][] = [];
  private target: Listen | null = null;
  /** Called after every change (e.g. to refresh a debug panel). */
  onChange: (() => void) | null = null;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly heap: () => number | null = () => readHeapMb(),
    startedAt: string = new Date().toISOString(),
  ) {
    this.startedAt = startedAt;
  }

  /** Window listeners for uncaught errors, unhandled rejections and WebGL context losses (capture phase: the event is
   *  fired on the viewer's canvas and does not bubble). Returns the detach function. */
  attach(target: Listen): () => void {
    this.detach();
    this.target = target;
    const on = (type: string, fn: EventListener, capture = false) => {
      target.addEventListener(type, fn, capture);
      this.listeners.push([type, fn, capture]);
    };
    on("error", (e) => {
      if (typeof ErrorEvent !== "undefined" && !(e instanceof ErrorEvent)) return; // not a script error
      const ev = e as ErrorEvent;
      this.error(ev.error ?? ev.message ?? "error");
    });
    on("unhandledrejection", (e) => this.error(`unhandled rejection: ${sanitizeMessage((e as PromiseRejectionEvent).reason)}`));
    on("webglcontextlost", () => {
      this.webglContextLost++;
      this.changed();
    }, true);
    return () => this.detach();
  }

  detach(): void {
    if (this.target) for (const [type, fn, capture] of this.listeners) this.target.removeEventListener(type, fn, capture);
    this.listeners = [];
    this.target = null;
    this.stopHeap();
  }

  /** Heap samples every 2 s from now on (none, and heap_samples_mb null, where the browser has no performance.memory). */
  startHeap(interval = HEAP_SAMPLE_MS): void {
    this.stopHeap();
    const first = this.heap();
    if (first === null) return;
    this.heapSamples = [first];
    this.timer = setInterval(() => {
      const v = this.heap();
      if (v !== null && this.heapSamples && this.heapSamples.length < MAX_SAMPLES) {
        this.heapSamples.push(v);
        this.changed();
      }
    }, interval);
  }

  stopHeap(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  error(raw: unknown): void {
    const msg = sanitizeMessage(raw);
    if (this.errors.length < MAX_ERRORS && !this.errors.includes(msg)) this.errors.push(msg);
    this.changed();
  }

  workerFailed(which: string, raw: unknown): void {
    this.error(`worker (${which}): ${sanitizeMessage(raw)}`);
  }

  /** The first Start camera of a capture (later restarts keep the first time). */
  cameraStarted(track: { getSettings?: () => MediaTrackSettings } | null, size: { width: number; height: number } | null): void {
    if (this.captureStart === null) this.captureStart = this.now();
    let settings: Record<string, unknown> | null = null;
    try {
      settings = cameraSettings(track?.getSettings?.() as Record<string, unknown> | undefined);
    } catch {
      settings = null;
    }
    this.camera = { width: size?.width ?? (typeof settings?.width === "number" ? (settings.width as number) : null), height: size?.height ?? (typeof settings?.height === "number" ? (settings.height as number) : null), settings };
    this.changed();
  }

  buildPressed(): void {
    if (this.captureStart !== null) this.captureMs = Math.round(this.now() - this.captureStart);
    this.changed();
  }

  buildFinished(ms: number): void {
    this.buildMs = Math.round(ms);
    this.changed();
  }

  exportFinished(ms: number, ok: boolean): void {
    this.exportMs = Math.round(ms);
    this.exportOk = ok;
    this.changed();
  }

  /** A new capture (Start over): the capture clock restarts; errors and heap samples stay (they describe the session). */
  resetCapture(): void {
    this.captureStart = null;
    this.captureMs = null;
    this.buildMs = null;
    this.exportMs = null;
    this.exportOk = null;
    this.changed();
  }

  peakHeap(): number | null {
    return this.heapSamples && this.heapSamples.length ? Math.max(...this.heapSamples) : null;
  }

  toJson(env: DeviceEnv, finishedAt: string | null, override: Partial<Pick<DeviceJson, "export_ms" | "export_ok">> = {}): DeviceJson {
    return {
      user_agent: env.userAgent,
      screen: env.screen ? { width: env.screen.width, height: env.screen.height, device_pixel_ratio: env.screen.devicePixelRatio } : null,
      device_memory_gb: env.deviceMemory,
      hardware_concurrency: env.hardwareConcurrency,
      camera: { ...this.camera, settings: this.camera.settings ? { ...this.camera.settings } : null },
      capture_ms: this.captureMs,
      build_ms: this.buildMs,
      export_ms: override.export_ms !== undefined ? override.export_ms : this.exportMs,
      heap_samples_mb: this.heapSamples ? [...this.heapSamples] : null,
      peak_heap_mb: this.peakHeap(),
      errors: [...this.errors],
      webgl_context_lost: this.webglContextLost,
      export_ok: override.export_ok !== undefined ? override.export_ok : this.exportOk,
      started_at: this.startedAt,
      finished_at: finishedAt,
    };
  }

  private changed(): void {
    this.onChange?.();
  }
}
