"""Thumb accuracy in simulation: the thumb's length for several thumb poses, as the engine measures it today and with the optional
depth-aware thumb (config finger_accuracy.thumb_depth_aware).  EVERYTHING HERE IS SIMULATED (pinhole camera, exact geometry, the
real engine, the model's landmark hand shape from two real photos, world-landmark noise matched to those photos' depth bend).
The error is against the simulated 3D thumb chain (MCP to IP to tip landmark), not the skin.

Usage (from backend/):  python -m scripts.thumb_study [--scans 100]
"""

from __future__ import annotations

import argparse
from dataclasses import replace

from glovesize.config import load_measurement_calibration, load_measurement_config

from .finger_accuracy_study import TYPICAL, Condition, evaluate


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scans", type=int, default=100)
    a = ap.parse_args()
    cfg, calib = load_measurement_config(), load_measurement_calibration()
    fa = cfg.finger_accuracy
    on = cfg.model_copy(update={"finger_accuracy": fa.model_copy(update={"thumb_depth_aware": True})})
    rows = []
    for label, scene in (
        ("thumb in plane (0 deg)", replace(TYPICAL, finger_pitch_deg={"thumb": 0.0})),
        ("thumb 10 deg out of plane", replace(TYPICAL, finger_pitch_deg={"thumb": 10.0})),
        ("thumb 20 deg out of plane", replace(TYPICAL, finger_pitch_deg={"thumb": 20.0})),
        ("thumb 30 deg out of plane", replace(TYPICAL, finger_pitch_deg={"thumb": 30.0})),
        ("thumb 40 deg out of plane", replace(TYPICAL, finger_pitch_deg={"thumb": 40.0})),
        ("thumb 20 deg, world depth noise x2 (6 mm)", replace(TYPICAL, finger_pitch_deg={"thumb": 20.0}, world_noise_mm=3.0, world_z_noise_mm=6.0)),
        ("thumb 20 deg, hand tilted 6 deg", replace(TYPICAL, finger_pitch_deg={"thumb": 20.0}, tilt_deg=6.0)),
    ):
        c = Condition(label, scene)
        rows.append((label, evaluate(c, a.scans, cfg, calib)["thumb"], evaluate(c, a.scans, on, calib)["thumb"]))
    print(f"### Thumb length error, {a.scans} simulated scans per row (SIMULATED), mm: bias / SD / RMSE\n")
    print("| thumb pose | production | depth-aware thumb (optional) |")
    print("|---|---|---|")
    for label, p, d in rows:
        f = lambda s: "hidden" if s.shown == 0 else f"{s.bias:+.2f} / {s.sd:.2f} / {s.rmse:.2f}"  # noqa: E731
        print(f"| {label} | {f(p)} | {f(d)} |")


if __name__ == "__main__":
    main()
