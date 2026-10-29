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


def single_view(config):
    """The configuration reduced to its primary (palm) view. Most tests exercise one palm scan; the
    production configuration also requires the back and side views (tests/test_multi_view.py)."""
    return config.model_copy(update={"capture": config.capture.model_copy(update={"views": config.capture.views[:1]})})


@pytest.fixture(autouse=True)
def _palm_only_by_default(monkeypatch):
    """Scans in tests are palm only unless a test asks for more views (test_multi_view.py)."""
    import glovesize.pipeline as pipeline

    monkeypatch.setattr(pipeline, "load_measurement_config", lambda: single_view(load_measurement_config()))


@pytest.fixture
def cfg():
    return single_view(load_measurement_config())


@pytest.fixture
def cfg_nodepth(cfg):
    """Config with the depth-layer correction disabled, so synthetic geometry is exact."""
    return cfg.model_copy(update={"depth_model": cfg.depth_model.model_copy(update={"enabled": False})})


@pytest.fixture
def cfg_rectify(cfg_nodepth):
    """Depth-free config with the (opt-in) affine tilt rectification switched on."""
    cal = cfg_nodepth.calibration.model_copy(update={"tilt_rectification": True, "max_tilt_deg": 20.0})
    return cfg_nodepth.model_copy(update={"calibration": cal})


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


def turn_over(frames: list[dict]) -> list[dict]:
    """The same hand seen from the other side: landmarks (and the depth landmarks and the coin) mirrored
    left-to-right about the image. This flips the sign of ``landmarks.hand_turn`` and changes nothing else."""
    out = []
    for f in frames:
        g = {**f, "landmarks": [{**p, "x": f["image_width"] - p["x"]} for p in f["landmarks"]]}
        if f.get("world_landmarks"):
            g["world_landmarks"] = [{**p, "x": -p["x"]} for p in f["world_landmarks"]]
        if f.get("coin"):
            g["coin"] = {**f["coin"], "center_x": f["image_width"] - f["coin"]["center_x"]}
        out.append(g)
    return out


def side_on(frames: list[dict], squash: float = 0.3) -> list[dict]:
    """The same hand turned towards its edge: landmarks squeezed left-to-right about the wrist, so the
    wrist-to-index and wrist-to-little-knuckle lines nearly coincide (|hand_turn| about 0.2 at 0.3)."""
    out = []
    for f in frames:
        x0 = f["landmarks"][0]["x"]
        out.append({**f, "landmarks": [{**p, "x": x0 + (p["x"] - x0) * squash} for p in f["landmarks"]]})
    return out


def frame_obs(**kwargs) -> FrameObservation:
    return FrameObservation.model_validate(synthetic_frame(**kwargs))


@pytest.fixture
def no_depth_config(monkeypatch, cfg_nodepth):
    """Make the pipeline use the depth-disabled config."""
    import glovesize.pipeline as pipeline

    monkeypatch.setattr(pipeline, "load_measurement_config", lambda: cfg_nodepth)
    return cfg_nodepth


@pytest.fixture
def operator_client():
    """A client on this machine sending the operator header, as validation mode and the research
    endpoints require (glovesize/operator_access.py)."""
    from fastapi.testclient import TestClient

    from glovesize.api import app

    with TestClient(
        app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000), headers={"X-Glovesize-Operator": "1"}
    ) as c:
        yield c
