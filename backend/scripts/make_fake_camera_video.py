"""Write a Y4M video for Chrome's fake camera (--use-file-for-fake-video-capture).

Used by the browser end-to-end tests. The default scene is a synthetic coin on a skin-coloured
background (no hand), with the coin's true pixel diameter written next to the video as JSON.
An optional still image (e.g. a photo of a hand) can be used instead with --image.

Usage (from backend/)::

    python -m scripts.make_fake_camera_video out.y4m [--image photo.jpg] [--frames 30]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from glovesize.synthetic import render_coin_scene

WIDTH, HEIGHT = 1280, 720


def write_y4m(path: Path, frames: list[np.ndarray], fps: int = 30) -> None:
    h, w = frames[0].shape[:2]
    with path.open("wb") as f:
        f.write(f"YUV4MPEG2 W{w} H{h} F{fps}:1 Ip A1:1 C420jpeg\n".encode())
        for bgr in frames:
            f.write(b"FRAME\n")
            f.write(cv2.cvtColor(bgr, cv2.COLOR_BGR2YUV_I420).tobytes())


def coin_frames(n: int) -> tuple[list[np.ndarray], dict]:
    frames, truth = [], None
    for i in range(n):
        img, t = render_coin_scene(
            width=WIDTH, height=HEIGHT, center=(640.0, 360.0), diameter_px=120.0, seed=i, noise_sigma=2.0
        )
        frames.append(img)
        truth = t
    return frames, {"center_x": truth.center_x, "center_y": truth.center_y, "diameter_px": truth.major_axis_px}


def image_frames(path: Path, n: int) -> list[np.ndarray]:
    img = cv2.imread(str(path))
    if img is None:
        raise SystemExit(f"cannot read {path}")
    scale = min(WIDTH / img.shape[1], HEIGHT / img.shape[0])
    resized = cv2.resize(img, (int(img.shape[1] * scale), int(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((HEIGHT, WIDTH, 3), np.uint8)
    y0, x0 = (HEIGHT - resized.shape[0]) // 2, (WIDTH - resized.shape[1]) // 2
    canvas[y0 : y0 + resized.shape[0], x0 : x0 + resized.shape[1]] = resized
    return [canvas] * n


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", type=Path)
    ap.add_argument("--image", type=Path)
    ap.add_argument("--frames", type=int, default=30)
    args = ap.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.image:
        write_y4m(args.out, image_frames(args.image, args.frames))
        print(f"wrote {args.out}")
        return
    frames, truth = coin_frames(args.frames)
    write_y4m(args.out, frames)
    args.out.with_suffix(".json").write_text(json.dumps(truth), encoding="utf-8")
    print(f"wrote {args.out} (coin diameter {truth['diameter_px']} px)")


if __name__ == "__main__":
    main()
