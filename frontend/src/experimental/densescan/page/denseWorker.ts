// A Web Worker for the heavy, pure parts of the dense scan, so the page keeps drawing while they run: the point set
// (core generation, validation, duplicates/isolated, regions, depth labels, via stagedPointSet) and the processing (core
// point cloud, lattice mesh, measurements). The same core functions as on the page; only the thread differs.
import type { ImageScale, Pt } from "../../common";
import { buildPointCloud, measureFromPoints, meshFromLattice, type BuildPointSetInput, type PointSet } from "../core";
import { stagedPointSet } from "./staged";

export type DenseRequest =
  | { type: "points"; id: number; input: BuildPointSetInput }
  | { type: "process"; id: number; set: PointSet; landmarks: Pt[]; scale: ImageScale | null };

export type ProcessResult = {
  cloud: ReturnType<typeof buildPointCloud>;
  mesh: ReturnType<typeof meshFromLattice>;
  measurements: ReturnType<typeof measureFromPoints>;
  timings: { cloudMs: number; meshMs: number; measureMs: number };
};

export type DenseReply =
  | { type: "points"; id: number; result: ReturnType<typeof stagedPointSet> }
  | { type: "process"; id: number; result: ProcessResult }
  | { type: "error"; id: number; message: string };

export function runProcess(set: PointSet, landmarks: readonly Pt[], scale: ImageScale | null): ProcessResult {
  const t0 = performance.now();
  const cloud = buildPointCloud(set);
  const t1 = performance.now();
  const mesh = meshFromLattice(set);
  const t2 = performance.now();
  const measurements = measureFromPoints(set, landmarks, scale);
  const t3 = performance.now();
  return { cloud, mesh, measurements, timings: { cloudMs: t1 - t0, meshMs: t2 - t1, measureMs: t3 - t2 } };
}

// Only when loaded as a worker (the page imports runProcess from this file for its fallback).
const scope = globalThis as unknown as { WorkerGlobalScope?: unknown; postMessage: (m: DenseReply) => void; onmessage: unknown };
if (typeof scope.WorkerGlobalScope !== "undefined") {
  scope.onmessage = (e: MessageEvent<DenseRequest>) => {
    const msg = e.data;
    try {
      if (msg.type === "points") scope.postMessage({ type: "points", id: msg.id, result: stagedPointSet(msg.input) });
      else scope.postMessage({ type: "process", id: msg.id, result: runProcess(msg.set, msg.landmarks, msg.scale) });
    } catch (err) {
      scope.postMessage({ type: "error", id: msg.id, message: String(err instanceof Error ? err.message : err) });
    }
  };
}
