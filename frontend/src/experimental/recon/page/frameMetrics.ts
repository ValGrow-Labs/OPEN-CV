// Live, per-frame measures of the EXPERIMENTAL board-capture page that do not need the markers: sharpness (a Laplacian
// measure on a half-size grey picture) and steadiness (how far the camera moved between consecutive analysed frames, from
// the board pose). Pure functions: they run in the live worker and in unit tests.
/** A board-to-camera pose (Xc = R X + t, R row-major), as any array type. */
export interface PoseLike {
  R: ArrayLike<number>;
  t: ArrayLike<number>;
}

/** Sharpness of an RGBA picture: on a half-size grey copy (2 x 2 averaging), the RMS of the 4-neighbour Laplacian over
 *  the RMS of the gradient, both taken over the pixels with a strong gradient (edges of the printed markers, the hand's
 *  outline). It falls as edges widen. On SIMULATED 1280 x 720 renders of the board (multiview/scene.ts, blur sigma
 *  0.7 px): 1.33 to 1.56 crisp, 0.77 to 0.90 after a 5 x 5 px box blur, 0.46 to 0.61 after 9 x 9 or 17 x 17 px blurs
 *  (development run, 2026-11-08). Unlike the plain variance of the Laplacian, the ratio hardly depends on how many edges
 *  are in view or on their contrast. Real phone pictures (sharpening, noise, compression) were not measured. Returns
 *  null when there are too few edges. */
export function laplacianSharpness(data: ArrayLike<number>, width: number, height: number): { value: number | null; edgePixels: number } {
  const w = width >> 1, h = height >> 1;
  if (w < 8 || h < 8) return { value: null, edgePixels: 0 };
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const o = ((2 * y + dy) * width + 2 * x + dx) * 4;
          s += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
        }
      g[y * w + x] = s / 4;
    }
  let lap2 = 0, grad2 = 0, n = 0;
  const minGrad = 24; // grey levels across two half-size pixels: a real edge, not noise
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w];
      const gm2 = gx * gx + gy * gy;
      if (gm2 < minGrad * minGrad) continue;
      const lap = g[i + 1] + g[i - 1] + g[i + w] + g[i - w] - 4 * g[i];
      lap2 += lap * lap;
      grad2 += gm2 / 4; // central difference over two pixels: per-pixel gradient
      n++;
    }
  if (n < 200 || grad2 <= 0) return { value: null, edgePixels: n };
  return { value: Math.sqrt(lap2 / grad2), edgePixels: n };
}

/** The camera centre of a board-to-camera pose, board mm. */
export function cameraCentre(p: PoseLike): [number, number, number] {
  const { R, t } = p;
  return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
}

/** Angle (degrees) between two rotations (row-major 3 x 3). */
export function rotationDeltaDeg(a: ArrayLike<number>, b: ArrayLike<number>): number {
  // trace(A B^T)
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tr += a[i * 3 + j] * b[i * 3 + j];
  return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
}

/** How far the camera moved from one analysed frame to the next. */
export function poseChange(a: PoseLike, b: PoseLike): { rotDeg: number; moveMm: number } {
  const ca = cameraCentre(a), cb = cameraCentre(b);
  return { rotDeg: rotationDeltaDeg(a.R, b.R), moveMm: Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]) };
}

/** Where a picture pixel lands on the board plane (z = 0), board mm, ignoring lens distortion (guidance only). */
export function pixelToBoard(K: { fx: number; fy: number; cx: number; cy: number }, pose: PoseLike, u: number, v: number): { x: number; y: number } | null {
  const dc = [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1];
  const { R } = pose;
  const d = [R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2], R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2], R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2]];
  const c = cameraCentre(pose);
  if (Math.abs(d[2]) < 1e-9) return null;
  const s = -c[2] / d[2];
  if (s <= 0) return null;
  return { x: c[0] + s * d[0], y: c[1] + s * d[1] };
}

/** Which board edge the thumb points to (the hand rests with the fingers toward +x), from one view's 21 landmarks in
 *  pixels: the thumb (landmarks 2 to 4) against the little finger (17 to 20) across the board. Null when unclear. */
export function thumbSideOnBoard(K: { fx: number; fy: number; cx: number; cy: number }, pose: PoseLike, landmarks: readonly ({ x: number; y: number } | null)[] | null): "top" | "bottom" | null {
  if (!landmarks || landmarks.length < 21) return null;
  const meanY = (idx: number[]) => {
    const ys = idx.map((i) => (landmarks[i] ? pixelToBoard(K, pose, landmarks[i]!.x, landmarks[i]!.y) : null)).filter((p): p is { x: number; y: number } => p !== null).map((p) => p.y);
    return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : null;
  };
  const thumb = meanY([2, 3, 4]), little = meanY([17, 18, 19, 20]);
  if (thumb === null || little === null || Math.abs(thumb - little) < 15) return null;
  return thumb > little ? "top" : "bottom";
}
