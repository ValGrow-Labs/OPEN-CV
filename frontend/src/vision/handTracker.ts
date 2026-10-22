// MediaPipe Hand Landmarker (pretrained model, VIDEO mode), served from this origin.
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { Point } from "../api/types";

export const MEDIAPIPE_WASM_PATH = "/mediapipe/wasm";
export const HAND_MODEL_PATH = "/models/hand_landmarker.task";

// MediaPipe's VIDEO-mode landmark projection assumes a square image (it logs "Using NORM_RECT
// without IMAGE_DIMENSIONS is only supported for the square ROI"), and on some phones portrait
// frames reach it in a different orientation or scale from what is displayed. Each frame is
// therefore drawn as displayed onto a square canvas (at most this many pixels a side) and the
// landmarks are mapped back.
const MAX_SQUARE_PX = 1280;

/** A video frame as drawn on a canvas: frame pixel (x, y) is at (ox + x * k, oy + y * k). */
export interface DrawnFrame {
  canvas: HTMLCanvasElement;
  ox: number;
  oy: number;
  k: number;
}

export interface HandFrame {
  landmarks: Point[]; // image pixels; z is MediaPipe's relative depth scaled by image width
  world: Point[] | null; // metres, model estimate
  handedness: "Left" | "Right" | null; // as reported by the model (it assumes mirrored input)
  handednessScore: number | null;
}

let shared: Promise<HandTracker> | null = null;

/** One tracker per page, created on first use and reused by every scan: creating it (WASM,
 *  model, GPU set-up) is the slow part, so it is never rebuilt between scans. */
export function getHandTracker(): Promise<HandTracker> {
  if (!shared) {
    shared = HandTracker.create().then((t) => {
      t.warmUp();
      return t;
    });
    shared.catch(() => {
      shared = null;
    });
  }
  return shared;
}

export class HandTracker {
  private constructor(
    private landmarker: HandLandmarker,
    readonly delegate: "GPU" | "CPU",
  ) {}

  static async create(): Promise<HandTracker> {
    const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_PATH);
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath: HAND_MODEL_PATH, delegate },
      runningMode: "VIDEO" as const,
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
    try {
      return new HandTracker(await HandLandmarker.createFromOptions(fileset, options("GPU")), "GPU");
    } catch {
      return new HandTracker(await HandLandmarker.createFromOptions(fileset, options("CPU")), "CPU");
    }
  }

  /** One detection on a blank image, so the GPU programs are compiled before the camera starts
   *  (otherwise the first live frame stalls for a second or more). Failures are harmless. */
  warmUp(): void {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      c.getContext("2d")?.fillRect(0, 0, 256, 256);
      this.landmarker.detectForVideo(c, performance.now());
    } catch {
      /* the first live frame warms it up instead */
    }
  }

  private square: HTMLCanvasElement | null = null;
  private drawn: DrawnFrame | null = null;

  /** The picture most recently given to detect(), exactly as the hand was found in it. The coin
   *  is cut from this too, so the hand and the coin always come from one frame and one mapping
   *  (cutting it from the live video element could be offset from the landmarks on a phone). */
  lastFrame(): DrawnFrame | null {
    return this.drawn;
  }

  detect(video: HTMLVideoElement, timestampMs: number): HandFrame | null {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const side = Math.min(Math.max(w, h), MAX_SQUARE_PX);
    const k = side / Math.max(w, h);
    const ox = (side - w * k) / 2;
    const oy = (side - h * k) / 2;
    const c = this.square ?? (this.square = document.createElement("canvas"));
    if (c.width !== side || c.height !== side) {
      c.width = side;
      c.height = side;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, side, side);
    ctx.drawImage(video, ox, oy, w * k, h * k);
    this.drawn = { canvas: c, ox, oy, k };
    const r = this.landmarker.detectForVideo(c, timestampMs);
    if (!r.landmarks.length) return null;
    const cat = r.handedness[0]?.[0];
    const label = cat?.categoryName;
    return {
      // Square-canvas pixels back to frame pixels.
      landmarks: r.landmarks[0].map((p) => ({ x: (p.x * side - ox) / k, y: (p.y * side - oy) / k, z: (p.z * side) / k })),
      world: r.worldLandmarks[0]?.map((p) => ({ x: p.x, y: p.y, z: p.z })) ?? null,
      handedness: label === "Left" || label === "Right" ? label : null,
      handednessScore: cat?.score ?? null,
    };
  }

  close(): void {
    this.landmarker.close();
  }
}

/** The model labels handedness as if the image were mirrored; our frames are not. */
export function actualHandedness(modelLabel: "Left" | "Right" | null): "left" | "right" | null {
  if (modelLabel === "Left") return "right";
  if (modelLabel === "Right") return "left";
  return null;
}
