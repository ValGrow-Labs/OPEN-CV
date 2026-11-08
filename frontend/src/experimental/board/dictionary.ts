// This project's own 4 x 4-bit marker dictionary (board v1). Generated deterministically by `generateDictionary`
// and frozen below, so a printed board never changes meaning. Rules (the usual ones for square fiducials):
//   * every code differs from every rotation (90, 180, 270 degrees) of itself in at least SELF_DISTANCE bits, so the
//     marker's orientation is never ambiguous;
//   * every pair of codes, under every relative rotation, differs in at least PAIR_DISTANCE bits, so up to
//     floor((PAIR_DISTANCE - 1) / 2) misread bits are still corrected to the right marker;
//   * between 5 and 11 white bits (no near-blank or near-solid markers).
// Bit 15 is the top-left data bit, row by row; 1 = white.

export const SELF_DISTANCE = 4;
export const PAIR_DISTANCE = 5;

export function rotateCode(code: number, quarterTurnsClockwise: number, n = 4): number {
  let c = code;
  for (let k = 0; k < ((quarterTurnsClockwise % 4) + 4) % 4; k++) {
    let out = 0;
    for (let r = 0; r < n; r++)
      for (let col = 0; col < n; col++) {
        // clockwise: new(r, c) = old(n - 1 - c, r)
        const srcR = n - 1 - col;
        const srcC = r;
        const bit = (c >> (n * n - 1 - (srcR * n + srcC))) & 1;
        out |= bit << (n * n - 1 - (r * n + col));
      }
    c = out;
  }
  return c;
}

export function hamming(a: number, b: number): number {
  let x = (a ^ b) >>> 0;
  let n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
}

const popcount = (c: number) => hamming(c, 0);

export function generateDictionary(count: number, seed = 20261108): number[] {
  const out: number[] = [];
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 16; // 16 bits
  };
  for (let tries = 0; tries < 2_000_000 && out.length < count; tries++) {
    const c = next() & 0xffff;
    const w = popcount(c);
    if (w < 5 || w > 11) continue;
    let ok = true;
    for (let k = 1; k < 4 && ok; k++) if (hamming(c, rotateCode(c, k)) < SELF_DISTANCE) ok = false;
    for (const d of out) {
      if (!ok) break;
      for (let k = 0; k < 4; k++)
        if (hamming(c, rotateCode(d, k)) < PAIR_DISTANCE) {
          ok = false;
          break;
        }
    }
    if (ok) out.push(c);
  }
  return out;
}

/** The frozen dictionary (generateDictionary(24), checked by dictionary.test.ts). */
export const MARKER_CODES: readonly number[] = generateDictionary(24);

/** Identify a read 4 x 4 code: the nearest dictionary code under any rotation, if within the correctable distance.
 *  `rotation` is the number of clockwise quarter turns that bring the READ code to the printed orientation. */
export function identify(read: number, codes: readonly number[] = MARKER_CODES): { id: number; rotation: number; errors: number } | null {
  const maxErrors = Math.floor((PAIR_DISTANCE - 1) / 2);
  let best: { id: number; rotation: number; errors: number } | null = null;
  for (let id = 0; id < codes.length; id++)
    for (let k = 0; k < 4; k++) {
      const e = hamming(rotateCode(read, k), codes[id]);
      if (e <= maxErrors && (!best || e < best.errors)) best = { id, rotation: k, errors: e };
    }
  return best;
}
