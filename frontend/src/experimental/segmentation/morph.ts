// Binary-mask morphology on typed arrays (pure; no OpenCV): exact Euclidean distance transform, distance-based
// dilation and erosion (round structuring element), connected components, hole filling, majority smoothing.

const INF = 1e20;

/** 1D squared distance transform (Felzenszwalb and Huttenlocher), in place over `f` of length n. */
function edt1d(f: Float64Array, n: number, v: Int32Array, z: Float64Array, d: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s: number;
    for (;;) {
      const p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k] && k > 0) k--;
      else break;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
  for (let q = 0; q < n; q++) f[q] = d[q];
}

/** Euclidean distance (pixels) from every pixel to the nearest pixel whose value equals `target` (0 on such pixels). */
export function distanceTo(data: Uint8Array, w: number, h: number, target: 0 | 255): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const d = new Float64Array(n);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = data[i] === target ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, v, z, d);
    for (let y = 0; y < h; y++) grid[y * w + x] = f[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, v, z, d);
    for (let x = 0; x < w; x++) grid[y * w + x] = f[x];
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = grid[i] >= INF / 2 ? Infinity : Math.sqrt(grid[i]);
  return out;
}

/** Grow the mask by `r` pixels (round element). */
export function dilate(data: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const d = distanceTo(data, w, h, 255);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= r ? 255 : 0;
  return out;
}

/** Shrink the mask by `r` pixels (round element). Pixels beyond the image border count as background. */
export function erode(data: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const padded = new Uint8Array((w + 2) * (h + 2));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) padded[(y + 1) * (w + 2) + x + 1] = data[y * w + x];
  const d = distanceTo(padded, w + 2, h + 2, 0);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = data[y * w + x] && d[(y + 1) * (w + 2) + x + 1] > r ? 255 : 0;
  return out;
}

export const open = (data: Uint8Array, w: number, h: number, r: number) => dilate(erode(data, w, h, r), w, h, r);
export const close = (data: Uint8Array, w: number, h: number, r: number) => erode(dilate(data, w, h, r), w, h, r);

export interface Components {
  /** Label per pixel: 0 = not in the mask, 1.. = component id (4-connectivity). */
  labels: Int32Array;
  /** Pixel count per component id (index 0 unused). */
  sizes: number[];
}

/** Connected components of the pixels equal to `value` (4-connectivity). */
export function components(data: Uint8Array, w: number, h: number, value: 0 | 255 = 255): Components {
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (data[start] !== value || labels[start] !== 0) continue;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = next;
    let size = 0;
    while (sp > 0) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && data[p - 1] === value && labels[p - 1] === 0) ((labels[p - 1] = next), (stack[sp++] = p - 1));
      if (x < w - 1 && data[p + 1] === value && labels[p + 1] === 0) ((labels[p + 1] = next), (stack[sp++] = p + 1));
      if (y > 0 && data[p - w] === value && labels[p - w] === 0) ((labels[p - w] = next), (stack[sp++] = p - w));
      if (y < h - 1 && data[p + w] === value && labels[p + w] === 0) ((labels[p + w] = next), (stack[sp++] = p + w));
    }
    sizes.push(size);
    next++;
  }
  return { labels, sizes };
}

/**
 * Keep one connected component: the one holding most of the `prefer` pixels (the sure-hand seeds) when given,
 * else the largest. Returns the cleaned mask and the share of the mask's area that belonged to other components.
 */
export function keepMainComponent(data: Uint8Array, w: number, h: number, prefer?: Uint8Array): { mask: Uint8Array; strayShare: number } {
  const { labels, sizes } = components(data, w, h, 255);
  if (sizes.length <= 1) return { mask: new Uint8Array(w * h), strayShare: 0 };
  let best = 1;
  if (prefer) {
    const votes = new Array<number>(sizes.length).fill(0);
    for (let i = 0; i < labels.length; i++) if (prefer[i] && labels[i]) votes[labels[i]]++;
    let top = 0;
    for (let c = 1; c < sizes.length; c++) if (votes[c] > top) ((top = votes[c]), (best = c));
    if (top === 0) best = sizes.indexOf(Math.max(...sizes.slice(1)));
  } else {
    best = sizes.indexOf(Math.max(...sizes.slice(1)));
  }
  const out = new Uint8Array(w * h);
  let total = 0;
  for (let c = 1; c < sizes.length; c++) total += sizes[c];
  for (let i = 0; i < labels.length; i++) if (labels[i] === best) out[i] = 255;
  return { mask: out, strayShare: total ? 1 - sizes[best] / total : 0 };
}

/** Fill background holes (not connected to the image border) of at most `maxArea` pixels. */
export function fillSmallHoles(data: Uint8Array, w: number, h: number, maxArea: number): Uint8Array {
  const { labels, sizes } = components(data, w, h, 0);
  const touchesBorder = new Array<boolean>(sizes.length).fill(false);
  for (let x = 0; x < w; x++) {
    touchesBorder[labels[x]] = true;
    touchesBorder[labels[(h - 1) * w + x]] = true;
  }
  for (let y = 0; y < h; y++) {
    touchesBorder[labels[y * w]] = true;
    touchesBorder[labels[y * w + w - 1]] = true;
  }
  const out = new Uint8Array(data);
  for (let i = 0; i < out.length; i++) {
    const l = labels[i];
    if (l > 0 && !touchesBorder[l] && sizes[l] <= maxArea) out[i] = 255;
  }
  return out;
}

/** 3x3 majority filter: removes single-pixel spurs and notches. */
export function majority3(data: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && data[yy * w + xx]) n++;
        }
      }
      out[y * w + x] = n >= 5 ? 255 : 0;
    }
  }
  return out;
}

export function countOn(data: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i]) n++;
  return n;
}
