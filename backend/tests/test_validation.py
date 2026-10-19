"""Validation-pipeline arithmetic, checked on small synthetic tables.

These numbers are invented to test the code paths; they are not validation results.
"""

import csv
import math

import numpy as np
import pytest

from validation.dataset import DatasetError, Participant, Scan, check_consistency, load_participants, load_scans
from validation.evaluate import evaluate, to_markdown
from validation.fit_calibration import fit, fit_entry
from validation.metrics import error_metrics, size_accuracy


def test_error_metrics_known_values():
    m = error_metrics([101, 99, 103, 97], [100, 100, 100, 100], sigmas=[1, 1, 1, 1])
    assert m["n"] == 4
    assert m["mae_mm"] == pytest.approx(2.0)
    assert m["rmse_mm"] == pytest.approx(math.sqrt((1 + 1 + 9 + 9) / 4))
    assert m["bias_mm"] == pytest.approx(0.0)
    assert m["coverage_95"] == pytest.approx(0.5)  # |1| <= 1.96 < |3|
    assert sum(m["error_histogram"]["counts"]) == 4


def test_error_metrics_bias():
    m = error_metrics([105, 106, 104], [100, 100, 100])
    assert m["bias_mm"] == pytest.approx(5.0)
    assert m["limits_of_agreement_mm"][0] < 5 < m["limits_of_agreement_mm"][1]


def test_size_accuracy():
    order = ["S", "M", "L", "XL"]
    r = size_accuracy(["M", "L", "S", None], ["L", None, "M", None], ["M", "M", "L", "M"], order)
    assert r["exact_accuracy"] == pytest.approx(1 / 4)
    assert r["adjacent_accuracy"] == pytest.approx(2 / 4)
    assert r["recommended_or_alternative_accuracy"] == pytest.approx(1 / 4)
    assert r["no_recommendation_rate"] == pytest.approx(1 / 4)


def test_fit_entry_recovers_offset_and_scale():
    rng = np.random.default_rng(0)
    raw = rng.uniform(160, 210, 60)
    ref = 1.02 * raw - 6.0 + rng.normal(0, 1.0, 60)
    e = fit_entry(raw, ref)
    assert e.scale == pytest.approx(1.02, abs=0.02)
    assert e.residual_sd_mm == pytest.approx(1.0, abs=0.3)
    small = fit_entry(raw[:10], raw[:10] + 4.0)
    assert (small.scale, small.offset_mm) == (1.0, pytest.approx(4.0))


def _synthetic_study(n=40, offset=-6.0, seed=0):
    rng = np.random.default_rng(seed)
    participants, scans = {}, []
    for i in range(n):
        pid = f"P-{i:04d}"
        ref_len = rng.uniform(165, 205)
        participants[pid] = Participant(pid, "dev" if i < n // 2 else "test", {"hand_length_mm": ref_len})
        for j in range(2):
            est = ref_len - offset + rng.normal(0, 2.0)
            accepted = not (j == 0 and i % 5 == 0)
            scans.append(
                Scan(
                    pid,
                    f"S{j}",
                    accepted,
                    "uncalibrated",
                    {"hand_length_mm": est},
                    {"hand_length_mm": 6.0},
                    {"hand_length_mm": "valid"},
                )
            )
    return participants, scans


def test_fit_uses_dev_split_only_and_improves_test_error():
    participants, scans = _synthetic_study()
    cal = fit(participants, scans)
    assert cal.status == "calibrated" and cal.n_participants == 20
    assert cal.measurements["hand_length_mm"].offset_mm == pytest.approx(-6.0, abs=1.5)
    before = evaluate(participants, scans)["splits"]["test"]["measurements"]["hand_length_mm"]
    after = evaluate(participants, scans, cal)["splits"]["test"]["measurements"]["hand_length_mm"]
    assert abs(after["bias_mm"]) < abs(before["bias_mm"])
    assert after["mae_mm"] < before["mae_mm"]


def test_fit_refuses_calibrated_inputs():
    participants, scans = _synthetic_study()
    scans[0].calibration_status = "calibrated"
    scans[0].accepted = True
    with pytest.raises(DatasetError):
        fit(participants, scans)


def test_fit_requires_minimum_participants():
    participants, scans = _synthetic_study(n=8)
    with pytest.raises(DatasetError):
        fit(participants, scans)


def test_report_rejection_rates_and_headline():
    participants, scans = _synthetic_study()
    rep = evaluate(participants, scans)
    test = rep["splits"]["test"]
    assert rep["headline_split"] == "test"
    assert test["first_scan_rejection_rate"] == pytest.approx(4 / 20)
    assert test["scan_rejection_rate"] == pytest.approx(4 / 40)
    md = to_markdown(rep)
    assert "held-out test split" in md and "| hand_length_mm |" in md


def test_participant_in_two_splits_rejected(tmp_path):
    p = tmp_path / "participants.csv"
    p.write_text("participant_id,split,ref_hand_length_mm\nP-1,dev,180\nP-1,test,180\n")
    with pytest.raises(DatasetError):
        load_participants(p)


def test_unknown_participant_in_scans():
    with pytest.raises(DatasetError):
        check_consistency({}, [Scan("P-x", "S0", True, "uncalibrated")])


def test_csv_roundtrip(tmp_path):
    p = tmp_path / "scans.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "participant_id",
                "scan_id",
                "status",
                "calibration_status",
                "rejection_codes",
                "est_hand_length_mm",
                "sd_hand_length_mm",
                "status_hand_length_mm",
            ]
        )
        w.writerow(["P-1", "S0", "accepted", "uncalibrated", "", "182.5", "6.1", "valid"])
        w.writerow(["P-1", "S1", "rejected", "uncalibrated", "coin_glare;coin_blurry", "", "", ""])
    scans = load_scans(p)
    assert scans[0].estimates == {"hand_length_mm": 182.5} and scans[0].accepted
    assert scans[1].rejection_codes == ["coin_glare", "coin_blurry"] and not scans[1].accepted
