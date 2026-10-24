"""A finger is bent or straight for a scan as a whole.

The hand model's depth ("world") bend of a straight finger is biased and noisy (straight real hands
read about 19-41 degrees), so judging it on every frame throws away good frames at random and can
leave a straight finger with too few. It is judged on the median over the scan instead; a frame is
dropped for it only far beyond the limit. The in-image bend stays a per-frame check (it is accurate).
Synthetic frames: they show how the rule behaves, not real-world accuracy.
"""

import math

import numpy as np

from glovesize.landmarks import LONG_FINGERS
from glovesize.measurement import aggregate_measurements, measure_frame, scan_bent_fingers, scan_finger_bends
from glovesize.pipeline import process_scan
from glovesize.schemas import FrameObservation, ReferenceSelection, ScanRequest
from glovesize.synthetic import CANONICAL_HAND_MM, synthetic_frame

from .conftest import QUARTER


def world_with_bend(finger: str, total_deg: float) -> list[dict]:
    """World landmarks of a flat hand whose `finger` is bent out of plane by `total_deg` over its two joints."""
    pts = np.column_stack([CANONICAL_HAND_MM / 1000.0, np.zeros(21)])
    chain = list(LONG_FINGERS[finger])
    seg = float(np.linalg.norm(pts[chain[1]] - pts[chain[0]])) or 0.03
    a = math.radians(total_deg / 2)
    p = pts[chain[0]].copy()
    for i, step in enumerate((0.0, a, 2 * a), start=1):
        d = np.array([0.0, -math.cos(step), math.sin(step)])  # up the finger (image y is down), then out of plane
        p = p + seg * d
        pts[chain[i]] = p
    return [{"x": float(x), "y": float(y), "z": float(z)} for x, y, z in pts]


def frame_with_depth_bend(finger: str, total_deg: float):
    f = synthetic_frame()
    f["world_landmarks"] = world_with_bend(finger, total_deg)
    return FrameObservation.model_validate(f)


def scan(cfg, per_frame_bends: dict[str, list[float]]):
    n = len(next(iter(per_frame_bends.values())))
    frames = []
    for i in range(n):
        f = synthetic_frame()
        world = np.array([[p["x"], p["y"], p["z"]] for p in world_with_bend("middle", 0.0)])
        for name, bends in per_frame_bends.items():
            w = world_with_bend(name, bends[i])
            for j in LONG_FINGERS[name]:
                world[j] = [w[j]["x"], w[j]["y"], w[j]["z"]]
        f["world_landmarks"] = [{"x": float(x), "y": float(y), "z": float(z)} for x, y, z in world]
        frames.append(FrameObservation.model_validate(f))
    return frames, [measure_frame(fr, QUARTER, cfg) for fr in frames]


def test_the_helper_makes_the_bend_it_claims(cfg_nodepth):
    for deg in (0, 30, 55, 80):
        r = measure_frame(frame_with_depth_bend("index", deg), QUARTER, cfg_nodepth)
        b3 = r.bends["index"][1] if r.bends else None
        assert b3 is not None and abs(b3 - deg) < 1.0, (deg, b3)


def test_a_straight_finger_with_noisy_depth_readings_is_measured_on_every_frame(cfg_nodepth, calib):
    rng = np.random.default_rng(3)
    # Median about 42 degrees, spread 12: a quarter of the frames read over the old 50 degree limit.
    noisy = list(np.clip(rng.normal(42, 12, 20), 5, 85))
    assert sum(b > 50 for b in noisy) >= 3
    frames, results = scan(cfg_nodepth, {"index": noisy, "little": list(np.clip(rng.normal(40, 12, 20), 5, 85))})
    assert sum(r.accepted for r in results) == 20  # none dropped for a noisy depth reading
    assert scan_bent_fingers(results, cfg_nodepth.capture) == set()
    agg = aggregate_measurements(results, cfg_nodepth, calib, None, bent_fingers=scan_bent_fingers(results, cfg_nodepth.capture))
    by = {m.key: m for m in agg.measurements}
    assert by["index_length_mm"].value_mm is not None and by["index_length_mm"].frames_used == 20
    assert by["little_length_mm"].value_mm is not None


def test_a_finger_that_is_really_curled_is_still_excluded(cfg_nodepth, calib):
    frames, results = scan(cfg_nodepth, {"index": [75.0] * 12})
    bent = scan_bent_fingers(results, cfg_nodepth.capture)
    assert bent == {"index"}
    agg = aggregate_measurements(results, cfg_nodepth, calib, None, bent_fingers=bent)
    by = {m.key: m for m in agg.measurements}
    assert by["index_length_mm"].value_mm is None and by["index_length_mm"].reasons == ["finger_bent"]
    assert by["middle_length_mm"].value_mm is not None  # the other fingers are unaffected


def test_a_frame_far_over_the_limit_is_still_dropped_for_that_finger(cfg_nodepth):
    limit = cfg_nodepth.capture.max_finger_bend_deg_3d * cfg_nodepth.capture.finger_bend_3d_frame_factor
    r = measure_frame(frame_with_depth_bend("index", limit + 15), QUARTER, cfg_nodepth)
    assert r.accepted and r.excluded["index_length_mm"] == "finger_bent"
    r = measure_frame(frame_with_depth_bend("index", 55), QUARTER, cfg_nodepth)  # over 50, under the frame limit
    assert r.accepted and "index_length_mm" in r.values


def test_the_in_image_bend_is_still_a_per_frame_check(cfg_nodepth):
    f = synthetic_frame()
    f["landmarks"][8]["x"] += 50
    r = measure_frame(FrameObservation.model_validate(f), QUARTER, cfg_nodepth)
    assert r.excluded["index_length_mm"] == "finger_bent"


def test_a_scan_whose_middle_finger_is_curled_is_rejected(cfg_nodepth, no_depth_config):
    frames = [synthetic_frame() for _ in range(12)]
    for f in frames:
        f["world_landmarks"] = world_with_bend("middle", 80.0)
    # (80 degrees is under the per-frame limit of 90, so frames pass; the scan median decides)
    req = ScanRequest.model_validate(
        {"frames": frames, "reference": {"object_id": "us_quarter", "confirmed": True}, "chart_id": "demo-length-v1"}
    )
    res = process_scan(req)
    assert res.status == "rejected"
    assert [i.code for i in res.issues][:1] == ["fingers_bent"]


def test_the_scan_reports_how_bent_each_finger_looked(cfg_nodepth):
    _, results = scan(cfg_nodepth, {"index": [40.0] * 6, "little": [30.0] * 6})
    bends = scan_finger_bends(results)
    assert abs(bends["index"][1] - 40.0) < 1.0 and abs(bends["little"][1] - 30.0) < 1.0
    assert 0 <= bends["index"][0] < 5  # in-image: straight
