"""Comparison-study tooling (validation/comparison.py).

All participants, measurements and photos here are CONSTRUCTED test fixtures with known
answers. They check the arithmetic and data handling of the pre-specified analysis; they are
not study results.
"""

import json
import math

import cv2
import numpy as np
import pytest

from experimental.paper_method.synthetic import PaperScene, render
from validation import comparison as cmp


def test_randomisation_is_balanced_reproducible_and_seed_dependent():
    a = cmp.randomise(40, seed=11)
    assert a == cmp.randomise(40, seed=11)
    assert a != cmp.randomise(40, seed=12)
    for i in range(0, 40, 4):
        block = [r["order"] for r in a[i : i + 4]]
        assert block.count("coin_first") == block.count("paper_first") == 2
    assert [r["slot_number"] for r in a] == list(range(1, 41))
    with pytest.raises(ValueError):
        cmp.randomise(10, seed=1, block=3)


def test_required_n_matches_the_standard_paired_t_value():
    # Effect size 0.5 (delta 1 mm, SD of differences 2 mm), alpha 0.05 two-sided, power 0.8: 34 pairs.
    assert cmp.required_n(1.0, 2.0) == 34
    # Effect size 0.25 (SD of differences 4 mm): 128 pairs. Doubling the SD roughly quadruples n.
    assert cmp.required_n(1.0, 4.0) == 128


def test_sd_of_paired_difference_is_not_the_sd_of_individual_errors():
    assert cmp.sd_paired_signed_difference(4.0, 3.0, 0.0) == pytest.approx(5.0)
    assert cmp.sd_paired_signed_difference(4.0, 3.0, 0.5) == pytest.approx(math.sqrt(13.0))
    # Shared reference error cancels in the signed difference but correlates the absolute errors.
    sim = cmp.simulate_abs_error_difference(300, cmp.ErrorModel(0, 4), cmp.ErrorModel(0, 4), ref_sd=1.0, reps=300)
    assert abs(sim["true_mean_difference_mm"]) < 0.2
    assert sim["sd_of_difference_mm"] < 4.0


def test_simulated_power_behaves():
    same = cmp.simulate_abs_error_difference(40, cmp.ErrorModel(0, 3), cmp.ErrorModel(0, 3), 1.0, reps=2000)
    assert same["power_two_sided"] == pytest.approx(0.05, abs=0.025)  # no true difference: type I error
    worse = cmp.simulate_abs_error_difference(60, cmp.ErrorModel(0, 6), cmp.ErrorModel(0, 3), 1.0, reps=1000)
    assert worse["true_mean_difference_mm"] > 1.5 and worse["power_two_sided"] > 0.8


def test_slot_assignment_follows_the_protocol_sequence():
    tries = [("rejected", None, "coin_tilted"), ("accepted", 181.0, ""), ("accepted", 182.0, ""),
             ("rejected", None, "a"), ("rejected", None, "b"), ("rejected", None, "c"),
             ("accepted", 183.0, ""), ("accepted", 199.0, "")]  # fmt: skip
    rows = cmp.assign_slots(tries)
    assert [(r["slot"], r["try"], r["status"]) for r in rows] == [
        ("1", 1, "rejected"), ("1", 2, "accepted"), ("2", 1, "accepted"),
        ("3", 1, "rejected"), ("3", 2, "rejected"), ("3", 3, "rejected"),
        ("self", 1, "accepted"), ("extra", None, "accepted"),
    ]  # fmt: skip


@pytest.mark.parametrize(
    ("readings", "expected"),
    [([180, 181, None], (180.5, "agreed")), ([180, None, None], (None, "not_repeated")),
     ([180, 184, None], (None, "discrepant")), ([180, 184, 183], (183, "agreed")), ([175, 180, 185], (None, "discrepant"))],
)  # fmt: skip
def test_reference_rule(readings, expected):
    assert cmp.reference_value(readings) == expected


def test_import_coin_records_uses_only_real_standard_scans(tmp_path):
    def rec(code, t, ok, est, origin="real_participant", cond="standard"):
        return {"participant_code": code, "created_at": f"2026-11-01T10:00:{t:02d}+00:00", "data_origin": origin,
                "trial": {"hand": "right", "condition": cond}, "quality_passed": ok,
                "scan_rejection_reasons": [] if ok else ["coin_tilted"],
                "comparisons": [{"key": "hand_length_mm", "estimate_mm": est}] if ok else []}  # fmt: skip

    lines = [rec("P-AAAAAA", 3, True, 182.0), rec("P-AAAAAA", 1, False, None), rec("P-AAAAAA", 5, True, 183.5),
             rec("P-AAAAAA", 7, True, 150.0, origin="software_test"), rec("P-AAAAAA", 8, True, 150.0, cond="distance_far")]  # fmt: skip
    path = tmp_path / "records.jsonl"
    path.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    rows = cmp.import_coin_records(path)
    assert [(r["slot"], r["try"], r["status"], r["hand_length_mm"]) for r in rows] == [
        ("1", 1, "rejected", None), ("1", 2, "accepted", 182.0), ("2", 1, "accepted", 183.5)]  # fmt: skip


def test_process_paper_photos_and_delete_only_processed_files(tmp_path):
    img, _ = render(PaperScene())
    cv2.imwrite(str(tmp_path / "P-AAAAAA_paper_1_t1.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cv2.imwrite(str(tmp_path / "P-AAAAAA_paper_self_t1.png"), img)
    (tmp_path / "holiday.jpg").write_bytes(b"not a protocol photo")
    rows, skipped = cmp.process_paper_photos(tmp_path, "a4", delete_processed=True)
    assert skipped == ["holiday.jpg"]
    assert {(r["slot"], r["status"]) for r in rows} == {("1", "accepted"), ("self", "accepted")}
    assert all(r["hand_length_mm"] == pytest.approx(185.0, abs=1.5) for r in rows)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["holiday.jpg"]


# --------------------------------------------------------------------------- #
# Pre-specified analysis on constructed data
# --------------------------------------------------------------------------- #

REF = {"C1": 180.0, "C2": 185.0, "C3": 190.0, "C4": 175.0, "F1": 200.0, "C5": 170.0}
COIN_ERR = {"C1": 4.0, "C2": -3.0, "C3": 2.0, "C4": 5.0, "F1": 30.0}
PAPER_ERR = {"C1": 1.0, "C2": -2.0, "C3": 3.0, "C4": 1.0, "F1": 30.0}


def study():
    participants = [{"participant_code": c, "phase": "feasibility" if c == "F1" else "confirmatory", "order": "coin_first"}
                    for c in REF]  # fmt: skip
    reference = [{"participant_code": c, "hand": "right", "length_r1": v, "length_r2": v + 1.0, "length_r3": "",
                  "breadth_r1": 84.0, "breadth_r2": 84.0, "breadth_r3": ""} for c, v in REF.items()]  # fmt: skip
    reference[-1]["length_r2"] = REF["C5"] + 6.0  # C5: readings disagree, no usable reference
    attempts = []

    def add(code, method, slot, try_, status, value, breadth=None):
        attempts.append({"participant_code": code, "method": method, "slot": slot, "try": str(try_), "status": status,
                         "reasons": "", "hand_length_mm": "" if value is None else value,
                         "hand_breadth_mm": "" if breadth is None else breadth})  # fmt: skip

    for c in COIN_ERR:
        ref = REF[c] + 0.5  # mean of the two readings
        add(c, "coin", "1", 1, "accepted", ref + COIN_ERR[c])
        add(c, "paper", "1", 1, "accepted", ref + PAPER_ERR[c], breadth=85.0)
    add("C2", "coin", "1", 1, "rejected", None)  # an earlier rejected try in slot 1 (try numbering)
    attempts[-1]["try"] = "0"
    for v in (186.5, 182.5):  # C1 coin slots 2-3: with slot 1 (184.5) -> SD 2.0
        add("C1", "coin", "2" if v == 186.5 else "3", 1, "accepted", v)
    for s in ("2", "3"):
        add("C1", "paper", s, 1, "accepted", 181.5)
    add("C1", "coin", "self", 1, "accepted", 181.5)
    for t in (1, 2, 3):
        add("C1", "paper", "self", t, "rejected", None)
    add("C5", "coin", "1", 1, "accepted", 171.0)
    add("C5", "paper", "1", 1, "accepted", 171.0)
    usability = [{"participant_code": c, "method": m, "seconds_to_first_accepted": s, "ease_1to7": e}
                 for c in ("C1", "C2") for m, s, e in (("coin", "60", "5"), ("paper", "90", "4"))]  # fmt: skip
    return participants, reference, attempts, usability


def test_primary_paired_analysis_exact():
    p, r, a, u = study()
    res = cmp.analyse(p, r, a, u, phase="confirmatory", delta_mid=1.5)
    pr = res["primary"]
    # D = |coin| - |paper| = 3, 1, -1, 4 for C1..C4; C5 has no usable reference; F1 is feasibility.
    assert pr["n_pairs"] == 4 and res["excluded_from_primary"] == 1
    assert pr["mean_D_mm"] == pytest.approx(1.75)
    sd = float(np.std([3, 1, -1, 4], ddof=1))
    assert pr["sd_D_mm"] == pytest.approx(sd)
    half = 3.182446 * sd / 2
    assert pr["ci95_t_mm"] == pytest.approx([1.75 - half, 1.75 + half], abs=1e-4)
    assert pr["criterion_paper_better"] is False and pr["criterion_coin_better"] is False  # CI includes 0
    coin, paper = res["accuracy_slot1"]["coin"], res["accuracy_slot1"]["paper"]
    assert (coin["bias_mm"], coin["mae_mm"]) == (pytest.approx(2.0), pytest.approx(3.5))
    assert (paper["bias_mm"], paper["mae_mm"]) == (pytest.approx(0.75), pytest.approx(1.75))
    assert res["references"] == {"agreed": 4, "discrepant": 1}


def test_feasibility_participants_never_enter_the_confirmatory_analysis():
    p, r, a, u = study()
    conf = cmp.analyse(p, r, a, u, phase="confirmatory")
    feas = cmp.analyse(p, r, a, u, phase="feasibility")
    assert conf["participants_in_phase"] == 5 and feas["participants_in_phase"] == 1
    assert feas["primary"]["n_pairs"] == 1 and feas["primary"]["mean_D_mm"] == pytest.approx(0.0)
    assert 30.0 not in [abs(x) for x in conf["accuracy_slot1"]["coin"].values() if isinstance(x, float)]


def test_secondary_outcomes():
    p, r, a, u = study()
    sec = cmp.analyse(p, r, a, u)["secondary"]
    assert sec["coin"]["within_participant_sd_mm"] == pytest.approx(2.0)
    assert sec["paper"]["within_participant_sd_mm"] == pytest.approx(0.0)
    assert sec["coin"]["self_capture_success"] == "1/5" and sec["paper"]["self_capture_success"] == "0/5"
    assert sec["coin"]["self_capture_accuracy"]["bias_mm"] == pytest.approx(1.0)
    assert sec["paper"]["rejected_tries"] == 3 and sec["coin"]["rejected_tries"] == 1
    assert sec["paper_breadth_slot1"]["bias_mm"] == pytest.approx(1.0)
    assert sec["usability"]["ease_median"] == {"coin": 5.0, "paper": 4.0}
    assert sec["usability"]["seconds_median"] == {"coin": 60.0, "paper": 90.0}


def test_report_and_cli(tmp_path):
    p, r, a, u = study()
    files = {}
    for name, rows in (("p", p), ("r", r), ("a", a), ("u", u)):
        path = tmp_path / f"{name}.csv"
        cmp._write_csv(path, rows, list(rows[0].keys()))
        files[name] = path
    out = tmp_path / "report.md"
    cmp.main(["analyse", "--participants", str(files["p"]), "--reference", str(files["r"]), "--attempts", str(files["a"]),
              "--usability", str(files["u"]), "--delta-mid", "1.5", "--out", str(out)])  # fmt: skip
    text = out.read_text(encoding="utf-8")
    assert "## Primary outcome" in text and "mean D = 1.75 mm" in text
    assert "paper criterion not met" in text and "do not choose a method by themselves" in text
    alloc = tmp_path / "alloc.csv"
    cmp.main(["randomise", "--n", "8", "--seed", "3", "--out", str(alloc)])
    assert alloc.read_text(encoding="utf-8").count("first") == 8


def test_nuisance_parameters_hide_every_comparison_of_means():
    p, r, a, u = study()
    nui = cmp.nuisance_parameters(cmp.analyse(p, r, a, u, phase="confirmatory"))
    text = json.dumps(nui)
    for leaked in ("mean_D", "bias", "mae", "rmse", "ci95", "criterion", "wilcoxon"):
        assert leaked not in text
    assert nui["sd_D_mm"] == pytest.approx(float(np.std([3, 1, -1, 4], ddof=1)))
    assert set(nui["rejection_rate"]) == {"coin", "paper"}


def test_sample_size_reassessment_never_shrinks_and_is_capped():
    assert cmp.reassessed_n(sd_d=2.0, delta=1.0, planned_n=60, max_n=120) == 60  # needs 34: keep the plan
    assert cmp.reassessed_n(sd_d=4.0, delta=1.0, planned_n=60, max_n=120) == 120  # needs 128: capped
    assert cmp.reassessed_n(sd_d=3.0, delta=1.0, planned_n=60, max_n=120) == cmp.required_n(1.0, 3.0)


def test_in_session_paper_processing_appends_and_prints_no_values(tmp_path, capsys):
    img, _ = render(PaperScene())
    out = tmp_path / "attempts.csv"
    for slot in ("1", "2"):
        incoming = tmp_path / f"in{slot}"
        incoming.mkdir()
        cv2.imwrite(str(incoming / f"P-AAAAAA_paper_{slot}_t1.png"), img)
        cmp.main(["process-paper", str(incoming), "--paper", "a4", "--out", str(out), "--append", "--delete-processed"])
    printed = capsys.readouterr().out
    assert "P-AAAAAA slot 1 try 1: accepted" in printed and "18" not in printed  # no millimetre values
    rows = out.read_text(encoding="utf-8").splitlines()
    assert rows[0].startswith("participant_code") and len(rows) == 3
