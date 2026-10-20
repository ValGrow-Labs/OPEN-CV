"""EXPERIMENTAL: hand measured flat on a known-size sheet of paper, photographed from above.

An alternative to the production coin-on-palm method, evaluated offline only. It is not wired
into the app, its API or config/. See docs/PAPER_METHOD_EVALUATION.md.

Pipeline (measure.measure_photo):

1. paper.detect_paper: find the sheet's four edges by sub-pixel line fitting (robust to the
   wrist covering part of an edge) and intersect them for the corners.
2. paper.PaperGeometry: the plane-to-plane homography to millimetres on the sheet, a focal
   length and camera-pose estimate from the rectangle's vanishing points, and a check that the
   sheet's measured aspect ratio matches the paper size the customer selected.
3. hand.segment_hand: rectify the sheet and separate the hand by its warm chroma (shadows on
   white paper are grey, so they are not mistaken for skin).
4. hand.measure_outline: hand length from the wrist edge of the sheet (protocol: wrist crease on
   the edge) to the farthest point of the outline (middle fingertip skin), and breadth across
   the outline at the metacarpal level (from MediaPipe MCP landmarks if given, else a heuristic
   level). Outline points are skin edges, not joint centres.
"""
