// SIMULATED end to end: rendered photos of the capsule hand on the board -> known-board segmentation (NOT the exact
// masks) -> landmark triangulation with the hand-moved check -> board-frame carving -> labelled mesh -> measurements,
// compared with the capsule hand's exact dimensions. Camera intrinsics and poses are the TRUE ones (or deliberately
// perturbed ones): estimating them from the markers is built elsewhere. Nothing here is a real-hand accuracy.
// Full grid (25 views, pose errors, skin tones, a skin-coloured table, voxel sizes):
//   RUN_MULTIVIEW_E2E=1 npx vitest run --no-file-parallelism src/experimental/multiview/endToEnd.test.ts
import { describe, expect, it } from "vitest";
import { FINGER_NAMES } from "../reconstruction/measure";
import { boardVolume, reconstructFromBoardViews, type BoardReconstruction, type BoardReconstructOptions, type BoardViewInput } from "./reconstruct";
import { referenceAreasInVolume, SKIN_TONES } from "./scene";
import { boardViews, capture, type Capture } from "./testFixtures";

const FULL = !!process.env.RUN_MULTIVIEW_E2E;

interface Row {
  label: string;
  rec: BoardReconstruction;
  wallMs: number;
  rssMb: number;
  heapMb: number;
}

const rows: Row[] = [];

function run(label: string, c: Capture, views: BoardViewInput[], voxelMm = 1.5, extra: Partial<BoardReconstructOptions> = {}): BoardReconstruction {
  const t0 = performance.now();
  const rec = reconstructFromBoardViews(views, { voxelMm, ignoreGate: true, ...extra });
  const wallMs = performance.now() - t0;
  const mu = process.memoryUsage();
  rows.push({ label, rec, wallMs, rssMb: mu.rss / 2 ** 20, heapMb: mu.heapUsed / 2 ** 20 });
  void c;
  return rec;
}

const f1 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(1));

function errors(c: Capture, r: BoardReconstruction) {
  const T = c.scene.truth;
  const m = r.measurements;
  const e = (v: number | null | undefined, t: number) => (v === null || v === undefined ? null : v - t);
  return {
    handLength: e(m?.handLength.value, T.handLength),
    palmBreadth: e(m?.palmBreadth.value, T.palmBreadth),
    palmThickness: e(m?.palmThickness.value, T.palmThickness),
    circumference: e(m?.circumferenceKnuckle.value, T.circumference),
    fingers: Object.fromEntries(FINGER_NAMES.map((f) => [f, e(m?.fingerLengths[f].value, T.fingerLengths[f])])) as Record<string, number | null>,
  };
}

function report(c: Capture): string {
  const ref = referenceAreasInVolume(c.scene, boardVolume());
  const head =
    "| scenario | accepted (reasons) | length | breadth | thickness | knuckle circ. | thumb | index | middle | ring | little | free area vs exact | views named by the hand-moved check | landmark RMS px (median view) | total s | rss MB |";
  const lines = rows.map(({ label, rec, wallMs, rssMb }) => {
    const e = errors(c, rec);
    const area = rec.freeSurfaceAreaMm2 === null ? "n/a" : `${f1(rec.freeSurfaceAreaMm2 - ref.freeMm2)} mm2 (${f1((100 * (rec.freeSurfaceAreaMm2 - ref.freeMm2)) / ref.freeMm2)} %)`;
    const lmRms = rec.landmarks ? median(rec.landmarks.views.map((v) => v.rmsPx).filter((x): x is number => x !== null)) : null;
    return `| ${label} | ${rec.accepted ? "yes" : "no"}${rec.reasons.length ? ` (${rec.reasons.join(", ")})` : ""} | ${f1(e.handLength)} | ${f1(e.palmBreadth)} | ${f1(e.palmThickness)} | ${f1(e.circumference)} | ${FINGER_NAMES.map((f) => f1(e.fingers[f])).join(" | ")} | ${area} | ${rec.landmarks?.disagreeingViews.join(", ") || "none"} | ${lmRms?.toFixed(2) ?? "n/a"} | ${(wallMs / 1000).toFixed(1)} | ${rssMb.toFixed(0)} |`;
  });
  const timing = rows.map(({ label, rec }) => {
    const t = rec.timingsMs;
    return `| ${label} | ${rec.views.length} | ${(t.segment / 1000).toFixed(1)} | ${t.triangulate.toFixed(0)} | ${t.carve.toFixed(0)} | ${t.mesh.toFixed(0)} | ${t.quality.toFixed(0)} | ${t.measure.toFixed(0)} | ${(t.total / 1000).toFixed(1)} |`;
  });
  return [
    `SIMULATED errors (estimate minus exact, mm); exact free surface ${ref.freeMm2.toFixed(0)} mm2 (closed ${ref.closedMm2.toFixed(0)} mm2):`,
    head,
    "|" + "---|".repeat(16),
    ...lines,
    "",
    "| scenario | views | segment s | triangulate ms | carve ms | mesh ms | gates ms | measure ms | total s |",
    "|---|---|---|---|---|---|---|---|---|",
    ...timing,
  ].join("\n");
}

function median(a: number[]): number | null {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}

describe("SIMULATED end-to-end board reconstruction", () => {
  const c17 = capture({});

  it("top + 16 views at 12 deg, segmented masks, true poses: accepted, mm-level agreement with the exact capsule hand", () => {
    const r = run("17 views (top + 16 at 12 deg), true poses", c17, boardViews(c17));
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(true);
    expect(r.landmarks!.disagreeingViews).toEqual([]);
    const e = errors(c17, r);
    expect(Math.abs(e.handLength!)).toBeLessThan(2);
    expect(Math.abs(e.palmBreadth!)).toBeLessThan(3);
    expect(Math.abs(e.palmThickness!)).toBeLessThan(4);
    expect(Math.abs(e.circumference!)).toBeLessThan(6);
    for (const f of FINGER_NAMES) expect(Math.abs(e.fingers[f]!)).toBeLessThan(3);
    // labelled, never filled: the palm side lies on the board plane, the forearm end is cut
    expect(r.supportShare!.support_plane).toBeGreaterThan(0.1);
    expect(r.supportShare!.volume_cut).toBeGreaterThan(0.01);
    expect(r.supportShare!.truncated).toBe(0);
    expect(r.pointCloud!.points.length / 3).toBe(r.support!.length);
    expect(r.measurements!.handLength.basis).toBe("model");
  }, 600_000);

  it("the hand moved 5 mm in one view: the check names that view, it is left out, the rest still reconstructs", () => {
    const moved = 5;
    const r = run(`17 views, hand moved 5 mm in view ${c17.cameras[moved].id}`, c17, boardViews(c17, { moved: { index: moved, offset: [5, 0, 0] } }));
    expect(r.landmarks!.disagreeingViews).toEqual([c17.cameras[moved].id]);
    expect(r.views[moved].used).toBe(false);
    expect(r.reasons).toContain("views_disagree");
    const e = errors(c17, r);
    expect(Math.abs(e.handLength!)).toBeLessThan(2);
    expect(Math.abs(e.palmThickness!)).toBeLessThan(4);
  }, 600_000);

  const grid: [string, () => void][] = [
    ["25 views", () => {
      const c25 = capture({ highCount: 8 });
      run("25 views (+8 at 35 deg), true poses", c25, boardViews(c25));
    }],
    ...([[0.5, 1], [0.5, 2], [1, 1], [1, 2]] as const).map(([deg, mm]) => [`pose ${deg}/${mm}`, () => void run(`17 views, pose error ${deg} deg / ${mm} mm`, c17, boardViews(c17, { poseRotDeg: deg, poseTransMm: mm }))] as [string, () => void]),
    ["pose 1/2 tolerance 1", () => void run("17 views, pose error 1 deg / 2 mm, carving tolerance 1", c17, boardViews(c17, { poseRotDeg: 1, poseTransMm: 2 }), 1.5, { tolerance: 1 })],
    ...(["light", "veryDark"] as const).map((skin) => [`${skin} skin`, () => {
      const cs = capture({ skin });
      run(`17 views, ${skin} skin`, cs, boardViews(cs));
    }] as [string, () => void]),
    ["skin-coloured table", () => {
      const ct = capture({ table: SKIN_TONES.medium });
      run("17 views, skin-coloured table", ct, boardViews(ct));
    }],
    ["voxel 1.0", () => void run("17 views, voxel 1.0 mm", c17, boardViews(c17), 1.0)],
    ["voxel 2.0", () => void run("17 views, voxel 2.0 mm", c17, boardViews(c17), 2.0)],
  ];
  for (const [name, fn] of grid) it.runIf(FULL)(`full SIMULATED grid: ${name}`, fn, 600_000);

  it("report", () => {
    console.log(report(c17));
    expect(rows.length).toBeGreaterThan(0);
  });
});
