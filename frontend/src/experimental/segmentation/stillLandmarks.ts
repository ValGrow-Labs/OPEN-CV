// Hand landmarks for a STILL image (for the evaluation and the experiment page's image mode). The live scan uses the
// app's own HandTracker on video; this does the same with the same model for one picture, drawn onto a square canvas
// first because MediaPipe's landmark projection assumes a square image (see src/vision/handTracker.ts).
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { Pt } from "../common";
import { HAND_MODEL_PATH, MEDIAPIPE_WASM_PATH } from "../../vision/handTracker";
import type { ImageLike } from "./imageops";

export interface StillHands {
  /** Landmarks in the image's pixels, or null when no hand was found. */
  detect(image: ImageLike): Pt[] | null;
  close(): void;
}

export async function createStillHandDetector(): Promise<StillHands> {
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_PATH);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: HAND_MODEL_PATH, delegate: "CPU" },
    runningMode: "IMAGE",
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
  });
  const canvas = document.createElement("canvas");
  return {
    detect(image) {
      const side = Math.max(image.width, image.height);
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, side, side);
      const ox = (side - image.width) / 2;
      const oy = (side - image.height) / 2;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), ox, oy);
      const r = landmarker.detect(canvas);
      if (!r.landmarks.length) return null;
      return r.landmarks[0].map((p) => ({ x: p.x * side - ox, y: p.y * side - oy }));
    },
    close: () => landmarker.close(),
  };
}
