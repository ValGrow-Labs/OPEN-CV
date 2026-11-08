// Comparing capture exports with a checked reference, on TEST FIXTURES (invented values; answers worked out by hand).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fixtureCaptureZip } from "./__fixtures__/fixtures";
import { compareCaptures, percentile, repeatabilityBySession } from "./compare";
import { parseCaptureZip } from "./exportModel";
import { checkReference } from "./reference";

const ref = checkReference(JSON.parse(readFileSync(path.join(__dirname, "__fixtures__", "reference.fixture.json"), "utf8"))).reference!;
// reference agreed values: hand_length 180.3, knuckle_section_width 85.0, circumference_knuckle 211
const zip = (name: string, o: Parameters<typeof fixtureCaptureZip>[0]) => parseCaptureZip(name, fixtureCaptureZip(o));
const compressed = (() => {
  const b = fixtureCaptureZip({});
  const dv = new DataView(b.buffer);
  dv.setUint16(dv.getUint32(b.length - 22 + 16, true) + 10, 8, true);
  return b;
})();
const captures = [
  zip("c1.zip", { handLength: 181.3, palmWidth: 85.5, withFrame: true, circumference: 215 }),
  zip("c2.zip", { handLength: 179.3, palmWidth: 84.5, withFrame: true }),
  zip("c3.zip", { handLength: 180.8, palmWidth: 86, withFrame: true, session: "S2", conditions: ["glare"] }),
  zip("c4.zip", { handLength: 190, accepted: false, session: "S2", conditions: ["glare"] }),
  zip("c5.zip", { refused: "camera_not_calibrated" }),
  zip("c6.zip", { handLength: 180.3, scaleWrong: true }),
  zip("c7.zip", { handLength: 180.3, ruler: "fail" }),
  zip("c8.zip", { handLength: 180.3, phantom: "another-phantom" }),
  parseCaptureZip("c9.zip", compressed),
];
const cmp = compareCaptures(captures, ref);
const dim = (n: string) => cmp.dimensions.find((d) => d.dimension === n)!;

describe("compareCaptures (fixtures)", () => {
  it("classifies captures and keeps the reasons", () => {
    expect(cmp.captures.map((c) => c.status)).toEqual(["accepted", "accepted", "accepted", "rejected", "refused", "rejected", "rejected", "excluded", "unreadable"]);
    expect(cmp.counts).toMatchObject({ total: 9, accepted: 3, rejected: 3, refused: 1, excluded: 1, unreadable: 1 });
    const reasons = (n: string) => cmp.captures.find((c) => c.name === n)!.reasons.join(" | ");
    expect(reasons("c4.zip")).toMatch(/quality: sides_not_observed/);
    expect(reasons("c5.zip")).toMatch(/refused: camera_not_calibrated/);
    expect(reasons("c6.zip")).toMatch(/print scale check failed/);
    expect(reasons("c7.zip")).toMatch(/board check ruler: fail \(square 31.2 mm/);
    expect(reasons("c8.zip")).toMatch(/another-phantom, not the reference's synthetic-fixture-block-A/);
    expect(reasons("c9.zip")).toMatch(/compressed/);
  });

  it("errors against the agreed value, accepted captures only (definition-differs pair flagged)", () => {
    const h = dim("hand_length");
    expect(h.relation).toBe("definition_differs");
    expect(h.n).toBe(3);
    expect(h.errors.map((e) => +e.errorMm.toFixed(6))).toEqual([1, -1, 0.5]);
    expect(h.stats!.bias).toBeCloseTo(1 / 6, 10);
    expect(h.stats!.mae).toBeCloseTo(2.5 / 3, 10);
    expect(h.stats!.rmse).toBeCloseTo(Math.sqrt(0.75), 10);
    expect(h.stats!.sd).toBeCloseTo(Math.sqrt(2.1666666667 / 2), 6);
    expect(h.stats!.maxAbs).toBeCloseTo(1, 10);
    expect(h.stats!.loaLow).toBeCloseTo(1 / 6 - 1.96 * h.stats!.sd, 10);
    // produced a value: c1 c2 c3 c4 c7 of the 7 considered (c5 refused, c6 withheld)
    expect(h.capturesConsidered).toBe(7);
    expect(h.capturesWithValue).toBe(5);
    expect(h.missingReasons.map((m) => m.reason)).toEqual(expect.arrayContaining(["withheld: the board print scale check failed", "capture refused: nothing measured"]));
  });

  it("mesh-derived like-for-like dimension from the exported PLY and hand_frame", () => {
    const k = dim("knuckle_section_width");
    expect(k.relation).toBe("like_for_like");
    expect(k.n).toBe(3);
    expect(k.errors[0].errorMm).toBeCloseTo(0.5, 1);
    expect(k.errors[1].errorMm).toBeCloseTo(-0.5, 1);
    expect(k.errors[2].errorMm).toBeCloseTo(1, 1);
    // c4, c7 have no mesh/frame: missing, never zero
    expect(k.capturesWithValue).toBe(3);
    expect(k.missingReasons.some((m) => /no mesh/.test(m.reason))).toBe(true);
  });

  it("basis none is missing, not zero", () => {
    const c = dim("circumference_knuckle");
    expect(c.n).toBe(1);
    expect(c.errors[0].errorMm).toBeCloseTo(4, 10);
    expect(c.missingReasons.some((m) => /plane cuts the mesh in 2 loops/.test(m.reason))).toBe(true);
  });

  it("repeatability within and between sessions", () => {
    const r = dim("hand_length").repeatability;
    expect(r.withinSessionSdMm).toBeCloseTo(Math.SQRT2, 10); // S1: 181.3 and 179.3
    expect(r.repeatabilityCoefficientMm).toBeCloseTo(2.77 * Math.SQRT2, 10);
    expect(r.sessionsWithRepeats).toBe(1);
    expect(r.betweenSessionSdMm).toBeCloseTo(Math.sqrt(0.125), 10); // means 180.3 and 180.8
    expect(r.betweenSessionRangeMm).toBeCloseTo(0.5, 10);
  });

  it("by condition, with the shift against baseline", () => {
    const glare = cmp.conditions.find((c) => c.condition === "glare")!;
    expect(cmp.conditions[0].condition).toBe("baseline");
    expect(glare).toMatchObject({ captures: 2, accepted: 1, rejected: 1 });
    const h = glare.dimensions.find((d) => d.dimension === "hand_length")!;
    expect(h.biasMm).toBeCloseTo(0.5, 10);
    expect(h.biasShiftVsBaselineMm).toBeCloseTo(0.5, 10); // baseline bias (+1 and -1) is 0
  });

  it("capture figures: processing time, calibration, pose rms, support shares; reference-only and unmeasured lists", () => {
    expect(cmp.processingMs).toMatchObject({ n: 7, median: 20000, max: 20000 });
    expect(cmp.calibrationRmsPx.n).toBe(6); // the refused capture has no calibration
    expect(cmp.poseRmsPx.median).toBeCloseTo(0.5, 10);
    expect(cmp.supportShare.support_plane.median).toBeCloseTo(0.25, 10);
    expect(cmp.referenceOnly).toEqual(["extra_block_height"]);
    expect(cmp.notInReference).toContain("finger_gap_index_middle");
    expect(cmp.notes[0]).toMatch(/ONE phantom/);
  });

  it("a synthetic capture is never compared with a physical reference", () => {
    const phys = { ...ref, phantomId: "fixture-physical-id", synthetic: false };
    const out = compareCaptures([zip("s.zip", { phantom: "fixture-physical-id", dataOrigin: "synthetic" }), zip("t.zip", { phantom: "synthetic-x" })], phys);
    expect(out.captures.map((c) => c.status)).toEqual(["excluded", "excluded"]);
    expect(out.captures[0].reasons[0]).toMatch(/SYNTHETIC/);
  });

  it("helpers", () => {
    expect(percentile([5, 1, 4, 2, 3], 90)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    expect(repeatabilityBySession([{ session: "a", value: 1 }]).withinSessionSdMm).toBeNull();
  });
});
