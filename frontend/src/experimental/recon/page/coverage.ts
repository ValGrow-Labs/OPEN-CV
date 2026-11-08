// Coverage guide of the EXPERIMENTAL board-capture page: which camera positions around the hand are still needed, what to
// tell the person holding the phone, and whether the current frame may be captured. Pure functions (unit-tested).
//
// The capture design (docs/hand3d-research/AUDIT_3D_STATUS.md, reconstruction/captureGeometry.test.ts, SIMULATED): one view
// from straight above, plus a LOW ring of views all round the hand at about 8 to 22 degrees above the board (they bound the
// hand's thickness), optionally a middle ring at 25 to 45 degrees. Angles come from the board pose: elevation above the
// board plane, azimuth around the hand area (0 = the fingertip / right side, 90 = the top edge, 180 = the open left edge
// where the wrist is, 270 = the bottom edge). Live, the pose uses an ASSUMED focal length (guidance only): the angles can
// be off by a degree or two, which is why the rings have margins.

export const TOP_MIN_ELEVATION_DEG = 60;
export const LOW_RING = { minDeg: 8, maxDeg: 22 } as const;
export const MID_RING = { minDeg: 25, maxDeg: 45 } as const;
export const LOW_SECTORS = 12; // 30 degrees each; boundaries at multiples of 30 (the open edge, 180, is a boundary)
export const MID_SECTORS = 6; // 60 degrees each (optional)
/** Fewest consistent markers in the frame for a capture. */
export const MIN_MARKERS = 4;
/** Sharpness (frameMetrics.laplacianSharpness) below this blocks a capture. */
export const MIN_SHARPNESS = 0.7;
/** Steadiness: over the last STEADY_FRAMES analysed frames, the camera turned less than this and moved less than this. */
export const STEADY_FRAMES = 3;
export const MAX_STEADY_ROT_DEG = 1.0;
export const MAX_STEADY_MOVE_MM = 5;

export type BinId = "top" | `low-${number}` | `mid-${number}`;

export interface Bin {
  id: BinId;
  ring: "top" | "low" | "mid";
  /** Sector index in its ring (0 for the top view). */
  sector: number;
  /** Azimuth range [from, to) in degrees (the top view: [0, 360)). */
  fromDeg: number;
  toDeg: number;
  required: boolean;
}

const sectorWidth = (ring: "low" | "mid") => 360 / (ring === "low" ? LOW_SECTORS : MID_SECTORS);

export const ALL_BINS: readonly Bin[] = [
  { id: "top", ring: "top", sector: 0, fromDeg: 0, toDeg: 360, required: true },
  ...Array.from({ length: LOW_SECTORS }, (_, k): Bin => ({ id: `low-${k}`, ring: "low", sector: k, fromDeg: k * sectorWidth("low"), toDeg: (k + 1) * sectorWidth("low"), required: true })),
  ...Array.from({ length: MID_SECTORS }, (_, k): Bin => ({ id: `mid-${k}`, ring: "mid", sector: k, fromDeg: k * sectorWidth("mid"), toDeg: (k + 1) * sectorWidth("mid"), required: false })),
];

export const REQUIRED_BINS = ALL_BINS.filter((b) => b.required);

export function binById(id: BinId): Bin {
  const b = ALL_BINS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown bin ${id}`);
  return b;
}

const wrap = (deg: number) => ((deg % 360) + 360) % 360;

/** The bin a camera position falls in, or null between the rings (or below the low ring). */
export function binOf(elevationDeg: number, azimuthDeg: number): BinId | null {
  if (!Number.isFinite(elevationDeg) || !Number.isFinite(azimuthDeg)) return null;
  if (elevationDeg >= TOP_MIN_ELEVATION_DEG) return "top";
  const az = wrap(azimuthDeg);
  if (elevationDeg >= LOW_RING.minDeg && elevationDeg <= LOW_RING.maxDeg) return `low-${Math.floor(az / sectorWidth("low")) % LOW_SECTORS}`;
  if (elevationDeg >= MID_RING.minDeg && elevationDeg <= MID_RING.maxDeg) return `mid-${Math.floor(az / sectorWidth("mid")) % MID_SECTORS}`;
  return null;
}

/** Which board edge the thumb points to, when known (from the top view's landmarks): it names the sides in words. */
export type ThumbSide = "top" | "bottom" | null;

/** The side of the hand a direction (azimuth) looks at, in words. */
export function sideWords(azimuthDeg: number, thumb: ThumbSide = null): string {
  const az = wrap(azimuthDeg);
  const names = [
    "the fingertip side",
    thumb === "top" ? "the thumb side (top edge)" : thumb === "bottom" ? "the little-finger side (top edge)" : "the top-edge side",
    "the wrist side (open edge)",
    thumb === "bottom" ? "the thumb side (bottom edge)" : thumb === "top" ? "the little-finger side (bottom edge)" : "the bottom-edge side",
  ];
  const q = Math.round(az / 90) % 4;
  let off = Math.abs(az - q * 90);
  if (off > 180) off = 360 - off;
  if (off <= 22.5) return names[q];
  const a = Math.floor(az / 90) % 4;
  return `between ${names[a]} and ${names[(a + 1) % 4]}`;
}

export function binWords(id: BinId, thumb: ThumbSide = null): string {
  const b = binById(id);
  if (b.ring === "top") return "the top view (straight above)";
  const mid = (b.fromDeg + b.toDeg) / 2;
  return `${b.ring === "low" ? "low" : "middle"} ${b.fromDeg}–${b.toDeg}° (${sideWords(mid, thumb)})`;
}

/** "top" or "low 90–120°": the bin without the side's name (tables). */
export function binShort(id: BinId): string {
  const b = binById(id);
  return b.ring === "top" ? "top (straight above)" : `${b.ring === "low" ? "low" : "middle"} ${b.fromDeg}–${b.toDeg}°`;
}

/** What is still missing before the reconstruction may start, in words (empty = ready). */
export function missingRequired(filled: ReadonlySet<BinId>): BinId[] {
  return REQUIRED_BINS.filter((b) => !filled.has(b.id)).map((b) => b.id);
}

export function missingWords(filled: ReadonlySet<BinId>): string {
  const miss = missingRequired(filled);
  if (miss.length === 0) return "";
  const parts: string[] = [];
  if (miss.includes("top")) parts.push("the top view");
  const low = miss.filter((m) => m.startsWith("low-"));
  if (low.length) parts.push(`${low.length} low view${low.length === 1 ? "" : "s"} (${low.map((m) => binShort(m).replace(/^low /, "")).join(", ")})`);
  return `Still needed: ${parts.join("; ")}.`;
}

// ------------------------------------------------------------------------------------------------ live state

export interface LiveAnalysis {
  /** Consistent markers found in the frame. */
  markers: number;
  /** From the board pose with ASSUMED intrinsics; null without a pose. */
  elevationDeg: number | null;
  azimuthDeg: number | null;
  sharpness: number | null;
  /** From the last STEADY_FRAMES analysed frames; null until there are enough. */
  steady: { rotDeg: number; moveMm: number } | null;
}

export type GateCode = "no_markers" | "few_markers" | "no_pose" | "between_rings" | "bin_filled" | "blurred" | "unsteady" | "ok";

export interface Gate {
  ok: boolean;
  code: GateCode;
  bin: BinId | null;
  /** Why a capture is blocked (or "ready"), in words. */
  words: string;
}

const deg = (v: number) => `${Math.round(v)}°`;

/** May the current frame be captured? The automatic capture and the "Take this view" button use the same checks. */
export function captureGate(a: LiveAnalysis, filled: ReadonlySet<BinId>, thumb: ThumbSide = null): Gate {
  if (a.markers === 0) return { ok: false, code: "no_markers", bin: null, words: "No printed markers are in view." };
  if (a.markers < MIN_MARKERS) return { ok: false, code: "few_markers", bin: null, words: `Only ${a.markers} printed marker${a.markers === 1 ? "" : "s"} found (needs ${MIN_MARKERS}).` };
  if (a.elevationDeg === null || a.azimuthDeg === null) return { ok: false, code: "no_pose", bin: null, words: "The board's position could not be worked out from the markers." };
  const bin = binOf(a.elevationDeg, a.azimuthDeg);
  if (!bin) return { ok: false, code: "between_rings", bin: null, words: `The phone is ${deg(a.elevationDeg)} above the board: that height is not one of the capture heights.` };
  if (filled.has(bin)) return { ok: false, code: "bin_filled", bin, words: `This position (${binWords(bin, thumb)}) is already taken.` };
  if (a.sharpness === null || a.sharpness < MIN_SHARPNESS)
    return { ok: false, code: "blurred", bin, words: a.sharpness === null ? "Too little detail to judge the sharpness." : `The picture is blurred (sharpness ${a.sharpness.toFixed(2)}, needs ${MIN_SHARPNESS}).` };
  if (!a.steady || a.steady.rotDeg > MAX_STEADY_ROT_DEG || a.steady.moveMm > MAX_STEADY_MOVE_MM)
    return {
      ok: false,
      code: "unsteady",
      bin,
      words: a.steady ? `The phone is moving (${a.steady.rotDeg.toFixed(1)}° and ${Math.round(a.steady.moveMm)} mm between frames).` : "Waiting for a few steady frames.",
    };
  return { ok: true, code: "ok", bin, words: `Ready: ${binWords(bin, thumb)}.` };
}

/** Angular distance from an azimuth to a sector's middle, degrees (0..180). */
function azDistance(az: number, b: Bin): number {
  const d = Math.abs(wrap(az) - (b.fromDeg + b.toDeg) / 2) % 360;
  return d > 180 ? 360 - d : d;
}

/** The next required bin to go to: the missing low sector nearest to the current azimuth. */
export function nearestMissingLow(filled: ReadonlySet<BinId>, azimuthDeg: number | null): Bin | null {
  const miss = REQUIRED_BINS.filter((b) => b.ring === "low" && !filled.has(b.id));
  if (!miss.length) return null;
  if (azimuthDeg === null) return miss[0];
  return miss.reduce((best, b) => (azDistance(azimuthDeg, b) < azDistance(azimuthDeg, best) ? b : best));
}

/** One line of plain guidance for the person holding the phone. */
export function guidance(a: LiveAnalysis, filled: ReadonlySet<BinId>, thumb: ThumbSide = null): string {
  if (a.markers === 0) return "Point the camera at the printed board so its black squares are in view.";
  if (a.markers < MIN_MARKERS || a.elevationDeg === null || a.azimuthDeg === null)
    return `Only ${a.markers} printed marker${a.markers === 1 ? "" : "s"} in view: step back a little or tilt the phone so more of the board's black squares show.`;
  const e = a.elevationDeg;
  const gate = captureGate(a, filled, thumb);
  const holdOrFix = () => (gate.code === "blurred" ? "The picture is blurred: hold the phone still, tap the screen to focus, or add light." : gate.code === "unsteady" ? "Hold the phone still." : "Hold still: taking this view.");
  if (!filled.has("top")) {
    if (e < TOP_MIN_ELEVATION_DEG) return `First the top view: hold the phone straight above the hand, looking down (now ${deg(e)} above the board, needs ${TOP_MIN_ELEVATION_DEG}° or more).`;
    return holdOrFix();
  }
  const next = nearestMissingLow(filled, a.azimuthDeg);
  if (next) {
    if (e > LOW_RING.maxDeg) return `Lower the phone until it is about level with the fingertips (${LOW_RING.minDeg} to ${LOW_RING.maxDeg}° above the board; now ${deg(e)}).`;
    if (e < LOW_RING.minDeg) return `Raise the phone a little (${LOW_RING.minDeg} to ${LOW_RING.maxDeg}° above the board; now ${deg(e)}).`;
    if (gate.code === "bin_filled") return `This side is done. Move round to ${sideWords((next.fromDeg + next.toDeg) / 2, thumb)} (${next.fromDeg}–${next.toDeg}°), keeping the phone low.`;
    return holdOrFix();
  }
  // every required view is taken
  if (gate.ok) return "Hold still: adding this optional view.";
  return 'All required views are taken. Optionally add middle-height views (25 to 45° above the board), or press "Build 3D hand".';
}
