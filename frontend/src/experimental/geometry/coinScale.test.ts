// What a coin gives and what it cannot. Uses the real reference-object diameters (read from config) and a synthetic camera.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { intrinsicsFromHfov, lookAt, project } from "./camera";
import { coinPlaneScale, distanceFromCoin, LIMITS_OF_ONE_CIRCLE, requiredReferenceForPose, scaleAtPlaneOffset } from "./coinScale";
import type { V3 } from "./linalg";

const near = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const refs = JSON.parse(readFileSync(resolve(process.cwd(), "../config/reference_objects.json"), "utf-8")).objects as { id: string; diameter_mm: number; diameter_uncertainty_mm: number }[];
const diameter = (id: string) => refs.find((r) => r.id === id)!.diameter_mm;

describe("scale, tilt and distance of the coin's plane", () => {
  it("a fronto-parallel coin: scale D / major, no tilt, and the distance from fx", () => {
    const D = diameter("us_quarter");
    const K = intrinsicsFromHfov(1280, 720, 70);
    const major = 120;
    const s = coinPlaneScale({ major_axis_px: major, minor_axis_px: major }, D, { intrinsics: K });
    near(s.mmPerPxMajor, D / major);
    near(s.tiltDeg, 0, 1e-6);
    near(s.distanceMm!, (K.fx * D) / major, 1e-9);
    expect(s.tiltSign).toBe("ambiguous");
  });
  it("the Indian 2-rupee coin (23.00 mm, read from config) works the same way", () => {
    const D = diameter("inr_2_2019");
    expect(D).toBe(23);
    const s = coinPlaneScale({ major_axis_px: 92, minor_axis_px: 92 }, D);
    near(s.mmPerPxMajor, 0.25, 1e-12);
  });
  it("tilt = acos(minor / major): a coin tilted 60 degrees images as an ellipse with ratio 0.5", () => {
    const s = coinPlaneScale({ major_axis_px: 100, minor_axis_px: 50, angle_deg: 30 }, 24.26);
    near(s.tiltDeg, 60, 1e-9);
    near(s.axisRatio, 0.5, 1e-12);
    expect(s.tiltAxisImageAngleDeg).toBe(30);
    near(s.mmPerPxMinorApparent / s.mmPerPxMajor, 2, 1e-12); // 1 / cos(60)
  });
  it("takes the longer axis as the major one whatever the order it was given in", () => {
    const a = coinPlaneScale({ major_axis_px: 50, minor_axis_px: 100 }, 24.26);
    near(a.mmPerPxMajor, 24.26 / 100);
    near(a.tiltDeg, 60, 1e-9);
  });
  it("gives a distance range for the app's assumed field-of-view range (the wider field means the nearer coin)", () => {
    const s = coinPlaneScale({ major_axis_px: 80, minor_axis_px: 80 }, 24.26, { imageSize: { width: 1280, height: 720 } });
    const [lo, hi] = s.distanceRangeMm!;
    expect(lo).toBeLessThan(hi);
    near(lo, ((1280 / 2) / Math.tan((80 * Math.PI) / 360)) * 24.26 / 80, 1e-9);
    near(hi, ((1280 / 2) / Math.tan((55 * Math.PI) / 360)) * 24.26 / 80, 1e-9);
  });
  it("recovers the scale and tilt of a coin rendered by a synthetic camera (ground truth known)", () => {
    const D = 24.26;
    const K = intrinsicsFromHfov(1920, 1080, 65);
    const pose = lookAt([0, 0, 340], [0, 0, 0], [0, -1, 0]); // straight above the table, plane z = 0
    // a circle of diameter D in the plane, imaged: take the extreme points along x and y
    const ring: V3[] = Array.from({ length: 360 }, (_, i) => [(D / 2) * Math.cos((i * Math.PI) / 180), (D / 2) * Math.sin((i * Math.PI) / 180), 0]);
    const px = ring.map((X) => project(K, pose, X)!);
    const major = Math.max(...px.map((p) => p.x)) - Math.min(...px.map((p) => p.x));
    const s = coinPlaneScale({ major_axis_px: major, minor_axis_px: major }, D, { intrinsics: K });
    near(s.distanceMm!, 340, 0.5); // small perspective effect of a near circle
    near(s.mmPerPxMajor, 340 / K.fx, 0.002);
  });
});

describe("one circle is not a camera pose", () => {
  it("says so in words, so the UI and the docs cannot overstate it", () => {
    const text = LIMITS_OF_ONE_CIRCLE.join(" ");
    expect(text).toMatch(/no scale at any other depth/);
    expect(text).toMatch(/sign|\+tilt and -tilt/);
    expect(text).toMatch(/no in-plane orientation|does not give a full camera pose/);
    expect(text).toMatch(/focal length/);
  });
  it("the scale at another plane is the coin's scale times (Z + dz) / Z, and a plane behind the camera is refused", () => {
    near(scaleAtPlaneOffset(0.2, 350, 15), 0.2 * (365 / 350), 1e-12);
    near(scaleAtPlaneOffset(0.2, 350, -10), 0.2 * (340 / 350), 1e-12);
    expect(() => scaleAtPlaneOffset(0.2, 350, -400)).toThrow();
  });
  it("distanceFromCoin is the pinhole relation", () => {
    near(distanceFromCoin(120, 24.26, 900), (900 * 24.26) / 120, 1e-12);
  });
});

describe("what a full pose would need", () => {
  const options = requiredReferenceForPose();
  it("lists the options and marks none of them as already in the product", () => {
    expect(options.length).toBeGreaterThanOrEqual(4);
    for (const o of options) expect(["option_not_in_product", "platform_dependent"]).toContain(o.availability);
    expect(options.map((o) => o.id)).toEqual(expect.arrayContaining(["marker_grid", "known_quad", "coin_plus_landmarks", "webxr_arcore"]));
  });
  it("planar point sets need at least four points and known intrinsics", () => {
    const grid = options.find((o) => o.id === "marker_grid")!;
    expect(grid.minimumPoints).toBeGreaterThanOrEqual(4);
    expect(grid.needsKnownIntrinsics).toBe(true);
  });
  it("the coin plus landmarks option is flagged as weak (noisy, flat-palm only)", () => {
    const c = options.find((o) => o.id === "coin_plus_landmarks")!;
    expect(c.caveats.join(" ")).toMatch(/jitter|noisy|flat/i);
  });
});
