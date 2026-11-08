// Live analysis of one camera frame for the EXPERIMENTAL board-capture page, off the main thread: marker detection on a
// half-size picture (corners refined at full size), the markers that agree on one plane, the board pose with an ASSUMED
// focal length (guidance only: the real calibration happens later, from all the captured pictures), and the sharpness.
// The frame's pixel buffer is sent back with the answer, so the page can keep exactly the analysed frame as a capture.
import type { CameraPose } from "../../common";
import { assumedIntrinsics } from "../../board/calibrate";
import { detectMarkers } from "../../board/detect";
import { estimateBoardPose } from "../../board/pose";
import { consistentMarkers } from "../chain";
import { laplacianSharpness } from "./frameMetrics";

export interface LiveRequest {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export interface LiveMarker {
  id: number;
  corners: { x: number; y: number }[];
}

export interface LiveReply {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  markers: LiveMarker[];
  /** Markers found but left out because they disagree with the others (misread ids). */
  inconsistent: number;
  rejectedCounts: Record<string, number>;
  pose: { pose: CameraPose; elevationDeg: number; azimuthDeg: number; distanceMm: number; rmsPx: number } | null;
  sharpness: number | null;
  timingsMs: { detect: number; pose: number; sharpness: number; total: number };
  error?: string;
}

const K_CACHE = new Map<string, ReturnType<typeof assumedIntrinsics>["intrinsics"]>();

export function analyseFrame(req: LiveRequest): LiveReply {
  const t0 = performance.now();
  const img = { width: req.width, height: req.height, data: new Uint8ClampedArray(req.buffer) };
  const det = detectMarkers(img, { decimate: 2 });
  const { kept, dropped } = consistentMarkers(det.markers);
  const t1 = performance.now();
  const key = `${req.width}x${req.height}`;
  let K = K_CACHE.get(key);
  if (!K) K_CACHE.set(key, (K = assumedIntrinsics(req.width, req.height).intrinsics));
  const p = kept.length >= 2 ? estimateBoardPose(K, kept, { minMarkers: 2 }) : null;
  const t2 = performance.now();
  const sharp = laplacianSharpness(img.data, req.width, req.height).value;
  const t3 = performance.now();
  return {
    id: req.id,
    width: req.width,
    height: req.height,
    buffer: req.buffer,
    markers: kept.map((m) => ({ id: m.id, corners: m.corners.map((c) => ({ x: c.x, y: c.y })) })),
    inconsistent: dropped.length,
    rejectedCounts: { ...(det.rejectedCounts as Record<string, number>) },
    pose: p && p.ok ? { pose: p.pose, elevationDeg: p.elevationDeg, azimuthDeg: p.azimuthDeg, distanceMm: p.distanceMm, rmsPx: p.reprojRmsPx } : null,
    sharpness: sharp,
    timingsMs: { detect: t1 - t0, pose: t2 - t1, sharpness: t3 - t2, total: t3 - t0 },
  };
}

const scope = globalThis as unknown as { WorkerGlobalScope?: unknown; postMessage: (m: LiveReply, t?: Transferable[]) => void; onmessage: unknown };
if (typeof scope.WorkerGlobalScope !== "undefined") {
  scope.onmessage = (e: MessageEvent<LiveRequest>) => {
    const req = e.data;
    let reply: LiveReply;
    try {
      reply = analyseFrame(req);
    } catch (err) {
      reply = {
        id: req.id,
        width: req.width,
        height: req.height,
        buffer: req.buffer,
        markers: [],
        inconsistent: 0,
        rejectedCounts: {},
        pose: null,
        sharpness: null,
        timingsMs: { detect: 0, pose: 0, sharpness: 0, total: 0 },
        error: String(err instanceof Error ? err.message : err),
      };
    }
    scope.postMessage(reply, [reply.buffer]);
  };
}
