// SIMULATED sensitivity study of the coin scale (sensitivity.ts). A small subset runs by default with assertions on its
// direction of effect; the whole study (the README tables) runs with COIN_STUDY=full and prints markdown:
//   COIN_STUDY=full npx vitest run --no-file-parallelism src/experimental/coin/sensitivity.test.ts
// Nothing here is real-world accuracy.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import type { CoinDetectionParams } from "../../api/types";
import { initOpenCV, type CV } from "../../vision/opencv";
import { intrinsicsFromHfov, lookAt, project } from "../geometry/camera";
import { coinReferenceFromConfig } from "./measureCoin";
import { BASELINE, globalScaleErrorTable, runScenario, runSensitivityStudy, sensitivityTable, studyScenarios, tiltedViewErrorMap } from "./sensitivity";

const cfg = JSON.parse(readFileSync(new URL("../../../../config/measurement.json", import.meta.url), "utf-8"));
const refsJson = JSON.parse(readFileSync(new URL("../../../../config/reference_objects.json", import.meta.url), "utf-8"));
const params = cfg.coin_detection as CoinDetectionParams;
const ref = coinReferenceFromConfig(refsJson, "inr_2_2019", cfg.calibration.custom_reference_thickness_mm);
const FULL = process.env.COIN_STUDY === "full";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCV(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 60_000);

describe("coin sensitivity (SIMULATED)", () => {
  it("has one scenario per varied factor, all derived from the baseline", () => {
    const sc = studyScenarios();
    const groups = new Set(sc.map((s) => s.group));
    for (const g of ["baseline", "position", "tilt", "distance", "resolution", "blur", "noise", "glare", "occlusion", "surface", "shadow"]) expect(groups.has(g), g).toBe(true);
    expect(sc.some((s) => s.width === 4000 && s.height === 3000)).toBe(true);
    expect(sc.filter((s) => s.group === "distance").map((s) => s.distanceMm)).toEqual([200, 400, 500]);
  });

  it("near the corner the plain D / major is several % off while the 3D outline fit with known intrinsics is within 0.6 %", () => {
    const row = runScenario(cv, { ...BASELINE, position: [0.85, 0.85], group: "t", name: "corner" }, params, ref, 1);
    expect(row.errRefined).toBeLessThan(-2.5);
    expect(Math.abs(row.errFit3D)).toBeLessThan(0.6);
    expect(Math.abs(row.errSupport)).toBeLessThan(0.6);
  }, 60_000);

  it("on white paper with a contact shadow the edge moves outward (scale too small by more than 1 %); without the shadow it does not", () => {
    const withShadow = runScenario(cv, { ...BASELINE, surface: "paper", group: "t", name: "paper" }, params, ref, 1);
    const without = runScenario(cv, { ...BASELINE, surface: "paper", shadow: false, group: "t", name: "paper" }, params, ref, 1);
    expect(withShadow.errRefined).toBeLessThan(-1);
    expect(Math.abs(without.errRefined)).toBeLessThan(0.5);
  }, 60_000);

  it.runIf(FULL)(
    "full study (prints the README table)",
    () => {
      const rows = runSensitivityStudy(cv, params, ref, { seeds: Number(process.env.COIN_SEEDS ?? 3) });
      console.log(sensitivityTable(rows));
      expect(rows.length).toBe(studyScenarios().length);
    },
    1_800_000,
  );
});

describe("one global pixels-per-mm ratio for a 3D hand (pinhole maths)", () => {
  it("the formula Z / (Z - dz) - 1 matches projected pixels", () => {
    const K = intrinsicsFromHfov(1280, 720, 69.4);
    const Z = 300;
    const pose = lookAt([0, 0, Z], [0, 0, 0], [0, 1, 0]);
    const coinPxPerMm = K.fx / Z;
    for (const dz of [20, 40]) {
      const a = project(K, pose, [-40, 0, dz])!, b = project(K, pose, [40, 0, dz])!;
      const measured = Math.hypot(b.x - a.x, b.y - a.y) / coinPxPerMm;
      const cell = globalScaleErrorTable([Z], [dz], { L: 80 })[0];
      expect(measured / 80 - 1).toBeCloseTo(cell.rel, 9);
      expect(cell.mmFor.L).toBeCloseTo(80 * cell.rel, 9);
    }
  });

  it("the back of the hand 20 to 40 mm above a coin on the table reads 4 to 25 % too large between 500 and 200 mm", () => {
    const t = globalScaleErrorTable([200, 300, 500], [20, 40], { breadth: 85 });
    const at = (Z: number, dz: number) => t.find((c) => c.distanceMm === Z && c.heightMm === dz)!.rel;
    expect(at(500, 20)).toBeCloseTo(20 / 480, 9);
    expect(at(300, 20)).toBeGreaterThan(0.06);
    expect(at(200, 40)).toBeCloseTo(0.25, 9);
    if (FULL) console.log(JSON.stringify(globalScaleErrorTable([200, 300, 400, 500], [-20, -10, 5, 10, 20, 30, 40], { "85 mm breadth": 85, "190 mm length": 190, "18 mm finger width": 18 }).map((c) => [c.distanceMm, c.heightMm, +(100 * c.rel).toFixed(2), Object.values(c.mmFor).map((v) => +v.toFixed(2))])));
  });

  it("even on the table plane a tilted view changes the scale across the hand", () => {
    const m = tiltedViewErrorMap(300, 45, [-100, 0, 100], [0]);
    const at = (x: number, y: number) => m.find((c) => c.x === x && c.y === y)!.rel;
    expect(at(0, 0)).toBeCloseTo(0, 12);
    expect(at(0, 100)).toBeLessThan(-0.1); // farther from the camera: the coin's ratio reads too small there
    expect(at(0, -100)).toBeGreaterThan(0.1);
    const overhead = tiltedViewErrorMap(300, 90, [-100, 0, 100], [0]);
    expect(Math.max(...overhead.map((c) => Math.abs(c.rel)))).toBeLessThan(1e-9); // straight down: the table is one depth
    if (FULL) {
      for (const [el, dz] of [
        [90, 30],
        [60, 0],
        [60, 30],
        [45, 0],
      ])
        console.log(el, dz, JSON.stringify(tiltedViewErrorMap(300, el, [-100, -50, 0, 50, 100], [dz]).map((c) => [c.x, c.y, +(100 * c.rel).toFixed(1)])));
    }
  });
});
