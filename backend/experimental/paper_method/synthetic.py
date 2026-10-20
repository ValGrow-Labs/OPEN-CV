"""SYNTHETIC scenes for the paper method: a pinhole camera photographing a sheet of paper with a
simplified flat hand on it. Used by tests and the study script; these images are not real data.

World frame: X right and Y down along the sheet (portrait, wrist on the bottom edge Y = H),
Z = height above the sheet. The hand outline is drawn at a chosen height (fingers / palm), so
the effect of hand thickness on a top-down photo can be studied.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

SHEETS = {"a4": (210.0, 297.0), "letter": (215.9, 279.4)}


@dataclass
class PaperScene:
    sheet: str = "a4"
    sheet_size_mm: tuple[float, float] | None = None  # override the physical sheet (e.g. a wrong selection)
    image_size: tuple[int, int] = (1600, 1200)  # (w, h); the sheet's long side runs along the image width
    hfov_deg: float = 65.0  # along the long image side
    camera_distance_mm: float = 380.0  # from the camera to the look-at point
    tilt_deg: float = 0.0
    tilt_azimuth_deg: float = 0.0
    roll_deg: float = 90.0  # 90: portrait sheet along the landscape image width
    target_mm: tuple[float, float] | None = None  # look-at point on the sheet (default: centre)
    hand_length_mm: float = 185.0
    breadth_mm: float = 84.0
    wrist_width_mm: float = 58.0
    crease_offset_mm: float = 0.0  # crease placed this far inside the sheet edge (misalignment)
    hand_rotation_deg: float = 0.0
    hand_dx_mm: float = 0.0
    finger_height_mm: float = 0.0
    palm_height_mm: float = 0.0
    thumb_adducted: bool = False  # thumb against the palm (protocol: spread away)
    skin_bgr: tuple[int, int, int] = (120, 150, 200)
    background_bgr: tuple[int, int, int] = (70, 62, 55)
    paper_bgr: tuple[int, int, int] = (236, 238, 240)
    shadow: bool = True
    light_gradient: float = 0.15
    k1: float = 0.0  # radial lens distortion (applied to densified outlines)
    blur_px: float = 0.7
    noise: float = 1.5
    supersample: int = 2
    seed: int = 0

    @property
    def size_mm(self) -> tuple[float, float]:
        return self.sheet_size_mm or SHEETS[self.sheet]

    @property
    def palm_length_mm(self) -> float:
        return 0.57 * self.hand_length_mm  # crease to the metacarpal level used by the model


class Camera:
    def __init__(self, s: PaperScene):
        w, h = s.image_size
        self.f = (max(w, h) / 2) / math.tan(math.radians(s.hfov_deg) / 2)
        self.c = np.array([w / 2, h / 2])
        sw, sh = s.size_mm
        t = np.array([*(s.target_mm or (sw / 2, sh / 2)), 0.0])
        tl, az = math.radians(s.tilt_deg), math.radians(s.tilt_azimuth_deg)
        self.centre = t + s.camera_distance_mm * np.array(
            [math.sin(tl) * math.cos(az), math.sin(tl) * math.sin(az), math.cos(tl)]
        )
        z = (t - self.centre) / np.linalg.norm(t - self.centre)
        y = np.array([0.0, 1.0, 0.0]) - z[1] * z
        y /= np.linalg.norm(y)
        x = np.cross(z, y)
        r = math.radians(s.roll_deg)
        self.x, self.y = math.cos(r) * x + math.sin(r) * y, -math.sin(r) * x + math.cos(r) * y
        self.z, self.k1 = z, s.k1
        self.half_diag = 0.5 * math.hypot(w, h)

    def project(self, pts: np.ndarray) -> np.ndarray:
        d = pts - self.centre
        uv = self.f * np.column_stack([d @ self.x, d @ self.y]) / (d @ self.z)[:, None] + self.c
        if self.k1:
            rr = np.linalg.norm(uv - self.c, axis=1, keepdims=True) / self.half_diag
            uv = self.c + (uv - self.c) * (1 + self.k1 * rr**2)
        return uv


def _densify(poly: np.ndarray, step: float = 2.0) -> np.ndarray:
    out = []
    for a, b in zip(poly, np.roll(poly, -1, axis=0), strict=True):
        n = max(1, int(np.linalg.norm(b - a) / step))
        out.extend(a + (b - a) * t for t in np.linspace(0, 1, n, endpoint=False))
    return np.array(out)


def _capsule(base: np.ndarray, direction: np.ndarray, length: float, width: float) -> np.ndarray:
    """Finger: straight sides and a round tip; ``length`` from base to the tip's extreme point."""
    u = direction / np.linalg.norm(direction)
    v = np.array([-u[1], u[0]])
    r = width / 2
    end = base + (length - r) * u
    arc = [end + r * (math.cos(a) * v + math.sin(a) * u) for a in np.linspace(0, math.pi, 25)]
    return np.array([base + r * v, *arc, base - r * v])


def hand_polygons(s: PaperScene) -> list[tuple[np.ndarray, float]]:
    """(polygon in sheet mm, height) for forearm, palm, thumb and fingers."""
    sw, sh = s.size_mm
    big_l, b, ww, pl = s.hand_length_mm, s.breadth_mm, s.wrist_width_mm, s.palm_length_mm
    rot = math.radians(s.hand_rotation_deg)
    origin = np.array([sw / 2 + s.hand_dx_mm, sh - s.crease_offset_mm])
    up = np.array([math.sin(rot), -math.cos(rot)])  # towards the fingertips
    across = np.array([-up[1], up[0]])

    def to_sheet(local: np.ndarray) -> np.ndarray:  # local (a across, b along) -> sheet
        local = np.atleast_2d(local)
        return origin + local[:, :1] * across + local[:, 1:2] * up

    polys = []
    forearm = np.array([[-ww / 2 - 2, -200], [ww / 2 + 2, -200], [ww / 2, 0], [-ww / 2, 0]])
    # The palm runs ~15 mm past the metacarpal heads to the finger webs, as in real hands.
    palm = np.array(
        [[-ww / 2, -12], [ww / 2, -12], [b / 2, 0.45 * pl], [b / 2, pl + 15], [-b / 2, pl + 15], [-b / 2, 0.45 * pl]]
    )
    polys += [(to_sheet(forearm), s.palm_height_mm), (to_sheet(palm), s.palm_height_mm)]
    if s.thumb_adducted:
        # Lying along the index side of the palm, past the metacarpal level.
        thumb = _capsule(np.array([-b / 2 - 6, 0.35 * pl]), np.array([0.0, 1.0]), 0.45 * big_l, 0.12 * big_l)
    else:
        thumb = _capsule(np.array([-b / 2 + 8, 0.30 * pl]), np.array([-1.0, 0.85]), 0.33 * big_l, 0.12 * big_l)
    polys.append((to_sheet(thumb), s.palm_height_mm))
    widths = np.array([0.255, 0.265, 0.25, 0.23]) * b
    widths *= b / widths.sum()
    tips = [big_l - 7, big_l, big_l - 5, big_l - 21]  # index, middle, ring, little
    a = -b / 2
    for wdt, tip in zip(widths, tips, strict=True):
        base = np.array([a + wdt / 2, pl + 12])
        polys.append((to_sheet(_capsule(base, np.array([0.0, 1.0]), tip - base[1], wdt)), s.finger_height_mm))
        a += wdt
    return polys


def mcp_landmarks_mm(s: PaperScene) -> np.ndarray:
    """Where MediaPipe's index (5) and little-finger (17) MCP landmarks would be, in sheet mm."""
    widths = np.array([0.255, 0.265, 0.25, 0.23]) * s.breadth_mm
    widths *= s.breadth_mm / widths.sum()
    a5, a17 = -s.breadth_mm / 2 + widths[0] / 2, s.breadth_mm / 2 - widths[3] / 2
    rot = math.radians(s.hand_rotation_deg)
    origin = np.array([s.size_mm[0] / 2 + s.hand_dx_mm, s.size_mm[1] - s.crease_offset_mm])
    up = np.array([math.sin(rot), -math.cos(rot)])
    across = np.array([-up[1], up[0]])
    return np.array([origin + a * across + s.palm_length_mm * up for a in (a5, a17)])


def render(s: PaperScene) -> tuple[np.ndarray, Camera]:
    rng = np.random.default_rng(s.seed)
    cam = Camera(s)
    ss = s.supersample
    w, h = s.image_size
    img = np.empty((h * ss, w * ss, 3), np.float32)
    img[:] = s.background_bgr

    def to_canvas(uv: np.ndarray) -> np.ndarray:
        # Pixel centres: output pixel i covers canvas pixels ss*i .. ss*i + ss - 1 (INTER_AREA).
        return np.round((uv * ss + (ss - 1) / 2) * 16).astype(np.int32)

    def fill(poly_mm: np.ndarray, height: float, colour) -> None:
        pts = _densify(poly_mm)
        uv = cam.project(np.column_stack([pts, np.full(len(pts), height)]))
        cv2.fillPoly(img, [to_canvas(uv)], colour, lineType=cv2.LINE_AA, shift=4)

    sw, sh = s.size_mm
    fill(np.array([[0, 0], [sw, 0], [sw, sh], [0, sh]], float), 0.0, s.paper_bgr)
    polys = hand_polygons(s)
    if s.shadow:  # soft and smooth, so it is drawn and blurred at output resolution (fast)
        shade = np.zeros((h, w), np.float32)
        for poly, _ in polys:
            pts = _densify(poly + np.array([4.0, 3.0]))
            uv = cam.project(np.column_stack([pts, np.zeros(len(pts))]))
            cv2.fillPoly(shade, [np.round(uv * 16).astype(np.int32)], 1.0, lineType=cv2.LINE_AA, shift=4)
        shade = cv2.resize(cv2.GaussianBlur(shade, (0, 0), 6), (w * ss, h * ss), interpolation=cv2.INTER_LINEAR)
        img *= (1 - 0.22 * shade)[..., None]
    for poly, height in polys:
        fill(poly, height, s.skin_bgr)
    small = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
    small *= (1 - s.light_gradient * np.linspace(0, 1, w, dtype=np.float32))[None, :, None]
    if s.blur_px > 0:
        small = cv2.GaussianBlur(small, (0, 0), s.blur_px)
    small += rng.normal(0, s.noise, small.shape).astype(np.float32)
    return np.clip(small, 0, 255).astype(np.uint8), cam


def mcp_landmarks_px(s: PaperScene, cam: Camera) -> np.ndarray:
    pts = mcp_landmarks_mm(s)
    return cam.project(np.column_stack([pts, np.full(2, s.palm_height_mm)]))
