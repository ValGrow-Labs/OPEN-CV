// Board flatness from the pictures (EXPERIMENTAL): is the printed sheet the flat plane every pose and the camera
// calibration assume? Read from the per-marker reprojection residuals of each view's board pose (chain.ts ViewCamera
// `markerResiduals`, from board/pose.ts with the CALIBRATED camera). A curled, folded or lifted sheet puts some markers
// above the plane: no single plane pose fits them all, so their corners miss by systematically more than detection noise.
//
// The verdict uses, per marker, the MEDIAN of its RMS corner residual over every view with a pose (views the chain
// rejected for a large residual included: they are the evidence), then the median and the worst of that per-marker map.
// Pixel limits are for a picture whose long side is 1280 px and scale with the long side.
//
// PROVISIONAL LIMITS (from SIMULATION only, boardFlatness.test.ts; never checked on a real print or phone):
//   pass    median <= 1.2 px and worst <= 2.0 px
//   warn    otherwise, while median <= 1.5 px and worst <= 3.0 px ("may not be flat": check the sheet)
//   fail    median > 1.5 px or worst > 3.0 px ("not flat": the result is not valid for validation)
//   not checked  fewer than 3 views with a pose, fewer than 6 markers seen, or an ASSUMED (not measured) focal length
//                (then residuals mix lens and focal errors with the sheet's shape); also not valid for validation.
// In the simulation a flat sheet rendered with blur and noise (multiview/scene.ts) gave median 0.78 / worst 0.91 px;
// ideal renders of a sheet bent by 1 mm at its edges about 0.8 px, 2 mm 1.4 to 1.7 px, 3 mm 2.0 to 2.6 px, 5 mm 3.4 px
// and more. A real flat print's residual level is unknown until the first phantom session measures it.
//
// The edge-versus-centre ratio (mean residual of the four corner markers, the ends of the top and bottom rows, over the
// mean of the middle markers of those rows) is REPORTED but does not decide the verdict: the pose's plane fit spreads a
// bend's error over every marker, and in the simulation the ratio rose only for a bend lifting the short edges (about
// 1.3 at 3 mm) and stayed near 1 for a bend lifting the long edges (there the right-hand column stood out instead).
import { BOARD, type BoardLayout } from "../board/spec";

export interface FlatnessView {
  id: string;
  /** The view has a board pose (residuals exist). */
  hasPose: boolean;
  markerResiduals: readonly { id: number; rmsPx: number; used: boolean }[];
}

export type FlatnessVerdict = "pass" | "warn" | "fail" | "not_checked";

export interface MarkerFlatness {
  id: number;
  /** Median over the views of this marker's RMS corner residual, px. */
  medianRmsPx: number;
  maxRmsPx: number;
  views: number;
  group: "corner" | "centre" | "other";
}

export interface BoardFlatness {
  verdict: FlatnessVerdict;
  worstMarkerRmsPx: number | null;
  medianMarkerRmsPx: number | null;
  edgeVsCentreRatio: number | null;
  perMarker: MarkerFlatness[];
  viewsUsed: number;
  /** Views with a pose whose residuals were left out of the reconstruction (pose residual over the chain's limit). */
  viewsRejectedForResidual: number;
  /** Limits applied, px at this picture size. */
  limitsPx: { passMedian: number; passWorst: number; failMedian: number; failWorst: number };
  /** Reasons in words (never empty). */
  reasons: string[];
  /** A failed or unchecked flatness makes a capture not valid for validation. */
  validForValidation: boolean;
}

/** Provisional limits (px for a 1280 px long side); see the file header. */
export const FLATNESS_LIMITS = {
  referenceLongSidePx: 1280,
  passMedianPx: 1.2,
  passWorstPx: 2.0,
  failMedianPx: 1.5,
  failWorstPx: 3.0,
  minViews: 3,
  minMarkers: 6,
} as const;

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Corner markers (the two ends of each long row) and centre markers (the row markers two or more places from either
 *  end), from the layout: markers sharing one y form a row; rows with at least 5 markers count. */
export function markerGroups(layout: BoardLayout = BOARD): Map<number, "corner" | "centre" | "other"> {
  const out = new Map<number, "corner" | "centre" | "other">(layout.markers.map((m) => [m.id, "other"]));
  const rows = new Map<number, typeof layout.markers>();
  for (const m of layout.markers) rows.set(m.y, [...(rows.get(m.y) ?? []), m]);
  for (const row of rows.values()) {
    if (row.length < 5) continue;
    const sorted = [...row].sort((a, b) => a.x - b.x);
    sorted.forEach((m, i) => out.set(m.id, i === 0 || i === sorted.length - 1 ? "corner" : i >= 2 && i <= sorted.length - 3 ? "centre" : "other"));
  }
  return out;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function boardFlatness(
  views: readonly FlatnessView[],
  opts: { imageLongSidePx: number; calibrationAssumed?: boolean; rejectedForResidual?: readonly string[]; layout?: BoardLayout },
): BoardFlatness {
  const L = FLATNESS_LIMITS;
  const k = Math.max(0.25, opts.imageLongSidePx / L.referenceLongSidePx);
  const limitsPx = { passMedian: r2(L.passMedianPx * k), passWorst: r2(L.passWorstPx * k), failMedian: r2(L.failMedianPx * k), failWorst: r2(L.failWorstPx * k) };
  const groups = markerGroups(opts.layout);
  const posed = views.filter((v) => v.hasPose && v.markerResiduals.length > 0);
  const byMarker = new Map<number, number[]>();
  for (const v of posed) for (const r of v.markerResiduals) if (Number.isFinite(r.rmsPx)) byMarker.set(r.id, [...(byMarker.get(r.id) ?? []), r.rmsPx]);
  const perMarker: MarkerFlatness[] = [...byMarker.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, xs]) => ({ id, medianRmsPx: median(xs), maxRmsPx: Math.max(...xs), views: xs.length, group: groups.get(id) ?? "other" }));
  const rejected = opts.rejectedForResidual ? posed.filter((v) => opts.rejectedForResidual!.includes(v.id)).length : 0;
  const base = { perMarker, viewsUsed: posed.length, viewsRejectedForResidual: rejected, limitsPx };

  const notChecked = (why: string): BoardFlatness => ({
    ...base,
    verdict: "not_checked",
    worstMarkerRmsPx: perMarker.length ? Math.max(...perMarker.map((m) => m.medianRmsPx)) : null,
    medianMarkerRmsPx: perMarker.length ? median(perMarker.map((m) => m.medianRmsPx)) : null,
    edgeVsCentreRatio: null,
    reasons: [`Board flatness could not be checked: ${why}.`, "Without this check the capture is not valid for validation."],
    validForValidation: false,
  });
  if (opts.calibrationAssumed) return notChecked("the camera's focal length is assumed, not measured, so the marker residuals mix lens and focal errors with the sheet's shape");
  if (posed.length < L.minViews) return notChecked(`only ${posed.length} picture(s) have a board pose (needs ${L.minViews})`);
  if (perMarker.length < L.minMarkers) return notChecked(`only ${perMarker.length} marker(s) were seen (needs ${L.minMarkers})`);

  const meds = perMarker.map((m) => m.medianRmsPx);
  const med = median(meds);
  const worstM = perMarker.reduce((a, b) => (b.medianRmsPx > a.medianRmsPx ? b : a));
  const worst = worstM.medianRmsPx;
  const corner = perMarker.filter((m) => m.group === "corner");
  const centre = perMarker.filter((m) => m.group === "centre");
  const mean = (ms: MarkerFlatness[]) => ms.reduce((s, m) => s + m.medianRmsPx, 0) / ms.length;
  const ratio = corner.length >= 2 && centre.length >= 2 && mean(centre) > 0 ? mean(corner) / mean(centre) : null;

  const figures = `median marker residual ${med.toFixed(2)} px, worst ${worst.toFixed(2)} px (marker ${worstM.id}) over ${posed.length} pictures`;
  const limits = `provisional limits: pass up to ${limitsPx.passMedian} px median and ${limitsPx.passWorst} px worst, fail above ${limitsPx.failMedian} px median or ${limitsPx.failWorst} px worst`;
  const reasons: string[] = [];
  let verdict: FlatnessVerdict;
  if (med > limitsPx.failMedian || worst > limitsPx.failWorst) {
    verdict = "fail";
    reasons.push(`The printed sheet is probably not flat (curled, folded or lifted): its markers do not lie on one plane (${figures}; ${limits}).`);
    reasons.push("Tape the sheet down at the corners or put it on a clipboard, then capture again. This capture is not valid for validation.");
  } else if (med > limitsPx.passMedian || worst > limitsPx.passWorst) {
    verdict = "warn";
    reasons.push(`The sheet may not be perfectly flat: the markers agree with one plane less well than expected (${figures}; ${limits}). Check that it lies flat with no curl at the edges.`);
  } else {
    verdict = "pass";
    reasons.push(`The printed sheet looks flat in the pictures: every marker agrees with one plane (${figures}; ${limits}).`);
  }
  if (rejected > 0) reasons.push(`${rejected} picture(s) were left out of the reconstruction because their markers miss the board's plane by more than the pose limit: often a sheet that is not flat.`);
  if (ratio !== null && ratio >= 1.5 && verdict !== "pass") reasons.push(`The corner markers miss the plane ${ratio.toFixed(1)} times more than the middle ones: the pattern of a sheet curling at its ends.`);
  return { ...base, verdict, worstMarkerRmsPx: worst, medianMarkerRmsPx: med, edgeVsCentreRatio: ratio, reasons, validForValidation: verdict === "pass" || verdict === "warn" };
}

/** The flatness of a chain result's cameras (null cameras: not checked). */
export function flatnessOfCameras(
  cameras: { calibration: { assumed: boolean }; intrinsics: { width: number; height: number }; views: readonly { id: string; pose: unknown; rejected: string | null; markerResiduals: readonly { id: number; rmsPx: number; used: boolean }[] }[] } | null,
  layout?: BoardLayout,
): BoardFlatness {
  if (!cameras) return boardFlatness([], { imageLongSidePx: FLATNESS_LIMITS.referenceLongSidePx, layout });
  const views = cameras.views.map((v) => ({ id: v.id, hasPose: !!v.pose, markerResiduals: v.markerResiduals }));
  return boardFlatness(views, {
    imageLongSidePx: Math.max(cameras.intrinsics.width, cameras.intrinsics.height),
    calibrationAssumed: cameras.calibration.assumed,
    rejectedForResidual: cameras.views.filter((v) => v.pose && v.rejected && /pose residual/.test(v.rejected)).map((v) => v.id),
    layout,
  });
}

export const FLATNESS_TITLES: Record<FlatnessVerdict, string> = {
  pass: "Flat: the markers agree with one plane",
  warn: "Check the sheet: it may not be flat",
  fail: "Not flat: the sheet is curled, folded or lifted",
  not_checked: "Flatness not checked",
};
