"""Scan orchestration: frames -> measurements -> recommendation."""

from __future__ import annotations

import logging
import math
from collections import Counter

import numpy as np

from .calibration import resolve_reference, smoothed_coin_tilts
from .config import (
    default_chart_id,
    load_measurement_calibration,
    load_measurement_config,
    load_reference_objects,
    load_sizing_charts,
)
from .issues import describe
from .measurement import HAND_LENGTH, aggregate_measurements, measure_frame
from .schemas import (
    CalibrationOut,
    CoinObservation,
    Issue,
    MeasurementOut,
    Point,
    RecommendationOut,
    RecommendRequest,
    ScanRequest,
    ScanResponse,
)
from .sizing import MeasuredValue, recommend

log = logging.getLogger("glovesize.pipeline")

BASE_LIMITATIONS = [
    "Measurements come from a single camera view and assume a flat, open hand with the coin lying flat on the palm.",
    "MediaPipe landmarks mark joint centres, not skin edges or creases; the offsets between them are corrected only after calibration with tape-measured hands.",
    "Hand circumference cannot be measured from one camera view. It is used only when entered manually or once a model has been validated on reference data.",
    "The size recommendation reflects measurement uncertainty only and does not guarantee fit.",
]


class UnknownChartError(ValueError):
    pass


def _issue(code: str, frames: int | None = None) -> Issue:
    sev, msg = describe(code)
    return Issue(code=code, severity=sev, message=msg, frames_affected=frames)


def get_chart(chart_id: str | None):
    charts = load_sizing_charts()
    cid = chart_id or default_chart_id()
    if cid not in charts:
        raise UnknownChartError(f"unknown chart_id {cid!r}")
    return charts[cid]


def recommendation_from(measurements: list[MeasurementOut], chart_id: str | None) -> RecommendationOut:
    chart = get_chart(chart_id)
    measured = {
        m.key: MeasuredValue(m.key, m.value_mm or 0.0, m.uncertainty_mm or 0.0, m.status, tuple(m.reasons))
        for m in measurements
    }
    return recommend(chart, measured)


def recommend_only(req: RecommendRequest) -> RecommendationOut:
    chart = get_chart(req.chart_id)
    measured = {m.key: MeasuredValue(m.key, m.value_mm, m.uncertainty_mm, m.status) for m in req.measurements}
    return recommend(chart, measured)


def process_scan(req: ScanRequest) -> ScanResponse:
    cfg = load_measurement_config()
    calib = load_measurement_calibration()
    chart = get_chart(req.chart_id)  # fail fast on unknown charts
    w, h = req.frames[0].image_width, req.frames[0].image_height
    # "validated" needs human sign-off on held-out real-world evidence, not just a fitted file.
    basis = (
        "validated"
        if calib.validated
        else "fitted_unvalidated"
        if calib.status == "calibrated"
        else "prior_assumptions"
    )

    def rejected(issues: list[Issue], counts: dict[str, int] | None = None, accepted: int = 0) -> ScanResponse:
        return ScanResponse(
            status="rejected", issues=issues, calibration=None, measurements=[], proportions={},
            frames_received=len(req.frames), frames_accepted=accepted, frame_rejection_counts=counts or {},
            landmarks_px_median=None, coin_median=None, image_width=w, image_height=h,
            recommendation=None, uncertainty_basis=basis, limitations=BASE_LIMITATIONS,
        )  # fmt: skip

    ref = resolve_reference(req.reference, load_reference_objects())
    if ref is None:
        return rejected([_issue("reference_unavailable")])
    if not req.reference.confirmed:
        return rejected([_issue("reference_unconfirmed")])
    obj = load_reference_objects().get(req.reference.object_id or "")
    if obj is not None and obj.size_check and not req.reference.size_checked:
        return rejected([_issue("reference_size_unchecked")])

    # The coin's tilt is judged on the average ellipse of neighbouring frames, not on one noisy frame.
    tilts = smoothed_coin_tilts([f.coin for f in req.frames], cfg.calibration.tilt_window_frames)
    results = [measure_frame(f, ref, cfg, tilt_deg=t) for f, t in zip(req.frames, tilts)]
    accepted_idx = [i for i, r in enumerate(results) if r.accepted]
    counts = Counter(c for r in results for c in set(r.codes))
    log.info(
        "scan: frames=%d accepted=%d top_issues=%s",
        len(results),
        len(accepted_idx),
        counts.most_common(3),
    )

    min_required = (
        8
        if (req.capture and req.capture.device_class == "mobile")
        else min(cfg.capture.frames_min_accepted, 8)
        if len(req.frames) <= 16
        else cfg.capture.frames_min_accepted
    )

    if len(accepted_idx) < min_required:
        issues = [_issue("insufficient_frames")] + [_issue(c, n) for c, n in counts.most_common(3)]
        return rejected(issues, dict(counts), len(accepted_idx))

    # Frame-to-frame consistency: a reliable coin fit and a still pose give nearly the same
    # millimetre hand length in every frame. Large spread means the scale is not trustworthy.
    hl_frames = np.array([results[i].values[HAND_LENGTH] for i in accepted_idx if HAND_LENGTH in results[i].values])
    if hl_frames.size >= 2 and float(np.std(hl_frames, ddof=1) / np.median(hl_frames)) > cfg.capture.max_frame_rel_sd:
        return rejected([_issue("scan_unstable")], dict(counts), len(accepted_idx))

    agg = aggregate_measurements(results, cfg, calib, req.manual_measurements)
    issues = [_issue(c) for c in agg.issue_codes]
    accepted = [results[i] for i in accepted_idx]
    scales = [r.scale for r in accepted if r.scale is not None]

    px = np.array([s.px_per_mm for s in scales])
    rel_scale = math.sqrt(
        float(np.median([s.rel_sigma_systematic for s in scales])) ** 2
        + float(np.median([s.rel_sigma_depth for s in scales])) ** 2
        + float(np.median([s.rel_sigma_tilt for s in scales])) ** 2
        + (float(np.std(px)) / float(np.mean(px))) ** 2 / len(px)
    )
    tilt_corrected = sum(s.tilt_corrected for s in scales) * 2 > len(scales)
    if tilt_corrected:
        issues.append(_issue("tilt_corrected"))
    if ref.custom:
        issues.append(_issue("custom_reference"))
    if basis != "validated":
        issues.append(_issue("uncertainty_unvalidated"))

    med_px = float(np.median(px))
    closest = accepted_idx[int(np.argmin(np.abs(px - med_px)))]
    coin = req.frames[closest].coin
    lms = np.median(np.array([[[p.x, p.y, p.z] for p in req.frames[i].landmarks] for i in accepted_idx]), axis=0)
    calibration = CalibrationOut(
        reference_label=ref.label,
        reference_diameter_mm=ref.diameter_mm,
        custom_reference=ref.custom,
        coin_diameter_px=round(float(np.median([s.px_per_mm_coin for s in scales])) * ref.diameter_mm, 2),
        px_per_mm=round(med_px, 4),
        px_per_mm_rel_uncertainty=round(rel_scale, 4),
        coin_tilt_deg=round(float(np.median([s.tilt_deg for s in scales])), 1),
        tilt_corrected=tilt_corrected,
        depth_correction_factor=round(float(np.median([s.depth_factor for s in scales])), 4),
        estimated_camera_distance_mm=(
            round(float(np.median([s.distance_range_mm[0] for s in scales]))),
            round(float(np.median([s.distance_range_mm[1] for s in scales]))),
        ),
    )

    hand_length = next((m for m in agg.measurements if m.key == HAND_LENGTH), None)
    status = "accepted"
    recommendation = None
    if hand_length is None or hand_length.status == "invalid":
        status = "rejected"
        issues.insert(0, _issue("hand_length_unreliable"))
    else:
        recommendation = recommendation_from(agg.measurements, chart.chart_id)

    limitations = list(BASE_LIMITATIONS)
    if cfg.depth_model.enabled:
        lo, hi = cfg.uncertainty.assumed_hfov_deg
        limitations.append(
            f"Lengths include an adjustment for depth that assumes a camera field of view between {lo:.0f}° "
            f"and {hi:.0f}° and a typical depth of the finger joints below the palm surface. Perspective "
            "and lens distortion are not measured; they are limited by the capture checks and included "
            "in the uncertainty."
        )

    return ScanResponse(
        status=status,  # type: ignore[arg-type]
        issues=issues,
        calibration=calibration,
        measurements=agg.measurements,
        proportions=agg.proportions,
        frames_received=len(req.frames),
        frames_accepted=len(accepted_idx),
        frame_rejection_counts=dict(counts),
        landmarks_px_median=[Point(x=float(x), y=float(y), z=float(z)) for x, y, z in lms],
        coin_median=CoinObservation.model_validate(coin.model_dump()) if coin else None,
        image_width=w,
        image_height=h,
        recommendation=recommendation,
        uncertainty_basis=basis,
        limitations=limitations,
    )
