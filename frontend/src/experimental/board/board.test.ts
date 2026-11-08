import { describe, expect, it } from "vitest";
import { generateDictionary, hamming, identify, MARKER_CODES, PAIR_DISTANCE, rotateCode, SELF_DISTANCE } from "./dictionary";
import { BOARD, boardIsBlack, markerCorners, PAPER } from "./spec";
import { boardSvg } from "./svg";

describe("marker dictionary", () => {
  it("has enough codes for the board, frozen and deterministic", () => {
    expect(MARKER_CODES.length).toBeGreaterThanOrEqual(BOARD.markers.length);
    expect(generateDictionary(24)).toEqual([...MARKER_CODES]);
  });

  it("keeps every rotation and every pair apart", () => {
    for (const c of MARKER_CODES) for (let k = 1; k < 4; k++) expect(hamming(c, rotateCode(c, k))).toBeGreaterThanOrEqual(SELF_DISTANCE);
    for (let i = 0; i < MARKER_CODES.length; i++)
      for (let j = i + 1; j < MARKER_CODES.length; j++)
        for (let k = 0; k < 4; k++) expect(hamming(MARKER_CODES[i], rotateCode(MARKER_CODES[j], k))).toBeGreaterThanOrEqual(PAIR_DISTANCE);
  });

  it("four quarter turns are the identity; identify undoes a rotation and corrects up to two bit errors", () => {
    for (const c of MARKER_CODES) expect(rotateCode(c, 4)).toBe(c);
    MARKER_CODES.forEach((c, id) => {
      for (let k = 0; k < 4; k++) {
        const seen = rotateCode(c, (4 - k) % 4); // the printed code seen turned by k quarter turns anticlockwise
        expect(identify(seen)).toMatchObject({ id, rotation: k, errors: 0 });
        expect(identify(seen ^ 0b1000_0000_0000_0001)?.id).toBe(id);
      }
    });
  });
});

describe("board layout", () => {
  it("fits on A4 with the print margin, markers do not overlap, the left edge is open", () => {
    const s = BOARD.markerMm;
    for (const m of BOARD.markers) {
      expect(m.x).toBeGreaterThanOrEqual(8);
      expect(m.y).toBeGreaterThanOrEqual(8);
      expect(m.x + s).toBeLessThanOrEqual(PAPER.widthMm - 8 + 1e-9);
      expect(m.y + s).toBeLessThanOrEqual(PAPER.heightMm - 8 + 1e-9);
      // nothing at the open left short edge between the rows, where the forearm comes onto the sheet
      if (m.x < 60) expect(m.y < BOARD.handArea.minY || m.y >= BOARD.handArea.maxY).toBe(true);
    }
    for (let i = 0; i < BOARD.markers.length; i++)
      for (let j = i + 1; j < BOARD.markers.length; j++) {
        const a = BOARD.markers[i], b = BOARD.markers[j];
        expect(a.x + s <= b.x || b.x + s <= a.x || a.y + s <= b.y || b.y + s <= a.y).toBe(true);
      }
    expect(new Set(BOARD.markers.map((m) => m.code)).size).toBe(BOARD.markers.length);
  });

  it("corners run top-left, top-right, bottom-right, bottom-left on the upright page", () => {
    const [tl, tr, br, bl] = markerCorners({ x: 10, y: 20 }, 30);
    expect([tl, tr, br, bl]).toEqual([
      { x: 10, y: 50, z: 0 },
      { x: 40, y: 50, z: 0 },
      { x: 40, y: 20, z: 0 },
      { x: 10, y: 20, z: 0 },
    ]);
  });

  it("the coin target and the hand area are clear of every marker", () => {
    const { center, diameterMm } = BOARD.coinTarget;
    for (let a = 0; a < 360; a += 10) {
      const r = diameterMm / 2 + 3;
      expect(boardIsBlack(center.x + r * Math.cos((a * Math.PI) / 180), center.y + r * Math.sin((a * Math.PI) / 180))).toBe(false);
    }
    const h = BOARD.handArea;
    for (let x = h.minX + 1; x < h.maxX; x += 3) for (let y = h.minY + 1; y < h.maxY; y += 3) expect(boardIsBlack(x, y)).toBe(false);
  });

  it("the printed border cells are black and the data bits follow the code", () => {
    const m = BOARD.markers[0];
    const cell = BOARD.markerMm / 6;
    expect(boardIsBlack(m.x + cell / 2, m.y + cell / 2)).toBe(true); // bottom-left border cell
    // top-left data bit: row 1, column 1 of the 6 x 6 grid
    const white = ((m.code >> 15) & 1) === 1;
    expect(boardIsBlack(m.x + 1.5 * cell, m.y + BOARD.markerMm - 1.5 * cell)).toBe(!white);
  });

  it("the SVG is in real millimetres and draws every marker", () => {
    const svg = boardSvg();
    expect(svg).toContain('width="297mm" height="210mm"');
    expect(svg.match(/<rect [^>]*fill="#000"/g)?.length).toBe(BOARD.markers.length);
    expect(svg).toContain("print at 100 %");
  });
});
