// Where the coin search runs during a scan: in a Web Worker when the browser allows it (the page
// stays responsive and keeps up with the camera), otherwise on the page itself.
import { runCoinJob, type CoinJob, type CoinJobResult } from "./coinJob";
import type { CoinWorkerReply, CoinWorkerRequest } from "./coinWorker";
import { loadOpenCV, OPENCV_URL, type CV } from "./opencv";

export interface CoinEngine {
  readonly kind: "worker" | "page";
  /** Runs one search. The job's pixel buffer is handed over and must not be used afterwards. */
  run(job: CoinJob): Promise<CoinJobResult>;
}

class PageEngine implements CoinEngine {
  readonly kind = "page";
  constructor(private cv: CV) {}
  run(job: CoinJob): Promise<CoinJobResult> {
    try {
      return Promise.resolve(runCoinJob(this.cv, job));
    } catch (err) {
      return Promise.reject(err);
    }
  }
}

type Pending = { resolve: (r: CoinJobResult) => void; reject: (e: Error) => void };

class WorkerEngine implements CoinEngine {
  readonly kind = "worker";
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private worker: Worker) {
    worker.onmessage = (e: MessageEvent<CoinWorkerReply>) => {
      const msg = e.data;
      if (msg.type === "ready" || msg.id === null) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === "result") p.resolve(msg.result);
      else p.reject(new Error(msg.message));
    };
    worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "coin worker failed"));
      this.pending.clear();
    };
  }

  run(job: CoinJob): Promise<CoinJobResult> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "job", id, job } satisfies CoinWorkerRequest, [job.image.data.buffer]);
    });
  }
}

function startWorker(): Promise<CoinEngine> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./coinWorker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      reject(err);
      return;
    }
    worker.onmessage = (e: MessageEvent<CoinWorkerReply>) => {
      if (e.data.type === "ready") resolve(new WorkerEngine(worker));
      else if (e.data.type === "error") {
        worker.terminate();
        reject(new Error(e.data.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "coin worker failed to start"));
    };
    worker.postMessage({ type: "load", url: new URL(OPENCV_URL, location.href).href } satisfies CoinWorkerRequest);
  });
}

let shared: Promise<CoinEngine> | null = null;

/** The engine used by scans, created once and reused (loading OpenCV takes a while). */
export function getCoinEngine(): Promise<CoinEngine> {
  if (!shared) {
    const worker = typeof Worker === "function" ? startWorker() : Promise.reject(new Error("Web Workers are not available"));
    shared = worker.catch((err) => {
      console.warn("Coin search runs on the page:", err);
      return loadOpenCV().then((cv) => new PageEngine(cv));
    });
    shared.catch(() => {
      shared = null;
    });
  }
  return shared;
}
