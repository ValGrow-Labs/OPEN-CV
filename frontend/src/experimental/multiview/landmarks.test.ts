// Landmark triangulation and the hand-moved check (SIMULATED: exact synthetic landmarks, Gaussian pixel noise).
import { describe, expect, it } from "vitest";
import type { Pt } from "../common";
import { perturbPose } from "../reconstruction/synthetic";
import { handFrameFromTriangulation, triangulateLandmarks, triangulatePoint, type LandmarkView } from "./landmarks";
import { boardRig, makeBoardScene, moveHand, projectLandmarks } from "./scene";

const scene = makeBoardScene();
const cams = boardRig(scene, { k1: 0.02 });
const views = (noisePx: number, f: (i: number) => Partial<LandmarkView> = () => ({})): LandmarkView[] =>
  cams.map((c, i) => ({ id: c.id, intrinsics: c.intrinsics, pose: c.pose, landmarks: projectLandmarks(scene.landmarks, c.intrinsics, c.pose, { noisePx, seed: 50 + i }), ...f(i) }));
const err3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe("landmark triangulation (SIMULATED)", () => {
  it("is exact without noise, distortion included", () => {
    const r = triangulateLandmarks(views(0));
    r.points.forEach((p, i) => expect(err3(p!, scene.landmarks[i])).toBeLessThan(1e-4));
    expect(r.handMoved).toBe(false);
  });

  it("DLT + refinement from two views", () => {
    const P = scene.landmarks[8];
    const obs = [cams[0], cams[5]].map((c) => {
      const q = projectLandmarks([P], c.intrinsics, c.pose)[0]!;
      return { K: c.intrinsics, pose: c.pose, u: q.x, v: q.y };
    });
    const s = triangulatePoint(obs)!;
    expect(Math.hypot(s.X[0] - P.x, s.X[1] - P.y, s.X[2] - P.z)).toBeLessThan(1e-4);
  });

  it("1.5 px noise over 17 views: points within about a millimetre, residuals near the noise, no view named", () => {
    const r = triangulateLandmarks(views(1.5));
    const errs = r.points.map((p, i) => err3(p!, scene.landmarks[i]));
    expect(Math.max(...errs)).toBeLessThan(1.5);
    expect(Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length)).toBeLessThan(0.7);
    expect(r.disagreeingViews).toEqual([]);
    for (const v of r.views) expect(v.medianPx!).toBeLessThan(3);
  });

  it("names the view in which the hand moved by 5 mm, and recovers the points without it", () => {
    const moved = moveHand(scene, [5, 0, 0]);
    const r = triangulateLandmarks(views(1.5, (i) => (i === 7 ? { landmarks: projectLandmarks(moved.landmarks, cams[7].intrinsics, cams[7].pose, { noisePx: 1.5, seed: 9 }) } : {})));
    expect(r.disagreeingViews).toEqual([cams[7].id]);
    expect(r.handMoved).toBe(true);
    const errs = r.points.map((p, i) => err3(p!, scene.landmarks[i]));
    expect(Math.max(...errs)).toBeLessThan(1.5);
    expect(Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length)).toBeLessThan(0.7);
    expect(r.views[7].looMedianPx!).toBeGreaterThan(r.thresholdPx);
  });

  it("sensitivity: which hand movements are caught at which landmark noise (report)", () => {
    const lines: string[] = [];
    for (const noise of [1, 2, 3, 5])
      for (const mm of [2, 5, 10]) {
        let caught = 0, falseAlarms = 0;
        const trials = 6;
        for (let k = 0; k < trials; k++) {
          const vi = 1 + ((k * 5) % 16);
          const moved = moveHand(scene, [mm, 0, 0]);
          const r = triangulateLandmarks(
            cams.map((c, i) => ({ id: c.id, intrinsics: c.intrinsics, pose: c.pose, landmarks: projectLandmarks((i === vi ? moved : scene).landmarks, c.intrinsics, c.pose, { noisePx: noise, seed: 1000 * k + i }) })),
          );
          if (r.disagreeingViews.includes(cams[vi].id)) caught++;
          falseAlarms += r.disagreeingViews.filter((id) => id !== cams[vi].id).length;
        }
        lines.push(`| ${noise} | ${mm} | ${caught}/${trials} | ${falseAlarms} |`);
      }
    console.log(["SIMULATED hand-moved check (17 views, one view moved along the hand axis):", "| landmark noise px | hand moved mm | moved view named | other views named (false alarms) |", "|---|---|---|---|", ...lines].join(String.fromCharCode(10)));
  }, 120_000);

  it("a wrong board pose in one view (2 degrees) is named the same way: the check cannot tell why a view disagrees", () => {
    const r = triangulateLandmarks(views(1.5, (i) => (i === 3 ? { pose: perturbPose(cams[3].pose, 2, 0, 4) } : {})));
    expect(r.disagreeingViews).toEqual([cams[3].id]);
  });

  it("handles missing views and partial detections; a landmark seen once is not triangulated", () => {
    const r = triangulateLandmarks(
      views(1, (i) => {
        if (i % 3 === 0) return { landmarks: null };
        const lm = projectLandmarks(scene.landmarks, cams[i].intrinsics, cams[i].pose, { noisePx: 1, seed: i, dropProbability: 0.3 }) as (Pt | null)[];
        if (i !== 1) lm[20] = null; // the little fingertip only in view 1
        return { landmarks: lm };
      }),
    );
    expect(r.points[20]).toBeNull();
    expect(r.notes.join(" ")).toContain("20");
    for (let i = 0; i < 20; i++) expect(err3(r.points[i]!, scene.landmarks[i])).toBeLessThan(1.5);
    const hf = handFrameFromTriangulation(r.points);
    expect(hf.frame).not.toBeNull();
    expect(hf.fingers.map((f) => f.name)).toEqual(["thumb", "index", "middle", "ring"]);
  });

  it("the landmark frame matches the board placement: +y along board +x, +x along board +y, +z down into the board", () => {
    const hf = handFrameFromTriangulation(triangulateLandmarks(views(0)).points);
    const f = hf.frame!;
    expect(f.axisY[0]).toBeCloseTo(1, 6);
    expect(f.axisX[1]).toBeCloseTo(1, 6);
    expect(f.axisZ[2]).toBeCloseTo(-1, 6);
    expect(f.knuckleYMm).toBeCloseTo(100, 4);
    expect(hf.fingers).toHaveLength(5);
  });
});
