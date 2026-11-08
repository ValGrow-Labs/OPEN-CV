// Runs the dense scan's heavy steps in denseWorker.ts when the browser allows it (the page keeps drawing), otherwise on
// the page after yielding to the event loop (the page then pauses briefly, and the debug panel says "page").
import type { ImageScale, Pt } from "../../common";
import type { BuildPointSetInput, PointSet } from "../core";
import { runProcess, type DenseReply, type DenseRequest, type ProcessResult } from "./denseWorker";
import { stagedPointSet } from "./staged";

type Where = "worker" | "page";
type Pending = { resolve: (r: unknown) => void; reject: (e: Error) => void };

const yieldToPaint = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export class DenseClient {
  private worker: Worker | null = null;
  private failed = false;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  private ensure(): Worker | null {
    if (this.failed) return null;
    if (this.worker) return this.worker;
    try {
      const w = new Worker(new URL("./denseWorker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<DenseReply>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.type === "error") p.reject(new Error(e.data.message));
        else p.resolve(e.data.result);
      };
      w.onerror = (e) => {
        e.preventDefault();
        this.failed = true;
        for (const p of this.pending.values()) p.reject(new Error(e.message || "dense worker failed"));
        this.pending.clear();
        w.terminate();
        this.worker = null;
      };
      this.worker = w;
      return w;
    } catch {
      this.failed = true;
      return null;
    }
  }

  private call<T>(msg: DenseRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never, transfer: Transferable[] = []): Promise<T> | null {
    const w = this.ensure();
    if (!w) return null;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      w.postMessage({ ...msg, id } as DenseRequest, transfer);
    });
  }

  async points(input: BuildPointSetInput): Promise<{ result: ReturnType<typeof stagedPointSet>; where: Where; wallMs: number }> {
    const t0 = performance.now();
    // The image is copied for the worker so the page keeps its frozen frame (for the optional photo in the export).
    const image = input.image ? { width: input.image.width, height: input.image.height, data: input.image.data.slice() } : null;
    const p = this.call<ReturnType<typeof stagedPointSet>>({ type: "points", input: { ...input, image } }, image ? [image.data.buffer] : []);
    if (p) {
      try {
        return { result: await p, where: "worker", wallMs: performance.now() - t0 };
      } catch (err) {
        console.warn("Dense points run on the page:", err);
        this.failed = true;
      }
    }
    await yieldToPaint();
    return { result: stagedPointSet(input), where: "page", wallMs: performance.now() - t0 };
  }

  async process(set: PointSet, landmarks: readonly Pt[], scale: ImageScale | null): Promise<{ result: ProcessResult; where: Where; wallMs: number }> {
    const t0 = performance.now();
    const p = this.call<ProcessResult>({ type: "process", set, landmarks: landmarks.map((l) => ({ x: l.x, y: l.y })), scale });
    if (p) {
      try {
        return { result: await p, where: "worker", wallMs: performance.now() - t0 };
      } catch (err) {
        console.warn("Dense processing runs on the page:", err);
        this.failed = true;
      }
    }
    await yieldToPaint();
    return { result: runProcess(set, landmarks, scale), where: "page", wallMs: performance.now() - t0 };
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("disposed"));
    this.pending.clear();
  }
}
