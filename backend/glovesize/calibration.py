"""Coin-based scale calibration for a single frame.

The coin gives a pixels-per-millimetre scale *at the coin*: ``px_per_mm = major_axis_px / D``.
Using the ellipse's major axis keeps the scale correct when the coin (and the palm it lies
on) is tilted: under weak perspective the axis parallel to the tilt axis is not foreshortened.

Two corrections extend that local scale to the hand landmarks:

* Tilt rectification. The coin's minor/major axis ratio gives the palm-plane tilt
  ``acos(minor/major)``. Landmarks are stretched along the minor-axis direction by
  ``major/minor`` (affine rectification of the palm plane), assuming a flat palm with the
  coin lying flat on it.
* Depth-layer correction. The coin's silhouette is its top face, about ``thickness`` above
  the palm skin, while MediaPipe landmarks are joint centres roughly
  ``landmark_layer_depth_mm`` below the skin. Points farther from the camera look smaller,
  so the landmark-layer scale is ``px_per_mm_coin * Z / (Z + delta)``. Z is estimated from the
  coin's pixel size and an assumed field-of-view range, so the correction carries
  an uncertainty.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from .config import CalibrationParams, MeasurementConfig, ReferenceObjectsConfig, load_measurement_config
from .schemas import CoinObservation, ReferenceSelection


@dataclass(frozen=True)
class ReferenceSpec:
    label: str
    diameter_mm: float
    diameter_uncertainty_mm: float
    thickness_mm: float
    custom: bool


def resolve_reference(
    sel: ReferenceSelection, refs: ReferenceObjectsConfig, cal: CalibrationParams | None = None
) -> ReferenceSpec | None:
    if sel.custom_diameter_mm is not None:
        cal = cal or load_measurement_config().calibration
        return ReferenceSpec(
            label=sel.custom_label or f"Custom reference ({sel.custom_diameter_mm:.2f} mm)",
            diameter_mm=sel.custom_diameter_mm,
            diameter_uncertainty_mm=cal.custom_reference_uncertainty_mm,
            thickness_mm=cal.custom_reference_thickness_mm,
            custom=True,
        )
    obj = refs.get(sel.object_id or "")
    if obj is None or not obj.enabled:
        return None
    if obj.thickness_mm is None:  # not in the coin's specification: use the documented assumption
        thickness = (cal or load_measurement_config().calibration).custom_reference_thickness_mm
    else:
        thickness = obj.thickness_mm
    return ReferenceSpec(obj.label, obj.diameter_mm, obj.diameter_uncertainty_mm, thickness, False)


@dataclass(frozen=True)
class FrameScale:
    px_per_mm: float  # at the landmark layer, after depth correction
    px_per_mm_coin: float
    rel_sigma_random: float
    rel_sigma_systematic: float
    rel_sigma_tilt: float
    rel_sigma_depth: float
    tilt_deg: float
    tilt_corrected: bool
    depth_factor: float
    distance_range_mm: tuple[float, float]
    center: tuple[float, float]
    rectification: np.ndarray  # 2x2, applied about ``center``

    def rectify(self, points: np.ndarray) -> np.ndarray:
        c = np.asarray(self.center)
        return (points[:, :2] - c) @ self.rectification.T + c


def coin_tilt_deg(coin: CoinObservation) -> float:
    ratio = min(1.0, coin.minor_axis_px / coin.major_axis_px)
    return math.degrees(math.acos(ratio))


def _shape_matrix(coin: CoinObservation) -> np.ndarray:
    """The coin ellipse as a 2x2 shape matrix: (major/2)^2 along its axis, (minor/2)^2 across."""
    t = math.radians(coin.angle_deg)
    u = np.array([math.cos(t), math.sin(t)])
    v = np.array([-math.sin(t), math.cos(t)])
    a, b = coin.major_axis_px / 2.0, min(coin.minor_axis_px, coin.major_axis_px) / 2.0
    return a * a * np.outer(u, u) + b * b * np.outer(v, v)


def smoothed_coin_tilts(coins: Sequence[CoinObservation | None], window: int) -> list[float | None]:
    """Coin tilt for each frame, estimated from the average ellipse of the frames around it.

    One frame's tilt is acos(minor / major). For a coin lying flat that ratio is 1 and any edge
    noise can only pull it below 1, so a single frame reads a spurious tilt (a 1% error in the
    ratio reads as about 8 degrees) that averaging the angles cannot remove. Averaging the
    ellipse *shapes* does: noise has no preferred direction, so the mean shape converges to a
    circle, while a really tilted coin keeps one consistent direction and keeps its tilt.
    ``window`` is the number of frames averaged (odd; 1 reproduces the per-frame tilt).
    """
    half = max(1, int(window)) // 2
    mats = [None if c is None else _shape_matrix(c) for c in coins]
    out: list[float | None] = []
    for i, c in enumerate(coins):
        if c is None:
            out.append(None)
            continue
        near = [m for m in mats[max(0, i - half) : i + half + 1] if m is not None]
        w = np.linalg.eigvalsh(sum(near) / len(near))  # ascending
        out.append(math.degrees(math.acos(min(1.0, math.sqrt(max(w[0], 0.0) / w[1])))))
    return out


def camera_distance_range_mm(
    coin_px: float, diameter_mm: float, image_w: int, image_h: int, hfov_deg: tuple[float, float]
) -> tuple[float, float]:
    """Distance to the coin implied by its pixel size, for the assumed horizontal FOV range
    (FOV taken across the image's long side)."""
    long_side = max(image_w, image_h)
    dists = []
    for fov in hfov_deg:
        f_px = (long_side / 2) / math.tan(math.radians(fov) / 2)
        dists.append(f_px * diameter_mm / coin_px)
    return (min(dists), max(dists))


def frame_scale(
    coin: CoinObservation,
    ref: ReferenceSpec,
    image_w: int,
    image_h: int,
    cfg: MeasurementConfig,
    tilt_deg: float | None = None,
) -> FrameScale:
    cal, unc, depth = cfg.calibration, cfg.uncertainty, cfg.depth_model
    major, minor = coin.major_axis_px, min(coin.minor_axis_px, coin.major_axis_px)
    px_per_mm_coin = major / ref.diameter_mm

    rel_random = 2.0 * coin.fit_residual_px / math.sqrt(max(coin.n_edge_points, 1)) / major
    rel_sys = math.hypot(cal.diameter_edge_floor_px, ref.diameter_uncertainty_mm * px_per_mm_coin) / major

    tilt = coin_tilt_deg(coin) if tilt_deg is None else tilt_deg
    corrected = cal.tilt_rectification and tilt >= cal.tilt_correction_min_deg
    if corrected:
        theta = math.radians(coin.angle_deg)
        u = np.array([math.cos(theta), math.sin(theta)])
        v = np.array([-math.sin(theta), math.cos(theta)])
        m = np.outer(u, u) + (major / minor) * np.outer(v, v)
        t = math.radians(tilt)
        rel_tilt = math.tan(t) * math.radians(unc.tilt_estimate_sigma_deg)
    else:
        m = np.eye(2)
        # Uncorrected tilt. Under true perspective the error depends on the (unknown) tilt
        # direction: the pinhole study puts its worst case near coefficient * sin(tilt).
        # Treated as a uniform error of that half-width.
        rel_tilt = unc.tilt_pitch_coefficient * math.sin(math.radians(tilt)) / math.sqrt(3)

    z_lo, z_hi = camera_distance_range_mm(major, ref.diameter_mm, image_w, image_h, unc.assumed_hfov_deg)
    if depth.enabled:
        z = math.sqrt(z_lo * z_hi)
        sz = (z_hi - z_lo) / (2 * math.sqrt(3))
        delta = ref.thickness_mm + depth.landmark_layer_depth_mm
        factor = z / (z + delta)
        rel_depth = math.hypot(depth.landmark_layer_depth_sd_mm / (z + delta), delta * sz / (z * (z + delta)))
    else:
        factor, rel_depth = 1.0, 0.0

    return FrameScale(
        px_per_mm=px_per_mm_coin * factor,
        px_per_mm_coin=px_per_mm_coin,
        rel_sigma_random=rel_random,
        rel_sigma_systematic=rel_sys,
        rel_sigma_tilt=rel_tilt,
        rel_sigma_depth=rel_depth,
        tilt_deg=tilt,
        tilt_corrected=corrected,
        depth_factor=factor,
        distance_range_mm=(z_lo, z_hi),
        center=(coin.center_x, coin.center_y),
        rectification=m,
    )
