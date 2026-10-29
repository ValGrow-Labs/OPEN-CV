"""Every hand has to work: small and large, short and long fingers, wide and narrow palms, left and
right, turned in the frame, and a tape measure for a hand the camera cannot measure.

SYNTHETIC hands: they show that no gate assumes an average hand, not real-world accuracy.
"""

import math

import numpy as np
import pytest
from pydantic import ValidationError

import glovesize.synthetic as syn
from glovesize.config import load_measurement_config
from glovesize.pipeline import process_scan
from glovesize.schemas import ManualMeasurements

from .conftest import make_frames
from .test_api import client  # noqa: F401  (the `client` fixture)
from .test_multi_view import by_key, request, tag, use  # noqa: F401  (the `use` fixture)

FINGERS = {"thumb": (2, (3, 4)), "index": (5, (6, 7, 8)), "middle": (9, (10, 11, 12)), "ring": (13, (14, 15, 16)), "little": (17, (18, 19, 20))}


def shaped(fingers: float = 1.0, palm_width: float = 1.0, thumb: float = 1.0) -> np.ndarray:
    """The canonical hand with its fingers lengthened/shortened, the palm widened/narrowed, the thumb longer/shorter."""
    pts = syn.CANONICAL_HAND_MM.copy()
    for name, (base, rest) in FINGERS.items():
        k = thumb if name == "thumb" else fingers
        for j in rest:
            pts[j] = pts[base] + (pts[j] - pts[base]) * k
    pts[:, 0] *= palm_width
    return pts


def true_hand_mm(pts: np.ndarray, hand_length_mm: float) -> float:
    """The wrist to middle fingertip distance the synthetic frame will really have for this shape."""
    return float(np.linalg.norm(pts[12] - pts[0])) * hand_length_mm / syn.CANONICAL_HAND_LENGTH_MM


SHAPES = {
    "average": dict(),
    "long fingers": dict(fingers=1.18),
    "short fingers": dict(fingers=0.82),
    "wide palm": dict(palm_width=1.28),
    "narrow palm": dict(palm_width=0.78),
    "long thumb": dict(thumb=1.25),
    "short thumb": dict(thumb=0.75),
}


@pytest.mark.parametrize("shape", list(SHAPES))
@pytest.mark.parametrize("mirror", [False, True], ids=["right hand", "left hand"])
def test_hands_of_any_proportion_left_or_right_are_measured(use, monkeypatch, shape, mirror):
    use(("palm",))
    pts = shaped(**SHAPES[shape])
    monkeypatch.setattr(syn, "CANONICAL_HAND_MM", pts)
    hl = 172.0
    frames = tag(make_frames(n=24, seed=4, hand_length_mm=hl, mirror=mirror), "palm")
    resp = process_scan(request(frames))
    assert resp.status == "accepted", [i.code for i in resp.issues]
    assert by_key(resp).value_mm == pytest.approx(true_hand_mm(pts, hl), rel=0.03)


@pytest.mark.parametrize("rotation", [-40, -20, 0, 25, 45])
def test_a_hand_turned_in_the_picture_is_measured(use, rotation):
    use(("palm",))
    frames = tag(make_frames(n=24, seed=5, hand_length_mm=175.0, rotation_deg=float(rotation)), "palm")
    resp = process_scan(request(frames))
    assert resp.status == "accepted", [i.code for i in resp.issues]
    assert by_key(resp).value_mm == pytest.approx(175.0, rel=0.03)


# --- the tape measure: a way in for every hand the camera cannot measure ------------------------


def test_the_tape_entry_range_covers_every_hand_and_is_configuration():
    cfg = load_measurement_config()
    r = cfg.manual_entry_range_mm
    assert r["hand_length_mm"][0] <= 70 and r["hand_length_mm"][1] >= 280  # a young child to a very large adult
    assert set(r) == {"hand_length_mm", "hand_circumference_mm", "palm_breadth_mm"}


@pytest.mark.parametrize("mm", [60, 70, 110, 175, 260, 300])
def test_a_tape_measured_hand_length_from_a_child_to_a_very_large_adult_is_accepted(mm):
    assert ManualMeasurements(hand_length_mm=mm).hand_length_mm == mm


@pytest.mark.parametrize("field,bad", [("hand_length_mm", 55), ("hand_length_mm", 320), ("hand_circumference_mm", 70), ("hand_circumference_mm", 500), ("palm_breadth_mm", 25), ("palm_breadth_mm", 200)])
def test_a_typing_slip_is_still_refused(field, bad):
    with pytest.raises(ValidationError):
        ManualMeasurements(**{field: bad})


def test_the_phone_is_told_the_tape_entry_ranges(client):
    got = client.get("/api/config").json()["manual_entry_range_mm"]
    assert got["hand_length_mm"] == [60.0, 300.0]


def test_a_tape_only_size_works_for_a_small_hand(client):
    """A refused scan has no camera measurements: the tape value alone must give a size."""
    body = {"chart_id": "demo-everyday-v1", "measurements": [{"key": "hand_length_mm", "value_mm": 112.0, "uncertainty_mm": 4.0, "status": "user_entered"}]}
    rec = client.post("/api/recommend", json=body).json()
    assert rec["size"] == "S" and rec["status"] in ("recommended", "borderline")
    assert rec["is_demo_chart"] is True
