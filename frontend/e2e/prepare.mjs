// Prepares fake-camera media and the relaxed test config for the e2e tests.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const media = resolve(root, "e2e/.media");
const backend = resolve(root, "../backend");
const python =
  process.env.GLOVESIZE_PYTHON ??
  resolve(backend, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");

if (!existsSync(resolve(root, "dist/index.html"))) {
  console.error("frontend/dist is missing: run `npm run build` first");
  process.exit(1);
}

const run = (args) => execFileSync(python, args, { cwd: backend, stdio: "inherit" });

if (!existsSync(resolve(media, "coin.y4m"))) run(["-m", "scripts.make_fake_camera_video", resolve(media, "coin.y4m")]);

// The sample hand photo is a relaxed, back-of-hand pose whose MediaPipe *world* landmarks
// exceed the provisional 3D flatness gates. Only for this pipeline test, those two gates
// are relaxed in a copy of the config; production config is unchanged.
const relaxed = resolve(media, "config-relaxed");
rmSync(relaxed, { recursive: true, force: true });
cpSync(resolve(root, "../config"), relaxed, { recursive: true });
const mPath = resolve(relaxed, "measurement.json");
const m = JSON.parse(readFileSync(mPath, "utf-8"));
m.capture.max_palm_tilt_deg_model = 45;
m.capture.max_finger_bend_deg_3d = 50;
writeFileSync(mPath, JSON.stringify(m, null, 2));

// Validation-mode e2e records go to a throwaway file, never to data/validation.
rmSync(resolve(media, "validation-records.jsonl"), { force: true });
rmSync(resolve(media, "validation"), { recursive: true, force: true }); // records, frames/, configs/

if (!existsSync(resolve(media, "hand.y4m"))) {
  try {
    run(["-m", "scripts.make_hand_test_video", resolve(media, "hand"), "--config-dir", relaxed]);
  } catch {
    console.warn("hand test video could not be generated (needs network + mediapipe); full-scan test will be skipped");
  }
}
