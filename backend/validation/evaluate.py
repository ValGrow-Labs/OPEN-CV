"""Evaluate camera estimates against reference measurements, per split.

The headline numbers are for the held-out TEST split. Development-split numbers are
reported separately and must not be presented as independent validation.

Usage::

    python -m validation.evaluate <participants.csv> <scans.csv> [--calibration cal.json]
        [--fit-trials fit_trials.csv] [--chart demo-length-v1] [--out report]
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from glovesize.config import MeasurementCalibration, load_sizing_charts
from glovesize.sizing import MeasuredValue, recommend

from .dataset import FitTrial, Participant, Scan, check_consistency, load_fit_trials, load_participants, load_scans
from .metrics import error_metrics, size_accuracy


def apply_calibration(scan: Scan, cal: MeasurementCalibration | None) -> tuple[dict[str, float], dict[str, float]]:
    if cal is None or cal.status != "calibrated":
        return dict(scan.estimates), dict(scan.sigmas)
    est, sig = {}, {}
    for k, v in scan.estimates.items():
        e = cal.measurements.get(k)
        if e is None:
            est[k], sig[k] = v, scan.sigmas.get(k, float("nan"))
        else:
            est[k], sig[k] = e.scale * v + e.offset_mm, e.residual_sd_mm
    return est, sig


def evaluate_split(
    split: str,
    participants: dict[str, Participant],
    scans: list[Scan],
    cal: MeasurementCalibration | None,
    trials: list[FitTrial],
    chart_id: str | None,
) -> dict:
    ids = {p for p, v in participants.items() if v.split == split}
    sscans = [s for s in scans if s.participant_id in ids]
    if not sscans:
        return {"split": split, "n_participants": len(ids), "n_scans": 0}

    accepted = [s for s in sscans if s.accepted]
    by_participant = defaultdict(list)
    for s in sorted(sscans, key=lambda s: s.scan_id):
        by_participant[s.participant_id].append(s)
    first_rejected = sum(1 for v in by_participant.values() if not v[0].accepted)

    measurements: dict[str, dict] = {}
    keys = sorted({k for s in accepted for k in s.estimates})
    for key in keys:
        est, ref, sig = [], [], []
        for s in accepted:
            e, sg = apply_calibration(s, cal)
            r = participants[s.participant_id].reference.get(key)
            if key in e and r is not None:
                est.append(e[key])
                ref.append(r)
                sig.append(sg.get(key, float("nan")))
        if est:
            measurements[key] = error_metrics(est, ref, sig)

    sizing = None
    if trials and chart_id:
        chart = load_sizing_charts()[chart_id]
        truth_by_p = {t.participant_id: t.best_size for t in trials if t.chart_id == chart_id}
        pred, alt, truth = [], [], []
        for s in accepted:
            if s.participant_id not in truth_by_p:
                continue
            e, sg = apply_calibration(s, cal)
            measured = {k: MeasuredValue(k, v, sg.get(k, 0.0), s.statuses.get(k, "valid")) for k, v in e.items()}
            rec = recommend(chart, measured)
            pred.append(rec.size)
            alt.append(rec.alternative_size)
            truth.append(truth_by_p[s.participant_id])
        sizing = size_accuracy(pred, alt, truth, [b.label for b in chart.sizes])
        sizing["chart_id"] = chart_id

    return {
        "split": split,
        "n_participants": len(ids),
        "n_participants_scanned": len(by_participant),
        "n_scans": len(sscans),
        "scan_rejection_rate": 1 - len(accepted) / len(sscans),
        "first_scan_rejection_rate": first_rejected / len(by_participant),
        "measurements": measurements,
        "sizing": sizing,
    }


def evaluate(participants, scans, cal=None, trials=(), chart_id=None) -> dict:
    check_consistency(participants, scans)
    return {
        "calibration_status": cal.status if cal else "none_applied",
        "calibration_fitted_on_participants": cal.n_participants if cal else 0,
        "headline_split": "test",
        "splits": {sp: evaluate_split(sp, participants, scans, cal, list(trials), chart_id) for sp in ("test", "dev")},
    }


def to_markdown(report: dict) -> str:
    lines = ["# Validation report", ""]
    lines.append(f"Calibration applied: **{report['calibration_status']}** "
                 f"(fitted on {report['calibration_fitted_on_participants']} development participants).")  # fmt: skip
    lines.append("")
    lines.append(
        "Headline results are for the **held-out test split**. Development-split results are shown only for diagnosis."
    )
    for split in ("test", "dev"):
        r = report["splits"][split]
        lines += ["", f"## {split.upper()} split", ""]
        if not r.get("n_scans"):
            lines.append("No scans.")
            continue
        lines.append(
            f"- Participants: {r['n_participants_scanned']} scanned ({r['n_participants']} enrolled), scans: {r['n_scans']}"
        )
        lines.append(
            f"- Scans rejected (rescan required): {r['scan_rejection_rate']:.1%}; first scan rejected: {r['first_scan_rejection_rate']:.1%}"
        )
        lines += ["", "| Measurement | n | MAE (mm) | RMSE (mm) | Bias (mm) | 95% LoA (mm) | p95 abs err (mm) | 95% interval coverage |",
                  "|---|---|---|---|---|---|---|---|"]  # fmt: skip
        for k, m in r["measurements"].items():
            loa = m["limits_of_agreement_mm"]
            cov = f"{m['coverage_95']:.0%}" if "coverage_95" in m else "–"
            lines.append(f"| {k} | {m['n']} | {m['mae_mm']:.1f} | {m['rmse_mm']:.1f} | {m['bias_mm']:+.1f} | "
                         f"{loa[0]:+.1f} … {loa[1]:+.1f} | {m['abs_error_percentiles_mm']['p95']:.1f} | {cov} |")  # fmt: skip
        if r.get("sizing"):
            s = r["sizing"]
            lines += ["", f"Sizing ({s['chart_id']}, n={s['n']}): exact {s['exact_accuracy']:.1%}, "
                          f"adjacent {s['adjacent_accuracy']:.1%}, recommended-or-alternative "
                          f"{s['recommended_or_alternative_accuracy']:.1%}, no recommendation {s['no_recommendation_rate']:.1%}"]  # fmt: skip
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("participants", type=Path)
    ap.add_argument("scans", type=Path)
    ap.add_argument("--calibration", type=Path)
    ap.add_argument("--fit-trials", type=Path)
    ap.add_argument("--chart")
    ap.add_argument("--out", type=Path, default=Path("validation_report"))
    args = ap.parse_args()
    cal = None
    if args.calibration:
        cal = MeasurementCalibration.model_validate_json(args.calibration.read_text(encoding="utf-8"))
    report = evaluate(
        load_participants(args.participants), load_scans(args.scans), cal, load_fit_trials(args.fit_trials), args.chart
    )
    args.out.with_suffix(".json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    args.out.with_suffix(".md").write_text(to_markdown(report), encoding="utf-8")
    print(to_markdown(report))


if __name__ == "__main__":
    main()
