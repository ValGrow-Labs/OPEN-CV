// The live board-flatness check of the EXPERIMENTAL board-capture page, off the main thread: from the markers the live
// analysis found on each captured frame (no pixels), the camera is self-calibrated and each view placed exactly as the
// chain does it (chain.ts camerasFromMarkers), then boardFlatness.ts judges the per-marker residuals. Run after each
// capture once three views exist; a warning while capturing, not a measurement.
import { camerasFromMarkers, type MarkerCornersOnly } from "../chain";
import { flatnessOfCameras, type BoardFlatness } from "../boardFlatness";

export interface FlatnessRequest {
  width: number;
  height: number;
  views: { id: string; markers: MarkerCornersOnly[] }[];
}

export type FlatnessReply = { type: "done"; flatness: BoardFlatness; ms: number } | { type: "error"; message: string };

/** Fewest captured views before the live check runs (the self-calibration needs different tilts). */
export const LIVE_FLATNESS_MIN_VIEWS = 3;

export function liveFlatness(req: FlatnessRequest): BoardFlatness {
  const est = camerasFromMarkers(req.views, req.width, req.height);
  return flatnessOfCameras(est.cameras);
}

const scope = globalThis as unknown as { WorkerGlobalScope?: unknown; postMessage: (m: FlatnessReply) => void; onmessage: unknown };
if (typeof scope.WorkerGlobalScope !== "undefined") {
  scope.onmessage = (e: MessageEvent<FlatnessRequest>) => {
    const t0 = performance.now();
    try {
      scope.postMessage({ type: "done", flatness: liveFlatness(e.data), ms: performance.now() - t0 });
    } catch (err) {
      scope.postMessage({ type: "error", message: String(err instanceof Error ? err.message : err) });
    }
  };
}
