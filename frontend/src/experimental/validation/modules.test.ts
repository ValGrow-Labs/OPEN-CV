// Small checks of the catalogue, the export reader and the test-phantom generator (TEST FIXTURES / SYNTHETIC shapes).
import { describe, expect, it } from "vitest";
import { meshBounds, meshVolume } from "../reconstruction/meshing";
import { DIMENSIONS, MAPPING, dimensionSpec, isPhantomOnly } from "./dimensions";
import { parseReconstructionJson, quantityAt } from "./exportModel";
import { fixtureReconstructionJson } from "./__fixtures__/fixtures";
import { capsulePhantom, DESIGN_NOTE } from "./phantomMesh";

describe("dimensions", () => {
  it("every catalogue dimension has exactly one mapping row, and every row names a catalogue dimension", () => {
    for (const d of DIMENSIONS) expect(MAPPING.filter((m) => m.dimension === d.name)).toHaveLength(1);
    for (const m of MAPPING) expect(dimensionSpec(m.dimension)).toBeDefined();
    expect(dimensionSpec("circumference_knuckle")!.instrument).toBe("tape");
    expect(isPhantomOnly("extra_base_width")).toBe(true);
    expect(isPhantomOnly("wrist_width")).toBe(false);
    // only the mesh-derived ones are like for like
    expect(MAPPING.filter((m) => m.relation === "like_for_like").every((m) => m.source.kind === "mesh")).toBe(true);
  });
});

describe("exportModel", () => {
  it("reads quantities by path and keeps missing ones missing", () => {
    const r = parseReconstructionJson("x", fixtureReconstructionJson({ handLength: null }));
    expect(quantityAt(r.reconstruction!.measurements, "handLength")).toMatchObject({ value: null, basis: "none" });
    expect(quantityAt(r.reconstruction!.measurements, "fingerLengths.middle")).toMatchObject({ value: 79, basis: "model" });
    expect(quantityAt(r.reconstruction!.measurements, "nope.deeper")).toBeNull();
  });

  it("tells an older export without hand_frame from a reconstruction without a hand frame", () => {
    const old = parseReconstructionJson("old", fixtureReconstructionJson({}));
    expect(old.handFrame).toBeNull();
    expect(old.handFrameMissing).toMatch(/older page version/);
    const empty = parseReconstructionJson("empty", { ...fixtureReconstructionJson({}), hand_frame: { source: null, origin: null, axis_x: null, axis_y: null, axis_z: null, knuckle_y_mm: null }, finger_axes: [] });
    expect(empty.handFrame).toBeNull();
    expect(empty.handFrameMissing).toMatch(/has no hand frame/);
    const ok = parseReconstructionJson("ok", fixtureReconstructionJson({ withFrame: true }));
    expect(ok.handFrame).toMatchObject({ source: "triangulated", knuckleYMm: 100, axisY: [1, 0, 0] });
  });

  it("reads the page's board_check and run fields", () => {
    const j = { ...fixtureReconstructionJson({}), board_check: { ruler: { verdict: "not_entered", reasons: ["x"] }, flatness: { verdict: "not_checked", reasons: [] }, coin: {}, valid_for_validation: false, not_valid_reasons: ["The board print check (ruler readings) was not entered."] } };
    const r = parseReconstructionJson("bc", j);
    expect(r.boardCheck).toMatchObject({ validForValidation: false, notValidReasons: ["The board print check (ruler readings) was not entered."] });
    expect(r.run).toMatchObject({ phantomId: "synthetic-fixture-block-A", sessionId: "S1", conditions: ["baseline"] });
  });
});

describe("capsulePhantom (SYNTHETIC design, not a reference)", () => {
  it("is a closed solid with a flat base on z = 0, cut square at the wrist", () => {
    const p = capsulePhantom({ voxelMm: 2 });
    const b = meshBounds(p.mesh);
    expect(meshVolume(p.mesh)).toBeGreaterThan(0);
    expect(b.min[2]).toBeCloseTo(0, 3); // extractMesh offsets the level by 1e-4
    expect(b.min[0]).toBeCloseTo(p.cutX, 3);
    // the tallest part is the wrist stub: its top is half its thickness above the hand's mid-plane (12 mm above the board)
    expect(b.max[2]).toBeCloseTo(p.params.palmThickness / 2 + p.params.wristThickness / 2, 0);
    expect(p.design.knuckle_section_width).toBe(p.params.palmBreadth);
    expect(p.notes[0]).toBe(DESIGN_NOTE);
  });
});
