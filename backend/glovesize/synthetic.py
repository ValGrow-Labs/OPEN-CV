"""Synthetic test scenes with exactly known geometry.

Used only for automated tests and parity fixtures. Synthetic images verify that the
algorithms recover known geometry; they say nothing about real-world accuracy.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

SKIN_BGR = (135, 165, 215)
COIN_BGR = (150, 152, 150)
RIM_BGR = (196, 198, 196)
CREASE_BGR = (105, 125, 170)

_SHIFT = 4  # fixed-point bits for sub-pixel drawing
_ONE = 1 << _SHIFT


@dataclass
class SceneTruth:
    center_x: float
    center_y: float
    major_axis_px: float
    minor_axis_px: float
    angle_deg: float


def _fx(v: float) -> int:
    return int(round(v * _ONE))


def _ellipse(img: np.ndarray, s: int, center, axes, angle: float, color, thickness: int = -1) -> None:
    # Map low-res pixel-centre coordinates to the supersampled grid.
    cx = s * center[0] + (s - 1) / 2
    cy = s * center[1] + (s - 1) / 2
    cv2.ellipse(
        img,
        (_fx(cx), _fx(cy)),
        (_fx(s * axes[0] / 2), _fx(s * axes[1] / 2)),
        angle,
        0,
        360,
        color,
        thickness,
        cv2.LINE_AA,
        _SHIFT,
    )


def render_coin_scene(
    width: int = 480,
    height: int = 480,
    center: tuple[float, float] = (240.0, 240.0),
    diameter_px: float = 80.0,
    tilt_deg: float = 0.0,
    major_angle_deg: float = 0.0,
    blur_sigma: float = 0.0,
    glare_fraction_of_radius: float = 0.0,
    occlusion_depth_fraction: float = 0.0,
    occlusion_side_deg: float = 0.0,
    noise_sigma: float = 2.0,
    creases: bool = True,
    seed: int = 0,
    supersample: int = 4,
) -> tuple[np.ndarray, SceneTruth]:
    """Render a coin lying on a skin-like surface; returns (BGR image, ground truth)."""
    rng = np.random.default_rng(seed)
    s = supersample
    hi = np.zeros((height * s, width * s, 3), np.uint8)
    hi[:] = SKIN_BGR

    if creases:
        for _ in range(4):
            x1, y1 = rng.uniform(0, width), rng.uniform(0, height)
            ang = rng.uniform(0, math.pi)
            length = rng.uniform(0.3, 0.8) * width
            x2, y2 = x1 + length * math.cos(ang), y1 + length * math.sin(ang)
            cv2.line(hi, (_fx(s * x1), _fx(s * y1)), (_fx(s * x2), _fx(s * y2)), CREASE_BGR, s, cv2.LINE_AA, _SHIFT)

    major = diameter_px
    minor = diameter_px * math.cos(math.radians(tilt_deg))
    _ellipse(hi, s, center, (major, minor), major_angle_deg, COIN_BGR)
    # Raised rim and some relief inside the coin face.
    _ellipse(
        hi, s, center, (major * 0.96, minor * 0.96), major_angle_deg, RIM_BGR, thickness=max(1, int(0.03 * major * s))
    )
    for _ in range(6):
        r = rng.uniform(0.05, 0.3) * major / 2
        off = rng.uniform(-0.35, 0.35, size=2) * np.array([major, minor])
        shade = int(rng.uniform(120, 175))
        _ellipse(hi, s, (center[0] + off[0], center[1] + off[1]), (2 * r, 2 * r), 0, (shade,) * 3)

    glare_hi = np.zeros(hi.shape[:2], np.uint8)
    if glare_fraction_of_radius > 0:
        g = glare_fraction_of_radius * diameter_px
        _ellipse(glare_hi, s, (center[0] - 0.1 * major, center[1] - 0.1 * minor), (g, g), 0, 255)

    if occlusion_depth_fraction > 0:
        # A finger-like bar entering from one side and covering part of the coin.
        ang = math.radians(occlusion_side_deg)
        ux, uy = math.cos(ang), math.sin(ang)
        tip_dist = major / 2 - occlusion_depth_fraction * major
        tip = (center[0] + ux * tip_dist, center[1] + uy * tip_dist)
        far = (center[0] + ux * width * 2, center[1] + uy * width * 2)
        half_w = 0.35 * major
        px, py = -uy, ux
        poly = np.array(
            [
                (tip[0] + px * half_w, tip[1] + py * half_w),
                (far[0] + px * half_w, far[1] + py * half_w),
                (far[0] - px * half_w, far[1] - py * half_w),
                (tip[0] - px * half_w, tip[1] - py * half_w),
            ]
        )
        cv2.fillPoly(hi, [np.round((poly * s + (s - 1) / 2) * _ONE).astype(np.int32)], SKIN_BGR, cv2.LINE_AA, _SHIFT)
        _ellipse(hi, s, tip, (2 * half_w, 2 * half_w), 0, SKIN_BGR)

    img = cv2.resize(hi, (width, height), interpolation=cv2.INTER_AREA).astype(np.float64)

    # Gentle illumination gradient.
    yy, xx = np.mgrid[0:height, 0:width]
    img *= (0.92 + 0.08 * (xx / width))[:, :, None]
    # Specular glare saturates the sensor, so it is composited after shading.
    glare = cv2.resize(glare_hi, (width, height), interpolation=cv2.INTER_AREA).astype(np.float64)[:, :, None] / 255
    img = img * (1 - glare) + 255.0 * glare
    if blur_sigma > 0:
        img = cv2.GaussianBlur(img, (0, 0), blur_sigma)
    if noise_sigma > 0:
        img += rng.normal(0, noise_sigma, img.shape)
    out = np.clip(np.round(img), 0, 255).astype(np.uint8)
    return out, SceneTruth(center[0], center[1], major, minor, major_angle_deg % 180.0)


# --------------------------------------------------------------------------- #
# Synthetic hands (landmark geometry only)
# --------------------------------------------------------------------------- #

# Canonical flat right hand in the palm plane, millimetres, wrist landmark at the origin,
# fingers pointing towards -y. Hand length (landmark 0 -> 12) is exactly 185 mm.
CANONICAL_HAND_MM = np.array(
    [
        (0.0, 0.0),
        (22.0, -25.0), (40.0, -45.0), (55.0, -62.0), (66.0, -78.0),
        (30.0, -90.0), (33.0, -130.0), (35.0, -152.0), (36.0, -172.0),
        (8.0, -85.0), (8.0, -130.0), (8.0, -157.0), (8.0, -math.sqrt(185.0**2 - 64.0)),
        (-13.0, -82.0), (-15.0, -122.0), (-16.0, -146.0), (-17.0, -166.0),
        (-32.0, -74.0), (-36.0, -104.0), (-38.0, -122.0), (-40.0, -139.0),
    ]
)  # fmt: skip
CANONICAL_HAND_LENGTH_MM = 185.0


def palm_centre_mm(points_mm: np.ndarray) -> np.ndarray:
    return points_mm[[0, 5, 9, 13, 17]].mean(axis=0)


def synthetic_frame(
    hand_length_mm: float = 185.0,
    px_per_mm: float = 3.2,
    image_size: tuple[int, int] = (720, 1280),
    rotation_deg: float = 0.0,
    tilt_deg: float = 0.0,
    tilt_axis_deg: float = 0.0,
    coin_diameter_mm: float = 24.26,
    coin_scale_factor: float = 1.0,
    landmark_noise_px: float = 0.0,
    mirror: bool = False,
    rng: np.random.Generator | None = None,
    coin_overrides: dict | None = None,
) -> dict:
    """A ``FrameObservation``-shaped dict for a flat hand with exactly known dimensions.

    ``px_per_mm`` is the scale of the landmark layer. ``coin_scale_factor`` sets the coin's
    pixel scale relative to it (``1 / depth_factor`` reproduces the depth model). The hand
    is tilted by ``tilt_deg`` about an in-plane axis at ``tilt_axis_deg``, foreshortening
    both the hand and the coin under weak perspective.
    """
    rng = rng or np.random.default_rng(0)
    w, h = image_size
    pts = CANONICAL_HAND_MM * (hand_length_mm / CANONICAL_HAND_LENGTH_MM)
    if mirror:
        pts = pts * np.array([-1.0, 1.0])
    centre = palm_centre_mm(pts)
    pts = pts - centre

    th = math.radians(rotation_deg)
    rot = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
    pts = pts @ rot.T

    # Foreshortening along the direction perpendicular to the tilt axis.
    a = math.radians(tilt_axis_deg)
    u = np.array([math.cos(a), math.sin(a)])
    v = np.array([-math.sin(a), math.cos(a)])
    c = math.cos(math.radians(tilt_deg))
    fs = np.outer(u, u) + c * np.outer(v, v)
    pts = pts @ fs.T

    img_centre = np.array([w / 2, h * 0.55])
    px = pts * px_per_mm + img_centre
    if landmark_noise_px > 0:
        px = px + rng.normal(0, landmark_noise_px, px.shape)

    coin_d_px = coin_diameter_mm * px_per_mm * coin_scale_factor
    coin = {
        "center_x": float(img_centre[0]),
        "center_y": float(img_centre[1]),
        "major_axis_px": coin_d_px,
        "minor_axis_px": coin_d_px * c,
        "angle_deg": math.degrees(a) % 180.0,
        "edge_support": 0.97,
        "max_angular_gap_deg": 10.0,
        "fit_residual_px": 0.25,
        "edge_width_px": 2.3,
        "glare_fraction": 0.0,
        "contrast": 0.3,
        "n_edge_points": 140,
        "confidence": 0.95,
        "accepted": True,
        "method": "synthetic",
        "reasons": [],
    }
    coin.update(coin_overrides or {})
    return {
        "timestamp_ms": 0.0,
        "image_width": w,
        "image_height": h,
        "landmarks": [{"x": float(x), "y": float(y), "z": 0.0} for x, y in px],
        "world_landmarks": None,
        "handedness": None,
        "handedness_score": None,
        "coin": coin,
        "brightness": 140.0,
    }
