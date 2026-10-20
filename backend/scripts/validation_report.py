"""Validation report with three strictly separate parts:

1. Real physical measurements: real-participant records from validation mode (camera estimate
   vs. ruler / tape readings taken by docs/PILOT_PROTOCOL.md).
2. Synthetic software tests: the pytest suite (rendered images, constructed landmarks).
3. Simulated camera experiments: the production engine on pinhole-camera simulations.

Only part 1 says anything about real-world performance, and only for the people measured.
Parts 2 and 3 show that the software computes geometry as designed.

Usage (from backend/)::

    python -m scripts.validation_report [--records PATH] [--out PATH] [--no-pytest] [--no-simulation]

The default output, data/validation/report.md, contains pilot data and is not committed.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from glovesize import validation_records as vr
from glovesize.config import REPO_ROOT

BACKEND = REPO_ROOT / "backend"


def _f(v, d: int = 1, sign: bool = False) -> str:
    if v is None:
        return "n/a"
    return f"{v:+.{d}f}" if sign else f"{v:.{d}f}"


def _stats_rows(label: str, d: dict) -> list[str]:
    if d.get("n", 0) == 0:
        return [f"| {label} | 0 | n/a | n/a | n/a | n/a | n/a | n/a |"]
    return [
        f"| {label} | {d['n']} | {_f(d['mean_signed_error_mm'], 2, True)} | {_f(d['mae_mm'], 2)} | {_f(d['rmse_mm'], 2)} "
        f"| {_f(d['median_abs_error_mm'], 2)} | {_f(d['max_abs_error_mm'], 2)} | {_f(d['error_sd_mm'], 2)} |"
    ]


def real_section(records: list[vr.ValidationRecord], unreadable: int) -> list[str]:
    s = vr.summarize(records, unreadable)
    rw, acc, sc = s["real_world"], s["real_world"]["accuracy"], s["real_world"]["scans"]
    flags = s["record_flags"]
    cal = s["calibration"]
    out = [
        "## 1. Real physical measurements",
        "",
        f"Source: `{vr.store_path()}`. Configuration `{s['config_fingerprint']}`. Calibration: "
        f"**{cal['status']}**, {'validated' if cal['validated'] else '**not validated** (unvalidated prototype)'}.",
        "",
        f"* Participants: {rw['participants']}; hands: {rw['hands']}",
        f"* Scans: {sc['total']} ({sc['accepted']} passed quality checks, {sc['rejected']} rejected"
        + (f", {sc['rejected_pct']:.0f}%" if sc["rejected_pct"] is not None else "")
        + ")",
        f"* Rejection reasons: {', '.join(f'{k} ({v})' for k, v in sorted(rw['scans']['rejection_reasons'].items())) or 'none'}",
        f"* Accepted scans without a hand-length estimate: {sc['accepted_without_estimate']}",
        f"* Physical references: {', '.join(f'{k} {v}' for k, v in sorted(rw['references'].items())) or 'none'}",
        f"* Excluded from all statistics: {', '.join(f'{k} {v}' for k, v in sorted(s['excluded'].items()) if v) or 'none'}",
        f"* Per-frame data stored for {sum(r.frames_stored for r in records if r.data_origin == 'real_participant')} of "
        f"{sum(r.data_origin == 'real_participant' for r in records)} real-participant scans; configuration versions: "
        f"{', '.join(sorted({r.config_fingerprint for r in records})) or 'none'}",
        "",
        f"> {acc['sample_note']}",
        "",
    ]
    if rw["scans"]["total"] == 0:
        out += ["No real-participant scans have been recorded, so no real-world result can be reported.", ""]
        return out

    out += [
        "### Hand length: camera estimate minus physical reference",
        "",
        f"Scope: {acc['scope']}. Errors in mm; positive means the camera reads long.",
        "",
        "| Unit of analysis | n | Mean signed error (bias) | MAE | RMSE | Median abs | Max abs | SD |",
        "|---|---|---|---|---|---|---|---|",
        *_stats_rows("Scan", acc["by_scan"]),
        *_stats_rows("Hand (mean of its scans)", acc["by_hand"]),
        "",
        f"Within the camera's reported 95% interval: {acc['within_reported_95_interval']['count']} of "
        f"{acc['within_reported_95_interval']['of']} scans.",
        "",
    ]
    hist = acc["by_scan"].get("histogram")
    if hist:
        out += ["Error distribution (scans, 2 mm bins):", "", "```"]
        edges, counts = hist["bin_edges_mm"], hist["counts"]
        if hist["below"]:
            out.append(f"   < -20 mm  {'#' * hist['below']} {hist['below']}")
        for lo, hi, n in zip(edges[:-1], edges[1:], counts, strict=True):
            if n:
                out.append(f"[{lo:+4.0f},{hi:+4.0f}) mm  {'#' * n} {n}")
        if hist["above"]:
            out.append(f"  >= +20 mm  {'#' * hist['above']} {hist['above']}")
        out += ["```", ""]

    out += [
        "### Individual results",
        "",
        "| When | Participant | Hand | Condition | Reference mm (readings) | Camera mm (±1 sd) | Error mm | Error % | Scan | Flags |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in records:
        if r.data_origin != "real_participant":
            continue
        c = next((c for c in r.comparisons if c.key == "hand_length_mm"), None)
        rs = r.reference_summary
        est = f"{c.estimate_mm:.1f} ± {c.uncertainty_mm:.1f}" if c and c.estimate_mm is not None else "n/a"
        scan = "passed" if r.quality_passed else "rejected: " + ", ".join(r.scan_rejection_reasons)
        out.append(
            f"| {r.created_at[:16].replace('T', ' ')} | {r.participant_code} | {r.trial.hand} | {r.trial.condition} "
            f"| {rs.hand_length_mm:.1f} ({rs.reliability}; {', '.join(f'{x:.1f}' for x in rs.readings_mm)}) | {est} "
            f"| {_f(c.signed_error_mm if c else None, 1, True)} | {_f(c.pct_error if c else None, 2, True)} | {scan} "
            f"| {', '.join(flags.get(r.id, [])) or ''} |"
        )
    out.append("")

    src = rw["by_reference_source"]
    out += [
        "### By who took the physical readings",
        "",
        "Self-measured references (remote pilot, protocol HL-1-self) are less reliable than operator-measured ones,",
        "so the two are never pooled. Unit: hand, standard-condition scans.",
        "",
        "| Readings taken by | Scans | Hands scored | Mean signed error | MAE | RMSE | Median abs | Max abs |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for source, label in (("operator", "Operator"), ("participant", "Participant (self)")):
        d, h = src[source], src[source]["by_hand"]
        out.append(
            f"| {label} | {d['scans']} | {d['hands_scored']} | {_f(h.get('mean_signed_error_mm'), 2, True)} "
            f"| {_f(h.get('mae_mm'), 2)} | {_f(h.get('rmse_mm'), 2)} | {_f(h.get('median_abs_error_mm'), 2)} "
            f"| {_f(h.get('max_abs_error_mm'), 2)} |"
        )
    out.append("")

    out += [
        "### Per participant (one row per hand)",
        "",
        "Errors are from that hand's standard-condition scans with agreed physical readings.",
        "",
        "| Participant | Hand | Reference mm | Scans | Rejected | Standard scored | Mean signed error | MAE | Error range | Other conditions (n, mean) |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for row in rw["by_participant"]:
        rng = row["standard_error_range_mm"]
        out.append(
            f"| {row['participant_code']} | {row['hand']} | {_f(row['reference_mm'])} ({row['reference_reliability']}) "
            f"| {row['scans']} | {row['rejected']} | {row['standard_scored']} "
            f"| {_f(row['standard_mean_signed_error_mm'], 2, True)} | {_f(row['standard_mae_mm'], 2)} "
            f"| {f'{rng[0]:+.1f} to {rng[1]:+.1f}' if rng else 'n/a'} "
            f"| {row['other_conditions_scored']}, {_f(row['other_conditions_mean_signed_error_mm'], 2, True)} |"
        )
    dist = rw["by_distance"]
    out += [
        "",
        "### By camera distance",
        "",
        f"Scope: {dist['scope']}. Within a band each hand counts once (mean of its scans there). Bands with fewer "
        f"than {dist['min_hands_per_band']} hands are listed but not interpreted.",
        "",
    ]
    for key, title in (("operator_measured", "Operator-measured distance"), ("coin_implied", "Coin-implied distance")):
        part = dist[key]
        out += [
            f"**{title}.** {part['note']} Scans without a distance: {part['without_distance']}.",
            "",
            "| Band | Scans | Rejected | Scored scans | Hands | Mean signed error | MAE | Interpretable |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for b in part["rows"]:
            out.append(
                f"| {b['band']} | {b['scans']} | {b['rejected']} | {b['scans_scored']} | {b['hands_scored']} "
                f"| {_f(b['mean_signed_error_mm'], 2, True)} | {_f(b['mae_mm'], 2)} | {'yes' if b['sufficient'] else 'no (too few hands)'} |"
            )
        out.append("")

    out += [
        "### By capture condition",
        "",
        "| Condition | Scans | Rejected | Scored | Mean signed error | MAE |",
        "|---|---|---|---|---|---|",
    ]
    for cond, d in rw["conditions"].items():
        out.append(
            f"| {cond} | {d['scans']} | {d['rejected']} | {d['scored']} | {_f(d['mean_signed_error_mm'], 2, True)} | {_f(d['mae_mm'], 2)} |"
        )
    rep = rw["repeatability"]
    out += [
        "",
        "### Repeatability (same hand, repeated scans)",
        "",
        f"> {rep['note']}",
        "",
        f"* Hands with two or more standard scans: {rep['hands_with_repeats']}",
        f"* Pooled within-hand SD: {_f(rep['within_hand_sd_mm'], 2)} mm; repeatability coefficient (2.77 × SD): "
        f"{_f(rep['repeatability_coefficient_mm'], 2)} mm",
        "",
    ]
    if rep["per_hand"]:
        out += ["| Participant | Hand | Standard scans | Mean mm | SD mm | Range mm |", "|---|---|---|---|---|---|"]
        out += [
            f"| {h['participant_code']} | {h['hand']} | {h['n']} | {h['mean_mm']:.1f} | {h['sd_mm']:.2f} | {h['range_mm']:.2f} |"
            for h in rep["per_hand"]
        ]
        out.append("")
    if rep["condition_shifts"]:
        out += [
            "Shift of the camera estimate from the same hand's standard scans:",
            "",
            "| Condition | Hands | Mean shift mm | Largest shift mm | Larger than repeatability coefficient |",
            "|---|---|---|---|---|",
        ]
        for cond, d in rep["condition_shifts"].items():
            exceeds = {True: "yes", False: "no", None: "n/a"}[d["exceeds_repeatability"]]
            out.append(
                f"| {cond} | {d['n_hands']} | {d['mean_shift_mm']:+.2f} | {d['max_abs_shift_mm']:.2f} | {exceeds} |"
            )
        out.append("")
    return out


def pytest_section() -> list[str]:
    out = [
        "## 2. Synthetic software tests",
        "",
        "Rendered coin images, constructed landmarks, synthetic scans and in-memory records. These check that",
        "the algorithms and arithmetic behave as designed. **They are not measurements of real hands.**",
        "",
    ]
    with tempfile.TemporaryDirectory() as tmp:
        xml = Path(tmp) / "junit.xml"
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:warnings", f"--junitxml={xml}"],
            cwd=BACKEND, capture_output=True, text=True, env=env, check=False,
        )  # fmt: skip
        if not xml.exists():
            return [*out, f"pytest did not produce results (exit {proc.returncode}).", ""]
        per_file: Counter = Counter()
        outcome: Counter = Counter()
        for case in ET.parse(xml).getroot().iter("testcase"):
            per_file[case.get("classname", "")] += 1
            kind = next((c.tag for c in case if c.tag in ("failure", "error", "skipped")), "passed")
            outcome[kind] += 1
    out += [
        f"Result: {outcome['passed']} passed, {outcome['failure']} failed, {outcome['error']} errors, "
        f"{outcome['skipped']} skipped (pytest exit code {proc.returncode}).",
        "",
        "| Test module | Tests |",
        "|---|---|",
        *[f"| `{k}` | {v} |" for k, v in sorted(per_file.items())],
        "",
    ]
    return out


def simulation_section() -> list[str]:
    from glovesize.config import load_measurement_config
    from glovesize.simulation import true_hand_length_mm

    from .calibration_study import SCENARIOS, measure

    cfg = load_measurement_config()
    out = [
        "## 3. Simulated camera experiments",
        "",
        "The production measurement engine and configuration on pinhole-camera simulations of a 185 mm hand",
        "(`glovesize/simulation.py`). These show systematic geometric effects under stated assumptions.",
        "**They are not measurements of real hands.** Method comparison: `docs/CALIBRATION_STUDY.md`.",
        "",
        "| Simulated scenario | Hand-length error |",
        "|---|---|",
    ]
    for name, scene in SCENARIOS:
        truth = true_hand_length_mm(scene)
        v, why = measure(scene, cfg)
        out.append(f"| {name} | {'rejected (' + why + ')' if v is None else f'{100 * (v - truth) / truth:+.2f}%'} |")
    return [*out, ""]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--records", type=Path, help="validation records file (default: GLOVESIZE_VALIDATION_PATH)")
    ap.add_argument("--out", type=Path, default=REPO_ROOT / "data" / "validation" / "report.md")
    ap.add_argument("--no-pytest", action="store_true", help="skip running the synthetic test suite")
    ap.add_argument("--no-simulation", action="store_true", help="skip the simulated camera experiments")
    args = ap.parse_args()
    if args.records:
        os.environ["GLOVESIZE_VALIDATION_PATH"] = str(args.records)
    records, unreadable = vr.read_store()

    lines = [
        "# Hand measurement validation report",
        "",
        f"Generated {datetime.now(UTC).isoformat(timespec='seconds')}. This system is an **unvalidated prototype**.",
        "The three parts below come from different kinds of evidence and must not be combined.",
        "",
        *real_section(records, unreadable),
        *(pytest_section() if not args.no_pytest else ["## 2. Synthetic software tests", "", "Not run (--no-pytest).", ""]),
        *(
            simulation_section()
            if not args.no_simulation
            else ["## 3. Simulated camera experiments", "", "Not run (--no-simulation).", ""]
        ),
    ]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
