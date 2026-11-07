// Backend (b): MediaPipe Tasks InteractiveSegmenter ("magic touch", a pretrained, class-agnostic promptable
// segmenter), prompted with scribbles along the hand's bones. Model file: public/models/experimental/magic_touch.tflite
// (6.2 MB, downloaded from storage.googleapis.com/mediapipe-models; see README for what is known about its licence).
import { FilesetResolver, InteractiveSegmenter } from "@mediapipe/tasks-vision";
import type { Pt } from "../../common";
import { BONES, lerp } from "../geometry";
import type { ImageLike } from "../imageops";
import { MEDIAPIPE_WASM_PATH } from "../../../vision/handTracker";

export const INTERACTIVE_MODEL_PATH = "/models/experimental/magic_touch.tflite";

export async function createInteractiveSegmenter(
  modelPath: string = INTERACTIVE_MODEL_PATH,
  delegate: "CPU" | "GPU" = "CPU",
): Promise<InteractiveSegmenter> {
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_PATH);
  return InteractiveSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelPath, delegate },
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
}

/** Scribble points: every landmark plus three points along every bone, in 0-1 image coordinates. */
export function scribbleFromLandmarks(lm: readonly Pt[], width: number, height: number): { x: number; y: number }[] {
  const pts: Pt[] = [...lm];
  for (const [a, b] of BONES) for (const t of [0.25, 0.5, 0.75]) pts.push(lerp(lm[a], lm[b], t));
  return pts.map((p) => ({ x: Math.min(1, Math.max(0, p.x / width)), y: Math.min(1, Math.max(0, p.y / height)) }));
}

/** Threshold of the segmenter's foreground confidence. */
export const INTERACTIVE_THRESHOLD = 0.5;

export function runInteractive(seg: InteractiveSegmenter, img: ImageLike, lm: readonly Pt[]): Uint8Array {
  const { width: w, height: h } = img;
  const out = new Uint8Array(w * h);
  const roi = { scribble: scribbleFromLandmarks(lm, w, h) };
  // MediaPipe needs a real image source: wrap the pixels in an ImageData (a plain {width,height,data} is rejected).
  const source = typeof ImageData !== "undefined" && img instanceof ImageData ? img : new ImageData(new Uint8ClampedArray(img.data), w, h);
  seg.segment(source, roi, (result) => {
    const mask = result.confidenceMasks?.[0];
    if (!mask) return;
    const conf = mask.getAsFloat32Array();
    const mw = mask.width;
    const mh = mask.height;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(mh - 1, Math.floor(((y + 0.5) * mh) / h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(mw - 1, Math.floor(((x + 0.5) * mw) / w));
        if (conf[sy * mw + sx] >= INTERACTIVE_THRESHOLD) out[y * w + x] = 255;
      }
    }
  });
  return out;
}
