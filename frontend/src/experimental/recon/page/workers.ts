// Thin clients for the two Web Workers of the EXPERIMENTAL board-capture page. Pixel buffers are transferred (not copied)
// both ways.
import type { LiveReply, LiveRequest } from "./liveWorker";
import type { FlatnessReply, FlatnessRequest } from "./flatnessWorker";
import type { ReconReply, ReconRequest } from "./reconWorker";

/** One frame in flight at a time: `analyse` resolves with the analysis (and the frame's buffer back). */
export class LiveAnalyser {
  private worker: Worker;
  private nextId = 1;
  private pending: { id: number; resolve: (r: LiveReply) => void; reject: (e: Error) => void } | null = null;

  constructor() {
    this.worker = new Worker(new URL("./liveWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<LiveReply>) => {
      const p = this.pending;
      if (!p || p.id !== e.data.id) return;
      this.pending = null;
      p.resolve(e.data);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      const p = this.pending;
      this.pending = null;
      p?.reject(new Error(e.message || "the live analysis worker failed"));
    };
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  analyse(width: number, height: number, buffer: ArrayBuffer): Promise<LiveReply> {
    if (this.pending) return Promise.reject(new Error("busy"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      const msg: LiveRequest = { id, width, height, buffer };
      this.worker.postMessage(msg, [buffer]);
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending?.reject(new Error("disposed"));
    this.pending = null;
  }
}

/** Runs one reconstruction in a fresh worker (terminated afterwards, which frees its memory at once). */
export function runReconWorker(req: ReconRequest, onProgress: (p: Extract<ReconReply, { type: "progress" }>["progress"]) => void): { promise: Promise<Extract<ReconReply, { type: "done" | "error" }>>; cancel: () => void } {
  const worker = new Worker(new URL("./reconWorker.ts", import.meta.url), { type: "module" });
  let settle: ((r: Extract<ReconReply, { type: "done" | "error" }>) => void) | null = null;
  const promise = new Promise<Extract<ReconReply, { type: "done" | "error" }>>((resolve) => {
    settle = resolve;
    worker.onmessage = (e: MessageEvent<ReconReply>) => {
      if (e.data.type === "progress") onProgress(e.data.progress);
      else {
        resolve(e.data);
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      resolve({ type: "error", message: e.message || "the reconstruction worker failed (it may have run out of memory)", buffers: [] });
      worker.terminate();
    };
  });
  worker.postMessage(req, req.views.map((v) => v.buffer));
  return {
    promise,
    cancel: () => {
      worker.terminate();
      settle?.({ type: "error", message: "cancelled", buffers: [] });
    },
  };
}

/** One live flatness check (calibration and poses from the captured views' markers) in a fresh worker. */
export function runFlatnessWorker(req: FlatnessRequest): { promise: Promise<FlatnessReply>; cancel: () => void } {
  const worker = new Worker(new URL("./flatnessWorker.ts", import.meta.url), { type: "module" });
  let settle: ((r: FlatnessReply) => void) | null = null;
  const promise = new Promise<FlatnessReply>((resolve) => {
    settle = resolve;
    worker.onmessage = (e: MessageEvent<FlatnessReply>) => {
      resolve(e.data);
      worker.terminate();
    };
    worker.onerror = (e) => {
      e.preventDefault();
      resolve({ type: "error", message: e.message || "the flatness worker failed" });
      worker.terminate();
    };
  });
  worker.postMessage(req);
  return {
    promise,
    cancel: () => {
      worker.terminate();
      settle?.({ type: "error", message: "cancelled" });
    },
  };
}
