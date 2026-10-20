"""Reference coin detector (OpenCV).

Pipeline
--------
1. Grayscale + CLAHE contrast normalisation + Gaussian blur.
2. Candidate generation by two independent methods:
   * contour method: Canny edges -> closed contours -> convex-hull circularity -> ``fitEllipse``;
   * Hough method: ``HoughCircles`` (HOUGH_GRADIENT).
3. Every candidate is refined by *radial edge search*: along ``radial_rays`` rays from the
   candidate centre, the intensity profile of the (lightly smoothed, non-CLAHE) image is
   sampled and the strongest intensity step near the expected radius is located with
   sub-pixel (parabolic) precision. An ellipse is fitted to these edge points with MAD-based
   outlier rejection, then the search is repeated in a narrow band around the fit.
4. Quality metrics are computed from the refined boundary: edge support (fraction of rays
   with a consistent edge), largest angular gap (occlusion), fit residual (irregular boundary),
   edge width (blur), glare fraction and coin/skin contrast. These feed hard acceptance gates
   and a heuristic confidence score in [0, 1]. The confidence is a detection-quality score,
   *not* a probability.

The browser implementation in ``frontend/src/vision/coinDetector.ts`` mirrors this
algorithm and its parameters (``config/measurement.json``); parity is checked by
``frontend/src/vision/coinDetector.parity.test.ts`` against fixtures generated here.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import cv2
import numpy as np

from .config import CoinDetectionParams

# Reason codes. Customer-facing text lives in ``issues.py``.
NO_CANDIDATE = "coin_not_found"
TOO_SMALL = "coin_too_small"
OCCLUDED = "coin_occluded"
BLURRY = "coin_blurry"
GLARE = "coin_glare"
LOW_CONTRAST = "coin_low_contrast"
IRREGULAR = "coin_irregular_boundary"
LOW_CONFIDENCE = "coin_low_confidence"
AMBIGUOUS = "coin_ambiguous"


@dataclass
class Candidate:
    cx: float
    cy: float
    major: float  # full axis length, px
    minor: float
    angle_deg: float  # orientation of the major axis
    method: str


@dataclass
class CoinDetection:
    found: bool
    accepted: bool
    center_x: float = 0.0
    center_y: float = 0.0
    major_axis_px: float = 0.0
    minor_axis_px: float = 0.0
    angle_deg: float = 0.0
    edge_support: float = 0.0
    max_angular_gap_deg: float = 360.0
    fit_residual_px: float = math.inf
    edge_width_px: float = math.inf
    glare_fraction: float = 0.0
    contrast: float = 0.0
    n_edge_points: int = 0
    confidence: float = 0.0
    method: str = ""
    reasons: list[str] = field(default_factory=list)
    candidates: list[dict] = field(default_factory=list)

    @property
    def axis_ratio(self) -> float:
        return self.minor_axis_px / self.major_axis_px if self.major_axis_px > 0 else 0.0

    def to_observation(self) -> dict:
        """Numeric observation as sent by the browser to ``/api/scan`` (see schemas.CoinObservation)."""
        d = asdict(self)
        for k in ("found", "candidates"):
            d.pop(k)
        # JSON has no infinity; an unusable fit is reported as a very large (failing) value.
        for k in ("fit_residual_px", "edge_width_px"):
            d[k] = min(d[k], 1e3)
        return d


# --------------------------------------------------------------------------- #
# Helpers shared with the TypeScript port
# --------------------------------------------------------------------------- #


def to_gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image
    if image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


CHROMA_GAIN = 3.0


def chroma_channel(image_bgr: np.ndarray) -> np.ndarray:
    """Signed normalised warm chroma ``(R - B) / (R + G + B)``, mapped to uint8 around 128.

    Silver (cupronickel) coins are nearly achromatic while skin of every tone is warm
    (R > B), so this channel has a strong step exactly at the coin's *outer* boundary and
    is largely invariant to shading. In grayscale, by contrast, the coin's raised rim
    often produces a stronger edge than the coin/skin boundary.

    The channel is signed (128 = neutral) so a coin that looks slightly blue under cool
    light is not clipped to zero; clipping flattened the inner side of the edge and pushed
    the detected boundary outwards (a 1.3% scale error in tests with a cool white balance).
    """
    f = image_bgr[:, :, :3].astype(np.float32)
    b, g, r = f[:, :, 0], f[:, :, 1], f[:, :, 2]
    c = (r - b) / (r + g + b + 30.0)
    return np.clip(c * CHROMA_GAIN * 127.5 + 128.0, 0, 255).astype(np.uint8)


def ramp(value: float, good: float, bad: float) -> float:
    """Linear score: 1 at ``good``, 0 at ``bad`` (works for either direction)."""
    if good == bad:
        return 1.0 if value == good else 0.0
    t = (value - bad) / (good - bad)
    return float(min(1.0, max(0.0, t)))


def ellipse_radius(phi: np.ndarray, major: float, minor: float, angle_deg: float) -> np.ndarray:
    """Distance from the ellipse centre to its boundary in direction ``phi`` (radians)."""
    a, b = major / 2.0, minor / 2.0
    t = phi - math.radians(angle_deg)
    return (a * b) / np.sqrt((b * np.cos(t)) ** 2 + (a * np.sin(t)) ** 2)


def bilinear(img: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Bilinear samples of ``img`` at (xs, ys); returns (values, valid_mask)."""
    h, w = img.shape
    valid = (xs >= 0) & (ys >= 0) & (xs <= w - 1) & (ys <= h - 1)
    x = np.clip(xs, 0, w - 1.000001)
    y = np.clip(ys, 0, h - 1.000001)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx, fy = x - x0, y - y0
    v00 = img[y0, x0]
    v01 = img[y0, x0 + 1]
    v10 = img[y0 + 1, x0]
    v11 = img[y0 + 1, x0 + 1]
    vals = (v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy
    return vals, valid


def fit_ellipse(points: np.ndarray) -> Candidate | None:
    if len(points) < 6:
        return None
    (cx, cy), (w, h), ang = cv2.fitEllipse(points.astype(np.float32))
    if not (np.isfinite(w) and np.isfinite(h)) or w <= 0 or h <= 0:
        return None
    if w >= h:
        return Candidate(cx, cy, w, h, ang % 180.0, "")
    return Candidate(cx, cy, h, w, (ang + 90.0) % 180.0, "")


# --------------------------------------------------------------------------- #
# Candidate generation
# --------------------------------------------------------------------------- #


def _contour_candidates(blurred: np.ndarray, p: CoinDetectionParams, d_min: float, d_max: float) -> list[Candidate]:
    edges = cv2.Canny(blurred, p.canny_high * p.canny_low_ratio, p.canny_high)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    out: list[Candidate] = []
    for c in contours:
        if len(c) < 0.5 * math.pi * d_min:
            continue
        hull = cv2.convexHull(c)
        area = cv2.contourArea(hull)
        perim = cv2.arcLength(hull, True)
        if area <= 0 or perim <= 0:
            continue
        eq_d = 2.0 * math.sqrt(area / math.pi)
        if eq_d < d_min or eq_d > d_max:
            continue
        if 4.0 * math.pi * area / perim**2 < p.min_contour_circularity:
            continue
        cand = fit_ellipse(c.reshape(-1, 2))
        if cand is None or cand.minor / cand.major < p.min_axis_ratio:
            continue
        if not d_min <= cand.major <= d_max:
            continue
        cand.method = "contour"
        out.append(cand)
    return out


def _hough_candidates(blurred: np.ndarray, p: CoinDetectionParams, d_min: float, d_max: float) -> list[Candidate]:
    circles = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp=p.hough_dp,
        minDist=max(d_min, 1.0),
        param1=p.canny_high,
        param2=p.hough_param2,
        minRadius=max(1, int(math.floor(d_min / 2))),
        maxRadius=int(math.ceil(d_max / 2)),
    )
    if circles is None:
        return []
    return [Candidate(float(x), float(y), 2 * float(r), 2 * float(r), 0.0, "hough") for x, y, r in circles[0]]


def _segmentation_candidates(chroma: np.ndarray, p: CoinDetectionParams, d_min: float, d_max: float) -> list[Candidate]:
    """Low-chroma (achromatic) blobs from an Otsu threshold of the chroma channel."""
    k = p.blur_kernel
    blurred = cv2.GaussianBlur(chroma, (k, k), 0)
    _, mask = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out: list[Candidate] = []
    for c in contours:
        if len(c) < 0.5 * math.pi * d_min:
            continue
        hull = cv2.convexHull(c)
        area = cv2.contourArea(hull)
        perim = cv2.arcLength(hull, True)
        if area <= 0 or perim <= 0:
            continue
        eq_d = 2.0 * math.sqrt(area / math.pi)
        if eq_d < d_min or eq_d > d_max or 4.0 * math.pi * area / perim**2 < p.min_contour_circularity:
            continue
        cand = fit_ellipse(hull.reshape(-1, 2))
        if cand is None or cand.minor / cand.major < p.min_axis_ratio:
            continue
        cand.method = "segmentation"
        out.append(cand)
    return out


def _dedupe(cands: list[Candidate]) -> list[Candidate]:
    kept: list[Candidate] = []
    for c in cands:
        dup = False
        for k in kept:
            r = max(k.major, c.major) / 2
            if math.hypot(k.cx - c.cx, k.cy - c.cy) < 0.2 * r and abs(k.major - c.major) < 0.15 * k.major:
                if c.method not in k.method:
                    k.method = f"{k.method}+{c.method}"
                dup = True
                break
        if not dup:
            kept.append(c)
    return kept


# --------------------------------------------------------------------------- #
# Radial refinement
# --------------------------------------------------------------------------- #


@dataclass
class _EdgeScan:
    points: np.ndarray  # (n, 2) accepted edge points
    angles: np.ndarray  # (n,) ray angles of accepted points
    strengths: np.ndarray  # (n,) |dI/dr| at accepted points
    all_strengths: np.ndarray  # (K,) strongest |dI/dr| per in-bounds ray


def _radial_scan(
    img: np.ndarray, cand: Candidate, p: CoinDetectionParams, search_fraction: float, polarity: float | None
) -> _EdgeScan:
    """Locate the boundary along rays; ``polarity`` +1 means intensity increases outwards
    (None = use the majority polarity)."""
    k = p.radial_rays
    phis = np.arange(k) * (2.0 * math.pi / k)
    r_exp = ellipse_radius(phis, cand.major, cand.minor, cand.angle_deg)
    step = p.radial_step_px
    n_steps = max(5, int(math.ceil(2 * search_fraction * r_exp.max() / step)) + 1)
    t = np.linspace(-1.0, 1.0, n_steps)
    radii = r_exp[:, None] * (1.0 + search_fraction * t[None, :])  # (K, M)
    xs = cand.cx + radii * np.cos(phis)[:, None]
    ys = cand.cy + radii * np.sin(phis)[:, None]
    vals, valid = bilinear(img, xs, ys)
    ray_ok = valid.all(axis=1)

    dr = radii[:, 2:] - radii[:, :-2]
    deriv = (vals[:, 2:] - vals[:, :-2]) / dr  # central difference, (K, M-2)
    absd = np.abs(deriv) if polarity is None else np.maximum(deriv * polarity, 0.0)
    idx = np.argmax(absd, axis=1)
    rows = np.arange(k)
    strength = absd[rows, idx]
    sign = np.sign(deriv[rows, idx])

    # Sub-pixel peak position by parabola through the neighbouring samples.
    i_c = np.clip(idx, 1, absd.shape[1] - 2)
    a, b, c = absd[rows, i_c - 1], absd[rows, i_c], absd[rows, i_c + 1]
    denom = a - 2 * b + c
    delta = np.divide(0.5 * (a - c), denom, out=np.zeros_like(denom), where=np.abs(denom) > 1e-9)
    delta = np.where((idx >= 1) & (idx <= absd.shape[1] - 2), np.clip(delta, -0.5, 0.5), 0.0)
    r_step = radii[rows, 1] - radii[rows, 0]
    r_edge = radii[rows, idx + 1] + delta * r_step

    in_bounds_strength = strength[ray_ok]
    thresh = p.edge_strength_min
    if in_bounds_strength.size:
        thresh = max(thresh, p.edge_strength_rel * float(np.median(in_bounds_strength)))
    # A peak at the window boundary means the real edge lies outside the window.
    ok = ray_ok & (strength >= thresh) & (idx > 0) & (idx < absd.shape[1] - 1)
    # Keep only one edge polarity (coin consistently darker or brighter than skin).
    if polarity is None and ok.any():
        polarity = 1.0 if (sign[ok] > 0).sum() >= (sign[ok] < 0).sum() else -1.0
    if polarity is not None:
        ok &= sign == polarity
    pts = np.stack([cand.cx + r_edge * np.cos(phis), cand.cy + r_edge * np.sin(phis)], axis=1)
    return _EdgeScan(pts[ok], phis[ok], strength[ok], in_bounds_strength)


def _residuals(points: np.ndarray, e: Candidate) -> np.ndarray:
    d = points - np.array([e.cx, e.cy])
    r = np.hypot(d[:, 0], d[:, 1])
    phi = np.arctan2(d[:, 1], d[:, 0])
    return np.abs(r - ellipse_radius(phi, e.major, e.minor, e.angle_deg))


def _robust_fit(scan: _EdgeScan, k_mad: float) -> tuple[Candidate | None, np.ndarray]:
    mask = np.ones(len(scan.points), dtype=bool)
    fit = None
    for _ in range(3):
        fit = fit_ellipse(scan.points[mask])
        if fit is None:
            return None, mask
        res = _residuals(scan.points, fit)
        mad = float(np.median(np.abs(res[mask] - np.median(res[mask]))))
        limit = max(k_mad * 1.4826 * mad + float(np.median(res[mask])), 0.5)
        new_mask = res <= limit
        if new_mask.sum() < 6 or np.array_equal(new_mask, mask):
            break
        mask = new_mask
    return fit_ellipse(scan.points[mask]) if mask.sum() >= 6 else None, mask


def _max_gap_deg(angles: np.ndarray) -> float:
    if angles.size < 2:
        return 360.0
    a = np.sort(np.mod(angles, 2 * math.pi))
    gaps = np.diff(np.concatenate([a, [a[0] + 2 * math.pi]]))
    return float(np.degrees(gaps.max()))


def _ring_median(img: np.ndarray, e: Candidate, scale: float, rays: int) -> float:
    phis = np.arange(rays) * (2.0 * math.pi / rays)
    r = ellipse_radius(phis, e.major, e.minor, e.angle_deg) * scale
    vals, valid = bilinear(img, e.cx + r * np.cos(phis), e.cy + r * np.sin(phis))
    return float(np.median(vals[valid])) if valid.any() else float("nan")


def _refine(
    img: np.ndarray, raw: np.ndarray, cand: Candidate, p: CoinDetectionParams, polarity: float | None
) -> CoinDetection | None:
    """``img`` is the float channel used for edge localisation; ``raw`` the uint8 gray ROI (glare)."""
    scan = _radial_scan(img, cand, p, p.radial_search_fraction, polarity)
    fit, _ = _robust_fit(scan, p.outlier_mad_k)
    if fit is None:
        return None
    # Second, narrow pass around the first fit.
    scan = _radial_scan(img, fit, p, min(p.narrow_search_fraction, p.radial_search_fraction), polarity)
    fit2, mask = _robust_fit(scan, p.outlier_mad_k)
    if fit2 is None:
        return None
    pts, angles, strengths = scan.points[mask], scan.angles[mask], scan.strengths[mask]
    res = _residuals(pts, fit2)

    contrast_gl = abs(_ring_median(img, fit2, 0.8, p.radial_rays) - _ring_median(img, fit2, 1.2, p.radial_rays))
    med_strength = float(np.median(strengths)) if strengths.size else 0.0
    edge_width = contrast_gl / med_strength if med_strength > 0 else math.inf

    mask_img = np.zeros(raw.shape, np.uint8)
    cv2.ellipse(
        mask_img,
        ((fit2.cx, fit2.cy), (fit2.major * 0.95, fit2.minor * 0.95), fit2.angle_deg),
        255,
        -1,
    )
    inside = raw[mask_img > 0]
    glare = float((inside >= p.glare_level).mean()) if inside.size else 0.0

    return CoinDetection(
        found=True,
        accepted=False,
        center_x=fit2.cx,
        center_y=fit2.cy,
        major_axis_px=fit2.major,
        minor_axis_px=fit2.minor,
        angle_deg=fit2.angle_deg,
        edge_support=len(pts) / p.radial_rays,
        max_angular_gap_deg=_max_gap_deg(angles),
        fit_residual_px=float(np.sqrt(np.mean(res**2))) if res.size else math.inf,
        edge_width_px=float(edge_width),
        glare_fraction=glare,
        contrast=float(contrast_gl / 255.0),
        n_edge_points=int(len(pts)),
        method=cand.method,
    )


def score_detection(det: CoinDetection, p: CoinDetectionParams) -> None:
    """Fill ``confidence``, ``accepted`` and ``reasons`` from the quality metrics."""
    acc, sc = p.accept, p.score
    resid_limit = max(acc.max_fit_residual_px, acc.max_fit_residual_rel * det.major_axis_px / 2)
    scores = [
        ramp(det.edge_support, sc.edge_support_good, sc.edge_support_bad),
        ramp(det.max_angular_gap_deg, sc.angular_gap_good_deg, acc.max_angular_gap_deg * sc.angular_gap_bad_factor),
        ramp(det.fit_residual_px, sc.fit_residual_good_px, resid_limit * sc.fit_residual_bad_factor),
        ramp(det.edge_width_px, sc.edge_width_good_px, acc.max_edge_width_px * sc.edge_width_bad_factor),
        ramp(det.glare_fraction, sc.glare_good, acc.max_glare_fraction * sc.glare_bad_factor),
        ramp(det.contrast, sc.contrast_good, acc.min_contrast * sc.contrast_bad_factor),
    ]
    det.confidence = float(np.prod(np.clip(scores, 1e-3, 1.0)) ** (1.0 / len(scores)))

    reasons: list[str] = []
    if det.major_axis_px < p.min_diameter_px:
        reasons.append(TOO_SMALL)
    if det.edge_support < acc.min_edge_support or det.max_angular_gap_deg > acc.max_angular_gap_deg:
        reasons.append(OCCLUDED)
    if det.fit_residual_px > resid_limit:
        reasons.append(IRREGULAR)
    if det.edge_width_px > acc.max_edge_width_px:
        reasons.append(BLURRY)
    if det.glare_fraction > acc.max_glare_fraction:
        reasons.append(GLARE)
    if det.contrast < acc.min_contrast:
        reasons.append(LOW_CONTRAST)
    if det.confidence < acc.min_confidence and not reasons:
        reasons.append(LOW_CONFIDENCE)
    det.reasons = reasons
    det.accepted = not reasons


def _has_rival(best: CoinDetection, others: list[CoinDetection], p: CoinDetectionParams) -> bool:
    """True when a *different* coin-like circle is almost as convincing as the best one
    (e.g. two coins, or a round button next to the coin). Refinements of the same coin
    converge to the same centre and are ignored."""
    for d in others:
        if not d.accepted:
            continue
        separation = math.hypot(d.center_x - best.center_x, d.center_y - best.center_y)
        if separation > 0.5 * best.major_axis_px and d.confidence >= p.ambiguity_confidence_ratio * best.confidence:
            return True
    return False


def detect_coin(
    image: np.ndarray,
    params: CoinDetectionParams,
    roi: tuple[int, int, int, int] | None = None,
    diameter_range_px: tuple[float, float] | None = None,
) -> CoinDetection:
    """Detect a single circular reference coin.

    ``roi`` is ``(x, y, w, h)`` in image pixels (e.g. a window around the palm centre);
    returned coordinates are always in full-image pixels.
    """
    gray_full = to_gray(image)
    h_img, w_img = gray_full.shape
    if roi is None:
        x0, y0, w, h = 0, 0, w_img, h_img
    else:
        x0 = max(0, int(roi[0]))
        y0 = max(0, int(roi[1]))
        w = min(w_img - x0, int(roi[2]))
        h = min(h_img - y0, int(roi[3]))
    if w < 8 or h < 8:
        return CoinDetection(found=False, accepted=False, reasons=[NO_CANDIDATE])
    raw = gray_full[y0 : y0 + h, x0 : x0 + w]
    is_color = image.ndim == 3 and image.shape[2] >= 3
    chroma = chroma_channel(image[y0 : y0 + h, x0 : x0 + w]) if is_color else None

    d_min = params.min_diameter_px
    d_max = 0.95 * min(w, h)
    if diameter_range_px is not None:
        d_min = max(d_min, diameter_range_px[0])
        d_max = min(d_max, diameter_range_px[1])
    if d_min >= d_max:
        return CoinDetection(found=False, accepted=False, reasons=[TOO_SMALL])

    clahe = cv2.createCLAHE(clipLimit=params.clahe_clip_limit, tileGridSize=(params.clahe_tile_grid,) * 2)
    k = params.blur_kernel
    blurred = cv2.GaussianBlur(clahe.apply(raw), (k, k), 0)
    # Edges are localised on the chroma channel when colour is available (achromatic coin
    # inside -> warm skin outside, so intensity rises outwards); otherwise on gray.
    edge_src, polarity = (chroma, 1.0) if chroma is not None else (raw, None)
    smooth = cv2.GaussianBlur(edge_src, (3, 3), 0).astype(np.float64)

    cands = _contour_candidates(blurred, params, d_min, d_max) + _hough_candidates(blurred, params, d_min, d_max)
    if chroma is not None:
        cands = _segmentation_candidates(chroma, params, d_min, d_max) + cands
    cands = _dedupe(cands)[: params.max_candidates * 2]

    results: list[CoinDetection] = []
    for cand in cands:
        det = _refine(smooth, raw, cand, params, polarity)
        lo_tol, hi_tol = params.candidate_size_tolerance
        if det is None or not (lo_tol * d_min <= det.major_axis_px <= hi_tol * d_max):
            continue
        score_detection(det, params)
        results.append(det)
    if not results:
        return CoinDetection(found=False, accepted=False, reasons=[NO_CANDIDATE])

    results.sort(key=lambda d: (d.accepted, d.confidence), reverse=True)
    best = results[0]
    if best.accepted and _has_rival(best, results[1:], params):
        best.accepted = False
        best.reasons = [AMBIGUOUS]
    best.candidates = [
        {
            "method": d.method,
            "diameter_px": round(d.major_axis_px, 2),
            "axis_ratio": round(d.axis_ratio, 4),
            "confidence": round(d.confidence, 3),
            "accepted": d.accepted,
        }
        for d in results[: params.max_candidates]
    ]
    best.center_x += x0
    best.center_y += y0
    return best
