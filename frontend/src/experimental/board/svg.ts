// The printable board as an SVG in real millimetres (width="297mm" height="210mm"), so printing it at 100 % ("Actual
// size", NOT "Fit to page") gives a 30.0 mm marker square. Drawn from the same layout the detectors use.
import { BOARD, markerBit, type BoardLayout } from "./spec";

export function boardSvg(layout: BoardLayout = BOARD): string {
  const { widthMm: W, heightMm: H } = layout.paper;
  const cell = layout.markerMm / layout.cellsPerSide;
  // SVG y runs down; board y runs up: svgY = H - boardY.
  const rects: string[] = [];
  for (const m of layout.markers) {
    const top = H - (m.y + layout.markerMm);
    rects.push(`<rect x="${m.x}" y="${top}" width="${layout.markerMm}" height="${layout.markerMm}" fill="#000"/>`);
    for (let r = 0; r < layout.bitsPerSide; r++)
      for (let c = 0; c < layout.bitsPerSide; c++)
        if (markerBit(m.code, r, c, layout.bitsPerSide))
          rects.push(`<rect x="${round(m.x + (c + 1) * cell)}" y="${round(top + (r + 1) * cell)}" width="${round(cell)}" height="${round(cell)}" fill="#fff"/>`);
  }
  const coin = layout.coinTarget;
  const label = `${layout.version} | print at 100 % (actual size) | each black square is ${layout.markerMm.toFixed(1)} mm | coin between the four ticks`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">`,
    `<title>Hand scan marker board (experimental)</title>`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`,
    ...rects,
    ...coinTicks(coin, H),
    `<text x="${W / 2}" y="${H - 3}" font-family="Arial, sans-serif" font-size="2.6" fill="#999" text-anchor="middle">${label}</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** The four radial placement ticks around the coin (outside its edge, so they never touch the coin's outline). */
function coinTicks(coin: BoardLayout["coinTarget"], H: number): string[] {
  const { center, ticks } = coin;
  const cx = center.x;
  const cy = H - center.y;
  const a = ticks.innerMm;
  const b = ticks.innerMm + ticks.lengthMm;
  return [
    [cx + a, cy, cx + b, cy],
    [cx - a, cy, cx - b, cy],
    [cx, cy + a, cx, cy + b],
    [cx, cy - a, cx, cy - b],
  ].map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#bbb" stroke-width="${ticks.widthMm}"/>`);
}
