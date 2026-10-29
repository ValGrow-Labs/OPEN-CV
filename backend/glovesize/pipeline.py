"""Scan orchestration: frames -> measurements -> recommendation."""

from __future__ import annotations

import logging
import math
from collections import Counter
from dataclasses import dataclass

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
from .landmarks import as_array, hand_turn
from .measurement import (
    HAND_LENGTH,
    CameraAgg,
    FrameResult,
    aggregate_camera,
    combine_views,
    finish_aggregate,
    measure_frame,
    scan_bent_fingers,
    scan_finger_bends,
)
from .schemas import (
    CalibrationOut,
    CoinObservation,
    FingerBendOut,
    FrameObservation,
    Issue,
    MeasurementOut,
    Point,
    RecommendationOut,
    RecommendRequest,
    ScanRequest,
    ScanResponse,
    ViewAgreement,
    ViewSummary,
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


@dataclass
class ViewOutcome:
    """What one view's frames came to: gate result, frame results and its camera measurements."""

    view_id: str
    frames: list[FrameObservation]
    results: list[FrameResult]
    accepted_idx: list[int]
    counts: Counter
    bent: set[str]
    camera: CameraAgg | None = None
    # Set when a hard gate failed: (issues for a rejection, accepted count). The primary view's
    # failure rejects the scan; a secondary view's only drops that view.
    failure: tuple[list[Issue], int] | None = None


def _process_view(view_id: str, frames: list[FrameObservation], ref, cfg, calib, req: ScanRequest, tag: bool) -> ViewOutcome:
    """Frame checks, the hard gates and the camera aggregation for the frames of one view."""
    # The coin's tilt is judged on the average ellipse of neighbouring frames, not on one noisy frame
    # (of this view's own frames: a view boundary is never smoothed across).
    tilts = smoothed_coin_tilts([f.coin for f in frames], cfg.calibration.tilt_window_frames)
    view_tilt_limit = next((v.max_coin_tilt_deg for v in cfg.capture.views if v.id == view_id), None)
    results = [measure_frame(f, ref, cfg, tilt_deg=t, max_tilt_deg=view_tilt_limit) for f, t in zip(frames, tilts)]
    accepted_idx = [i for i, r in enumerate(results) if r.accepted]
    counts = Counter(c for r in results for c in set(r.codes))
    log.info(
        "scan%s: frames=%d accepted=%d top_issues=%s",
        f" [{view_id}]" if tag else "",
        len(results),
        len(accepted_idx),
        counts.most_common(3),
    )
    out = ViewOutcome(view_id, frames, results, accepted_idx, counts, set())

    min_required = (
        8
        if (req.capture and req.capture.device_class == "mobile")
        else min(cfg.capture.frames_min_accepted, 8)
        if len(frames) <= 16
        else cfg.capture.frames_min_accepted
    )
    if len(accepted_idx) < min_required:
        issues = [_issue("insufficient_frames")] + [
            _implausible_scale_issue(results, ref, cfg, n) if c == "implausible_scale" else _issue(c, n)
            for c, n in counts.most_common(3)
        ]
        out.failure = (issues, len(accepted_idx))
        return out

    # A finger is bent or straight for the scan as a whole (median of its frames), not per frame.
    out.bent = scan_bent_fingers(results, cfg.capture)
    if "middle" in out.bent:  # hand length runs to its tip
        counts["fingers_bent"] = max(counts.get("fingers_bent", 0), len(accepted_idx))
        out.failure = ([_issue("fingers_bent", len(accepted_idx))], len(accepted_idx))
        return out

    # Frame-to-frame consistency: a reliable coin fit and a still pose give nearly the same
    # millimetre hand length in every frame. Large spread means the scale is not trustworthy.
    hl_frames = np.array([results[i].values[HAND_LENGTH] for i in accepted_idx if HAND_LENGTH in results[i].values])
    if hl_frames.size >= 2 and float(np.std(hl_frames, ddof=1) / np.median(hl_frames)) > cfg.capture.max_frame_rel_sd:
        out.failure = ([_issue("scan_unstable")], len(accepted_idx))
        return out

    out.camera = aggregate_camera(results, cfg, calib, out.bent)
    return out


def _implausible_scale_issue(results: list[FrameResult], ref, cfg, n: int) -> Issue:
    """The generic 'implausible scale' guidance plus what was actually measured, so a customer (and we)
    can tell a wrong coin from a small hand."""
    implied = [r.implied_hand_length_mm for r in results if r.implied_hand_length_mm is not None]
    base = _issue("implausible_scale", n)
    if not implied:
        return base
    lo, hi = cfg.measurements[HAND_LENGTH].plausible_range_mm
    mm = float(np.median(implied))
    side = "small" if mm < lo else "large"
    return base.model_copy(
        update={
            "message": (
                f"With the selected coin ({ref.label}, {ref.diameter_mm:.1f} mm) your hand measured about {mm:.0f} mm, "
                f"which is too {side} (expected {lo:.0f} to {hi:.0f} mm). Check that the coin on your hand is the "
                "one you selected; if you are not sure, measure it across with a ruler."
            )
        }
    )


def _median_turn(frames: list[FrameObservation]) -> float:
    turns = [
        hand_turn(as_array([[p.x, p.y] for p in f.landmarks]))
        for f in frames
        if all(math.isfinite(p.x) and math.isfinite(p.y) for p in f.landmarks)
    ]
    return float(np.median(turns)) if turns else 0.0


def _same_side(first: list[FrameObservation], second: list[FrameObservation], min_abs: float) -> bool:
    """True when both views show the same side of the hand: the same sign of ``hand_turn`` (median of
    each view's frames), each clearly judged (|turn| at least ``min_abs``). When either cannot be judged
    (a hand seen edge-on) nothing is claimed here: the view's own gates decide."""
    a, b = _median_turn(first), _median_turn(second)
    return abs(a) >= min_abs and abs(b) >= min_abs and (a > 0) == (b > 0)


def _usable_for_count(f: FrameObservation) -> bool:
    """A frame of a capture-only view counts as accepted when its landmarks are finite. The coin is
    optional: the view is not measured, and a coin seen edge-on must not hold a customer up."""
    return all(math.isfinite(p.x) and math.isfinite(p.y) for p in f.landmarks)


def _view_summaries(view_defs, outcomes: list[ViewOutcome], capture_only: dict[str, list[FrameObservation]]) -> list[ViewSummary]:
    """One summary per submitted view, in configured order."""
    done = {o.view_id: o for o in outcomes}
    summaries: list[ViewSummary] = []
    for vid, vdef in view_defs.items():
        if vid in done:
            o = done[vid]
            summaries.append(
                ViewSummary(
                    id=vid,
                    label=vdef.label,
                    frames_received=len(o.frames),
                    frames_accepted=len(o.accepted_idx),
                    used=o.failure is None,
                    hand_length_mm=None if (hl := _view_hand_length(o)) is None else round(hl, 1),
                    reason=None if o.failure is None else o.failure[0][0].code,
                )
            )
        elif vid in capture_only:
            frames = capture_only[vid]
            summaries.append(
                ViewSummary(
                    id=vid,
                    label=vdef.label,
                    frames_received=len(frames),
                    frames_accepted=sum(_usable_for_count(f) for f in frames),
                    used=False,
                    hand_length_mm=None,
                    reason="not_used_for_size",
                )
            )
    return summaries


def _view_hand_length(o: ViewOutcome) -> float | None:
    raw = o.camera.raw.get(HAND_LENGTH) if o.camera else None
    return None if raw is None else raw.value


def process_scan(req: ScanRequest, *, require_extra_views: bool = True) -> ScanResponse:
    """Process one scan. Customer scans (the default) must contain every view marked ``required`` in
    config capture.views. ``require_extra_views=False`` requires only the primary view and treats the
    others as optional: the single-view validation study, remote pilot, re-measuring and offline
    scripts use it, because they capture the palm only."""
    cfg = load_measurement_config()
    calib = load_measurement_calibration()
    chart = get_chart(req.chart_id)  # fail fast on unknown charts
    # The response reports the primary view's image size (views may differ, e.g. a rotated phone).
    primary_first = next((f for f in req.frames if f.view == cfg.capture.views[0].id), req.frames[0])
    w, h = primary_first.image_width, primary_first.image_height
    # "validated" needs human sign-off on held-out real-world evidence, not just a fitted file.
    basis = (
        "validated"
        if calib.validated
        else "fitted_unvalidated"
        if calib.status == "calibrated"
        else "prior_assumptions"
    )

    received = [len(req.frames)]  # becomes the number of size-used frames once the views are split

    def rejected(issues: list[Issue], counts: dict[str, int] | None = None, accepted: int = 0) -> ScanResponse:
        return ScanResponse(
            status="rejected", issues=issues, calibration=None, measurements=[], proportions={},
            frames_received=received[0], frames_accepted=accepted, frame_rejection_counts=counts or {},
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

    # Group the frames by capture view (the first configured view is the primary, required one).
    view_defs = {v.id: v for v in cfg.capture.views}
    primary_id = cfg.capture.views[0].id
    by_view: dict[str, list[FrameObservation]] = {}
    for f in req.frames:
        by_view.setdefault(f.view, []).append(f)
    if any(v not in view_defs for v in by_view):
        return rejected([_issue("unknown_view")])
    # Views that are captured but not used for size (config used_for_size: false) are only counted:
    # no size gate, tilt, bend or flatness check, no measurement, no calibration, no agreement, no
    # rejection or warning. Totals (frames_received/accepted, rejection counts) cover size-used views only.
    capture_only = {v: fs for v, fs in by_view.items() if not view_defs[v].used_for_size}
    received[0] = sum(len(fs) for v, fs in by_view.items() if v not in capture_only)
    required_ids = {v.id for v in cfg.capture.views if v.required} if require_extra_views else {primary_id}
    if primary_id not in by_view:
        return rejected([_issue("primary_view_missing")])
    for v in cfg.capture.views:
        if v.id in required_ids and v.id not in by_view:
            return rejected([_issue("required_view_missing")])
    order = [v.id for v in cfg.capture.views if v.id in by_view and v.id not in capture_only]  # primary first
    tag = len(order) > 1

    # A view that must show the other side of the hand (the back, after the palm) cannot be the same
    # side again: showing the palm twice would make the "back" view a copy of the first.
    for vid, vdef in view_defs.items():
        if vid in by_view and vdef.opposite_of in by_view and vid in required_ids and _same_side(
            by_view[vdef.opposite_of], by_view[vid], cfg.capture.hand_turn_min_abs
        ):
            return rejected([_issue("view_shows_same_side")])
        if vid in by_view and vdef.max_hand_turn_abs is not None and vid in required_ids:
            if abs(_median_turn(by_view[vid])) > vdef.max_hand_turn_abs:
                return rejected([_issue("view_not_side_on")])

    outcomes = [_process_view(vid, by_view[vid], ref, cfg, calib, req, tag) for vid in order]
    primary = outcomes[0]
    if primary.failure is not None:
        issues_f, accepted_f = primary.failure
        return rejected(issues_f, dict(primary.counts), accepted_f)

    # A required view that fails a gate rejects the scan (with the gate's own guidance); only an
    # optional view is dropped with a warning.
    for o in outcomes[1:]:
        if o.failure is not None and o.view_id in required_ids:
            issues_f, _ = o.failure
            all_counts = Counter()
            for x in outcomes:
                all_counts.update(x.counts)
            return rejected(
                [_issue("required_view_failed")] + issues_f, dict(all_counts), sum(len(x.accepted_idx) for x in outcomes)
            )
    # A required view that is only captured (not used for size) needs enough frames with a coin.
    min_capture = min(cfg.capture.frames_min_accepted, 8)
    for vid, fs in capture_only.items():
        if vid in required_ids and sum(_usable_for_count(f) for f in fs) < min_capture:
            all_counts = Counter()
            for x in outcomes:
                all_counts.update(x.counts)
            return rejected([_issue("required_view_failed")], dict(all_counts), sum(len(x.accepted_idx) for x in outcomes))

    used = [o for o in outcomes if o.failure is None]
    view_issues: list[Issue] = []
    for o in outcomes[1:]:
        if o.failure is not None:
            view_issues.append(_issue("view_dropped"))
    counts = Counter()
    for o in outcomes:
        counts.update(o.counts)
    accepted_idx = primary.accepted_idx  # the primary view's frames carry calibration and the diagram
    camera = combine_views([o.camera for o in used], cfg)
    agg = finish_aggregate(camera, cfg, calib, req.manual_measurements)
    issues = [_issue(c) for c in agg.issue_codes] + view_issues

    # Do the views agree about the hand length? A second view is an independent re-measurement;
    # disagreement is flagged (and already widens the uncertainty), never a rejection.
    agreement = None
    lengths = [v for v in (_view_hand_length(o) for o in used) if v is not None]
    if len(lengths) >= 2:
        diff = max(lengths) - min(lengths)
        allowed = cfg.capture.view_max_rel_diff * float(np.mean(lengths))
        agreement = ViewAgreement(
            hand_length_diff_mm=round(diff, 1), max_allowed_mm=round(allowed, 1), agree=diff <= allowed
        )
        if not agreement.agree:
            issues.append(_issue("views_disagree"))

    results = primary.results
    accepted = [results[i] for i in accepted_idx]
    scales = [r.scale for r in accepted if r.scale is not None]
    req_frames = primary.frames  # indices below refer to the primary view's frames

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
    coin = req_frames[closest].coin
    lms = np.median(np.array([[[p.x, p.y, p.z] for p in req_frames[i].landmarks] for i in accepted_idx]), axis=0)
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
    if len(used) > 1:
        limitations[0] = (
            "Measurements come from several camera views of the same hand, each assuming a flat, open hand with "
            "the coin lying flat on it. The views cross-check each other; they do not remove the stored "
            "uncertainty allowances."
        )
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
        frames_received=received[0],
        frames_accepted=sum(len(o.accepted_idx) for o in outcomes),
        frame_rejection_counts=dict(counts),
        landmarks_px_median=[Point(x=float(x), y=float(y), z=float(z)) for x, y, z in lms],
        coin_median=CoinObservation.model_validate(coin.model_dump()) if coin else None,
        image_width=w,
        image_height=h,
        recommendation=recommendation,
        uncertainty_basis=basis,
        limitations=limitations,
        finger_bends={
            name: FingerBendOut(
                bend_2d_deg=round(b2, 1),
                bend_3d_deg=None if b3 is None else round(b3, 1),
                limit_2d_deg=cfg.capture.max_finger_bend_deg,
                limit_3d_deg=cfg.capture.max_finger_bend_deg_3d,
            )
            for name, (b2, b3) in scan_finger_bends(results).items()
        },
        views=_view_summaries(view_defs, outcomes, capture_only),
        view_agreement=agreement,
    )
