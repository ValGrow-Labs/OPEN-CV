// Pure helpers of the EXPERIMENTAL dense-scan page (no DOM): what the counters show, the scan quality grade, the honest
// caption of the 3D preview, and the transform of the core's image-space geometry into the viewer's space.
// Every number shown on the page is computed here from the real point arrays; nothing is invented to look busy.
import type { BinaryMask, Mesh } from "../../common";
import type { PointSet, SurfacePoint } from "../core";

export interface Revealed {
  generated: number;
  accepted: number;
  rejected: number;
}

/** Counts of the points the scan line has passed (y at or above the line), from the real list. */
export function revealedCounts(points: readonly Pick<SurfacePoint, "y" | "accepted">[] | null, lineY: number): Revealed {
  if (!points) return { generated: 0, accepted: 0, rejected: 0 };
  let generated = 0;
  let accepted = 0;
  for (const p of points) {
    if (p.y > lineY) continue;
    generated++;
    if (p.accepted) accepted++;
  }
  return { generated, accepted, rejected: generated - accepted };
}

export type ScanQuality = "good" | "fair" | "poor" | "unknown";

/** Provisional, unvalidated thresholds on the share of accepted points. A rejected segmentation is always poor. */
export const QUALITY_GOOD = 0.85;
export const QUALITY_FAIR = 0.6;

export function scanQuality(r: Revealed, segmentationOk: boolean | null): ScanQuality {
  if (segmentationOk === false) return "poor";
  if (segmentationOk === null || r.generated === 0) return "unknown";
  const share = r.accepted / r.generated;
  return share >= QUALITY_GOOD ? "good" : share >= QUALITY_FAIR ? "fair" : "poor";
}

export const QUALITY_WORDS: Record<ScanQuality, string> = {
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  unknown: "Not judged yet",
};

/** The 3D preview's caption: it says what the geometry IS. Never "measured" unless the core reports measured depth. */
export function captionFor(view: "points" | "mesh", zUnit: "mm" | "relative" | null, meshMeasured: boolean): string {
  if (view === "mesh") {
    return meshMeasured
      ? "Mesh with measured depth (mm) from a depth sensor. Experimental, not validated."
      : "Flat 2D surface-point map (no depth): a coverage map of the visible hand, not a 3D scan.";
  }
  if (zUnit === "mm") return "Points with measured depth (mm) from a depth sensor. Experimental, not validated.";
  if (zUnit === "relative") return "Estimated relative depth (MediaPipe), not a measured 3D scan.";
  return "Flat 2D surface-point map (no depth).";
}

/** Top and bottom rows of the hand in SOURCE pixels, from the mask (for the scan line's travel). */
export function maskRowsSource(mask: BinaryMask, scaleToSource: number): { top: number; bottom: number } | null {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width;
    for (let x = 0; x < mask.width; x++) {
      if (!mask.data[row + x]) continue;
      if (top < 0) top = y;
      bottom = y;
      break;
    }
  }
  if (top < 0) return null;
  return { top: top * scaleToSource, bottom: (bottom + 1) * scaleToSource };
}

/** Image-space x, y (y down) and z into the viewer's space: centred, y up, x and y multiplied by `xyScale` (mm per px from
 *  the coin, or 1 for pixels) and z by `zScale`. Returns a new array. */
export function toViewerSpace(positions: Float32Array, xyScale: number, zScale: number): Float32Array {
  const n = positions.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += positions[i * 3];
    cy += positions[i * 3 + 1];
    cz += positions[i * 3 + 2];
  }
  if (n) {
    cx /= n;
    cy /= n;
    cz /= n;
  }
  const out = new Float32Array(positions.length);
  for (let i = 0; i < n; i++) {
    out[i * 3] = (positions[i * 3] - cx) * xyScale;
    out[i * 3 + 1] = -(positions[i * 3 + 1] - cy) * xyScale;
    // MediaPipe's z is smaller nearer the camera: flip so "towards the viewer" is +z.
    out[i * 3 + 2] = -(positions[i * 3 + 2] - cz) * zScale;
  }
  return out;
}

/** The core's lattice mesh (image space, y down) into the viewer's space; the flip of y reverses the winding, so each
 *  triangle's last two indices are swapped to keep it counter-clockwise from the front. */
export function meshToViewerSpace(mesh: Mesh): Mesh {
  const indices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    indices[t] = mesh.indices[t];
    indices[t + 1] = mesh.indices[t + 2];
    indices[t + 2] = mesh.indices[t + 1];
  }
  return { vertices: toViewerSpace(mesh.vertices, 1, 1), indices };
}

export const REASON_WORDS: Record<string, string> = {
  outside_mask: "outside the hand",
  near_edge: "too near the hand's edge",
  blurred: "blurred",
  overexposed: "too bright",
  underexposed: "too dark",
  isolated: "isolated (noise)",
  duplicate: "duplicate",
};

/** Rejected points by reason, largest first, for the "rejected" counter's breakdown. */
export function rejectBreakdown(set: Pick<PointSet, "counts"> | null): { reason: string; words: string; count: number }[] {
  if (!set) return [];
  return Object.entries(set.counts.byReason)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, words: REASON_WORDS[reason] ?? reason, count }));
}

/** Below this on-screen pitch (CSS px between neighbouring dots) a lattice reads as a solid wash, not as dots. */
export const READABLE_PITCH_CSS = 5;

/** Display only: draw every k-th lattice point in each direction so the on-screen pitch is at least `readable` CSS px.
 *  `scale` is CSS px per source px. k = 1 when the full lattice is already readable. */
export function displayStride(spacingPx: number, scale: number, readable = READABLE_PITCH_CSS): number {
  const pitch = spacingPx * scale;
  if (!(pitch > 0)) return 1;
  return pitch >= readable ? 1 : Math.ceil(readable / pitch);
}

/** Indices of the points on the coarser display lattice (gx and gy multiples of k). The point arrays are never changed:
 *  this only chooses which of them are DRAWN. */
export function displaySubset(points: readonly Pick<SurfacePoint, "gx" | "gy">[], k: number): number[] {
  const out: number[] = [];
  const m = (v: number) => ((v % k) + k) % k;
  for (let i = 0; i < points.length; i++) if (k <= 1 || (m(points[i].gx) === 0 && m(points[i].gy) === 0)) out.push(i);
  return out;
}

/** How a frame of w x h source px is shown in a box of boxW x boxH CSS px with object-fit: contain. */
export function containScale(w: number, h: number, boxW: number, boxH: number): number {
  if (!(w > 0 && h > 0 && boxW > 0 && boxH > 0)) return 1;
  return Math.min(boxW / w, boxH / h);
}

export interface GapProbe {
  pair: string;
  x: number;
  y: number;
  /** True when the mask has background here: a real gap between the two fingers at this height. */
  gap: boolean;
  /** Distance (source px) from the probe to the nearest accepted point. */
  nearestAcceptedPx: number | null;
}

const GAP_PAIRS: [string, number, number][] = [
  ["index-middle tips", 8, 12],
  ["middle-ring tips", 12, 16],
  ["ring-little tips", 16, 20],
  ["index-middle DIP", 7, 11],
  ["middle-ring DIP", 11, 15],
  ["ring-little DIP", 15, 19],
];

/** Probes between neighbouring fingers (midpoints of the fingertip and DIP landmarks). Where the mask is background there,
 *  the fingers are apart, and no accepted point may sit near the probe: dots must not fill the gap between fingers. */
export function gapProbes(set: Pick<PointSet, "points" | "mask" | "scaleToSource">, landmarks: readonly { x: number; y: number }[]): GapProbe[] {
  const m = set.mask;
  if (!m || landmarks.length < 21) return [];
  const acc = set.points.filter((p) => p.accepted);
  return GAP_PAIRS.map(([pair, a, b]) => {
    const x = (landmarks[a].x + landmarks[b].x) / 2;
    const y = (landmarks[a].y + landmarks[b].y) / 2;
    const mx = Math.floor(x / set.scaleToSource);
    const my = Math.floor(y / set.scaleToSource);
    const gap = mx >= 0 && my >= 0 && mx < m.width && my < m.height ? !m.data[my * m.width + mx] : false;
    let best = Infinity;
    for (const p of acc) best = Math.min(best, Math.hypot(p.x - x, p.y - y));
    return { pair, x, y, gap, nearestAcceptedPx: Number.isFinite(best) ? best : null };
  });
}

/** Every accepted point must lie on a hand pixel of the mask it came from: the check the browser test and the debug hook use. */
export function pointsOutsideMask(set: Pick<PointSet, "points" | "mask" | "scaleToSource">): number {
  const m = set.mask;
  if (!m) return 0;
  let bad = 0;
  for (const p of set.points) {
    if (!p.accepted) continue;
    const mx = Math.floor(p.x / set.scaleToSource);
    const my = Math.floor(p.y / set.scaleToSource);
    if (mx < 0 || my < 0 || mx >= m.width || my >= m.height || !m.data[my * m.width + mx]) bad++;
  }
  return bad;
}

/** The live instruction while waiting to scan: the FIRST check that is still failing, in words, so the customer is told
 *  what to fix (the coin, holding still, a sharp picture) instead of a generic "hold still". There is no way to scan
 *  without an accepted coin, so it never offers one. */
export function liveGuidance(
  chips: { coin: { found: boolean; accepted: boolean }; steady: { steady: boolean; jitter: number | null }; sharpness: { sharp: boolean } } | null,
  goodRun: number,
  need: number,
  coinLabel: string | null,
): string {
  if (!chips) return "Show your open hand with the coin on the palm";
  const coin = coinLabel ?? "coin";
  if (!chips.coin.accepted) {
    return chips.coin.found
      ? `Coin seen but not accepted: lay the ${coin} flat in the middle of your palm, fully visible`
      : `Put the ${coin} flat in the middle of your palm`;
  }
  if (!chips.steady.steady) return "Hold your hand still";
  if (!chips.sharpness.sharp) return "Hold the phone steady so the picture is sharp";
  return `Hold still: ${Math.min(goodRun, need)} / ${need} good frames`;
}
