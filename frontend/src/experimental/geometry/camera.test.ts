// Camera model and pose maths. Synthetic cameras with known ground truth: these tests check the MATHS, not any phone.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_VIDEO_SIZE,
  ASSUMED_HFOV_DEG,
  axisAngleFromRotation,
  cameraCenter,
  composePoses,
  distortNormalized,
  focalLengthSensitivity,
  identityPose,
  intrinsicsFromHfov,
  invertPose,
  lookAt,
  pixelToNormalized,
  project,
  projectCamera,
  reprojectionError,
  rotationAngleBetween,
  rotationFromAxisAngle,
  rotationMatrixIsValid,
  transformPoint,
  undistortNormalized,
  unproject,
} from "./camera";
import type { V3 } from "./linalg";

const near = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const config = JSON.parse(readFileSync(resolve(process.cwd(), "../config/measurement.json"), "utf-8"));

describe("the assumptions mirror the existing configuration (read-only)", () => {
  it("the assumed field-of-view range equals config uncertainty.assumed_hfov_deg", () => {
    expect([...ASSUMED_HFOV_DEG]).toEqual(config.uncertainty.assumed_hfov_deg);
  });
  it("the app video size is what src/camera/camera.ts asks for", () => {
    expect(APP_VIDEO_SIZE.mobile).toEqual({ width: 1280, height: 720 });
    expect(APP_VIDEO_SIZE.desktop).toEqual({ width: 1920, height: 1080 });
  });
});

describe("intrinsics from a field of view", () => {
  it("fx = (side / 2) / tan(fov / 2) with the field of view on the long side, principal point at the centre", () => {
    const K = intrinsicsFromHfov(1280, 720, 70);
    near(K.fx, 640 / Math.tan((35 * Math.PI) / 180), 1e-9);
    expect(K.fy).toBe(K.fx);
    expect([K.cx, K.cy]).toEqual([640, 360]);
  });
  it("'width' spans the width instead; a portrait frame differs between the two conventions", () => {
    const portraitLong = intrinsicsFromHfov(720, 1280, 70, "long");
    const portraitWidth = intrinsicsFromHfov(720, 1280, 70, "width");
    near(portraitLong.fx / portraitWidth.fx, 1280 / 720, 1e-9);
  });
  it("rejects nonsense", () => {
    expect(() => intrinsicsFromHfov(0, 720, 70)).toThrow();
    expect(() => intrinsicsFromHfov(1280, 720, 180)).toThrow();
  });
});

describe("projection and distortion", () => {
  const K = { ...intrinsicsFromHfov(1280, 720, 70), k1: -0.08, k2: 0.01 };
  it("a point on the optical axis lands on the principal point", () => {
    const p = projectCamera(K, [0, 0, 400])!;
    near(p.x, 640);
    near(p.y, 360);
  });
  it("matches the pinhole formula without distortion", () => {
    const K0 = intrinsicsFromHfov(1280, 720, 70);
    const p = projectCamera(K0, [30, -20, 400])!;
    near(p.x, K0.fx * (30 / 400) + 640);
    near(p.y, K0.fy * (-20 / 400) + 360);
  });
  it("a point behind or on the camera plane is not projected", () => {
    expect(projectCamera(K, [0, 0, -5])).toBeNull();
    expect(projectCamera(K, [0, 0, 0])).toBeNull();
  });
  it("undistort inverts distort (round trip below 1e-9 in normalised units), also near the image corner", () => {
    for (const [x, y] of [[0, 0], [0.1, -0.05], [0.4, 0.3], [0.7, 0.4], [-0.6, -0.35]]) {
      const d = distortNormalized(x, y, K.k1, K.k2);
      const u = undistortNormalized(d.x, d.y, K.k1, K.k2);
      near(u.x, x, 1e-9);
      near(u.y, y, 1e-9);
    }
  });
  it("project then unproject at the true depth returns the point (round trip in pixels and millimetres)", () => {
    const X: V3 = [55, -32, 380];
    const p = projectCamera(K, X)!;
    const back = unproject(K, p.x, p.y, X[2]);
    near(back[0], X[0], 1e-6);
    near(back[1], X[1], 1e-6);
    near(back[2], X[2], 1e-9);
    const n = pixelToNormalized(K, p.x, p.y);
    near(n.x, X[0] / X[2], 1e-9);
  });
  it("barrel distortion (k1 < 0) pulls points toward the centre", () => {
    const d = distortNormalized(0.5, 0, -0.1);
    expect(d.x).toBeLessThan(0.5);
  });
});

describe("pose maths", () => {
  it("Rodrigues gives a valid rotation and axis/angle round-trips, including a half turn", () => {
    for (const [axis, angle] of [[[0, 0, 1], 0.7], [[1, 2, 3], 2.2], [[0, 1, 0], Math.PI], [[1, 0, 0], 1e-4]] as [V3, number][]) {
      const R = rotationFromAxisAngle(axis, angle);
      expect(rotationMatrixIsValid(R)).toBe(true);
      const back = axisAngleFromRotation(R);
      near(back.angleRad, angle, 1e-7);
    }
    const R = rotationFromAxisAngle([1, 2, 3], 2.2);
    const a = axisAngleFromRotation(R);
    const n = Math.hypot(1, 2, 3);
    near(a.axis[0], 1 / n, 1e-9);
    near(a.axis[2], 3 / n, 1e-9);
  });
  it("a 90 degree turn about z maps x to y", () => {
    const R = rotationFromAxisAngle([0, 0, 1], Math.PI / 2);
    const v = transformPoint({ R, t: [0, 0, 0] }, [1, 0, 0]);
    near(v[0], 0, 1e-12);
    near(v[1], 1, 1e-12);
  });
  it("compose applies b then a; invert undoes a pose", () => {
    const a = { R: rotationFromAxisAngle([0, 1, 0], 0.4), t: [10, -5, 30] as V3 };
    const b = { R: rotationFromAxisAngle([1, 0, 0], -0.9), t: [-4, 8, 2] as V3 };
    const X: V3 = [3, 4, 5];
    const direct = transformPoint(a, transformPoint(b, X));
    const composed = transformPoint(composePoses(a, b), X);
    for (let i = 0; i < 3; i++) near(direct[i], composed[i], 1e-9);
    const round = transformPoint(invertPose(a), transformPoint(a, X));
    for (let i = 0; i < 3; i++) near(round[i], X[i], 1e-9);
    const id = composePoses(a, invertPose(a));
    expect(rotationAngleBetween(id.R, identityPose().R)).toBeLessThan(1e-6);
  });
  it("lookAt: the target lies on the optical axis at the right distance, the rotation is valid, y points down", () => {
    const eye: V3 = [60, -80, 350];
    const pose = lookAt(eye, [0, 0, 0], [0, -1, 0]);
    expect(rotationMatrixIsValid(pose.R)).toBe(true);
    const c = transformPoint(pose, [0, 0, 0]);
    near(c[0], 0, 1e-9);
    near(c[1], 0, 1e-9);
    near(c[2], Math.hypot(60, 80, 350), 1e-9);
    const centre = cameraCenter(pose);
    for (let i = 0; i < 3; i++) near(centre[i], eye[i], 1e-9);
    // world "up" (0,-1,0) should appear going up in the image, i.e. toward negative camera y
    const above = transformPoint(pose, [0, -50, 0]);
    expect(above[1]).toBeLessThan(c[1]);
  });
  it("rotationAngleBetween measures the angle in degrees", () => {
    const R1 = rotationFromAxisAngle([0, 0, 1], 0.2);
    const R2 = rotationFromAxisAngle([0, 0, 1], 0.5);
    near(rotationAngleBetween(R1, R2), (0.3 * 180) / Math.PI, 1e-9);
  });
});

describe("reprojection error", () => {
  const K = { ...intrinsicsFromHfov(1280, 720, 70), k1: -0.05 };
  const pose = lookAt([40, -60, 320], [0, 0, 0], [0, -1, 0]);
  const world: V3[] = [[0, 0, 0], [50, 0, 0], [0, 50, 0], [50, 50, 0], [25, 25, 0]];
  it("is zero for exact observations and equals the shift for shifted ones", () => {
    const observed = world.map((X) => project(K, pose, X)!);
    near(reprojectionError(K, pose, world, observed).rmsPx, 0, 1e-9);
    const shifted = observed.map((p) => ({ x: p.x + 3, y: p.y + 4 }));
    near(reprojectionError(K, pose, world, shifted).rmsPx, 5, 1e-9);
  });
  it("a point behind the camera is Infinity, and mismatched lists throw", () => {
    const e = reprojectionError(K, pose, [[0, 0, 1e6]], [{ x: 0, y: 0 }]);
    expect(e.rmsPx).toBe(Infinity);
    expect(() => reprojectionError(K, pose, world, [])).toThrow();
  });
});

describe("what a wrong focal length costs", () => {
  it("the worked example: +10 %, Z = 350, dz = 15, L = 190 gives -0.375 % and about -0.71 mm", () => {
    const s = focalLengthSensitivity({ relFocalError: 0.1, distanceMm: 350, planeOffsetMm: 15, lengthMm: 190 });
    near(s.distanceErrorMm, 35, 1e-9);
    const hand = (385 + 15) / 385 / ((350 + 15) / 350) - 1;
    near(s.planeScaleErrorRel, hand, 1e-12);
    near(s.planeScaleErrorRel, -0.00375, 5e-5);
    near(s.lengthErrorMm, 190 * hand, 1e-9);
    near(s.lengthErrorMm, -0.71, 0.01);
  });
  it("is zero when the measured plane IS the coin's plane (dz = 0): the in-plane scale does not need the focal length", () => {
    const s = focalLengthSensitivity({ relFocalError: 0.25, distanceMm: 300, planeOffsetMm: 0, lengthMm: 190 });
    near(s.planeScaleErrorRel, 0, 1e-12);
    near(s.lengthErrorMm, 0, 1e-9);
  });
  it("grows with the plane offset and shrinks with distance", () => {
    const a = Math.abs(focalLengthSensitivity({ relFocalError: 0.1, distanceMm: 300, planeOffsetMm: 10, lengthMm: 190 }).lengthErrorMm);
    const b = Math.abs(focalLengthSensitivity({ relFocalError: 0.1, distanceMm: 300, planeOffsetMm: 25, lengthMm: 190 }).lengthErrorMm);
    const c = Math.abs(focalLengthSensitivity({ relFocalError: 0.1, distanceMm: 500, planeOffsetMm: 10, lengthMm: 190 }).lengthErrorMm);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeLessThan(a);
  });
});
