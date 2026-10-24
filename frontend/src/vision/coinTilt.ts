// Coin tilt from the coin's ellipse (mirror of backend/glovesize/calibration.py).
//
// One frame's tilt is acos(minor / major). For a coin lying flat the ratio is 1 and edge noise can
// only pull it below 1, so a single frame reads a spurious tilt (a 1% error in the ratio reads as
// about 8 degrees) that averaging the angles cannot remove. Averaging the ellipse *shapes* does:
// noise has no preferred direction, so the mean shape converges to a circle, while a really tilted
// coin keeps one consistent direction and keeps its tilt.

export interface CoinShape {
  major_axis_px: number;
  minor_axis_px: number;
  angle_deg: number;
}

const deg = (rad: number) => (rad * 180) / Math.PI;

/** The tilt this one frame's ellipse implies (noisy; used for display and as the fallback). */
export function coinTiltDeg(c: Pick<CoinShape, "major_axis_px" | "minor_axis_px">): number {
  return deg(Math.acos(Math.min(1, c.minor_axis_px / c.major_axis_px)));
}

/** Tilt of the average ellipse of these coins; null when there are none. */
export function smoothedTiltDeg(coins: CoinShape[]): number | null {
  if (coins.length === 0) return null;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const c of coins) {
    const t = (c.angle_deg * Math.PI) / 180;
    const ux = Math.cos(t);
    const uy = Math.sin(t);
    const a = (c.major_axis_px / 2) ** 2;
    const b = (Math.min(c.minor_axis_px, c.major_axis_px) / 2) ** 2;
    // a * u u^T + b * v u^T, with v = (-uy, ux)
    xx += a * ux * ux + b * uy * uy;
    xy += (a - b) * ux * uy;
    yy += a * uy * uy + b * ux * ux;
  }
  xx /= coins.length;
  xy /= coins.length;
  yy /= coins.length;
  const mean = (xx + yy) / 2;
  const diff = Math.hypot((xx - yy) / 2, xy);
  const hi = mean + diff;
  const lo = Math.max(mean - diff, 0);
  return deg(Math.acos(Math.min(1, Math.sqrt(lo / hi))));
}
