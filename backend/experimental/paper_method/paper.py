"""Sheet-of-paper detection and plane geometry.

The sheet is the scale reference. Unlike the coin, it is large (most of the image) and the
hand lies on it, so the image-to-sheet homography maps points *on the sheet plane* exactly,
for any camera tilt (pinhole model, no lens distortion). Points above the sheet, such as the
outline of a hand that is 5-25 mm thick, are not on that plane; see measure.height_correction.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from glovesize.coin_detection import bilinear

from .config import PaperDetectionParams, PaperSpec


@dataclass
class EdgeFit:
    point: np.ndarray  # a point on the line (px)
    direction: np.ndarray  # unit direction (px)
    inliers: int
    samples: int
    rms_px: float
    curvature_px: float  # sagitta of a quadratic fitted to the edge (lens distortion / bent sheet indicator)


@dataclass
class PaperDetection:
    corners_px: np.ndarray  # (4, 2) TL, TR, BR, BL in image order
    edges: list[EdgeFit]
    area_fraction: float
    reasons: list[str] = field(default_factory=list)

    @property
    def found(self) -> bool:
        return not self.reasons


def _order_corners(pts: np.ndarray) -> np.ndarray:
    c = pts.mean(axis=0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    pts = pts[np.argsort(ang)]  # clockwise in image coordinates (y down), starting at TL-ish
    start = int(np.argmin(pts.sum(axis=1)))
    return np.roll(pts, -start, axis=0)


def _initial_quad(image_bgr: np.ndarray, p: PaperDetectionParams) -> tuple[np.ndarray | None, float, list[str]]:
    # White paper is bright *and* nearly colourless; skin and most tables are coloured.
    hsv = cv2.cvtColor(cv2.GaussianBlur(image_bgr, (5, 5), 0), cv2.COLOR_BGR2HSV)
    neutral = hsv[:, :, 1] < 45
    if neutral.sum() < 100:
        return None, 0.0, ["paper_not_found"]
    v = hsv[:, :, 2]
    thr, _ = cv2.threshold(v[neutral].reshape(-1, 1), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bright = ((v > max(thr, 120)) & neutral).astype(np.uint8) * 255
    gray = v
    bright = cv2.morphologyEx(bright, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(bright, connectivity=4)
    if n <= 1:
        return None, 0.0, ["paper_not_found"]
    idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    frac = float(stats[idx, cv2.CC_STAT_AREA]) / gray.size
    if frac < p.min_area_fraction:
        return None, frac, ["paper_too_small"]
    contours, _ = cv2.findContours((labels == idx).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    hull = cv2.convexHull(max(contours, key=cv2.contourArea))
    peri = cv2.arcLength(hull, True)
    for eps in (0.01, 0.02, 0.03, 0.05):
        approx = cv2.approxPolyDP(hull, eps * peri, True).reshape(-1, 2).astype(float)
        if len(approx) == 4:
            return _order_corners(approx), frac, []
    return None, frac, ["paper_not_quadrilateral"]


def _fit_line(points: np.ndarray, k_mad: float = 3.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    keep = np.ones(len(points), bool)
    for _ in range(4):
        q = points[keep]
        c = q.mean(axis=0)
        _, _, vt = np.linalg.svd(q - c)
        d = vt[0]
        nrm = np.array([-d[1], d[0]])
        res = (points - c) @ nrm
        mad = float(np.median(np.abs(res[keep] - np.median(res[keep])))) * 1.4826
        keep = np.abs(res) <= max(k_mad * mad, 0.35)
    return c, d, keep


def _refine_edge(
    gray_f: np.ndarray, a: np.ndarray, b: np.ndarray, centre: np.ndarray, p: PaperDetectionParams
) -> EdgeFit | None:
    d = (b - a) / np.linalg.norm(b - a)
    nrm = np.array([-d[1], d[0]])
    if (centre - a) @ nrm > 0:  # outward normal
        nrm = -nrm
    ts = np.linspace(0.04, 0.96, p.edge_samples)
    offs = np.arange(-p.edge_search_px, p.edge_search_px + 0.5, 0.5)
    pts, strengths = [], []
    for t in ts:
        q = a + t * (b - a)
        xs, ys = q[0] + offs * nrm[0], q[1] + offs * nrm[1]
        vals, ok = bilinear(gray_f, xs, ys)
        if not ok.all():
            continue
        g = np.gradient(vals)  # paper (bright) inside -> outside darker: negative step
        i = int(np.argmin(g))
        if 0 < i < len(g) - 1:
            den = g[i - 1] - 2 * g[i] + g[i + 1]
            sub = 0.5 * (g[i - 1] - g[i + 1]) / den if den != 0 else 0.0
        else:
            sub = 0.0
        inside, outside = vals[: len(vals) // 3].mean(), vals[-len(vals) // 3 :].mean()
        pts.append(q + (offs[i] + sub * 0.5) * nrm)
        strengths.append(-g[i] if inside > outside else 0.0)
    if len(pts) < 10:
        return None
    pts_a, s = np.array(pts), np.array(strengths)
    strong = s >= max(0.35 * float(np.median(s)), 2.0)  # weak steps: the wrist or a shadow covers the edge
    if strong.sum() < 10:
        return None
    c, dvec, keep = _fit_line(pts_a[strong])
    inl = pts_a[strong][keep]
    nrm2 = np.array([-dvec[1], dvec[0]])
    u, r = (inl - c) @ dvec, (inl - c) @ nrm2
    rms = float(np.sqrt(np.mean(r**2)))
    coef = np.polyfit(u, r, 2) if len(u) >= 6 else np.zeros(3)
    half = (u.max() - u.min()) / 2
    curvature = float(abs(coef[0]) * half**2)  # sagitta of the quadratic over the edge
    return EdgeFit(c, dvec, int(keep.sum()), p.edge_samples, rms, curvature)


def _intersect(e1: EdgeFit, e2: EdgeFit) -> np.ndarray:
    a = np.column_stack([e1.direction, -e2.direction])
    s = np.linalg.solve(a, e2.point - e1.point)
    return e1.point + s[0] * e1.direction


def detect_paper(image_bgr: np.ndarray, p: PaperDetectionParams) -> PaperDetection:
    gray = cv2.GaussianBlur(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    quad, frac, reasons = _initial_quad(image_bgr, p)
    if quad is None:
        return PaperDetection(np.zeros((4, 2)), [], frac, reasons)
    centre = quad.mean(axis=0)
    gray_f = gray.astype(np.float32)
    edges = []
    for i in range(4):
        e = _refine_edge(gray_f, quad[i], quad[(i + 1) % 4], centre, p)
        if e is None or e.inliers < p.min_edge_inlier_fraction * e.samples:
            return PaperDetection(quad, [], frac, ["paper_edge_unclear"])
        edges.append(e)
    corners = np.array([_intersect(edges[(i - 1) % 4], edges[i]) for i in range(4)])
    return PaperDetection(corners, edges, frac)


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #


@dataclass
class PaperGeometry:
    """Homography between the image and millimetres on the sheet, plus what the rectangle tells
    about the camera. Sheet coordinates: origin at the TL image corner, X along TL->TR."""

    h_img_to_mm: np.ndarray
    h_mm_to_img: np.ndarray
    size_mm: tuple[float, float]  # extent along X, Y
    focal_px: float
    focal_observed: bool  # False: near-frontal view, focal taken from the field-of-view prior
    measured_aspect: float  # long/short side, from the image
    expected_aspect: float
    camera_mm: np.ndarray  # camera centre in sheet coordinates (x, y, height)
    camera_height_range_mm: tuple[float, float]

    def to_mm(self, pts_px: np.ndarray) -> np.ndarray:
        return cv2.perspectiveTransform(np.asarray(pts_px, np.float64).reshape(-1, 1, 2), self.h_img_to_mm).reshape(
            -1, 2
        )

    def to_px(self, pts_mm: np.ndarray) -> np.ndarray:
        return cv2.perspectiveTransform(np.asarray(pts_mm, np.float64).reshape(-1, 1, 2), self.h_mm_to_img).reshape(
            -1, 2
        )

    @property
    def aspect_error(self) -> float:
        return self.measured_aspect / self.expected_aspect - 1.0


def _k(f: float, c: tuple[float, float]) -> np.ndarray:
    return np.array([[f, 0, c[0]], [0, f, c[1]], [0, 0, 1.0]])


def _pose(h: np.ndarray, f: float, c: tuple[float, float]) -> tuple[np.ndarray, float, float]:
    """Camera centre in sheet coordinates for focal f, and the column norms n1, n2."""
    kinv = np.linalg.inv(_k(f, c))
    a1, a2, a3 = (kinv @ h[:, i] for i in range(3))
    n1, n2 = float(np.linalg.norm(a1)), float(np.linalg.norm(a2))
    lam = 2.0 / (n1 + n2)
    if (lam * a3)[2] < 0:
        lam = -lam
    r1, r2, t = lam * a1, lam * a2, lam * a3
    u, _, vt = np.linalg.svd(np.column_stack([r1, r2, np.cross(r1, r2)]))
    r = u @ vt
    cam = -r.T @ t
    return cam, n1, n2


def paper_geometry(
    corners_px: np.ndarray, paper: PaperSpec, image_size: tuple[int, int], hfov_deg: tuple[float, float]
) -> PaperGeometry:
    w_img, h_img = image_size
    top, bottom = np.linalg.norm(corners_px[1] - corners_px[0]), np.linalg.norm(corners_px[2] - corners_px[3])
    left, right = np.linalg.norm(corners_px[3] - corners_px[0]), np.linalg.norm(corners_px[2] - corners_px[1])
    long_side, short_side = max(paper.width_mm, paper.height_mm), min(paper.width_mm, paper.height_mm)
    x_mm, y_mm = (long_side, short_side) if top + bottom > left + right else (short_side, long_side)
    dst = np.array([[0, 0], [x_mm, 0], [x_mm, y_mm], [0, y_mm]], np.float64)
    h_img_to_mm = cv2.getPerspectiveTransform(corners_px.astype(np.float32), dst.astype(np.float32)).astype(np.float64)
    h_mm_to_img = np.linalg.inv(h_img_to_mm)
    h = h_mm_to_img / h_mm_to_img[2, 2]
    c = (w_img / 2.0, h_img / 2.0)

    # Orthogonality of the sheet's sides fixes the focal length when the view is oblique enough:
    # (h1' . h2')/f^2 + h1z h2z = 0 with principal-point-centred columns h'.
    a = [np.array([h[0, i] - c[0] * h[2, i], h[1, i] - c[1] * h[2, i], h[2, i]]) for i in range(2)]
    f_prior = [(max(w_img, h_img) / 2) / math.tan(math.radians(v) / 2) for v in hfov_deg]
    f_lo, f_hi = min(f_prior), max(f_prior)
    den = a[0][2] * a[1][2]
    f2 = -(a[0][0] * a[1][0] + a[0][1] * a[1][1]) / den if den != 0 else -1.0
    # Both vanishing points must be finite: a view that is frontal, or tilted about an axis parallel
    # to a sheet edge, keeps one pair of edges parallel and leaves the focal length undetermined.
    vp = [math.hypot(ai[0], ai[1]) / abs(ai[2]) if ai[2] != 0 else math.inf for ai in a]
    observed = bool(f2 > 0 and max(vp) < 6.0 * f_hi and 0.5 * f_lo <= math.sqrt(f2) <= 2.0 * f_hi)
    f = math.sqrt(f2) if observed else math.sqrt(f_lo * f_hi)

    cam, n1, n2 = _pose(h, f, c)
    measured = (x_mm / y_mm) * (n1 / n2)
    measured_aspect = max(measured, 1 / measured)
    heights = (cam[2], cam[2]) if observed else tuple(sorted(abs(_pose(h, fv, c)[0][2]) for fv in (f_lo, f_hi)))
    return PaperGeometry(
        h_img_to_mm, h_mm_to_img, (x_mm, y_mm), f, observed, measured_aspect, long_side / short_side,
        np.array([cam[0], cam[1], abs(cam[2])]), (float(abs(heights[0])), float(abs(heights[1]))),
    )  # fmt: skip


def edge_curvature_mm(det: PaperDetection, geom: PaperGeometry) -> float:
    """Largest edge sagitta, converted to mm with the local scale of that edge."""
    worst = 0.0
    for i, e in enumerate(det.edges):
        a, b = det.corners_px[i], det.corners_px[(i + 1) % 4]
        mm_per_px = np.linalg.norm(np.subtract(*geom.to_mm(np.array([a, b])))) / max(np.linalg.norm(b - a), 1e-9)
        worst = max(worst, e.curvature_px * mm_per_px)
    return worst
