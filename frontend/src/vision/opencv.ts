// Loader for OpenCV.js (WASM, ~10 MB).
//
// The library is served as a classic script from /opencv/opencv.js (copied into public/ by
// scripts/setup-assets.mjs) and loaded only when the scanner starts, keeping it out of the
// app bundle. It is not loaded through `import()`: the Emscripten module object has a
// `then` method, and promise resolution would treat it (and an ES-module namespace that
// re-exports it) as a thenable and never settle.
import type cvType from "@techstark/opencv-js";

export type CV = typeof cvType;

type EmscriptenModule = CV & { Mat?: unknown; onRuntimeInitialized?: () => void; then?: unknown };

export const OPENCV_URL = "/opencv/opencv.js";

/** Wait for the WASM runtime, then strip `then` so the module can be returned from promises. */
export async function initOpenCV(module: unknown): Promise<CV> {
  const cv = module as EmscriptenModule;
  if (!cv.Mat) {
    await new Promise<void>((resolve) => {
      cv.onRuntimeInitialized = () => resolve();
    });
  }
  delete cv.then;
  return cv;
}

let pending: Promise<CV> | null = null;

export function loadOpenCV(url: string = OPENCV_URL): Promise<CV> {
  if (!pending) {
    // The module is always wrapped in an object so the thenable never reaches resolve().
    pending = new Promise<{ cv: unknown }>((resolve, reject) => {
      const existing = (window as unknown as { cv?: unknown }).cv;
      if (existing) return resolve({ cv: existing });
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.onload = () => {
        const cv = (window as unknown as { cv?: unknown }).cv;
        if (cv) resolve({ cv });
        else reject(new Error("OpenCV.js loaded but did not define `cv`"));
      };
      script.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.head.appendChild(script);
    }).then(({ cv }) => initOpenCV(cv));
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}
