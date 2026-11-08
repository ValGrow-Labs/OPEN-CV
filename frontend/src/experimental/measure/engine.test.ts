// SIMULATED unit tests of the Stage 5 measurement engine: synthetic meshes (the capsule hand's exact signed distance field
// meshed at a fine grid, cylinders), stated input sigmas, the analytic budget, withholding and the reporting increment.
// Nothing here is a real-hand or real-phone result.
import { describe, expect, it } from "vitest";
import type { Mesh } from "../common";
import { extractMesh, sdfToField } from "../reconstruction/meshing";
import { FINGER_NAMES, fingersFromLandmarks, frameFromLandmarks, measureHand, type FingerAxis, type HandFrame } from "../reconstruction/measure";
import { DEFAULT_HAND_PARAMS, makeCapsuleHand } from "../reconstruction/synthetic";
import type { Vec3 } from "../reconstruction/linalg";
import { capsuleLandmarksHandFrame } from "../multiview/scene";
import { meshDimensions } from "../validation/meshDimensions";
import { camerasForScale, measureWithUncertainty, reportingIncrement, resolutionSummary, step125Floor, type EngineInput } from "./engine";
import { BOARD_ROUTE_SIMULATED, boardFreeUncertainty, PHONE_BOARD_ASSUMED, stated } from "./inputs";
import { fingerTips, fingerWidthAt } from "./sections";
import { FACTOR_KEYS, type CaptureUncertainty } from "./types";

// capsule hand meshed from its exact SDF (no carving): the engine's arithmetic on a known shape
const hand = makeCapsuleHand(DEFAULT_HAND_PARAMS);
const b = hand.bounds;
const mesh: Mesh = extractMesh(sdfToField(hand.sdf, { min: [b.min[0] - 2, b.min[1] - 2, b.min[2] - 2], max: [b.max[0] + 2, b.max[1] + 2, b.max[2] + 2] }, 1), 0);
const lm = capsuleLandmarksHandFrame(DEFAULT_HAND_PARAMS).map(([x, y, z]) => ({ x, y, z }));
const frame: HandFrame = { ...frameFromLandmarks(lm)!, source: "given" };
const fingers: FingerAxis[] = fingersFromLandmarks(lm);
const measurements = measureHand(mesh, frame, { fingers, accepted: true });
// cameras 340 mm away along -z (looking at the palm) and 640 px wide at 62 degrees: about 0.64 mm per pixel
const fx = 320 / Math.tan((31 * Math.PI) / 180);
const cams = [0, 1, 2].map((k) => ({ id: `c${k}`, intrinsics: { fx, fy: fx, cx: 320, cy: 180, width: 640, height: 360 }, pose: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, -100, 340 + k] as [number, number, number] } }));

function input(over: Partial<EngineInput> = {}): EngineInput {
  return {
    mesh,
    support: null,
    supportLabels: [],
    frame,
    fingers,
    measurements,
    accepted: true,
    supportBounded: false,
    up: [0, 0, 1],
    usedViews: cams.map((c) => c.id),
    landmarkSource: "given",
    cameras: camerasForScale(cams, [0, 100, 0]),
    voxelMm: 1.5,
    capture: BOARD_ROUTE_SIMULATED,
    ...over,
  };
}

describe("reporting increment (1-2-5 step at or below the standard uncertainty)", () => {
  it("steps", () => {
    expect(step125Floor(0.84)).toBeCloseTo(0.5);
    expect(step125Floor(1.3)).toBeCloseTo(1);
    expect(step125Floor(0.19)).toBeCloseTo(0.1);
    expect(step125Floor(0.2)).toBeCloseTo(0.2);
    expect(step125Floor(3.7)).toBeCloseTo(2);
    expect(step125Floor(5)).toBeCloseTo(5);
    expect(reportingIncrement(0.001)).toBe(0.01);
    // 0.1 mm needs a standard uncertainty below 0.2 mm
    expect(reportingIncrement(0.199)).toBeCloseTo(0.1);
    expect(reportingIncrement(0.2)).toBeCloseTo(0.2);
  });
});

describe("input sigmas carry their provenance", () => {
  it("every preset sigma states an origin and a source; nothing is unlabelled", () => {
    for (const cap of [BOARD_ROUTE_SIMULATED, PHONE_BOARD_ASSUMED]) {
      for (const k of ["focalRel", "poseRotDeg", "poseCentreMm", "scaleRel", "maskBoundaryPx", "landmarkPx", "landmark3dMm"] as const) {
        expect(["SIMULATED", "ASSUMED", "EXACT", "RUNTIME"]).toContain(cap[k].origin);
        expect(cap[k].source.length).toBeGreaterThan(20);
        expect(cap[k].value).toBeGreaterThanOrEqual(0);
      }
    }
    // the injected landmark noise is not a MediaPipe measurement
    expect(BOARD_ROUTE_SIMULATED.landmarkPx.origin).toBe("ASSUMED");
    // the board-free route must be told its focal / pose sigmas; only the coin scale has a SIMULATED default
    const bf = boardFreeUncertainty({
      focalRel: stated(0.01, "ASSUMED", "test value for the board-free interface, nobody measured it"),
      poseRotDeg: stated(0.3, "ASSUMED", "test value for the board-free interface, nobody measured it"),
      poseCentreMm: stated(1, "ASSUMED", "test value for the board-free interface, nobody measured it"),
      maskBoundaryPx: stated(1.25, "ASSUMED", "test value for the board-free interface, nobody measured it"),
      landmarkPx: stated(5, "ASSUMED", "test value for the board-free interface, nobody measured it"),
      landmark3dMm: stated(2.3, "ASSUMED", "test value for the board-free interface, nobody measured it"),
    });
    expect(bf.scaleReference).toBe("coin");
    expect(bf.scaleRel.origin).toBe("SIMULATED");
  });
});

describe("finger widths on the capsule hand (SIMULATED exact SDF mesh)", () => {
  const tips = fingerTips(mesh, null, fingers);
  it("width = capsule diameter at both stations; the 15 mm station equals validation/meshDimensions", () => {
    const dims = meshDimensions({ mesh, support: null, supportLabels: [], frame: { ...frame, knuckleYMm: frame.knuckleYMm ?? null }, fingers });
    for (const f of ["index", "middle", "ring", "little"] as const) {
      const r = 2 * DEFAULT_HAND_PARAMS.fingers[f].radius;
      const w15 = fingerWidthAt(mesh, null, tips, f, { kind: "fromTip", mm: 15 });
      const w25 = fingerWidthAt(mesh, null, tips, f, { kind: "fraction", of: "base_to_tip", f: 0.25 });
      expect(w15.value).not.toBeNull();
      expect(Math.abs(w15.value! - r)).toBeLessThan(0.3);
      expect(w25.value === null || Math.abs(w25.value - r) < 0.3).toBe(true);
      expect(w15.value!).toBeCloseTo(dims[`finger_width_${f}_at_15mm`].value!, 6);
    }
  });

  it("withholds a width when two fingers are merged in the section", () => {
    // two touching cylinders along +y
    const sdf = (x: number, y: number, z: number) => {
      const yy = Math.min(Math.max(y, 0), 60);
      return Math.min(Math.hypot(x + 4, y - yy, z), Math.hypot(x - 4, y - yy, z)) - 5;
    };
    const m2 = extractMesh(sdfToField(sdf, { min: [-12, -8, -8], max: [12, 68, 8] }, 0.5), 0);
    const ax: FingerAxis[] = [
      { name: "index", base: [-4, 0, 0], dir: [0, 1, 0] },
      { name: "middle", base: [4, 0, 0], dir: [0, 1, 0] },
    ];
    const t2 = fingerTips(m2, null, ax);
    const w = fingerWidthAt(m2, null, t2, "index", { kind: "fromTip", mm: 15 });
    expect(w.value).toBeNull();
    expect(w.note).toMatch(/merged/);
  });
});

describe("analytic budget (SIMULATED inputs on the capsule mesh)", () => {
  const rep = measureWithUncertainty(input());
  it("every reported value has definition, method, data source, basis and an uncertainty with all six factors", () => {
    const reported = rep.values.filter((v) => v.value !== null);
    expect(reported.length).toBeGreaterThanOrEqual(4 + 5 + 8);
    for (const v of reported) {
      expect(v.definition.length).toBeGreaterThan(30);
      expect(v.method.length).toBeGreaterThan(10);
      expect(v.dataSource.views.length).toBe(3);
      expect(["direct", "model"]).toContain(v.basis);
      expect(v.uncertainty).not.toBeNull();
      const u = v.uncertainty!;
      expect(u.components.map((c) => c.factor).sort()).toEqual([...FACTOR_KEYS].sort());
      expect(u.expanded95).toBeCloseTo(2 * u.standard, 9);
      expect(u.interval95[0]).toBeCloseTo(v.value! - u.expanded95, 9);
      expect(u.excludes).toMatch(/upper bound/);
      for (const c of u.components) expect(["SIMULATED", "ASSUMED", "EXACT", "RUNTIME"]).toContain(c.inputOrigin);
      expect(v.reportingIncrementMm).not.toBeNull();
      expect(v.reportingIncrementMm!).toBeLessThanOrEqual(u.standard + 1e-12);
    }
  });

  it("closed-form components follow the stated sigmas", () => {
    const L = rep.byKey.hand_length;
    const comp = (f: string) => L.uncertainty!.components.find((c) => c.factor === f)!.sigma;
    expect(comp("focal")).toBeCloseTo(L.value! * 0.001, 9);
    expect(comp("scale")).toBe(0); // EXACT in the simulation
    expect(comp("landmarks")).toBeCloseTo(0.9, 9); // the wrist landmark sets the wrist plane
    const mmpp = resolutionSummary(input().cameras)!.medianMmPerPx;
    expect(mmpp).toBeGreaterThan(0.6);
    expect(mmpp).toBeLessThan(0.7);
    expect(comp("boundary")).toBeCloseTo(0.6 * mmpp, 9); // one surface end
    expect(comp("voxel")).toBeCloseTo(1.5 / Math.sqrt(12), 9);
  });

  it("section and width offset gains are read on the mesh: about 2 for a width, about 2 pi for a loop", () => {
    const w = rep.byKey.finger_width_middle_tip15;
    expect(w.uncertainty!.components.find((c) => c.factor === "boundary")!.rule).toMatch(/read on the mesh/);
    const bnd = (k: string) => rep.byKey[k].uncertainty!.components.find((c) => c.factor === "boundary")!.sigma;
    const mmpp = rep.resolution!.medianMmPerPx;
    expect(bnd("finger_width_middle_tip15") / (0.6 * mmpp)).toBeGreaterThan(1.7);
    expect(bnd("finger_width_middle_tip15") / (0.6 * mmpp)).toBeLessThan(2.3);
    expect(bnd("knuckle_circumference") / (0.6 * mmpp)).toBeGreaterThan(5);
    expect(bnd("knuckle_circumference") / (0.6 * mmpp)).toBeLessThan(7.5);
  });

  it("a scale sigma from the coin scales every length", () => {
    const cap: CaptureUncertainty = { ...BOARD_ROUTE_SIMULATED, scaleRel: stated(0.0034, "SIMULATED", "coin/README.md sceneScale baseline claimed total sigma"), scaleReference: "coin" };
    const r = measureWithUncertainty(input({ capture: cap, fast: true }));
    const L = r.byKey.hand_length;
    expect(L.uncertainty!.components.find((c) => c.factor === "scale")!.sigma).toBeCloseTo(L.value! * 0.0034, 9);
  });
});

describe("withholding rules", () => {
  it("a support-bounded capture withholds the surface area; extents are flagged as hull upper bounds", () => {
    const r = measureWithUncertainty(input({ supportBounded: true, fast: true }));
    expect(r.byKey.surface_area.value).toBeNull();
    expect(r.byKey.surface_area.basis).toBe("none");
    expect(r.byKey.surface_area.uncertainty).toBeNull();
    expect(r.byKey.knuckle_circumference.upperBound).toBe(true);
    expect(r.notes.join(" ")).toMatch(/UPPER BOUND/);
  });

  it("no uncertainty when the gates failed or there is no scale reference; values keep their basis", () => {
    const r = measureWithUncertainty(input({ accepted: false, reasons: ["reprojection_mismatch"], fast: true }));
    expect(r.byKey.hand_length.value).not.toBeNull();
    expect(r.byKey.hand_length.uncertainty).toBeNull();
    expect(r.byKey.hand_length.uncertaintyNote).toMatch(/reprojection_mismatch/);
    const r2 = measureWithUncertainty(input({ capture: { ...BOARD_ROUTE_SIMULATED, scaleReference: "none" }, fast: true }));
    expect(r2.byKey.hand_length.uncertainty).toBeNull();
  });

  it("without a hand frame every value is withheld with the reason", () => {
    const r = measureWithUncertainty(input({ frame: null, fingers: [], measurements: null, fast: true }));
    for (const v of r.values) {
      expect(v.value).toBeNull();
      expect(v.basis).toBe("none");
      expect(v.uncertaintyNote).toMatch(/withheld/);
    }
    expect(FINGER_NAMES.every((f) => r.byKey[`finger_width_${f}_tip15`])).toBe(true);
  });

  it("the up axis is the support normal: an axis along it has no width", () => {
    const up: Vec3 = [0, 1, 0];
    const r = measureWithUncertainty(input({ up, fast: true }));
    expect(r.byKey.finger_width_middle_tip15.value).toBeNull();
    expect(r.byKey.finger_width_middle_tip15.basisNote).toMatch(/too steep/);
  });
});
