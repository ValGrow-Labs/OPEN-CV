"""Why the THUMB differs most between scans of one hand, and which fix helps, in simulation.

Repeated SIMULATED scans of one hand through the real engine (glovesize/simulation.py): every scan has its own landmark jitter and
per-scan landmark bias (2 px / 1.5 px, ASSUMED), camera distance and position, and a thumb that is turned out of the palm plane by a
different angle: ``scan pitch ~ N(20, sigma_scan)`` degrees (a relaxed thumb sits 10-40 degrees out of plane: ASSUMED), each frame
drifting around it by ``sigma_frame`` degrees. The outline fingertip is found per finger with probability 0.8 (ASSUMED) and the
phone's per-hand tip rule applies. The thumb's chain foreshortens by 1 - cos(pitch): 20 degrees reads 6% short, 40 degrees 23%.

Variants (the config flags are in finger_accuracy; the tip rule is the phone's, frontend/src/vision/handTips.ts):
  now          hand tip rule for the thumb too, all frames, no depth
  own_tip      the thumb uses its OWN outline extension when found, else its own prior (0.21 of its distal segment, ASSUMED: the two photos)
  best_frames  the thumb value from the half of the frames in which the thumb chord is flattest (thumb_best_frames_frac 0.5)
  depth        the optional depth-aware thumb (thumb_depth_aware)
  depth+best   both of those
  all          own_tip + best_frames + depth

``--world-pitch-bias`` adds a constant pitch error of the model's world frame (ASSUMED), to see what survives a systematic bias.
EVERYTHING HERE IS SIMULATED; nothing is real-world accuracy.  Usage (from backend/):  python -m scripts.thumb_repeat_study [--scans 80]
"""

from __future__ import annotations

import argparse
import math
from dataclasses import replace

import numpy as np

from glovesize.calibration import smoothed_coin_tilts
from glovesize.config import load_measurement_calibration, load_measurement_config
from glovesize.measurement import aggregate_camera, measure_frame
from glovesize.schemas import FrameObservation
from glovesize.simulation import ALL_CHAINS, Scene, hand_points_3d, simulate_frame

from .finger_accuracy_study import QUARTER
from .repeatability_study import FINGERS, TIP, TRUE_RATIO, plan

THUMB_PRIOR = 0.21
MEAS_BIAS, MEAS_SD = -0.013, 0.010


def tips_for(found: dict[str, float], own_thumb: bool) -> dict[str, tuple[float, str]]:
    pl = plan(found, None, "prior_est")
    if own_thumb:
        pl["thumb"] = (found["thumb"], "outline") if "thumb" in found else (THUMB_PRIOR, "estimated")
    return pl


VARIANTS = {
    "now": dict(own=False, frac=1.0, depth=False),
    "own_tip": dict(own=True, frac=1.0, depth=False),
    "best_frames": dict(own=False, frac=0.5, depth=False),
    "depth": dict(own=False, frac=1.0, depth=True),
    "depth+best": dict(own=False, frac=0.5, depth=True),
    "all": dict(own=True, frac=0.5, depth=True),
}


def one_scan(seed, sigma_scan, sigma_frame, bias_deg, p_found, cfg0, calib, ratio_scale=1.0, n=16):
    rng = np.random.default_rng(seed)
    pitch = float(np.clip(rng.normal(20, sigma_scan), 0, 45))
    base = Scene(
        hand_shape="photo", landmark_noise_px=2.0, landmark_bias_px=1.5, world_noise_mm=1.5, world_z_noise_mm=3.0,
        world_pitch_bias_deg=bias_deg, distance_mm=float(rng.uniform(340, 400)),
        offset_mm=(float(rng.uniform(-10, 10)), float(rng.uniform(-10, 10))), seed=seed,
        finger_pitch_deg={f: float(np.clip(rng.normal(3, 3), -3, 10)) for f in FINGERS[1:]},
    )  # fmt: skip
    frames = []
    for _ in range(n):
        p = float(np.clip(pitch + rng.normal(0, sigma_frame), 0, 50))
        frames.append(simulate_frame(replace(base, finger_pitch_deg={**base.finger_pitch_deg, "thumb": p}), rng))
    lm3, _, _ = hand_points_3d(replace(base, finger_pitch_deg={**base.finger_pitch_deg, "thumb": pitch}))
    ch = ALL_CHAINS["thumb"]
    seg = np.linalg.norm(np.diff(lm3[list(ch)], axis=0), axis=1)
    ratio = TRUE_RATIO["thumb"] * ratio_scale
    truth = float(seg.sum() + ratio * seg[-1])
    found = {f: TRUE_RATIO[f] * ratio_scale + MEAS_BIAS + float(rng.normal(0, MEAS_SD)) for f in FINGERS if rng.random() < p_found}
    out = {}
    for name, v in VARIANTS.items():
        fa = cfg0.finger_accuracy.model_copy(update={"thumb_depth_aware": v["depth"], "thumb_best_frames_frac": v["frac"]})
        cfg = cfg0.model_copy(update={"finger_accuracy": fa})
        pl = tips_for(found, v["own"])
        obs = []
        for d in frames:
            d2 = dict(d)
            tips = {}
            for f in FINGERS:
                r, src = pl[f]
                if src == "landmark":
                    continue
                dip, tip = TIP[f]
                t, q = d["landmarks"][tip], d["landmarks"][dip]
                dx, dy = t["x"] - q["x"], t["y"] - q["y"]
                tips[str(tip)] = {"x": t["x"] + r * dx, "y": t["y"] + r * dy, "extension_px": r * math.hypot(dx, dy), "source": "outline"}
            if tips:
                d2["refined_tips"] = tips
            obs.append(FrameObservation.model_validate(d2))
        tilts = smoothed_coin_tilts([f.coin for f in obs], cfg.calibration.tilt_window_frames)
        res = [measure_frame(f, QUARTER, cfg, tilt_deg=t) for f, t in zip(obs, tilts, strict=True)]
        if sum(r.accepted for r in res) < 8:
            out[name] = None
            continue
        m = next(x for x in aggregate_camera(res, cfg, calib).out if x.key == "thumb_length_mm")
        out[name] = (m.value_mm if m.value_mm is not None else m.info_value_mm, m.crease_to_tip_mm)
    return out, truth, pitch


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scans", type=int, default=80)
    ap.add_argument("--world-pitch-bias", type=float, default=0.0)
    ap.add_argument("--ratio-scale", type=float, default=1.0)
    ap.add_argument("--levels", type=float, nargs="*", default=[0, 5, 10, 15])
    a = ap.parse_args()
    cfg, calib = load_measurement_config(), load_measurement_calibration()
    print(f"### Thumb scan-to-scan SD (mm) / bias vs the true skin-tip thumb (mm); thumb pitch ~ N(20, sigma_scan) deg; world pitch bias {a.world_pitch_bias}; true extension x {a.ratio_scale}; {a.scans} scans (SIMULATED)\n")
    print("| sigma_scan | sigma_frame | " + " | ".join(VARIANTS) + " |")
    print("|---|---|" + "---|" * len(VARIANTS))
    rows = [(s, 0.0) for s in a.levels] + [(10.0, 4.0)]
    for s_scan, s_frame in rows:
        vals = {v: [] for v in VARIANTS}
        errs = {v: [] for v in VARIANTS}
        creases = {v: [] for v in VARIANTS}
        for k in range(a.scans):
            out, truth, _ = one_scan(7000 + k, s_scan, s_frame, a.world_pitch_bias, 0.8, cfg, calib, a.ratio_scale)
            for v, r in out.items():
                if r and r[0] is not None:
                    vals[v].append(r[0])
                    errs[v].append(r[0] - truth)
                    creases[v].append(r[1])
        print(f"| {s_scan:g} | {s_frame:g} | " + " | ".join(f"{np.std(vals[v], ddof=1):.2f} / {np.mean(errs[v]):+.2f}" for v in VARIANTS) + " |")
        if s_scan == 10 and s_frame == 0:
            print("|  | crease-to-tip SD | " + " | ".join(f"{np.std([c for c in creases[v] if c is not None], ddof=1):.2f}" for v in VARIANTS) + " |")


if __name__ == "__main__":
    main()
