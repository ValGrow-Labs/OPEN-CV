"""MediaPipe hand-landmark topology and geometric checks.

Landmark indices follow the MediaPipe Hand Landmarker model:
https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
"""

from __future__ import annotations

import numpy as np

NUM_LANDMARKS = 21

WRIST = 0
THUMB_CMC, THUMB_MCP, THUMB_IP, THUMB_TIP = 1, 2, 3, 4
INDEX_MCP, INDEX_PIP, INDEX_DIP, INDEX_TIP = 5, 6, 7, 8
MIDDLE_MCP, MIDDLE_PIP, MIDDLE_DIP, MIDDLE_TIP = 9, 10, 11, 12
RING_MCP, RING_PIP, RING_DIP, RING_TIP = 13, 14, 15, 16
PINKY_MCP, PINKY_PIP, PINKY_DIP, PINKY_TIP = 17, 18, 19, 20

LANDMARK_NAMES = [
    "wrist",
    "thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip",
    "index_mcp", "index_pip", "index_dip", "index_tip",
    "middle_mcp", "middle_pip", "middle_dip", "middle_tip",
    "ring_mcp", "ring_pip", "ring_dip", "ring_tip",
    "pinky_mcp", "pinky_pip", "pinky_dip", "pinky_tip",
]  # fmt: skip

# Chains MCP -> PIP -> DIP -> TIP of the four long fingers, used for straightness checks.
LONG_FINGERS: dict[str, tuple[int, int, int, int]] = {
    "index": (INDEX_MCP, INDEX_PIP, INDEX_DIP, INDEX_TIP),
    "middle": (MIDDLE_MCP, MIDDLE_PIP, MIDDLE_DIP, MIDDLE_TIP),
    "ring": (RING_MCP, RING_PIP, RING_DIP, RING_TIP),
    "little": (PINKY_MCP, PINKY_PIP, PINKY_DIP, PINKY_TIP),
}

# Outline of the palm, used to check that the coin rests on the palm.
PALM_POLYGON = (WRIST, THUMB_CMC, THUMB_MCP, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP)
PALM_PLANE_POINTS = (WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP)


def as_array(points: object, dims: int = 2) -> np.ndarray:
    arr = np.asarray(points, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[0] != NUM_LANDMARKS or arr.shape[1] < dims:
        raise ValueError(f"expected {NUM_LANDMARKS} landmarks with at least {dims} coordinates")
    return arr[:, :dims]


def path_length(points: np.ndarray, chain: list[int] | tuple[int, ...]) -> float:
    seg = np.diff(points[list(chain)], axis=0)
    return float(np.linalg.norm(seg, axis=1).sum())


def chain_bend_deg(points: np.ndarray, chain: tuple[int, ...] | list[int]) -> float:
    """Total bend along a joint chain: the sum of the angles between consecutive segments.

    0 deg means a perfectly straight finger. Works for 2D or 3D points.
    """
    seg = np.diff(points[list(chain)], axis=0)
    norms = np.linalg.norm(seg, axis=1)
    if np.any(norms < 1e-9):
        return float("nan")
    unit = seg / norms[:, None]
    cosines = np.clip(np.sum(unit[:-1] * unit[1:], axis=1), -1.0, 1.0)
    return float(np.degrees(np.arccos(cosines)).sum())


def palm_tilt_deg(world: np.ndarray) -> float:
    """Angle between the palm-plane normal and the camera's optical axis.

    Uses MediaPipe *world* landmarks, which are model estimates (not measurements);
    the result is used only as a plausibility gate.
    """
    pts = world[list(PALM_PLANE_POINTS), :3]
    centred = pts - pts.mean(axis=0)
    _, _, vt = np.linalg.svd(centred)
    normal = vt[-1]
    return float(np.degrees(np.arccos(min(1.0, abs(normal[2]) / np.linalg.norm(normal)))))


def point_in_polygon(point: tuple[float, float], polygon: np.ndarray) -> bool:
    x, y = point
    inside = False
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            x_cross = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < x_cross:
                inside = not inside
    return inside


def palm_polygon(points: np.ndarray) -> np.ndarray:
    return points[list(PALM_POLYGON), :2]


def bbox_size(points: np.ndarray) -> float:
    span = points[:, :2].max(axis=0) - points[:, :2].min(axis=0)
    return float(span.max())


def inside_frame(points: np.ndarray, width: int, height: int, margin_fraction: float) -> bool:
    mx, my = width * margin_fraction, height * margin_fraction
    xs, ys = points[:, 0], points[:, 1]
    return bool(np.all(xs >= mx) and np.all(xs <= width - mx) and np.all(ys >= my) and np.all(ys <= height - my))
