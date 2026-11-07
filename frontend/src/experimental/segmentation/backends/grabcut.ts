// Backend (a): GrabCut (OpenCV), seeded from the landmarks. Runs on the working-size picture, cropped to the
// probable-background band so only the area around the hand is modelled.
import type { CV } from "../../../vision/opencv";
import type { ImageLike } from "../imageops";
import type { Seeds } from "../seeds";

// The OpenCV.js typings do not declare grabCut; the function exists in the bundled build (checked at run time).
type AnyCv = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function runGrabCut(cv: CV, img: ImageLike, seeds: Seeds, iterations: number): Uint8Array {
  const c = cv as unknown as AnyCv;
  if (typeof c.grabCut !== "function") throw new Error("this OpenCV.js build has no grabCut");
  const { width: w, height: h, labels, band } = seeds;
  // Crop to the band's bounding box (plus a margin).
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!band[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const out = new Uint8Array(w * h);
  if (x1 < 0) return out;
  x0 = Math.max(0, x0 - 2);
  y0 = Math.max(0, y0 - 2);
  x1 = Math.min(w - 1, x1 + 2);
  y1 = Math.min(h - 1, y1 + 2);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;

  const rgba = c.matFromImageData(img);
  const rgb = new c.Mat();
  c.cvtColor(rgba, rgb, c.COLOR_RGBA2RGB);
  const roiView = rgb.roi(new c.Rect(x0, y0, cw, ch));
  const crop = roiView.clone();
  const mask = new c.Mat(ch, cw, c.CV_8UC1);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) mask.data[y * cw + x] = labels[(y0 + y) * w + x0 + x];
  const bgd = new c.Mat();
  const fgd = new c.Mat();
  const rect = new c.Rect(0, 0, cw, ch);
  try {
    c.grabCut(crop, mask, rect, bgd, fgd, iterations, c.GC_INIT_WITH_MASK);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const v = mask.data[y * cw + x];
        if (v === c.GC_FGD || v === c.GC_PR_FGD) out[(y0 + y) * w + x0 + x] = 255;
      }
    }
  } finally {
    for (const m of [rgba, rgb, roiView, crop, mask, bgd, fgd]) m.delete();
  }
  return out;
}
