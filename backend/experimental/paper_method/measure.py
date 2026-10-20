"""End-to-end experimental measurement from one photo of a hand flat on a sheet of paper."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .config import PaperMethodConfig, load_config
from .hand import OutlineMeasurement, measure_outline, segment_hand
from .paper import PaperGeometry, detect_paper, edge_curvature_mm, paper_geometry

Z95 = 1.959964


@dataclass
class Estimate:
    key: str
    value_mm: float
    raw_mm: float  # before the silhouette-height adjustment
    sd_mm: float
    components_mm: dict[str, float]
    method: str
    basis: str = "experimental: assumption-based uncertainty, not validated against physical measurements"

    @property
    def interval95_mm(self) -> tuple[float, float]:
        return (self.value_mm - Z95 * self.sd_mm, self.value_mm + Z95 * self.sd_mm)


@dataclass
class PaperResult:
    accepted: bool
    reasons: list[str]
    estimates: list[Estimate] = field(default_factory=list)
    geometry: PaperGeometry | None = None
    outline: OutlineMeasurement | None = None
    diagnostics: dict = field(default_factory=dict)


def height_correction(p_frame: np.ndarray, nadir_frame: np.ndarray, camera_height_mm: float, h_mm: float) -> np.ndarray:
    """Where a point really is, given where its ray meets the sheet and its height above the sheet.

    A point at height h is seen along the ray from the camera centre C; that ray meets the sheet
    at p. Solving for the point on the ray at height h gives n + (p - n)(1 - h/H), where n is the
    point of the sheet directly below the camera and H the camera's height. Outlines are seen
    displaced outwards from n, so raw measurements across the hand read long.
    """
    return nadir_frame + (p_frame - nadir_frame) * (1.0 - h_mm / camera_height_mm)


def _hypot(d: dict[str, float]) -> float:
    return math.sqrt(sum(v * v for v in d.values()))


def measure_photo(
    image_bgr: np.ndarray,
    paper_key: str,
    mcp_landmarks_px: np.ndarray | None = None,
    cfg: PaperMethodConfig | None = None,
) -> PaperResult:
    """``mcp_landmarks_px``: optional MediaPipe index and little-finger MCP landmarks (5 and 17),
    in image pixels, used only to locate the metacarpal level for hand breadth."""
    cfg = cfg or load_config()
    paper = cfg.papers[paper_key]
    det = detect_paper(image_bgr, cfg.paper_detection)
    if not det.found:
        return PaperResult(False, det.reasons)
    h, w = image_bgr.shape[:2]
    ga = cfg.geometry_assumptions
    geom = paper_geometry(det.corners_px, paper, (w, h), ga.assumed_hfov_deg)
    curvature = edge_curvature_mm(det, geom)
    diag = {
        "paper_corners_px": det.corners_px.round(2).tolist(),
        "aspect_measured": round(geom.measured_aspect, 4),
        "aspect_expected": round(geom.expected_aspect, 4),
        "focal_px": round(geom.focal_px, 1),
        "focal_observed": geom.focal_observed,
        "camera_height_mm": [round(v, 1) for v in geom.camera_height_range_mm],
        "edge_curvature_mm": round(curvature, 3),
    }
    reasons = []
    if abs(geom.aspect_error) > cfg.paper_detection.aspect_tolerance:
        reasons.append("paper_size_mismatch")
    if curvature > cfg.paper_detection.max_edge_curvature_mm:
        reasons.append("paper_edges_curved")
    if reasons:
        return PaperResult(False, reasons, geometry=geom, diagnostics=diag)

    seg = segment_hand(image_bgr, geom, cfg.rectify_px_per_mm, cfg.hand)
    if seg.reasons:
        return PaperResult(False, seg.reasons, geometry=geom, diagnostics=diag)
    mcp = seg.frame.from_sheet(geom.to_mm(mcp_landmarks_px)) if mcp_landmarks_px is not None else None
    out = measure_outline(seg, cfg.hand, mcp)
    if out is None:
        return PaperResult(False, ["hand_outline_incomplete"], geometry=geom, diagnostics=diag)
    diag.update(wrist_side=seg.frame.side, axis_angle_deg=round(out.axis_angle_deg, 2), wrist_width_mm=round(out.wrist_width_mm, 1),
                min_margin_mm=round(out.min_margin_mm, 1), breadth_level_source=out.breadth_level_source)  # fmt: skip

    # Silhouette-height adjustment (assumed heights; see config geometry_assumptions).
    nadir = seg.frame.from_sheet(geom.camera_mm[:2])[0]
    hc_lo, hc_hi = geom.camera_height_range_mm
    hc = math.sqrt(hc_lo * hc_hi)
    sh = ga.silhouette_height_mm
    tip_c = height_correction(out.tip, nadir, hc, sh.fingertip)
    ends_c = height_correction(out.breadth_ends, nadir, hc, sh.palm_edge)
    length = float(tip_c[1])  # the wrist crease lies on the edge (y = 0) at sheet level
    breadth = float(np.linalg.norm(ends_c[0] - ends_c[1]))

    def height_sd(points: np.ndarray, dh: float) -> float:
        return float(np.linalg.norm(points - nadir, axis=1).mean()) * dh / hc

    along_y = seg.frame.depth_mm
    along_x = seg.frame.size_mm[0] if seg.frame.side in ("top", "bottom") else seg.frame.size_mm[1]
    tol = paper.tolerance_mm / math.sqrt(3)  # uniform within the tolerance
    l_comp = {
        "paper_size_tolerance": length * tol / along_y,
        "silhouette_height": height_sd(out.tip[None, :], ga.silhouette_height_sd_mm),
        "camera_height": abs(float(height_correction(out.tip, nadir, hc_lo, sh.fingertip)[1] - height_correction(out.tip, nadir, hc_hi, sh.fingertip)[1])) / 2,
        "wrist_alignment": ga.wrist_alignment_sd_mm,
        "outline": ga.outline_sd_mm,
        "edge_straightness": length * curvature / along_y,
    }  # fmt: skip
    b_comp = {
        "paper_size_tolerance": breadth * tol / along_x,
        "silhouette_height": math.sqrt(2) * height_sd(out.breadth_ends, ga.silhouette_height_sd_mm),
        "outline": math.sqrt(2) * ga.outline_sd_mm,
        "metacarpal_level": out.breadth_level_sensitivity_mm
        if math.isfinite(out.breadth_level_sensitivity_mm)
        else 2.0,
        "edge_straightness": breadth * curvature / along_x,
    }
    estimates = [
        Estimate("hand_length_mm", length, out.length_perp_mm, _hypot(l_comp), l_comp,
                 "Wrist edge of the sheet (protocol: wrist crease on the edge) to the farthest outline point (middle fingertip skin)."),
        Estimate("hand_breadth_mm", breadth, out.breadth_mm, _hypot(b_comp), b_comp,
                 f"Outline width across the palm at the metacarpal level ({out.breadth_level_source}), thumb excluded by protocol."),
    ]  # fmt: skip
    return PaperResult(not out.reasons, out.reasons, estimates, geom, out, diag)
