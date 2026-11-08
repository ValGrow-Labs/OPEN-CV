// Shared types of the EXPERIMENTAL board-capture page.
import type { Pt } from "../../common";
import type { ChainResult } from "../chain";
import type { BinId } from "./coverage";

/** One captured view: the full frame at the video's size and what was found on THAT frame. */
export interface Capture {
  id: string;
  bin: BinId;
  width: number;
  height: number;
  /** RGBA pixels of the frame (not mirrored). */
  pixels: Uint8ClampedArray;
  /** MediaPipe's 21 landmarks in pixels of this frame (normalised x width, y height), or null when no hand was found. */
  landmarks: Pt[] | null;
  /** MediaPipe's handedness label as reported (it assumes a mirrored picture), or null. */
  handedness: "Left" | "Right" | null;
  /** The markers the live analysis found on this frame (detector pixel convention), for the live flatness check. */
  markerCorners: { id: number; corners: Pt[] }[];
  /** Live values at capture time (the pose used an ASSUMED focal length). */
  markers: number;
  elevationDeg: number;
  azimuthDeg: number;
  sharpness: number | null;
  trigger: "auto" | "button";
  capturedAt: string;
  /** A small copy for the thumbnail. */
  thumb: ImageData | null;
}

export interface CoinCheckSummary {
  ok: boolean;
  viewId: string | null;
  referenceDiameterMm: number;
  thicknessMm: number | null;
  diameterMm?: number;
  circleDiameterMm?: number;
  /** physical mm per board mm: reference / measured (1 = printed at 100 %). */
  printScale?: number;
  residualMm?: number;
  centerOffsetMm?: number;
  elevationDeg?: number | null;
  reason?: string;
  detail?: string;
}

export interface ReconOutcome {
  chain: ChainResult;
  coin: CoinCheckSummary | null;
  timingsMs: { chain: number; coin: number; total: number };
}
