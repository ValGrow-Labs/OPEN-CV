// A SYNTHETIC reference built from the exact dimensions of the simulated capsule hand (multiview/scene.ts truth), for the
// round-trip TEST only. Its phantom id starts with "synthetic", so the report refuses it unless --test is passed, and
// labels such output SYNTHETIC TEST. Its "readings" are the exact design values repeated: no person measured anything.
import type { BoardScene } from "../multiview/scene";
import { capsuleExactDimensions } from "./meshDimensions";
import { REFERENCE_SCHEMA, type DimensionRecord, type ReferenceFile } from "./reference";
import { dimensionSpec } from "./dimensions";

export const SYNTHETIC_PHANTOM_ID = "synthetic-capsule-board-hand";

export function syntheticReference(scene: BoardScene): ReferenceFile {
  const t = scene.truth;
  const exact: Record<string, number> = {
    hand_length: t.handLength,
    palm_breadth: t.palmBreadth,
    palm_thickness: t.palmThickness,
    circumference_knuckle: t.circumference,
    ...Object.fromEntries((["thumb", "index", "middle", "ring", "little"] as const).map((f) => [`finger_length_${f}`, t.fingerLengths[f]])),
    ...capsuleExactDimensions(scene.hand.params),
  };
  const dimensions: DimensionRecord[] = Object.entries(exact).map(([name, v]) => ({
    name,
    definition: `${dimensionSpec(name)?.definition ?? name} [SYNTHETIC: exact value of the capsule hand]`,
    instrument: dimensionSpec(name)?.instrument === "tape" ? "synthetic-tape" : "synthetic-caliper",
    readings: ["S1", "S1", "S2", "S2"].map((measurer) => ({ measurer, value_mm: v })),
  }));
  return {
    schema: REFERENCE_SCHEMA,
    phantom: { id: SYNTHETIC_PHANTOM_ID, description: "SYNTHETIC capsule hand of the simulated board scene (exact dimensions; no physical object)", cad_file: null, print_scanned: false },
    date: "2026-11-08",
    units: "mm",
    instruments: [
      { id: "synthetic-caliper", type: "caliper", model: "SYNTHETIC (exact)", resolution_mm: 0.001, calibration_check: { reference: "gauge_block", nominal_mm: 100, reading_mm: 100 } },
      { id: "synthetic-tape", type: "tape", model: "SYNTHETIC (exact)", resolution_mm: 0.001, calibration_check: { reference: "steel_rule", nominal_mm: 100, reading_mm: 100 } },
    ],
    measurers: [{ code: "S1" }, { code: "S2" }],
    protocol: { min_readings_per_measurer: 2, spread_tolerance_mm: 0.5, agreed_value: "mean", second_measurer: "all" },
    dimensions,
    notes: "SYNTHETIC TEST reference: exact values of a simulated shape. Not a measurement.",
  };
}
