"""Calibration study: how depth, perspective and pose affect coin-scaled hand measurements.

Runs the real measurement engine on pinhole-camera simulations (glovesize/simulation.py)
and compares calibration methods. Writes docs/CALIBRATION_STUDY.md.

These are SYNTHETIC results about geometry. They do not measure real-world accuracy.

Usage (from backend/):  python -m scripts.calibration_study
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np

from glovesize.calibration import ReferenceSpec
from glovesize.config import REPO_ROOT, load_measurement_calibration, load_measurement_config
from glovesize.measurement import aggregate_measurements, measure_frame
from glovesize.schemas import FrameObservation
from glovesize.simulation import Scene, simulate_frame, true_hand_length_mm

QUARTER = ReferenceSpec("US quarter", 24.26, 0.05, 1.75, False)
STUDY_MAX_TILT_DEG = 30.0
DEFAULT = "D. C + assumed 10 mm joint depth (default)"


def method_configs():
    base = load_measurement_config()
    cal, dm = base.calibration, base.depth_model

    def cfg(rectify: bool, depth: bool, layer: float, layer_sd: float):
        # The production tilt gate (calibration.max_tilt_deg) is lifted so tilted scenes show a
        # number instead of "rejected"; production rejects them (see the note under the table).
        return base.model_copy(
            update={
                "calibration": cal.model_copy(
                    update={"tilt_rectification": rectify, "max_tilt_deg": STUDY_MAX_TILT_DEG}
                ),
                "depth_model": dm.model_copy(
                    update={"enabled": depth, "landmark_layer_depth_mm": layer, "landmark_layer_depth_sd_mm": layer_sd}
                ),
            }
        )

    return {
        "A. coin scale only": cfg(False, False, 0.0, 0.0),
        "B. A + tilt rectification (opt-in)": cfg(True, False, 0.0, 0.0),
        "C. A + coin thickness": cfg(False, True, 0.0, 0.0),
        "D. C + assumed 10 mm joint depth (default)": cfg(False, True, 10.0, 5.0),
    }


def measure(scene: Scene, cfg) -> tuple[float | None, str]:
    r = measure_frame(FrameObservation.model_validate(simulate_frame(scene)), QUARTER, cfg)
    if not r.accepted:
        return None, ",".join(r.codes)
    return r.values["hand_length_mm"], ""


SCENARIOS: list[tuple[str, Scene]] = [
    ("Ideal: no depth offsets, centred, flat", Scene(coin_thickness_mm=0.0, layer_depth_mm=0.0)),
    ("Coin thickness only (1.75 mm)", Scene(layer_depth_mm=0.0)),
    ("Typical: coin 1.75 mm + joints 10 mm deep, 350 mm away", Scene()),
    ("Joints 5 mm deep", Scene(layer_depth_mm=5.0)),
    ("Joints 15 mm deep", Scene(layer_depth_mm=15.0)),
    ("Camera 250 mm away", Scene(distance_mm=250.0)),
    ("Camera 450 mm away", Scene(distance_mm=450.0)),
    ("Camera 600 mm away", Scene(distance_mm=600.0)),
    ("Wide lens (true FOV 80 deg)", Scene(hfov_deg=80.0)),
    ("Narrow lens (true FOV 50 deg)", Scene(hfov_deg=50.0)),
    ("Palm tilted 10 deg (fingers away)", Scene(tilt_deg=10.0, tilt_axis_deg=0.0)),
    ("Palm tilted 18 deg (fingers away)", Scene(tilt_deg=18.0, tilt_axis_deg=0.0)),
    ("Palm tilted 18 deg (sideways)", Scene(tilt_deg=18.0, tilt_axis_deg=90.0)),
    ("Palm tilted 25 deg (fingers away)", Scene(tilt_deg=25.0, tilt_axis_deg=0.0)),
    ("Hand off-centre by 60 mm", Scene(offset_mm=(60.0, 0.0))),
    ("Off-centre 60 mm + barrel distortion", Scene(offset_mm=(60.0, 0.0), k1=-0.08)),
    ("Fingers curled 8 deg per joint", Scene(flex_deg=8.0)),
    ("Fingers curled 15 deg per joint", Scene(flex_deg=15.0)),
]


def fmt(v: float | None, truth: float, why: str) -> str:
    if v is None:
        return f"rejected ({why})"
    return f"{100 * (v - truth) / truth:+.2f}%"


def multi_frame_noise(cfg) -> list[tuple[int, float, float]]:
    """Spread of the aggregated estimate for 1 vs many frames with landmark jitter."""
    calib = load_measurement_calibration()
    rows = []
    for n in (1, 6, 24):
        estimates = []
        for trial in range(60):
            rng = np.random.default_rng(1000 + trial)
            results = [
                measure_frame(
                    FrameObservation.model_validate(simulate_frame(replace(Scene(), landmark_noise_px=2.0), rng)),
                    QUARTER,
                    cfg,
                )
                for _ in range(n)
            ]
            if n < cfg.capture.frames_min_accepted:
                vals = [r.values["hand_length_mm"] for r in results if r.accepted]
                estimates.append(float(np.median(vals)))
            else:
                agg = aggregate_measurements(results, cfg, calib, None)
                hl = next(m for m in agg.measurements if m.key == "hand_length_mm")
                estimates.append(hl.value_mm)
        rows.append((n, float(np.std(estimates, ddof=1)), float(np.mean(estimates))))
    return rows


def main() -> None:
    methods = method_configs()
    lines = [
        "# Calibration study (synthetic geometry)",
        "",
        "Generated by `backend/scripts/calibration_study.py` with the pinhole-camera simulator in",
        "`backend/glovesize/simulation.py`. **These are synthetic software results about geometry, not",
        "real-world accuracy.** Real accuracy also depends on where MediaPipe places landmarks on real",
        "hands, which only the validation study (`docs/VALIDATION_PLAN.md`) can measure.",
        "",
        "Each cell is the error of the landmark-defined hand length (wrist landmark to middle fingertip)",
        "for a 185 mm hand, as measured by the real engine from the simulated frame. Methods:",
        "",
        "* **A** scale = coin major axis / 24.26 mm, applied to all landmarks.",
        "* **B** A + affine rectification of the palm plane from the coin's ellipse. Off by default",
        "  (`calibration.tilt_rectification: false`) because of the results below.",
        "* **C** A + correction for the coin's top face sitting 1.75 mm in front of the palm skin.",
        "* **D** C + an *assumed* 10 +/- 5 mm depth of the joint centres behind the skin, with the",
        "  camera distance inferred from the coin size and a 55-80 deg field-of-view prior. This is the",
        "  production default. It is an assumption-based adjustment, not a measured correction.",
        "",
        "| Scenario | " + " | ".join(methods) + " |",
        "|---|" + "---|" * len(methods),
    ]
    for name, scene in SCENARIOS:
        truth = true_hand_length_mm(scene)
        cells = [_cell(scene, cfg, truth) for cfg in methods.values()]
        lines.append(f"| {name} | " + " | ".join(cells) + " |")
    lines += [
        "",
        f"Tilt rows are computed with the tilt gate lifted to {STUDY_MAX_TILT_DEG:.0f} deg. Production rejects coin",
        "ellipses implying more than `calibration.max_tilt_deg` (12 deg) and widens the uncertainty for",
        "smaller tilts instead of rectifying.",
        "",
        "`too_close` is the production distance gate: the camera distance implied by the coin size and the",
        f"55-80 deg FOV prior must be at least `capture.min_camera_distance_mm` ({methods[DEFAULT].capture.min_camera_distance_mm:.0f} mm).",
        "Because the true FOV is unknown, a narrow (telephoto) lens at a normal distance looks close and is",
        "asked to move back. That is a conservative prompt, not a wrong measurement.",
        "",
        "## What this shows",
        "",
        "* Coin-only scaling (A) is not unbiased: the coin sits in front of the palm and the landmark",
        "  joint centres sit behind the skin, so the hand projects smaller than the coin implies. The",
        "  error depends on camera distance and on the unknown joint depth.",
        "* D removes most of that bias **only if** the assumed 10 mm joint depth and the FOV prior are",
        "  right. When they are wrong (5 or 15 mm joints, ideal scene) it leaves errors of a few percent.",
        "  D is therefore described as an assumption-based adjustment with its own uncertainty term, not",
        "  as a perspective correction.",
        "* The coin ellipse's apparent tilt is itself distorted by perspective, so affine rectification",
        "  (B) over-corrects at larger tilts. It stays off by default; production gates tilt and widens",
        "  the uncertainty instead.",
        "* Multi-frame aggregation reduces random landmark jitter, but not the systematic errors above.",
        "  Removing those needs a reference measurement study on real hands (`docs/VALIDATION_PLAN.md`)",
        "  or a second view or depth sensor, none of which this prototype has.",
    ]

    lines += ["", "## Multiple frames", ""]
    lines.append("Landmark jitter of 2 px per frame (typical stable-hand MediaPipe jitter is 1-3 px). Spread of the")
    lines.append("final hand-length estimate over 60 repeated scans, method D (default):")
    lines += ["", "| Frames per scan | SD of estimate (mm) | Mean (mm) |", "|---|---|---|"]
    for n, sd, mean in multi_frame_noise(methods[DEFAULT]):
        lines.append(f"| {n} | {sd:.2f} | {mean:.1f} |")

    path = REPO_ROOT / "docs" / "CALIBRATION_STUDY.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def _cell(scene: Scene, cfg, truth: float) -> str:
    v, why = measure(scene, cfg)
    return fmt(v, truth, why)


if __name__ == "__main__":
    main()
