// The printed metric marker board of the EXPERIMENTAL multi-view hand reconstruction (board v1).
//
// One A4 sheet, landscape, printed at 100 % scale. Square fiducial markers (6 x 6 cells: a black border of one cell
// around 4 x 4 data bits) run along three edges; the fourth (left) short edge is left open so the wrist and forearm can
// come onto the sheet. The hand rests palm-down in the plain white middle. Four short grey ticks mark where the coin
// lies, well outside its edge (a ring AT the coin's edge biased the coin's measured diameter), so the coin's diameter can
// be measured in board millimetres (a check of the print scale; see README.md).
//
// The board coordinate frame (millimetres, right-handed): origin at the paper's bottom-left corner as printed (landscape,
// text upright), +x along the long edge to the right, +y up the page, +z out of the paper toward a viewer above it. A
// hand resting on the board has z > 0. This is the world frame of every reconstruction made with the board.
//
// The marker codes are this project's own (dictionary.ts), not an ArUco dictionary, so nothing here depends on another
// project's data. Every number is a design choice for a first prototype, not a validated optimum.
import { MARKER_CODES } from "./dictionary";

export const BOARD_VERSION = "glovesize-board/1";

/** A4 landscape, millimetres. */
export const PAPER = { widthMm: 297, heightMm: 210 } as const;

export interface BoardLayout {
  version: string;
  paper: { widthMm: number; heightMm: number };
  /** Cells per marker side, border included (6 = 1 border + 4 data + 1 border). */
  cellsPerSide: number;
  /** Data bits per side (4). */
  bitsPerSide: number;
  /** Printed side of one marker, border included, in mm. */
  markerMm: number;
  markers: BoardMarker[];
  /** Where the coin is placed (board plane, z = 0): its centre and expected diameter, and the four printed placement
   *  ticks (radial, at 0, 90, 180 and 270 degrees, from `innerMm` to `innerMm + lengthMm` from the centre). */
  coinTarget: { center: { x: number; y: number }; diameterMm: number; ticks: { innerMm: number; lengthMm: number; widthMm: number } };
  /** The plain region meant for the hand (no markers), board mm. */
  handArea: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface BoardMarker {
  /** Index into MARKER_CODES; also the marker's printed id. */
  id: number;
  /** The 16-bit code (bit 15 = top-left data bit, row by row; 1 = white). */
  code: number;
  /** Lower-left corner of the marker's printed square (border included), board mm. */
  x: number;
  y: number;
}

export interface Corner3 {
  x: number;
  y: number;
  z: number;
}

/** Margin kept free of print at every paper edge (most printers cannot print the last few millimetres). */
const MARGIN_MM = 8;
const MARKER_MM = 30;
const GAP_MM = 10;
const LONG_EDGE_COUNT = 7;
const RIGHT_EDGE_COUNT = 2;

function buildLayout(): BoardLayout {
  const markers: BoardMarker[] = [];
  const add = (x: number, y: number) => {
    const id = markers.length;
    markers.push({ id, code: MARKER_CODES[id], x, y });
  };
  const rowSpan = LONG_EDGE_COUNT * MARKER_MM + (LONG_EDGE_COUNT - 1) * GAP_MM;
  const x0 = PAPER.widthMm - MARGIN_MM - rowSpan; // the rows end at the right margin; the left side stays open
  // Top row (y near the top edge), left to right.
  for (let i = 0; i < LONG_EDGE_COUNT; i++) add(x0 + i * (MARKER_MM + GAP_MM), PAPER.heightMm - MARGIN_MM - MARKER_MM);
  // Right column, top to bottom, centred between the rows.
  const colSpan = RIGHT_EDGE_COUNT * MARKER_MM + (RIGHT_EDGE_COUNT - 1) * GAP_MM;
  const yTop = (PAPER.heightMm + colSpan) / 2 - MARKER_MM;
  for (let i = 0; i < RIGHT_EDGE_COUNT; i++) add(PAPER.widthMm - MARGIN_MM - MARKER_MM, yTop - i * (MARKER_MM + GAP_MM));
  // Bottom row, right to left.
  for (let i = LONG_EDGE_COUNT - 1; i >= 0; i--) add(x0 + i * (MARKER_MM + GAP_MM), MARGIN_MM);
  const rightInner = PAPER.widthMm - MARGIN_MM - MARKER_MM - GAP_MM;
  const handArea = {
    minX: 0,
    minY: MARGIN_MM + MARKER_MM + GAP_MM,
    maxX: rightInner,
    maxY: PAPER.heightMm - MARGIN_MM - MARKER_MM - GAP_MM,
  };
  return {
    version: BOARD_VERSION,
    paper: { ...PAPER },
    cellsPerSide: 6,
    bitsPerSide: 4,
    markerMm: MARKER_MM,
    markers,
    // Beyond the fingertips of a hand whose wrist is at the open left edge, clear of the right-hand markers.
    coinTarget: { center: { x: rightInner - 20, y: PAPER.heightMm / 2 }, diameterMm: 23, ticks: { innerMm: 20, lengthMm: 4, widthMm: 0.5 } },
    handArea,
  };
}

export const BOARD: BoardLayout = buildLayout();

/** The four corners of a marker's printed square on the board (z = 0), in the order top-left, top-right,
 *  bottom-right, bottom-left as seen on the upright printed page. Detectors report image corners in this order. */
export function markerCorners(m: Pick<BoardMarker, "x" | "y">, markerMm = BOARD.markerMm): [Corner3, Corner3, Corner3, Corner3] {
  return [
    { x: m.x, y: m.y + markerMm, z: 0 },
    { x: m.x + markerMm, y: m.y + markerMm, z: 0 },
    { x: m.x + markerMm, y: m.y, z: 0 },
    { x: m.x, y: m.y, z: 0 },
  ];
}

/** The colour of the printed board at a board point (x, y mm): true = black. The paper is white elsewhere. Used by
 *  the test renderer and by the known-background segmentation (the board's expected appearance in a view). */
export function boardIsBlack(x: number, y: number, layout: BoardLayout = BOARD): boolean {
  const cell = layout.markerMm / layout.cellsPerSide;
  for (const m of layout.markers) {
    const u = x - m.x;
    const v = m.y + layout.markerMm - y; // distance down from the marker's top edge
    if (u < 0 || v < 0 || u >= layout.markerMm || v >= layout.markerMm) continue;
    const c = Math.floor(u / cell);
    const r = Math.floor(v / cell);
    if (r === 0 || c === 0 || r === layout.cellsPerSide - 1 || c === layout.cellsPerSide - 1) return true;
    return !markerBit(m.code, r - 1, c - 1, layout.bitsPerSide);
  }
  return false;
}

/** Data bit (row r, column c, from the top-left of the 4 x 4 data area) of a code: true = white. */
export function markerBit(code: number, r: number, c: number, bitsPerSide = 4): boolean {
  const i = r * bitsPerSide + c;
  return ((code >> (bitsPerSide * bitsPerSide - 1 - i)) & 1) === 1;
}

/** Is the board point on one of the printed coin-placement ticks (light grey)? For the renderers and the background
 *  model only. (Named "outline" for history: board v1 drafts had a ring at the coin's edge, which biased the coin
 *  measurement and was replaced by these ticks before anything was printed.) */
export function onCoinOutline(x: number, y: number, layout: BoardLayout = BOARD): boolean {
  const { center, ticks } = layout.coinTarget;
  const dx = x - center.x;
  const dy = y - center.y;
  const half = ticks.widthMm / 2;
  const inRun = (along: number, across: number) => along >= ticks.innerMm && along <= ticks.innerMm + ticks.lengthMm && Math.abs(across) <= half;
  return inRun(dx, dy) || inRun(-dx, dy) || inRun(dy, dx) || inRun(-dy, dx);
}
