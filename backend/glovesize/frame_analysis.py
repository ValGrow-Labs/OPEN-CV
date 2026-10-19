"""Per-frame image analysis: from an image plus hand landmarks to a ``FrameObservation``.

This is the Python counterpart of the browser's frame processing
(``frontend/src/vision/frameAnalysis.ts``) and is used by the offline validation pipeline,
so that still images and live camera frames go through the same steps.
"""

from __future__ import annotations

import numpy as np

from .coin_detection import detect_coin, to_gray
from .config import CoinDetectionParams
from .landmarks import MIDDLE_MCP, PALM_PLANE_POINTS, WRIST


def coin_search_window(
    landmarks_px: np.ndarray, image_w: int, image_h: int, p: CoinDetectionParams
) -> tuple[tuple[int, int, int, int], tuple[float, float]]:
    """ROI ``(x, y, w, h)`` around the palm centre and the plausible coin-diameter range (px)."""
    pts = landmarks_px[:, :2]
    centre = pts[list(PALM_PLANE_POINTS)].mean(axis=0)
    palm_len = float(np.linalg.norm(pts[WRIST] - pts[MIDDLE_MCP]))
    half = p.search_roi_half_size_palm_lengths * palm_len
    x0 = int(max(0, np.floor(centre[0] - half)))
    y0 = int(max(0, np.floor(centre[1] - half)))
    x1 = int(min(image_w, np.ceil(centre[0] + half)))
    y1 = int(min(image_h, np.ceil(centre[1] + half)))
    lo, hi = p.search_diameter_range_palm_lengths
    return (x0, y0, x1 - x0, y1 - y0), (lo * palm_len, hi * palm_len)


def build_frame_observation(
    image_bgr: np.ndarray,
    landmarks_px: np.ndarray,
    world_landmarks: np.ndarray | None,
    handedness: str | None,
    handedness_score: float | None,
    p: CoinDetectionParams,
    timestamp_ms: float = 0.0,
) -> dict:
    h, w = image_bgr.shape[:2]
    roi, d_range = coin_search_window(landmarks_px, w, h, p)
    det = detect_coin(image_bgr, p, roi=roi, diameter_range_px=d_range)
    x, y, rw, rh = roi
    gray = to_gray(image_bgr)[y : y + rh, x : x + rw]
    return {
        "timestamp_ms": timestamp_ms,
        "image_width": w,
        "image_height": h,
        "landmarks": [{"x": float(a), "y": float(b), "z": float(c)} for a, b, c in landmarks_px[:, :3]],
        "world_landmarks": None
        if world_landmarks is None
        else [{"x": float(a), "y": float(b), "z": float(c)} for a, b, c in world_landmarks[:, :3]],
        "handedness": handedness,
        "handedness_score": handedness_score,
        "coin": det.to_observation() if det.found else None,
        "brightness": float(gray.mean()) if gray.size else None,
    }
