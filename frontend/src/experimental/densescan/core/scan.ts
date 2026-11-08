// The scanning sequence as a pure, frame-rate-independent state machine. The page feeds it events; it never invents
// numbers: `revealed` counts real points (from ctx.points) above the sweep line, and acceptance comes from validation.
//
// waiting_hand --frame_frozen (after hand_found)--> segmenting --mask_ready--> sweeping --(sweep time over)--> validating
// --validated (enough points)--> captured --process_start--> processing --processed--> done
// Any of segmenting/sweeping/validating --hand_lost / mask_failed / too few points--> rejected. reset -> waiting_hand.
import { MIN_ACCEPTED_POINTS, type SurfacePoint } from "./types";

export type ScanPhase = "waiting_hand" | "segmenting" | "sweeping" | "validating" | "captured" | "processing" | "done" | "rejected";

export interface ScanState {
  phase: ScanPhase;
  /** Current y of the scanning line, source px. */
  sweepY: number;
  /** Points (generated) above the sweep line: they are the ones shown so far. */
  revealed: number;
  message: string;
  reasons: string[];
  handSeen: boolean;
  /** Top and bottom of the hand (source px), from the mask. */
  top: number;
  bottom: number;
  elapsedMs: number;
}

export type ScanEvent =
  | { type: "hand_found" }
  | { type: "hand_lost" }
  | { type: "frame_frozen" }
  | { type: "mask_ready"; top: number; bottom: number }
  | { type: "mask_failed"; reason: string }
  | { type: "tick"; dtMs: number }
  | { type: "validated"; accepted: number; minAccepted?: number }
  | { type: "process_start" }
  | { type: "processed" }
  | { type: "reset" };

export interface ScanContext {
  points: SurfacePoint[] | null;
  frameHeight: number;
  sweepMs: number;
}

const MESSAGES: Record<ScanPhase, string> = {
  waiting_hand: "Show your open hand with the coin on the palm",
  segmenting: "Finding the outline of your hand",
  sweeping: "Scanning the surface of your hand",
  validating: "Checking the points",
  captured: "Snapshot captured",
  processing: "Processing the points",
  done: "Scan complete",
  rejected: "Scan not accepted",
};

export function initialScanState(): ScanState {
  return { phase: "waiting_hand", sweepY: 0, revealed: 0, message: MESSAGES.waiting_hand, reasons: [], handSeen: false, top: 0, bottom: 0, elapsedMs: 0 };
}

function countAbove(points: SurfacePoint[] | null, y: number): number {
  if (!points) return 0;
  let n = 0;
  for (const p of points) if (p.y <= y) n++;
  return n;
}

const reject = (s: ScanState, reason: string): ScanState => ({ ...s, phase: "rejected", message: MESSAGES.rejected, reasons: [...s.reasons, reason] });

export function scanReducer(state: ScanState, event: ScanEvent, ctx: ScanContext): ScanState {
  if (event.type === "reset") return initialScanState();
  const active = state.phase === "segmenting" || state.phase === "sweeping" || state.phase === "validating";
  switch (event.type) {
    case "hand_found":
      return state.phase === "waiting_hand" ? { ...state, handSeen: true, message: "Hand found. Hold still" } : { ...state, handSeen: true };
    case "hand_lost":
      if (active) return reject(state, "Your hand left the picture during the scan.");
      return { ...state, handSeen: false, message: state.phase === "waiting_hand" ? MESSAGES.waiting_hand : state.message };
    case "frame_frozen":
      if (state.phase !== "waiting_hand" || !state.handSeen) return state;
      return { ...state, phase: "segmenting", message: MESSAGES.segmenting, reasons: [] };
    case "mask_failed":
      return state.phase === "segmenting" ? reject(state, event.reason) : state;
    case "mask_ready": {
      if (state.phase !== "segmenting") return state;
      const top = Math.max(0, Math.min(event.top, event.bottom));
      const bottom = Math.min(ctx.frameHeight, Math.max(event.top, event.bottom));
      return { ...state, phase: "sweeping", message: MESSAGES.sweeping, top, bottom, sweepY: top, elapsedMs: 0, revealed: countAbove(ctx.points, top) };
    }
    case "tick": {
      if (state.phase !== "sweeping") return state;
      const elapsed = state.elapsedMs + Math.max(0, event.dtMs);
      const f = ctx.sweepMs > 0 ? Math.min(1, elapsed / ctx.sweepMs) : 1;
      const sweepY = state.top + (state.bottom - state.top) * f;
      const next = { ...state, elapsedMs: elapsed, sweepY, revealed: countAbove(ctx.points, sweepY) };
      return f >= 1 ? { ...next, phase: "validating", message: MESSAGES.validating } : next;
    }
    case "validated": {
      if (state.phase !== "validating") return state;
      const min = event.minAccepted ?? MIN_ACCEPTED_POINTS;
      if (event.accepted < min) return reject(state, `Only ${event.accepted} points passed the checks (at least ${min} are needed).`);
      return { ...state, phase: "captured", message: MESSAGES.captured };
    }
    case "process_start":
      return state.phase === "captured" ? { ...state, phase: "processing", message: MESSAGES.processing } : state;
    case "processed":
      return state.phase === "processing" ? { ...state, phase: "done", message: MESSAGES.done } : state;
  }
  return state;
}
