// TEST FIXTURES (not measurements): hand-made shapes and export files for the unit tests of the validation tooling.
// The numbers are invented so the expected answers can be worked out by hand.
import type { Mesh } from "../../common";
import { makeZip } from "../../capture/zip";
import { extractMesh, sdfToField } from "../../reconstruction/meshing";
import { meshPly } from "../../recon/page/exportZip";

export const SUPPORT_LABELS = ["observed", "implied", "support_plane", "volume_cut", "truncated"];

export type Box = { min: [number, number, number]; max: [number, number, number] };

const sdBox = (x: number, y: number, z: number, b: Box) => {
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const qx = Math.abs(x - cx) - (b.max[0] - b.min[0]) / 2, qy = Math.abs(y - cy) - (b.max[1] - b.min[1]) / 2, qz = Math.abs(z - cz) - (b.max[2] - b.min[2]) / 2;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
};

/** A union of boxes as one closed mesh (marching tetrahedra on their distance field). */
export function boxesMesh(boxes: readonly Box[], voxelMm = 1): Mesh {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k] - 2 * voxelMm); max[k] = Math.max(max[k], b.max[k] + 2 * voxelMm); } // fmt: skip
  const sdf = (x: number, y: number, z: number) => Math.min(...boxes.map((b) => sdBox(x, y, z, b)));
  return extractMesh(sdfToField(sdf, { min, max }, voxelMm), 0);
}

/** Support labels: vertices on the board plane (z below `tol`) are support_plane (2), the rest observed (0). */
export function boardLabels(mesh: Mesh, tol = 0.25): Uint8Array {
  const n = mesh.vertices.length / 3;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = mesh.vertices[i * 3 + 2] < tol ? 2 : 0;
  return out;
}

const q = (value: number | null, basis: "direct" | "model" | "none", note = "fixture") => ({ value, unit: "mm", basis, note });

export interface FixtureCaptureOptions {
  handLength?: number | null;
  handLengthBasis?: "direct" | "model" | "none";
  circumference?: number | null;
  accepted?: boolean;
  reasons?: { code: string; words: string }[];
  refused?: string | null;
  session?: string | null;
  phantom?: string | null;
  conditions?: string[];
  scaleWrong?: boolean;
  ruler?: string | null;
  calRms?: number;
  poseRms?: number[];
  workerMs?: number;
  /** Palm box width (y extent) for the mesh; no mesh when undefined. */
  palmWidth?: number;
  withFrame?: boolean;
  dataOrigin?: string;
  noRun?: boolean;
}

/** A reconstruction.json shaped like the page's export (only the fields the tooling reads), with fixture values. */
export function fixtureReconstructionJson(o: FixtureCaptureOptions = {}): Record<string, unknown> {
  const accepted = o.accepted ?? true;
  const refused = o.refused ?? null;
  const j: Record<string, unknown> = {
    experimental: true,
    created_at: "2026-11-08T10:00:00.000Z",
    coin_print_scale_check: { ok: true, printScale: 1.001, scale_wrong: o.scaleWrong ?? false, measurements_withheld_on_page: o.scaleWrong ?? false, words: "fixture" },
    refused,
    refusal_words: refused ? "fixture refusal words" : null,
    calibration: refused === "camera_not_calibrated" ? null : { method: "zhang", assumed: false, intrinsics: { fx: 1000 }, rms_px: o.calRms ?? 0.8 },
    views: (o.poseRms ?? [0.4, 0.5, 0.6]).map((r, i) => ({ id: `v${i}`, camera: { markers: 9, pose_rms_px: r, rejected: null, marker_residuals: [{ id: 3, rms_px: r + 0.1 }] } })),
    reconstruction: refused
      ? null
      : {
          ok: true,
          accepted,
          reasons: accepted ? [] : (o.reasons ?? [{ code: "sides_not_observed", words: "fixture words" }]),
          quality: { metrics: { completeness: 0.8 } },
          measurements: {
            handLength: q(o.handLength === undefined ? 181.3 : o.handLength, o.handLength === null ? "none" : (o.handLengthBasis ?? "model")),
            palmBreadth: q(84.9, "model"),
            palmThickness: q(25.1, "model"),
            circumferenceKnuckle: q(o.circumference ?? null, o.circumference ? "model" : "none", o.circumference ? "UPPER BOUND fixture" : "the plane cuts the mesh in 2 loops"),
            fingerLengths: { thumb: q(60, "model"), index: q(null, "none"), middle: q(79, "model"), ring: q(74, "model"), little: q(58, "model") },
            surfaceArea: q(null, "none"),
          },
          support_share: { observed: 0.6, implied: 0.1, support_plane: 0.25, volume_cut: 0.05, truncated: 0 },
          timings_ms: { total: 1000 },
        },
    timings_ms: { chain: { total: (o.workerMs ?? 20000) - 30 }, worker: { total: o.workerMs ?? 20000 } },
  };
  if (!o.noRun) j.run = { phantom_id: o.phantom === undefined ? "synthetic-fixture-block-A" : o.phantom, session_id: o.session === undefined ? "S1" : o.session, capture_index: 1, operator_code: "OP1", conditions: o.conditions ?? ["baseline"], notes: null };
  if (o.ruler !== undefined) j.board_check = { ruler: { verdict: o.ruler, reasons: o.ruler === "fail" ? ["square 31.2 mm, expected 30.0"] : [] }, flatness: { verdict: "pass", reasons: [] } };
  if (o.withFrame) j.hand_frame = { source: "triangulated", origin: [0, 142.5, 12], axis_x: [0, 1, 0], axis_y: [1, 0, 0], axis_z: [0, 0, -1], knuckle_y_mm: 100 };
  if (o.dataOrigin) j.data_origin = o.dataOrigin;
  return j;
}

const enc = new TextEncoder();

/** A capture ZIP as the page writes it (stored entries), with a palm-box mesh written by the page's own PLY writer. */
export function fixtureCaptureZip(o: FixtureCaptureOptions = {}, extra: { name: string; data: Uint8Array }[] = []): Uint8Array {
  const entries = [{ name: "README.txt", data: enc.encode("fixture") }, { name: "reconstruction.json", data: enc.encode(JSON.stringify(fixtureReconstructionJson(o))) }];
  if (o.palmWidth !== undefined) {
    const mesh = boxesMesh([{ min: [0, 142.5 - o.palmWidth / 2, 0], max: [100, 142.5 + o.palmWidth / 2, 24] }], 1);
    entries.push({ name: "mesh.ply", data: enc.encode(meshPly(mesh, null, boardLabels(mesh), SUPPORT_LABELS)) });
  }
  return makeZip([...entries, ...extra].map((e) => ({ ...e, date: new Date("2026-11-08T10:00:00Z") })));
}
