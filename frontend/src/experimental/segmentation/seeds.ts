// Seeds for a segmentation, drawn from the 21 hand landmarks. They only SAY WHERE the hand certainly is and where it
// certainly is not; the segmentation backend decides everything in between from the picture. The landmark hull is
// never returned as the mask.
import type { Pt } from "../common";
import {
  GRABCUT_LABELS,
  PROBABLE_BG_GROW,
  PROBABLE_FG_GROW,
  SURE_FG_BONE_RADIUS,
  SURE_FG_PALM_ERODE,
} from "./seedLabels";
import { BONES, PALM_POLYGON, convexHull, drawThickLine, fillPolygon, palmWidth } from "./geometry";
import { dilate, erode } from "./morph";

export interface Seeds {
  width: number;
  height: number;
  /** GrabCut labels per pixel: 0 sure background, 1 sure hand, 2 probable background, 3 probable hand. */
  labels: Uint8Array;
  /** 255 where the hand certainly is (thick bones + shrunken palm), else 0. */
  sureFg: Uint8Array;
  /** 255 inside the grown landmark hull (where the hand probably is). */
  probable: Uint8Array;
  /** 255 inside the probable-background band (anything outside it is sure background). */
  band: Uint8Array;
  /** Area of the plain landmark hull in pixels squared (the naive "mask" the segmentation must go beyond). */
  hullArea: number;
  /** The hand's size unit in this image (palm width, pixels). */
  palmWidthPx: number;
}

export function buildSeeds(lm: readonly Pt[], width: number, height: number): Seeds {
  const pw = palmWidth(lm);
  const n = width * height;
  const sureFg = new Uint8Array(n);
  const boneR = Math.max(1.5, SURE_FG_BONE_RADIUS * pw);
  for (const [a, b] of BONES) drawThickLine(sureFg, width, height, lm[a], lm[b], boneR, 255);
  const palm = new Uint8Array(n);
  fillPolygon(palm, width, height, PALM_POLYGON.map((i) => lm[i]), 255);
  const core = erode(palm, width, height, Math.max(1, SURE_FG_PALM_ERODE * pw));
  for (let i = 0; i < n; i++) if (core[i]) sureFg[i] = 255;

  const hull = convexHull(lm);
  const hullMask = new Uint8Array(n);
  fillPolygon(hullMask, width, height, hull, 255);
  let hullArea = 0;
  for (let i = 0; i < n; i++) if (hullMask[i]) hullArea++;
  const probable = dilate(hullMask, width, height, Math.max(2, PROBABLE_FG_GROW * pw));
  const band = dilate(hullMask, width, height, Math.max(4, PROBABLE_BG_GROW * pw));

  const labels = new Uint8Array(n); // 0 = sure background
  for (let i = 0; i < n; i++) {
    if (sureFg[i]) labels[i] = GRABCUT_LABELS.FGD;
    else if (probable[i]) labels[i] = GRABCUT_LABELS.PR_FGD;
    else if (band[i]) labels[i] = GRABCUT_LABELS.PR_BGD;
  }
  // The outermost pixel ring is background unless a sure-hand seed is there.
  for (let x = 0; x < width; x++) {
    if (!sureFg[x]) labels[x] = GRABCUT_LABELS.BGD;
    if (!sureFg[(height - 1) * width + x]) labels[(height - 1) * width + x] = GRABCUT_LABELS.BGD;
  }
  for (let y = 0; y < height; y++) {
    if (!sureFg[y * width]) labels[y * width] = GRABCUT_LABELS.BGD;
    if (!sureFg[y * width + width - 1]) labels[y * width + width - 1] = GRABCUT_LABELS.BGD;
  }
  return { width, height, labels, sureFg, probable, band, hullArea, palmWidthPx: pw };
}
