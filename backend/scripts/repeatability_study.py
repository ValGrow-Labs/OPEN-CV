"""Scan-to-scan repeatability of the finger lengths: why the SAME hand scanned twice reads differently, and what helps.

Repeated SIMULATED scans of one hand (glovesize/simulation.py, the real engine), every scan with its own realistic variation:
landmark jitter and a per-scan landmark bias (ASSUMED sizes), a slightly different hand pose (fingers lifted a few degrees,
the thumb turned out of the palm plane by a varying amount, a small tilt), camera distance and hand position, and the
outline fingertip FOUND or NOT FOUND per finger at random (``p_found``, ASSUMED: nothing in the repository says how often a
real phone finds it). The outline extensions are the ones the two real photos gave (fractions of the distal segment, in
`TRUE_RATIO`); a found tip measures its true extension with the error of the rendered-finger evaluation
(-0.013 +- 0.010 of the segment, SIMULATED).

Policies for what the phone sends (the TypeScript rule in frontend/src/vision/handTips.ts mirrors `plan`):
  landmark   outline_tip off: every tip is the model's tip landmark
  per_finger the first version: a found finger uses its outline tip, an unfound one the landmark (flips by ~6 mm)
  hand_est   a hand needs >= 2 found fingers; unfound fingers get the hand's median extension (labelled "estimated"); fewer
             than 2 found: every tip is the landmark (the whole scan switches together)
  hand_all   as hand_est, but every finger uses the hand's median extension (also the found ones)
  prior_est  as hand_est, but a scan with fewer than 2 found fingers does not fall back to the landmark: it uses an ASSUMED
             prior extension for every finger (labelled "estimated"), so no scan ever switches method
  prior_all  as prior_est, every finger uses the hand's (or the prior) extension
  fixed      no measurement at all: every finger uses the ASSUMED prior extension

Nothing here is real-world accuracy.  Usage (from backend/):  python -m scripts.repeatability_study [--scans 120]
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

FINGERS = ("thumb", "index", "middle", "ring", "little")
TIP = {"thumb": (3, 4), "index": (7, 8), "middle": (11, 12), "ring": (15, 16), "little": (19, 20)}
# Extension of the skin tip beyond the landmark tip as a fraction of the distal segment: what the outline measured on the two
# real photos (mean of both), used here as the simulated truth (ASSUMED to hold for the hand that is rescanned).
TRUE_RATIO = {"thumb": 0.21, "index": 0.27, "middle": 0.25, "ring": 0.345, "little": 0.315}
MEAS_BIAS, MEAS_SD = -0.013, 0.010


def median(v):
    return float(np.median(v))


PRIOR = 0.27  # ASSUMED: the mean extension of the two real photos (one hand); not a population value


def plan(found: dict[str, float], carry: float | None = None, policy: str = "hand_est") -> dict[str, tuple[float, str]]:
    """Per finger (ratio, source) from the ratios the outline found (missing = not found)."""
    if policy == "landmark":
        return {f: (0.0, "landmark") for f in FINGERS}
    if policy == "fixed":
        return {f: (PRIOR, "estimated") for f in FINGERS}
    if policy == "per_finger":
        return {f: (found[f], "outline") if f in found else (0.0, "landmark") for f in FINGERS}
    hand = None
    if len(found) >= 2:
        med = median(list(found.values()))
        if median([abs(r - med) for r in found.values()]) * 1.4826 <= 0.1:
            hand = med
    if hand is None:
        hand = carry
    if hand is None and policy.startswith("prior"):
        hand = PRIOR
    if hand is None:
        return {f: (0.0, "landmark") for f in FINGERS}
    out = {}
    for f in FINGERS:
        if policy in ("hand_all", "prior_all"):
            out[f] = (hand, "estimated")
        elif f in found and abs(found[f] - hand) <= 0.12:
            out[f] = (found[f], "outline")
        else:
            out[f] = (hand, "estimated")
    return out


RATIO_SCALE = 1.0


def one_scan(seed: int, p_found: float, policies: list[str], cfg, calib, n_frames: int = 16):
    rng = np.random.default_rng(seed)
    scene = Scene(
        hand_shape="photo", landmark_noise_px=2.0, landmark_bias_px=1.5, world_noise_mm=1.5, world_z_noise_mm=3.0,
        distance_mm=float(rng.uniform(330, 420)), offset_mm=(float(rng.uniform(-15, 15)), float(rng.uniform(-15, 15))),
        tilt_deg=float(abs(rng.normal(0, 3.0))), tilt_axis_deg=float(rng.uniform(0, 180)), seed=seed,
        finger_pitch_deg={
            "thumb": float(np.clip(rng.normal(20, 8), 0, 45)),
            **{f: float(np.clip(rng.normal(4, 4), -5, 15)) for f in FINGERS[1:]},
        },
    )  # fmt: skip
    # who is found, and what the outline measures (per scan), the same for every policy
    found = {f: TRUE_RATIO[f] * RATIO_SCALE + MEAS_BIAS + float(rng.normal(0, MEAS_SD)) for f in FINGERS if rng.random() < p_found}
    frames = [simulate_frame(scene, rng) for _ in range(n_frames)]
    lm3, _, _ = hand_points_3d(scene)
    truth = {}
    for f in FINGERS:
        chain = ALL_CHAINS[f]
        base = float(np.linalg.norm(np.diff(lm3[list(chain)], axis=0), axis=1).sum())
        distal = float(np.linalg.norm(lm3[chain[-1]] - lm3[chain[-2]]))
        truth[f] = base + TRUE_RATIO[f] * RATIO_SCALE * distal  # chain to the true skin tip
    out = {}
    for pol in policies:
        pl = plan(found, None, pol)
        fr = []
        for d in frames:
            d2 = dict(d)
            tips = {}
            for f in FINGERS:
                ratio, src = pl[f]
                dip, tip = TIP[f]
                t, q = d["landmarks"][tip], d["landmarks"][dip]
                dx, dy = t["x"] - q["x"], t["y"] - q["y"]
                if src == "landmark":
                    continue
                tips[str(tip)] = {
                    "x": t["x"] + ratio * dx, "y": t["y"] + ratio * dy,
                    "extension_px": ratio * math.hypot(dx, dy), "source": "outline",
                }  # fmt: skip
            if tips:
                d2["refined_tips"] = tips
            fr.append(FrameObservation.model_validate(d2))
        tilts = smoothed_coin_tilts([f.coin for f in fr], cfg.calibration.tilt_window_frames)
        res = [measure_frame(f, QUARTER, cfg, tilt_deg=t) for f, t in zip(fr, tilts, strict=True)]
        if sum(r.accepted for r in res) < 8:
            out[pol] = None
            continue
        cam = aggregate_camera(res, cfg, calib)
        vals = {}
        for m in cam.out:
            name = m.key.removesuffix("_length_mm")
            if name in FINGERS:
                vals[name] = m.value_mm if m.value_mm is not None else m.info_value_mm
                vals["c_" + name] = m.crease_to_tip_mm
            if m.key == "hand_length_mm":
                vals["hand"] = m.value_mm
        out[pol] = vals
    return out, truth


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scans", type=int, default=120)
    ap.add_argument("--p", type=float, nargs="*", default=[1.0, 0.8, 0.6, 0.4])
    ap.add_argument("--policies", nargs="*", default=None)
    ap.add_argument("--ratio-scale", type=float, default=1.0, help="scale the hand's true extensions (a hand unlike the photos)")
    a = ap.parse_args()
    global RATIO_SCALE
    RATIO_SCALE = a.ratio_scale
    cfg, calib = load_measurement_config(), load_measurement_calibration()
    policies = a.policies or ["landmark", "per_finger", "hand_est", "hand_all", "prior_est", "prior_all", "fixed"]
    print("### Scan-to-scan SD of the finger lengths (mm), repeated scans of ONE simulated hand (SIMULATED)\n")
    print(f"true extensions x {a.ratio_scale}; {a.scans} scans per row; each scan: own jitter and bias, pose, distance, position; outline found per finger with probability p (ASSUMED).\n")
    print("| p(found) | policy | " + " | ".join(FINGERS) + " | hand length |")
    print("|---|---|" + "---|" * 6)
    bias_rows = []
    crease_rows = []
    for p in a.p:
        acc = {pol: {f: [] for f in (*FINGERS, "hand", *("c_" + x for x in FINGERS))} for pol in policies}
        err = {pol: {f: [] for f in FINGERS} for pol in policies}
        for k in range(a.scans):
            res, truth = one_scan(5000 + k, p, policies, cfg, calib)
            for pol in policies:
                v = res[pol]
                if v is None:
                    continue
                for f in FINGERS:
                    if v.get("c_" + f) is not None:
                        acc[pol]["c_" + f].append(v["c_" + f])
                    if v.get(f) is not None:
                        acc[pol][f].append(v[f])
                        err[pol][f].append(v[f] - truth[f])
                if v.get("hand") is not None:
                    acc[pol]["hand"].append(v["hand"])
        for pol in policies:
            print(f"| {p} | {pol} | " + " | ".join(f"{np.std(acc[pol][f], ddof=1):.2f}" for f in (*FINGERS, "hand")) + " |")
            crease_rows.append((p, pol, [float(np.std(acc[pol]["c_" + f], ddof=1)) for f in FINGERS]))
            bias_rows.append((p, pol, {f: (np.mean(err[pol][f]), math.sqrt(np.mean(np.square(err[pol][f])))) for f in FINGERS}))
    print("\n### Scan-to-scan SD of the CREASE-TO-TIP estimate (mm)\n")
    print("| p(found) | policy | " + " | ".join(FINGERS) + " |")
    print("|---|---|" + "---|" * 5)
    for p, pol, row in crease_rows:
        print(f"| {p} | {pol} | " + " | ".join(f"{x:.2f}" for x in row) + " |")
    print("\n### Bias / RMSE against the simulated length to the TRUE skin tip (mm)\n")
    print("| p(found) | policy | " + " | ".join(FINGERS) + " |")
    print("|---|---|" + "---|" * 5)
    for p, pol, d in bias_rows:
        print(f"| {p} | {pol} | " + " | ".join(f"{d[f][0]:+.2f} / {d[f][1]:.2f}" for f in FINGERS) + " |")


if __name__ == "__main__":
    main()
