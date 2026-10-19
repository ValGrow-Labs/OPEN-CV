// MediaPipe Hand Landmarker (pretrained model, VIDEO mode), served from this origin.
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { Point } from "../api/types";

export const MEDIAPIPE_WASM_PATH = "/mediapipe/wasm";
export const HAND_MODEL_PATH = "/models/hand_landmarker.task";

export interface HandFrame {
  landmarks: Point[]; // image pixels; z is MediaPipe's relative depth scaled by image width
  world: Point[] | null; // metres, model estimate
  handedness: "Left" | "Right" | null; // as reported by the model (it assumes mirrored input)
  handednessScore: number | null;
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

  detect(video: HTMLVideoElement, timestampMs: number): HandFrame | null {
    const w = video.videoWidth;
    const h = video.videoHeight;
    const r = this.landmarker.detectForVideo(video, timestampMs);
    if (!r.landmarks.length) return null;
    const cat = r.handedness[0]?.[0];
    const label = cat?.categoryName;
    return {
      landmarks: r.landmarks[0].map((p) => ({ x: p.x * w, y: p.y * h, z: p.z * w })),
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
