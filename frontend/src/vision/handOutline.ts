// Anatomical hand contour generation from 21 MediaPipe hand landmarks.
// Generates a smooth, continuous closed outer outline around fingers, webs, and palm.
// Computes outline quality and detects finger overlap to guide the user.

import type { Point } from "../api/types";
import { dist } from "./geometry";

export interface HandOutlineResult {
  /** Ordered perimeter points defining the closed outer contour */
  contour: Point[];
  /** Overall outline confidence score [0..1] based on finger separation and geometry */
  quality: number;
  /** True if all adjacent fingers have adequate clearance */
  fingersSeparated: boolean;
  /** Distance in pixels between the closest pair of adjacent fingertips */
  minAdjacentTipGapPx: number;
}

/** Unit vector perpendicular to (p2 - p1), pointing to the left (CCW). */
function normal(p1: Point, p2: Point): { nx: number; ny: number } {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return { nx: 0, ny: 1 };
  return { nx: -dy / len, ny: dx / len };
}

/** Unit tangent from p1 to p2. */
function tangent(p1: Point, p2: Point): { tx: number; ty: number } {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return { tx: 0, ty: -1 };
  return { tx: dx / len, ty: dy / len };
}

/** Offset a point along a normal vector by radius r. */
function offset(p: Point, n: { nx: number; ny: number }, r: number): Point {
  return { x: p.x + n.nx * r, y: p.y + n.ny * r, z: p.z };
}

/** Generate an arc around a fingertip extending beyond the tip landmark. */
function tipArc(tip: Point, prev: Point, rTip: number, steps = 5): Point[] {
  const { tx, ty } = tangent(prev, tip);
  const { nx, ny } = normal(prev, tip);
  const pts: Point[] = [];
  // Sweep from +normal, through +tangent, to -normal
  for (let i = 0; i <= steps; i++) {
    const angle = (Math.PI * i) / steps;
    // At angle 0: normal; at PI/2: tangent; at PI: -normal
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    pts.push({
      x: tip.x + (nx * cosA + tx * sinA) * rTip,
      y: tip.y + (ny * cosA + ty * sinA) * rTip,
      z: tip.z,
    });
  }
  return pts;
}

/**
 * Computes the outer boundary contour and quality metrics from 21 hand landmarks.
 */
export function computeHandOutline(landmarks: Point[]): HandOutlineResult {
  if (!landmarks || landmarks.length < 21) {
    return { contour: [], quality: 0, fingersSeparated: false, minAdjacentTipGapPx: 0 };
  }

  const p = landmarks;
  const handLen = dist(p[0], p[12]); // wrist to middle tip
  const scale = Math.max(10, handLen);

  // Check finger separation between adjacent tips
  const tips = [4, 8, 12, 16, 20]; // Thumb, Index, Middle, Ring, Little
  let minGap = Infinity;
  for (let i = 1; i < tips.length - 1; i++) {
    const d = dist(p[tips[i]], p[tips[i + 1]]);
    if (d < minGap) minGap = d;
  }
  const thumbIndexGap = dist(p[4], p[8]);

  const minAcceptableGap = scale * 0.055;
  const fingersSeparated = minGap >= minAcceptableGap && thumbIndexGap >= scale * 0.06;

  // Quality score: degraded if fingers touch or hand is squashed
  let quality = 1.0;
  if (!fingersSeparated) {
    quality = Math.max(0.2, Math.min(0.7, minGap / minAcceptableGap));
  }

  // Anatomical radii proportional to hand size
  const rThumbBase = scale * 0.065;
  const rThumbTip = scale * 0.046;

  const rIndexBase = scale * 0.055;
  const rIndexTip = scale * 0.038;

  const rMidBase = scale * 0.058;
  const rMidTip = scale * 0.040;

  const rRingBase = scale * 0.054;
  const rRingTip = scale * 0.038;

  const rLittleBase = scale * 0.048;
  const rLittleTip = scale * 0.032;

  // Wrist orientation
  const wristNorm = normal(p[0], p[9]);
  const wristWidth = scale * 0.18;
  const wristUlnar = offset(p[0], wristNorm, wristWidth);
  const wristRadial = offset(p[0], wristNorm, -wristWidth);

  const contour: Point[] = [];

  // 1. Wrist ulnar base
  contour.push(wristUlnar);

  // 2. Outer palm (ulnar side) to Little MCP (17)
  const norm17 = normal(p[0], p[17]);
  contour.push(offset(p[17], norm17, rLittleBase * 1.3));

  // 3. Little finger (17 -> 18 -> 19 -> 20)
  const nLittle18 = normal(p[17], p[18]);
  contour.push(offset(p[18], nLittle18, rLittleBase * 1.1));
  const nLittle19 = normal(p[18], p[19]);
  contour.push(offset(p[19], nLittle19, rLittleTip * 1.05));
  // Little fingertip cap
  contour.push(...tipArc(p[20], p[19], rLittleTip));
  // Little finger inner side down
  contour.push(offset(p[19], nLittle19, -rLittleTip * 1.05));
  contour.push(offset(p[18], nLittle18, -rLittleBase * 1.0));

  // Web between Little (17) and Ring (13)
  const web17_13 = {
    x: 0.5 * (p[17].x + p[13].x) + (p[0].x - p[9].x) * 0.02,
    y: 0.5 * (p[17].y + p[13].y) + (p[0].y - p[9].y) * 0.02,
    z: 0.5 * (p[17].z + p[13].z),
  };
  contour.push(web17_13);

  // 4. Ring finger (13 -> 14 -> 15 -> 16)
  const nRing14 = normal(p[13], p[14]);
  contour.push(offset(p[14], nRing14, rRingBase * 1.05));
  const nRing15 = normal(p[14], p[15]);
  contour.push(offset(p[15], nRing15, rRingTip * 1.05));
  // Ring fingertip cap
  contour.push(...tipArc(p[16], p[15], rRingTip));
  // Ring finger inner side down
  contour.push(offset(p[15], nRing15, -rRingTip * 1.05));
  contour.push(offset(p[14], nRing14, -rRingBase * 1.0));

  // Web between Ring (13) and Middle (9)
  const web13_9 = {
    x: 0.5 * (p[13].x + p[9].x) + (p[0].x - p[9].x) * 0.02,
    y: 0.5 * (p[13].y + p[9].y) + (p[0].y - p[9].y) * 0.02,
    z: 0.5 * (p[13].z + p[9].z),
  };
  contour.push(web13_9);

  // 5. Middle finger (9 -> 10 -> 11 -> 12)
  const nMid10 = normal(p[9], p[10]);
  contour.push(offset(p[10], nMid10, rMidBase * 1.05));
  const nMid11 = normal(p[10], p[11]);
  contour.push(offset(p[11], nMid11, rMidTip * 1.05));
  // Middle fingertip cap
  contour.push(...tipArc(p[12], p[11], rMidTip));
  // Middle finger inner side down
  contour.push(offset(p[11], nMid11, -rMidTip * 1.05));
  contour.push(offset(p[10], nMid10, -rMidBase * 1.0));

  // Web between Middle (9) and Index (5)
  const web9_5 = {
    x: 0.5 * (p[9].x + p[5].x) + (p[0].x - p[9].x) * 0.02,
    y: 0.5 * (p[9].y + p[5].y) + (p[0].y - p[9].y) * 0.02,
    z: 0.5 * (p[9].z + p[5].z),
  };
  contour.push(web9_5);

  // 6. Index finger (5 -> 6 -> 7 -> 8)
  const nIndex6 = normal(p[5], p[6]);
  contour.push(offset(p[6], nIndex6, rIndexBase * 1.05));
  const nIndex7 = normal(p[6], p[7]);
  contour.push(offset(p[7], nIndex7, rIndexTip * 1.05));
  // Index fingertip cap
  contour.push(...tipArc(p[8], p[7], rIndexTip));
  // Index finger outer side down
  contour.push(offset(p[7], nIndex7, -rIndexTip * 1.05));
  contour.push(offset(p[6], nIndex6, -rIndexBase * 1.05));
  contour.push(offset(p[5], normal(p[0], p[5]), -rIndexBase * 1.1));

  // Web between Index (5) and Thumb (2)
  const web5_2 = {
    x: 0.6 * p[5].x + 0.4 * p[2].x,
    y: 0.6 * p[5].y + 0.4 * p[2].y,
    z: 0.6 * p[5].z + 0.4 * p[2].z,
  };
  contour.push(web5_2);

  // 7. Thumb (2 -> 3 -> 4)
  const nThumb3 = normal(p[2], p[3]);
  contour.push(offset(p[3], nThumb3, rThumbTip * 1.05));
  // Thumb fingertip cap
  contour.push(...tipArc(p[4], p[3], rThumbTip));
  // Thumb outer side down
  contour.push(offset(p[3], nThumb3, -rThumbTip * 1.05));
  contour.push(offset(p[2], nThumb3, -rThumbBase * 1.15));
  contour.push(offset(p[1], normal(p[0], p[1]), -rThumbBase * 1.3));

  // 8. Thenar eminence (base of thumb to wrist radial)
  contour.push(wristRadial);

  return {
    contour,
    quality,
    fingersSeparated,
    minAdjacentTipGapPx: minGap,
  };
}

/**
 * Draws a smooth Catmull-Rom spline or Bezier curve through the closed contour points.
 */
export function drawSmoothContour(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  fillColor: string,
  lineWidth: number,
): void {
  if (points.length < 3) return;

  ctx.save();
  ctx.beginPath();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = color;
  ctx.fillStyle = fillColor;

  // Catmull-Rom to Cubic Bezier spline closed loop
  const n = points.length;
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];

    // Control points for Catmull-Rom (tension 0.5)
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }

  ctx.closePath();
  if (fillColor) ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * Converts closed contour points to a smooth SVG path d attribute string.
 */
export function outlineSvgPath(points: Point[]): string {
  if (points.length < 3) return "";
  const n = points.length;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d + " Z";
}
