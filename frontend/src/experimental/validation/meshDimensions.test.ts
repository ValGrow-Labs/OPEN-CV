// Mesh-derived dimensions on a hand made of boxes (TEST FIXTURE: invented shapes whose answers are known exactly).
// Board frame as on the page: the hand lies palm-down with the fingers toward +x; the board is z = 0.
import { describe, expect, it } from "vitest";
import { boardLabels, boxesMesh, SUPPORT_LABELS, type Box } from "./__fixtures__/fixtures";
import { CLOSED_GAP_NOTE, meshDimensions, sliceLabelled } from "./meshDimensions";
import type { Vec3 } from "../reconstruction/linalg";

// palm on the board; index and middle float 3 / 2.5 mm above it with a 7 mm gap; ring touches middle; little 8 mm from ring
const palm: Box = { min: [0, 100, 0], max: [100, 185, 24] };
const index: Box = { min: [99, 100, 3], max: [160, 118, 21] };
const middle: Box = { min: [99, 125, 2.5], max: [170, 144, 21.5] };
const ring: Box = { min: [99, 144, 3], max: [165, 162, 21] };
const little: Box = { min: [99, 170, 4], max: [150, 185, 20] };
const mesh = boxesMesh([palm, index, middle, ring, little], 1);
const support = boardLabels(mesh);
const frame = { source: "triangulated", origin: [0, 142.5, 12] as Vec3, axisX: [0, 1, 0] as Vec3, axisY: [1, 0, 0] as Vec3, knuckleYMm: 100 };
const axis = (b: Box) => ({ base: [100, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2] as Vec3, dir: [1, 0, 0] as Vec3 });
const fingers = [
  { name: "index" as const, ...axis(index) },
  { name: "middle" as const, ...axis(middle) },
  { name: "ring" as const, ...axis(ring) },
  { name: "little" as const, ...axis(little) },
];
const dims = meshDimensions({ mesh, support, supportLabels: SUPPORT_LABELS, frame, fingers });

describe("meshDimensions on a box hand", () => {
  it("knuckle section: width without board points, height down to the board contact", () => {
    expect(dims.knuckle_section_width.value).toBeCloseTo(85, 1);
    expect(dims.knuckle_section_height.value).toBeCloseTo(24, 1);
    expect(dims.knuckle_section_height.note).toMatch(/board contact/);
    expect(dims.knuckle_section_width.basis).toBe("model");
  });

  it("finger width and height 15 mm from the tip", () => {
    expect(dims.finger_width_index_at_15mm.value).toBeCloseTo(18, 1);
    expect(dims.finger_height_index_at_15mm.value).toBeCloseTo(18, 1); // floating: no board contact
    expect(dims.finger_height_index_at_15mm.note).not.toMatch(/reaches the board/);
    expect(dims.finger_width_little_at_15mm.value).toBeCloseTo(15, 1);
    expect(dims.finger_height_little_at_15mm.value).toBeCloseTo(16, 1);
  });

  it("merged fingers are not separable: no width, and the gap is 0 with the note", () => {
    expect(dims.finger_width_middle_at_15mm.value).toBeNull();
    expect(dims.finger_width_middle_at_15mm.note).toMatch(/merged/);
    expect(dims.finger_gap_middle_ring.value).toBe(0);
    expect(dims.finger_gap_middle_ring.note).toContain(CLOSED_GAP_NOTE);
  });

  it("open gaps 10 mm proximal to the shorter tip", () => {
    expect(dims.finger_gap_index_middle.value).toBeCloseTo(7, 1);
    expect(dims.finger_gap_ring_little.value).toBeCloseTo(8, 1);
  });

  it("missing axes or frame: unavailable with the reason, never a number", () => {
    expect(dims.finger_width_thumb_at_15mm.value).toBeNull();
    expect(dims.finger_width_thumb_at_15mm.note).toMatch(/no axis for the thumb/);
    expect(dims.finger_gap_thumb_index.basis).toBe("none");
    const noFrame = meshDimensions({ mesh, support, supportLabels: SUPPORT_LABELS, frame: null, fingers });
    expect(Object.values(noFrame).every((q) => q.value === null && /no hand_frame/.test(q.note))).toBe(true);
    const noAxes = meshDimensions({ mesh, support, supportLabels: SUPPORT_LABELS, frame, fingers: null });
    expect(noAxes.knuckle_section_width.value).toBeCloseTo(85, 1);
    expect(noAxes.finger_gap_index_middle.note).toMatch(/no finger_axes/);
    const pca = meshDimensions({ mesh, support, supportLabels: SUPPORT_LABELS, frame: { ...frame, source: "pca" }, fingers });
    expect(pca.knuckle_section_width.note).toMatch(/not from landmarks/);
  });

  it("board-contact points never widen a section", () => {
    // a section with a wide board footprint: a thin flange on the board under a narrow block
    const m = boxesMesh([{ min: [0, 0, 0], max: [20, 40, 1] }, { min: [0, 15, 0], max: [20, 25, 10] }], 0.5);
    const lab = new Uint8Array(m.vertices.length / 3).map((_, i) => (m.vertices[i * 3 + 2] < 1.1 ? 2 : 0));
    const loops = sliceLabelled(m, lab.map((l) => (l === 2 ? 1 : 0)), [10, 0, 0], [1, 0, 0]);
    expect(loops.length).toBe(1);
    const obs = loops[0].points.filter((_, i) => !loops[0].board[i]).map((p) => p[1]);
    expect(Math.max(...obs) - Math.min(...obs)).toBeLessThan(10.5);
  });
});
