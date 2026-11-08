// Board-free hand segmentation for the carving views (EXPERIMENTAL, stage 4). Three methods, compared in README.md:
//
//   "grabcut"   (a) the stage 2a method: GrabCut (OpenCV.js) seeded from the landmarks (segmentation/ seed geometry:
//               thick bones and the shrunken palm = sure hand, the grown landmark hull = probable hand, a wider band =
//               probable background, the rest sure background). One change for views that are not palm-facing: the
//               hand's size unit is max(palm width, 0.6 x wrist-to-middle-knuckle) in pixels, because the palm width
//               collapses in a view along the knuckle line; and the band also covers the forearm strip so the forearm
//               is not cut by the band's edge (the carving's forearm rule decides what beyond the cut means).
//   "plane"     (b) plane consistency, no colour model: every pixel's ray is intersected with the TABLE plane (z = 0 in
//               the table frame, from the structure from motion) and that table point is looked up in neighbouring
//               sweep frames (the plane homography, distortion included). Table pixels agree with a neighbour (zero-mean
//               normalised cross-correlation of the band-passed grey picture over a 5 x 5 window, the best of the windows containing the pixel, and the
//               pixel's own colour within a tolerance); pixels above the table (the hand) do not, because of parallax.
//               Hand = the region that never agrees, connected to the landmark skeleton, inside the projected volume.
//               Rays that never meet the table are UNKNOWN (no evidence either way).
//   "combined"  (c) GrabCut seeded by the plane evidence: table-confirmed pixels are sure background, the landmark
//               skeleton that is not table-confirmed is sure hand, the rest of the projected volume is decided by colour.
//
// All three are board-free: the only inputs are the pictures, the SfM camera geometry and the landmark positions (the
// landmarks projected from their multi-view triangulation, so a view where the detector failed still gets seeds).
// SIMULATED evaluation only.
import type { BinaryMask, CameraPose, Intrinsics, Pt } from "../common";
import type { CV } from "../../vision/opencv";
import { boxMean, gaussianBlurPlane, rayBox, rayGrid, type RGBAImage } from "../multiview/image";
import { projectPoint, type Vec3 } from "../reconstruction/linalg";
import { runGrabCutWithModels } from "../segmentation/backends/grabcut";
import { BONES, PALM_POLYGON, convexHull, drawThickLine, fillPolygon, palmWidth } from "../segmentation/geometry";
import { dilate, erode, fillSmallHoles, keepMainComponent, majority3, open } from "../segmentation/morph";
import { GRABCUT_ITERATIONS, GRABCUT_LABELS, PROBABLE_BG_GROW, PROBABLE_FG_GROW, SURE_FG_BONE_RADIUS, SURE_FG_PALM_ERODE } from "../segmentation/seedLabels";
import type { Seeds } from "../segmentation/seeds";
import type { SegmentationMethod, ViewSegmentation } from "./types";

export interface SegViewContext {
  id: string;
  /** The picture at the reconstruction size (RGBA). */
  image: RGBAImage;
  K: Intrinsics;
  /** Table-frame pose (mm). */
  pose: CameraPose;
  /** 21 landmark positions in this picture (projected from the triangulation; null = unavailable). */
  landmarks: (Pt | null)[] | null;
  /** Neighbouring sweep frames (same size and intrinsics) with their table-frame poses. */
  neighbours: { id: string; image: RGBAImage; pose: CameraPose }[];
  /** The carving volume (table mm): only pixels whose rays cross it can show the hand. */
  volume: { min: Vec3; max: Vec3 };
}

export interface SegmentOptions {
  method: SegmentationMethod;
  /** OpenCV.js (needed by "grabcut" and "combined"). */
  cv?: CV;
  /** ZNCC a table pixel must reach with at least one neighbour (default 0.6). */
  minZncc?: number;
  /** Local standard deviation (grey levels, 0-255) below which a window carries no texture (default 3). */
  minTextureStd?: number;
  /** Largest per-channel colour difference (0-255) of an agreeing pixel with the warped neighbour (default 22). */
  maxColourDiff?: number;
  /** Smallest structure-tensor eigenvalue ((grey/px)^2, window mean) both windows need (default 4). */
  minCornerness?: number;
  /** Gaussian sigma (px) of the high-pass applied before the ZNCC (default 2). */
  highPassSigmaPx?: number;
  /** Window radius for the ZNCC (default 2: 5 x 5). */
  windowRadius?: number;
  grabCutIterations?: number;
}

export interface PlaneEvidence {
  /** 255 where the ray crosses the volume. */
  roi: Uint8Array;
  /** 255 where the ray meets the table plane in front of the camera. */
  hitsTable: Uint8Array;
  /** 255 where the pixel agrees with the table seen by at least one neighbour (table confirmed). */
  agree: Uint8Array;
  /** Share of the ROI pixels that meet the table and agree. */
  agreeShare: number;
  /** 255 where the ray meets the table within the distance (from the volume's centre) up to which table pixels of this
   *  view were confirmed at all (the 95th percentile): beyond it the foreshortened table carries no usable texture and
   *  the plane test can say nothing (the top outline of the hand in a 12-degree view lies there). */
  verifiable: Uint8Array;
  verifiableRadiusMm: number;
  ms: number;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Halve an RGBA picture `factor` (power of two) times with 2 x 2 averaging (pixel u maps to u / 2 exactly). */
export function halveImage(img: RGBAImage, factor: number): RGBAImage {
  let cur = img;
  for (let f = factor; f > 1; f /= 2) {
    const w = cur.width >> 1, h = cur.height >> 1;
    const out = new Uint8ClampedArray(w * h * 4);
    const src = cur.data, W = cur.width;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = (2 * y * W + 2 * x) * 4, b = a + 4, c = a + W * 4, d = c + 4, o = (y * w + x) * 4;
        for (let k = 0; k < 4; k++) out[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2) >> 2;
      }
    cur = { width: w, height: h, data: out };
  }
  return cur;
}

const grey = (img: RGBAImage): Float32Array => {
  const n = img.width * img.height, g = new Float32Array(n);
  for (let p = 0; p < n; p++) g[p] = 0.299 * img.data[p * 4] + 0.587 * img.data[p * 4 + 1] + 0.114 * img.data[p * 4 + 2];
  return g;
};

/** Bilinear RGB sample at a continuous position (pixel centres at +0.5); null outside the picture. */
function sampleRgb(img: RGBAImage, x: number, y: number, out: number[]): boolean {
  const xf = x - 0.5, yf = y - 0.5;
  if (xf < 0 || yf < 0 || xf > img.width - 1 || yf > img.height - 1) return false;
  const x0 = Math.min(img.width - 2, Math.floor(xf)), y0 = Math.min(img.height - 2, Math.floor(yf));
  const ax = xf - x0, ay = yf - y0, w = img.width, d = img.data;
  const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
  for (let k = 0; k < 3; k++) out[k] = (1 - ay) * ((1 - ax) * d[i00 + k] + ax * d[i10 + k]) + ay * ((1 - ax) * d[i01 + k] + ax * d[i11 + k]);
  return true;
}

/** The plane-consistency evidence of one view. */
export function planeEvidence(ctx: SegViewContext, o: Partial<SegmentOptions> = {}): PlaneEvidence {
  const t0 = now();
  const { width: w, height: h } = ctx.image;
  const n = w * h;
  const grid = rayGrid(ctx.K, ctx.pose, w, h);
  const O = grid.origin;
  const roi = new Uint8Array(n), hits = new Uint8Array(n);
  const tx = new Float32Array(n), ty = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const d = [grid.dirs[p * 3], grid.dirs[p * 3 + 1], grid.dirs[p * 3 + 2]];
    if (rayBox(O, d, ctx.volume.min, ctx.volume.max)) roi[p] = 255;
    if (d[2] < -1e-9) {
      const t = -O[2] / d[2];
      if (t > 0) {
        hits[p] = 255;
        tx[p] = O[0] + d[0] * t;
        ty[p] = O[1] + d[1] * t;
      }
    }
  }
  const r = o.windowRadius ?? 2;
  const minStd = o.minTextureStd ?? 3, minZ = o.minZncc ?? 0.6, maxDiff = o.maxColourDiff ?? 22;
  // band-pass (grey minus its Gaussian blur): the table's texture survives, the hand's smooth shading does not, so a
  // hand pixel cannot "agree" with the hand seen through the plane in a neighbour that also hides the table point
  const hp = (g: Float32Array) => {
    const b = gaussianBlurPlane(Float32Array.from(g), w, h, o.highPassSigmaPx ?? 2);
    for (let p = 0; p < n; p++) b[p] = g[p] - b[p];
    return b;
  };
  const gI = hp(grey(ctx.image));
  const mI = boxMean(gI, w, h, r);
  const mII = boxMean(gI.map((v) => v * v), w, h, r);
  // 2D texture (smallest eigenvalue of the structure tensor): an edge shifted ALONG itself by the parallax still
  // correlates (the aperture problem: the hand's finger outlines run along the ring's parallax), a corner does not
  const lamI = minEigen(gI, w, h, r);
  const agree = new Uint8Array(n);
  const s = [0, 0, 0];
  for (const nb of ctx.neighbours) {
    // the neighbour's picture warped into this view through the table plane
    const W = new Float32Array(n * 3), valid = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      if (!hits[p] || !roi[p]) continue;
      const q = projectPoint([tx[p], ty[p], 0], ctx.K, nb.pose);
      if (!q || !sampleRgb(nb.image, q.u, q.v, s)) continue;
      W[p * 3] = s[0]; W[p * 3 + 1] = s[1]; W[p * 3 + 2] = s[2]; // fmt: skip
      valid[p] = 1;
    }
    const gw0 = new Float32Array(n);
    for (let p = 0; p < n; p++) gw0[p] = valid[p] ? 0.299 * W[p * 3] + 0.587 * W[p * 3 + 1] + 0.114 * W[p * 3 + 2] : 0.299 * ctx.image.data[p * 4] + 0.587 * ctx.image.data[p * 4 + 1] + 0.114 * ctx.image.data[p * 4 + 2];
    const gW = hp(gw0);
    const mW = boxMean(gW, w, h, r);
    const mWW = boxMean(gW.map((v) => v * v), w, h, r);
    const mIW = boxMean(gI.map((v, p) => v * gW[p]), w, h, r);
    const lamW = minEigen(gW, w, h, r);
    const minLam = o.minCornerness ?? 4;
    const zncc = new Float32Array(n).fill(-1);
    for (let p = 0; p < n; p++) {
      if (!valid[p]) continue;
      const vI = mII[p] - mI[p] * mI[p], vW = mWW[p] - mW[p] * mW[p];
      if (vI < minStd * minStd || vW < minStd * minStd || lamI[p] < minLam || lamW[p] < minLam) continue;
      zncc[p] = (mIW[p] - mI[p] * mW[p]) / Math.sqrt(vI * vW);
    }
    // the best window containing the pixel (shiftable windows: no fattening at the hand's outline)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (agree[p] || !valid[p]) continue;
        let best = -1;
        for (let dy = -r; dy <= r && best < minZ; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const z = zncc[yy * w + xx];
            if (z > best) best = z;
          }
        }
        if (best < minZ) continue;
        const d = ctx.image.data;
        if (Math.abs(d[p * 4] - W[p * 3]) <= maxDiff && Math.abs(d[p * 4 + 1] - W[p * 3 + 1]) <= maxDiff && Math.abs(d[p * 4 + 2] - W[p * 3 + 2]) <= maxDiff) agree[p] = 255;
      }
  }
  let inRoi = 0, ag = 0;
  for (let p = 0; p < n; p++)
    if (roi[p] && hits[p]) {
      inRoi++;
      if (agree[p]) ag++;
    }
  const cx = (ctx.volume.min[0] + ctx.volume.max[0]) / 2, cy = (ctx.volume.min[1] + ctx.volume.max[1]) / 2;
  const dists: number[] = [];
  for (let p = 0; p < n; p++) if (agree[p]) dists.push(Math.hypot(tx[p] - cx, ty[p] - cy));
  dists.sort((a, b) => a - b);
  const R = dists.length ? dists[Math.floor(0.95 * (dists.length - 1))] : 0;
  const verifiable = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (hits[p] && Math.hypot(tx[p] - cx, ty[p] - cy) <= R) verifiable[p] = 255;
  return { roi, hitsTable: hits, agree, agreeShare: inRoi ? ag / inRoi : 0, verifiable, verifiableRadiusMm: R, ms: now() - t0 };
}

/** Smallest eigenvalue of the structure tensor (window mean of the gradient outer product) per pixel. */
export function minEigen(g: Float32Array, w: number, h: number, r: number): Float32Array {
  const n = w * h, xx = new Float32Array(n), yy = new Float32Array(n), xy = new Float32Array(n);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x, gx = (g[p + 1] - g[p - 1]) / 2, gy = (g[p + w] - g[p - w]) / 2;
      xx[p] = gx * gx; yy[p] = gy * gy; xy[p] = gx * gy; // fmt: skip
    }
  const a = boxMean(xx, w, h, r), c = boxMean(yy, w, h, r), b = boxMean(xy, w, h, r);
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) out[p] = (a[p] + c[p]) / 2 - Math.sqrt(((a[p] - c[p]) / 2) ** 2 + b[p] * b[p]);
  return out;
}

/** The hand's size unit in a view of any direction (pixels). */
export function handScalePx(lm: readonly Pt[]): number {
  return Math.max(palmWidth(lm), 0.6 * Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y));
}

/** Stage 2a seed geometry with the view-robust size unit and the forearm strip in the probable-background band. */
export function landmarkSeeds(lm: readonly Pt[], w: number, h: number): Seeds {
  const s = handScalePx(lm);
  const n = w * h;
  const sureFg = new Uint8Array(n);
  for (const [a, b] of BONES) drawThickLine(sureFg, w, h, lm[a], lm[b], Math.max(1.5, SURE_FG_BONE_RADIUS * s), 255);
  const palm = new Uint8Array(n);
  fillPolygon(palm, w, h, PALM_POLYGON.map((i) => lm[i]), 255);
  const core = erode(palm, w, h, Math.max(1, SURE_FG_PALM_ERODE * s));
  for (let i = 0; i < n; i++) if (core[i]) sureFg[i] = 255;
  const hull = convexHull(lm);
  const hullMask = new Uint8Array(n);
  fillPolygon(hullMask, w, h, hull, 255);
  let hullArea = 0;
  for (let i = 0; i < n; i++) if (hullMask[i]) hullArea++;
  const probable = dilate(hullMask, w, h, Math.max(2, PROBABLE_FG_GROW * s));
  const band = dilate(hullMask, w, h, Math.max(4, PROBABLE_BG_GROW * s));
  // the forearm strip (wrist away from the middle knuckle, to the border) is probable background, not sure background
  const dx = lm[0].x - lm[9].x, dy = lm[0].y - lm[9].y, l = Math.hypot(dx, dy) || 1;
  drawThickLine(band, w, h, lm[0], { x: lm[0].x + (dx / l) * 4 * (w + h), y: lm[0].y + (dy / l) * 4 * (w + h) }, 0.9 * s, 255);
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) labels[i] = sureFg[i] ? GRABCUT_LABELS.FGD : probable[i] ? GRABCUT_LABELS.PR_FGD : band[i] ? GRABCUT_LABELS.PR_BGD : GRABCUT_LABELS.BGD;
  return { width: w, height: h, labels, sureFg, probable, band, hullArea, palmWidthPx: s };
}

function cleanUp(raw: Uint8Array, w: number, h: number, prefer: Uint8Array): Uint8Array {
  let m = keepMainComponent(raw, w, h, prefer).mask;
  m = fillSmallHoles(m, w, h, Math.max(4, Math.round(0.004 * m.reduce((s, v) => s + (v ? 1 : 0), 0))));
  m = open(majority3(m, w, h), w, h, 1);
  return keepMainComponent(m, w, h, prefer).mask;
}

/** Segment one carving view. Never throws: a failure is a rejected view with its reason. */
export function segmentView(ctx: SegViewContext, o: SegmentOptions): ViewSegmentation {
  const t0 = now();
  const { width: w, height: h } = ctx.image;
  const n = w * h;
  const rejected: string[] = [];
  const lmOk = !!ctx.landmarks && [0, 5, 9, 13, 17].every((i) => ctx.landmarks![i]);
  const lm = lmOk ? (ctx.landmarks as (Pt | null)[]).map((p) => p ?? ctx.landmarks![0] ?? { x: 0, y: 0 }) : null;
  const ev = o.method === "grabcut" ? null : planeEvidence(ctx, o);
  let mask: Uint8Array = new Uint8Array(n);
  const known = new Uint8Array(n).fill(255);
  const seeds = lm ? landmarkSeeds(lm, w, h) : null;
  if (!seeds) rejected.push("no_landmarks");
  else if (o.method === "plane") {
    const cand = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (ev!.roi[p] && ev!.hitsTable[p] && !ev!.agree[p]) cand[p] = 255;
    mask = cleanUp(cand, w, h, seeds.sureFg);
    // no plane evidence possible: the ray misses the table, or meets it beyond the verifiable radius
    for (let p = 0; p < n; p++)
      if (ev!.roi[p] && !ev!.verifiable[p]) {
        known[p] = 0;
        mask[p] = 0;
      }
  } else {
    if (!o.cv) rejected.push("opencv_missing");
    else {
      const labels = new Uint8Array(seeds.labels);
      if (o.method === "combined") {
        // sure background: table-confirmed pixels away (3 px) from anything unconfirmed, so the hand's own
        // near-table rim (within a millimetre or two of the table it agrees too) does not teach the background model skin
        const sureTable = erode(ev!.agree, w, h, 3);
        // the forearm between the wrist and the volume's cut is probably hand
        const fore = new Uint8Array(n);
        const dx = lm![0].x - lm![9].x, dy = lm![0].y - lm![9].y, l = Math.hypot(dx, dy) || 1;
        drawThickLine(fore, w, h, lm![0], { x: lm![0].x + (dx / l) * 4 * (w + h), y: lm![0].y + (dy / l) * 4 * (w + h) }, 0.5 * seeds.palmWidthPx, 255);
        for (let p = 0; p < n; p++) {
          if (!ev!.roi[p]) labels[p] = GRABCUT_LABELS.BGD;
          else if (seeds.sureFg[p]) labels[p] = GRABCUT_LABELS.FGD;
          else if (sureTable[p]) labels[p] = GRABCUT_LABELS.BGD;
          else if (ev!.agree[p]) labels[p] = GRABCUT_LABELS.PR_BGD;
          else if (seeds.probable[p] || fore[p]) labels[p] = GRABCUT_LABELS.PR_FGD;
          else labels[p] = GRABCUT_LABELS.PR_BGD;
        }
      }
      try {
        const band = new Uint8Array(n);
        for (let p = 0; p < n; p++) if (labels[p] !== GRABCUT_LABELS.BGD) band[p] = 255;
        const g = runGrabCutWithModels(o.cv, ctx.image, { ...seeds, labels, band: dilate(band, w, h, 4) }, o.grabCutIterations ?? GRABCUT_ITERATIONS);
        mask = cleanUp(g.mask, w, h, seeds.sureFg);
      } catch (e) {
        rejected.push(`segmentation_failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  let handPixels = 0, roiN = 0, unk = 0;
  for (let p = 0; p < n; p++) {
    if (mask[p]) handPixels++;
    if (ev ? ev.roi[p] : true) {
      roiN++;
      if (!known[p]) unk++;
    }
  }
  let inside: number | null = null;
  if (lm && handPixels) {
    inside = 0;
    for (const p of lm) {
      const x = Math.floor(p.x), y = Math.floor(p.y);
      if (x >= 0 && y >= 0 && x < w && y < h && (mask[y * w + x] || !known[y * w + x])) inside++;
    }
    if (inside < 0.85 * lm.length) rejected.push(`landmarks_outside_mask (${inside}/21 inside)`);
  }
  if (seeds && !handPixels && !rejected.length) rejected.push("mask_empty");
  if (ev && ev.agreeShare < 0.3) rejected.push(`table_not_verified (${Math.round(ev.agreeShare * 100)} % of the table around the hand agreed with a neighbour)`);
  return {
    id: ctx.id,
    method: o.method,
    mask: { width: w, height: h, data: mask },
    known: { width: w, height: h, data: known },
    rejected,
    stats: { handPixels, unknownShare: roiN ? unk / roiN : 0, tableAgreeShare: ev ? ev.agreeShare : null, landmarksInside: inside, neighbours: ctx.neighbours.map((b) => b.id), ms: now() - t0 },
  };
}

/** IoU of a mask with the truth over the known pixels, and the share of truth hand pixels left unknown. */
export function scoreAgainstTruth(seg: ViewSegmentation, truth: BinaryMask): { iou: number; unknownHandShare: number; fpPx: number; fnPx: number } {
  let i = 0, u = 0, fp = 0, fn = 0, th = 0, tu = 0;
  for (let p = 0; p < truth.data.length; p++) {
    const t = truth.data[p] > 0;
    if (t) th++;
    if (!seg.known.data[p]) {
      if (t) tu++;
      continue;
    }
    const m = seg.mask.data[p] > 0;
    if (m && t) i++;
    if (m || t) u++;
    if (m && !t) fp++;
    if (!m && t) fn++;
  }
  return { iou: u ? i / u : 1, unknownHandShare: th ? tu / th : 0, fpPx: fp, fnPx: fn };
}
