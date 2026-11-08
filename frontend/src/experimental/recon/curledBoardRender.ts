// TEST SUPPORT for the board-flatness check (boardFlatness.test.ts): renders the printed board as a camera would see it
// when the SHEET IS CURLED, by per-pixel ray casting onto the bent paper (board/render.ts renders a flat sheet only and
// has no curl option; it is not edited). Not used by the page.
//
// The bend is a cylinder of the paper itself (arc length preserved, so the print is not stretched): a sheet lying on the
// table whose two opposite edges lift by `edgeLiftMm`, its middle line touching the table.
//   axis "x": the bend axis runs along the long (x) edge, so the two LONG edges (the top and bottom marker rows) lift;
//   axis "y": the bend axis runs along the short (y) edge, so the two SHORT edges (the open left edge and the right
//             column, with the ends of both rows) lift.
// edgeLiftMm 0 is a flat sheet. Each pixel takes ss x ss stratified samples (regular, no jitter), the lens model is the
// radial k1, k2 of geometry/camera.ts (pixel centres on whole numbers, as board/render.ts). No lighting; optional
// Gaussian blur and sensor noise (default none: an IDEAL picture of a bent sheet; multiview/scene.ts uses 0.7 px and 2.5
// grey levels). SIMULATED; it says nothing about real paper, which curls unevenly.
import type { CameraPose, Intrinsics } from "../common";
import { cameraCenter } from "../geometry/camera";
import { seededRandom, transpose } from "../geometry/linalg";
import { gaussianBlurPlane, type RgbaImage } from "../board/image";
import { makeBoardSampler } from "../board/render";
import { BOARD, type BoardLayout } from "../board/spec";

export interface Curl {
  axis: "x" | "y";
  /** How far the two lifted edges rise above the table, mm (0 = flat). */
  edgeLiftMm: number;
}

/** Radius of the cylinder whose arc of half-length `halfMm` rises `liftMm` at its ends: lift = R (1 - cos(half / R)). */
export function curlRadius(halfMm: number, liftMm: number): number {
  if (liftMm <= 0) return Infinity;
  let R = (halfMm * halfMm) / (2 * liftMm); // small-angle start
  for (let i = 0; i < 60; i++) {
    const f = R * (1 - Math.cos(halfMm / R)) - liftMm;
    const df = 1 - Math.cos(halfMm / R) - (halfMm / R) * Math.sin(halfMm / R);
    const next = R - f / df;
    if (!Number.isFinite(next) || next <= 0) break;
    if (Math.abs(next - R) < 1e-9) return next;
    R = next;
  }
  return R;
}

/** The world point (mm) of a board point (x, y) on the curled sheet (to check the renderer and to project corners). */
export function curledPoint(x: number, y: number, curl: Curl, layout: BoardLayout = BOARD): [number, number, number] {
  const along = curl.axis === "x" ? y - layout.paper.heightMm / 2 : x - layout.paper.widthMm / 2;
  const half = (curl.axis === "x" ? layout.paper.heightMm : layout.paper.widthMm) / 2;
  const R = curlRadius(half, curl.edgeLiftMm);
  if (!Number.isFinite(R)) return [x, y, 0];
  const th = along / R;
  const w = R * Math.sin(th), z = R * (1 - Math.cos(th));
  return curl.axis === "x" ? [x, layout.paper.heightMm / 2 + w, z] : [layout.paper.widthMm / 2 + w, y, z];
}

export function renderCurledBoard(K: Intrinsics, pose: CameraPose, curl: Curl, opts: { layout?: BoardLayout; supersample?: number; blurSigmaPx?: number; noiseSigma?: number; seed?: number } = {}): RgbaImage {
  const layout = opts.layout ?? BOARD;
  const ss = Math.max(1, Math.round(opts.supersample ?? 2));
  const W = K.width, H = K.height;
  const sampler = makeBoardSampler(layout);
  const paper = [226, 224, 218], ink = [28, 28, 32], tick = [182, 182, 182], table = [118, 96, 78], background = [150, 154, 160];
  const C = cameraCenter(pose);
  const Rt = transpose(pose.R);
  const k1 = K.k1 ?? 0, k2 = K.k2 ?? 0;
  const ax = curl.axis;
  const half = (ax === "x" ? layout.paper.heightMm : layout.paper.widthMm) / 2;
  const mid = half;
  const R = curlRadius(half, curl.edgeLiftMm);
  const out = new Uint8ClampedArray(W * H * 4);
  const planes = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)];
  // colour of the ray C + l D
  const shade = (dx: number, dy: number, dz: number, col: number[]) => {
    let bx = NaN, by = NaN;
    if (Number.isFinite(R)) {
      // in the bend's own coordinates: w across the bend (from the middle line), z up; cylinder axis at (w 0, z R)
      const cw = (ax === "x" ? C[1] : C[0]) - mid, cz = C[2] - R;
      const dw = ax === "x" ? dy : dx;
      const a = dw * dw + dz * dz;
      const b = cw * dw + cz * dz;
      const c = cw * cw + cz * cz - R * R;
      const disc = b * b - a * c;
      if (a > 0 && disc >= 0) {
        const l = (-b + Math.sqrt(disc)) / a; // the camera is inside the (huge) cylinder: the far root is the sheet below
        if (l > 0) {
          const w = cw + l * dw, z = C[2] + l * dz;
          if (z < R) {
            const arc = R * Math.atan2(w, R - z);
            if (Math.abs(arc) <= half) {
              const along = C[ax === "x" ? 0 : 1] + l * (ax === "x" ? dx : dy);
              bx = ax === "x" ? along : mid + arc;
              by = ax === "x" ? mid + arc : along;
            }
          }
        }
      }
    } else if (dz < 0) {
      const l = -C[2] / dz;
      bx = C[0] + l * dx;
      by = C[1] + l * dy;
    }
    let src = background;
    if (Number.isFinite(bx)) {
      const id = sampler(bx, by);
      src = id === 1 ? ink : id === 2 ? tick : id === 0 ? paper : table;
    } else if (dz < 0) src = table; // past a lifted edge: the table (z = 0)
    col[0] += src[0];
    col[1] += src[1];
    col[2] += src[2];
  };
  const col = [0, 0, 0];
  for (let py = 0; py < H; py++)
    for (let px = 0; px < W; px++) {
      col[0] = col[1] = col[2] = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const u = px - 0.5 + (sx + 0.5) / ss, v = py - 0.5 + (sy + 0.5) / ss;
          const xd = (u - K.cx) / K.fx, yd = (v - K.cy) / K.fy;
          let x = xd, y = yd;
          if (k1 || k2)
            for (let it = 0; it < 30; it++) {
              const r2 = x * x + y * y;
              const d = 1 + k1 * r2 + k2 * r2 * r2;
              const nx = xd / d, ny = yd / d;
              const done = Math.abs(nx - x) + Math.abs(ny - y) < 1e-13;
              x = nx;
              y = ny;
              if (done) break;
            }
          shade(Rt[0] * x + Rt[1] * y + Rt[2], Rt[3] * x + Rt[4] * y + Rt[5], Rt[6] * x + Rt[7] * y + Rt[8], col);
        }
      const o = py * W + px, n = ss * ss;
      planes[0][o] = col[0] / n;
      planes[1][o] = col[1] / n;
      planes[2][o] = col[2] / n;
    }
  if (opts.blurSigmaPx) for (const p of planes) gaussianBlurPlane(p, W, H, opts.blurSigmaPx);
  const rnd = seededRandom(opts.seed ?? 1);
  const noise = opts.noiseSigma ?? 0;
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = planes[c][i] + (noise ? noise * rnd.gaussian() : 0);
    out[i * 4 + 3] = 255;
  }
  return { width: W, height: H, data: out };
}
