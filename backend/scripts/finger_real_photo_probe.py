"""What the real MediaPipe model does to the fingers of two real flat-hand photos (the only real hands in the repo).

Runs the Hand Landmarker (backend/validation/hand_tracking.py, models/hand_landmarker.task) on the repository's two
sample photos, frontend/e2e/.media/hand.png and hand_portrait.png (untracked files; they are real photos of a flat
hand with a drawn-on coin), each perturbed N times (rotation +-5 deg, scale +-8%, pixel noise), and reports per
finger:

* repeatability of the chain length relative to the hand length (SD over the perturbations): REAL model output,
  but one hand and synthetic perturbations, so it is repeatability, not accuracy;
* the in-image and depth bend of each chain and how often the per-frame / per-scan bend gates would drop it;
* the elevation of each finger chord above the image plane from the world landmarks. The hands are flat, so the
  true elevation is about 0 (by eye, not measured): what the model reads is its own error;
* what the optional depth-aware length (config finger_accuracy.depth_aware_lengths) changes on these flat hands,
  in mm for an ASSUMED 185 mm hand and an ASSUMED 65 degree field of view. On a flat hand the ideal change is 0.

There is NO caliper truth here. Needs the optional validation dependencies (mediapipe).

Usage (from backend/):  python -m scripts.finger_real_photo_probe [--n 60]
"""

from __future__ import annotations

import argparse
import math

import cv2
import numpy as np

from glovesize.calibration import FrameScale
from glovesize.config import REPO_ROOT, load_measurement_config
from glovesize.landmarks import ALL_CHAINS, chain_bend_deg, chain_elevation_deg, path_length
from glovesize.measurement import depth_aware_length_mm

PHOTOS = ("hand", "hand_portrait")
ASSUMED_HAND_MM = 185.0
ASSUMED_HFOV_DEG = 65.0


def perturb(im: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    h, w = im.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), rng.uniform(-5, 5), rng.uniform(0.92, 1.08))
    out = cv2.warpAffine(im, m, (w, h), borderValue=(255, 255, 255))
    return np.clip(out.astype(np.float32) + rng.normal(0, 3, out.shape), 0, 255).astype(np.uint8)


def dump_landmarks(out_dir: str) -> None:
    """MediaPipe landmarks of the two UNPERTURBED photos plus the photos' own scale (the drawn coin), for the
    outline-fingertip check (frontend/src/vision/fingertip.realphoto.eval.test.ts reads these)."""
    import json
    from pathlib import Path

    from validation.hand_tracking import HandTracker

    media = REPO_ROOT / "frontend" / "e2e" / ".media"
    dest = Path(out_dir)
    dest.mkdir(parents=True, exist_ok=True)
    with HandTracker() as tracker:
        for photo in PHOTOS:
            im = cv2.imread(str(media / f"{photo}.png"))
            d = tracker.detect(im)
            meta = json.loads((media / f"{photo}.json").read_text(encoding="utf-8"))
            (dest / f"{photo}.json").write_text(
                json.dumps({"width": im.shape[1], "height": im.shape[0], "landmarks": d.landmarks_px[:, :2].tolist(),
                            "px_per_mm_coin": meta["coin_diameter_px"] / 24.26}),
                encoding="utf-8",
            )  # fmt: skip
            cv2.imwrite(str(dest / f"{photo}.png"), im)


def dump_perturbed(out_dir: str, n: int) -> None:
    """N perturbed copies of each photo (rotation +-5 deg, scale +-8%, noise) with the landmarks MediaPipe returns on each:
    real model jitter on real pixels, for the repeatability evaluation of the outline fingertip
    (frontend/src/vision/fingertip.repeat.eval.test.ts)."""
    import json
    from pathlib import Path

    from validation.hand_tracking import HandTracker

    media = REPO_ROOT / "frontend" / "e2e" / ".media"
    dest = Path(out_dir)
    dest.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(21)
    with HandTracker() as tracker:
        for photo in PHOTOS:
            im = cv2.imread(str(media / f"{photo}.png"))
            meta = json.loads((media / f"{photo}.json").read_text(encoding="utf-8"))
            k = 0
            for _ in range(n * 2):
                if k >= n:
                    break
                p = perturb(im, rng)
                d = tracker.detect(p)
                if d is None:
                    continue
                cv2.imwrite(str(dest / f"{photo}_{k}.png"), p)
                (dest / f"{photo}_{k}.json").write_text(json.dumps({"landmarks": d.landmarks_px[:, :2].tolist()}), encoding="utf-8")
                k += 1
            (dest / f"{photo}_meta.json").write_text(json.dumps({"n": k, "px_per_mm_coin": meta["coin_diameter_px"] / 24.26}), encoding="utf-8")


def draw_overlays(dir_: str) -> None:
    """Crops of each fingertip with the landmark tip (red) and the outline tip (green), from the eval's tips JSON."""
    import json
    from pathlib import Path

    d = Path(dir_)
    for photo in PHOTOS:
        res = json.loads((d / f"{photo}_tips.json").read_text(encoding="utf-8"))
        im = cv2.imread(str(d / f"{photo}.png"))
        tiles = []
        for f in res["fingers"]:
            tx, ty = f["tip"]
            half = 60
            x0, y0 = int(max(0, tx - half)), int(max(0, ty - half))
            crop = cv2.resize(im[y0 : y0 + 2 * half, x0 : x0 + 2 * half].copy(), None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
            def at(p, x0=x0, y0=y0):
                return int((p[0] - x0) * 4), int((p[1] - y0) * 4)

            cv2.circle(crop, at(f["tip"]), 6, (0, 0, 255), -1)
            if f["ok"]:
                cv2.circle(crop, at(f["refined"]), 6, (0, 200, 0), -1)
                cv2.line(crop, at(f["tip"]), at(f["refined"]), (0, 200, 0), 2)
            label = f"{f['name']} " + (f"+{f['ext_mm']:.1f} mm" if f["ok"] else f"fallback: {f['reason']}")
            cv2.putText(crop, label, (6, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 3)
            cv2.putText(crop, label, (6, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1)
            tiles.append(crop[:480, :480] if crop.shape[0] >= 480 and crop.shape[1] >= 480 else cv2.resize(crop, (480, 480)))
        cv2.imwrite(str(d / f"{photo}_tips_overlay.png"), np.hstack(tiles))
        print(d / f"{photo}_tips_overlay.png")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--dump-landmarks", default="", help="write the landmarks of the two photos to this folder and stop")
    ap.add_argument("--dump-perturbed", default="", help="write perturbed copies of the photos with their landmarks to this folder and stop")
    ap.add_argument("--overlay", default="", help="draw the outline-tip overlays from this folder's *_tips.json and stop")
    a = ap.parse_args()
    if a.dump_landmarks:
        dump_landmarks(a.dump_landmarks)
        return
    if a.dump_perturbed:
        dump_perturbed(a.dump_perturbed, a.n)
        return
    if a.overlay:
        draw_overlays(a.overlay)
        return
    from validation.hand_tracking import HandTracker  # optional dependency (mediapipe)

    cfg = load_measurement_config()
    cap = cfg.capture
    rng = np.random.default_rng(7)
    media = REPO_ROOT / "frontend" / "e2e" / ".media"
    frame_limit_3d = cap.max_finger_bend_deg_3d * cap.finger_bend_3d_frame_factor
    print(f"| photo | finger | length/hand SD | bend 2D median (limit {cap.max_finger_bend_deg:.0f}) | frames over 2D limit "
          f"| bend 3D median (limit {cap.max_finger_bend_deg_3d:.0f}) | frames over {frame_limit_3d:.0f} | elevation median / SD deg "
          "| depth-aware change mm mean / SD |")
    print("|---|---|---|---|---|---|---|---|---|")
    with HandTracker() as tracker:
        for photo in PHOTOS:
            path = media / f"{photo}.png"
            if not path.is_file():
                print(f"| {photo} | missing {path} |")
                continue
            im = cv2.imread(str(path))
            h, w = im.shape[:2]
            rows = []
            for _ in range(a.n):
                d = tracker.detect(perturb(im, rng))
                if d is None:
                    continue
                lm, world = d.landmarks_px[:, :2], d.world
                hand_px = float(np.linalg.norm(lm[12] - lm[0]))
                ppm = hand_px / ASSUMED_HAND_MM
                z = ((max(w, h) / 2) / math.tan(math.radians(ASSUMED_HFOV_DEG) / 2)) / ppm  # mm from the camera to the knuckle layer
                scale = FrameScale(ppm, ppm, 0, 0, 0, 0, 0.0, False, 1.0, (z, z), (0.0, 0.0), np.eye(2))
                row = {}
                for name, chain in ALL_CHAINS.items():
                    prod = path_length(lm, chain) / ppm
                    depth = depth_aware_length_mm(lm, chain, world[:, 2] * 1000.0, scale, (w / 2, h / 2), cfg.finger_accuracy.max_elevation_deg)
                    row[name] = dict(
                        ratio=path_length(lm, chain) / hand_px, b2=chain_bend_deg(lm, chain), b3=chain_bend_deg(world, chain),
                        elev=chain_elevation_deg(world, chain), change=depth - prod,
                    )  # fmt: skip
                rows.append(row)
            print(f"<!-- {photo}: detected {len(rows)}/{a.n}; palm tilt (model) median not shown -->")
            for name in ALL_CHAINS:
                def g(k, name=name, rows=rows):
                    return np.array([r[name][k] for r in rows])

                r = g("ratio")
                print(
                    f"| {photo} | {name} | {100 * r.std(ddof=1) / r.mean():.2f}% | {np.median(g('b2')):.1f} | {100 * np.mean(g('b2') > cap.max_finger_bend_deg):.0f}% "
                    f"| {np.median(g('b3')):.1f} | {100 * np.mean(g('b3') > frame_limit_3d):.0f}% "
                    f"| {np.median(g('elev')):.1f} / {g('elev').std(ddof=1):.1f} | {g('change').mean():+.2f} / {g('change').std(ddof=1):.2f} |"
                )


if __name__ == "__main__":
    main()
