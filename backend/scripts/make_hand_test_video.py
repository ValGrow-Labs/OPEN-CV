"""Build a fake-camera video of a real hand photo with a synthetic coin composited on the palm.

Purpose: an end-to-end PIPELINE test (camera -> MediaPipe -> coin detection -> API -> UI) on
a real hand image, and a cross-check that the browser and the Python offline pipeline agree.
The coin is synthetic, so the resulting millimetre values say NOTHING about real accuracy.

Source image: MediaPipe's public test asset ``right_hands.jpg``.
Writes ``<out>.y4m`` and ``<out>.json`` (Python-pipeline result for the same frames).

Usage (from backend/)::

    python -m scripts.make_hand_test_video ../frontend/e2e/.media/hand --config-dir <dir>
"""

from __future__ import annotations

import argparse
import json
import math
import os
import urllib.request
from pathlib import Path

import cv2
import numpy as np

SOURCE_URL = "https://storage.googleapis.com/mediapipe-assets/right_hands.jpg"
WIDTH, HEIGHT = 1280, 720
TARGET_HAND_LENGTH_MM = 185.0  # only used to choose a plausible synthetic coin size


def composite_coin(img: np.ndarray, centre: tuple[float, float], diameter: float, s: int = 4) -> np.ndarray:
    h, w = img.shape[:2]
    layer = np.zeros((h * s, w * s, 3), np.uint8)
    alpha = np.zeros((h * s, w * s), np.uint8)
    c = (int(round((centre[0] * s + (s - 1) / 2) * 16)), int(round((centre[1] * s + (s - 1) / 2) * 16)))
    r = int(round(diameter * s / 2 * 16))
    cv2.circle(layer, c, r, (150, 152, 150), -1, cv2.LINE_AA, 4)
    cv2.circle(layer, c, int(r * 0.96), (196, 198, 196), max(1, int(0.03 * diameter * s)), cv2.LINE_AA, 4)
    cv2.circle(layer, c, int(r * 0.45), (128, 130, 128), -1, cv2.LINE_AA, 4)
    cv2.circle(alpha, c, r, 255, -1, cv2.LINE_AA, 4)
    layer = cv2.resize(layer, (w, h), interpolation=cv2.INTER_AREA).astype(np.float64)
    a = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_AREA).astype(np.float64)[:, :, None] / 255
    return np.clip(img * (1 - a) + layer * a, 0, 255).astype(np.uint8)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", type=Path, help="output path without extension")
    ap.add_argument("--config-dir", type=Path, help="config directory to use for the Python cross-check")
    ap.add_argument("--frames", type=int, default=40)
    ap.add_argument("--portrait", action="store_true", help="720 x 1280 frames, as from a phone held upright")
    args = ap.parse_args()
    if args.config_dir:
        os.environ["GLOVESIZE_CONFIG_DIR"] = str(args.config_dir.resolve())

    from glovesize.calibration import resolve_reference
    from glovesize.config import load_measurement_config, load_reference_objects
    from glovesize.frame_analysis import build_frame_observation
    from glovesize.pipeline import process_scan
    from glovesize.schemas import ReferenceSelection, ScanRequest
    from scripts.make_fake_camera_video import write_y4m
    from validation.hand_tracking import HandTracker

    args.out.parent.mkdir(parents=True, exist_ok=True)
    src = args.out.parent / "right_hands.jpg"
    if not src.exists():
        urllib.request.urlretrieve(SOURCE_URL, src)  # noqa: S310 - fixed https URL
    photo = cv2.imread(str(src))
    width, height = (HEIGHT, WIDTH) if args.portrait else (WIDTH, HEIGHT)
    hand = photo[:, 360:]  # the right-hand half: an open hand with straight fingers
    scale = min(600 / hand.shape[0], 0.9 * width / hand.shape[1])
    hand = cv2.resize(hand, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    canvas = np.full((height, width, 3), 255, np.uint8)
    x0, y0 = (width - hand.shape[1]) // 2, (height - hand.shape[0]) // 3 if args.portrait else 20
    canvas[y0 : y0 + hand.shape[0], x0 : x0 + hand.shape[1]] = hand
    # Extend the wrist downwards so the wrist landmark is not at the frame edge.
    canvas[y0 + hand.shape[0] :, x0 : x0 + hand.shape[1]] = hand[-1:, :, :]

    cfg = load_measurement_config()
    with HandTracker() as tracker:
        det = tracker.detect(canvas)
        if det is None:
            raise SystemExit("MediaPipe did not detect the hand in the test image")
        lm = det.landmarks_px
        centre = lm[[0, 5, 9, 13, 17], :2].mean(axis=0)
        hand_len_px = float(np.linalg.norm(lm[0, :2] - lm[12, :2]))
        coin_px = hand_len_px * 24.26 / (TARGET_HAND_LENGTH_MM * 0.96)
        base = composite_coin(canvas, (float(centre[0]), float(centre[1])), coin_px)

        rng = np.random.default_rng(0)
        frames, observations = [], []
        for i in range(args.frames):
            dx, dy = rng.uniform(-0.6, 0.6, 2)
            m = np.float32([[1, 0, dx], [0, 1, dy]])
            f = cv2.warpAffine(base, m, (width, height), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            f = np.clip(f + rng.normal(0, 1.5, f.shape), 0, 255).astype(np.uint8)
            frames.append(f)
            d = tracker.detect(f)
            if d is not None:
                observations.append(
                    build_frame_observation(
                        f, d.landmarks_px, d.world, d.handedness, d.handedness_score, cfg.coin_detection, i * 33.0
                    )
                )

    write_y4m(args.out.with_suffix(".y4m"), frames)
    ref = resolve_reference(ReferenceSelection(object_id="us_quarter"), load_reference_objects())
    assert ref is not None
    resp = process_scan(
        ScanRequest.model_validate(
            {"frames": observations, "reference": {"object_id": "us_quarter", "confirmed": True}}
        )
    )
    hl = next((m for m in resp.measurements if m.key == "hand_length_mm"), None)
    summary = {
        "note": "Synthetic coin on a real hand photo: pipeline test only, not an accuracy measurement.",
        "coin_diameter_px": coin_px,
        "python_status": resp.status,
        "python_frames_accepted": resp.frames_accepted,
        "python_rejections": resp.frame_rejection_counts,
        "python_hand_length_mm": hl.value_mm if hl else None,
        "python_size": resp.recommendation.size if resp.recommendation else None,
        "landmark_hand_length_px": hand_len_px,
        "hand_length_if_no_depth_correction_mm": hand_len_px / (coin_px / ref.diameter_mm),
    }
    args.out.with_suffix(".json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    cv2.imwrite(str(args.out.with_suffix(".png")), frames[0])
    print(json.dumps(summary, indent=2))
    if not math.isfinite(coin_px):
        raise SystemExit("invalid coin size")


if __name__ == "__main__":
    main()
