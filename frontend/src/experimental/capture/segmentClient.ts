// Calls the experimental segmentation from the page: in a Worker when the browser allows it (the page keeps responding),
// otherwise on the page itself after yielding to the event loop (the page then pauses while GrabCut runs, and says so).
import { loadOpenCV, OPENCV_URL, type CV } from "../../vision/opencv";
import { segmentHand, type SegmentationResult } from "../segmentation/segmentHand";
import type { SegReply, SegRequest } from "./segmentWorker";

export interface SegmentOutcome {
  result: SegmentationResult;
  /** Where it ran: "worker" (page stays responsive) or "page" (it paused). */
  where: "worker" | "page";
  /** Wall-clock milliseconds including the transfer to and from the worker. */
  wallMs: number;
}

type Pending = { resolve: (r: SegmentationResult) => void; reject: (e: Error) => void };

export class SegmentClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private pageCv: Promise<CV> | null = null;
  private workerFailed = false;

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      if (typeof Worker !== "function") return reject(new Error("Web Workers are not available"));
      let worker: Worker;
      try {
        worker = new Worker(new URL("./segmentWorker.ts", import.meta.url), { type: "module" });
      } catch (err) {
        return reject(err);
      }
      worker.onmessage = (e: MessageEvent<SegReply>) => {
        const msg = e.data;
        if (msg.type === "ready") {
          this.worker = worker;
          resolve();
          return;
        }
        if (msg.type === "error" && msg.id === null) {
          worker.terminate();
          reject(new Error(msg.message));
          return;
        }
        if (msg.type === "result" || msg.type === "error") {
          const p = this.pending.get(msg.id as number);
          if (!p) return;
          this.pending.delete(msg.id as number);
          if (msg.type === "result") p.resolve(msg.result);
          else p.reject(new Error(msg.message));
        }
      };
      worker.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || "segmentation worker failed"));
        this.pending.clear();
        worker.terminate();
        reject(new Error(e.message || "segmentation worker failed to start"));
      };
      worker.postMessage({ type: "load", url: new URL(OPENCV_URL, location.href).href } satisfies SegRequest);
    });
    this.ready.catch(() => {
      this.workerFailed = true;
    });
    return this.ready;
  }

  /** Segment a still. The pixels are copied before they are handed over, so the caller's image stays usable. */
  async segment(image: { width: number; height: number; data: Uint8ClampedArray }, landmarks: readonly { x: number; y: number }[], workingSize?: number): Promise<SegmentOutcome> {
    const t0 = performance.now();
    if (!this.workerFailed) {
      try {
        await this.start();
        const id = this.nextId++;
        const copy = image.data.slice();
        const result = await new Promise<SegmentationResult>((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.worker!.postMessage({ type: "segment", id, width: image.width, height: image.height, data: copy, landmarks: landmarks.map((p) => ({ x: p.x, y: p.y })), workingSize } satisfies SegRequest, [copy.buffer]);
        });
        return { result, where: "worker", wallMs: performance.now() - t0 };
      } catch (err) {
        console.warn("Segmentation runs on the page:", err);
        this.workerFailed = true;
      }
    }
    const cv = await (this.pageCv ??= loadOpenCV());
    await new Promise((r) => setTimeout(r, 30)); // let the "analysing" message paint before the page pauses
    const result = await segmentHand(image, landmarks, { backend: "grabcut", cv, workingSize });
    return { result, where: "page", wallMs: performance.now() - t0 };
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("disposed"));
    this.pending.clear();
  }
}
