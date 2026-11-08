// One capture export of the EXPERIMENTAL board-capture page, as the validation tooling sees it. Reads the page's ZIP
// (recon/page/exportZip.ts): reconstruction.json, mesh.ply, and device.json when present. Tolerant: every field that the
// page adds later (run, board_check, hand_frame, finger_axes, per-view marker_residuals, device.json) is optional, and
// a missing field stays missing (null), never a default value.
import type { Mesh, Quantity } from "../common";
import type { FingerName } from "../reconstruction/measure";
import type { Vec3 } from "../reconstruction/linalg";
import { parsePly, supportLabelsFromComments } from "./meshIO";
import { readStoredZip, text, type ZipFiles } from "./zipRead";
import { parseDeviceJson, type DeviceRun } from "./device";

export interface RunInfo {
  phantomId: string | null;
  sessionId: string | null;
  captureIndex: number | null;
  operatorCode: string | null;
  conditions: string[];
  notes: string | null;
}

export interface CheckVerdict {
  verdict: string | null;
  reasons: string[];
  /** Everything else the check recorded, as given. */
  values: Record<string, unknown>;
}

export interface HandFrameRecord {
  source: string | null;
  origin: Vec3;
  axisX: Vec3;
  axisY: Vec3;
  axisZ: Vec3 | null;
  knuckleYMm: number | null;
}

export interface FingerAxisRecord {
  name: FingerName;
  base: Vec3;
  dir: Vec3;
}

export interface ViewRecord {
  id: string;
  rejected: string | null;
  poseRmsPx: number | null;
  markers: number | null;
  markerResiduals: { id: number; rmsPx: number }[];
}

export interface CaptureRecord {
  /** File or folder name the capture came from. */
  name: string;
  /** False when the archive or its reconstruction.json could not be read at all. */
  readable: boolean;
  createdAt: string | null;
  /** An explicit data-origin label if the export carries one (e.g. "synthetic"). */
  dataOrigin: string | null;
  run: RunInfo | null;
  refused: string | null;
  refusalWords: string | null;
  calibration: { method: string | null; assumed: boolean | null; rmsPx: number | null; fx: number | null } | null;
  views: ViewRecord[];
  reconstruction: {
    ok: boolean | null;
    failure: string | null;
    accepted: boolean | null;
    reasons: { code: string; words: string | null }[];
    completeness: number | null;
    supportShare: Record<string, number> | null;
    measurements: Record<string, unknown> | null;
    timingsMs: Record<string, number> | null;
  } | null;
  coinCheck: { ok: boolean | null; scaleWrong: boolean; printScale: number | null; words: string | null } | null;
  boardCheck: {
    ruler: CheckVerdict | null;
    flatness: CheckVerdict | null;
    coin: CheckVerdict | null;
    /** The page's own decision (validity.ts), when recorded. */
    validForValidation: boolean | null;
    notValidReasons: string[];
  } | null;
  timings: { chainTotalMs: number | null; workerTotalMs: number | null };
  handFrame: HandFrameRecord | null;
  /** Why there is no usable hand frame (null when there is one). */
  handFrameMissing: string | null;
  fingerAxes: FingerAxisRecord[] | null;
  mesh: { mesh: Mesh; support: Uint8Array | null; supportLabels: string[]; confidence: Float32Array | null } | null;
  device: DeviceRun | null;
  /** Problems met while reading (a damaged mesh, an unreadable device.json): reported, not hidden. */
  problems: string[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() !== "" ? x : null);
const bool = (x: unknown): boolean | null => (typeof x === "boolean" ? x : null);

export function vec3(x: unknown): Vec3 | null {
  if (Array.isArray(x) && x.length === 3 && x.every((v) => typeof v === "number" && Number.isFinite(v))) return [x[0], x[1], x[2]];
  if (isObj(x) && [x.x, x.y, x.z].every((v) => typeof v === "number" && Number.isFinite(v as number))) return [x.x as number, x.y as number, x.z as number];
  return null;
}

const FINGER_SET = new Set(["thumb", "index", "middle", "ring", "little"]);

function parseVerdict(x: unknown): CheckVerdict | null {
  if (!isObj(x)) return null;
  const { verdict, reasons, ...values } = x;
  return { verdict: str(verdict), reasons: Array.isArray(reasons) ? reasons.map(String) : [], values };
}

/** The hand frame as the page writes it (snake_case `hand_frame`, top level or under `reconstruction`; the older
 *  camelCase HandFrame of `reconstruction.hand_frame` is read too). */
export function parseHandFrame(x: unknown): HandFrameRecord | null {
  if (!isObj(x)) return null;
  const origin = vec3(x.origin);
  const axisX = vec3(x.axis_x ?? x.axisX);
  const axisY = vec3(x.axis_y ?? x.axisY);
  if (!origin || !axisX || !axisY) return null;
  return { source: str(x.source), origin, axisX, axisY, axisZ: vec3(x.axis_z ?? x.axisZ), knuckleYMm: num(x.knuckle_y_mm ?? x.knuckleYMm) };
}

export function parseFingerAxes(x: unknown): FingerAxisRecord[] | null {
  if (!Array.isArray(x)) return null;
  const out: FingerAxisRecord[] = [];
  for (const f of x) {
    if (!isObj(f) || typeof f.name !== "string" || !FINGER_SET.has(f.name)) continue;
    const base = vec3(f.base), dir = vec3(f.dir);
    if (base && dir) out.push({ name: f.name as FingerName, base, dir });
  }
  return out;
}

/** Parse reconstruction.json (already JSON-parsed) into the fields the comparison uses. */
export function parseReconstructionJson(name: string, j: unknown): CaptureRecord {
  const problems: string[] = [];
  const r = isObj(j) ? j : {};
  if (!isObj(j)) problems.push("reconstruction.json is not a JSON object");
  const run = isObj(r.run)
    ? {
        phantomId: str(r.run.phantom_id),
        sessionId: str(r.run.session_id),
        captureIndex: num(r.run.capture_index),
        operatorCode: str(r.run.operator_code),
        conditions: Array.isArray(r.run.conditions) ? r.run.conditions.filter((c): c is string => typeof c === "string" && c.trim() !== "") : [],
        notes: str(r.run.notes),
      }
    : null;
  const cal = isObj(r.calibration) ? r.calibration : null;
  const views: ViewRecord[] = (Array.isArray(r.views) ? r.views : []).filter(isObj).map((v) => {
    const cam = isObj(v.camera) ? v.camera : {};
    const res = Array.isArray(v.marker_residuals) ? v.marker_residuals : Array.isArray(cam.marker_residuals) ? cam.marker_residuals : [];
    return {
      id: String(v.id ?? ""),
      rejected: str(cam.rejected),
      poseRmsPx: num(cam.pose_rms_px),
      markers: num(cam.markers),
      markerResiduals: res.filter(isObj).flatMap((m) => (num(m.id) !== null && num(m.rms_px) !== null ? [{ id: num(m.id)!, rmsPx: num(m.rms_px)! }] : [])),
    };
  });
  const rec = isObj(r.reconstruction) ? r.reconstruction : null;
  const quality = rec && isObj(rec.quality) ? rec.quality : null;
  const metrics = quality && isObj(quality.metrics) ? quality.metrics : null;
  const coin = isObj(r.coin_print_scale_check) ? r.coin_print_scale_check : null;
  const bc = isObj(r.board_check) ? r.board_check : null;
  const timings = isObj(r.timings_ms) ? r.timings_ms : {};
  const chainT = isObj(timings.chain) ? timings.chain : {};
  const workerT = isObj(timings.worker) ? timings.worker : {};
  const handFrame = parseHandFrame(r.hand_frame) ?? (rec ? parseHandFrame(rec.hand_frame) : null);
  const fingerAxes = parseFingerAxes(r.finger_axes) ?? (rec ? parseFingerAxes(rec.finger_axes) : null);
  const supportShare = rec && isObj(rec.support_share) ? (Object.fromEntries(Object.entries(rec.support_share).filter(([, v]) => num(v) !== null)) as Record<string, number>) : null;
  return {
    name,
    readable: isObj(j),
    createdAt: str(r.created_at),
    dataOrigin: str(r.data_origin),
    run,
    refused: str(r.refused),
    refusalWords: str(r.refusal_words),
    calibration: cal ? { method: str(cal.method), assumed: bool(cal.assumed), rmsPx: num(cal.rms_px), fx: isObj(cal.intrinsics) ? num(cal.intrinsics.fx) : null } : null,
    views,
    reconstruction: rec
      ? {
          ok: bool(rec.ok),
          failure: str(rec.failure),
          accepted: bool(rec.accepted),
          reasons: (Array.isArray(rec.reasons) ? rec.reasons : []).map((x) => (isObj(x) ? { code: String(x.code ?? "?"), words: str(x.words) } : { code: String(x), words: null })),
          completeness: metrics ? num(metrics.completeness) : null,
          supportShare,
          measurements: isObj(rec.measurements) ? rec.measurements : null,
          timingsMs: isObj(rec.timings_ms) ? (Object.fromEntries(Object.entries(rec.timings_ms).filter(([, v]) => num(v) !== null)) as Record<string, number>) : null,
        }
      : null,
    coinCheck: coin ? { ok: bool(coin.ok), scaleWrong: coin.scale_wrong === true || coin.measurements_withheld_on_page === true, printScale: num(coin.printScale), words: str(coin.words) } : null,
    boardCheck: bc
      ? {
          ruler: parseVerdict(bc.ruler),
          flatness: parseVerdict(bc.flatness),
          coin: parseVerdict(bc.coin),
          validForValidation: bool(bc.valid_for_validation),
          notValidReasons: Array.isArray(bc.not_valid_reasons) ? bc.not_valid_reasons.map(String) : [],
        }
      : null,
    timings: { chainTotalMs: num(chainT.total), workerTotalMs: num(workerT.total) },
    handFrame,
    handFrameMissing: handFrame
      ? null
      : "hand_frame" in r || (rec && "hand_frame" in rec && rec.hand_frame !== null)
        ? "the reconstruction has no hand frame (hand_frame is empty: no or too few landmarks)"
        : "the export has no hand_frame (an older page version)",
    fingerAxes,
    mesh: null,
    device: null,
    problems,
  };
}

/** A software Quantity at a dotted path of reconstruction.measurements (e.g. "fingerLengths.index"), or null. */
export function quantityAt(measurements: Record<string, unknown> | null, path: string): Quantity | null {
  let cur: unknown = measurements;
  for (const k of path.split(".")) cur = isObj(cur) ? cur[k] : undefined;
  if (!isObj(cur)) return null;
  const basis = cur.basis === "direct" || cur.basis === "model" || cur.basis === "none" ? cur.basis : null;
  if (!basis) return null;
  return { value: num(cur.value), unit: (str(cur.unit) ?? "mm") as Quantity["unit"], basis, note: str(cur.note) ?? "" };
}

/** Parse a capture from its files (a ZIP's entries or an extracted folder). */
export function parseCaptureFiles(name: string, files: Map<string, Uint8Array>): CaptureRecord {
  const jsonBytes = files.get("reconstruction.json");
  let rec: CaptureRecord;
  if (!jsonBytes) {
    rec = parseReconstructionJson(name, null);
    rec.problems = ["no reconstruction.json in this capture"];
  } else {
    let j: unknown = null;
    try {
      j = JSON.parse(text(jsonBytes));
    } catch (e) {
      rec = parseReconstructionJson(name, null);
      rec.problems = [`reconstruction.json is not valid JSON (${e instanceof Error ? e.message : String(e)})`];
      return rec;
    }
    rec = parseReconstructionJson(name, j);
  }
  const ply = files.get("mesh.ply");
  if (ply) {
    try {
      const p = parsePly(ply);
      const labels = supportLabelsFromComments(p.comments) ?? [];
      const sup = p.vertexProps.support;
      const conf = p.vertexProps.confidence;
      rec.mesh = {
        mesh: p.mesh,
        support: sup ? Uint8Array.from(sup) : null,
        supportLabels: labels,
        confidence: conf ? Float32Array.from(conf) : null,
      };
      if (!labels.length) rec.problems.push("mesh.ply has no support label names in its header");
    } catch (e) {
      rec.problems.push(`mesh.ply could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const dev = files.get("device.json");
  if (dev) {
    const d = parseDeviceJson(text(dev), `${name}/device.json`);
    rec.device = d.run;
    rec.problems.push(...d.problems);
  }
  return rec;
}

export function parseCaptureZip(name: string, bytes: Uint8Array): CaptureRecord {
  let z: ZipFiles;
  try {
    z = readStoredZip(bytes, name);
  } catch (e) {
    const rec = parseReconstructionJson(name, null);
    rec.problems = [e instanceof Error ? e.message : String(e)];
    return rec;
  }
  return parseCaptureFiles(name, z.files);
}
