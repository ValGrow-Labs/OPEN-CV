// Hand-made outcomes for the unit tests of the EXPERIMENTAL board-capture page (not used by the page). Shapes follow
// recon/chain.ts and multiview/reconstruct.ts; the values are invented and mean nothing.
import type { Quantity } from "../../common";
import type { HandMeasurements } from "../../reconstruction/measure";
import { boardLimits } from "../../multiview/reconstruct";
import type { ChainResult } from "../chain";
import type { Capture, CoinCheckSummary, ReconOutcome } from "./types";

const q = (value: number | null, unit: Quantity["unit"], basis: Quantity["basis"], note = ""): Quantity => ({ value, unit, basis, note });

/** As a board capture reports them: multiview/reconstruct.ts boardLimits applied (no hand surface area; the knuckle
 *  circumference an UPPER BOUND). */
export function fakeMeasurements(): HandMeasurements {
  return boardLimits(rawMeasurements())!;
}

/** Without the board's limits (as the generic measurement gives them). */
export function rawMeasurements(): HandMeasurements {
  return {
    handLength: q(187.42, "mm", "model", "wrist plane to the farthest point along the hand axis"),
    palmBreadth: q(84.1, "mm", "model"),
    palmThickness: q(26.3, "mm", "model"),
    circumferenceKnuckle: q(214.62, "mm", "direct", "perimeter of the section at the knuckle line"),
    fingerLengths: { thumb: q(60.2, "mm", "model"), index: q(71, "mm", "model"), middle: q(79.9, "mm", "model"), ring: q(74.4, "mm", "model"), little: q(58.8, "mm", "model") },
    surfaceArea: q(46123.4, "mm2", "direct", "sum of the triangle areas"),
    frameSource: "landmarks",
    notes: ["Experimental and unvalidated: no result has been compared with a physical measurement."],
  };
}

export function fakeCaptures(n = 3): Capture[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `v${String(i + 1).padStart(2, "0")}-${i === 0 ? "top" : `low-${i - 1}`}`,
    bin: (i === 0 ? "top" : `low-${i - 1}`) as Capture["bin"],
    width: 8,
    height: 4,
    pixels: new Uint8ClampedArray(8 * 4 * 4).fill(200),
    landmarks: i === 2 ? null : Array.from({ length: 21 }, (_, k) => ({ x: k, y: k / 2 })),
    handedness: null,
    markerCorners: [],
    markers: 6 + i,
    elevationDeg: i === 0 ? 88 : 12,
    azimuthDeg: 15 + 30 * i,
    sharpness: 1.2,
    trigger: "auto",
    capturedAt: "2026-11-08T10:00:00.000Z",
    thumb: null,
  }));
}

export function fakeOutcome(opts: { refused?: boolean; accepted?: boolean; measurements?: boolean; coin?: CoinCheckSummary | null; residualPx?: number; frame?: "triangulated" | "one_view" } = {}): ReconOutcome {
  const caps = fakeCaptures();
  const pose = { R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [-100, 100, 400] };
  const cameras = {
    calibration: {
      ok: true,
      method: "zhang",
      assumed: false,
      intrinsics: { fx: 1023.2, fy: 1023.2, cx: 640, cy: 360, width: 1280, height: 720, k1: -0.0635 },
      model: { aspect: "square", principalPoint: "center", distortion: "k1" },
      rmsPx: 0.78,
      perViewRmsPx: [0.7, 0.8, 0.9],
      poses: [],
      std: { fx: 1.1, fy: null, cx: null, cy: null, k1: 0.002, k2: null },
      closedFormFocalPx: 1010,
      closedFormGeneral: null,
      degeneracy: { degenerate: false, tiltsDeg: [], normalSpreadDeg: 60, reasons: [] },
      iterations: 9,
      warnings: [],
    },
    intrinsics: { fx: 1023.2, fy: 1023.2, cx: 640, cy: 360, width: 1280, height: 720, k1: -0.0635 },
    views: caps.map((c, i) => ({
      id: c.id,
      markers: i === 2 ? 2 : 10,
      inconsistentMarkers: i === 1 ? [4] : [],
      detectMs: 120,
      pose: i === 2 ? null : pose,
      poseRmsPx: i === 2 ? null : 0.4,
      elevationDeg: i === 2 ? null : c.elevationDeg + 0.5,
      azimuthDeg: i === 2 ? null : c.azimuthDeg,
      distanceMm: 340,
      rejected: i === 2 ? "only 2 consistent marker(s) (needs 3)" : null,
      markerResiduals: i === 2 ? [] : Array.from({ length: 10 }, (_, k) => ({ id: k, rmsPx: opts.residualPx ?? 0.3 + 0.02 * k, used: k !== 9 })),
    })),
  };
  const mesh = { vertices: Float32Array.from([0, 0, 0, 100, 0, 0, 0, 50, 0, 0, 0, 20]), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) };
  const reasons = [...(opts.accepted === false ? ["sides_not_observed", "views_disagree"] : []), ...(opts.frame === "one_view" ? ["hand_frame_from_one_view"] : [])];
  const quality = {
    accepted: opts.accepted !== false,
    reasons: reasons.filter((r) => r !== "views_disagree"),
    metrics: { views: 2, coverageRadiusDeg: 0, maxAzimuthGapDeg: 40, completeness: 0.7, unconstrainedSurface: 0.1, meanIoU: 0.95, minIoU: 0.9, ious: [0.95, 0.95], topology: { vertices: 4, triangles: 4, edges: 6, boundaryEdges: 0, nonManifoldEdges: 0, holes: 0, components: 1, watertight: true }, boundsContact: null, truncatedSurface: 0, lowestElevationDeg: 33.2, planeNormal: [0, 0, 1] },
    thresholds: { minViews: 3, maxAzimuthGapDeg: 100, minCompleteness: 0.5, minMeanIoU: 0.9, minMinIoU: 0.8, maxUnconstrainedSurface: 0.6, maxComponents: 1, requireWatertight: true, maxTruncatedSurface: 0.05, maxLowestElevationDeg: 20 },
  };
  const reconstruction = opts.refused
    ? null
    : {
        ok: true,
        volume: { min: [0, 34, 0], max: [229, 176, 80] },
        voxelMm: 1.5,
        mesh,
        confidence: Float32Array.from([0, 0.5, 1, 1]),
        support: Uint8Array.from([2, 2, 0, 1]),
        supportLabels: ["observed", "implied", "support_plane", "volume_cut", "truncated"],
        supportShare: { observed: 0.25, implied: 0.25, support_plane: 0.5, volume_cut: 0, truncated: 0 },
        pointCloud: { points: mesh.vertices, labels: Uint8Array.from([2, 2, 0, 1]) },
        quality,
        accepted: opts.accepted !== false,
        reasons,
        measurements: opts.measurements === false ? null : fakeMeasurements(),
        measurementBasis: opts.measurements === false ? "no hand frame: no (or too few) triangulated landmarks, so no measurements; the mesh is still the visual hull" : "mesh: visual hull; hand frame: landmarks",
        frame: opts.frame ? { origin: [40, 105, 12], axisX: [0, 1, 0], axisY: [1, 0, 0], axisZ: [0, 0, 1], knuckleYMm: 95.5, source: "landmarks" } : null,
        fingers: opts.frame ? [{ name: "index", base: [135, 125, 10], dir: [1, 0.05, 0] }, { name: "middle", base: [138, 106, 10], dir: [1, 0, 0] }] : [],
        freeSurfaceAreaMm2: 35000,
        hullVolumeMm3: 300000,
        views: caps.slice(0, 2).map((c, i) => ({ id: c.id, used: i === 0, ...(i === 1 ? { rejected: "named by the hand-moved check (its landmarks disagree with the other views)" } : {}), segmented: true, handPixels: 1000, knownFraction: 0.98, unknownInVolume: 0.01, segmentation: null, reprojectionIoU: i === 0 ? 0.951 : null, knownHandPixels: 900, landmarks: 21, landmarkMedianPx: 1.5 })),
        landmarks: {
          points: Array.from({ length: 21 }, (_, k) => ({ x: k, y: 1, z: 2 })),
          landmarks: [],
          views: caps.slice(0, 2).map((c, i) => ({ id: c.id, index: i, observations: 21, medianPx: 1.2 + i, rmsPx: 1.5, looMedianPx: 1.4 + 8 * i, looShiftPx: 1, disagrees: i === 1 })),
          disagreeingViews: [caps[1].id],
          handMoved: true,
          thresholdPx: 4,
          shiftThresholdPx: 3,
          notes: [],
        },
        timingsMs: { segment: 900, triangulate: 20, carve: 300, mesh: 400, quality: 700, measure: 100, total: 2500 },
      };
  const chain = {
    cameras,
    reconstruction,
    refused: opts.refused ? "camera_not_calibrated" : null,
    refusalWords: opts.refused ? "The camera's focal length could not be measured from these pictures (they need different tilts of the board). An assumed focal length would scale every millimetre wrongly, so nothing is measured." : null,
    timingsMs: { detect: 1500, calibrate: 700, pose: 200, reconstruct: 2500, total: 4900 },
  } as unknown as ChainResult;
  const coin: CoinCheckSummary | null =
    opts.coin === undefined ? { ok: true, viewId: caps[0].id, referenceDiameterMm: 23, thicknessMm: null, diameterMm: 23.1, circleDiameterMm: 23.3, printScale: 23 / 23.1, residualMm: 0.05, centerOffsetMm: 0.4, elevationDeg: 88 } : opts.coin;
  return { chain, coin, timingsMs: { chain: 4900, coin: 30, total: 4930 } };
}
