"""Run the full measurement pipeline on captured study images and write scans.csv.

Layout::

    <dataset>/captures/<participant_id>/<scan_id>/*.jpg|*.png   (frames of one scan, in order)

Every scan is processed exactly like a browser scan (MediaPipe landmarks -> coin detection
in the palm ROI -> /api/scan pipeline), but with an *uncalibrated* (identity) calibration,
so that the written estimates are raw values that fit_calibration.py can fit.

Usage::

    python -m validation.extract_from_images <dataset_dir> [--chart demo-length-v1] [--out scans.csv]
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

import cv2

import glovesize.pipeline as pipeline
from glovesize.config import load_measurement_calibration, load_measurement_config
from glovesize.frame_analysis import build_frame_observation
from glovesize.schemas import ScanRequest

from .dataset import write_scans
from .hand_tracking import HandTracker

log = logging.getLogger("validation.extract")
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".bmp"}


def identity_calibration():
    base = load_measurement_calibration()
    entries = {k: e.model_copy(update={"scale": 1.0, "offset_mm": 0.0}) for k, e in base.measurements.items()}
    return base.model_copy(update={"status": "uncalibrated", "measurements": entries, "derived": {}})


def scan_row(participant_id: str, scan_id: str, resp, chart_id: str) -> dict:
    row = {
        "participant_id": participant_id,
        "scan_id": scan_id,
        "status": resp.status,
        "frames_received": resp.frames_received,
        "frames_accepted": resp.frames_accepted,
        "rejection_codes": ";".join(sorted(resp.frame_rejection_counts)),
        "calibration_status": "uncalibrated",
        "chart_id": chart_id,
        "recommended_size": resp.recommendation.size if resp.recommendation else "",
        "alternative_size": (resp.recommendation.alternative_size or "") if resp.recommendation else "",
        "confidence_level": (resp.recommendation.confidence_level or "") if resp.recommendation else "",
    }
    for m in resp.measurements:
        if m.source == "camera_landmarks":
            row[f"est_{m.key}"] = "" if m.value_mm is None else m.value_mm
            row[f"sd_{m.key}"] = "" if m.uncertainty_mm is None else m.uncertainty_mm
            row[f"status_{m.key}"] = m.status
    return row


def process_dataset(dataset: Path, chart_id: str | None, reference_id: str = "us_quarter") -> list[dict]:
    cfg = load_measurement_config()
    pipeline.load_measurement_calibration = identity_calibration  # raw estimates only
    chart = pipeline.get_chart(chart_id)
    rows = []
    with HandTracker() as tracker:
        for pdir in sorted(p for p in (dataset / "captures").iterdir() if p.is_dir()):
            for sdir in sorted(s for s in pdir.iterdir() if s.is_dir()):
                files = sorted(f for f in sdir.iterdir() if f.suffix.lower() in IMAGE_EXT)
                frames = []
                for i, f in enumerate(files):
                    img = cv2.imread(str(f))
                    if img is None:
                        log.warning("unreadable image %s", f)
                        continue
                    det = tracker.detect(img)
                    if det is None:
                        continue
                    frames.append(
                        build_frame_observation(
                            img,
                            det.landmarks_px,
                            det.world,
                            det.handedness,
                            det.handedness_score,
                            cfg.coin_detection,
                            timestamp_ms=i * 33.0,
                        )  # fmt: skip
                    )
                if not frames:
                    rows.append({"participant_id": pdir.name, "scan_id": sdir.name, "status": "rejected",
                                 "frames_received": len(files), "frames_accepted": 0,
                                 "rejection_codes": "no_hand_detected", "calibration_status": "uncalibrated"})  # fmt: skip
                    continue
                req = ScanRequest.model_validate(
                    {"frames": frames, "reference": {"object_id": reference_id}, "chart_id": chart.chart_id}
                )
                resp = pipeline.process_scan(req)
                rows.append(scan_row(pdir.name, sdir.name, resp, chart.chart_id))
                log.info(
                    "%s/%s: %s (%d/%d frames)", pdir.name, sdir.name, resp.status, resp.frames_accepted, len(files)
                )
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", type=Path)
    ap.add_argument("--chart", default=None)
    ap.add_argument("--reference", default="us_quarter")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    rows = process_dataset(args.dataset, args.chart, args.reference)
    out = args.out or args.dataset / "scans.csv"
    write_scans(out, rows)
    print(f"wrote {len(rows)} scans to {out}")


if __name__ == "__main__":
    main()
