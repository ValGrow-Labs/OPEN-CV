"""Parameters of the experimental paper method (config.json next to this file)."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

CONFIG_PATH = Path(__file__).with_name("config.json")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PaperSpec(_Strict):
    label: str
    width_mm: float = Field(gt=50, lt=1000)
    height_mm: float = Field(gt=50, lt=1000)
    tolerance_mm: float = Field(ge=0, lt=10)
    source: str


class PaperDetectionParams(_Strict):
    min_area_fraction: float = Field(gt=0, lt=1)
    edge_samples: int = Field(ge=20, le=1000)
    edge_search_px: int = Field(ge=2, le=40)
    min_edge_inlier_fraction: float = Field(gt=0, le=1)
    max_edge_curvature_mm: float = Field(gt=0)
    aspect_tolerance: float = Field(gt=0, lt=0.5)


class HandParams(_Strict):
    min_margin_mm: float = Field(ge=0)
    max_axis_angle_deg: float = Field(gt=0, lt=45)
    palm_level_fraction_of_length: float = Field(gt=0.3, lt=0.8)
    palm_band_mm: float = Field(ge=0, le=20)
    min_wrist_width_mm: float = Field(gt=0)
    # Hand breadth / hand length above this suggests the thumb is merged with the palm outline.
    max_breadth_to_length: float = Field(gt=0.3, lt=0.8)


class SilhouetteHeights(_Strict):
    fingertip: float = Field(ge=0, le=40)
    palm_edge: float = Field(ge=0, le=40)


class GeometryAssumptions(_Strict):
    assumed_hfov_deg: tuple[float, float]
    silhouette_height_mm: SilhouetteHeights
    silhouette_height_sd_mm: float = Field(ge=0)
    wrist_alignment_sd_mm: float = Field(ge=0)
    outline_sd_mm: float = Field(ge=0)


class PaperMethodConfig(_Strict):
    comment: str | None = Field(default=None, alias="_comment")
    papers: dict[str, PaperSpec]
    rectify_px_per_mm: float = Field(gt=0.5, le=20)
    paper_detection: PaperDetectionParams
    hand: HandParams
    geometry_assumptions: GeometryAssumptions


@lru_cache(maxsize=1)
def load_config(path: Path = CONFIG_PATH) -> PaperMethodConfig:
    return PaperMethodConfig.model_validate(json.loads(path.read_text(encoding="utf-8")))
