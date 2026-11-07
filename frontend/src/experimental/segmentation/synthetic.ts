// A SYNTHETIC hand generator: a parametric flat hand (palm, five capsule digits, forearm) drawn on a background, with
// its exact ground-truth mask and the 21 landmarks that go with it. For unit tests and for evaluating the pipeline
// mechanics against a KNOWN answer. It says nothing about real hands: results measured on these images are
// "synthetic" and must never be reported as accuracy on people.
import type { BinaryMask, Pt } from "../common";
import { drawThickLine, fillPolygon } from "./geometry";
import type { ImageLike } from "./imageops";

export interface SyntheticHandOptions {
  width?: number;
  height?: number;
  /** Where the wrist point (landmark 0) is, in pixels. Default: centre horizontally, 72 % down. */
  wrist?: Pt;
  /** Palm width in pixels (landmark 5 to landmark 17). Default 28 % of the shorter image side. */
  palmWidth?: number;
  /** Rotation of the whole hand about the wrist, degrees (0 = fingers point up the image). */
  rotationDeg?: number;
  /** Finger fan-out in degrees at the outer fingers (0 = parallel). */
  spreadDeg?: number;
  /** Finger radius as a fraction of the palm width (0.115 leaves a gap at 0 spread; 0.17 makes fingers touch). */
  fingerRadius?: number;
  skin?: [number, number, number];
  background?: [number, number, number];
  /** Deterministic per-pixel noise amplitude (grey levels), to give the picture a little texture. */
  noise?: number;
  seed?: number;
  /** Length of forearm drawn below the wrist, in palm widths (it must be cut away by the wrist boundary). */
  forearm?: number;
}

export interface SyntheticHand {
  image: ImageLike;
  /** Ground-truth hand mask WITHOUT the forearm (the hand up to the wrist line), at the image size. */
  truth: BinaryMask;
  /** Mask with the forearm included. */
  withForearm: BinaryMask;
  landmarks: Pt[];
  palmWidth: number;
}

/** Local hand frame: x across the palm, y from the wrist towards the fingers (up). Lengths in palm widths. */
function localLandmarks(spreadDeg: number): Pt[] {
  const lm: Pt[] = new Array(21);
  lm[0] = { x: 0, y: 0 };
  lm[1] = { x: -0.35, y: 0.25 };
  lm[2] = { x: -0.72, y: 0.55 };
  lm[3] = { x: -0.95, y: 0.85 };
  lm[4] = { x: -1.1, y: 1.15 };
  const mcpX = [-0.5, -0.1667, 0.1667, 0.5];
  const lengths = [0.95, 1.05, 0.98, 0.75];
  const angles = [-1, -0.33, 0.33, 1].map((a) => (a * spreadDeg * Math.PI) / 180);
  const base = [5, 9, 13, 17];
  for (let f = 0; f < 4; f++) {
    const mcp = { x: mcpX[f], y: 1.1 };
    const dir = { x: Math.sin(angles[f]), y: Math.cos(angles[f]) };
    const L = lengths[f];
    lm[base[f]] = mcp;
    lm[base[f] + 1] = { x: mcp.x + dir.x * L * 0.45, y: mcp.y + dir.y * L * 0.45 };
    lm[base[f] + 2] = { x: mcp.x + dir.x * L * 0.75, y: mcp.y + dir.y * L * 0.75 };
    lm[base[f] + 3] = { x: mcp.x + dir.x * L, y: mcp.y + dir.y * L };
  }
  return lm;
}

export function makeSyntheticHand(o: SyntheticHandOptions = {}): SyntheticHand {
  const width = o.width ?? 400;
  const height = o.height ?? 400;
  const pw = o.palmWidth ?? 0.28 * Math.min(width, height);
  const wrist = o.wrist ?? { x: width / 2, y: height * 0.72 };
  const rot = ((o.rotationDeg ?? 0) * Math.PI) / 180;
  const fr = (o.fingerRadius ?? 0.115) * pw;
  const local = localLandmarks(o.spreadDeg ?? 14);
  // local (x right, y up) -> image: rotate about the wrist, then y down.
  const toImg = (p: Pt): Pt => {
    const x = p.x * pw;
    const y = p.y * pw;
    const rx = x * Math.cos(rot) - y * Math.sin(rot);
    const ry = x * Math.sin(rot) + y * Math.cos(rot);
    return { x: wrist.x + rx, y: wrist.y - ry };
  };
  const lm = local.map(toImg);

  const draw = (withForearm: boolean): Uint8Array => {
    const m = new Uint8Array(width * height);
    // palm
    fillPolygon(m, width, height, [{ x: -0.55, y: 0 }, { x: -0.62, y: 1.1 }, { x: 0.62, y: 1.1 }, { x: 0.55, y: 0 }].map(toImg), 255);
    // thenar and thumb
    drawThickLine(m, width, height, lm[0], lm[1], 0.2 * pw, 255);
    drawThickLine(m, width, height, lm[1], lm[2], 0.17 * pw, 255);
    drawThickLine(m, width, height, lm[2], lm[3], 0.14 * pw, 255);
    drawThickLine(m, width, height, lm[3], lm[4], 0.125 * pw, 255);
    // fingers: one capsule from knuckle to tip
    for (const b of [5, 9, 13, 17]) drawThickLine(m, width, height, lm[b], lm[b + 3], fr, 255);
    if (withForearm) {
      const len = o.forearm ?? 1.6;
      fillPolygon(m, width, height, [{ x: -0.45, y: 0.02 }, { x: 0.45, y: 0.02 }, { x: 0.45, y: -len }, { x: -0.45, y: -len }].map(toImg), 255);
    }
    return m;
  };
  const withForearm = draw(true);
  const handOnly = draw(false);
  // The hand ends at the wrist line (through the wrist point, across the hand): clip the truth there, as the
  // pipeline's wrist boundary does. "Up" along the fingers, in image pixels, is (-sin rot, -cos rot).
  const upx = -Math.sin(rot);
  const upy = -Math.cos(rot);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (handOnly[y * width + x] && (x + 0.5 - wrist.x) * upx + (y + 0.5 - wrist.y) * upy < 0) handOnly[y * width + x] = 0;
    }
  }

  const skin = o.skin ?? [201, 150, 120];
  const bg = o.background ?? [235, 235, 238];
  const noise = o.noise ?? 0;
  let s = (o.seed ?? 1) >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const c = withForearm[i] ? skin : bg;
    const n = noise ? rnd() * noise : 0;
    data[i * 4] = c[0] + n;
    data[i * 4 + 1] = c[1] + n;
    data[i * 4 + 2] = c[2] + n;
    data[i * 4 + 3] = 255;
  }
  return {
    image: { width, height, data },
    truth: { width, height, data: handOnly },
    withForearm: { width, height, data: withForearm },
    landmarks: lm,
    palmWidth: pw,
  };
}

/** A box blur (repeated) of an RGB picture, to make a synthetic picture look out of focus. */
export function blurImage(img: ImageLike, radius: number, passes = 3): ImageLike {
  const { width: w, height: h } = img;
  let cur = new Float32Array(img.data.length);
  for (let i = 0; i < cur.length; i++) cur[i] = img.data[i];
  for (let pass = 0; pass < passes; pass++) {
    for (const horizontal of [true, false]) {
      const next = new Float32Array(cur.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            let n = 0;
            for (let k = -radius; k <= radius; k++) {
              const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
              const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
              sum += cur[(yy * w + xx) * 4 + c];
              n++;
            }
            next[(y * w + x) * 4 + c] = sum / n;
          }
          next[(y * w + x) * 4 + 3] = 255;
        }
      }
      cur = next;
    }
  }
  const data = new Uint8ClampedArray(cur.length);
  for (let i = 0; i < data.length; i++) data[i] = cur[i];
  return { width: w, height: h, data };
}

/** Paint a filled disc of one colour over a picture (an occluder). */
export function paintDisc(img: ImageLike, c: Pt, radius: number, colour: [number, number, number]): ImageLike {
  const data = new Uint8ClampedArray(img.data);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if ((x + 0.5 - c.x) ** 2 + (y + 0.5 - c.y) ** 2 <= radius * radius) {
        const i = (y * img.width + x) * 4;
        data[i] = colour[0];
        data[i + 1] = colour[1];
        data[i + 2] = colour[2];
      }
    }
  }
  return { width: img.width, height: img.height, data };
}
