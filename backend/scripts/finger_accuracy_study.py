"""Finger accuracy study: how well the engine measures the thumb and the four fingers, in simulation.

Runs the real engine (measure_frame + aggregate_camera [+ combine_views]) on pinhole-camera simulations
(glovesize/simulation.py) with exactly known 3D geometry, many scans per condition, and reports for each
finger the bias, SD, RMSE and 95% half-width of the error against the simulated 3D joint-chain length, plus
the interval the app reported and how often it covered the truth.

EVERYTHING HERE IS SIMULATED. The noise sizes (landmark jitter, per-hand bias, world-landmark noise, outlier
frames) are ASSUMED; the world noise was chosen so that the simulated depth bend of straight fingers matches
what MediaPipe did on two real photos (backend/scripts/finger_real_photo_probe.py), which is the only real
evidence in the repository. The hand shape is the model's landmark geometry on those photos. Nothing here is
real-world accuracy: there are no caliper-measured fingers, and the error is measured against the simulated
joint-centre chain, not against skin.

Usage (from backend/):  python -m scripts.finger_accuracy_study [--scans 120] [--quick] [--section all]
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, replace

import numpy as np

from glovesize.calibration import ReferenceSpec, smoothed_coin_tilts
from glovesize.config import load_measurement_calibration, load_measurement_config
from glovesize.measurement import aggregate_camera, combine_views, measure_frame
from glovesize.schemas import FrameObservation
from glovesize.simulation import Scene, simulate_frame, true_chain_lengths_mm

QUARTER = ReferenceSpec("US quarter", 24.26, 0.05, 1.75, False)
FINGERS = ("thumb", "index", "middle", "ring", "little")
KEY = {f: f"{f}_length_mm" for f in FINGERS}
Z95 = 1.959964

# ASSUMED typical noise of a phone scan (docs/CALIBRATION_STUDY.md: "typical stable-hand jitter is 1-3 px").
# World noise (mm per axis, z doubled) reproduces the depth bend MediaPipe read on two real flat-hand photos.
TYPICAL = Scene(hand_shape="photo", landmark_noise_px=2.0, world_noise_mm=1.5, world_z_noise_mm=3.0)


@dataclass
class Condition:
    name: str
    scene: Scene
    frames: int = 16


def conditions() -> list[Condition]:
    t = TYPICAL
    return [
        Condition("ideal: no noise", Scene(hand_shape="photo")),
        Condition("typical: 2 px jitter, 16 frames", t),
        Condition("8 frames (phone minimum)", t, 8),
        Condition("24 frames", t, 24),
        Condition("+ per-hand landmark bias 1.5 px (ASSUMED)", replace(t, landmark_bias_px=1.5)),
        Condition("camera 450 mm away", replace(t, distance_mm=450.0)),
        Condition("hand tilted 6 deg (inside the 12 deg gate)", replace(t, tilt_deg=6.0)),
        Condition("fingers lifted 10 deg towards camera", replace(t, finger_pitch_deg={f: 10.0 for f in FINGERS[1:]})),
        Condition("fingers lifted 20 deg towards camera", replace(t, finger_pitch_deg={f: 20.0 for f in FINGERS[1:]})),
        Condition("thumb turned out of plane 20 deg", replace(t, finger_pitch_deg={"thumb": 20.0})),
        Condition("thumb turned out of plane 40 deg", replace(t, finger_pitch_deg={"thumb": 40.0})),
        Condition("fingers curled 8 deg per joint", replace(t, flex_deg=8.0)),
        Condition("off-centre 25 mm + barrel distortion", replace(t, offset_mm=(25.0, 0.0), k1=-0.08)),
        Condition("joints 15 mm deep (depth assumption wrong)", replace(t, layer_depth_mm=15.0)),
        Condition("blur/mis-placed tips: 15% frames displaced 12 px", replace(t, outlier_fraction=0.15, outlier_px=12.0)),
    ]


def scan_results(scene: Scene, seed: int, n: int, cfg):
    rng = np.random.default_rng(seed)
    s = replace(scene, seed=seed)
    frames = [FrameObservation.model_validate(simulate_frame(s, rng)) for _ in range(n)]
    # As production does: the coin tilt is judged on the average ellipse of neighbouring frames.
    tilts = smoothed_coin_tilts([f.coin for f in frames], cfg.calibration.tilt_window_frames)
    return [measure_frame(f, QUARTER, cfg, tilt_deg=t) for f, t in zip(frames, tilts, strict=True)], true_chain_lengths_mm(s)


def scan(scene: Scene, seed: int, n: int, cfg, calib):
    """One simulated scan of n frames through the engine: (CameraAgg or None, frame results, truth)."""
    results, truth = scan_results(scene, seed, n, cfg)
    if sum(r.accepted for r in results) < min(cfg.capture.frames_min_accepted, 8):
        return None, results, truth  # the scan would be rejected by the frame gates
    return aggregate_camera(results, cfg, calib, set()), results, truth


@dataclass
class Stats:
    scans: int
    shown: int
    bias: float
    sd: float
    rmse: float
    p95: float
    reported_u95: float
    coverage: float
    status: str


def summarise(errs, rep, cov, stat, scans, rejected) -> dict[str, Stats]:
    out = {}
    for f in FINGERS:
        e = np.array(errs[f]) if errs[f] else np.array([float("nan")])
        top = max(set(stat[f]), key=stat[f].count) if stat[f] else f"scan rejected ({rejected}/{scans})"
        out[f] = Stats(
            scans, len(errs[f]), float(np.mean(e)), float(np.std(e, ddof=1)) if len(e) > 1 else 0.0,
            float(math.sqrt(np.mean(e**2))), float(np.percentile(np.abs(e), 95)),
            float(np.mean(rep[f])) if rep[f] else float("nan"), float(np.mean(cov[f])) if cov[f] else float("nan"), top,
        )  # fmt: skip
    return out


def evaluate_multi(cond: Condition, scans: int, cfg, calib, estimators: dict) -> dict[str, dict[str, Stats]]:
    """Monte Carlo over ``scans`` simulated scans. Each estimator (None = the engine's own value, or a function
    ``(finger, frame results, measurement) -> mm``) is scored on the SAME frames; the reported interval is the
    engine's own in every case."""
    acc = {n: ({f: [] for f in FINGERS}, {f: [] for f in FINGERS}, {f: [] for f in FINGERS}) for n in estimators}
    stat = {f: [] for f in FINGERS}
    rejected = 0
    for k in range(scans):
        camera, results, truth = scan(cond.scene, 1000 + k, cond.frames, cfg, calib)
        if camera is None:
            rejected += 1
            continue
        for f in FINGERS:
            m = next(x for x in camera.out if x.key == KEY[f])
            stat[f].append(m.status)
            if m.value_mm is None:
                continue
            u95 = Z95 * (m.uncertainty_mm or 0.0)
            for n, est in estimators.items():
                v = est(f, results, m) if est else m.value_mm
                errs, rep, cov = acc[n]
                errs[f].append(v - truth[f])
                rep[f].append(u95)
                cov[f].append(abs(v - truth[f]) <= u95)
    return {n: summarise(acc[n][0], acc[n][1], acc[n][2], stat, scans, rejected) for n in estimators}


def evaluate(cond: Condition, scans: int, cfg, calib, estimator=None) -> dict[str, Stats]:
    return evaluate_multi(cond, scans, cfg, calib, {"x": estimator})["x"]


def md_table(title: str, rows: list[tuple[str, dict[str, Stats]]]) -> list[str]:
    lines = [f"### {title}", "", "| condition | finger | bias mm | SD mm | RMSE mm | 95% half-width mm | reported 95% mm | covered | status |",
             "|---|---|---|---|---|---|---|---|---|"]  # fmt: skip
    for name, st in rows:
        for f in FINGERS:
            s = st[f]
            if s.shown == 0:
                lines.append(f"| {name} | {f} | n/a | n/a | n/a | n/a | n/a | n/a | {s.status} (value hidden) |")
            else:
                lines.append(f"| {name} | {f} | {s.bias:+.2f} | {s.sd:.2f} | {s.rmse:.2f} | {s.p95:.2f} | {s.reported_u95:.1f} | {100*s.coverage:.0f}% | {s.status} |")  # fmt: skip
    return lines + [""]


def md_compare(title: str, names: list[str], rows: list[tuple[str, list[dict[str, Stats]]]]) -> list[str]:
    head = "| condition | finger | " + " | ".join(f"{n}: bias / SD / RMSE" for n in names) + " |"
    lines = [f"### {title}", "", head, "|---|---|" + "---|" * len(names)]
    for cname, per in rows:
        for f in FINGERS:
            cells = []
            for st in per:
                s = st[f]
                cells.append("hidden" if s.shown == 0 else f"{s.bias:+.2f} / {s.sd:.2f} / {s.rmse:.2f}")
            lines.append(f"| {cname} | {f} | " + " | ".join(cells) + " |")
    return lines + [""]


def md_uncertainty(title: str, names: list[str], rows: list[tuple[str, list[dict[str, Stats]]]]) -> list[str]:
    head = "| condition | finger | " + " | ".join(f"{n}: reported 95% mm / covered / status" for n in names) + " |"
    lines = [f"### {title}", "", head, "|---|---|" + "---|" * len(names)]
    for cname, per in rows:
        for f in FINGERS:
            cells = []
            for st in per:
                s = st[f]
                cells.append("hidden" if s.shown == 0 else f"{s.reported_u95:.1f} / {100*s.coverage:.0f}% / {s.status}")
            lines.append(f"| {cname} | {f} | " + " | ".join(cells) + " |")
    return lines + [""]


# --------------------------------------------------------------------------- #
# Aggregation rules compared on the same frames
# --------------------------------------------------------------------------- #


def _values(f: str, results) -> np.ndarray:
    return np.array([r.values[KEY[f]] for r in results if r.accepted and KEY[f] in r.values])


def est_median(f, results, m):
    return float(np.median(_values(f, results)))


def est_mean_inliers(f, results, m):
    from glovesize.measurement import robust_inliers

    v = _values(f, results)
    return float(np.mean(v[robust_inliers(v)]))


def est_trimmed(f, results, m):
    v = np.sort(_values(f, results))
    k = max(1, len(v) // 5)
    return float(np.mean(v[k:-k]))


def est_hodges_lehmann(f, results, m):
    v = _values(f, results)
    return float(np.median([(v[i] + v[j]) / 2 for i in range(len(v)) for j in range(i, len(v))]))


AGGREGATORS = {
    "median (production)": est_median,
    "mean of MAD inliers": est_mean_inliers,
    "20% trimmed mean": est_trimmed,
    "Hodges-Lehmann": est_hodges_lehmann,
}


# --------------------------------------------------------------------------- #
# Two views
# --------------------------------------------------------------------------- #


def evaluate_two_views(scene: Scene, scans: int, cfg, calib) -> tuple[dict, dict]:
    """Palm view alone vs palm + back view combined (combine_views), the two views' per-hand landmark biases
    drawn independently (ASSUMED: nothing in the repository says whether a view's errors are independent)."""
    single = {f: [] for f in FINGERS}
    both = {f: [] for f in FINGERS}
    rep1 = {f: [] for f in FINGERS}
    rep2 = {f: [] for f in FINGERS}
    for k in range(scans):
        ca, _, truth = scan(scene, 2000 + k, 16, cfg, calib)
        cb, _, _ = scan(scene, 9000 + k, 10, cfg, calib)  # the back view collects 10 frames on a phone
        if ca is None or cb is None:
            continue
        both_c = combine_views([ca, cb], cfg)
        for f in FINGERS:
            ma = next(x for x in ca.out if x.key == KEY[f])
            mc = next(x for x in both_c.out if x.key == KEY[f])
            if ma.value_mm is None or mc.value_mm is None:
                continue
            single[f].append(ma.value_mm - truth[f])
            both[f].append(mc.value_mm - truth[f])
            rep1[f].append(Z95 * ma.uncertainty_mm)
            rep2[f].append(Z95 * mc.uncertainty_mm)

    def row(e, r):
        return (float(np.mean(e)), float(np.std(e, ddof=1)), float(math.sqrt(np.mean(np.square(e)))), float(np.mean(r)))

    return {f: row(single[f], rep1[f]) for f in FINGERS}, {f: row(both[f], rep2[f]) for f in FINGERS}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scans", type=int, default=120)
    ap.add_argument("--quick", action="store_true", help="fewer scans")
    ap.add_argument("--only", default="", help="substring of a condition name")
    ap.add_argument("--section", default="all", choices=["all", "production", "depth", "uncertainty", "aggregation", "views"])
    a = ap.parse_args()
    scans = 20 if a.quick else a.scans
    cfg, calib = load_measurement_config(), load_measurement_calibration()
    fa = cfg.finger_accuracy
    cfg_depth = cfg.model_copy(update={"finger_accuracy": fa.model_copy(update={"depth_aware_lengths": True})})
    cfg_unc = cfg.model_copy(update={"finger_accuracy": fa.model_copy(update={"tilt_uncertainty": True})})
    cfg_both = cfg.model_copy(update={"finger_accuracy": fa.model_copy(update={"depth_aware_lengths": True, "tilt_uncertainty": True})})
    variants = {"production": cfg, "depth": cfg_depth, "unc": cfg_unc, "both": cfg_both}
    conds = [c for c in conditions() if not a.only or a.only in c.name]
    out: list[str] = []
    cache: dict = {}

    def ev(c: Condition, variant: str) -> dict[str, Stats]:
        if (c.name, variant) not in cache:
            cache[(c.name, variant)] = evaluate(c, scans, variants[variant], calib)
        return cache[(c.name, variant)]

    def want(s: str) -> bool:
        return a.section in ("all", s)

    if want("production"):
        out += md_table(f"Production engine (defaults), {scans} simulated scans per condition (SIMULATED)",
                        [(c.name, ev(c, "production")) for c in conds])  # fmt: skip
    if want("depth"):
        out += md_compare(f"Landmark-depth-aware finger lengths vs production, {scans} scans (SIMULATED)",
                          ["production", "depth-aware"],
                          [(c.name, [ev(c, "production"), ev(c, "depth")]) for c in conds])  # fmt: skip
    if want("uncertainty"):
        out += md_uncertainty(f"Reported uncertainty: production vs with the finger-tilt term, {scans} scans (SIMULATED)",
                              ["production", "tilt term", "tilt term + depth-aware"],
                              [(c.name, [ev(c, "production"), ev(c, "unc"), ev(c, "both")]) for c in conds])  # fmt: skip
    if want("aggregation"):
        picks = [c for c in conds if c.name.startswith(("typical", "8 frames", "+ per-hand", "blur"))]
        rows = []
        for c in picks:
            res = evaluate_multi(c, scans, cfg, calib, AGGREGATORS)
            rows.append((c.name, [res[n] for n in AGGREGATORS]))
        out += md_compare(f"Aggregation rules on the same frames, {scans} scans (SIMULATED)", list(AGGREGATORS), rows)
    if want("views"):
        out += ["### Palm only vs palm + back view (combine_views), independent per-hand biases (ASSUMED), "
                f"{scans} scans (SIMULATED)", "", "| bias px | finger | palm only: bias / SD / RMSE / reported 95% | two views: bias / SD / RMSE / reported 95% |", "|---|---|---|---|"]  # fmt: skip
        for bias in (1.5, 3.0):
            s1, s2 = evaluate_two_views(replace(TYPICAL, landmark_bias_px=bias), scans, cfg, calib)
            for f in FINGERS:
                out.append(f"| {bias} | {f} | " + " | ".join(f"{b:+.2f} / {sd:.2f} / {r:.2f} / {u:.1f}" for b, sd, r, u in (s1[f], s2[f])) + " |")
        out.append("")
    print("\n".join(out))


if __name__ == "__main__":
    main()
