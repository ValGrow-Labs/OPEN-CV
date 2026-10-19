"""Transparent, rules-based glove-size recommendation.

The engine applies a manufacturer's chart (``config/sizing_charts/*.json``) to measured
values and their uncertainties. Measurement uncertainty is propagated by checking which
size ranges overlap the value +/- 1 sigma and +/- 2 sigma intervals:

* ``clear``      - the +/- 2 sigma interval lies within one size;
* ``likely``     - +/- 1 sigma lies within one size, +/- 2 sigma reaches a neighbour;
* ``borderline`` - +/- 1 sigma already spans two sizes (both are plausible);
* ``uncertain``  - +/- 2 sigma spans three or more sizes (rescan or measure by hand).

These levels describe *measurement* uncertainty only. They are not the probability that a
glove will fit, which depends on the product and on preference.
"""

from __future__ import annotations

from dataclasses import dataclass

from .config import SizingChart
from .schemas import RecommendationOut, SizeByMeasurement

LEVEL_ORDER = ["clear", "likely", "borderline", "uncertain"]

MEASUREMENT_NAMES = {
    "hand_length_mm": "hand length",
    "hand_circumference_mm": "hand circumference",
    "palm_breadth_mm": "palm breadth",
    "mcp_span_mm": "palm width",
}

HOW_TO_MEASURE = {
    "hand_circumference_mm": "Wrap a soft tape measure around your palm at the knuckles (excluding the thumb) and enter the value.",
    "palm_breadth_mm": "Measure the width of your palm across the knuckles, excluding the thumb, and enter the value.",
    "hand_length_mm": "Rescan your hand, or measure from the wrist crease to the tip of your middle finger.",
}


@dataclass(frozen=True)
class MeasuredValue:
    key: str
    value: float
    sigma: float
    status: str


def _fmt(v: float) -> str:
    return f"{v:.0f} mm ({v / 25.4:.2f} in)"


def band_index(chart: SizingChart, key: str, value: float) -> int:
    """Index of the size whose [min, max) range contains ``value``.

    A value in a gap between two sizes is assigned to the larger size; a value below or above
    the chart is clamped to the first or last size.
    """
    for i, band in enumerate(chart.sizes):
        lo, hi = band.ranges[key]
        if (lo is None or value >= lo) and (hi is None or value < hi):
            return i
    for i, band in enumerate(chart.sizes):
        lo, _ = band.ranges[key]
        if lo is not None and value < lo:
            return i
    return len(chart.sizes) - 1


def overlapping(chart: SizingChart, key: str, lo_v: float, hi_v: float) -> tuple[int, int]:
    return band_index(chart, key, lo_v), band_index(chart, key, hi_v)


def _range_text(chart: SizingChart, key: str, i: int) -> str:
    lo, hi = chart.sizes[i].ranges[key]
    if lo is None:
        return f"below {hi:.0f} mm"
    if hi is None:
        return f"{lo:.0f} mm and above"
    return f"{lo:.0f}-{hi:.0f} mm"


def recommend(chart: SizingChart, measured: dict[str, MeasuredValue]) -> RecommendationOut:
    rules = chart.rules
    required = rules.measurements[:1] if rules.combine == "primary_only" else rules.measurements
    usable = {k: m for k, m in measured.items() if m.status in ("valid", "low_confidence", "user_entered")}
    missing = [k for k in required if k not in usable]

    common = dict(
        chart_id=chart.chart_id,
        manufacturer=chart.manufacturer,
        product_model=chart.product_model,
        is_demo_chart=chart.is_demo,
        disclaimer=chart.disclaimer,
        basis=[MEASUREMENT_NAMES.get(k, k) for k in required],
    )
    if missing:
        return RecommendationOut(
            **common,
            status="needs_more_data",
            size=None,
            alternative_size=None,
            confidence_level=None,
            explanation=[f"This product is sized by {', '.join(MEASUREMENT_NAMES.get(k, k) for k in required)}."]
            + [HOW_TO_MEASURE.get(k, f"A reliable {k} measurement is needed.") for k in missing],
            needed_measurements=missing,
            by_measurement=[],
        )

    per: list[SizeByMeasurement] = []
    idx, lo1, hi1, lo2, hi2 = [], [], [], [], []
    for k in required:
        m = usable[k]
        i = band_index(chart, k, m.value)
        a1, b1 = overlapping(chart, k, m.value - m.sigma, m.value + m.sigma)
        a2, b2 = overlapping(chart, k, m.value - 2 * m.sigma, m.value + 2 * m.sigma)
        idx.append(i)
        lo1.append(a1)
        hi1.append(b1)
        lo2.append(a2)
        hi2.append(b2)
        per.append(
            SizeByMeasurement(
                key=k,
                value_mm=round(m.value, 1),
                uncertainty_mm=round(m.sigma, 1),
                size=chart.sizes[i].label,
                plausible_sizes=[chart.sizes[j].label for j in range(a2, b2 + 1)],
            )
        )

    # "largest_size": the recommendation is the largest of the per-measurement sizes; the
    # same max() applied to interval ends gives the plausible range of that recommendation.
    best = max(idx)
    r1 = (max(lo1), max(hi1))
    r2 = (max(lo2), max(hi2))
    if r2[1] - r2[0] >= 2:
        level = "uncertain"
    elif r1[1] > r1[0]:
        level = "borderline"
    elif r2[1] > r2[0]:
        level = "likely"
    else:
        level = "clear"
    if level == "clear" and any(usable[k].status == "low_confidence" for k in required):
        level = "likely"

    alternative = None
    if level in ("likely", "borderline"):
        span = r1 if level == "borderline" else r2
        alt = span[1] if span[1] != best else span[0]
        alternative = chart.sizes[alt].label if alt != best else None

    size = chart.sizes[best].label
    explanation: list[str] = []
    for k, m, i in zip(required, (usable[k] for k in required), idx, strict=False):
        explanation.append(
            f"Your {MEASUREMENT_NAMES.get(k, k)} is {_fmt(m.value)}, with an estimated uncertainty of ±{m.sigma:.1f} mm; "
            f"size {chart.sizes[i].label} covers {_range_text(chart, k, i)}."
        )
    if rules.combine == "largest_size" and len(set(idx)) > 1:
        explanation.append(
            f"Your measurements point to different sizes; this product's rule is to choose the larger one ({size})."
        )
    if level == "clear":
        explanation.append(f"Size {size} is clearly indicated even allowing for measurement uncertainty.")
    elif level == "likely":
        explanation.append(
            f"Size {size} is most likely; {alternative} is possible because your measurement is close to a size boundary."
        )
    elif level == "borderline":
        explanation.append(
            f"Your measurement is on the boundary between {size} and {alternative}; both may fit. Consider trying both, or measure with a tape to confirm."
        )
    else:
        plausible = [chart.sizes[j].label for j in range(r2[0], r2[1] + 1)]
        explanation.append(
            f"Size {size} is the single most likely size, but the measurement uncertainty spans "
            f"{', '.join(plausible)}. Please confirm with a tape measure before ordering."
        )
    if rules.notes:
        explanation.append(f"Sizing rule: {rules.notes}")

    status = {
        "clear": "recommended",
        "likely": "recommended",
        "borderline": "borderline",
        "uncertain": "needs_more_data",
    }[level]
    return RecommendationOut(
        **common,
        status=status,  # type: ignore[arg-type]
        size=size,
        alternative_size=alternative,
        confidence_level=level,  # type: ignore[arg-type]
        explanation=explanation,
        needed_measurements=[] if level != "uncertain" else list(required),
        by_measurement=per,
    )
