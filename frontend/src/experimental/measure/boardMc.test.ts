// SIMULATED: the Stage 5 measurement engine on the board route (multiview/reconstruct.ts) with the rendered capsule hand
// on the board (multiview/scene.ts, 17 views at 640 x 360: one from above, 16 at 12 degrees), EXACT hand masks, and the
// capsule hand's exact dimensions as truth. The analytic first-order budget is compared with a Monte Carlo that re-runs
// the whole reconstruction (triangulation, carving, meshing, gates, measurement) under drawn input errors.
// Nothing here is a real hand, a real phone, a real print or a real accuracy.
// Full study (per-factor and combined Monte Carlo, both input sets; about 10 minutes):
//   RUN_MEASURE_MC=1 npx vitest run --no-file-parallelism src/experimental/measure/boardMc.test.ts
import { describe, expect, it } from "vitest";
import { reconstructFromBoardViews, type BoardReconstruction } from "../multiview/reconstruct";
import { BOARD_HAND_PARAMS, projectLandmarks } from "../multiview/scene";
import { capture } from "../multiview/testFixtures";
import { FINGER_NAMES } from "../reconstruction/measure";
import { boardRouteRunner, type BoardMcScene } from "./boardMc";
import { poseDisplacementMm, reportingIncrement } from "./engine";
import { BOARD_ROUTE_SIMULATED, PHONE_BOARD_ASSUMED } from "./inputs";
import { NO_PERTURBATION, runMonteCarlo, type McResult } from "./monteCarlo";
import type { CaptureUncertainty, FactorKey, MeasurementReport } from "./types";

const FULL = !!process.env.RUN_MEASURE_MC;
const VOXEL = 1.5;
const c = capture();
const scene: BoardMcScene = { views: c.cameras.map((cam, i) => ({ id: cam.id, intrinsics: cam.intrinsics, pose: cam.pose, mask: c.renders[i].mask })), landmarks3d: c.scene.landmarks };

/** Exact dimensions of the capsule hand (the thumb width has none: the board scene clips the lifted thumb). */
function truthOf(): Record<string, number> {
  const T = c.scene.truth;
  const out: Record<string, number> = { hand_length: T.handLength, palm_breadth: T.palmBreadth, palm_thickness: T.palmThickness, knuckle_circumference: T.circumference };
  for (const f of FINGER_NAMES) out[`finger_length_${f}`] = T.fingerLengths[f];
  for (const f of ["index", "middle", "ring", "little"] as const) {
    out[`finger_width_${f}_tip15`] = 2 * BOARD_HAND_PARAMS.fingers[f].radius;
    out[`finger_width_${f}_base25`] = 2 * BOARD_HAND_PARAMS.fingers[f].radius;
  }
  return out;
}
const TRUTH = truthOf();

let nominalRec: BoardReconstruction | null = null;
const reports = new Map<string, MeasurementReport>();
function reportFor(cap: CaptureUncertainty): MeasurementReport {
  const hit = reports.get(cap.route);
  if (hit) return hit;
  const rec = reconstructFromBoardViews(
    scene.views.map((v, i) => ({ id: v.id, intrinsics: v.intrinsics, pose: v.pose, mask: v.mask, landmarks: projected[i] })),
    { voxelMm: VOXEL, uncertainty: cap },
  );
  if (!nominalRec) nominalRec = rec;
  reports.set(cap.route, rec.measurementReport!);
  return rec.measurementReport!;
}
const { runner, nViews } = boardRouteRunner(scene, { voxelMm: VOXEL });
let nominalValues: Record<string, number | null> | null = null;
const nominal = () => (nominalValues ??= runner(NO_PERTURBATION(nViews)));
// the landmarks the nominal run sees: exact projections (noise 0), as in the runner's unperturbed call
const projected = scene.views.map((v, i) => projectLandmarks(scene.landmarks3d, v.intrinsics, v.pose, { noisePx: 0, seed: 1 + i }));

const f2 = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
const s2 = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));

function valueTable(rep: MeasurementReport, mc: McResult | null, title: string): string {
  const head = `${title}\n| value | basis | value mm | truth mm | error mm | analytic u_c | dominant | MC sd | MC mean shift | MC 95 % of (value - nominal) | MC rms dev | increment (analytic u_c) | increment (MC rms) |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|`;
  const lines = rep.values.map((v) => {
    const s = mc?.stats[v.key];
    const t = TRUTH[v.key];
    return `| ${v.key} | ${v.basis}${v.upperBound ? " (upper bound)" : ""} | ${f2(v.value, 1)} | ${t === undefined ? "-" : t.toFixed(1)} | ${v.value !== null && t !== undefined ? s2(v.value - t, 1) : "-"} | ${f2(v.uncertainty?.standard)} | ${v.uncertainty?.dominant ?? "-"} | ${f2(s?.sd)} | ${s2(s?.meanShift)} | ${s ? `[${s2(s.p025)}, ${s2(s.p975)}]` : "-"} | ${f2(s?.rmsDev)} | ${v.reportingIncrementMm ?? "-"} | ${s && Number.isFinite(s.rmsDev) ? reportingIncrement(s.rmsDev) : "-"} |`;
  });
  return [head, ...lines].join("\n");
}

describe("SIMULATED board route: engine on the rendered capsule hand (exact masks, true poses)", () => {
  it("the hook adds a measurement report; values match the existing measurements; finger widths near the capsule diameters", () => {
    const rep = reportFor(BOARD_ROUTE_SIMULATED);
    const rec = nominalRec!;
    expect(rec.accepted).toBe(true);
    // additive: the existing measurements are unchanged and the report repeats them
    expect(rep.byKey.hand_length.value).toBe(rec.measurements!.handLength.value);
    expect(rep.byKey.knuckle_circumference.basis).toBe("model");
    expect(rep.byKey.knuckle_circumference.basisNote).toMatch(/UPPER BOUND/);
    expect(rep.byKey.surface_area.value).toBeNull();
    expect(rec.measurements!.surfaceArea.value).toBeNull();
    expect(rep.resolution!.medianMmPerPx).toBeGreaterThan(0.5);
    // the thumb's base point lies inside the palm outline: its base25 section is the palm, withheld
    expect(rep.byKey.finger_width_thumb_base25.value).toBeNull();
    expect(rep.byKey.finger_width_thumb_base25.basisNote).toMatch(/not finger-sized/);
    for (const f of ["index", "middle", "ring", "little"] as const) {
      const w = rep.byKey[`finger_width_${f}_tip15`];
      expect(w.value).not.toBeNull();
      expect(Math.abs(w.value! - TRUTH[`finger_width_${f}_tip15`])).toBeLessThan(3);
      expect(w.uncertainty!.standard).toBeGreaterThan(0.1);
    }
    console.log(
      valueTable(rep, null, `SIMULATED board route, ${nViews} views 640x360, voxel ${VOXEL} mm, exact masks, true poses; inputs ${rep.route}; mm/px at the hand median ${rep.resolution!.medianMmPerPx.toFixed(3)} (${rep.resolution!.minMmPerPx.toFixed(3)} to ${rep.resolution!.maxMmPerPx.toFixed(3)})`),
    );
    const comps = rep.values
      .filter((v) => v.uncertainty)
      .map((v) => `| ${v.key} | ${f2(v.uncertainty!.standard)} | ${v.uncertainty!.components.map((x) => f2(x.sigma, 3)).join(" | ")} |`);
    console.log([`SIMULATED analytic components (${rep.route})`, `| value | u_c | ${v0(rep).join(" | ")} |`, `|---|---|${v0(rep).map(() => "---").join("|")}|`, ...comps].join("\n"));
  }, 300_000);

  it("the 0.1 mm question: input sigma that ALONE would use a 0.1 mm standard uncertainty (first-order, linear)", () => {
    const rep = reportFor(BOARD_ROUTE_SIMULATED);
    const cap = rep.inputs;
    const mmpp = rep.resolution!.medianMmPerPx;
    const keys = ["hand_length", "finger_length_middle", "palm_breadth", "palm_thickness", "knuckle_circumference", "finger_width_middle_tip15", "finger_width_ring_base25"];
    const need = (key: string) => {
      const v = rep.byKey[key];
      const c = (f: string) => v.uncertainty!.components.find((x) => x.factor === f)!.sigma;
      const pd = poseDisplacementMm({ capture: cap, voxelMm: rep.voxelMm, mmPerPx: mmpp, distanceMm: rep.resolution!.medianDepthMm });
      return {
        focalPct: (100 * 0.1) / v.value!, // focal and scale: coefficient |V|
        boundaryPx: (cap.maskBoundaryPx.value * 0.1) / c("boundary"),
        poseDispMm: (pd * 0.1) / c("pose"),
        voxelMm: (rep.voxelMm * 0.1) / c("voxel"),
        landmarkMm: c("landmarks") > 0 ? (cap.landmark3dMm.value * 0.1) / c("landmarks") : Infinity,
      };
    };
    const rows = keys.map((k) => {
      const n = need(k);
      return `| ${k} | ${rep.byKey[k].uncertainty!.standard.toFixed(2)} | ${n.focalPct.toFixed(3)} % | ${n.boundaryPx.toFixed(3)} px (${(n.boundaryPx * mmpp).toFixed(3)} mm) | ${n.poseDispMm.toFixed(3)} mm | ${n.voxelMm.toFixed(2)} mm | ${Number.isFinite(n.landmarkMm) ? n.landmarkMm.toFixed(2) + " mm" : "-"} |`;
    });
    console.log(
      [
        `SIMULATED inverse budget at ${mmpp.toFixed(3)} mm/px (median, carving masks): each column is the input sigma that alone gives a 0.1 mm standard uncertainty (a 0.1 mm increment needs the COMBINED u_c below 0.2 mm). Present inputs: focal ${(cap.focalRel.value * 100).toFixed(2)} %, boundary ${cap.maskBoundaryPx.value} px, pose displacement ${poseDisplacementMm({ capture: cap, voxelMm: rep.voxelMm, mmPerPx: mmpp, distanceMm: rep.resolution!.medianDepthMm }).toFixed(2)} mm, voxel ${rep.voxelMm} mm, landmarks ${cap.landmark3dMm.value} mm`,
        "| value | u_c now | focal or scale | mask boundary | pose (per-view displacement) | voxel | 3D landmarks |",
        "|---|---|---|---|---|---|---|",
        ...rows,
      ].join("\n"),
    );
    // no value supports a 0.1 mm increment with these SIMULATED inputs
    for (const v of rep.values) if (v.uncertainty) expect(v.reportingIncrementMm!).toBeGreaterThan(0.1);
  }, 300_000);

  it("Monte Carlo smoke: the perturbed pipeline runs and returns values (2 trials, all factors)", () => {
    const nom = nominal();
    expect(nom.hand_length).not.toBeNull();
    const mc = runMonteCarlo(BOARD_ROUTE_SIMULATED, nViews, VOXEL, nom, runner, { trials: 2, seed: 7, factors: ["focal", "pose", "boundary", "landmarks", "voxel"] });
    expect(mc.stats.hand_length.n).toBe(2);
    expect(Math.abs(mc.stats.hand_length.meanShift)).toBeLessThan(10);
  }, 300_000);

  it.skipIf(!FULL)("FULL: per-factor and combined Monte Carlo vs the analytic budget (board route SIMULATED inputs)", () => {
    const rep = reportFor(BOARD_ROUTE_SIMULATED);
    const nom = nominal();
    const per: Partial<Record<FactorKey, McResult>> = {};
    for (const f of ["focal", "pose", "boundary", "landmarks", "voxel"] as FactorKey[]) per[f] = runMonteCarlo(BOARD_ROUTE_SIMULATED, nViews, VOXEL, nom, runner, { trials: 10, seed: 11, factors: [f] });
    const comb = runMonteCarlo(BOARD_ROUTE_SIMULATED, nViews, VOXEL, nom, runner, { trials: 30, seed: 13, factors: ["focal", "pose", "boundary", "landmarks", "voxel"] });
    console.log(valueTable(rep, comb, `SIMULATED combined Monte Carlo, ${comb.trials} trials (${(comb.ms / 1000).toFixed(0)} s), accepted share ${f2(comb.acceptedShare)}; inputs ${rep.route}`));
    const fs = ["focal", "pose", "boundary", "landmarks", "voxel"] as FactorKey[];
    const lines = rep.values
      .filter((v) => v.uncertainty)
      .map((v) => `| ${v.key} | ${fs.map((f) => `${f2(v.uncertainty!.components.find((x) => x.factor === f)!.sigma)} / ${f2(per[f]!.stats[v.key]?.sd)} (${s2(per[f]!.stats[v.key]?.meanShift)})`).join(" | ")} |`);
    console.log(
      [
        `SIMULATED per factor: analytic component / MC sd (MC mean shift), 10 trials each; accepted share ${fs.map((f) => `${f} ${f2(per[f]!.acceptedShare)}`).join(", ")}`,
        `| value | ${fs.join(" | ")} |`,
        `|---|${fs.map(() => "---").join("|")}|`,
        ...lines,
      ].join("\n"),
    );
    expect(comb.stats.hand_length.n).toBeGreaterThan(20);
  }, 1_800_000);

  it.skipIf(!FULL)("FULL: combined Monte Carlo with the ASSUMED phone-condition inputs", () => {
    const rep = reportFor(PHONE_BOARD_ASSUMED);
    const nom = nominal();
    const comb = runMonteCarlo(PHONE_BOARD_ASSUMED, nViews, VOXEL, nom, runner, { trials: 20, seed: 17, factors: ["focal", "pose", "scale", "boundary", "landmarks", "voxel"] });
    console.log(valueTable(rep, comb, `SIMULATED scene, ASSUMED inputs: combined Monte Carlo, ${comb.trials} trials (${(comb.ms / 1000).toFixed(0)} s), accepted share ${f2(comb.acceptedShare)}; inputs ${rep.route}`));
    const comps = rep.values
      .filter((v) => v.uncertainty)
      .map((v) => `| ${v.key} | ${f2(v.uncertainty!.standard)} | ${v.uncertainty!.components.map((x) => f2(x.sigma, 3)).join(" | ")} |`);
    console.log([`analytic components (${rep.route})`, `| value | u_c | ${v0(rep).join(" | ")} |`, `|---|---|${v0(rep).map(() => "---").join("|")}|`, ...comps].join("\n"));
    expect(comb.stats.hand_length.n).toBeGreaterThan(10);
  }, 1_800_000);
});

function v0(rep: MeasurementReport): string[] {
  return rep.values.find((v) => v.uncertainty)?.uncertainty!.components.map((x) => x.factor) ?? [];
}
