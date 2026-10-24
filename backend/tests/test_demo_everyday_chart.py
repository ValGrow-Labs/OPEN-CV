"""The placeholder everyday chart: three coarse sizes, so the camera alone can name a size in a demo.

It is a demonstration chart with invented boundaries (clearly labelled as such), not a real size
standard. These tests check that it is valid, labelled, and that at the camera uncertainty seen in a
real phone recording (about 7.7 mm) it never has to say "more information needed". They say nothing
about whether the sizes fit anyone.
"""

import pytest

from glovesize.config import default_chart_id, load_sizing_charts
from glovesize.sizing import MeasuredValue, recommend

SIGMA_SEEN_ON_A_PHONE = 7.7


@pytest.fixture(scope="module")
def chart():
    return load_sizing_charts()["demo-everyday-v1"]


def test_it_is_a_labelled_demo_with_three_contiguous_sizes(chart):
    assert chart.is_demo and "DEMONSTRATION" in (chart.disclaimer or "")
    assert "placeholder" in (chart.product_model or "").lower()
    assert [s.label for s in chart.sizes] == ["S", "M", "L"]
    bands = [s.ranges["hand_length_mm"] for s in chart.sizes]
    assert bands[0][0] is None and bands[-1][1] is None
    assert bands[0][1] == bands[1][0] and bands[1][1] == bands[2][0]


def test_it_is_the_default_chart():
    assert default_chart_id() == "demo-everyday-v1"


@pytest.mark.parametrize("reading", range(140, 231, 5))
def test_a_camera_reading_always_gets_a_size_at_the_uncertainty_seen_on_a_phone(chart, reading):
    rec = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", float(reading), SIGMA_SEEN_ON_A_PHONE, "low_confidence")})
    assert rec.status in ("recommended", "borderline")
    assert rec.size in ("S", "M", "L")
    assert rec.is_demo_chart and rec.disclaimer


def test_the_size_grows_with_the_reading_and_the_recording_case_is_medium(chart):
    sizes = [
        recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", float(v), SIGMA_SEEN_ON_A_PHONE, "valid")}).size
        for v in range(140, 231, 2)
    ]
    order = {"S": 0, "M": 1, "L": 2}
    assert [order[s] for s in sizes] == sorted(order[s] for s in sizes)
    rec = recommend(chart, {"hand_length_mm": MeasuredValue("hand_length_mm", 174.0, SIGMA_SEEN_ON_A_PHONE, "low_confidence")})
    assert rec.size == "M" and rec.alternative_size == "S"  # 174 mm, 7.7 mm: closer to the S boundary
