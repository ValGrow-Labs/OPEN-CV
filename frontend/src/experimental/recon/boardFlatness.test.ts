// The board-flatness check: the verdict logic on hand-made residuals, then SIMULATED renders of a FLAT and a CURLED
// sheet (curledBoardRender.ts: per-pixel ray casting onto a cylindrically bent sheet, lens distortion, blur 0.7 px, noise
// 2.5 grey levels as multiview/scene.ts) through the chain's own calibration and poses (estimateCameras), and through the
// page's live check (live marker detection on half-size frames, the first three views only). SIMULATED: a real sheet
// curls unevenly, a real phone adds compression and rolling shutter; the limits are provisional.
import { describe, expect, it } from "vitest";
import { orbitPose } from "../board/render";
import { detectMarkers } from "../board/detect";
import { BOARD } from "../board/spec";
import { intrinsicsFromHfov } from "../geometry/camera";
import { boardFlatness, FLATNESS_LIMITS, flatnessOfCameras, markerGroups, type FlatnessView } from "./boardFlatness";
import { consistentMarkers, estimateCameras } from "./chain";
import { curledPoint, curlRadius, renderCurledBoard, type Curl } from "./curledBoardRender";
import { liveFlatness } from "./page/flatnessWorker";
import { boardRig, makeBoardScene, renderView, SKIN_TONES } from "../multiview/scene";

const view = (id: string, res: Record<number, number>, hasPose = true): FlatnessView => ({
  id,
  hasPose,
  markerResiduals: Object.entries(res).map(([k, v]) => ({ id: Number(k), rmsPx: v, used: true })),
});
const uniform = (v: number, ids = [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15]) => Object.fromEntries(ids.map((i) => [i, v]));
const three = (res: Record<number, number>) => [view("a", res), view("b", res), view("c", res)];

describe("board flatness verdict (hand-made residuals)", () => {
  it("groups the corner and middle markers from the layout", () => {
    const g = markerGroups(BOARD);
    // top row 0..6 left to right, right column 7, 8, bottom row 9..15 right to left
    const of = (kind: string) => [...g.entries()].filter(([, v]) => v === kind).map(([k]) => k).sort((a, b) => a - b);
    expect(of("corner")).toEqual([0, 6, 9, 15]);
    expect(of("centre")).toEqual([2, 3, 4, 11, 12, 13]);
    expect(g.get(7)).toBe("other");
  });

  it("passes small residuals, warns in between, fails large ones, and scales the limits with the picture", () => {
    const at = (v: number, long = 1280) => boardFlatness(three(uniform(v)), { imageLongSidePx: long });
    expect(at(0.5).verdict).toBe("pass");
    expect(at(1.3).verdict).toBe("warn");
    expect(at(1.6).verdict).toBe("fail");
    expect(at(1.6).validForValidation).toBe(false);
    expect(at(1.3).validForValidation).toBe(true);
    expect(at(1.6, 1920).verdict).toBe("pass"); // 1.6 px on a 1920 px picture is 1.07 px at 1280
    expect(at(1.6).reasons.join(" ")).toMatch(/not flat.*not valid for validation/);
  });

  it("fails on one badly bent marker even when the median is fine", () => {
    const f = boardFlatness(three({ ...uniform(0.4), 15: 3.5 }), { imageLongSidePx: 1280 });
    expect(f.verdict).toBe("fail");
    expect(f.worstMarkerRmsPx).toBeCloseTo(3.5);
    expect(f.reasons[0]).toContain("marker 15");
  });

  it("aggregates a marker over views by its median (one occluded view does not decide)", () => {
    const f = boardFlatness([view("a", { ...uniform(0.4), 3: 6 }), view("b", uniform(0.4)), view("c", uniform(0.4))], { imageLongSidePx: 1280 });
    expect(f.verdict).toBe("pass");
    expect(f.perMarker.find((m) => m.id === 3)).toMatchObject({ medianRmsPx: 0.4, maxRmsPx: 6, views: 3 });
  });

  it("reports the corner-versus-middle ratio", () => {
    const f = boardFlatness(three({ ...uniform(1), 0: 2, 6: 2, 9: 2, 15: 2 }), { imageLongSidePx: 1280 });
    expect(f.edgeVsCentreRatio).toBeCloseTo(2);
  });

  it("never passes silently: too few views, too few markers, or an assumed focal length are 'not checked' and not valid", () => {
    const two = boardFlatness([view("a", uniform(0.2)), view("b", uniform(0.2)), view("c", uniform(0.2), false)], { imageLongSidePx: 1280 });
    expect(two.verdict).toBe("not_checked");
    expect(two.validForValidation).toBe(false);
    expect(two.reasons[0]).toMatch(/only 2 picture/);
    const few = boardFlatness([view("a", { 0: 0.2, 1: 0.2 }), view("b", { 0: 0.2 }), view("c", { 2: 0.2 })], { imageLongSidePx: 1280 });
    expect(few.verdict).toBe("not_checked");
    expect(boardFlatness(three(uniform(0.2)), { imageLongSidePx: 1280, calibrationAssumed: true }).verdict).toBe("not_checked");
    expect(flatnessOfCameras(null).verdict).toBe("not_checked");
    expect(boardFlatness([], { imageLongSidePx: 1280 }).reasons.length).toBeGreaterThan(0);
  });

  it("counts the views the chain left out for their pose residual", () => {
    const f = flatnessOfCameras({
      calibration: { assumed: false },
      intrinsics: { width: 1280, height: 720 },
      views: ["a", "b", "c"].map((id, i) => ({ id, pose: {}, rejected: i === 2 ? "pose residual 3.10 px (limit 1.5)" : null, markerResiduals: view(id, uniform(i === 2 ? 3.1 : 0.5)).markerResiduals })),
    });
    expect(f.viewsRejectedForResidual).toBe(1);
    expect(f.reasons.join(" ")).toMatch(/1 picture\(s\) were left out/);
  });
});

describe("the curled-sheet renderer (test support)", () => {
  it("bends the sheet without stretching it: the edges rise by the asked lift, the middle line stays on the table", () => {
    const R = curlRadius(105, 4);
    expect(R * (1 - Math.cos(105 / R))).toBeCloseTo(4, 6);
    expect(curledPoint(150, 210, { axis: "x", edgeLiftMm: 4 })[2]).toBeCloseTo(4, 6);
    expect(curledPoint(150, 105, { axis: "x", edgeLiftMm: 4 })[2]).toBeCloseTo(0, 9);
    expect(curledPoint(0, 50, { axis: "y", edgeLiftMm: 3 })[2]).toBeCloseTo(3, 6);
    expect(curledPoint(10, 20, { axis: "x", edgeLiftMm: 0 })).toEqual([10, 20, 0]);
    // arc length preserved: a 30 mm marker side across the bend stays 30 mm along the paper, a little shorter as a chord
    const a = curledPoint(19, 172, { axis: "x", edgeLiftMm: 5 });
    const b = curledPoint(19, 202, { axis: "x", edgeLiftMm: 5 });
    const chord = Math.hypot(a[1] - b[1], a[2] - b[2]);
    expect(chord).toBeLessThan(30);
    expect(chord).toBeGreaterThan(29.9);
  });
});

// ------------------------------------------------------------------------------------------------ SIMULATED renders
const K = { ...intrinsicsFromHfov(1280, 720, 64), k1: -0.06, k2: 0.02 };
const T = { x: 124.5, y: 105, z: 10 };
// one view from above, then six low views round the hand area (the page's low ring, every other sector)
const POSES = [orbitPose(T, 420, 78, 270), ...[15, 75, 135, 195, 255, 315].map((a) => orbitPose(T, 340, a === 195 ? 15 : 12, a))];

// Long synchronous renders starve vitest's worker RPC ("Timeout calling onTaskUpdate"): yield between them.
const breathe = () => new Promise((r) => setTimeout(r, 0));

async function simulate(curl: Curl) {
  const images = [];
  for (let i = 0; i < POSES.length; i++) {
    images.push(renderCurledBoard(K, POSES[i], curl, { blurSigmaPx: 0.7, noiseSigma: 2.5, seed: 10 + i }));
    await breathe();
  }
  const est = estimateCameras(images.map((image, i) => ({ id: `v${i}`, image })));
  const built = flatnessOfCameras(est.cameras);
  await breathe();
  const live = liveFlatness({
    width: 1280,
    height: 720,
    views: images.slice(0, 3).map((img, i) => ({ id: `v${i}`, markers: consistentMarkers(detectMarkers(img, { decimate: 2 }).markers).kept.map((m) => ({ id: m.id, corners: m.corners })) })),
  });
  const cal = est.cameras.calibration;
  console.log(
    `SIMULATED board flatness, sheet bent ${curl.edgeLiftMm} mm (${curl.axis === "x" ? "long edges lift" : "short edges lift"}), ${images.length} views 1280x720:\n` +
      `  after the build: ${built.verdict}, median ${built.medianMarkerRmsPx?.toFixed(2)} px, worst ${built.worstMarkerRmsPx?.toFixed(2)} px, corner/middle ratio ${built.edgeVsCentreRatio?.toFixed(2)}, views left out for residual ${built.viewsRejectedForResidual}/${built.viewsUsed}; calibration rms ${cal.assumed ? "assumed" : cal.rmsPx.toFixed(2)} px, fx ${est.cameras.intrinsics.fx.toFixed(1)} (true ${K.fx.toFixed(1)})\n` +
      `  live (first 3 views): ${live.verdict}, median ${live.medianMarkerRmsPx?.toFixed(2)} px, worst ${live.worstMarkerRmsPx?.toFixed(2)} px\n` +
      `  per marker: ${built.perMarker.map((m) => `${m.id}:${m.medianRmsPx.toFixed(2)}`).join(" ")}`,
  );
  return { built, live };
}

describe("SIMULATED: flat and curled sheets through the chain's calibration and poses", () => {
  it("passes a flat sheet", async () => {
    const { built, live } = await simulate({ axis: "x", edgeLiftMm: 0 });
    expect(built.verdict).toBe("pass");
    expect(built.validForValidation).toBe(true);
    expect(built.medianMarkerRmsPx!).toBeLessThan(FLATNESS_LIMITS.passMedianPx);
    expect(live.verdict).toBe("pass");
  }, 300_000);

  for (const curl of [
    { axis: "x", edgeLiftMm: 3 },
    { axis: "x", edgeLiftMm: 5 },
    { axis: "y", edgeLiftMm: 3 },
    { axis: "y", edgeLiftMm: 5 },
  ] as Curl[])
    it(`flags a sheet whose ${curl.axis === "x" ? "long" : "short"} edges are lifted ${curl.edgeLiftMm} mm`, async () => {
      const { built, live } = await simulate(curl);
      expect(built.verdict).toBe("fail");
      expect(built.validForValidation).toBe(false);
      expect(built.reasons[0]).toMatch(/not flat/);
      expect(live.verdict).toBe("fail");
    }, 300_000);

  it("passes the flat board of the chain's own test scene (the capsule hand on it, shading, blur 0.7 px, noise 2.5)", async () => {
    const scene = makeBoardScene();
    const cams = boardRig(scene, { width: 1280, height: 720, hfovDeg: 64, k1: -0.06, k2: 0.02, lowCount: 8, highCount: 0 });
    const images = [];
    for (let i = 0; i < cams.length; i++) {
      images.push({ id: cams[i].id, image: renderView(scene, cams[i].intrinsics, cams[i].pose, { skin: SKIN_TONES.medium, seed: i + 1 }).image });
      await breathe();
    }
    const f = flatnessOfCameras(estimateCameras(images).cameras);
    console.log(`SIMULATED board flatness, multiview/scene.ts flat board with the hand, ${images.length} views: ${f.verdict}, median ${f.medianMarkerRmsPx?.toFixed(2)} px, worst ${f.worstMarkerRmsPx?.toFixed(2)} px, corner/middle ratio ${f.edgeVsCentreRatio?.toFixed(2)}`);
    expect(f.verdict).toBe("pass");
  }, 300_000);
});
