// The local export of the EXPERIMENTAL board reconstruction (saved on this device only, never uploaded): a ZIP with
// reconstruction.json, the mesh as a PLY (per-vertex confidence and support label), the point cloud as CSV, a README.txt
// and the photos ONLY when the person ticked "Include the photos of my hand" (off by default). Pure apart from the photo
// encoder, which the page passes in.
// For the physical validation (`?validation`) reconstruction.json also carries `run` (phantom, session, capture index,
// operator CODE, conditions, notes), `board_check` (ruler readings and verdict, the sheet checklist, the flatness from the
// pictures, the coin check, whether the capture is valid for validation), per view `marker_residuals`, and the hand
// frame and finger axes in board millimetres (`hand_frame`, `finger_axes`); and the ZIP a separate device.json
// (deviceLog.ts). The field names are read by the offline report tool (src/experimental/validation/): do not rename them.
import type { Mesh } from "../../common";
import { makeZip, type ZipEntry } from "../../capture/zip";
import { BOARD_VERSION } from "../../board/spec";
import { binWords } from "./coverage";
import { coinView, MAX_PRINT_SCALE_ERROR, reasonDetail, reasonWords, refusalWords } from "./format";
import type { BoardFlatness } from "../boardFlatness";
import { CHECKLIST, type Checklist, type RulerCheck } from "./boardCheck";
import type { DeviceJson } from "./deviceLog";
import { runJson, type RunDetails } from "./runDetails";
import type { Capture, ReconOutcome } from "./types";
import { validity } from "./validity";

export interface ExportInput {
  outcome: ReconOutcome;
  captures: readonly Capture[];
  includePhotos: boolean;
  /** The coin entry from the served config (as densescan/page/coin.ts coinRecord gives it), or null. */
  coin: Record<string, unknown> | null;
  coinLabel: string;
  createdAt: string;
  environment: { userAgent: string | null; heapMb: number | null; page: string };
  /** PNG bytes of a capture; only called when includePhotos is true. */
  encodePhoto?: (c: Capture) => Promise<Uint8Array>;
  /** Validation mode (`?validation`): the run details and the board print check are required and recorded. */
  validationMode?: boolean;
  run?: RunDetails | null;
  ruler?: RulerCheck | null;
  checklist?: Checklist | null;
  /** The board flatness from the pictures (boardFlatness.ts flatnessOfCameras). */
  flatness?: BoardFlatness | null;
  /** device.json, made when every other file is ready (so it can carry the time the export took to prepare). */
  device?: ((prepareMs: number) => DeviceJson) | null;
}

const r3 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);

/** `board_check.ruler` of reconstruction.json. */
export function rulerJson(r: RulerCheck | null | undefined, checklist: Checklist | null | undefined) {
  return {
    square_x_mm: r?.readings.squareXmm ?? null,
    square_y_mm: r?.readings.squareYmm ?? null,
    long_span_mm: r?.readings.longSpanMm ?? null,
    short_span_mm: r?.readings.shortSpanMm ?? null,
    expected: r ? { ...r.expected } : null,
    verdict: r?.verdict ?? "not_entered",
    reasons: r?.reasons ?? ["The ruler check was not entered."],
    scale_x: r3(r?.scaleX),
    scale_y: r3(r?.scaleY),
    checklist: checklist ? Object.fromEntries(CHECKLIST.map((c) => [c.key === "noGlare" ? "no_glare" : c.key, checklist[c.key]])) : null,
  };
}

/** `board_check.flatness` of reconstruction.json. */
export function flatnessJson(f: BoardFlatness | null | undefined) {
  if (!f)
    return { verdict: "not_checked", worst_marker_rms_px: null, median_marker_rms_px: null, edge_vs_centre_ratio: null, reasons: ["Board flatness was not checked."], per_marker: [], limits_px: null, views_used: 0, views_rejected_for_residual: 0 };
  return {
    verdict: f.verdict,
    worst_marker_rms_px: r3(f.worstMarkerRmsPx),
    median_marker_rms_px: r3(f.medianMarkerRmsPx),
    edge_vs_centre_ratio: r3(f.edgeVsCentreRatio),
    reasons: [...f.reasons],
    per_marker: f.perMarker.map((m) => ({ id: m.id, median_rms_px: r3(m.medianRmsPx), max_rms_px: r3(m.maxRmsPx), views: m.views, group: m.group })),
    limits_px: { ...f.limitsPx },
    views_used: f.viewsUsed,
    views_rejected_for_residual: f.viewsRejectedForResidual,
  };
}

/** `hand_frame` and `finger_axes` of reconstruction.json, board millimetres (nulls and [] without a hand frame). */
export function handFrameJson(rec: ReconOutcome["chain"]["reconstruction"]) {
  const f = rec?.frame ?? null;
  const v = (a: readonly number[]) => [r3(a[0]), r3(a[1]), r3(a[2])];
  return {
    hand_frame: f
      ? {
          source: rec!.reasons.includes("hand_frame_from_one_view") ? ("one_view" as const) : ("triangulated" as const),
          origin: v(f.origin),
          axis_x: v(f.axisX),
          axis_y: v(f.axisY),
          axis_z: v(f.axisZ),
          knuckle_y_mm: r3(f.knuckleYMm),
        }
      : { source: null, origin: null, axis_x: null, axis_y: null, axis_z: null, knuckle_y_mm: null },
    finger_axes: f && rec ? rec.fingers.map((a) => ({ name: a.name, base: v(a.base), dir: v(a.dir) })) : [],
  };
}

const enc = new TextEncoder();

/** ASCII PLY of the mesh: x y z (board mm), confidence (0..1), support (label index), and the triangles. */
export function meshPly(mesh: Mesh, confidence: Float32Array | null, support: Uint8Array | null, labels: readonly string[]): string {
  const nv = mesh.vertices.length / 3, nt = mesh.indices.length / 3;
  const head = [
    "ply",
    "format ascii 1.0",
    "comment EXPERIMENTAL visual-hull reconstruction (glovesize board capture); not validated against physical measurements",
    "comment units: millimetres; frame: the printed board (origin bottom-left corner of the A4 sheet, +x right, +y up the page, +z out of the paper)",
    `comment support labels: ${labels.map((l, i) => `${i}=${l}`).join(", ")}`,
    `element vertex ${nv}`,
    "property float x",
    "property float y",
    "property float z",
    "property float confidence",
    "property uchar support",
    `element face ${nt}`,
    "property list uchar int vertex_indices",
    "end_header",
  ];
  const lines: string[] = head;
  const V = mesh.vertices;
  for (let i = 0; i < nv; i++) lines.push(`${V[i * 3].toFixed(3)} ${V[i * 3 + 1].toFixed(3)} ${V[i * 3 + 2].toFixed(3)} ${confidence ? confidence[i].toFixed(3) : "0"} ${support ? support[i] : 255}`);
  const I = mesh.indices;
  for (let t = 0; t < nt; t++) lines.push(`3 ${I[t * 3]} ${I[t * 3 + 1]} ${I[t * 3 + 2]}`);
  return lines.join("\n") + "\n";
}

/** CSV of the point cloud: x, y, z (board mm) and the support label. */
export function pointCloudCsv(points: Float32Array, labels: Uint8Array | null, names: readonly string[]): string {
  const out = ["x_mm,y_mm,z_mm,support"];
  for (let i = 0; i < points.length / 3; i++) out.push(`${points[i * 3].toFixed(3)},${points[i * 3 + 1].toFixed(3)},${points[i * 3 + 2].toFixed(3)},${labels ? (names[labels[i]] ?? labels[i]) : ""}`);
  return out.join("\n") + "\n";
}

/** Everything about the run except the large arrays (they are in the PLY and the CSV). */
export function reconstructionJson(input: ExportInput): Record<string, unknown> {
  const { outcome, captures } = input;
  const chain = outcome.chain;
  const rec = chain.reconstruction;
  const cam = chain.cameras;
  const coin = coinView(outcome.coin, input.coinLabel);
  const cal = cam?.calibration ?? null;
  const coinCheck = {
    ...outcome.coin,
    words: coin.words,
    max_print_scale_error: MAX_PRINT_SCALE_ERROR,
    scale_wrong: coin.scaleWrong,
    measurements_withheld_on_page: coin.scaleWrong,
  };
  const valid = validity({
    validationMode: !!input.validationMode,
    run: input.run ?? null,
    ruler: input.ruler ?? null,
    checklist: input.checklist ?? null,
    flatness: input.flatness ?? null,
    coin,
    refused: !!chain.refused,
    hasMeasurements: !!rec?.measurements,
  });
  return {
    experimental: true,
    notice: "EXPERIMENTAL visual-hull reconstruction from phone pictures of a hand resting on a printed board. The palm side rests on the board and is not observed. Not validated against physical measurements.",
    created_at: input.createdAt,
    board_version: BOARD_VERSION,
    coin_entry_from_config: input.coin,
    coin_print_scale_check: coinCheck,
    validation_mode: !!input.validationMode,
    run: runJson(input.run ?? null),
    board_check: {
      ruler: rulerJson(input.ruler, input.checklist),
      flatness: flatnessJson(input.flatness),
      coin: coinCheck,
      valid_for_validation: valid.valid,
      not_valid_reasons: valid.reasons,
    },
    ...handFrameJson(rec),
    refused: chain.refused,
    refusal_words: refusalWords(chain.refused, chain.refusalWords),
    calibration: cal
      ? {
          method: cal.method,
          assumed: cal.assumed,
          intrinsics: cal.intrinsics,
          rms_px: cal.assumed ? null : cal.rmsPx,
          std: cal.assumed ? null : cal.std,
          model: cal.assumed ? null : cal.model,
          warnings: cal.assumed ? [cal.reason] : cal.warnings,
          degeneracy: cal.degeneracy,
        }
      : null,
    views: captures.map((c, i) => {
      const v = cam?.views[i] ?? null;
      const rv = rec?.views.find((r) => r.id === c.id) ?? null;
      const agree = rec?.landmarks?.views.find((a) => a.id === c.id) ?? null;
      return {
        id: c.id,
        position: binWords(c.bin),
        bin: c.bin,
        size: { width: c.width, height: c.height },
        captured_at: c.capturedAt,
        trigger: c.trigger,
        live: { markers: c.markers, elevation_deg_assumed_focal: c.elevationDeg, azimuth_deg_assumed_focal: c.azimuthDeg, sharpness: c.sharpness },
        mediapipe_landmarks_px: c.landmarks ? c.landmarks.map((p) => [p.x, p.y]) : null,
        mediapipe_handedness_label: c.handedness,
        marker_residuals: v ? v.markerResiduals.map((r) => ({ id: r.id, rms_px: r3(r.rmsPx), used: r.used })) : [],
        camera: v
          ? { markers: v.markers, inconsistent_markers: v.inconsistentMarkers, pose: v.pose, pose_rms_px: v.poseRmsPx, elevation_deg: v.elevationDeg, azimuth_deg: v.azimuthDeg, distance_mm: v.distanceMm, rejected: v.rejected, detect_ms: v.detectMs }
          : null,
        reconstruction: rv,
        hand_moved_check: agree ? { disagrees: agree.disagrees, median_px: agree.medianPx, leave_one_out_median_px: agree.looMedianPx, shift_px: agree.looShiftPx } : null,
      };
    }),
    reconstruction: rec
      ? {
          ok: rec.ok,
          failure: rec.failure ?? null,
          accepted: rec.accepted,
          reasons: rec.reasons.map((r) => ({ code: r, words: reasonWords(r), detail: reasonDetail(r, rec.quality) })),
          quality: rec.quality,
          measurement_basis: rec.measurementBasis,
          measurements: rec.measurements,
          free_surface_area_mm2: rec.freeSurfaceAreaMm2,
          hull_volume_mm3: rec.hullVolumeMm3,
          support_labels: rec.supportLabels,
          support_share: rec.supportShare,
          volume_mm: rec.volume,
          voxel_mm: rec.voxelMm,
          mesh: rec.mesh ? { vertices: rec.mesh.vertices.length / 3, triangles: rec.mesh.indices.length / 3, file: "mesh.ply" } : null,
          point_cloud: rec.pointCloud ? { points: rec.pointCloud.points.length / 3, file: "points.csv" } : null,
          hand_frame: rec.frame,
          landmarks_3d: rec.landmarks
            ? { points_mm: rec.landmarks.points, disagreeing_views: rec.landmarks.disagreeingViews, hand_moved: rec.landmarks.handMoved, notes: rec.landmarks.notes }
            : null,
          timings_ms: rec.timingsMs,
        }
      : null,
    timings_ms: { chain: chain.timingsMs, worker: outcome.timingsMs },
    environment: input.environment,
    photos_included: input.includePhotos,
  };
}

export function readmeText(input: ExportInput, files: string[]): string {
  const n = input.captures.length;
  return [
    "EXPERIMENTAL board capture: 3D hand reconstruction (visual hull)",
    "================================================================",
    "",
    `Made on this device on ${input.createdAt} from ${n} photo${n === 1 ? "" : "s"}. Nothing was uploaded.`,
    "",
    "What this is: a visual hull carved from the hand's outline in each photo, with every camera placed by the printed",
    "board's markers and the camera calibrated from them. Concavities are filled, finger gaps close where no photo looks",
    "through them, and the palm side rests on the board: it is bounded by the board plane, NOT observed.",
    "It has not been validated against physical measurements. Do not use it for sizing.",
    "",
    "Files:",
    ...files.map((f) => `  ${f}`),
    "",
    "reconstruction.json  calibration, every camera pose, per-view reports, measurements with their basis",
    "                     (direct / model / none and a note), quality verdict and reasons in words, timings,",
    "                     the board version and the coin entry from the served settings, the coin print-scale check.",
    "mesh.ply             ASCII PLY, millimetres in the board frame; per vertex: confidence (0..1, how many outlines",
    "                     pass through it) and support (0 observed, 1 implied, 2 bounded by the board, 3 forearm cut,",
    "                     4 truncated by the search box).",
    "points.csv           the point cloud (the mesh vertices) with the same support labels.",
    ...(input.device
      ? ["device.json          this device's performance log: capture, build and export durations, JS heap samples,", "                     memory class, cores, screen, camera settings, errors (messages only), WebGL losses."]
      : []),
    "Validation fields in reconstruction.json: run (phantom, session, capture index, operator code, conditions,",
    "                     notes), board_check (ruler readings and verdict, checklist, flatness from the pictures,",
    "                     the coin check, valid_for_validation), per view marker_residuals, hand_frame, finger_axes.",
    input.includePhotos ? "photos/              the captured photos (PNG), as you asked." : "No photos are included (the box was not ticked).",
    "",
    "Board frame: origin at the bottom-left corner of the printed A4 sheet (landscape), +x to the right along the long",
    "edge (toward the fingertips), +y up the page, +z out of the paper. The board plane is z = 0.",
    "",
  ].join("\n");
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export async function buildExportEntries(input: ExportInput): Promise<ZipEntry[]> {
  const t0 = now();
  const rec = input.outcome.chain.reconstruction;
  const entries: ZipEntry[] = [];
  const date = new Date(input.createdAt);
  if (rec?.mesh) entries.push({ name: "mesh.ply", data: enc.encode(meshPly(rec.mesh, rec.confidence, rec.support, rec.supportLabels)), date });
  if (rec?.pointCloud) entries.push({ name: "points.csv", data: enc.encode(pointCloudCsv(rec.pointCloud.points, rec.pointCloud.labels, rec.supportLabels)), date });
  if (input.includePhotos) {
    if (!input.encodePhoto) throw new Error("photos were asked for but no encoder was given");
    for (const c of input.captures) entries.push({ name: `photos/${c.id}.png`, data: await input.encodePhoto(c), date });
  }
  entries.unshift({ name: "reconstruction.json", data: enc.encode(JSON.stringify(reconstructionJson(input), null, 2)), date });
  if (input.device) {
    const at = entries.findIndex((e) => e.name.startsWith("photos/"));
    const dev = { name: "device.json", data: enc.encode(JSON.stringify(input.device(now() - t0), null, 2)), date };
    if (at < 0) entries.push(dev);
    else entries.splice(at, 0, dev);
  }
  const names = ["README.txt", ...entries.map((e) => e.name)];
  entries.unshift({ name: "README.txt", data: enc.encode(readmeText(input, names)), date });
  return entries;
}

export async function buildExportZip(input: ExportInput): Promise<Uint8Array> {
  return makeZip(await buildExportEntries(input));
}
