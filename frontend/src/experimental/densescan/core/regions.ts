// Hand regions and depth labels for surface points.
import type { Pt, Pt3 } from "../../common";
import type { Region, SurfacePoint } from "./types";

const FINGERS: { region: Region; chain: number[] }[] = [
  { region: "thumb", chain: [1, 2, 3, 4] },
  { region: "index", chain: [5, 6, 7, 8] },
  { region: "middle", chain: [9, 10, 11, 12] },
  { region: "ring", chain: [13, 14, 15, 16] },
  { region: "little", chain: [17, 18, 19, 20] },
];
const PALM = [0, 1, 5, 9, 13, 17];

function segDist(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x,
    vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

function insidePolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Region of each point from the 21 landmarks (source px): "wrist" below the wrist landmark along the hand's axis,
 *  "palm" inside the palm polygon (0, 1, 5, 9, 13, 17), otherwise the finger whose bone chain is nearest, or "unknown"
 *  when every chain is farther than 60 % of the palm width. Uses only distances and an axis built from the landmarks, so
 *  it is the same for any rotation, a mirrored picture and a left or right hand. */
export function labelRegions(points: SurfacePoint[], landmarks: readonly Pt[]): SurfacePoint[] {
  if (landmarks.length < 21 || landmarks.some((l) => !Number.isFinite(l.x) || !Number.isFinite(l.y))) {
    return points.map((p) => ({ ...p, region: "unknown" as Region }));
  }
  const w = landmarks[0],
    m = landmarks[9];
  const axLen = Math.hypot(m.x - w.x, m.y - w.y) || 1;
  const ux = (m.x - w.x) / axLen,
    uy = (m.y - w.y) / axLen;
  const palmWidth = Math.hypot(landmarks[5].x - landmarks[17].x, landmarks[5].y - landmarks[17].y) || axLen;
  const palm = PALM.map((i) => landmarks[i]);
  return points.map((p) => {
    const t = (p.x - w.x) * ux + (p.y - w.y) * uy;
    let region: Region = "unknown";
    if (t < -0.02 * axLen) region = "wrist";
    else if (insidePolygon(p, palm)) region = "palm";
    else {
      let best = Infinity;
      for (const f of FINGERS) {
        for (let k = 0; k + 1 < f.chain.length; k++) {
          const d = segDist(p, landmarks[f.chain[k]], landmarks[f.chain[k + 1]]);
          if (d < best) {
            best = d;
            region = f.region;
          }
        }
      }
      if (best > 0.6 * palmWidth) region = "unknown";
    }
    return { ...p, region };
  });
}

/** Relative depth for every point, interpolated (inverse-distance weighting, power 2) from the landmarks' z. This is
 *  MediaPipe's RELATIVE depth (an estimate learned from images, roughly in the units of x, with an unknown offset), not a
 *  measurement: points are labelled `"estimated"`. Never use these z values as millimetres. */
export function estimateRelativeDepth(points: SurfacePoint[], landmarks: readonly Pt3[]): SurfacePoint[] {
  if (landmarks.length < 21 || landmarks.some((l) => !Number.isFinite(l.z))) return points.map((p) => ({ ...p }));
  return points.map((p) => {
    let ws = 0,
      zs = 0;
    for (const l of landmarks) {
      const d2 = (l.x - p.x) ** 2 + (l.y - p.y) ** 2;
      if (d2 < 1e-9) {
        ws = 1;
        zs = l.z;
        break;
      }
      const wgt = 1 / d2;
      ws += wgt;
      zs += wgt * l.z;
    }
    return { ...p, depth: "estimated", z: zs / ws };
  });
}

/** Minimum confidence (0-255) of a depth sample to be accepted as measured. */
export const MIN_DEPTH_CONFIDENCE = 128;

/** The ONLY way a point becomes `"measured"`: a real metric depth map in millimetres (for example from ARCore through
 *  WebXR depth sensing), aligned with the camera frame (`frame` gives the frame size it maps onto; default: the depth
 *  map's own size). Samples that are not finite, not positive, or below MIN_DEPTH_CONFIDENCE leave the point's label as
 *  it was. Nothing is ever filled in. */
export function applyMeasuredDepth(
  points: SurfacePoint[],
  depthMm: { width: number; height: number; data: Float32Array | Uint16Array; confidence?: Uint8Array },
  frame: { width: number; height: number } = { width: depthMm.width, height: depthMm.height },
): SurfacePoint[] {
  const sx = depthMm.width / frame.width,
    sy = depthMm.height / frame.height;
  return points.map((p) => {
    const dx = Math.floor(p.x * sx),
      dy = Math.floor(p.y * sy);
    if (dx < 0 || dy < 0 || dx >= depthMm.width || dy >= depthMm.height) return { ...p };
    const i = dy * depthMm.width + dx;
    const v = Number(depthMm.data[i]);
    if (!(Number.isFinite(v) && v > 0)) return { ...p };
    if (depthMm.confidence && depthMm.confidence[i] < MIN_DEPTH_CONFIDENCE) return { ...p };
    return { ...p, depth: "measured", z: v };
  });
}
