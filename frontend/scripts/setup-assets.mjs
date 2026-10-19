// Copies the MediaPipe WASM runtime and the hand-landmarker model into public/ so the app
// serves them itself (no third-party CDN at runtime). Downloads the model if missing.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = dirname(root);
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_SHA256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1";

const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmDst = join(root, "public", "mediapipe", "wasm");
if (existsSync(wasmSrc)) {
  mkdirSync(wasmDst, { recursive: true });
  cpSync(wasmSrc, wasmDst, { recursive: true });
  console.log("copied MediaPipe wasm ->", wasmDst);
}

const opencvSrc = join(root, "node_modules", "@techstark", "opencv-js", "dist", "opencv.js");
if (existsSync(opencvSrc)) {
  mkdirSync(join(root, "public", "opencv"), { recursive: true });
  cpSync(opencvSrc, join(root, "public", "opencv", "opencv.js"));
  console.log("copied OpenCV.js -> public/opencv");
}

const repoModel = join(repo, "models", "hand_landmarker.task");
if (!existsSync(repoModel)) {
  console.log("downloading", MODEL_URL);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  mkdirSync(dirname(repoModel), { recursive: true });
  writeFileSync(repoModel, Buffer.from(await res.arrayBuffer()));
}
const digest = createHash("sha256").update(readFileSync(repoModel)).digest("hex");
if (digest !== MODEL_SHA256) {
  console.warn(`WARNING: hand_landmarker.task sha256 ${digest} differs from the verified ${MODEL_SHA256}`);
}
const modelDst = join(root, "public", "models");
mkdirSync(modelDst, { recursive: true });
cpSync(repoModel, join(modelDst, "hand_landmarker.task"));
console.log("copied model ->", modelDst);
