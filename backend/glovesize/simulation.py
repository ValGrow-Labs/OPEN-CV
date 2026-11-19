"""Pinhole-camera simulation of a hand holding a coin, with exactly known 3D geometry.

Unlike ``synthetic.synthetic_frame`` (weak perspective, everything in one plane), this
models the effects the measurement engine has to cope with:

* the coin's top face sits ``thickness`` mm in front of the palm skin;
* MediaPipe landmarks are joint centres ``layer_depth`` mm behind the palm skin;
* true perspective projection (points farther away look smaller), off-centre hands;
* rigid palm tilt, finger flexion towards the camera, optional radial lens distortion.

It is used by ``scripts/calibration_study.py`` to compare calibration methods and by the
tests. Results describe the geometry only. They are not evidence of real-world accuracy,
which also depends on MediaPipe's landmark placement on real hands.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from .synthetic import CANONICAL_HAND_LENGTH_MM, CANONICAL_HAND_MM, palm_centre_mm

FINGER_CHAINS = {"index": (5, 6, 7, 8), "middle": (9, 10, 11, 12), "ring": (13, 14, 15, 16), "little": (17, 18, 19, 20)}
# The thumb's chain (MCP -> IP -> tip), as the production thumb measurement uses it.
THUMB_CHAIN = (2, 3, 4)
ALL_CHAINS = {"thumb": THUMB_CHAIN, **FINGER_CHAINS}


# A real hand's MediaPipe landmark geometry: the mean of the landmarks MediaPipe returned on the repository's two
# flat-hand sample photos (frontend/e2e/.media/hand.png, hand_portrait.png), rotated so the wrist-to-middle-knuckle
# line points up, in units of the wrist-to-middle-fingertip distance. The two photos agree to 0.019 units
# (3.5 mm at 185 mm). It is a LANDMARK shape (joint centres as the model places them), used because the canonical
# hand's thumb and fingers are 10-30% shorter than the model's landmark chains on a real hand. It is one hand
# (or two photos of what looks like the same hand): a shape, not a population.
PHOTO_HAND_UNIT = np.array(
    [[0.0, 0.0], [-0.2042, -0.1127], [-0.3079, -0.2737], [-0.3663, -0.4338], [-0.4336, -0.5645],
     [-0.1312, -0.4584], [-0.1389, -0.6864], [-0.1401, -0.8285], [-0.1287, -0.9493],
     [-0.0, -0.4506], [0.0411, -0.6997], [0.0708, -0.8631], [0.0963, -0.9954],
     [0.104, -0.4081], [0.1829, -0.6233], [0.2336, -0.7692], [0.2698, -0.8842],
     [0.1868, -0.3552], [0.2828, -0.5163], [0.3376, -0.6197], [0.3847, -0.7116]]
)  # fmt: skip


def hand_shape_mm(s: Scene) -> np.ndarray:
    """The 21 landmark positions (mm, wrist at the origin, flat) of the scene's hand."""
    if s.hand_shape == "photo":
        base = PHOTO_HAND_UNIT
        return base * (s.hand_length_mm / float(np.linalg.norm(base[12] - base[0])))
    return CANONICAL_HAND_MM * (s.hand_length_mm / CANONICAL_HAND_LENGTH_MM)


@dataclass
class Scene:
    """Physical setup. Distances in mm, angles in degrees."""

    hand_length_mm: float = 185.0
    hand_shape: str = "canonical"  # "canonical" (the test hand) or "photo" (PHOTO_HAND_UNIT)
    distance_mm: float = 350.0  # camera to palm skin, along the optical axis
    hfov_deg: float = 65.0  # true horizontal field of view (long image side)
    image_size: tuple[int, int] = (1080, 1920)  # portrait phone frame
    coin_diameter_mm: float = 24.26
    coin_thickness_mm: float = 1.75
    layer_depth_mm: float = 10.0  # joint centres behind the palmar skin
    tilt_deg: float = 0.0  # rigid rotation of hand + coin about an in-plane axis
    tilt_axis_deg: float = 0.0  # direction of that axis in the palm plane (0 = image x)
    flex_deg: float = 0.0  # each long-finger joint bent towards the camera by this much
    offset_mm: tuple[float, float] = (0.0, 0.0)  # hand offset from the centred position
    k1: float = 0.0  # radial distortion coefficient (normalised coordinates)
    landmark_noise_px: float = 0.0
    # Per-finger rigid pitch (degrees) about the finger's MCP joint, tip towards the camera: a finger lifted
    # (or the thumb turned out of the palm plane) without any joint bend. Keys: thumb/index/middle/ring/little.
    finger_pitch_deg: dict = field(default_factory=dict)
    # A fixed per-landmark offset (px, one draw per scene, the same in every frame): the model's own bias on a
    # given hand, which averaging frames cannot remove. ASSUMED size: nothing in the repo measures it.
    landmark_bias_px: float = 0.0
    # Noise added to the model-style world landmarks (mm, per axis; z is the depth axis). ASSUMED; see
    # scripts/finger_accuracy_study.py for how it was matched to what MediaPipe did on two real photos.
    world_noise_mm: float = 0.0
    # A rigid pitch error of the model's whole world frame about the image x axis (degrees): a constant bias of the depth estimate
    # (the real model reads a flat hand's palm 26-29 degrees tilted). ASSUMED sizes; used to test what survives a systematic bias.
    world_pitch_bias_deg: float = 0.0
    world_z_noise_mm: float = 0.0
    # Fraction of frames whose landmarks are displaced by ``outlier_px`` (motion blur, a mis-placed tip).
    outlier_fraction: float = 0.0
    outlier_px: float = 0.0
    seed: int = 0
    extra: dict = field(default_factory=dict)

    @property
    def focal_px(self) -> float:
        return (max(self.image_size) / 2) / math.tan(math.radians(self.hfov_deg) / 2)


def _rotation(axis: np.ndarray, angle_rad: float) -> np.ndarray:
    axis = axis / np.linalg.norm(axis)
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + math.sin(angle_rad) * k + (1 - math.cos(angle_rad)) * (k @ k)


def hand_points_3d(s: Scene) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """3D landmarks, coin rim (top face) and coin centre in camera coordinates (mm).

    Camera at the origin looking along +Z, image x right / y down. The palm faces the camera.
    """
    pts2 = hand_shape_mm(s)
    centre2 = palm_centre_mm(pts2)
    pts2 = pts2 - centre2  # palm centre at the origin of the hand frame
    lm = np.column_stack([pts2, np.full(21, s.layer_depth_mm)])  # +Z = away from camera

    # Finger flexion: rotate distal segments about each joint, curling towards the camera (-Z).
    if s.flex_deg:
        for chain in FINGER_CHAINS.values():
            for j in range(1, 4):  # bend at MCP, PIP and DIP
                pivot = lm[chain[j - 1]].copy()
                d = lm[chain[j]] - pivot
                side = np.cross(d, [0, 0, 1.0])
                r = _rotation(side, -math.radians(s.flex_deg))
                for k in chain[j:]:
                    lm[k] = pivot + r @ (lm[k] - pivot)

    # Rigid finger pitch about the MCP (tip towards the camera, no joint bend).
    for name, deg in s.finger_pitch_deg.items():
        if not deg:
            continue
        chain = ALL_CHAINS[name]
        pivot = lm[chain[0]].copy()
        d = lm[chain[-1]] - pivot
        r = _rotation(np.cross(d, [0, 0, 1.0]), -math.radians(deg))
        for k in chain[1:]:
            lm[k] = pivot + r @ (lm[k] - pivot)

    # Coin rim: top face is `thickness` in front of the palm skin (z = 0 is the skin).
    phi = np.linspace(0, 2 * math.pi, 360, endpoint=False)
    rad = s.coin_diameter_mm / 2
    rim = np.column_stack([rad * np.cos(phi), rad * np.sin(phi), np.full(phi.size, -s.coin_thickness_mm)])
    coin_c = np.array([0.0, 0.0, -s.coin_thickness_mm])

    if s.tilt_deg:
        a = math.radians(s.tilt_axis_deg)
        r = _rotation(np.array([math.cos(a), math.sin(a), 0.0]), math.radians(s.tilt_deg))
        lm, rim, coin_c = lm @ r.T, rim @ r.T, r @ coin_c

    # Centre the hand's bounding box on the optical axis (as the on-screen guide asks), then offset.
    bbox_centre = (pts2.min(axis=0) + pts2.max(axis=0)) / 2
    shift = np.array([s.offset_mm[0] - bbox_centre[0], s.offset_mm[1] - bbox_centre[1], s.distance_mm])
    return lm + shift, rim + shift, coin_c + shift


def project(points: np.ndarray, s: Scene) -> np.ndarray:
    w, h = s.image_size
    x = points[:, 0] / points[:, 2]
    y = points[:, 1] / points[:, 2]
    if s.k1:
        r2 = x * x + y * y
        x, y = x * (1 + s.k1 * r2), y * (1 + s.k1 * r2)
    return np.column_stack([s.focal_px * x + w / 2, s.focal_px * y + h / 2])


def simulate_frame(s: Scene, rng: np.random.Generator | None = None) -> dict:
    """A ``FrameObservation``-shaped dict rendered through the pinhole camera."""
    rng = rng or np.random.default_rng(s.seed)
    lm3, rim3, _ = hand_points_3d(s)
    lm2 = project(lm3, s)
    if s.landmark_bias_px:
        lm2 = lm2 + np.random.default_rng(s.seed + 7919).normal(0, s.landmark_bias_px, lm2.shape)
    if s.landmark_noise_px:
        lm2 = lm2 + rng.normal(0, s.landmark_noise_px, lm2.shape)
    if s.outlier_fraction and rng.random() < s.outlier_fraction:
        lm2 = lm2 + rng.normal(0, s.outlier_px, lm2.shape)
    (cx, cy), (aw, ah), ang = cv2.fitEllipse(project(rim3, s).astype(np.float32))
    major, minor = (aw, ah) if aw >= ah else (ah, aw)
    angle = ang if aw >= ah else ang + 90.0
    world = (lm3 - lm3.mean(axis=0)) / 1000.0  # metres, model-style world landmarks
    if s.world_pitch_bias_deg:
        b = math.radians(s.world_pitch_bias_deg)
        y, z = world[:, 1].copy(), world[:, 2].copy()
        world[:, 1], world[:, 2] = y * math.cos(b) - z * math.sin(b), y * math.sin(b) + z * math.cos(b)
    if s.world_noise_mm or s.world_z_noise_mm:
        sd = np.array([s.world_noise_mm, s.world_noise_mm, s.world_z_noise_mm or s.world_noise_mm]) / 1000.0
        world = world + rng.normal(0, 1.0, world.shape) * sd
    w, h = s.image_size
    return {
        "timestamp_ms": 0.0,
        "image_width": w,
        "image_height": h,
        "landmarks": [{"x": float(x), "y": float(y), "z": 0.0} for x, y in lm2],
        "world_landmarks": [{"x": float(a), "y": float(b), "z": float(c)} for a, b, c in world],
        "handedness": None,
        "handedness_score": None,
        "coin": {
            "center_x": float(cx),
            "center_y": float(cy),
            "major_axis_px": float(major),
            "minor_axis_px": float(min(minor, major)),
            "angle_deg": float(angle % 180.0),
            "edge_support": 0.97,
            "max_angular_gap_deg": 10.0,
            "fit_residual_px": 0.25,
            "edge_width_px": 2.3,
            "glare_fraction": 0.0,
            "contrast": 0.3,
            "n_edge_points": 140,
            "confidence": 0.95,
            "accepted": True,
            "method": "simulation",
            "reasons": [],
        },
        "brightness": 140.0,
    }


def true_hand_length_mm(s: Scene) -> float:
    """Ground truth for the landmark-defined hand length of a flat, extended hand."""
    pts = hand_shape_mm(s)
    return float(np.linalg.norm(pts[0] - pts[12]))


def true_chain_lengths_mm(s: Scene) -> dict[str, float]:
    """Ground truth for the joint-chain lengths of the thumb and the four fingers: the 3D polyline through the
    simulated joint centres (so foreshortening, finger pitch and flexion are all in the truth, not in the
    measurement). This is the landmark-defined length, not a skin-to-skin length."""
    lm3, _, _ = hand_points_3d(s)
    return {
        name: float(np.linalg.norm(np.diff(lm3[list(chain)], axis=0), axis=1).sum()) for name, chain in ALL_CHAINS.items()
    }
