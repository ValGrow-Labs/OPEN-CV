import pytest

from glovesize.config import load_sizing_charts
from glovesize.sizing import MeasuredValue, band_index, recommend


@pytest.fixture
def length_chart():
    return load_sizing_charts()["demo-length-v1"]  # XS <163 | S 163-175 | M 175-187 | L 187-199 | XL 199-211 | XXL


@pytest.fixture
def combo_chart():
    return load_sizing_charts()["demo-length-circumference-v1"]


def mv(key, value, sigma, status="valid"):
    return {key: MeasuredValue(key, value, sigma, status)}


@pytest.mark.parametrize(
    "value,label",
    [
        (100, "XS"),
        (162.99, "XS"),
        (163.0, "S"),
        (174.9, "S"),
        (175.0, "M"),
        (186.99, "M"),
        (187.0, "L"),
        (211.0, "XXL"),
        (400, "XXL"),
    ],
)
def test_band_index_boundaries(length_chart, value, label):
    assert length_chart.sizes[band_index(length_chart, "hand_length_mm", value)].label == label


def test_clear(length_chart):
    r = recommend(length_chart, mv("hand_length_mm", 181.0, 1.5))
    assert (r.status, r.size, r.alternative_size, r.confidence_level) == ("recommended", "M", None, "clear")
    assert r.is_demo_chart and r.disclaimer


def test_likely_with_alternative(length_chart):
    r = recommend(length_chart, mv("hand_length_mm", 185.5, 1.0))  # +2 sigma crosses 187
    assert (r.status, r.size, r.alternative_size, r.confidence_level) == ("recommended", "M", "L", "likely")


def test_borderline_two_sizes(length_chart):
    r = recommend(length_chart, mv("hand_length_mm", 186.5, 1.0))  # +1 sigma crosses 187
    assert (r.status, r.size, r.alternative_size, r.confidence_level) == ("borderline", "M", "L", "borderline")


def test_borderline_below_boundary_alternative_is_smaller(length_chart):
    r = recommend(length_chart, mv("hand_length_mm", 175.4, 1.0))
    assert (r.size, r.alternative_size) == ("M", "S")


def test_exact_boundary_with_zero_uncertainty_is_upper_size(length_chart):
    r = recommend(length_chart, mv("hand_length_mm", 187.0, 0.0))
    assert (r.size, r.confidence_level) == ("L", "clear")


def test_uncertain_requests_more_data(length_chart):
    r = recommend(length_chart, mv("hand_length_mm", 181.0, 10.0))
    assert r.status == "needs_more_data" and r.confidence_level == "uncertain"
    assert r.needed_measurements == ["hand_length_mm"]


def test_low_confidence_cannot_be_clear(length_chart):
    r = recommend(length_chart, mv("hand_length_mm", 181.0, 1.0, "low_confidence"))
    assert r.confidence_level == "likely"


def test_invalid_measurement_not_used(length_chart):
    r = recommend(length_chart, mv("hand_length_mm", 181.0, 1.0, "invalid"))
    assert r.status == "needs_more_data" and r.size is None


def test_missing_circumference_requested(combo_chart):
    r = recommend(combo_chart, mv("hand_length_mm", 181.0, 1.0))
    assert r.status == "needs_more_data"
    assert r.needed_measurements == ["hand_circumference_mm"]
    assert any("tape" in e for e in r.explanation)


def test_largest_size_rule(combo_chart):
    m = mv("hand_length_mm", 192.0, 1.0) | mv("hand_circumference_mm", 200.0, 2.0, "user_entered")
    r = recommend(combo_chart, m)
    # circumference -> 8, length -> 9 ; rule picks the larger
    assert r.size == "9"
    assert {b.key: b.size for b in r.by_measurement} == {"hand_circumference_mm": "8", "hand_length_mm": "9"}
    assert any("larger" in e for e in r.explanation)


def test_explanation_has_units_and_ranges(length_chart):
    r = recommend(length_chart, mv("hand_length_mm", 181.0, 1.5))
    text = " ".join(r.explanation)
    assert "181 mm" in text and "in)" in text and "175-187 mm" in text


def test_no_fit_probability_language(length_chart):
    r = recommend(length_chart, mv("hand_length_mm", 181.0, 1.5))
    text = " ".join(r.explanation).lower()
    assert "guarantee" not in text and "%" not in text


def test_uncertain_gives_no_size_and_lists_plausible_sizes(length_chart):
    r = recommend(length_chart, mv("hand_length_mm", 181.0, 10.0))
    assert r.size is None and r.alternative_size is None
    assert r.plausible_sizes == ["XS", "S", "M", "L", "XL"]  # 181 +/- 20 mm
    assert any("can't recommend" in e for e in r.explanation)
    assert any("wrist" in e for e in r.explanation)  # tells the customer how to measure


def test_tape_measured_value_supports_a_recommendation(length_chart):
    # A tape measurement (+/- 4 mm assumed) inside a band gives a recommendation.
    r = recommend(length_chart, mv("hand_length_mm", 181.0, 2.5, "user_entered"))
    assert r.size == "M" and r.status == "recommended"


def test_tape_value_is_never_uncertain(length_chart):
    # A tape value mid-band: recommended, with the nearer neighbouring size flagged.
    r = recommend(length_chart, mv("hand_length_mm", 181.0, 4.0, "user_entered"))
    assert (r.size, r.confidence_level) == ("M", "borderline")
    assert r.alternative_size in ("S", "L")
    r = recommend(length_chart, mv("hand_length_mm", 185.5, 4.0, "user_entered"))
    assert (r.size, r.alternative_size) == ("M", "L")


def test_alternative_is_the_nearer_neighbour(length_chart):
    assert recommend(length_chart, mv("hand_length_mm", 176.0, 4.0, "user_entered")).alternative_size == "S"
    assert recommend(length_chart, mv("hand_length_mm", 186.0, 4.0, "user_entered")).alternative_size == "L"


@pytest.mark.parametrize(
    "value,sigma,level,size,alt",
    [
        (169.0, 1.0, "clear", "S", None),
        (174.0, 0.8, "likely", "S", "M"),
        (174.6, 0.8, "borderline", "S", "M"),
        (175.2, 0.8, "borderline", "M", "S"),
        (163.0, 0.0, "clear", "S", None),
    ],
)
def test_adjacent_size_cases(length_chart, value, sigma, level, size, alt):
    r = recommend(length_chart, mv("hand_length_mm", value, sigma))
    assert (r.confidence_level, r.size, r.alternative_size) == (level, size, alt)


def test_missing_and_invalid_measurements_explain_what_is_needed(combo_chart):
    r = recommend(combo_chart, {})
    assert r.status == "needs_more_data" and r.size is None
    assert set(r.needed_measurements) == {"hand_circumference_mm", "hand_length_mm"}
    r = recommend(
        combo_chart,
        mv("hand_circumference_mm", 200.0, 4.0, "user_entered") | mv("hand_length_mm", 180.0, 2.0, "invalid"),
    )
    assert r.needed_measurements == ["hand_length_mm"]
