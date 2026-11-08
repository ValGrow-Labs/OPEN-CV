// Marker detection on RENDERED board images with known truth (render.ts). SIMULATED: these tests check the detector's
// logic and its accuracy on ideal synthetic images, not on real phones or real prints.
import { describe, expect, it } from "vitest";
import type { Intrinsics, Pt } from "../common";
import { intrinsicsFromHfov } from "../geometry/camera";
import { adaptiveThreshold, connectedComponents, convexHull, detectMarkers, polygonArea, traceContour } from "./detect";
import { toGray, type RgbaImage } from "./image";
import { orbitPose, projectedMarkerCorners, renderBoardView, toBoardUnits, type Ellipsoid, type RenderOptions } from "./render";
import { BOARD, type BoardLayout } from "./spec";

const K: Intrinsics = { ...intrinsicsFromHfov(1280, 720, 65), k1: -0.08, k2: 0.02 };
const HAND_CENTRE = { x: 124.5, y: 105, z: 0 };
const STANDARD: RenderOptions = { blurSigmaPx: 0.8, noiseSigma: 3, light: { gradientX: 0.15, vignette: 0.2 } };

function cornerErrors(det: ReturnType<typeof detectMarkers>, truth: Map<number, (Pt | null)[]>): number[] {
  const out: number[] = [];
  for (const m of det.markers) {
    const t = truth.get(m.id)!;
    m.corners.forEach((p, i) => out.push(Math.hypot(p.x - t[i]!.x, p.y - t[i]!.y)));
  }
  return out;
}
const rms = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);

describe("image primitives", () => {
  it("threshold, components, contour and hull find a dark square", () => {
    const W = 40, H = 30;
    const g = { width: W, height: H, data: new Float32Array(W * H).fill(220) };
    for (let y = 8; y < 20; y++) for (let x = 10; x < 25; x++) g.data[y * W + x] = 30;
    const mask = adaptiveThreshold(g, 15, 7);
    const { labels, comps } = connectedComponents(mask, W, H);
    expect(comps.length).toBe(1);
    expect(comps[0]).toMatchObject({ x0: 10, y0: 8, x1: 24, y1: 19 });
    const contour = traceContour(labels, W, H, 1, comps[0].start, 1000);
    const hull = convexHull(contour);
    expect(hull.length).toBe(4);
    expect(Math.abs(polygonArea(hull))).toBeCloseTo(14 * 11, 6); // pixel centres of the boundary
  });
});

describe("marker detection on rendered views (SIMULATED)", () => {
  it("from straight above: every visible marker, right ids, corners in the printed order to about 0.1 px", () => {
    const pose = orbitPose(HAND_CENTRE, 400, 90, 270);
    const img = renderBoardView(K, pose, { ...STANDARD, seed: 1 });
    const det = detectMarkers(img);
    const truth = projectedMarkerCorners(K, toBoardUnits(pose));
    expect(det.markers.map((m) => m.id)).toEqual(BOARD.markers.map((m) => m.id));
    const e = cornerErrors(det, truth);
    expect(rms(e)).toBeLessThan(0.15);
    expect(Math.max(...e)).toBeLessThan(0.5);
    for (const m of det.markers) {
      expect(m.refined).toBe(true);
      expect(m.bitErrors).toBe(0);
      expect(m.edgeContrast).toBeGreaterThan(80);
    }
    expect(det.timingsMs.total).toBeGreaterThan(0);
  });

  it("reads every in-image rotation (the camera all round the board) and reorders the corners", () => {
    for (const az of [0, 90, 180, 270, 45]) {
      const pose = orbitPose(HAND_CENTRE, 420, 55, az);
      const det = detectMarkers(renderBoardView(K, pose, { ...STANDARD, seed: az + 3 }));
      const truth = projectedMarkerCorners(K, toBoardUnits(pose));
      expect(det.markers.length).toBeGreaterThanOrEqual(12);
      expect(rms(cornerErrors(det, truth))).toBeLessThan(0.15);
    }
  });

  it("at 12 degrees elevation the near row is still found with sub-pixel corners", () => {
    const pose = orbitPose(HAND_CENTRE, 350, 12, 270); // camera beyond the bottom edge
    const det = detectMarkers(renderBoardView(K, pose, { ...STANDARD, seed: 7 }));
    const truth = projectedMarkerCorners(K, toBoardUnits(pose));
    const nearRow = BOARD.markers.filter((m) => m.y < 50).map((m) => m.id);
    for (const id of nearRow) expect(det.markers.map((m) => m.id)).toContain(id);
    const e = cornerErrors(det, truth);
    expect(rms(e)).toBeLessThan(0.45);
    // no false identity anywhere: every detection is at its true place
    for (const m of det.markers) {
      const t = truth.get(m.id)!;
      expect(Math.max(...m.corners.map((p, i) => Math.hypot(p.x - t[i]!.x, p.y - t[i]!.y)))).toBeLessThan(2);
    }
  });

  it("a covered marker is missed, its neighbours are not, and no wrong id appears", () => {
    const m = BOARD.markers[3];
    const blob: Ellipsoid = { center: { x: m.x + 15, y: m.y + 18, z: 6 }, radii: { x: 14, y: 12, z: 6 } };
    const pose = orbitPose(HAND_CENTRE, 400, 90, 270);
    const det = detectMarkers(renderBoardView(K, pose, { ...STANDARD, occluders: [blob], seed: 2 }));
    const ids = det.markers.map((d) => d.id);
    expect(ids).not.toContain(3);
    expect(ids).toContain(2);
    expect(ids).toContain(4);
    const truth = projectedMarkerCorners(K, toBoardUnits(pose));
    expect(Math.max(...cornerErrors(det, truth))).toBeLessThan(0.6);
  });

  it("a blank or noisy image gives no markers and does not throw; rejections carry reasons", () => {
    const W = 320, H = 240;
    const blank: RgbaImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) };
    expect(detectMarkers(blank).markers).toEqual([]);
    const noisy = renderBoardView({ ...intrinsicsFromHfov(W, H, 65) }, orbitPose(HAND_CENTRE, 2500, 90, 270), { noiseSigma: 40, seed: 9 });
    const det = detectMarkers(noisy);
    expect(det.markers.length).toBe(0);
    for (const r of det.rejected) expect(typeof r.reason).toBe("string");
  });

  it("two markers with the same id: one kept, the other rejected as duplicate_id", () => {
    const layout: BoardLayout = { ...BOARD, markers: BOARD.markers.map((m, i) => (i === 5 ? { ...BOARD.markers[1], x: m.x, y: m.y } : m)) };
    const pose = orbitPose(HAND_CENTRE, 400, 90, 270);
    const det = detectMarkers(renderBoardView(K, pose, { ...STANDARD, layout, seed: 4 }), { layout });
    expect(det.markers.filter((m) => m.id === 1).length).toBe(1);
    expect(det.rejectedCounts.duplicate_id).toBe(1);
  });

  it("decimate 2 finds the same markers on a 1920 x 1080 view, refined at full resolution", () => {
    const K2: Intrinsics = { ...intrinsicsFromHfov(1920, 1080, 65), k1: -0.08, k2: 0.02 };
    const pose = orbitPose(HAND_CENTRE, 400, 50, 300);
    const img = renderBoardView(K2, pose, { ...STANDARD, seed: 5 });
    const truth = projectedMarkerCorners(K2, toBoardUnits(pose));
    const full = detectMarkers(img);
    const dec = detectMarkers(img, { decimate: 2 });
    expect(dec.markers.map((m) => m.id)).toEqual(full.markers.map((m) => m.id));
    expect(rms(cornerErrors(dec, truth))).toBeLessThan(0.15);
  });

  it("supplying the intrinsics (lines fitted without lens distortion) keeps or improves the corners", () => {
    const Kd: Intrinsics = { ...K, k1: -0.2, k2: 0.05 };
    const pose = orbitPose(HAND_CENTRE, 330, 60, 200);
    const img = renderBoardView(Kd, pose, { ...STANDARD, seed: 6 });
    const truth = projectedMarkerCorners(Kd, toBoardUnits(pose));
    const a = rms(cornerErrors(detectMarkers(img), truth));
    const b = rms(cornerErrors(detectMarkers(img, { intrinsics: Kd }), truth));
    expect(b).toBeLessThanOrEqual(a + 0.01);
    expect(b).toBeLessThan(0.15);
  });

  it("grey input gives the same result as RGBA", () => {
    const img = renderBoardView(K, orbitPose(HAND_CENTRE, 400, 70, 250), { ...STANDARD, seed: 8 });
    const a = detectMarkers(img);
    const b = detectMarkers(toGray(img));
    expect(b.markers.map((m) => m.corners)).toEqual(a.markers.map((m) => m.corners));
  });
});
