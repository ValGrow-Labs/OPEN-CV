// SIMULATED ROUND TRIP of the validation tooling. Rendered photos of the synthetic capsule hand on the printed board
// (multiview/scene.ts) go through the real chain (recon/chain.ts), the page's real export (recon/page/exportZip.ts, ZIP,
// PLY), this tool's reader, comparison and report, against a reference built from the scene's EXACT dimensions
// (syntheticReference.ts, phantom id "synthetic-..."). The report is printed to the TEST OUTPUT only; no file is written,
// and nothing here goes to docs/hand3d-research/validation/physical/.
// It proves the pieces fit and the bookkeeping is right on clean renders. It is NOT a physical result and NOT an accuracy.
import { describe, expect, it } from "vitest";
import type { Pt } from "../common";
import { flatnessOfCameras } from "../recon/boardFlatness";
import { reconstructFromImages, type ChainResult, type ImageView } from "../recon/chain";
import { expectedRuler, rulerCheck } from "../recon/page/boardCheck";
import { binOf } from "../recon/page/coverage";
import { buildExportZip, type ExportInput } from "../recon/page/exportZip";
import type { Capture } from "../recon/page/types";
import { boardRig, makeBoardScene, projectLandmarks, renderView, SKIN_TONES } from "../multiview/scene";
import { compareCaptures } from "./compare";
import { aggregateDevices } from "./device";
import { parseCaptureZip, type CaptureRecord } from "./exportModel";
import { capsuleExactDimensions, CLOSED_GAP_NOTE } from "./meshDimensions";
import { phantomMeshFromScene } from "./phantomMesh";
import { checkReference } from "./reference";
import { renderReport, SyntheticReferenceRefused } from "./report";
import { surfaceDistance } from "./surfaceDistance";
import { SYNTHETIC_PHANTOM_ID, syntheticReference } from "./syntheticReference";

const scene = makeBoardScene();
const cams = boardRig(scene, { width: 1280, height: 720, hfovDeg: 64, k1: -0.06, k2: 0.02, lowCount: 16, highCount: 0 });
const images = cams.map((c, i) => renderView(scene, c.intrinsics, c.pose, { skin: SKIN_TONES.medium, seed: i + 1 }).image);

async function simulatedExport(index: number, seedBase: number): Promise<{ zip: Uint8Array; chain: ChainResult }> {
  const views: ImageView[] = cams.map((c, i) => ({ id: c.id, image: images[i], landmarks: projectLandmarks(scene.landmarks, c.intrinsics, c.pose, { noisePx: 2, seed: seedBase + i }) }));
  const chain = reconstructFromImages(views, { reconstruct: { voxelMm: 1.5 } });
  const captures: Capture[] = cams.map((c, i) => ({
    id: c.id,
    bin: binOf(c.elevationDeg, c.azimuthDeg ?? 0) ?? "top",
    width: images[i].width,
    height: images[i].height,
    pixels: images[i].data as Uint8ClampedArray,
    landmarks: views[i].landmarks as Pt[],
    handedness: null,
    markerCorners: [],
    markers: chain.cameras?.views[i].markers ?? 0,
    elevationDeg: c.elevationDeg,
    azimuthDeg: c.azimuthDeg ?? 0,
    sharpness: null,
    trigger: "auto",
    capturedAt: "2026-11-08T10:00:00.000Z",
    thumb: null,
  }));
  const e = expectedRuler();
  const input: ExportInput = {
    outcome: { chain, coin: null, timingsMs: { chain: chain.timingsMs.total, coin: 0, total: chain.timingsMs.total } },
    captures,
    includePhotos: false,
    coin: null,
    coinLabel: "none (SIMULATED)",
    createdAt: "2026-11-08T10:00:00.000Z",
    environment: { userAgent: "SIMULATED (vitest)", heapMb: null, page: "experiment/recon (SIMULATED)" },
    validationMode: true,
    run: { phantomId: SYNTHETIC_PHANTOM_ID, sessionId: "SIM-S1", captureIndex: index, operatorCode: "SIM1", conditions: ["baseline"], notes: "SIMULATED round trip" },
    // the simulated board is printed at exactly 100 %: its ruler readings are the layout's own values
    ruler: rulerCheck({ squareXmm: e.square_mm, squareYmm: e.square_mm, longSpanMm: e.long_span_mm, shortSpanMm: e.short_span_mm }),
    checklist: { matte: true, flat: true, noGlare: true },
    flatness: flatnessOfCameras(chain.cameras),
  };
  return { zip: await buildExportZip(input), chain };
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);

describe("SIMULATED round trip: page export -> validation report (synthetic reference, --test only)", () => {
  it("reads the real export, maps and compares like for like, measures widths and gaps, and refuses a physical report", async () => {
    const a = await simulatedExport(1, 100);
    const b = await simulatedExport(2, 300);
    const records: CaptureRecord[] = [parseCaptureZip("SIM-1.zip", a.zip), parseCaptureZip("SIM-2.zip", b.zip)];
    for (const r of records) {
      expect(r.problems).toEqual([]);
      expect(r.mesh?.supportLabels).toEqual(["observed", "implied", "support_plane", "volume_cut", "truncated"]);
      expect(r.handFrame?.source).toBe("triangulated");
      expect(r.fingerAxes?.length).toBe(5);
      expect(r.run?.phantomId).toBe(SYNTHETIC_PHANTOM_ID);
    }
    const check = checkReference(syntheticReference(scene));
    expect(check.reasons).toEqual([]);
    expect(check.synthetic).toBe(true);
    const cmp = compareCaptures(records, check.reference!);
    const exact = capsuleExactDimensions(scene.hand.params);

    const lines = cmp.dimensions.map((d) => `  ${d.dimension.padEnd(28)} ${d.relation === "like_for_like" ? "like-for-like     " : "definition differs"} ref ${d.reference.agreedMm.toFixed(2).padStart(7)}  errors ${d.errors.map((x) => fmt(x.errorMm)).join(", ") || "none"}${d.missingReasons.length ? `  missing: ${d.missingReasons[0].reason.slice(0, 90)}` : ""}`);
    console.log([`SIMULATED round trip (synthetic capsule hand, ${cams.length} rendered views, 2 captures differing only in landmark noise):`, `  status ${cmp.captures.map((c) => `${c.name} ${c.status}${c.reasons.length ? ` [${c.reasons.join("; ")}]` : ""}`).join(", ")}`, ...lines].join("\n"));

    expect(cmp.captures.map((c) => c.status)).toEqual(["accepted", "accepted"]);
    const err = (name: string) => cmp.dimensions.find((d) => d.dimension === name)!;
    // the chain test's own bounds on the same renders
    for (const e of err("hand_length").errors) expect(Math.abs(e.errorMm)).toBeLessThan(3);
    for (const e of err("knuckle_section_width").errors) expect(Math.abs(e.errorMm)).toBeLessThan(3);
    for (const e of err("knuckle_section_height").errors) expect(Math.abs(e.errorMm)).toBeLessThan(5);
    // finger widths 15 mm from the tip: 2 r of the capsule where the section is separable
    for (const f of ["index", "middle", "ring", "little"]) {
      const d = err(`finger_width_${f}_at_15mm`);
      expect(d.reference.agreedMm).toBeCloseTo(exact[`finger_width_${f}_at_15mm`], 6);
      for (const e of d.errors) expect(Math.abs(e.errorMm)).toBeLessThan(3);
      // heights: the capsule finger floats (12 - r) mm above the board; if no view looked under it the hull would be
      // filled down to the board and the error would be about +(12 - r); whichever happens is reported, not hidden
      const h = err(`finger_height_${f}_at_15mm`);
      for (const e of h.errors) expect(e.errorMm).toBeGreaterThan(-3);
      for (const e of h.errors) expect(e.errorMm).toBeLessThan(12 - scene.hand.params.fingers[f as "index"].radius + 3);
    }
    // gaps: either a measured clearance near the exact value, or 0 with the "closed" note
    for (const g of ["index_middle", "middle_ring", "ring_little"]) {
      const d = err(`finger_gap_${g}`);
      expect(d.reference.agreedMm).toBeGreaterThan(5);
      for (const c of cmp.captures) {
        const v = c.values[`finger_gap_${g}`];
        expect(v.value === null || v.value === 0 ? v.note.includes(CLOSED_GAP_NOTE) || v.missing !== null : Math.abs(v.value - d.reference.agreedMm) < 3).toBe(true);
      }
    }
    // the thumb has no exact value: not in the synthetic reference, so not compared
    expect(cmp.notInReference).toEqual(expect.arrayContaining(["finger_width_thumb_at_15mm", "finger_gap_thumb_index"]));

    // surface distance against the exact phantom solid (above the board, cut at the volume's open edge x = 0), in the
    // known board frame (fixed identity: the scene IS in board millimetres)
    const refMesh = phantomMeshFromScene(scene, { voxelMm: 1, cutX: 0 });
    const s = surfaceDistance({ reconstruction: records[0].mesh!, reference: refMesh, referenceKind: "cad_nominal", transform: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] } });
    console.log(
      `SIMULATED surface distance (capture 1 vs the exact capsule solid, fixed frame): recon->ref observed+implied n ${s.meshToReference.n}, mean ${s.meshToReference.meanMm?.toFixed(2)}, RMS ${s.meshToReference.rmsMm?.toFixed(2)}, p95 ${s.meshToReference.p95Mm?.toFixed(2)}, max ${s.meshToReference.maxMm?.toFixed(2)}, signed ${fmt(s.meshToReference.signedMeanMm)} mm; ` +
        `per label ${Object.entries(s.perLabel).map(([k, v]) => `${k} ${v.meanMm?.toFixed(2)}`).join(", ")}; ref->recon mean ${s.referenceToMesh.meanMm?.toFixed(2)}, Hausdorff ${s.hausdorffMm?.toFixed(2)} mm, coverage ${((s.coverage.share ?? 0) * 100).toFixed(1)} % within 2 mm (excluded: base ${s.coverage.baseAreaExcludedMm2.toFixed(0)} mm2, facing the cut ${s.coverage.cutAreaExcludedMm2.toFixed(0)} mm2)`,
    );
    expect(s.ok).toBe(true);
    expect(s.meshToReference.medianMm!).toBeLessThan(2);
    expect(s.meshToReference.signedMeanMm!).toBeGreaterThan(-0.5); // a visual hull lies on or outside the solid

    // the report: refused as physical, labelled SYNTHETIC TEST otherwise; printed here, never written to the docs
    const input = { referenceCheck: check, referenceSource: "syntheticReference(scene)", capturesSource: "SIMULATED", captureFiles: 2, comparison: cmp, surfaces: [{ capture: "SIM-1.zip", result: s }], surfaceSource: "phantomMeshFromScene(scene)", devices: aggregateDevices([]), generatedAt: "2026-11-08T12:00:00.000Z", command: "vitest roundTrip.test.ts" };
    expect(() => renderReport({ ...input, test: false })).toThrow(SyntheticReferenceRefused);
    const rep = renderReport({ ...input, test: true });
    expect(rep.markdown.startsWith("# SYNTHETIC TEST: PHYSICAL PHANTOM VALIDATION")).toBe(true);
    console.log(rep.markdown);
  }, 900_000);
});
