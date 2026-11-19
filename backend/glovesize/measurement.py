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
    ALL_CHAINS,
    LONG_FINGERS,
    MIDDLE_TIP,
    WRIST,
    bbox_size,
    chain_bend_deg,
    chain_elevation_deg,
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
    # The hand length (mm) this frame implied when it was refused as implausible (``implausible_scale``):
    # with the selected coin the hand came out outside the human range, so the coin is probably wrong.
    implied_hand_length_mm: float | None = None
    # Per finger: (in-image bend, depth bend) in degrees; the depth bend is None without world landmarks.
    bends: dict[str, tuple[float, float | None]] = field(default_factory=dict)
    # Per chain (thumb and four fingers): elevation of its end-to-end chord above the image plane, degrees,
    # from the model's world landmarks (an estimate); empty without world landmarks.
    elevations: dict[str, float] = field(default_factory=dict)
    # Per chain key (thumb and fingers): where the tip of the length came from ("outline": the skin tip found from
    # the hand outline in the browser; "estimated": the hand's extension; "landmark": the model's tip point) and the extension, mm.
    tip_sources: dict[str, str] = field(default_factory=dict)
    tip_ext_mm: dict[str, float] = field(default_factory=dict)
    # Finger chain lengths of a usable frame BEFORE the finger-level exclusions (bent, implausible): only for the
    # information shown for a finger the result would otherwise hide. Never used for a value, a status or a size.
    info_values: dict[str, float] = field(default_factory=dict)
    # Crease-to-tip estimate per chain key for the frames that have the value, and for every usable frame (information), mm, and the
    # MCP-to-PIP segment of the frame, mm.
    crease_values: dict[str, float] = field(default_factory=dict)
    crease_info_values: dict[str, float] = field(default_factory=dict)
    prox_mm: dict[str, float] = field(default_factory=dict)


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


def _chain_name(chain: list[int]) -> str | None:
    """Like _chain_finger, but the thumb's chain counts too."""
    for name, ch in ALL_CHAINS.items():
        if tuple(chain) == ch:
            return name
    return None


def refined_tip(entry, lm: np.ndarray, chain: list[int], fa, w: int, h: int, margin_fraction: float):
    """The skin tip the browser found from the hand outline, if it passes the sanity checks, else None.

    It must be flagged "outline", lie in the frame, and sit beyond the landmark tip along the distal segment's own
    direction: extension between 0 and ``fa.outline_tip_max_extension_frac`` x the distal segment (DIP to tip), with
    only a small sideways offset. A refined tip is never a reason to accept anything else about the frame.
    """
    if entry is None or entry.source not in ("outline", "estimated"):
        return None
    tip, dip = lm[chain[-1]], lm[chain[-2]]
    axis = tip - dip
    length = float(np.linalg.norm(axis))
    if length < 3.0:
        return None
    axis = axis / length
    rel = np.array([entry.x, entry.y]) - tip
    along = float(rel @ axis)
    side = abs(float(rel[0] * axis[1] - rel[1] * axis[0]))
    if not (0.0 <= along <= fa.outline_tip_max_extension_frac * length) or side > 0.1 * length:
        return None
    pt = np.array([[entry.x, entry.y]])
    if not inside_frame(pt, w, h, margin_fraction):
        return None
    return pt[0]


def depth_aware_length_mm(
    pts: np.ndarray,
    chain: tuple[int, ...] | list[int],
    world_z_mm: np.ndarray,
    scale: FrameScale,
    principal: tuple[float, float],
    max_elevation_deg: float,
) -> float:
    """Length of a finger chain from the landmarks' RELATIVE depth (optional: config finger_accuracy).

    The coin gives one scale, for the knuckle layer. A joint nearer to or farther from the camera than the
    finger's own knuckle is at another distance, so its pixels mean other millimetres, and a finger tilted
    out of the image plane is foreshortened. With the model's relative world z (smaller = nearer; an
    ESTIMATE, noisy, never a measurement) each joint's lateral position is scaled by Z_i / Z_knuckle (about the image centre, where a pinhole camera's
    perspective is centred) and the
    chord's depth difference restores the foreshortening. The chord is used for the depth difference (its noise
    enters squared and over a long baseline) and the depth is clipped at ``max_elevation_deg``.
    """
    idx = list(chain)
    centre = np.asarray(principal)
    z_layer = scale.distance_range_mm
    z_layer = math.sqrt(z_layer[0] * z_layer[1]) / scale.depth_factor  # camera distance at the knuckle layer
    dz = world_z_mm[idx] - world_z_mm[idx[0]]
    xy = (pts[idx, :2] - centre) / scale.px_per_mm * (1.0 + dz / z_layer)[:, None]
    seg = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    lateral = float(seg.sum())
    chord = float(np.linalg.norm(xy[-1] - xy[0]))
    if chord < 1e-9:
        return lateral
    dz_chord = float(np.clip(dz[-1], -chord * math.tan(math.radians(max_elevation_deg)), chord * math.tan(math.radians(max_elevation_deg))))
    return lateral * math.sqrt(chord * chord + dz_chord * dz_chord) / chord


def measure_frame(
    frame: FrameObservation,
    ref: ReferenceSpec,
    cfg: MeasurementConfig,
    tilt_deg: float | None = None,
    max_tilt_deg: float | None = None,
    max_palm_tilt_deg: float | None = None,
) -> FrameResult:
    """Check one frame and measure it. ``tilt_deg`` is the coin tilt estimated from the frames around
    it (calibration.smoothed_coin_tilts); without it the frame's own, noisier, tilt is used.
    ``max_tilt_deg`` is the view's own coin-tilt limit (config capture.views[].max_coin_tilt_deg);
    without it calibration.max_tilt_deg applies. ``max_palm_tilt_deg`` likewise overrides
    capture.max_palm_tilt_deg_model for the view."""
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
    elevations: dict[str, float] = {}
    if world is not None:
        for name, chain in ALL_CHAINS.items():
            e = chain_elevation_deg(world, chain)
            if np.isfinite(e):
                elevations[name] = e
    if "middle" in bent:
        codes.append("fingers_bent")
    if world is not None and palm_tilt_deg(world) > (cap.max_palm_tilt_deg_model if max_palm_tilt_deg is None else max_palm_tilt_deg):
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
        if tilt > (cfg.calibration.max_tilt_deg if max_tilt_deg is None else max_tilt_deg):
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
    result = FrameResult(True, [], scale=scale, bends=bends, elevations=elevations)
    fa = cfg.finger_accuracy
    for key, d in cfg.measurements.items():
        finger = _chain_finger(d.landmarks)
        if d.kind == "straight":
            length_px = float(np.linalg.norm(pts[d.landmarks[-1]] - pts[d.landmarks[0]]))
            k = math.sqrt(2.0)
        else:
            length_px = path_length(pts, d.landmarks)
            k = math.sqrt(2.0 + 0.5 * (len(d.landmarks) - 2))
        name = _chain_name(d.landmarks)
        use = pts
        tip_src, tip_ext_mm = "landmark", 0.0
        if d.kind == "polyline" and fa.outline_tip and frame.refined_tips and name is not None and finger not in obscured and finger not in bent:
            entry = frame.refined_tips.get(str(d.landmarks[-1]))
            rp = refined_tip(entry, lm, d.landmarks, fa, w, h, cap.edge_margin_fraction)
            if rp is not None:
                use = pts.copy()
                use[d.landmarks[-1]] = scale.rectify(rp[None, :])[0]
                length_px = path_length(use, d.landmarks)
                tip_src = entry.source
                tip_ext_mm = float(np.linalg.norm(use[d.landmarks[-1]] - pts[d.landmarks[-1]])) / scale.px_per_mm
        mm = length_px / scale.px_per_mm
        thumb_da = fa.thumb_depth_aware and name == "thumb"
        if (thumb_da or (fa.depth_aware_lengths and finger is not None)) and world is not None and finger not in obscured:
            mm = depth_aware_length_mm(use, d.landmarks, world[:, 2] * 1000.0, scale, (w / 2.0, h / 2.0), fa.thumb_max_elevation_deg if name == "thumb" else fa.max_elevation_deg)
        crease = None
        if name is not None and d.kind == "polyline" and finger not in obscured:
            result.info_values[key] = mm
            result.landmark_sigma[key] = k * sigma_lm_px / scale.px_per_mm
            prox = float(np.linalg.norm(use[d.landmarks[1]] - use[d.landmarks[0]])) / scale.px_per_mm
            result.prox_mm[key] = prox
            if fa.crease_estimate and name in fa.crease_t:
                crease = mm - fa.crease_t[name] * prox
                result.crease_info_values[key] = crease
        lo, hi = d.plausible_range_mm
        if finger in obscured:
            result.excluded[key] = "finger_obscured"
            continue
        if finger in bent:
            result.excluded[key] = "finger_bent"
            continue
        if not lo <= mm <= hi:
            if key == HAND_LENGTH:
                return FrameResult(False, ["implausible_scale"], implied_hand_length_mm=mm)
            result.excluded[key] = "implausible_value"
            continue
        result.values[key] = mm
        if crease is not None:
            result.crease_values[key] = crease
        if name is not None and d.kind == "polyline":
            result.tip_sources[key] = tip_src
            result.tip_ext_mm[key] = tip_ext_mm
        result.landmark_sigma[key] = k * sigma_lm_px / scale.px_per_mm
    return result


# --------------------------------------------------------------------------- #
# Aggregation
# --------------------------------------------------------------------------- #


def finger_tilt_rel_sigma(tilt_deg: float, fa, corrected: bool) -> float:
    """Relative uncertainty from a finger tilted ``tilt_deg`` out of the image plane (optional term).

    A finger tilted by theta looks 1 - cos(theta) shorter. The tilt is only known from the model's noisy world
    landmarks (1 sigma ``fa.elevation_sigma_deg``, ASSUMED), so the true tilt is taken as the larger of the two:
    the reading and its noise, and the foreshortening it can hide is treated as uniform over that range (the
    same treatment as the coin tilt term). When the lengths are already depth-aware the foreshortening is
    corrected, and what remains is the error of that correction, tan(theta) times the tilt's noise, with the
    noise's own bias as a floor.
    """
    sig = math.radians(fa.elevation_sigma_deg)
    floor = (1.0 / math.cos(sig) - 1.0) / math.sqrt(3.0)
    theta = math.radians(min(tilt_deg, fa.max_elevation_deg))
    if corrected:
        return max(math.tan(theta) * sig, floor)
    return (1.0 / math.cos(math.hypot(theta, sig)) - 1.0) / math.sqrt(3.0)


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


@dataclass
class RawKey:
    """One camera measurement of one view, before rounding (what combining several views needs)."""

    value: float  # calibrated, mm
    comps: dict[str, float]  # uncertainty components before the calibration scale (as reported)
    cal_scale: float
    n: int
    unstable: bool


@dataclass
class CameraAgg:
    """The camera measurements of one view (no manual entries, no derived ones yet)."""

    out: list[MeasurementOut]
    issue_codes: list[str]
    unstable: bool
    kept_values: dict[str, float]
    kept_sigma: dict[str, float]
    raw: dict[str, RawKey]
    accepted: list[FrameResult]
    raw_crease: dict[str, RawKey] = field(default_factory=dict)


def aggregate_measurements(
    results: list[FrameResult],
    cfg: MeasurementConfig,
    calib: MeasurementCalibration,
    manual: ManualMeasurements | None,
    bent_fingers: Collection[str] = (),
) -> AggregateOutput:
    camera = aggregate_camera(results, cfg, calib, bent_fingers)
    return finish_aggregate(camera, cfg, calib, manual)


def _estimate(key, d, accepted, idx, vals, cfg, calib, trim=True, calibrate=True):
    """Median value and uncertainty components of one measurement from the chosen frames (after MAD rejection, unless
    ``trim`` is off). ``calibrate`` off: the calibration entry of the key is not applied (the crease-to-tip estimate is a
    different quantity from the chain length that entry was fitted to)."""
    unc = cfg.uncertainty
    calibrated = calib.status == "calibrated"
    keep = robust_inliers(vals) if trim else np.ones(len(vals), dtype=bool)
    n_out = int((~keep).sum())
    idx = [i for i, kpt in zip(idx, keep, strict=False) if kpt]
    vals = vals[keep]
    n = len(vals)
    m = float(np.median(vals))
    sd = float(np.std(vals, ddof=1)) if n > 1 else 0.0
    scales = [accepted[i].scale for i in idx]
    entry = calib.measurements.get(key)
    cal_scale = entry.scale if (entry and calibrate) else 1.0
    cal_offset = entry.offset_mm if (entry and calibrate) else 0.0
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
    name = _chain_name(d.landmarks)
    elevs = [accepted[i].elevations[name] for i in idx if name in accepted[i].elevations] if name else []
    tilt_deg = float(np.median(elevs)) if elevs else None
    tilted = False
    fa = cfg.finger_accuracy
    if fa.tilt_uncertainty and tilt_deg is not None:
        tilted = tilt_deg > fa.flag_elevation_deg
        if not calibrated:  # a fitted residual already includes the population's tilt
            comps["finger_foreshortening"] = m * finger_tilt_rel_sigma(
                tilt_deg, fa, corrected=(fa.depth_aware_lengths and name != "thumb") or (fa.thumb_depth_aware and name == "thumb")
            )
    sigma = cal_scale * math.sqrt(sum(c * c for c in comps.values()))
    return dict(idx=idx, n=n, n_out=n_out, m=m, sd=sd, value=value, sigma=sigma, comps=comps, cal_scale=cal_scale,
                tilt_deg=tilt_deg, tilted=tilted)  # fmt: skip


def _info_fields(key, d, accepted, cfg, calib, est=None) -> dict:
    """The value, uncertainty and interval of a thumb or finger the result would hide (status invalid), as plain
    additive fields. Same formulas as the shown value; the status, the reasons and the size are not touched.
    ``est`` is an estimate already made from the usual frames; otherwise one is made from every usable frame."""
    if _chain_name(d.landmarks) is None or d.kind != "polyline":
        return {}
    if est is None:
        idx = [i for i, r in enumerate(accepted) if key in r.info_values]
        if not idx:
            return {}
        est = _estimate(key, d, accepted, idx, np.array([accepted[i].info_values[key] for i in idx]), cfg, calib)
    v, s = est["value"], est["sigma"]
    return dict(info_value_mm=round(v, 1), info_uncertainty_mm=round(s, 1),
                info_interval95_mm=(round(v - Z95 * s, 1), round(v + Z95 * s, 1)), info_frames=est["n"])  # fmt: skip


def _tip_fields(key, d, accepted, idx) -> dict:
    if _chain_name(d.landmarks) is None or d.kind != "polyline":
        return {}
    counts = Counter(accepted[i].tip_sources.get(key, "landmark") for i in idx)
    ext = [accepted[i].tip_ext_mm[key] for i in idx if accepted[i].tip_sources.get(key, "landmark") != "landmark" and key in accepted[i].tip_ext_mm]
    return dict(tip_source=dict(counts), tip_extension_mm=round(float(np.median(ext)), 1) if ext else None)


def _crease_fields(key, d, accepted, idx, cfg, calib, trim) -> tuple[dict, RawKey | None]:
    """The crease-to-tip ESTIMATE of a thumb or finger as additive fields (and the raw numbers for combining views).

    Per frame it is the chain length minus t x |MCP to PIP| (measure_frame); here it is aggregated like the value (median of the same
    frames; when ``trim`` is off the frames are exactly the ones the value used), with the same uncertainty terms plus
    ``crease_position`` for where the crease really lies (+- ``crease_position_halfwidth_frac`` of the MCP-to-PIP segment,
    uniform, ASSUMED). Its status uses the same limits as every length, so a value over them is called invalid (shown as
    "Very uncertain"), never hidden. Nothing here changes a value, a status or the size."""
    fa = cfg.finger_accuracy
    name = _chain_name(d.landmarks)
    if not fa.crease_estimate or name is None or d.kind != "polyline" or name not in fa.crease_t:
        return {}, None
    source = "crease_values" if not trim else "crease_info_values"
    use_idx = [i for i in idx if key in getattr(accepted[i], source)]
    if not use_idx:
        return {}, None
    vals = np.array([getattr(accepted[i], source)[key] for i in use_idx])
    est = _estimate(key, d, accepted, use_idx, vals, cfg, calib, trim=trim, calibrate=False)
    prox = float(np.median([accepted[i].prox_mm[key] for i in est["idx"]]))
    comps = dict(est["comps"])
    comps["crease_position"] = fa.crease_position_halfwidth_frac * prox / math.sqrt(3.0)
    sigma = math.sqrt(sum(c * c for c in comps.values()))
    value = est["value"]
    status = classify(value, sigma, cfg, out_of_plane=d.out_of_plane)
    fields = dict(
        crease_to_tip_mm=round(value, 1), crease_uncertainty_mm=round(sigma, 1),
        crease_interval95_mm=(round(value - Z95 * sigma, 1), round(value + Z95 * sigma, 1)),
        crease_status=status, crease_t=fa.crease_t[name],
    )  # fmt: skip
    return fields, RawKey(value=value, comps=comps, cal_scale=1.0, n=est["n"], unstable=False)


def aggregate_camera(
    results: list[FrameResult],
    cfg: MeasurementConfig,
    calib: MeasurementCalibration,
    bent_fingers: Collection[str] = (),
) -> CameraAgg:
    accepted = [r for r in results if r.accepted]
    unc = cfg.uncertainty
    min_frames = min(cfg.capture.frames_min_accepted, len(accepted))
    calibrated = calib.status == "calibrated"
    out: list[MeasurementOut] = []
    issue_codes: list[str] = []
    unstable = False
    kept_values: dict[str, float] = {}
    kept_sigma: dict[str, float] = {}
    raw_keys: dict[str, RawKey] = {}
    raw_crease: dict[str, RawKey] = {}

    min_feature_frames = min(min_frames, max(4, len(accepted) // 2))
    fa = cfg.finger_accuracy
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
        excl = Counter(r.excluded[key] for r in accepted if key in r.excluded)
        base["limitation"] = d.limitation or None
        if _chain_finger(d.landmarks) in bent_fingers:
            out.append(MeasurementOut(**base, value_mm=None, uncertainty_mm=None, interval95_mm=None,
                                      status="invalid", frames_used=0, reasons=["finger_bent"],
                                      frame_exclusions=dict(excl), **_info_fields(key, d, accepted, cfg, calib),
                                      **_crease_fields(key, d, accepted, [i for i, r in enumerate(accepted) if key in r.info_values], cfg, calib, True)[0]))  # fmt: skip
            continue
        if len(idx) < req_frames:
            reason = excl.most_common(1)[0][0] if excl else "too_few_frames"
            out.append(MeasurementOut(**base, value_mm=None, uncertainty_mm=None, interval95_mm=None,
                                      status="invalid", frames_used=len(idx), reasons=[reason],
                                      frame_exclusions=dict(excl), **_info_fields(key, d, accepted, cfg, calib),
                                      **_crease_fields(key, d, accepted, [i for i, r in enumerate(accepted) if key in r.info_values], cfg, calib, True)[0]))  # fmt: skip
            continue

        thumb_pick = None
        if fa.thumb_best_frames_frac < 1.0 and _chain_name(d.landmarks) == "thumb" and sum("thumb" in accepted[i].elevations for i in idx) == len(idx):
            ranked = sorted(idx, key=lambda i: accepted[i].elevations["thumb"])
            keep_n = min(len(idx), max(req_frames, math.ceil(fa.thumb_best_frames_frac * len(idx))))
            thumb_pick = sorted(ranked[:keep_n])
            if len(thumb_pick) < len(idx):
                excl["thumb_not_flattest"] = len(idx) - len(thumb_pick)
                idx = thumb_pick
        est = _estimate(key, d, accepted, idx, np.array([accepted[i].values[key] for i in idx]), cfg, calib)
        if est["n_out"]:
            excl["outlier_frame"] = est["n_out"]
        idx, n, m, sd = est["idx"], est["n"], est["m"], est["sd"]
        value, sigma, comps, cal_scale = est["value"], est["sigma"], est["comps"], est["cal_scale"]
        tilt_deg, tilted = est["tilt_deg"], est["tilted"]
        status = classify(value, sigma, cfg, out_of_plane=d.out_of_plane)
        reasons: list[str] = []
        if d.out_of_plane and status in ("valid", "low_confidence"):
            status = "low_confidence"
            reasons.append("out_of_plane")
        if tilted:
            reasons.append("finger_tilted")
        lo, hi = d.plausible_range_mm
        if not lo <= value <= hi:
            status = "invalid"
            reasons.append("implausible_value")
        key_unstable = bool(m > 0 and sd / m > unc.unstable_rel_sd)
        if key_unstable:
            reasons.append("unstable")
            unstable = True
        if status == "invalid" and not reasons:
            reasons.append("uncertainty_too_large")

        show = status != "invalid"
        crease_f, crease_raw = _crease_fields(key, d, accepted, idx, cfg, calib, False)
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
                frame_exclusions=dict(excl),
                finger_tilt_deg=None if tilt_deg is None else round(tilt_deg, 1),
                **_tip_fields(key, d, accepted, idx),
                **({} if show else _info_fields(key, d, accepted, cfg, calib, est)),
                **crease_f,
            )
        )
        if crease_raw is not None:
            raw_crease[key] = crease_raw
        if show:
            kept_values[key] = value
            kept_sigma[key] = sigma
            raw_keys[key] = RawKey(value=value, comps=dict(comps), cal_scale=cal_scale, n=n, unstable=key_unstable)

    if unstable:
        issue_codes.append("measurement_unstable")
    return CameraAgg(out, issue_codes, unstable, kept_values, kept_sigma, raw_keys, accepted, raw_crease)


def finish_aggregate(
    camera: CameraAgg,
    cfg: MeasurementConfig,
    calib: MeasurementCalibration,
    manual: ManualMeasurements | None,
) -> AggregateOutput:
    """Add the customer's tape entries and the derived measurements to the camera ones."""
    out = list(camera.out)
    kept_values = dict(camera.kept_values)
    kept_sigma = dict(camera.kept_sigma)
    issue_codes = list(camera.issue_codes)
    accepted = camera.accepted

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
    return AggregateOutput(out, _proportions(accepted, kept_values), issue_codes, camera.unstable)


def combine_views(views: list[CameraAgg], cfg: MeasurementConfig) -> CameraAgg:
    """One camera measurement per key from several views of the same hand (primary view first).

    * A key that only one view measured is that view's measurement, unchanged.
    * Otherwise the value is the mean of the views' values (one vote per *view*, not per frame) and
      each uncertainty component is the average of the views' components: no reduction of any
      random or systematic term is claimed. A new component, ``view_disagreement`` (the standard
      error of the views' values), grows when the views differ.
    """
    if len(views) == 1:
        return views[0]
    primary = views[0]
    out: list[MeasurementOut] = []
    kept_values: dict[str, float] = {}
    kept_sigma: dict[str, float] = {}
    raw_out: dict[str, RawKey] = {}
    by_key = [{m.key: m for m in v.out} for v in views]
    for key, d in cfg.measurements.items():
        have = [(v, i) for i, v in enumerate(views) if key in v.raw]
        if not have:
            out.append(by_key[0][key])
            continue
        if len(have) == 1:
            v, i = have[0]
            out.append(by_key[i][key])
            kept_values[key] = v.kept_values[key]
            kept_sigma[key] = v.kept_sigma[key]
            raw_out[key] = v.raw[key]
            continue
        raws = [v.raw[key] for v, _ in have]
        k = len(raws)
        vals = np.array([r.value for r in raws])
        value = float(np.mean(vals))
        cal_scale = raws[0].cal_scale
        names = list(raws[0].comps)
        comps = {c: float(np.mean([r.comps.get(c, 0.0) for r in raws])) for c in names}
        comps["view_disagreement"] = float(np.std(vals, ddof=1) / math.sqrt(k)) / cal_scale
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
        if any(r.unstable for r in raws):
            reasons.append("unstable")
        if status == "invalid" and not reasons:
            reasons.append("uncertainty_too_large")
        show = status != "invalid"
        base = by_key[have[0][1]][key]
        out.append(
            base.model_copy(
                update=dict(
                    value_mm=round(value, 1) if show else None,
                    uncertainty_mm=round(sigma, 1) if show else None,
                    interval95_mm=(round(value - Z95 * sigma, 1), round(value + Z95 * sigma, 1)) if show else None,
                    status=status,
                    frames_used=sum(r.n for r in raws),
                    uncertainty_components_mm={c: round(x, 2) for c, x in comps.items()},
                    reasons=reasons,
                    frame_exclusions=_sum_counts([by_key[i][key].frame_exclusions for _, i in have]),
                    finger_tilt_deg=_mean_or_none([by_key[i][key].finger_tilt_deg for _, i in have]),
                    tip_source=_sum_counts([by_key[i][key].tip_source for _, i in have]),
                    tip_extension_mm=_mean_or_none([by_key[i][key].tip_extension_mm for _, i in have]),
                    **(
                        {}
                        if show or _chain_name(d.landmarks) is None or d.kind != "polyline"
                        else dict(info_value_mm=round(value, 1), info_uncertainty_mm=round(sigma, 1),
                                  info_interval95_mm=(round(value - Z95 * sigma, 1), round(value + Z95 * sigma, 1)),
                                  info_frames=sum(r.n for r in raws))
                    ),
                )
            )
        )
        if show:
            kept_values[key] = value
            kept_sigma[key] = sigma
            raw_out[key] = RawKey(value, comps, cal_scale, sum(r.n for r in raws), any(r.unstable for r in raws))
    out, raw_crease_out = _combine_crease(views, out, by_key, cfg)
    codes = list(dict.fromkeys(c for v in views for c in v.issue_codes))
    return CameraAgg(out, codes, any(v.unstable for v in views), kept_values, kept_sigma, raw_out, primary.accepted, raw_crease_out)


def _combine_crease(views, out, by_key, cfg):
    """The crease-to-tip estimate of each finger over several views: the mean of the views' values, each uncertainty term
    averaged, plus the disagreement of the views, exactly as the value is combined (view votes, not frame votes)."""
    raw_out: dict[str, RawKey] = {}
    result = []
    for m in out:
        d = cfg.measurements[m.key]
        have = [(v, i) for i, v in enumerate(views) if m.key in v.raw_crease]
        if not have:
            result.append(m)
            continue
        if len(have) == 1:
            v, i = have[0]
            src = by_key[i][m.key]
            raw_out[m.key] = v.raw_crease[m.key]
            result.append(m.model_copy(update=dict(
                crease_to_tip_mm=src.crease_to_tip_mm, crease_uncertainty_mm=src.crease_uncertainty_mm,
                crease_interval95_mm=src.crease_interval95_mm, crease_status=src.crease_status, crease_t=src.crease_t)))  # fmt: skip
            continue
        raws = [v.raw_crease[m.key] for v, _ in have]
        vals = np.array([r.value for r in raws])
        comps = {c: float(np.mean([r.comps.get(c, 0.0) for r in raws])) for c in raws[0].comps}
        comps["view_disagreement"] = float(np.std(vals, ddof=1) / math.sqrt(len(raws)))
        sigma = math.sqrt(sum(c * c for c in comps.values()))
        value = float(np.mean(vals))
        raw_out[m.key] = RawKey(value, comps, 1.0, sum(r.n for r in raws), False)
        result.append(m.model_copy(update=dict(
            crease_to_tip_mm=round(value, 1), crease_uncertainty_mm=round(sigma, 1),
            crease_interval95_mm=(round(value - Z95 * sigma, 1), round(value + Z95 * sigma, 1)),
            crease_status=classify(value, sigma, cfg, out_of_plane=d.out_of_plane), crease_t=by_key[have[0][1]][m.key].crease_t)))  # fmt: skip
    return result, raw_out


def _sum_counts(counts: list[dict[str, int]]) -> dict[str, int]:
    out: Counter = Counter()
    for c in counts:
        out.update(c)
    return dict(out)


def _mean_or_none(values: list[float | None]) -> float | None:
    have = [v for v in values if v is not None]
    return None if not have else round(float(np.mean(have)), 1)


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
