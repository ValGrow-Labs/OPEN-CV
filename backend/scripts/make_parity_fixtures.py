"""Generate coin-detection parity fixtures for the TypeScript port.

Writes frontend/src/vision/__fixtures__/coin_scenes.json: synthetic RGBA scenes
(zlib + base64) together with the Python reference detector's output for each scene.
Run from backend/:  python -m scripts.make_parity_fixtures
"""

from __future__ import annotations

import base64
import json
import zlib

import cv2
import numpy as np

from glovesize.coin_detection import detect_coin
from glovesize.config import REPO_ROOT, load_measurement_config
from glovesize.frame_analysis import coin_search_window
from glovesize.synthetic import render_coin_scene, synthetic_frame

SCENES = {
    "clean_70": dict(width=240, height=240, center=(120.3, 118.6), diameter_px=70.0, seed=1),
    "tilted_20": dict(
        width=240, height=240, center=(121.0, 119.0), diameter_px=72.0, tilt_deg=20, major_angle_deg=40, seed=2
    ),
    "small_off_centre": dict(width=240, height=200, center=(80.4, 120.2), diameter_px=46.0, noise_sigma=4.0, seed=3),
    "blurred": dict(width=240, height=240, diameter_px=70.0, center=(120, 120), blur_sigma=3.0, seed=4),
    "glare": dict(width=240, height=240, diameter_px=70.0, center=(120, 120), glare_fraction_of_radius=0.6, seed=5),
    "occluded": dict(width=240, height=240, diameter_px=70.0, center=(120, 120), occlusion_depth_fraction=0.3, seed=6),
}
ROI_CASE = {"scene": "clean_70", "roi": [60, 50, 130, 140], "diameter_range_px": [40.0, 110.0]}


def main() -> None:
    p = load_measurement_config().coin_detection
    out = {"generator": "backend/scripts/make_parity_fixtures.py", "scenes": []}
    images = {}
    for name, kw in SCENES.items():
        bgr, truth = render_coin_scene(**kw)
        images[name] = bgr
        rgba = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGBA)
        det = detect_coin(bgr, p)
        out["scenes"].append(
            {
                "name": name,
                "width": int(bgr.shape[1]),
                "height": int(bgr.shape[0]),
                "rgba_zlib_b64": base64.b64encode(zlib.compress(rgba.tobytes(), 9)).decode(),
                "truth": truth.__dict__,
                "python": det.to_observation(),
            }
        )
    roi_det = detect_coin(
        images[ROI_CASE["scene"]], p, roi=tuple(ROI_CASE["roi"]), diameter_range_px=tuple(ROI_CASE["diameter_range_px"])
    )
    out["roi_case"] = {**ROI_CASE, "python": roi_det.to_observation()}
    frame = synthetic_frame(rotation_deg=17.0, tilt_deg=9.0, px_per_mm=2.9)
    lm = np.array([[q["x"], q["y"], q["z"]] for q in frame["landmarks"]])
    roi, d_range = coin_search_window(lm, frame["image_width"], frame["image_height"], p)
    out["search_window_case"] = {"frame": frame, "roi": list(roi), "diameter_range_px": list(d_range)}
    path = REPO_ROOT / "frontend" / "src" / "vision" / "__fixtures__" / "coin_scenes.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out), encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size // 1024} KiB)")
    for s in out["scenes"]:
        d = s["python"]
        print(f"  {s['name']:18s} accepted={d['accepted']!s:5s} major={d['major_axis_px']:.2f} reasons={d['reasons']}")


if __name__ == "__main__":
    main()
