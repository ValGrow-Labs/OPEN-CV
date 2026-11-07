// The synthetic experiment runner. A small, fast subset runs by default; the full grid (about a minute) runs when
// RUN_SYNTHETIC_GRID=1 is set and prints the table that README.md quotes. Everything here is SYNTHETIC.
import { describe, expect, it } from "vitest";
import { EIGHT_VIEWS, FOUR_VIEWS } from "./synthetic";
import { formatGridTable, metricStats, METRICS, runRepeatability, runScenario, syntheticGridScenarios, truthOf, type ScenarioResult } from "./experiment";
import { makeCapsuleHand } from "./synthetic";

const cfg = { voxelMm: 2, imageSize: 192 } as const;

describe("the synthetic experiment runner", () => {
  it("a clean eight-view scenario passes the gates and reports small signed errors for every metric", () => {
    const r = runScenario({ label: "8 views, clean", views: EIGHT_VIEWS, noise: {} }, cfg);
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(true);
    for (const m of METRICS) expect(r.errors[m]).not.toBeNull();
    expect(Math.abs(r.errors.handLength!)).toBeLessThan(1.5);
    for (const f of ["thumb", "index", "middle", "ring", "little"] as const) expect(Math.abs(r.errors[f]!)).toBeLessThan(2);
    // the area error is within a few per cent of the reference area
    const truth = truthOf(makeCapsuleHand());
    expect(Math.abs(r.errors.surfaceArea!) / truth.surfaceArea).toBeLessThan(0.06);
    expect(r.meshCompleteness).toBeGreaterThan(0.8);
  }, 120000);

  it("a scenario whose views cannot support a mesh says why and withholds nothing it should not", () => {
    const r = runScenario({ label: "2 views", views: ["palm", "back"], noise: {} }, { ...cfg, voxelMm: 3 });
    expect(r.accepted).toBe(false);
    expect(r.reasons).toContain("too_few_views");
  }, 120000);

  it("the table is labelled SYNTHETIC and prints one row per scenario", () => {
    const rows = [runScenario({ label: "4 views", views: FOUR_VIEWS, noise: {} }, { ...cfg, voxelMm: 3 })];
    const table = formatGridTable(rows);
    expect(table).toMatch(/^SYNTHETIC results/);
    expect(table.split("\n").filter((l) => l.startsWith("| 4 views"))).toHaveLength(1);
  }, 120000);

  it("repeating a noisy reconstruction gives a small spread, and reports the bias separately", () => {
    const rows = runRepeatability({ label: "8 views, 1 px edge noise", views: EIGHT_VIEWS, noise: { jitterPx: 1 } }, 3, cfg);
    const len = rows.find((r) => r.metric === "handLength")!;
    expect(len.repeats).toBe(3);
    expect(len.sd).toBeLessThan(1.5);
    expect(Number.isFinite(len.bias)).toBe(true);
    expect(rows).toHaveLength(METRICS.length);
  }, 180000);

  it("metricStats summarises the signed errors of a set of results", () => {
    const r1 = runScenario({ label: "a", views: FOUR_VIEWS, noise: {} }, { ...cfg, voxelMm: 3 });
    const s = metricStats([r1, r1], "handLength")!;
    expect(s.n).toBe(2);
    expect(s.mae).toBeCloseTo(Math.abs(r1.errors.handLength!), 9);
  }, 120000);
});

// The full grid, opt in with RUN_SYNTHETIC_GRID=1: one test per scenario (so the test runner is never blocked for long),
// then one that prints the table README.md quotes.
describe.skipIf(!process.env.RUN_SYNTHETIC_GRID)("the full SYNTHETIC grid (opt in)", () => {
  const rows: ScenarioResult[] = [];
  for (const sc of syntheticGridScenarios()) it(sc.label, () => void rows.push(runScenario(sc)), 120000);
  it("prints the table", () => {
    console.log(formatGridTable(rows));
    expect(rows.length).toBe(syntheticGridScenarios().length);
  });
});
