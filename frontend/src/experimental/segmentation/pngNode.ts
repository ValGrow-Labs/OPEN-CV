// NODE-ONLY minimal PNG reader for the composite evaluation (8-bit grey, grey+alpha, RGB, RGBA; not interlaced).
// Uses only Node's built-in zlib: no new dependency. Never import this from browser code.
import { inflateSync } from "node:zlib";
import type { ImageLike } from "./imageops";

export function decodePng(buf: Uint8Array): ImageLike {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error("not a PNG");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (pos < buf.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      const depth = body[8];
      colorType = body[9];
      if (depth !== 8 || body[12] !== 0) throw new Error(`unsupported PNG (bit depth ${depth}, interlace ${body[12]})`);
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType as 0 | 2 | 4 | 6];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const total = idat.reduce((s, c) => s + c.length, 0);
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) ((z.set(c, o)), (o += c.length));
  const raw = inflateSync(z);
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      const v = raw[src + x];
      let r: number;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + b;
      else if (f === 3) r = v + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * stride + x] = r & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    if (channels === 1 || channels === 2) {
      data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = px[s];
      data[4 * i + 3] = channels === 2 ? px[s + 1] : 255;
    } else {
      data[4 * i] = px[s];
      data[4 * i + 1] = px[s + 1];
      data[4 * i + 2] = px[s + 2];
      data[4 * i + 3] = channels === 4 ? px[s + 3] : 255;
    }
  }
  return { width, height, data };
}
