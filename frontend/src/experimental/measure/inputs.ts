// Input uncertainty sets (EXPERIMENTAL). Every sigma states where it comes from:
//   SIMULATED = measured in one of our simulated tests (the test is cited; it is NOT a real-world figure);
//   ASSUMED   = nobody measured it (a stated guess to be replaced by measurement);
//   EXACT     = zero by construction of a simulation (e.g. the printed board's size in a rendered scene);
//   RUNTIME   = computed from the capture itself (e.g. the calibration's own covariance).
// Do not present any of these as real-world accuracy.
import type { ZhangCalibration } from "../board/calibrate";
import type { CaptureUncertainty, StatedSigma } from "./types";

export const stated = (value: number, origin: StatedSigma["origin"], source: string): StatedSigma => ({ value, origin, source });

const CHAIN_RUN = "recon/chain.test.ts console output recorded in recon/README.md (2026-11-08): 17 rendered 1280x720 views, pixels only";

/** The board route under the conditions our SIMULATED tests reproduce (clean renders, the synthetic capsule hand). */
export const BOARD_ROUTE_SIMULATED: CaptureUncertainty = {
  route: "board (SIMULATED conditions)",
  focalRel: stated(0.001, "SIMULATED", `${CHAIN_RUN}: focal error 0.096 % (one run); board/README.md section 5: capture-like view sets |focal error| max 0.065 %. Used as the sigma (one realisation, not a distribution)`),
  poseRotDeg: stated(0.14, "SIMULATED", `${CHAIN_RUN}: rotation error max 0.142 deg over the 16 views used (the max is used as the RMS: conservative)`),
  poseCentreMm: stated(1.56, "SIMULATED", `${CHAIN_RUN}: camera centre error max 1.56 mm (the max is used as the RMS: conservative)`),
  scaleRel: stated(0, "EXACT", "the printed board's size is exact by construction in the rendered scenes; a real print is not (see PHONE_BOARD_ASSUMED)"),
  scaleReference: "board_print",
  maskBoundaryPx: stated(0.6, "SIMULATED", "multiview/segment.test.ts (multiview/README.md table): known-board segmentation boundary mean 0.29 to 0.55 px at 640 px; mean 0.46 px at 12 deg, medium skin; sigma = mean |d| / 0.8 (half-normal) = 0.6 px"),
  landmarkPx: stated(2, "ASSUMED", "the 2D landmark noise the chain test INJECTS (recon/chain.test.ts noisePx 2); not a MediaPipe measurement"),
  landmark3dMm: stated(0.9, "SIMULATED", "multiview/landmarks.test.ts (multiview/README.md): 1.5 px noise over 17 views gives 3D RMS below 0.7 mm; scaled linearly to 2 px = 0.9 mm"),
};

/** The board route under conditions NOT simulated yet (a phone, a real print, a real hand). Mostly ASSUMED. */
export const PHONE_BOARD_ASSUMED: CaptureUncertainty = {
  route: "board (ASSUMED phone conditions)",
  focalRel: stated(0.001, "SIMULATED", `${CHAIN_RUN}; board/README.md section 5 (capture-like sets max 0.065 %). Kept: the board self-calibration was robust in every simulated set`),
  poseRotDeg: stated(0.5, "SIMULATED", "board/README.md (HARD imaging: blur 1.5 px + 4 px motion blur, noise 6): up to 0.5 deg error in views that have a pose"),
  poseCentreMm: stated(3, "SIMULATED", "board/README.md (HARD imaging): up to 3 mm camera error in views that have a pose"),
  scaleRel: stated(0.0074, "SIMULATED", "board/README.md section 6 coin print-scale check errors -0.95, -0.77, -0.38 % (RMS 0.74 %): how well the coin can verify that the board was printed at 100 %"),
  scaleReference: "board_print",
  maskBoundaryPx: stated(1.25, "ASSUMED", "no real-photo board segmentation has been scored; the composite GrabCut evaluation (segmentation/README.md) gave boundary mean 1.0 px, so sigma = 1.0 / 0.8 = 1.25 px is ASSUMED for real skin edges"),
  landmarkPx: stated(5, "ASSUMED", "multiview/README.md: real MediaPipe errors are 'several pixels' and correlated within a view; 5 px is a guess"),
  landmark3dMm: stated(2.3, "ASSUMED", "0.7 mm at 1.5 px (multiview/landmarks.test.ts) scaled linearly to 5 px; real errors are correlated, so this may be optimistic"),
};

/**
 * Input set for a BOARD-FREE route (structure from motion + coin scale). The caller MUST state the focal, pose, boundary
 * and landmark sigmas with their sources: no board-free figure has been measured by this module. The coin scale default
 * is the SIMULATED multi-view coin fit (coin/README.md, sceneScale.test.ts baseline).
 */
export function boardFreeUncertainty(p: {
  route?: string;
  focalRel: StatedSigma;
  poseRotDeg: StatedSigma;
  poseCentreMm: StatedSigma;
  maskBoundaryPx: StatedSigma;
  landmarkPx: StatedSigma;
  landmark3dMm: StatedSigma;
  coinScaleRel?: StatedSigma;
}): CaptureUncertainty {
  return {
    route: p.route ?? "board-free (structure from motion + coin scale)",
    focalRel: p.focalRel,
    poseRotDeg: p.poseRotDeg,
    poseCentreMm: p.poseCentreMm,
    scaleRel:
      p.coinScaleRel ??
      stated(0.0034, "SIMULATED", "coin/README.md multi-view coin scale (sceneScale.test.ts): baseline claimed total sigma 0.34 % with exact poses; pose noise 0.3 deg / 1 mm adds a +0.8 % bias NOT included here"),
    scaleReference: "coin",
    maskBoundaryPx: p.maskBoundaryPx,
    landmarkPx: p.landmarkPx,
    landmark3dMm: p.landmark3dMm,
  };
}

/** The board-route inputs for one capture: the calibration's own focal covariance (a LOWER bound, board/README.md section
 *  5) when it is larger than the SIMULATED floor, the rest from `base`. */
export function boardRouteFromCalibration(cal: Pick<ZhangCalibration, "intrinsics" | "std" | "rmsPx">, base: CaptureUncertainty = BOARD_ROUTE_SIMULATED): CaptureUncertainty {
  const rel = cal.std && Number.isFinite(cal.std.fx) && cal.intrinsics.fx > 0 ? cal.std.fx / cal.intrinsics.fx : 0;
  if (rel <= base.focalRel.value) return { ...base, route: `${base.route}; calibration covariance ${(rel * 100).toFixed(3)} % <= floor` };
  return {
    ...base,
    route: `${base.route}; focal from this capture's calibration`,
    focalRel: stated(rel, "RUNTIME", `this capture's self-calibration covariance (rms ${cal.rmsPx.toFixed(2)} px); a lower bound (board/README.md section 5)`),
  };
}
