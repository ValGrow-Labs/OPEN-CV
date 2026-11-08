// What a single segmented RGB frame can and cannot give. Every value is a `Quantity` with its basis:
//   "direct" = read from the mask/points in image pixels; "model" = needs an assumption (the coin-plane scale, a joint
//   centre from the landmarks as one end); "none" = not available from one RGB frame, with the reason.
import type { ImageScale, Pt, Quantity } from "../../common";
import { insideMask } from "./edt";
import type { PointSet } from "./types";

const FINGERS: { name: string; base: number; tip: number }[] = [
  { name: "thumb", base: 2, tip: 4 },
  { name: "index", base: 5, tip: 8 },
  { name: "middle", base: 9, tip: 12 },
  { name: "ring", base: 13, tip: 16 },
  { name: "little", base: 17, tip: 20 },
];

const COIN_PLANE = "Converted with the coin's scale, which holds at the coin's plane only; parts of the hand at other heights are off by their height over distance.";

/** March from `from` along the unit direction (dx, dy) while on hand pixels; returns the last point on the hand. */
function marchToEdge(set: PointSet, from: Pt, dx: number, dy: number, maxPx: number): Pt {
  if (!set.mask) return from;
  const step = Math.max(0.5, set.scaleToSource / 2);
  let last = from;
  for (let t = 0; t <= maxPx; t += step) {
    const q = { x: from.x + dx * t, y: from.y + dy * t };
    if (!insideMask(set.mask, set.scaleToSource, q.x, q.y)) break;
    last = q;
  }
  return last;
}

function q(value: number | null, unit: Quantity["unit"], basis: Quantity["basis"], note: string): Quantity {
  return { value, unit, basis, note };
}

export function measureFromPoints(set: PointSet, landmarks: readonly Pt[], scale: ImageScale | null): Record<string, Quantity> {
  const mm = scale && scale.mmPerPx > 0 ? scale.mmPerPx : null;
  const out: Record<string, Quantity> = {};
  const toMm = (px: number | null, extra: string): Quantity =>
    px === null ? q(null, "mm", "none", "Not available in pixels.") : mm === null ? q(null, "mm", "none", "No coin scale.") : q(px * mm, "mm", "model", `${COIN_PLANE} ${extra}`.trim());

  // projected area: the mask itself
  const maskPx = set.mask ? set.mask.data.reduce((n, v) => n + (v ? 1 : 0), 0) * set.scaleToSource ** 2 : null;
  out.projected_area_px2 = maskPx === null ? q(null, "px2", "none", "No mask.") : q(maskPx, "px2", "direct", "Hand pixels of the mask (up to the wrist boundary).");
  out.projected_area_mm2 =
    maskPx === null || mm === null ? q(null, "mm2", "none", mm === null ? "No coin scale." : "No mask.") : q(maskPx * mm * mm, "mm2", "model", `${COIN_PLANE} The projected (silhouette) area is not the skin surface area.`);
  out.accepted_points = q(set.counts.accepted, "ratio", "direct", "Number of accepted surface points (a count, not a measurement of the hand).");

  const ok = landmarks.length >= 21 && landmarks.every((l) => Number.isFinite(l.x) && Number.isFinite(l.y));
  if (!ok) {
    for (const k of ["hand_length", "palm_breadth", ...FINGERS.map((f) => `${f.name}_length`)]) {
      out[`${k}_px`] = q(null, "px", "none", "No usable landmarks.");
      out[`${k}_mm`] = q(null, "mm", "none", "No usable landmarks.");
    }
  } else {
    const w = landmarks[0];
    const mid = landmarks[9];
    const axLen = Math.hypot(mid.x - w.x, mid.y - w.y) || 1;
    const ux = (mid.x - w.x) / axLen,
      uy = (mid.y - w.y) / axLen;
    // hand length: wrist landmark to the middle fingertip found on the mask, measured along the hand axis
    const tip12 = landmarks[12];
    const fx = tip12.x - landmarks[9].x,
      fy = tip12.y - landmarks[9].y;
    const fl = Math.hypot(fx, fy) || 1;
    const tipM = marchToEdge(set, tip12, fx / fl, fy / fl, 4 * axLen);
    const handPx = (tipM.x - w.x) * ux + (tipM.y - w.y) * uy;
    out.hand_length_px = q(handPx, "px", "model", "From the wrist landmark (a joint estimate, not the wrist crease) to the middle fingertip edge of the mask, along the hand's axis.");
    out.hand_length_mm = toMm(handPx, "");
    // palm breadth: skin edge to skin edge of the mask along the knuckle line (landmarks 5 to 17), through its midpoint
    const a = landmarks[5],
      b = landmarks[17];
    const kl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const kx = (b.x - a.x) / kl,
      ky = (b.y - a.y) / kl;
    // The knuckle joint centres can sit at or beyond the top of the palm, so the midpoint of their line may fall between
    // two fingers: step toward the wrist (along the hand axis) until the line crosses the palm, at most 40 % of the axis.
    let c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let shift = 0;
    const onHand = (p: Pt) => (set.mask ? insideMask(set.mask, set.scaleToSource, p.x, p.y) : false);
    while (set.mask && !onHand(c) && shift < 0.4 * axLen) {
      shift += 1;
      c = { x: (a.x + b.x) / 2 - ux * shift, y: (a.y + b.y) / 2 - uy * shift };
    }
    const e1 = marchToEdge(set, c, kx, ky, 3 * kl);
    const e2 = marchToEdge(set, c, -kx, -ky, 3 * kl);
    const breadthPx = set.mask && onHand(c) ? Math.hypot(e1.x - e2.x, e1.y - e2.y) : null;
    out.palm_breadth_px =
      breadthPx === null
        ? q(null, "px", "none", "No mask, or the knuckle line does not cross the palm.")
        : q(
            breadthPx,
            "px",
            "direct",
            `Skin edge to skin edge of the mask along the knuckle line (direction and position from the landmarks${shift > 0 ? `, moved ${shift.toFixed(0)} px toward the wrist to cross the palm` : ""}).`,
          );
    out.palm_breadth_mm = toMm(breadthPx, "");
    for (const f of FINGERS) {
      const base = landmarks[f.base],
        tip = landmarks[f.tip];
      const dl = Math.hypot(tip.x - base.x, tip.y - base.y) || 1;
      const end = marchToEdge(set, tip, (tip.x - base.x) / dl, (tip.y - base.y) / dl, 2 * dl);
      const px = Math.hypot(end.x - base.x, end.y - base.y);
      out[`${f.name}_length_px`] = q(px, "px", "model", "From the knuckle joint centre (a landmark) to the fingertip edge of the mask.");
      out[`${f.name}_length_mm`] = toMm(px, "");
    }
  }

  const noDepth =
    "Not available: one RGB frame has no metric depth. It needs measured depth with the camera's intrinsics, or calibrated multi-view capture; MediaPipe's relative depth is not a measurement.";
  out.thickness_mm = q(null, "mm", "none", noDepth);
  out.circumference_mm = q(null, "mm", "none", `${noDepth} A circumference also needs the back and the sides, which one view never sees.`);
  out.surface_area_3d_mm2 = q(null, "mm2", "none", noDepth);
  return out;
}
