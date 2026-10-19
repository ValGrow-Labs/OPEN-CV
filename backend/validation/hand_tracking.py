"""MediaPipe Hand Landmarker wrapper for offline validation (still images).

Requires the optional dependencies in requirements-validation.txt and the model file
``models/hand_landmarker.task`` (see scripts/download_models.py).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from glovesize.config import REPO_ROOT

DEFAULT_MODEL = REPO_ROOT / "models" / "hand_landmarker.task"


@dataclass
class HandDetection:
    landmarks_px: np.ndarray  # (21, 3): x, y in pixels, z = MediaPipe relative depth scaled by width
    world: np.ndarray  # (21, 3) metres (model estimate)
    handedness: str | None  # as reported by the model for the image as given
    handedness_score: float | None


class HandTracker:
    def __init__(self, model_path: Path = DEFAULT_MODEL, min_confidence: float = 0.5):
        from mediapipe.tasks.python import BaseOptions, vision

        if not Path(model_path).is_file():
            raise FileNotFoundError(f"{model_path} not found; run scripts/download_models.py")
        options = vision.HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(model_path)),
            running_mode=vision.RunningMode.IMAGE,
            num_hands=1,
            min_hand_detection_confidence=min_confidence,
            min_hand_presence_confidence=min_confidence,
            min_tracking_confidence=min_confidence,
        )
        self._landmarker = vision.HandLandmarker.create_from_options(options)

    def detect(self, image_bgr: np.ndarray) -> HandDetection | None:
        import mediapipe as mp

        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        result = self._landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        if not result.hand_landmarks:
            return None
        h, w = image_bgr.shape[:2]
        lm = np.array([(p.x * w, p.y * h, p.z * w) for p in result.hand_landmarks[0]])
        world = np.array([(p.x, p.y, p.z) for p in result.hand_world_landmarks[0]])
        cat = result.handedness[0][0] if result.handedness else None
        return HandDetection(lm, world, cat.category_name if cat else None, float(cat.score) if cat else None)

    def close(self) -> None:
        self._landmarker.close()

    def __enter__(self) -> HandTracker:
        return self

    def __exit__(self, *exc) -> None:
        self.close()
