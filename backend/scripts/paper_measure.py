"""EXPERIMENTAL: measure a hand photographed flat on a sheet of paper, from an image file.

Runs entirely on this computer; nothing is uploaded or stored. For research comparisons only
(docs/PAPER_METHOD_EVALUATION.md); results are not validated against physical measurements.

Usage (from backend/)::

    python -m scripts.paper_measure photo.jpg --paper a4 [--mediapipe] [--json]

``--mediapipe`` locates the metacarpal level from MediaPipe's MCP landmarks (needs the optional
validation dependencies and models/hand_landmarker.task); otherwise a heuristic level is used.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2

from experimental.paper_method.config import load_config
from experimental.paper_method.measure import measure_photo


def main() -> None:
    papers = sorted(load_config().papers)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", type=Path)
    ap.add_argument("--paper", choices=papers, required=True, help="the sheet size the customer used")
    ap.add_argument("--mediapipe", action="store_true", help="use MediaPipe MCP landmarks for the breadth level")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    img = cv2.imread(str(args.image), cv2.IMREAD_COLOR)
    if img is None:
        sys.exit(f"cannot read {args.image}")
    mcp = None
    if args.mediapipe:
        from validation.hand_tracking import HandTracker

        with HandTracker() as tracker:
            det = tracker.detect(img)
        if det is None:
            sys.exit("MediaPipe found no hand; run without --mediapipe for the heuristic level")
        mcp = det.landmarks_px[[5, 17], :2]

    r = measure_photo(img, args.paper, mcp)
    out = {
        "experimental": True,
        "accepted": r.accepted,
        "reasons": r.reasons,
        "estimates": [
            {
                "key": e.key,
                "value_mm": round(e.value_mm, 1),
                "raw_mm": round(e.raw_mm, 1),
                "sd_mm": round(e.sd_mm, 1),
                "interval95_mm": [round(v, 1) for v in e.interval95_mm],
                "components_mm": {k: round(v, 2) for k, v in e.components_mm.items()},
                "method": e.method,
                "basis": e.basis,
            }
            for e in r.estimates
        ],  # fmt: skip
        "diagnostics": {k: (bool(v) if isinstance(v, bool) else v) for k, v in r.diagnostics.items()},
    }
    if args.json:
        print(json.dumps(out, indent=2, default=float))
        return
    print("EXPERIMENTAL flat-hand-on-paper measurement (not validated)")
    print("accepted" if r.accepted else f"not accepted: {', '.join(r.reasons)}")
    for e in out["estimates"]:
        lo, hi = e["interval95_mm"]
        print(f"  {e['key']}: {e['value_mm']} mm (raw {e['raw_mm']}, 95% {lo}-{hi} mm, model-based)")


if __name__ == "__main__":
    main()
