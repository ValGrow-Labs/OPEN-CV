"""Catalogue of quality-issue codes and the customer-facing guidance for each."""

from __future__ import annotations

from typing import Literal

Severity = Literal["error", "warning", "info"]

ISSUES: dict[str, tuple[Severity, str]] = {
    # Frame-level hand issues
    "landmarks_invalid": ("error", "The hand could not be tracked reliably. Hold your hand still in good light."),
    "hand_out_of_frame": ("error", "Part of your hand is outside the camera view. Move it fully inside the guide."),
    "hand_too_small": ("error", "Your hand is too small in the picture. Bring it closer to the camera."),
    "fingers_bent": ("error", "Straighten your fingers and keep them flat."),
    "palm_not_flat": ("error", "Hold your palm flat and facing the camera directly."),
    # Frame-level coin issues
    "coin_missing": ("error", "No coin detected. Place the coin flat in the centre of your palm."),
    "coin_not_found": ("error", "No coin detected. Place the coin flat in the centre of your palm."),
    "coin_too_small": ("error", "The coin is too small in the picture. Bring your hand closer to the camera."),
    "coin_occluded": ("error", "The coin's edge is partly hidden. Make sure the whole coin is visible."),
    "coin_blurry": ("error", "The image is blurry. Hold still and make sure the camera is focused."),
    "coin_glare": (
        "error",
        "There is glare on the coin. Tilt your hand slightly away from the light or move away from direct light.",
    ),
    "coin_low_contrast": ("error", "The coin is hard to distinguish from your palm. Avoid glare and over-bright light; use soft, even light."),
    "coin_irregular_boundary": (
        "error",
        "The coin's outline is unclear. Check that only one coin is used and it lies flat.",
    ),
    "coin_low_confidence": ("error", "The coin could not be measured reliably. Improve lighting and hold still."),
    "coin_ambiguous": (
        "error",
        "More than one coin-like circle is visible. Use a single coin and keep other round objects out of view.",
    ),
    "coin_not_on_palm": ("error", "Place the coin on the centre of your palm."),
    "coin_tilted": ("error", "The coin appears tilted. Hold your palm flat, facing the camera directly."),
    "too_close": ("error", "Your hand is too close to the camera. Move it a little farther away."),
    "too_dark": ("error", "The scene is too dark. Move to a brighter place."),
    "too_bright": ("error", "The scene is overexposed. Avoid pointing the camera at a bright light."),
    "implausible_scale": (
        "error",
        "The measured size is outside the expected human range. Check the selected coin type.",
    ),
    # Scan-level
    "unknown_view": ("error", "A capture view that is not configured was submitted."),
    "primary_view_missing": ("error", "The palm view is required. Please scan your palm first."),
    "required_view_missing": ("error", "A required view is missing. Please scan every view."),
    "required_view_failed": ("error", "A required view did not have enough good frames. Please rescan."),
    "view_dropped": (
        "warning",
        "One extra view could not be used (too few good frames), so your size is based on the other view(s) only.",
    ),
    "views_disagree": (
        "warning",
        "The views gave different hand lengths. Check that the same coin is used and lies flat in each view, then rescan.",
    ),
    "insufficient_frames": ("error", "Not enough good-quality frames were captured. Please scan again."),
    "hand_length_unreliable": ("error", "Hand length could not be measured with enough certainty. Please scan again."),
    "measurement_unstable": ("warning", "Measurements varied between frames. Keep your hand still during the scan."),
    "tilt_corrected": ("info", "A small palm tilt was detected; lengths were adjusted assuming a flat hand."),
    "scan_unstable": (
        "error",
        "Your measurements changed too much between frames. Hold your hand and the coin still and scan again.",
    ),
    "custom_reference": ("warning", "A custom reference object was used; accuracy depends on its stated diameter."),
    "reference_unavailable": ("error", "The selected reference object is not available."),
    "reference_unconfirmed": ("error", "Please confirm which coin you are holding before scanning."),
    "reference_size_unchecked": (
        "error",
        "Please confirm the size of your coin: older coins with the same value are a different size.",
    ),
    "uncertainty_unvalidated": (
        "info",
        "This is an unvalidated prototype: its measurements and uncertainty values have not yet been checked against tape-measured hands.",
    ),
}


def describe(code: str) -> tuple[Severity, str]:
    return ISSUES.get(code, ("error", "The scan could not be completed. Please try again."))
