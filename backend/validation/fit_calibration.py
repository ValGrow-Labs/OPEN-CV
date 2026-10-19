"""Fit measurement calibration (offsets/scales and derived models) on the DEVELOPMENT split.

The fitted file replaces config/measurement_calibration.json. Test-split participants are
never used here; evaluate.py reports performance on them separately.

Usage::

    python -m validation.fit_calibration <participants.csv> <scans.csv> --out ../config/measurement_calibration.json
"""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from glovesize.config import CalibrationEntry, DerivedModel, MeasurementCalibration, load_measurement_config

from .dataset import DatasetError, Participant, Scan, check_consistency, load_participants, load_scans

MIN_PARTICIPANTS = 10
MIN_FOR_SCALE = 30
DERIVED_PREDICTORS = {
    "palm_breadth_mm": ["mcp_span_mm"],
    "hand_circumference_mm": ["mcp_span_mm", "hand_length_mm"],
}


def participant_means(scans: list[Scan], ids: set[str]) -> dict[str, dict[str, float]]:
    """Mean raw estimate per participant over accepted scans."""
    acc: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for s in scans:
        if s.accepted and s.participant_id in ids:
            if s.calibration_status not in ("uncalibrated", "unknown"):
                raise DatasetError(
                    f"scan {s.participant_id}/{s.scan_id} was produced with a calibrated config; refit needs raw estimates"
                )
            for k, v in s.estimates.items():
                acc[s.participant_id][k].append(v)
    return {p: {k: float(np.mean(v)) for k, v in d.items()} for p, d in acc.items()}


def fit_entry(raw: np.ndarray, ref: np.ndarray) -> CalibrationEntry:
    n = len(raw)
    if n >= MIN_FOR_SCALE:
        a, b = np.polyfit(raw, ref, 1)
        a = float(np.clip(a, 0.6, 1.4))
        b = float(np.mean(ref - a * raw))
        dof = n - 2
    else:
        a, b, dof = 1.0, float(np.mean(ref - raw)), n - 1
    resid = ref - (a * raw + b)
    sd = float(math.sqrt(float(np.sum(resid**2)) / max(dof, 1)))
    return CalibrationEntry(scale=a, offset_mm=b, residual_sd_mm=sd)


def fit_derived(target: str, predictors: list[str], rows: list[tuple[dict, dict]]) -> DerivedModel | None:
    usable = [(e, r) for e, r in rows if target in r and all(p in e for p in predictors)]
    if len(usable) < MIN_FOR_SCALE:
        return None
    x = np.array([[e[p] for p in predictors] for e, _ in usable])
    y = np.array([r[target] for _, r in usable])
    design = np.column_stack([x, np.ones(len(x))])
    coef, *_ = np.linalg.lstsq(design, y, rcond=None)
    resid = y - design @ coef
    sd = float(math.sqrt(float(np.sum(resid**2)) / max(len(y) - design.shape[1], 1)))
    return DerivedModel(
        predictors={p: float(c) for p, c in zip(predictors, coef[:-1], strict=True)},
        intercept_mm=float(coef[-1]),
        residual_sd_mm=sd,
        n_participants=len(y),
    )


def fit(participants: dict[str, Participant], scans: list[Scan], force: bool = False) -> MeasurementCalibration:
    check_consistency(participants, scans)
    dev = {p.participant_id for p in participants.values() if p.split == "dev"}
    means = participant_means(scans, dev)
    if len(means) < MIN_PARTICIPANTS and not force:
        raise DatasetError(f"only {len(means)} development participants with accepted scans; need {MIN_PARTICIPANTS}")
    keys = load_measurement_config().measurements
    entries: dict[str, CalibrationEntry] = {}
    for key in keys:
        pairs = [
            (m[key], participants[p].reference[key])
            for p, m in means.items()
            if key in m and key in participants[p].reference
        ]
        if len(pairs) >= 3:
            raw, ref = np.array(pairs).T
            entries[key] = fit_entry(raw, ref)
    rows = [(means[p], participants[p].reference) for p in means]
    derived = {t: fit_derived(t, preds, rows) for t, preds in DERIVED_PREDICTORS.items()}
    # Measurements without reference data keep their prior (uncalibrated) entries.
    from glovesize.config import load_measurement_calibration

    prior = load_measurement_calibration().measurements
    merged = {k: entries.get(k, prior[k]) for k in prior}
    return MeasurementCalibration(
        status="calibrated" if entries else "uncalibrated",
        source=f"Fitted on {len(means)} development-split participants by validation/fit_calibration.py. "
        f"Measurements with fitted entries: {sorted(entries)}.",
        fitted_at=datetime.now(UTC).isoformat(timespec="seconds"),
        n_participants=len(means),
        measurements=merged,
        derived=derived,
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("participants", type=Path)
    ap.add_argument("scans", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--force", action="store_true", help="allow fewer than the minimum number of participants")
    args = ap.parse_args()
    cal = fit(load_participants(args.participants), load_scans(args.scans), args.force)
    args.out.write_text(json.dumps(cal.model_dump(mode="json"), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out} ({cal.n_participants} participants, status={cal.status})")


if __name__ == "__main__":
    main()
