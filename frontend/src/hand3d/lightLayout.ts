// Layout maths of the light theme's labels (pure: no DOM, no three.js, so it is tested without WebGL).

export interface BracketBox {
  /** Left edge of the bracket line (px, in the stage). */
  x: number;
  /** Top and height of the bracket (px): it spans the two projected end points. */
  top: number;
  height: number;
}

/** Where the vertical bracket of the hand length goes: on the right of the hand, spanning the two projected
 *  end points (wrist and middle fingertip), with room left for the label to its left. ``handRight`` is the
 *  right-most projected point of the hand. The bracket stays inside the stage and is never shorter than
 *  ``minHeight`` (a hand seen edge-on or a degenerate pose still gets a visible bracket). */
export function bracketBox(opts: { y1: number; y2: number; handRight: number; width: number; height: number; gap?: number; minHeight?: number }): BracketBox {
  const gap = opts.gap ?? 16;
  const minHeight = opts.minHeight ?? 24;
  const lo = Math.min(opts.y1, opts.y2);
  const hi = Math.max(opts.y1, opts.y2);
  let top = lo;
  let h = Math.max(minHeight, hi - lo);
  top = Math.min(Math.max(2, top), Math.max(2, opts.height - h - 2));
  h = Math.min(h, Math.max(minHeight, opts.height - 4));
  const x = Math.min(Math.max(2, opts.handRight + gap), Math.max(2, opts.width - 4));
  return { x, top, height: h };
}

/** A label "Index 53 mm" as the name and the value: the colon in the light theme is drawn by CSS, so the text
 *  content stays exactly the given label. Labels without a trailing "<number> mm" are returned as a name only. */
export function splitLabel(label: string): { name: string; value: string } {
  const m = /^(.*?)\s+(-?[\d.,]+\s*mm)$/i.exec(label.trim());
  if (!m || !m[1]) return { name: label, value: "" };
  return { name: m[1], value: m[2] };
}
