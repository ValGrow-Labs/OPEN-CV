"""Hand segmentation on the rectified sheet and outline-based anatomical endpoints.

Endpoints come from the hand's *outline* (skin edges), which is what the anthropometric
definitions use:

* hand length: wrist crease to the tip of the middle finger. The protocol puts the wrist
  crease on the sheet's edge, so that end is a physical line, not a model guess. The tip is
  the outline point farthest from that edge.
* hand breadth: across the palm at the metacarpal heads, thumb excluded. The outline gives
  both skin edges; only the *level* of the metacarpals has to be located, from MediaPipe's
  MCP landmarks when available, otherwise from a heuristic fraction of hand length.

MediaPipe joint-centre landmarks alone would give neither skin endpoint.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from glovesize.coin_detection import bilinear, chroma_channel

from .config import HandParams
from .paper import PaperGeometry

SIDES = ("top", "right", "bottom", "left")


@dataclass
class Frame:
    """Wrist frame: y = distance from the wrist edge into the sheet, x = along that edge (mm)."""

    side: str
    size_mm: tuple[float, float]

    def from_sheet(self, p: np.ndarray) -> np.ndarray:
        p = np.atleast_2d(p).astype(float)
        x, y = p[:, 0], p[:, 1]
        sx, sy = self.size_mm
        if self.side == "bottom":
            return np.column_stack([x, sy - y])
        if self.side == "top":
            return np.column_stack([x, y])
        if self.side == "left":
            return np.column_stack([y, x])
        return np.column_stack([y, sx - x])

    def to_sheet(self, q: np.ndarray) -> np.ndarray:
        q = np.atleast_2d(q).astype(float)
        a, b = q[:, 0], q[:, 1]
        sx, sy = self.size_mm
        if self.side == "bottom":
            return np.column_stack([a, sy - b])
        if self.side == "top":
            return np.column_stack([a, b])
        if self.side == "left":
            return np.column_stack([b, a])
        return np.column_stack([sx - b, a])

    @property
    def depth_mm(self) -> float:
        """Extent of the sheet perpendicular to the wrist edge."""
        return self.size_mm[1] if self.side in ("top", "bottom") else self.size_mm[0]


@dataclass
class Segmentation:
    rectified: np.ndarray
    chroma: np.ndarray  # smoothed, float32
    threshold: float
    mask: np.ndarray
    px_per_mm: float
    frame: Frame | None
    reasons: list[str] = field(default_factory=list)


@dataclass
class OutlineMeasurement:
    wrist_mid: np.ndarray  # wrist frame (mm)
    wrist_width_mm: float
    tip: np.ndarray
    axis_angle_deg: float
    length_perp_mm: float  # tip distance from the wrist edge (protocol definition)
    length_axis_mm: float  # tip distance from the wrist-crossing midpoint
    breadth_mm: float
    breadth_ends: np.ndarray  # (2, 2)
    breadth_level_mm: float
    breadth_level_source: str  # "mediapipe_mcp" or "heuristic_fraction"
    breadth_level_sensitivity_mm: float  # half the breadth change over +/-8 mm of level
    min_margin_mm: float
    reasons: list[str] = field(default_factory=list)


def rectify(image_bgr: np.ndarray, geom: PaperGeometry, px_per_mm: float) -> np.ndarray:
    s = np.diag([px_per_mm, px_per_mm, 1.0])
    size = (round(geom.size_mm[0] * px_per_mm), round(geom.size_mm[1] * px_per_mm))
    return cv2.warpPerspective(
        image_bgr, s @ geom.h_img_to_mm, size, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
    )


def segment_hand(image_bgr: np.ndarray, geom: PaperGeometry, px_per_mm: float, p: HandParams) -> Segmentation:
    rect = rectify(image_bgr, geom, px_per_mm)
    chroma = cv2.GaussianBlur(chroma_channel(rect).astype(np.float32), (5, 5), 0)
    thr, raw = cv2.threshold(chroma.astype(np.uint8), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    above, below = chroma[raw > 0], chroma[raw == 0]
    if above.size == 0 or below.size == 0 or float(above.mean() - below.mean()) < 6.0:
        return Segmentation(rect, chroma, float(thr), raw, px_per_mm, None, ["hand_not_separated"])
    k = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(cv2.morphologyEx(raw, cv2.MORPH_OPEN, k), cv2.MORPH_CLOSE, k, iterations=2)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return Segmentation(rect, chroma, float(thr), mask, px_per_mm, None, ["hand_not_found"])
    idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = (labels == idx).astype(np.uint8) * 255
    # Fill holes (nails, rings, highlights) so the outline is the outer skin edge.
    flood = mask.copy()
    cv2.floodFill(flood, np.zeros((mask.shape[0] + 2, mask.shape[1] + 2), np.uint8), (0, 0), 255)
    mask = mask | cv2.bitwise_not(flood) if mask[0, 0] == 0 else mask

    band = 2
    counts = {"top": int(mask[:band].any(axis=0).sum()), "bottom": int(mask[-band:].any(axis=0).sum()),
              "left": int(mask[:, :band].any(axis=1).sum()), "right": int(mask[:, -band:].any(axis=1).sum())}  # fmt: skip
    side = max(counts, key=counts.get)
    if counts[side] / px_per_mm < p.min_wrist_width_mm:
        return Segmentation(rect, chroma, float(thr), mask, px_per_mm, None, ["hand_not_at_edge"])
    return Segmentation(rect, chroma, float(thr), mask, px_per_mm, Frame(side, geom.size_mm))


def _sample(seg: Segmentation, pts_frame: np.ndarray) -> np.ndarray:
    sheet = seg.frame.to_sheet(pts_frame) * seg.px_per_mm
    vals, ok = bilinear(seg.chroma, sheet[:, 0], sheet[:, 1])
    return np.where(ok, vals, -1.0)


def _crossing(
    seg: Segmentation, start: np.ndarray, direction: np.ndarray, max_mm: float, step: float = 0.05
) -> float | None:
    """Distance from ``start`` (inside the hand) along ``direction`` to the outline, sub-pixel."""
    s = np.arange(0.0, max_mm, step)
    v = _sample(seg, start[None, :] + s[:, None] * direction[None, :]) - seg.threshold
    out = np.nonzero(v < 0)[0]
    if out.size == 0 or out[0] == 0:
        return None
    i = out[0]
    return float(s[i - 1] + step * v[i - 1] / (v[i - 1] - v[i]))


def _chord(seg: Segmentation, centre: np.ndarray, normal: np.ndarray) -> tuple[float, np.ndarray] | None:
    a = _crossing(seg, centre, normal, 120.0)
    b = _crossing(seg, centre, -normal, 120.0)
    if a is None or b is None:
        return None
    ends = np.array([centre + a * normal, centre - b * normal])
    return a + b, ends


def measure_outline(seg: Segmentation, p: HandParams, mcp_frame: np.ndarray | None = None) -> OutlineMeasurement | None:
    frame, s = seg.frame, seg.px_per_mm
    contours, _ = cv2.findContours(seg.mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    outline = frame.from_sheet(max(contours, key=cv2.contourArea).reshape(-1, 2) / s)

    # Wrist: where the hand crosses the edge, sampled 1 mm inside the sheet.
    xs = np.arange(0.0, max(frame.size_mm), 0.1)
    inside = _sample(seg, np.column_stack([xs, np.full_like(xs, 1.0)])) > seg.threshold
    if not inside.any():
        return None
    runs = np.split(np.nonzero(inside)[0], np.nonzero(np.diff(np.nonzero(inside)[0]) > 1)[0] + 1)
    run = max(runs, key=len)
    wrist_mid = np.array([(xs[run[0]] + xs[run[-1]]) / 2, 0.0])
    wrist_width = float(xs[run[-1]] - xs[run[0]])

    # Tip: farthest outline point from the edge, refined to sub-pixel along +y.
    coarse = outline[int(np.argmax(outline[:, 1]))]
    best, tip_x = coarse[1], coarse[0]
    for dx in np.arange(-1.5, 1.51, 0.1):
        start = np.array([coarse[0] + dx, coarse[1] - 6.0])
        if _sample(seg, start[None])[0] <= seg.threshold:
            continue
        d = _crossing(seg, start, np.array([0.0, 1.0]), 12.0, step=0.02)
        if d is not None and start[1] + d > best:
            best, tip_x = start[1] + d, start[0]
    tip = np.array([tip_x, best])

    axis = tip - wrist_mid
    length_axis = float(np.linalg.norm(axis))
    u = axis / length_axis
    normal = np.array([-u[1], u[0]])
    angle = math.degrees(math.atan2(axis[0], axis[1]))

    if mcp_frame is not None:
        level, source = float(np.mean((mcp_frame - wrist_mid) @ u)), "mediapipe_mcp"
    else:
        level, source = p.palm_level_fraction_of_length * float(tip[1]), "heuristic_fraction"

    def breadth_at(t: float):
        return _chord(seg, wrist_mid + t * u, normal)

    # Maximum breadth over a small band around the metacarpal level (anthropometric definition).
    best_chord = None
    for t in np.linspace(level - p.palm_band_mm / 2, level + p.palm_band_mm / 2, 5):
        c = breadth_at(t)
        if c is not None and (best_chord is None or c[0] > best_chord[0]):
            best_chord = c
    if best_chord is None:
        return None
    # A thumb held against the palm merges with the outline and cannot be separated reliably from
    # the silhouette alone (it reaches past the finger webs). The protocol asks for the thumb to
    # be spread away; this only flags an implausibly wide palm for a retake.
    thumb_merged = best_chord[0] > p.max_breadth_to_length * float(tip[1])
    lo, hi = breadth_at(level - 8.0), breadth_at(level + 8.0)
    sensitivity = abs(hi[0] - lo[0]) / 2 if lo and hi else float("nan")

    # Clearance from the three sheet edges that the hand must not reach.
    margin_far = float(np.min(frame.depth_mm - outline[:, 1]))
    width_along = frame.size_mm[0] if frame.side in ("top", "bottom") else frame.size_mm[1]
    margin_sides = float(min(np.min(outline[:, 0]), np.min(width_along - outline[:, 0])))
    reasons = []
    margin = min(margin_far, margin_sides)
    if margin < p.min_margin_mm:
        reasons.append("hand_near_sheet_edge")
    if abs(angle) > p.max_axis_angle_deg:
        reasons.append("hand_axis_rotated")
    if thumb_merged:
        reasons.append("breadth_implausible_check_thumb")
    return OutlineMeasurement(
        wrist_mid, wrist_width, tip, angle, float(tip[1]), length_axis, best_chord[0], best_chord[1], level,
        source, sensitivity, margin, reasons,
    )  # fmt: skip
