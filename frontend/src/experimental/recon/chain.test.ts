// SIMULATED, end to end FROM PIXELS ONLY: rendered photos of the synthetic capsule hand resting on the printed board
// (multiview/scene.ts) go through marker detection, camera self-calibration and board pose (board/), then known-board
// segmentation, landmark triangulation, carving and measurement (multiview/). The chain is told nothing: not the focal
// length, not the distortion, not one camera pose. Compared with the capsule hand's exact dimensions.
// This proves the pieces fit together and the maths holds on clean renders. It says nothing about real phones, real
// prints, real hands or real accuracy.
import { describe, expect, it } from "vitest";
import { rotationAngleDeg } from "../reconstruction/linalg";
import { boardRig, makeBoardScene, projectLandmarks, renderView, SKIN_TONES } from "../multiview/scene";
import { reconstructFromImages, type ImageView } from "./chain";

const scene = makeBoardScene();
// A phone in landscape, 1280 x 720, an unknown-to-the-chain field of view and lens distortion.
const cameras = boardRig(scene, { width: 1280, height: 720, hfovDeg: 64, k1: -0.06, k2: 0.02, lowCount: 16, highCount: 0 });
const views: ImageView[] = cameras.map((c, i) => ({
  id: c.id,
  image: renderView(scene, c.intrinsics, c.pose, { skin: SKIN_TONES.medium, seed: i + 1 }).image,
  landmarks: projectLandmarks(scene.landmarks, c.intrinsics, c.pose, { noisePx: 2, seed: 100 + i }),
}));

describe("SIMULATED reconstruction from pixels only (no intrinsics, no poses given)", () => {
  it("calibrates the camera, places every view, and measures the synthetic hand", () => {
    const r = reconstructFromImages(views, { reconstruct: { voxelMm: 1.5 } });
    const cam = r.cameras!;
    const trueK = cameras[0].intrinsics;
    const fErr = (cam.intrinsics.fx - trueK.fx) / trueK.fx;
    const poseErr = cameras.map((c, i) => {
      const p = cam.views[i].pose;
      if (!p || cam.views[i].rejected) return null; // views the chain did not use
      const R = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => {
        // relative rotation R_est * R_true^T
        const a = Math.floor(k / 3), b = k % 3;
        let s = 0;
        for (let j = 0; j < 3; j++) s += p.R[a * 3 + j] * c.pose.R[b * 3 + j];
        return s;
      });
      const cEst = centre(p), cTrue = centre(c.pose);
      return { rotDeg: rotationAngleDeg(R), centreMm: Math.hypot(cEst[0] - cTrue[0], cEst[1] - cTrue[1], cEst[2] - cTrue[2]) };
    });
    const used = poseErr.filter((p): p is { rotDeg: number; centreMm: number } => p !== null);
    const rec = r.reconstruction;
    const T = scene.truth;
    const m = rec?.measurements;
    const e = (v: number | null | undefined, t: number) => (v === null || v === undefined ? "n/a" : (v - t >= 0 ? "+" : "") + (v - t).toFixed(1));
    console.log(
      [
        `SIMULATED pixels-only chain, ${views.length} views 1280x720:`,
        `  calibration ${cam.calibration.method}, focal error ${(fErr * 100).toFixed(3)} %, k1 est ${cam.intrinsics.k1?.toFixed(4)} (true ${trueK.k1}), rms ${"rmsPx" in cam.calibration ? cam.calibration.rmsPx.toFixed(2) : "n/a"} px`,
        `  views with pose: ${cam.views.filter((v) => v.pose && !v.rejected).length}/${views.length}; markers per view ${cam.views.map((v) => v.markers).join(",")}`,
        `  pose error over the ${used.length} views used: rotation max ${Math.max(...used.map((p) => p.rotDeg)).toFixed(3)} deg, camera centre max ${Math.max(...used.map((p) => p.centreMm)).toFixed(2)} mm`,
        `  views left out: ${cam.views.filter((v) => !v.pose || v.rejected).map((v) => `${v.id} (${v.rejected ?? "no pose"}; inconsistent markers ${v.inconsistentMarkers.join(",") || "none"})`).join("; ") || "none"}`,
        `  accepted ${rec?.accepted} [${rec?.reasons.join(", ")}]`,
        `  length ${e(m?.handLength.value, T.handLength)}, breadth ${e(m?.palmBreadth.value, T.palmBreadth)}, thickness ${e(m?.palmThickness.value, T.palmThickness)}, knuckle circ ${e(m?.circumferenceKnuckle.value, T.circumference)} mm`,
        `  fingers ${(["thumb", "index", "middle", "ring", "little"] as const).map((f) => `${f} ${e(m?.fingerLengths[f].value, T.fingerLengths[f])}`).join(", ")}`,
        `  support share ${JSON.stringify(rec?.supportShare)}`,
        `  timings detect ${(r.timingsMs.detect / 1000).toFixed(1)} s, calibrate ${r.timingsMs.calibrate.toFixed(0)} ms, pose ${r.timingsMs.pose.toFixed(0)} ms, reconstruct ${(r.timingsMs.reconstruct / 1000).toFixed(1)} s`,
      ].join("\n"),
    );
    expect(r.refused).toBeNull();
    expect(cam.calibration.assumed).toBe(false);
    expect(Math.abs(fErr)).toBeLessThan(0.01);
    expect(used.length).toBeGreaterThanOrEqual(12);
    expect(Math.max(...used.map((p) => p.rotDeg))).toBeLessThan(0.5); // the reconstruction needs better than ~0.5 degrees
    expect(rec?.accepted).toBe(true);
    expect(Math.abs(m!.handLength.value! - T.handLength)).toBeLessThan(3);
    expect(Math.abs(m!.palmThickness.value! - T.palmThickness)).toBeLessThan(5);
    expect(Math.abs(m!.circumferenceKnuckle.value! - T.circumference)).toBeLessThan(6);
    // Stage 5 (additive): the measurement report repeats the values with numeric uncertainties
    const rep = rec!.measurementReport!;
    expect(rep.byKey.hand_length.value).toBe(m!.handLength.value);
    expect(rep.byKey.hand_length.uncertainty!.standard).toBeGreaterThan(0);
    expect(rep.inputs.focalRel.origin === "SIMULATED" || rep.inputs.focalRel.origin === "RUNTIME").toBe(true);
    expect(rep.byKey.surface_area.value).toBeNull();
  }, 900_000);

  it("landmarks found in the top view only (as MediaPipe usually does): the hand frame is lifted from that view onto the mesh", () => {
    const topOnly = views.map((v) => (v.id === "top" ? v : { ...v, landmarks: null }));
    const r = reconstructFromImages(topOnly, { reconstruct: { voxelMm: 1.5 } });
    const rec = r.reconstruction!;
    const T = scene.truth;
    const m = rec.measurements!;
    const e = (v: number | null | undefined, t: number) => (v === null || v === undefined ? "n/a" : (v - t >= 0 ? "+" : "") + (v - t).toFixed(1));
    console.log(
      `SIMULATED top-view-only landmarks: reasons [${rec.reasons.join(", ")}], lifted from ${rec.liftedLandmarks?.viewId} (missed ${rec.liftedLandmarks?.missed.join(",") || "none"})
` +
        `  length ${e(m.handLength.value, T.handLength)}, breadth ${e(m.palmBreadth.value, T.palmBreadth)}, thickness ${e(m.palmThickness.value, T.palmThickness)}, knuckle circ ${e(m.circumferenceKnuckle.value, T.circumference)} mm; ` +
        (["thumb", "index", "middle", "ring", "little"] as const).map((f) => `${f} ${e(m.fingerLengths[f].value, T.fingerLengths[f])}`).join(", "),
    );
    expect(rec.reasons).toContain("hand_frame_from_one_view");
    expect(rec.reasons).not.toContain("no_hand_frame");
    expect(rec.measurementBasis).toMatch(/ONE view/);
    expect(Math.abs(m.handLength.value! - T.handLength)).toBeLessThan(5);
    expect(Math.abs(m.palmBreadth.value! - T.palmBreadth)).toBeLessThan(5);
  }, 900_000);

  it("refuses millimetres when the camera cannot be calibrated (one picture only)", () => {
    const r = reconstructFromImages(views.slice(0, 1), { reconstruct: { voxelMm: 1.5 } });
    expect(r.reconstruction).toBeNull();
    expect(r.refused).not.toBeNull();
  }, 120_000);
});

function centre(p: { R: readonly number[]; t: readonly number[] }): [number, number, number] {
  const { R, t } = p;
  return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
}
