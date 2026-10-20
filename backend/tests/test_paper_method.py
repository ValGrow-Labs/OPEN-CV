"""EXPERIMENTAL flat-hand-on-paper method: SYNTHETIC tests of geometry and measurement.

Every image here is rendered by experimental/paper_method/synthetic.py with a pinhole camera.
Passing these tests shows the geometry is implemented as designed; it says nothing about
accuracy on real hands or real photos.
"""

import math
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from experimental.paper_method.config import load_config
from experimental.paper_method.measure import height_correction, measure_photo
from experimental.paper_method.paper import detect_paper, paper_geometry
from experimental.paper_method.synthetic import SHEETS, Camera, PaperScene, mcp_landmarks_px, render

CFG = load_config()
HFOV = CFG.geometry_assumptions.assumed_hfov_deg


def sheet_corners(s: PaperScene) -> np.ndarray:
    w, h = s.size_mm
    return np.array([[0, 0, 0], [w, 0, 0], [w, h, 0], [0, h, 0]], float)


def exact_geometry(s: PaperScene, paper="a4"):
    cam = Camera(s)
    px = cam.project(sheet_corners(s))
    order = np.argsort(np.arctan2(px[:, 1] - px[:, 1].mean(), px[:, 0] - px[:, 0].mean()))
    px = px[order]
    px = np.roll(px, -int(np.argmin(px.sum(axis=1))), axis=0)
    return cam, paper_geometry(px, CFG.papers[paper], s.image_size, HFOV)


def estimate(r, key):
    return next(e for e in r.estimates if e.key == key)


POSES = [
    dict(),
    dict(tilt_deg=25, tilt_azimuth_deg=30),
    dict(tilt_deg=20, tilt_azimuth_deg=90),  # tilt about an axis parallel to a sheet edge
    dict(tilt_deg=30, tilt_azimuth_deg=200, roll_deg=60),
    dict(camera_distance_mm=320, roll_deg=100, target_mm=(95.0, 160.0)),
]


# --------------------------------------------------------------------------- #
# Plane geometry (exact projected corners, no rendering)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("pose", POSES)
def test_homography_maps_sheet_points_exactly(pose):
    s = PaperScene(**pose)
    cam, g = exact_geometry(s)
    rng = np.random.default_rng(1)
    pts = rng.uniform([0, 0], s.size_mm, (50, 2))
    back = g.to_mm(cam.project(np.column_stack([pts, np.zeros(50)])))
    # Sheet coordinates are defined up to the sheet's own symmetry: compare distances.
    d_true = np.linalg.norm(pts[:, None] - pts[None], axis=2)
    d_back = np.linalg.norm(back[:, None] - back[None], axis=2)
    assert np.abs(d_true - d_back).max() < 1e-4  # float32 inside getPerspectiveTransform


@pytest.mark.parametrize(("pose", "observable"), [
    (dict(tilt_deg=25, tilt_azimuth_deg=30), True),
    (dict(tilt_deg=15, tilt_azimuth_deg=45), True),
    (dict(tilt_deg=30, tilt_azimuth_deg=135), True),
    (dict(), False),  # frontal
    (dict(tilt_deg=20, tilt_azimuth_deg=90), False),  # one pair of edges stays parallel
])  # fmt: skip
def test_focal_and_camera_height(pose, observable):
    s = PaperScene(**pose)
    cam, g = exact_geometry(s)
    assert g.focal_observed is observable
    lo, hi = g.camera_height_range_mm
    if observable:
        assert g.focal_px == pytest.approx(cam.f, rel=0.002)
        assert lo == pytest.approx(cam.centre[2], rel=0.002)
        nadir_px = cam.project(np.array([[cam.centre[0], cam.centre[1], 0.0]]))
        assert np.linalg.norm(g.camera_mm[:2] - g.to_mm(nadir_px)[0]) < 0.5
    else:
        assert lo < cam.centre[2] < hi  # the field-of-view prior brackets the truth


@pytest.mark.parametrize("pose", POSES)
def test_paper_size_check(pose):
    for sheet, wrong in (("a4", "letter"), ("letter", "a4")):
        s = PaperScene(sheet=sheet, **pose)
        _, right_g = exact_geometry(s, sheet)
        _, wrong_g = exact_geometry(s, wrong)
        assert abs(right_g.aspect_error) < 0.006
        assert abs(wrong_g.aspect_error) > 2 * CFG.paper_detection.aspect_tolerance


@pytest.mark.parametrize("pose", POSES[:4])
@pytest.mark.parametrize("h", [5.0, 15.0])
def test_height_correction_recovers_true_position(pose, h):
    s = PaperScene(**pose)
    cam, g = exact_geometry(s)
    p = np.array([[60.0, 80.0, h], [150.0, 220.0, h]])
    seen = g.to_mm(cam.project(p))  # where the rays meet the sheet
    truth = g.to_mm(cam.project(np.column_stack([p[:, :2], np.zeros(2)])))
    if g.focal_observed:
        fixed = height_correction(seen, g.camera_mm[:2], g.camera_mm[2], h)
        assert np.abs(fixed - truth).max() < 1e-4
    shift = np.linalg.norm(seen - truth, axis=1)
    assert (shift > 0.5).all()  # raised points really are displaced


# --------------------------------------------------------------------------- #
# Paper detection on rendered images
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("pose", POSES)
def test_paper_corners_subpixel_despite_the_wrist(pose):
    s = PaperScene(**pose)
    img, cam = render(s)
    det = detect_paper(img, CFG.paper_detection)
    assert det.found, det.reasons
    truth = cam.project(sheet_corners(s))
    err = [np.min(np.linalg.norm(truth - c, axis=1)) for c in det.corners_px]
    assert max(err) < 0.6


def test_lens_distortion_bends_edges_and_is_rejected():
    r = measure_photo(render(PaperScene(k1=-0.06))[0], "a4")
    assert not r.accepted and r.reasons == ["paper_edges_curved"]


def test_no_paper_or_cut_off_paper():
    blank = np.full((1200, 1600, 3), (70, 62, 55), np.uint8)
    assert measure_photo(blank, "a4").reasons in (["paper_not_found"], ["paper_too_small"])
    cut = render(PaperScene(target_mm=(105.0, 40.0), camera_distance_mm=300))[0]  # sheet runs off the image
    assert not measure_photo(cut, "a4").accepted


@pytest.mark.parametrize(("sheet", "selected"), [("letter", "a4"), ("a4", "letter")])
def test_wrong_paper_selection_is_rejected(sheet, selected):
    r = measure_photo(render(PaperScene(sheet=sheet, tilt_deg=20, tilt_azimuth_deg=40))[0], selected)
    assert r.reasons == ["paper_size_mismatch"]


# --------------------------------------------------------------------------- #
# Measurement on rendered images
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "scene",
    [
        PaperScene(),
        PaperScene(tilt_deg=25, tilt_azimuth_deg=30),
        PaperScene(tilt_deg=20, tilt_azimuth_deg=90),
        PaperScene(roll_deg=75, hand_dx_mm=-12),
        PaperScene(sheet="letter", hand_length_mm=172, breadth_mm=76),
        PaperScene(skin_bgr=(55, 70, 95)),  # dark skin
        PaperScene(skin_bgr=(170, 190, 230), shadow=True),  # light skin with a soft shadow
        PaperScene(hand_length_mm=205, breadth_mm=93, wrist_width_mm=64),
    ],
)
def test_flat_outline_measured_to_sub_millimetre(scene):
    """With the outline in the sheet plane (zero hand thickness) the raw values are the truth."""
    img, cam = render(scene)
    for lm in (None, mcp_landmarks_px(scene, cam)):
        r = measure_photo(img, scene.sheet, lm)
        assert r.accepted, r.reasons
        assert estimate(r, "hand_length_mm").raw_mm == pytest.approx(scene.hand_length_mm, abs=0.5)
        assert estimate(r, "hand_breadth_mm").raw_mm == pytest.approx(scene.breadth_mm, abs=0.6)
    assert r.outline.breadth_level_source == "mediapipe_mcp"


@pytest.mark.parametrize(
    "pose", [dict(), dict(tilt_deg=25, tilt_azimuth_deg=200), dict(tilt_deg=20, tilt_azimuth_deg=90)]
)
def test_hand_thickness_bias_and_assumption_based_adjustment(pose):
    s = PaperScene(finger_height_mm=5.0, palm_height_mm=12.0, **pose)  # equal to the configured assumptions
    r = measure_photo(render(s)[0], "a4")
    length, breadth = estimate(r, "hand_length_mm"), estimate(r, "hand_breadth_mm")
    assert breadth.raw_mm - s.breadth_mm > 2.0  # the raised outline reads wide
    assert length.value_mm == pytest.approx(s.hand_length_mm, abs=0.6)
    assert breadth.value_mm == pytest.approx(s.breadth_mm, abs=0.8)
    # When the assumption is wrong (a thin hand), the adjustment itself becomes the error.
    thin = measure_photo(render(replace(s, finger_height_mm=0.0, palm_height_mm=0.0))[0], "a4")
    assert estimate(thin, "hand_breadth_mm").value_mm < s.breadth_mm - 2.0


def test_wrist_misalignment_is_not_detectable():
    """The protocol's wrist-crease placement is a physical assumption: a crease 4 mm inside the
    edge adds 4 mm, and nothing in the image can tell. This is a known limitation."""
    base = estimate(measure_photo(render(PaperScene())[0], "a4"), "hand_length_mm").raw_mm
    off = measure_photo(render(PaperScene(crease_offset_mm=4.0))[0], "a4")
    assert off.accepted
    assert estimate(off, "hand_length_mm").raw_mm - base == pytest.approx(4.0, abs=0.3)


@pytest.mark.parametrize(("scene", "reason"), [
    (PaperScene(hand_rotation_deg=15), "hand_axis_rotated"),
    (PaperScene(thumb_adducted=True), "breadth_implausible_check_thumb"),
    (PaperScene(hand_dx_mm=60), "hand_near_sheet_edge"),  # little-finger side 3 mm from the sheet edge
])  # fmt: skip
def test_capture_problems_are_flagged(scene, reason):
    r = measure_photo(render(scene)[0], "a4")
    assert not r.accepted and reason in r.reasons


def test_hand_over_the_edge_is_rejected_either_way():
    # Closer than ~2 mm the hand (or its shadow) breaks the sheet outline itself.
    for dx in (61, 62, 70):
        assert not measure_photo(render(PaperScene(hand_dx_mm=dx))[0], "a4").accepted


def test_small_rotation_is_accepted_with_a_cosine_error():
    r = measure_photo(render(PaperScene(hand_rotation_deg=8))[0], "a4")
    assert r.accepted
    assert estimate(r, "hand_length_mm").raw_mm == pytest.approx(185 * math.cos(math.radians(8)) + 1.2, abs=1.5)


def test_uncertainty_is_labelled_as_assumption_based():
    r = measure_photo(render(PaperScene())[0], "a4")
    e = estimate(r, "hand_length_mm")
    assert set(e.components_mm) == {"paper_size_tolerance", "silhouette_height", "camera_height", "wrist_alignment",
                                    "outline", "edge_straightness"}  # fmt: skip
    assert e.components_mm["wrist_alignment"] == CFG.geometry_assumptions.wrist_alignment_sd_mm
    assert "not validated" in e.basis
    lo, hi = e.interval95_mm
    assert lo < e.value_mm < hi


def test_production_code_never_imports_the_experiment():
    root = Path(__file__).resolve().parents[1] / "glovesize"
    for f in root.rglob("*.py"):
        assert "experimental" not in f.read_text(encoding="utf-8"), f
    assert set(SHEETS) == set(CFG.papers)
