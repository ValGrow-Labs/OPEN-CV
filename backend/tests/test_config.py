import json

import pytest
from pydantic import ValidationError

from glovesize import config as config_mod
from glovesize.config import SizingChart, load_app_config, load_sizing_charts


def test_shipped_configuration_is_valid():
    config_mod.load_reference_objects()
    config_mod.load_measurement_config()
    config_mod.load_measurement_calibration()
    charts = load_sizing_charts()
    assert config_mod.default_chart_id() in charts
    assert load_app_config().research_collection_enabled is False


def test_quarter_is_default_reference_with_official_diameter():
    refs = config_mod.load_reference_objects()
    q = refs.get(refs.default)
    assert q is not None and q.id == "us_quarter"
    assert q.diameter_mm == pytest.approx(24.26)


def test_shipped_charts_are_marked_demo():
    for chart in load_sizing_charts().values():
        assert chart.is_demo and "SYNTHETIC" in chart.disclaimer


def _chart(**over):
    base = {
        "chart_id": "t",
        "is_demo": False,
        "rules": {"measurements": ["hand_length_mm"], "combine": "primary_only"},
        "sizes": [
            {"label": "S", "ranges": {"hand_length_mm": [None, 170]}},
            {"label": "M", "ranges": {"hand_length_mm": [170, 185]}},
            {"label": "L", "ranges": {"hand_length_mm": [185, None]}},
        ],
    }
    base.update(over)
    return base


def test_valid_custom_chart():
    SizingChart.model_validate(_chart())


@pytest.mark.parametrize(
    "sizes",
    [
        # overlapping
        [
            {"label": "S", "ranges": {"hand_length_mm": [None, 175]}},
            {"label": "M", "ranges": {"hand_length_mm": [170, None]}},
        ],
        # open bound in the middle
        [
            {"label": "S", "ranges": {"hand_length_mm": [None, 170]}},
            {"label": "M", "ranges": {"hand_length_mm": [None, 185]}},
            {"label": "L", "ranges": {"hand_length_mm": [185, None]}},
        ],
        # empty range
        [
            {"label": "S", "ranges": {"hand_length_mm": [None, 170]}},
            {"label": "M", "ranges": {"hand_length_mm": [180, 180]}},
        ],
        # missing measurement range
        [{"label": "S", "ranges": {"palm_breadth_mm": [None, 170]}}],
        # duplicate labels
        [
            {"label": "S", "ranges": {"hand_length_mm": [None, 170]}},
            {"label": "S", "ranges": {"hand_length_mm": [170, None]}},
        ],
    ],
)
def test_invalid_charts_rejected(sizes):
    with pytest.raises(ValidationError):
        SizingChart.model_validate(_chart(sizes=sizes))


def test_demo_chart_requires_disclaimer():
    with pytest.raises(ValidationError):
        SizingChart.model_validate(_chart(is_demo=True))


def test_config_dir_override(tmp_path, monkeypatch):
    src = config_mod.config_dir()
    for name in ("reference_objects.json", "measurement.json", "measurement_calibration.json", "app.json"):
        (tmp_path / name).write_text((src / name).read_text())
    (tmp_path / "sizing_charts").mkdir()
    (tmp_path / "sizing_charts" / "client.json").write_text(json.dumps(_chart(chart_id="client-1")))
    app = json.loads((src / "app.json").read_text())
    app["default_chart_id"] = "client-1"
    (tmp_path / "app.json").write_text(json.dumps(app))
    monkeypatch.setenv("GLOVESIZE_CONFIG_DIR", str(tmp_path))
    config_mod.clear_caches()
    assert list(load_sizing_charts()) == ["client-1"]
    assert config_mod.default_chart_id() == "client-1"
