"""Hand measurement engine.

Turns per-frame numeric observations (MediaPipe landmarks in image pixels plus a
coin-ellipse observation) into millimetre measurements with an explicit uncertainty
budget, then aggregates many frames robustly. No rendering or UI code lives here.

See docs/MEASUREMENT_METHODOLOGY.md for definitions and the error model.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Collection
from dataclasses import dataclass, field

import numpy as np

from .calibration import FrameScale, ReferenceSpec, coin_tilt_deg, frame_scale
from .coin_detection import CoinDetection, score_detection
from .config import MeasurementCalibration, MeasurementConfig
from .issues import ISSUES
from .landmarks import (
    LONG_FINGERS,
    MIDDLE_TIP,
    WRIST,
    bbox_size,
    chain_bend_deg,
    inside_frame,
    palm_polygon,
    palm_tilt_deg,
    path_length,
    point_in_polygon,
)
from .schemas import CoinObservation, FrameObservation, ManualMeasurements, MeasurementOut

HAND_LENGTH = "hand_length_mm"
Z95 = 1.959964

# Measurements that are produced only by a fitted model or manual entry.
DERIVED_LABELS = {
    "palm_breadth_mm": "Palm breadth (skin edge to skin edge)",
    "hand_circumference_mm": "Hand circumference (around the knuckles, excluding thumb)",
}
DERIVED_DEFINITIONS = {
    "palm_breadth_mm": "Breadth of the palm at the metacarpal heads, measured skin edge to skin edge.",
    "hand_circumference_mm": "Circumference of the palm around the metacarpal heads (knuckles), excluding the thumb.",
}


@dataclass
class FrameResult:
    accepted: bool
    codes: list[str]
    values: dict[str, float] = field(default_factory=dict)  # raw mm, before calibration
    landmark_sigma: dict[str, float] = field(default_factory=dict)  # mm
    excluded: dict[str, str] = field(default_factory=dict)  # key -> reason
    scale: FrameScale | None = None
    # Per finger: (in-image bend, depth bend) in degrees; the depth bend is None without world landmarks.
    bends: dict[str, tuple[float, float | None]] = field(default_factory=dict)


def scan_finger_bends(results: list["FrameResult"]) -> dict[str, tuple[float, float | None]]:
    """The median bend of each finger over a scan's accepted frames (in-image, depth)."""
    out: dict[str, tuple[float, float | None]] = {}
    frames = [r.bends for r in results if r.accepted and r.bends]
    for name in LONG_FINGERS:
        two = [b[name][0] for b in frames if name in b and np.isfinite(b[name][0])]
        three = [b[name][1] for b in frames if name in b and b[name][1] is not None and np.isfinite(b[name][1])]
        if two:
            out[name] = (float(np.median(two)), float(np.median(three)) if three else None)
    return out


def scan_bent_fingers(results: list["FrameResult"], cap) -> set[str]:
    """Fingers that are bent for the scan as a whole: the median in-image bend is over its limit, or
    the median depth bend is. One noisy frame cannot decide this, a finger that is really curled can."""
    bent: set[str] = set()
    for name, (b2, b3) in scan_finger_bends(results).items():
        if b2 > cap.max_finger_bend_deg or (b3 is not None and b3 > cap.max_finger_bend_deg_3d):
            bent.add(name)
    return bent


def recheck_coin(coin: CoinObservation, cfg: MeasurementConfig) -> list[str]:
    """Re-apply the server-side acceptance thresholds to a client-reported coin observation."""
    det = CoinDetection(
        found=True,
        accepted=False,
        major_axis_px=coin.major_axis_px,
        minor_axis_px=coin.minor_axis_px,
        edge_support=coin.edge_support,
        max_angular_gap_deg=coin.max_angular_gap_deg,
        fit_residual_px=coin.fit_residual_px,
        edge_width_px=coin.edge_width_px,
        glare_fraction=coin.glare_fraction,
        contrast=coin.contrast,
        n_edge_points=coin.n_edge_points,
    )
    score_detection(det, cfg.coin_detection)
    return det.reasons


def _chain_finger(chain: list[int]) -> str | None:
    for name, ch in LONG_FINGERS.items():
        if tuple(chain) == ch:
            return name
    return None


def measure_frame(
    frame: FrameObservation, ref: ReferenceSpec, cfg: MeasurementConfig, tilt_deg: float | None = None
) -> FrameResult:
    """Check one frame and measure it. ``tilt_deg`` is the coin tilt estimated from the frames around
    it (calibration.smoothed_coin_tilts); without it the frame's own, noisier, tilt is used."""
    cap, unc = cfg.capture, cfg.uncertainty
    w, h = frame.image_width, frame.image_height
    lm = np.array([[p.x, p.y] for p in frame.landmarks], dtype=np.float64)
    codes: list[str] = []

    if not np.all(np.isfinite(lm)) or bbox_size(lm) < 1.0:
        return FrameResult(False, ["landmarks_invalid"])
    if not inside_frame(lm, w, h, cap.edge_margin_fraction):
        codes.append("hand_out_of_frame")
    if np.linalg.norm(lm[WRIST] - lm[MIDDLE_TIP]) < cap.min_hand_length_fraction * min(w, h):
        codes.append("hand_too_small")

    world = None
    if frame.world_landmarks is not None:
        world = np.array([[p.x, p.y, p.z] for p in frame.world_landmarks], dtype=np.float64)
    bent: set[str] = set()
    obscured: set[str] = set()
    bends: dict[str, tuple[float, float | None]] = {}
    for name, chain in LONG_FINGERS.items():
        chain_pts = lm[list(chain)]
        segs = np.linalg.norm(np.diff(chain_pts, axis=0), axis=1)
        b2 = chain_bend_deg(lm, chain)
        b3 = chain_bend_deg(world, chain) if world is not None else None
        bends[name] = (b2, b3)
        if np.isnan(b2) or np.any(segs < 3.0) or not inside_frame(chain_pts, w, h, cap.edge_margin_fraction):
            obscured.add(name)
        # In-image bend is accurate: judged on every frame. The depth bend is noisy and biased, so a
        # frame is dropped for it only when it is far over the limit; the limit itself is applied to
        # the median over the scan (scan_bent_fingers).
        elif not (b2 <= cap.max_finger_bend_deg) or (
            b3 is not None and not (b3 <= cap.max_finger_bend_deg_3d * cap.finger_bend_3d_frame_factor)
        ):
            bent.add(name)
    if "middle" in bent:
        codes.append("fingers_bent")
    if world is not None and palm_tilt_deg(world) > cap.max_palm_tilt_deg_model:
        codes.append("palm_not_flat")

    if frame.brightness is not None:
        lo, hi = cap.brightness_range
        if frame.brightness < lo:
            codes.append("too_dark")
        elif frame.brightness > hi:
            codes.append("too_bright")

    coin = frame.coin
    scale: FrameScale | None = None
    if coin is None:
        codes.append("coin_missing")
    else:
        # Server thresholds are re-applied to the reported metrics; reasons only the client can
        # see in the image (e.g. a second coin-like circle) are kept as reported.
        reasons = set(recheck_coin(coin, cfg)) | set(coin.reasons)
        if not coin.accepted and not reasons:
            reasons.add("coin_low_confidence")
        codes.extend(r for r in sorted(reasons) if r in ISSUES)
        if cfg.calibration.require_coin_on_palm and not point_in_polygon(
            (coin.center_x, coin.center_y), palm_polygon(lm)
        ):
            codes.append("coin_not_on_palm")
        tilt = coin_tilt_deg(coin) if tilt_deg is None else tilt_deg
        if tilt > cfg.calibration.max_tilt_deg:
            codes.append("coin_tilted")
        if not codes:
            scale = frame_scale(coin, ref, w, h, cfg, tilt)
            # Guided positioning: very close hands magnify depth differences between the coin
            # and the finger joints (see docs/CALIBRATION_STUDY.md).
            if math.sqrt(scale.distance_range_mm[0] * scale.distance_range_mm[1]) < cap.min_camera_distance_mm:
                codes.append("too_close")
                scale = None

    if codes or scale is None:
        return FrameResult(False, codes or ["coin_missing"])

    pts = scale.rectify(lm)
    # MediaPipe runs the landmark model on a crop about `landmark_roi_scale` times the hand's size.
    sigma_lm_px = unc.landmark_sigma_model_px * unc.landmark_roi_scale * bbox_size(lm) / unc.landmark_model_input_px
    result = FrameResult(True, [], scale=scale, bends=bends)
    for key, d in cfg.measurements.items():
        if d.kind == "straight":
            length_px = float(np.linalg.norm(pts[d.landmarks[-1]] - pts[d.landmarks[0]]))
            k = math.sqrt(2.0)
        else:
            length_px = path_length(pts, d.landmarks)
            k = math.sqrt(2.0 + 0.5 * (len(d.landmarks) - 2))
        mm = length_px / scale.px_per_mm
        finger = _chain_finger(d.landmarks)
        lo, hi = d.plausible_range_mm
        if finger in obscured:
            result.excluded[key] = "finger_obscured"
            continue
        if finger in bent:
            result.excluded[key] = "finger_bent"
            continue
        if not lo <= mm <= hi:
            if key == HAND_LENGTH:
                return FrameResult(False, ["implausible_scale"])
            result.excluded[key] = "implausible_value"
            continue
        result.values[key] = mm
        result.landmark_sigma[key] = k * sigma_lm_px / scale.px_per_mm
    return result


# --------------------------------------------------------------------------- #
# Aggregation
# --------------------------------------------------------------------------- #


def robust_inliers(values: np.ndarray, k: float = 3.5) -> np.ndarray:
    med = np.median(values)
    mad = np.median(np.abs(values - med)) * 1.4826
    if mad <= 1e-9:
        return np.ones(len(values), dtype=bool)
    return np.abs(values - med) <= k * mad


def classify(value: float, sigma: float, cfg: MeasurementConfig, out_of_plane: bool = False) -> str:
    rel95 = Z95 * sigma / value if value > 0 else math.inf
    u95 = Z95 * sigma
    if rel95 <= cfg.acceptance.max_rel_u95_valid and not out_of_plane:
        return "valid"
    if rel95 <= cfg.acceptance.max_rel_u95_low_confidence:
        return "low_confidence"
    if out_of_plane and rel95 <= 0.35 and u95 <= 16.0:
        return "low_confidence"
    if value > 0 and rel95 <= 0.25 and u95 <= 15.0:
        return "low_confidence"
    return "invalid"


@dataclass
class AggregateOutput:
    measurements: list[MeasurementOut]
    proportions: dict[str, float]
    issue_codes: list[str]
    unstable: bool


def aggregate_measurements(
    results: list[FrameResult],
    cfg: MeasurementConfig,
    calib: MeasurementCalibration,
    manual: ManualMeasurements | None,
    bent_fingers: Collection[str] = (),
) -> AggregateOutput:
    accepted = [r for r in results if r.accepted]
    unc = cfg.uncertainty
    min_frames = min(cfg.capture.frames_min_accepted, len(accepted))
    calibrated = calib.status == "calibrated"
    out: list[MeasurementOut] = []
    issue_codes: list[str] = []
    unstable = False
    kept_values: dict[str, float] = {}
    kept_sigma: dict[str, float] = {}

    min_feature_frames = min(min_frames, max(4, len(accepted) // 2))
    for key, d in cfg.measurements.items():
        idx = [i for i, r in enumerate(accepted) if key in r.values]
        base = dict(
            key=key,
            label=d.label,
            method=f"{'Straight-line' if d.kind == 'straight' else 'Joint-chain'} distance between MediaPipe "
            f"landmarks {d.landmarks}, coin-calibrated, tilt-rectified, median of frames",
            definition=d.definition,
            calibrated=calibrated,
            source="camera_landmarks",
        )
        req_frames = min_frames if key == HAND_LENGTH else min_feature_frames
        if _chain_finger(d.landmarks) in bent_fingers:
            out.append(MeasurementOut(**base, value_mm=None, uncertainty_mm=None, interval95_mm=None,
                                      status="invalid", frames_used=0, reasons=["finger_bent"]))  # fmt: skip
            continue
        if len(idx) < req_frames:
            excl = Counter(r.excluded.get(key) for r in accepted if key in r.excluded)
            reason = excl.most_common(1)[0][0] if excl else "too_few_frames"
            out.append(MeasurementOut(**base, value_mm=None, uncertainty_mm=None, interval95_mm=None,
                                      status="invalid", frames_used=len(idx), reasons=[reason]))  # fmt: skip
            continue

        vals = np.array([accepted[i].values[key] for i in idx])
        keep = robust_inliers(vals)
        idx = [i for i, kpt in zip(idx, keep, strict=False) if kpt]
        vals = vals[keep]
        n = len(vals)
        m = float(np.median(vals))
        sd = float(np.std(vals, ddof=1)) if n > 1 else 0.0
        scales = [accepted[i].scale for i in idx]

        entry = calib.measurements.get(key)
        cal_scale = entry.scale if entry else 1.0
        cal_offset = entry.offset_mm if entry else 0.0
        resid_sd = entry.residual_sd_mm if entry else 0.0
        value = cal_scale * m + cal_offset

        random = sd / math.sqrt(n)
        if calibrated:
            comps = {"calibration_residual": resid_sd, "frame_variation": random}
        else:
            comps = {
                "frame_variation": random,
                "landmark_localisation": float(np.median([accepted[i].landmark_sigma[key] for i in idx])),
                "coin_scale": m * float(np.median([s.rel_sigma_systematic for s in scales])),
                "tilt": m * float(np.median([s.rel_sigma_tilt for s in scales])),
                "depth_layer": m * float(np.median([s.rel_sigma_depth for s in scales])),
                "perspective_and_hand_flatness": m * unc.perspective_rel_sigma,
                "landmark_definition_prior": resid_sd,
            }
        sigma = cal_scale * math.sqrt(sum(c * c for c in comps.values()))
        status = classify(value, sigma, cfg, out_of_plane=d.out_of_plane)
        reasons: list[str] = []
        if d.out_of_plane and status in ("valid", "low_confidence"):
            status = "low_confidence"
            reasons.append("out_of_plane")
        lo, hi = d.plausible_range_mm
        if not lo <= value <= hi:
            status = "invalid"
            reasons.append("implausible_value")
        if m > 0 and sd / m > unc.unstable_rel_sd:
            reasons.append("unstable")
            unstable = True
        if status == "invalid" and not reasons:
            reasons.append("uncertainty_too_large")

        show = status != "invalid"
        out.append(
            MeasurementOut(
                **base,
                value_mm=round(value, 1) if show else None,
                uncertainty_mm=round(sigma, 1) if show else None,
                interval95_mm=(round(value - Z95 * sigma, 1), round(value + Z95 * sigma, 1)) if show else None,
                status=status,  # type: ignore[arg-type]
                frames_used=n,
                uncertainty_components_mm={k: round(v, 2) for k, v in comps.items()},
                reasons=reasons,
            )
        )
        if show:
            kept_values[key] = value
            kept_sigma[key] = sigma

    if manual and manual.hand_length_mm is not None:
        v = float(manual.hand_length_mm)
        s = cfg.uncertainty.manual_measurement_sd_mm
        hl_entry = MeasurementOut(
            key=HAND_LENGTH,
            label=cfg.measurements[HAND_LENGTH].label,
            value_mm=round(v, 1),
            uncertainty_mm=s,
            interval95_mm=(round(v - Z95 * s, 1), round(v + Z95 * s, 1)),
            status="user_entered",
            source="user_entered",
            method="Entered by the customer (tape measure)",
            definition=cfg.measurements[HAND_LENGTH].definition,
            calibrated=False,
            frames_used=0,
            uncertainty_components_mm={},
            reasons=[],
        )
        out = [m for m in out if m.key != HAND_LENGTH]
        out.insert(0, hl_entry)
        kept_values[HAND_LENGTH] = v
        kept_sigma[HAND_LENGTH] = s

    out.extend(_derived_and_manual(calib, kept_values, kept_sigma, manual, cfg))
    if unstable:
        issue_codes.append("measurement_unstable")
    return AggregateOutput(out, _proportions(accepted, kept_values), issue_codes, unstable)


def _derived_and_manual(
    calib: MeasurementCalibration,
    values: dict[str, float],
    sigmas: dict[str, float],
    manual: ManualMeasurements | None,
    cfg: MeasurementConfig,
) -> list[MeasurementOut]:
    out: list[MeasurementOut] = []
    manual_values = manual.model_dump(exclude_none=True) if manual else {}
    for key, label in DERIVED_LABELS.items():
        base = dict(key=key, label=label, definition=DERIVED_DEFINITIONS[key], frames_used=0)
        if key in manual_values:
            v = float(manual_values[key])
            s = cfg.uncertainty.manual_measurement_sd_mm
            out.append(MeasurementOut(**base, value_mm=round(v, 1), uncertainty_mm=s,
                                      interval95_mm=(round(v - Z95 * s, 1), round(v + Z95 * s, 1)),
                                      status="user_entered", source="user_entered",
                                      method="Entered by the customer (tape measure)", calibrated=False))  # fmt: skip
            continue
        model = calib.derived.get(key)
        if model is not None and all(p in values for p in model.predictors):
            v = model.intercept_mm + sum(c * values[p] for p, c in model.predictors.items())
            s = math.sqrt(model.residual_sd_mm**2 + sum((c * sigmas[p]) ** 2 for p, c in model.predictors.items()))
            status = classify(v, s, cfg)
            out.append(MeasurementOut(**base, value_mm=round(v, 1), uncertainty_mm=round(s, 1),
                                      interval95_mm=(round(v - Z95 * s, 1), round(v + Z95 * s, 1)),
                                      status=status, source="camera_model_estimate",  # type: ignore[arg-type]
                                      method=f"Linear model fitted on {model.n_participants} reference participants "
                                             f"from {', '.join(model.predictors)}",
                                      calibrated=True))  # fmt: skip
            continue
        out.append(MeasurementOut(**base, value_mm=None, uncertainty_mm=None, interval95_mm=None,
                                  status="not_measured", source="not_available",
                                  method="Not measurable from a single camera view without a validated model",
                                  calibrated=False, reasons=["requires_validated_model_or_manual_entry"]))  # fmt: skip
    return out


PROPORTIONS = {
    "palm_length_to_hand_length": ("palm_length_mm", HAND_LENGTH),
    "palm_width_to_palm_length": ("mcp_span_mm", "palm_length_mm"),
    "middle_finger_to_hand_length": ("middle_length_mm", HAND_LENGTH),
    "index_to_ring_finger": ("index_length_mm", "ring_length_mm"),
}


def _proportions(accepted: list[FrameResult], kept: dict[str, float]) -> dict[str, float]:
    """Scale-free ratios of raw landmark distances (median over frames)."""
    out: dict[str, float] = {}
    for name, (num, den) in PROPORTIONS.items():
        if num not in kept or den not in kept:
            continue
        ratios = [r.values[num] / r.values[den] for r in accepted if num in r.values and den in r.values]
        if ratios:
            out[name] = round(float(np.median(ratios)), 3)
    return out
