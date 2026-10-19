// Landmark topology and geometry helpers (mirror backend/glovesize/landmarks.py).
import type { Point } from "../api/types";

export const WRIST = 0;
export const MIDDLE_MCP = 9;
export const MIDDLE_TIP = 12;

export const LONG_FINGERS: Record<string, [number, number, number, number]> = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  little: [17, 18, 19, 20],
};

export const PALM_POLYGON = [0, 1, 2, 5, 9, 13, 17];
export const PALM_PLANE_POINTS = [0, 5, 9, 13, 17];

export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Sum of angles between consecutive segments of a joint chain (0 = straight). */
export function chainBendDeg(points: Point[], chain: number[], use3d = false): number {
  let total = 0;
  for (let i = 0; i + 2 < chain.length; i++) {
    const a = points[chain[i]];
    const b = points[chain[i + 1]];
    const c = points[chain[i + 2]];
    const u = [b.x - a.x, b.y - a.y, use3d ? b.z - a.z : 0];
    const v = [c.x - b.x, c.y - b.y, use3d ? c.z - b.z : 0];
    const nu = Math.hypot(...u);
    const nv = Math.hypot(...v);
    if (nu < 1e-9 || nv < 1e-9) return NaN;
    const cos = Math.min(1, Math.max(-1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv)));
    total += (Math.acos(cos) * 180) / Math.PI;
  }
  return total;
}

/** Approximate palm-plane tilt from MediaPipe world landmarks (live gate only; the server is authoritative). */
export function palmTiltDeg(world: Point[]): number {
  const p0 = world[0];
  // Average of the normals of the fan of triangles wrist -> consecutive knuckles.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 1; i + 1 < PALM_PLANE_POINTS.length; i++) {
    const a = world[PALM_PLANE_POINTS[i]];
    const b = world[PALM_PLANE_POINTS[i + 1]];
    const u = [a.x - p0.x, a.y - p0.y, a.z - p0.z];
    const v = [b.x - p0.x, b.y - p0.y, b.z - p0.z];
    nx += u[1] * v[2] - u[2] * v[1];
    ny += u[2] * v[0] - u[0] * v[2];
    nz += u[0] * v[1] - u[1] * v[0];
  }
  const n = Math.hypot(nx, ny, nz);
  if (n < 1e-12) return NaN;
  return (Math.acos(Math.min(1, Math.abs(nz) / n)) * 180) / Math.PI;
}

export function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.y > y !== b.y > y) {
      const xCross = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}

export function palmCentre(points: Point[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const i of PALM_PLANE_POINTS) {
    x += points[i].x;
    y += points[i].y;
  }
  return { x: x / PALM_PLANE_POINTS.length, y: y / PALM_PLANE_POINTS.length };
}

export function insideFrame(points: Point[], w: number, h: number, marginFraction: number): boolean {
  const mx = w * marginFraction;
  const my = h * marginFraction;
  return points.every((p) => p.x >= mx && p.x <= w - mx && p.y >= my && p.y <= h - my);
}

export function bboxSize(points: Point[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return Math.max(maxX - minX, maxY - minY);
}

/** Mean landmark displacement between two frames, relative to the hand size. */
export function jitterFraction(a: Point[], b: Point[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += dist(a[i], b[i]);
  const size = bboxSize(a);
  return size > 0 ? total / a.length / size : Infinity;
}
