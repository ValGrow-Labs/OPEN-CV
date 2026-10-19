from __future__ import annotations

import numpy as np
import pytest

from glovesize import config as config_mod
from glovesize.calibration import ReferenceSpec
from glovesize.config import load_measurement_calibration, load_measurement_config, load_reference_objects
from glovesize.schemas import FrameObservation
from glovesize.synthetic import synthetic_frame

QUARTER = ReferenceSpec("US quarter", 24.26, 0.05, 1.75, False)


@pytest.fixture(autouse=True)
def _fresh_config_caches():
    config_mod.clear_caches()
    yield
    config_mod.clear_caches()


@pytest.fixture
def cfg():
    return load_measurement_config()


@pytest.fixture
def cfg_nodepth(cfg):
    """Config with the depth-layer correction disabled, so synthetic geometry is exact."""
    return cfg.model_copy(update={"depth_model": cfg.depth_model.model_copy(update={"enabled": False})})


@pytest.fixture
def calib():
    return load_measurement_calibration()


@pytest.fixture
def refs():
    return load_reference_objects()


def make_frames(n: int = 24, noise_px: float = 1.0, seed: int = 1, **kwargs) -> list[dict]:
    rng = np.random.default_rng(seed)
    frames = []
    for i in range(n):
        f = synthetic_frame(landmark_noise_px=noise_px, rng=rng, **kwargs)
        f["timestamp_ms"] = float(i * 33)
        frames.append(f)
    return frames


def frame_obs(**kwargs) -> FrameObservation:
    return FrameObservation.model_validate(synthetic_frame(**kwargs))


@pytest.fixture
def no_depth_config(monkeypatch, cfg_nodepth):
    """Make the pipeline use the depth-disabled config."""
    import glovesize.pipeline as pipeline

    monkeypatch.setattr(pipeline, "load_measurement_config", lambda: cfg_nodepth)
    return cfg_nodepth
