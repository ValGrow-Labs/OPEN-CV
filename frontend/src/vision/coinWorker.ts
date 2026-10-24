/// <reference lib="webworker" />
// Runs the coin search off the page's main thread, so the camera picture, the hand outline and
// the live guidance keep up with the camera while OpenCV works.
import { runCoinJob, type CoinJob } from "./coinJob";
import { initOpenCV, type CV } from "./opencv";

export type CoinWorkerRequest = { type: "load"; url: string } | { type: "job"; id: number; job: CoinJob };
export type CoinWorkerReply =
  | { type: "ready" }
  | { type: "result"; id: number; result: ReturnType<typeof runCoinJob> }
  | { type: "error"; id: number | null; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let cv: CV | null = null;

// OpenCV.js is a classic script (it defines a global `cv`); module workers cannot importScripts,
// so its source is fetched and evaluated in the worker's global scope.
async function load(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  (0, eval)(await res.text());
  const module = (scope as unknown as { cv?: unknown }).cv;
  if (!module) throw new Error("OpenCV.js loaded but did not define `cv`");
  cv = await initOpenCV(module);
}

scope.onmessage = async (e: MessageEvent<CoinWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "load") {
    try {
      await load(msg.url);
      scope.postMessage({ type: "ready" } satisfies CoinWorkerReply);
    } catch (err) {
      scope.postMessage({ type: "error", id: null, message: String(err) } satisfies CoinWorkerReply);
    }
    return;
  }
  try {
    if (!cv) throw new Error("OpenCV is not loaded");
    const result = runCoinJob(cv, msg.job);
    scope.postMessage({ type: "result", id: msg.id, result } satisfies CoinWorkerReply);
  } catch (err) {
    scope.postMessage({ type: "error", id: msg.id, message: String(err) } satisfies CoinWorkerReply);
  }
};
