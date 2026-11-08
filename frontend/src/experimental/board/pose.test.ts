// Board pose from detected markers, on rendered views with known truth. SIMULATED.
import { describe, expect, it } from "vitest";
import type { Intrinsics } from "../common";
import { cameraCenter, intrinsicsFromHfov, rotationAngleBetween } from "../geometry/camera";
import { detectMarkers, type MarkerDetection } from "./detect";
import { estimateBoardPose, viewAngles } from "./pose";
import { handOccluders, orbitPose, projectedMarkerCorners, renderBoardView, toBoardUnits, type RenderOptions } from "./render";

const K: Intrinsics = { ...intrinsicsFromHfov(1280, 720, 65), k1: -0.08, k2: 0.02 };
const HAND_CENTRE = { x: 124.5, y: 105, z: 0 };
const STANDARD: RenderOptions = { blurSigmaPx: 0.8, noiseSigma: 3, light: { gradientX: 0.15, vignette: 0.2 } };

function centreError(a: ReturnType<typeof orbitPose>, b: ReturnType<typeof orbitPose>): number {
  const ca = cameraCenter(a), cb = cameraCenter(b);
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
}

describe("board pose (SIMULATED)", () => {
  it("a 45-degree view: pose within hundredths of a degree and tenths of a millimetre; elevation and azimuth read back", () => {
    const truth = orbitPose(HAND_CENTRE, 380, 45, 300);
    const det = detectMarkers(renderBoardView(K, truth, { ...STANDARD, seed: 11 }));
    const r = estimateBoardPose(K, det.markers);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.markersUsed).toBeGreaterThanOrEqual(12);
    expect(rotationAngleBetween(r.pose.R, truth.R)).toBeLessThan(0.05);
    expect(centreError(r.pose, truth)).toBeLessThan(0.5);
    expect(r.reprojRmsPx).toBeLessThan(0.2);
    expect(r.elevationDeg).toBeCloseTo(45, 0);
    expect(r.azimuthDeg).toBeCloseTo(300, 0);
    expect(r.distanceMm).toBeCloseTo(380, -1);
    expect(r.ambiguityWarning).toBeNull();
    expect(r.residuals.every((m) => m.used)).toBe(true);
  });

  it("a low view (12 degrees) with the hand on the board still gives a usable pose from the near markers", () => {
    const truth = orbitPose(HAND_CENTRE, 350, 12, 270);
    const det = detectMarkers(renderBoardView(K, truth, { ...STANDARD, occluders: handOccluders(), seed: 12 }));
    const r = estimateBoardPose(K, det.markers);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.markersUsed).toBeGreaterThanOrEqual(6);
    expect(rotationAngleBetween(r.pose.R, truth.R)).toBeLessThan(0.3);
    expect(centreError(r.pose, truth)).toBeLessThan(3);
    expect(r.elevationDeg).toBeGreaterThan(10);
    expect(r.elevationDeg).toBeLessThan(14);
  });

  it("drops a marker whose corners are wrong (a misread id) and reports its residual", () => {
    const truth = orbitPose(HAND_CENTRE, 400, 60, 250);
    const det = detectMarkers(renderBoardView(K, truth, { ...STANDARD, seed: 13 }));
    const bad: MarkerDetection[] = det.markers.map((m) => (m.id === 4 ? { ...m, id: 12 } : m)).filter((m, i, a) => a.findIndex((k) => k.id === m.id) === i);
    const r = estimateBoardPose(K, bad);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.droppedIds).toContain(12);
    expect(r.residuals.find((m) => m.id === 12)!.rmsPx).toBeGreaterThan(20);
    expect(rotationAngleBetween(r.pose.R, truth.R)).toBeLessThan(0.05);
  });

  it("refuses without markers; one marker gives a (weak) pose", () => {
    expect(estimateBoardPose(K, [])).toMatchObject({ ok: false, reason: "too_few_markers" });
    const truth = orbitPose(HAND_CENTRE, 380, 50, 250);
    const corners = projectedMarkerCorners(K, toBoardUnits(truth)).get(9)!;
    const one: MarkerDetection = {
      id: 9,
      corners: corners as MarkerDetection["corners"],
      rawCorners: corners as MarkerDetection["corners"],
      bitErrors: 0,
      borderErrors: 0,
      rotation: 0,
      edgeContrast: 100,
      cellContrast: 100,
      edgeFitRmsPx: 0,
      refined: true,
      areaPx: 1000,
    };
    const r = estimateBoardPose(K, [one]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(rotationAngleBetween(r.pose.R, truth.R)).toBeLessThan(0.01);
  });

  it("viewAngles: straight above is 90 degrees; the azimuth follows the camera round", () => {
    expect(viewAngles(orbitPose(HAND_CENTRE, 300, 90, 0), HAND_CENTRE).elevationDeg).toBeCloseTo(90, 6);
    for (const az of [0, 90, 135, 270]) expect(viewAngles(orbitPose(HAND_CENTRE, 300, 20, az), HAND_CENTRE).azimuthDeg).toBeCloseTo(az, 6);
  });
});
