"""Accuracy metrics for camera estimates against physical reference measurements."""

from __future__ import annotations

import math

import numpy as np

Z95 = 1.959964


def error_metrics(estimates: list[float], references: list[float], sigmas: list[float] | None = None) -> dict:
    """Error statistics of ``estimate - reference`` (mm)."""
    est = np.asarray(estimates, dtype=float)
    ref = np.asarray(references, dtype=float)
    if est.shape != ref.shape:
        raise ValueError("estimates and references must have the same length")
    n = int(est.size)
    if n == 0:
        return {"n": 0}
    err = est - ref
    abs_err = np.abs(err)
    sd = float(np.std(err, ddof=1)) if n > 1 else 0.0
    bias = float(err.mean())
    edges = np.arange(-20, 22, 2.0)
    hist, _ = np.histogram(np.clip(err, -20, 19.999), bins=edges)
    out = {
        "n": n,
        "mae_mm": float(abs_err.mean()),
        "rmse_mm": float(math.sqrt(float(np.mean(err**2)))),
        "bias_mm": bias,
        "error_sd_mm": sd,
        "limits_of_agreement_mm": [bias - Z95 * sd, bias + Z95 * sd],
        "abs_error_percentiles_mm": {
            "p50": float(np.percentile(abs_err, 50)),
            "p90": float(np.percentile(abs_err, 90)),
            "p95": float(np.percentile(abs_err, 95)),
            "max": float(abs_err.max()),
        },
        "error_histogram": {"bin_edges_mm": edges.tolist(), "counts": hist.tolist(), "clipped_to_mm": [-20, 20]},
        "relative_mae": float(np.mean(abs_err / ref)),
    }
    if sigmas is not None:
        s = np.asarray(sigmas, dtype=float)
        ok = np.isfinite(s) & (s > 0)
        if ok.any():
            out["coverage_95"] = float(np.mean(abs_err[ok] <= Z95 * s[ok]))
            out["coverage_n"] = int(ok.sum())
    return out


def size_accuracy(
    predicted: list[str | None], alternatives: list[str | None], truth: list[str], order: list[str]
) -> dict:
    """Exact, adjacent (within one size) and 'recommended-or-alternative' accuracy.

    ``predicted`` may contain None for scans where no size could be recommended; these count
    as misses and are also reported separately.
    """
    idx = {s: i for i, s in enumerate(order)}
    n = len(truth)
    if n == 0:
        return {"n": 0}
    exact = adjacent = covered = no_rec = 0
    for p, a, t in zip(predicted, alternatives, truth, strict=True):
        if p is None:
            no_rec += 1
            continue
        if t not in idx or p not in idx:
            raise ValueError(f"size {p!r} or {t!r} not in chart order {order}")
        exact += p == t
        adjacent += abs(idx[p] - idx[t]) <= 1
        covered += t in (p, a)
    return {
        "n": n,
        "exact_accuracy": exact / n,
        "adjacent_accuracy": adjacent / n,
        "recommended_or_alternative_accuracy": covered / n,
        "no_recommendation_rate": no_rec / n,
    }
