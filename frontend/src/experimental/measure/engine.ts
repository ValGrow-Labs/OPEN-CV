// The EXPERIMENTAL measurement engine with numeric uncertainty (Stage 5).
//
// In: a reconstructed hull mesh (with support labels when the palm rests on a plane), the landmark hand frame and finger
// axes, the existing measurements (reconstruction/measure.ts, already limited by the route, e.g. multiview boardLimits),
// the cameras (for millimetres per pixel at the hand), the voxel size, and the capture's INPUT uncertainties with their
// provenance (CaptureUncertainty: independent of the board, so a board-free route can feed it).
// Out: a MeasurementReport. Every value: value, definition, method, data source, basis, and an ANALYTIC FIRST-ORDER
// uncertainty (standard and k = 2 expanded) with one component per input factor. The sensitivities that depend on the
// shape (how much a section's width changes when the surface moves out, or when the section slides along the axis) are
// read ON THE ACTUAL MESH by re-measuring it (offset mesh, shifted stations); the rest are closed-form.
// The Monte Carlo propagation through the whole pipeline lives in monteCarlo.ts / boardMc.ts; README compares the two.
//
// NOT validated against any physical measurement. A stated uncertainty describes the STATED input sigmas only.
import type { CameraPose, Intrinsics, Mesh, Quantity } from "../common";
import { cameraCenter, type Vec3 } from "../reconstruction/linalg";
import { FINGER_NAMES, measureHand, type FingerAxis, type FingerName, type HandFrame, type HandMeasurements } from "../reconstruction/measure";
import { meshArea } from "../reconstruction/meshing";
import { BASE_DEFINITIONS, fingerLengthDefinition, fingerWidthDefinition, SURFACE_AREA_DEFINITION, WIDTH_STATIONS, type ValueDefinition } from "./definitions";
import { fingerTips, fingerWidthAt, notObservedMask, offsetMesh, vertexNormals, type FingerTip } from "./sections";
import type { CameraForScale, CaptureUncertainty, DataSource, FactorKey, MeasuredValue, MeasurementReport, ResolutionSummary, SigmaOrigin, UncertaintyComponent, ValueUncertainty } from "./types";

export const ENGINE_LABEL =
  "EXPERIMENTAL measurement engine. Uncertainties are propagated from STATED input sigmas (each labelled SIMULATED, ASSUMED, EXACT or RUNTIME); they are not validated real-world accuracy.";

export const EXCLUDES =
  "Propagated input uncertainty only. NOT included: the visual hull's one-sided bias (an upper bound: concavities and unseen gaps filled), the gap between this landmark-based definition and an anatomical or tape definition, soft-tissue, posture and finger-spread variation, lens-model error beyond the calibrated distortion, and any error the stated sigmas do not describe.";

export interface EngineInput {
  mesh: Mesh | null;
  /** Per-vertex support labels (quality.ts vertexSupport) and their names; null when there are none. */
  support?: Uint8Array | null;
  supportLabels?: readonly string[];
  frame: HandFrame | null;
  fingers: readonly FingerAxis[];
  /** The existing measurements (reconstruction/measure.ts), already limited by the route (e.g. boardLimits). */
  measurements: HandMeasurements | null;
  /** The reconstruction passed its quality gates. No uncertainty is stated otherwise. */
  accepted: boolean;
  /** Why it was not accepted (shown in the note). */
  reasons?: readonly string[];
  /** The palm side rests on a support plane (a board, or a table fitted by a board-free route): not observed. */
  supportBounded: boolean;
  /** The support plane's normal (default board +z). Finger widths are measured parallel to that plane. */
  up?: Vec3;
  usedViews: readonly string[];
  landmarkSource: DataSource["landmarkSource"];
  /** Millimetres per pixel at the hand comes from these (fx of the CARVING masks, depth of the hand). */
  cameras: readonly CameraForScale[];
  voxelMm: number;
  capture: CaptureUncertainty;
  /** Closed-form sensitivities only (no re-measuring of perturbed meshes): faster, less shape-aware. */
  fast?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Resolution

/** Millimetres per mask pixel at a point for each camera: depth of the point / fx. */
export function camerasForScale(views: readonly { id: string; intrinsics: Intrinsics; pose: CameraPose }[], point: Vec3): CameraForScale[] {
  return views.map((v) => {
    const R = v.pose.R, t = v.pose.t;
    const z = R[6] * point[0] + R[7] * point[1] + R[8] * point[2] + t[2];
    const c = cameraCenter(v.pose);
    return { id: v.id, fxPx: v.intrinsics.fx, distanceMm: z > 0 ? z : Math.hypot(point[0] - c[0], point[1] - c[1], point[2] - c[2]) };
  });
}

export function resolutionSummary(cams: readonly CameraForScale[]): ResolutionSummary | null {
  if (!cams.length) return null;
  const perView = cams.map((c) => ({ id: c.id, mmPerPx: c.distanceMm / c.fxPx }));
  const s = perView.map((p) => p.mmPerPx).sort((a, b) => a - b);
  return {
    perView,
    medianMmPerPx: s[Math.floor(s.length / 2)],
    minMmPerPx: s[0],
    maxMmPerPx: s[s.length - 1],
    medianDepthMm: cams.map((c) => c.distanceMm).sort((a, b) => a - b)[Math.floor(cams.length / 2)],
    note: "millimetres per pixel OF THE MASKS USED FOR CARVING at the hand's depth (depth / fx). Pixel size is resolution, not accuracy.",
  };
}

/** Mean of the mesh vertices (the hand's centroid, for the depth of the hand in each view). */
export function meshCentroid(mesh: Mesh): Vec3 {
  const V = mesh.vertices;
  const n = V.length / 3;
  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += V[i * 3 + k] / n;
  return c;
}

// ---------------------------------------------------------------------------------------------------------------
// Reporting increment (the 0.1 mm question)

/** The largest step of the 1-2-5 series (..., 0.1, 0.2, 0.5, 1, 2, 5, ...) that is at or below `x`. */
export function step125Floor(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return NaN;
  const e = Math.floor(Math.log10(x) + 1e-12);
  const base = 10 ** e;
  const m = x / base;
  const k = m >= 5 - 1e-9 ? 5 : m >= 2 - 1e-9 ? 2 : 1;
  return k * base;
}

/** Smallest defensible reporting increment for a standard uncertainty u (mm): the 1-2-5 step at or below u. Reporting
 *  finer than the standard uncertainty adds digits the data cannot support; rounding to this step adds at most
 *  step / sqrt(12) <= 0.29 u in quadrature (<= 4 % of u_c). Never finer than 0.01 mm. */
export function reportingIncrement(u: number): number {
  return Math.max(0.01, step125Floor(u));
}

export const roundTo = (v: number, inc: number): number => Math.round(v / inc) * inc;

// ---------------------------------------------------------------------------------------------------------------
// Values (no uncertainty yet)

interface RawValue {
  def: ValueDefinition;
  q: Quantity;
  upperBound: boolean;
  /** For finger widths: which finger and station (to read the station slope). */
  width?: { finger: FingerName; station: (typeof WIDTH_STATIONS)[number]; stationS: number | null; observedShare: number | null };
}

const none = (unit: Quantity["unit"], note: string): Quantity => ({ value: null, unit, basis: "none", note });

function existingValues(m: HandMeasurements | null, noFrameWhy: string): Record<string, Quantity> {
  const out: Record<string, Quantity> = {};
  if (!m) {
    for (const d of BASE_DEFINITIONS) out[d.key] = none("mm", noFrameWhy);
    for (const f of FINGER_NAMES) out[`finger_length_${f}`] = none("mm", noFrameWhy);
    out.surface_area = none("mm2", noFrameWhy);
    return out;
  }
  out.hand_length = m.handLength;
  out.palm_breadth = m.palmBreadth;
  out.palm_thickness = m.palmThickness;
  out.knuckle_circumference = m.circumferenceKnuckle;
  for (const f of FINGER_NAMES) out[`finger_length_${f}`] = m.fingerLengths[f];
  out.surface_area = m.surfaceArea;
  return out;
}

/** Every value of the engine (existing measurements + finger widths), with basis and withholding, no uncertainty. */
export function extractValues(input: Pick<EngineInput, "mesh" | "support" | "supportLabels" | "frame" | "fingers" | "measurements" | "supportBounded" | "up">): RawValue[] {
  const noFrame = "no hand frame (landmarks missing or not triangulated), so nothing is measured in the hand frame";
  const ex = existingValues(input.measurements, noFrame);
  const out: RawValue[] = [];
  for (const d of BASE_DEFINITIONS) {
    const q = ex[d.key];
    out.push({ def: d, q, upperBound: q.value !== null && d.kind !== "length" });
  }
  for (const f of FINGER_NAMES) out.push({ def: fingerLengthDefinition(f), q: ex[`finger_length_${f}`], upperBound: false });
  // finger widths
  const mesh = input.mesh;
  const nv = mesh ? mesh.vertices.length / 3 : 0;
  const notObs = mesh ? notObservedMask(input.support ?? null, input.supportLabels ?? [], nv) : null;
  const tips = mesh && input.frame && input.fingers.length ? fingerTips(mesh, notObs, input.fingers) : new Map<FingerName, FingerTip>();
  const widthBasis: Quantity["basis"] = input.frame?.source === "given" ? "direct" : "model";
  for (const f of FINGER_NAMES)
    for (const st of WIDTH_STATIONS) {
      const def = fingerWidthDefinition(f, st);
      if (!mesh) {
        out.push({ def, q: none("mm", "no mesh"), upperBound: false });
        continue;
      }
      if (!input.frame || input.frame.source === "pca") {
        out.push({ def, q: none("mm", noFrame), upperBound: false });
        continue;
      }
      if (!input.fingers.some((a) => a.name === f)) {
        out.push({ def, q: none("mm", `no axis for the ${f} (its landmarks are missing)`), upperBound: false });
        continue;
      }
      const w = fingerWidthAt(mesh, notObs, tips, f, st.station, { up: input.up });
      const note =
        w.value === null
          ? w.note
          : `${widthBasis === "model" ? "station and direction from the landmark finger axis (a detector's estimate)" : "station and direction from the given finger axis"}; visual hull section (an upper bound of the finger: never narrower up to input errors)${notObs ? "" : "; no support labels: board-contact vertices could not be excluded"}`;
      out.push({ def, q: w.value === null ? none("mm", note) : { value: w.value, unit: "mm", basis: widthBasis, note }, upperBound: w.value !== null, width: { finger: f, station: st, stationS: w.stationS, observedShare: w.observedShare } });
    }
  // A station nearer the base can cut into the palm (the thumb's base point lies inside the palm outline): a section
  // much wider than the same finger near its tip is not a finger width. Bounds ASSUMED: 1.5 x the tip15 width, 40 mm.
  for (const f of FINGER_NAMES) {
    const near = out.find((r) => r.width?.finger === f && r.width.station.id === "tip15");
    for (const r of out) {
      if (r.width?.finger !== f || r.width.station.id === "tip15" || r.q.value === null) continue;
      const ref = near?.q.value ?? null;
      if (r.q.value > 40 || (ref !== null && r.q.value > 1.5 * ref)) {
        r.q = none("mm", `the section is not finger-sized (${r.q.value.toFixed(1)} mm${ref !== null ? ` against ${ref.toFixed(1)} mm near the tip` : ""}): it reaches into the palm or a neighbouring finger (ASSUMED bounds: 1.5 x the tip15 width, 40 mm)`);
        r.upperBound = false;
      }
    }
  }
  const area = ex.surface_area;
  out.push({ def: SURFACE_AREA_DEFINITION, q: input.supportBounded && area.value !== null ? none("mm2", "not available: the palm side rests on the support plane and is not observed") : area, upperBound: area.value !== null && !input.supportBounded });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Shape-dependent sensitivities, read on the actual mesh

export interface Sensitivities {
  /** dV / d(eps): change of the value per mm of uniform outward offset of the observed surface. */
  offsetGain: Record<string, number>;
  /** dV / d(station): change per mm the section slides along its axis (sections and widths). */
  stationSlope: Record<string, number>;
  method: "mesh re-measure" | "closed-form rules";
  epsMm: number;
  stationStepMm: number;
}

const sectionKeys = ["palm_breadth", "palm_thickness", "knuckle_circumference"] as const;

function sectionValues(m: HandMeasurements | null): Record<string, number | null> {
  return { palm_breadth: m?.palmBreadth.value ?? null, palm_thickness: m?.palmThickness.value ?? null, knuckle_circumference: m?.circumferenceKnuckle.value ?? null };
}

export function meshSensitivities(input: EngineInput, raw: readonly RawValue[], epsMm = 0.5, stationStepMm = 2): Sensitivities {
  const out: Sensitivities = { offsetGain: {}, stationSlope: {}, method: "mesh re-measure", epsMm, stationStepMm };
  const mesh = input.mesh;
  if (!mesh || !input.frame || input.fast) return { ...out, method: "closed-form rules" };
  const nv = mesh.vertices.length / 3;
  const notObs = notObservedMask(input.support ?? null, input.supportLabels ?? [], nv);
  const normals = vertexNormals(mesh);
  const opts = { fingers: input.fingers, accepted: input.accepted };
  const plus = offsetMesh(mesh, epsMm, notObs, normals), minus = offsetMesh(mesh, -epsMm, notObs, normals);
  const sp = sectionValues(measureHand(plus, input.frame, opts)), sm = sectionValues(measureHand(minus, input.frame, opts));
  for (const k of sectionKeys) if (sp[k] !== null && sm[k] !== null) out.offsetGain[k] = (sp[k]! - sm[k]!) / (2 * epsMm);
  if (input.frame.knuckleYMm !== undefined) {
    const shifted = (d: number): HandFrame => ({ ...input.frame!, knuckleYMm: input.frame!.knuckleYMm! + d });
    const yp = sectionValues(measureHand(mesh, shifted(stationStepMm), opts)), ym = sectionValues(measureHand(mesh, shifted(-stationStepMm), opts));
    for (const k of sectionKeys) if (yp[k] !== null && ym[k] !== null) out.stationSlope[k] = (yp[k]! - ym[k]!) / (2 * stationStepMm);
  }
  const tipsP = fingerTips(plus, notObs, input.fingers), tipsM = fingerTips(minus, notObs, input.fingers), tips0 = fingerTips(mesh, notObs, input.fingers);
  for (const r of raw) {
    if (!r.width || r.q.value === null) continue;
    const { finger, station } = r.width;
    const wp = fingerWidthAt(plus, notObs, tipsP, finger, station.station, { up: input.up }).value;
    const wm = fingerWidthAt(minus, notObs, tipsM, finger, station.station, { up: input.up }).value;
    if (wp !== null && wm !== null) out.offsetGain[r.def.key] = (wp - wm) / (2 * epsMm);
    const sp2 = fingerWidthAt(mesh, notObs, tips0, finger, station.station, { up: input.up, shiftMm: stationStepMm }).value;
    const sm2 = fingerWidthAt(mesh, notObs, tips0, finger, station.station, { up: input.up, shiftMm: -stationStepMm }).value;
    if (sp2 !== null && sm2 !== null) out.stationSlope[r.def.key] = (sp2 - sm2) / (2 * stationStepMm);
  }
  const area = raw.find((r) => r.def.key === "surface_area");
  if (area && area.q.value !== null) out.offsetGain.surface_area = (meshArea(plus) - meshArea(minus)) / (2 * epsMm);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The analytic first-order budget

export interface BudgetContext {
  capture: CaptureUncertainty;
  voxelMm: number;
  /** Median millimetres per mask pixel at the hand. */
  mmPerPx: number;
  /** Median camera-to-hand depth, mm. */
  distanceMm: number;
}

const DEG = Math.PI / 180;
const worstOrigin = (...o: SigmaOrigin[]): SigmaOrigin => (o.includes("ASSUMED") ? "ASSUMED" : o.includes("RUNTIME") ? "RUNTIME" : o.includes("SIMULATED") ? "SIMULATED" : "EXACT");

/** Lateral silhouette displacement (mm, one sigma, per view) from the pose sigmas: an isotropic rotation of RMS angle
 *  theta about the camera centre moves the hand's image by D theta sqrt(2/3) across the line of sight; an isotropic
 *  centre error C by C sqrt(2/3). */
export function poseDisplacementMm(ctx: BudgetContext): number {
  const th = ctx.capture.poseRotDeg.value * DEG;
  return Math.sqrt(2 / 3) * Math.hypot(ctx.distanceMm * th, ctx.capture.poseCentreMm.value);
}

/** The first-order components of one value. `gain` = dV/d(offset), `slope` = dV/d(station). */
export function analyticComponents(raw: RawValue, sens: Sensitivities, ctx: BudgetContext): { components: UncertaintyComponent[]; notes: string[] } {
  const V = raw.q.value!;
  const kind = raw.def.kind;
  const key = raw.def.key;
  const u = ctx.capture;
  const notes: string[] = [];
  const isArea = kind === "area";
  const rel = isArea ? 2 : 1;
  let gain = sens.offsetGain[key];
  let gainRule = `dV/d(offset) = ${gain?.toFixed(2)} read on the mesh (offset +-${sens.epsMm} mm of the observed surface)`;
  if (gain === undefined) {
    if (kind === "length") {
      gain = 1;
      gainRule = "dV/d(offset) = 1 (one surface end: the tip moves with the surface; the other end is a landmark datum)";
    } else if (kind === "extent") {
      gain = 2;
      gainRule = "dV/d(offset) = 2 (closed-form: both sides move)";
    } else if (kind === "loop") {
      gain = 2 * Math.PI;
      gainRule = "dV/d(offset) = 2 pi (closed-form: a loop offset by eps grows by 2 pi eps)";
    } else {
      gain = NaN;
      gainRule = "no offset sensitivity for this area (needs the mesh)";
    }
  }
  const g = Math.abs(gain);
  const slope = Math.abs(sens.stationSlope[key] ?? 0);
  const comps: UncertaintyComponent[] = [];
  const add = (factor: FactorKey, sigma: number, rule: string, origin: SigmaOrigin, source: string) => {
    if (Number.isFinite(sigma)) comps.push({ factor, sigma, rule, inputOrigin: origin, inputSource: source });
  };
  // focal and scale: relative, coefficient 1 (lengths) or 2 (areas)
  add("focal", rel * Math.abs(V) * u.focalRel.value, `${rel} x |V| x sigma_f/f (a shared focal error scales the hull; SIMULATED reconstruction/README: +2 % focal -> about -2 % on every length)`, u.focalRel.origin, u.focalRel.source);
  add("scale", rel * Math.abs(V) * u.scaleRel.value, `${rel} x |V| x sigma_s (every length is linear in the scene scale${u.scaleReference === "coin" ? ", fixed by the coin" : u.scaleReference === "board_print" ? ", fixed by the printed board" : ""})`, u.scaleRel.origin, u.scaleRel.source);
  // mask boundary: an outward/inward offset of the outline of sigma_b px = sigma_b x mm/px at the hand
  const bMm = u.maskBoundaryPx.value * ctx.mmPerPx;
  const vMm = ctx.voxelMm / Math.sqrt(12);
  const isWidth = !!raw.width;
  const tipStation = isWidth && raw.width!.station.station.kind === "fromTip";
  const fracF = isWidth && raw.width!.station.station.kind === "fraction" ? (raw.width!.station.station as { f: number }).f : 0;
  // a width's station is placed from the tip (mesh): the tip moves with the boundary / voxel errors too
  const stationFromMesh = isWidth ? (tipStation ? 1 : fracF) : 0;
  add(
    "boundary",
    Math.hypot(g * bMm, slope * stationFromMesh * bMm),
    `${gainRule}; x sigma_b ${u.maskBoundaryPx.value} px x ${ctx.mmPerPx.toFixed(3)} mm/px = ${bMm.toFixed(3)} mm${stationFromMesh ? `; plus the station sliding with the tip: |dV/ds| ${slope.toFixed(3)} x ${stationFromMesh} x ${bMm.toFixed(3)} mm` : ""}`,
    u.maskBoundaryPx.origin,
    u.maskBoundaryPx.source,
  );
  const pMm = poseDisplacementMm(ctx);
  add(
    "pose",
    (g * pMm) / Math.SQRT2,
    `${gainRule}; x per-view displacement ${pMm.toFixed(3)} mm (sqrt(2/3) x hypot(D ${ctx.distanceMm.toFixed(0)} mm x ${u.poseRotDeg.value} deg, centre ${u.poseCentreMm.value} mm)) / sqrt 2 (half the misregistration of two independent views). First-order only: misregistration SHRINKS a hull (a negative bias the Monte Carlo shows)`,
    worstOrigin(u.poseRotDeg.origin, u.poseCentreMm.origin),
    `${u.poseRotDeg.source} | ${u.poseCentreMm.source}`,
  );
  const vFactor = kind === "length" ? 1 : Math.SQRT1_2;
  add(
    "voxel",
    Math.hypot(g * vMm * vFactor, slope * stationFromMesh * vMm),
    `${gainRule}; x voxel ${ctx.voxelMm} mm / sqrt 12 = ${vMm.toFixed(3)} mm per surface${kind === "length" ? "" : " / sqrt 2 (the sides quantise independently)"} (ASSUMED rule: uniform quantisation; the blurred iso-surface is sub-voxel)`,
    "ASSUMED",
    `voxel size ${ctx.voxelMm} mm is a setting; the 1/sqrt(12) rule is ASSUMED (checked by the voxel-phase Monte Carlo)`,
  );
  // landmarks: the datums
  const L = u.landmark3dMm.value;
  let lmSigma = 0;
  let lmRule = "";
  if (key === "hand_length") {
    lmSigma = L;
    lmRule = "1 x sigma_lm3d (the wrist landmark sets the wrist plane along the axis)";
  } else if (key.startsWith("finger_length_")) {
    lmSigma = L;
    lmRule = "1 x sigma_lm3d (the MCP landmark is the base point)";
  } else if ((sectionKeys as readonly string[]).includes(key)) {
    lmSigma = (slope * L) / 2;
    lmRule = `|dV/dy| ${slope.toFixed(3)} (section slid +-${sens.stationStepMm} mm on the mesh) x sigma_lm3d / 2 (the knuckle line is the mean of 4 MCP landmarks; the wrist origin cancels)`;
  } else if (isWidth) {
    lmSigma = slope * (1 - stationFromMesh) * L;
    lmRule = tipStation
      ? "0: the station is placed from the fingertip (mesh), not from a landmark; the axis direction enters at second order only (w sigma_alpha^2 / 2, below 0.01 mm here)"
      : `|dV/ds| ${slope.toFixed(3)} x (1 - ${fracF}) x sigma_lm3d (the base landmark places ${((1 - fracF) * 100).toFixed(0)} % of the station)`;
  } else {
    lmRule = "no landmark datum";
  }
  add("landmarks", lmSigma, lmRule, u.landmark3dMm.origin, u.landmark3dMm.source);
  if (!Number.isFinite(gain)) notes.push(gainRule);
  return { components: comps, notes };
}

export function combine(value: number, components: UncertaintyComponent[], method: ValueUncertainty["method"]): ValueUncertainty {
  const standard = Math.sqrt(components.reduce((s, c) => s + c.sigma * c.sigma, 0));
  const dominant = components.slice().sort((a, b) => b.sigma - a.sigma)[0]?.factor ?? "focal";
  const U = 2 * standard;
  return { standard, expanded95: U, coverageFactor: 2, interval95: [value - U, value + U], method, components, dominant, excludes: EXCLUDES };
}

// ---------------------------------------------------------------------------------------------------------------
// The report

export function measureWithUncertainty(input: EngineInput): MeasurementReport {
  const raw = extractValues(input);
  const resolution = resolutionSummary(input.cameras);
  const dists = input.cameras.map((c) => c.distanceMm).sort((a, b) => a - b);
  const ctx: BudgetContext = { capture: input.capture, voxelMm: input.voxelMm, mmPerPx: resolution?.medianMmPerPx ?? NaN, distanceMm: dists.length ? dists[Math.floor(dists.length / 2)] : NaN };
  const anyValue = raw.some((r) => r.q.value !== null);
  const canState = input.accepted && input.capture.scaleReference !== "none" && Number.isFinite(ctx.mmPerPx);
  const sens = anyValue && canState ? meshSensitivities(input, raw) : { offsetGain: {}, stationSlope: {}, method: "closed-form rules" as const, epsMm: 0.5, stationStepMm: 2 };
  const whyNot = !input.accepted
    ? `no uncertainty stated: the reconstruction did not pass its quality gates${input.reasons?.length ? ` (${input.reasons.join(", ")})` : ""}; its errors are not described by the stated input sigmas`
    : input.capture.scaleReference === "none"
      ? "no uncertainty stated: there is no metric scale reference"
      : !Number.isFinite(ctx.mmPerPx)
        ? "no uncertainty stated: no camera geometry to convert pixels to millimetres"
        : null;
  const values: MeasuredValue[] = raw.map((r) => {
    const dataSource: DataSource = { views: [...input.usedViews], meshRegion: r.def.meshRegion, landmarks: r.def.landmarks, landmarkSource: r.def.landmarks.length ? input.landmarkSource : "none" };
    const base = {
      key: r.def.key,
      label: r.def.label,
      unit: r.def.unit,
      kind: r.def.kind,
      value: r.q.value,
      basis: r.q.basis,
      basisNote: r.q.note,
      upperBound: r.upperBound,
      definition: r.def.definition,
      method: r.def.method,
      dataSource,
    };
    if (r.q.value === null) return { ...base, uncertainty: null, uncertaintyNote: "withheld (basis none): " + r.q.note, reportingIncrementMm: null, reported: null };
    if (whyNot) return { ...base, uncertainty: null, uncertaintyNote: whyNot, reportingIncrementMm: null, reported: null };
    const { components, notes } = analyticComponents(r, sens, ctx);
    const unc = combine(r.q.value, components, "analytic first-order");
    const inc = r.def.unit === "mm" ? reportingIncrement(unc.standard) : step125Floor(unc.standard);
    return { ...base, uncertainty: unc, uncertaintyNote: notes.length ? notes.join("; ") : null, reportingIncrementMm: inc, reported: roundTo(r.q.value, inc) };
  });
  const byKey: Record<string, MeasuredValue> = {};
  for (const v of values) byKey[v.key] = v;
  const notes = [
    "Experimental and unvalidated: no value has been compared with a physical measurement.",
    `Input sigmas (${input.capture.route}): focal ${(input.capture.focalRel.value * 100).toFixed(3)} % [${input.capture.focalRel.origin}], pose ${input.capture.poseRotDeg.value} deg [${input.capture.poseRotDeg.origin}] / ${input.capture.poseCentreMm.value} mm [${input.capture.poseCentreMm.origin}], scale ${(input.capture.scaleRel.value * 100).toFixed(2)} % (${input.capture.scaleReference}) [${input.capture.scaleRel.origin}], mask boundary ${input.capture.maskBoundaryPx.value} px [${input.capture.maskBoundaryPx.origin}], 3D landmarks ${input.capture.landmark3dMm.value} mm [${input.capture.landmark3dMm.origin}], voxel ${input.voxelMm} mm.`,
    `Sensitivities: ${sens.method}.`,
    "The expanded uncertainty uses k = 2 (about 95 % IF the errors were normal and the stated sigmas right). " + EXCLUDES,
  ];
  if (input.supportBounded) notes.push("The palm side rests on the support plane (not observed): no hand surface area; the knuckle circumference is an UPPER BOUND.");
  if (whyNot) notes.push(whyNot);
  return { label: ENGINE_LABEL, route: input.capture.route, accepted: input.accepted, inputs: input.capture, voxelMm: input.voxelMm, resolution, values, byKey, notes };
}

/** Replace the analytic uncertainty of each value by a Monte Carlo one (sd and empirical 2.5 / 97.5 % interval around the
 *  value), keeping the analytic components for the breakdown. Values the Monte Carlo has no samples for are unchanged. */
export function withMonteCarlo(report: MeasurementReport, mc: Record<string, { sd: number; p025: number; p975: number; meanShift: number; n: number } | undefined>): MeasurementReport {
  const values = report.values.map((v) => {
    const s = mc[v.key];
    if (!s || v.value === null || !v.uncertainty || s.n < 2) return v;
    const unc: ValueUncertainty = { ...v.uncertainty, standard: s.sd, expanded95: 2 * s.sd, interval95: [v.value + s.p025, v.value + s.p975], method: "monte carlo" };
    const inc = reportingIncrement(s.sd);
    return { ...v, uncertainty: unc, reportingIncrementMm: inc, reported: roundTo(v.value, inc), uncertaintyNote: `${v.uncertaintyNote ? v.uncertaintyNote + "; " : ""}Monte Carlo over ${s.n} trials: mean shift ${s.meanShift.toFixed(2)} (a bias, NOT corrected)` };
  });
  const byKey: Record<string, MeasuredValue> = {};
  for (const v of values) byKey[v.key] = v;
  return { ...report, values, byKey };
}
