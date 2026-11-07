/// <reference lib="webworker" />
// Runs the experimental GrabCut hand segmentation off the page's main thread (it takes seconds on a laptop), so the page stays
// responsive while a captured view is analysed. OpenCV.js is a classic script, so (like the production coin worker, which this
// follows) its source is fetched and evaluated in the worker's global scope.
import { initOpenCV, type CV } from "../../vision/opencv";
import { segmentHand, type SegmentationResult } from "../segmentation/segmentHand";

export type SegRequest =
  | { type: "load"; url: string }
  | { type: "segment"; id: number; width: number; height: number; data: Uint8ClampedArray; landmarks: { x: number; y: number }[]; workingSize?: number };

export type SegReply = { type: "ready" } | { type: "result"; id: number; result: SegmentationResult } | { type: "error"; id: number | null; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let cv: CV | null = null;

async function load(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  (0, eval)(await res.text());
  const module = (scope as unknown as { cv?: unknown }).cv;
  if (!module) throw new Error("OpenCV.js loaded but did not define `cv`");
  cv = await initOpenCV(module);
}

scope.onmessage = async (e: MessageEvent<SegRequest>) => {
  const msg = e.data;
  if (msg.type === "load") {
    try {
      await load(msg.url);
      scope.postMessage({ type: "ready" } satisfies SegReply);
    } catch (err) {
      scope.postMessage({ type: "error", id: null, message: String(err) } satisfies SegReply);
    }
    return;
  }
  try {
    if (!cv) throw new Error("OpenCV is not loaded");
    const landmarks = msg.landmarks.map((p) => ({ x: p.x, y: p.y }));
    const result = await segmentHand({ width: msg.width, height: msg.height, data: msg.data }, landmarks, { backend: "grabcut", cv, workingSize: msg.workingSize });
    const transfer: Transferable[] = result.mask ? [result.mask.data.buffer] : [];
    scope.postMessage({ type: "result", id: msg.id, result } satisfies SegReply, transfer);
  } catch (err) {
    scope.postMessage({ type: "error", id: msg.id, message: String(err instanceof Error ? err.message : err) } satisfies SegReply);
  }
};
