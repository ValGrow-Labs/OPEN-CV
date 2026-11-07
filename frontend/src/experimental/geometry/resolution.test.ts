// Resolution requirements and the app's own video scale. Pure arithmetic from the stated field of view; not a measurement.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSUMED_HFOV_DEG, intrinsicsFromHfov } from "./camera";
import {
  appVideoScale,
  buildResolutionTable,
  fieldOfViewOnHandMm,
  mmPerPxAtDistance,
  NOT_PIXEL_LIMITED,
  requiredResolutionForMmPerPx,
  RESOLUTION_TABLE_0_1_MM,
} from "./resolution";

const near = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const refs = JSON.parse(readFileSync(resolve(process.cwd(), "../config/reference_objects.json"), "utf-8")).objects as { id: string; diameter_mm: number }[];
const quarter = refs.find((r) => r.id === "us_quarter")!.diameter_mm;
const inr2 = refs.find((r) => r.id === "inr_2_2019")!.diameter_mm;

describe("required resolution for a target scale", () => {
  it("0.1 mm/px at 350 mm needs fx = 3500 px; a 4032 px-wide image with that focal length sees a 403 mm field", () => {
    const r = requiredResolutionForMmPerPx(0.1, 350, 70);
    near(r.requiredFxPx, 3500, 1e-9);
    near((4032 * 0.1), 403.2, 1e-9);
    // the field of view of a 4032 px image with fx = 3500 px
    const fov = (2 * Math.atan(2016 / 3500) * 180) / Math.PI;
    near(fieldOfViewOnHandMm(350, fov), 403.2, 1e-6);
    near(mmPerPxAtDistance(350, 4032, fov), 0.1, 1e-9);
  });
  it("the field on the hand depends on distance and field of view only, so the pixels needed are field / target", () => {
    const r = requiredResolutionForMmPerPx(0.1, 350, 69.4);
    near(r.fieldMm, 2 * 350 * Math.tan((69.4 * Math.PI) / 360), 1e-9);
    near(r.requiredSidePx, r.fieldMm / 0.1, 1e-9);
    near(r.requiredMegapixels43, (r.requiredSidePx * r.requiredSidePx * 0.75) / 1e6, 1e-9);
    expect(r.requiredSidePx).toBeGreaterThan(4800);
    expect(r.requiredMegapixels43).toBeGreaterThan(17);
  });
  it("consistent with the intrinsics: fx = side / 2 / tan(fov / 2) = distance / target for the required side", () => {
    const r = requiredResolutionForMmPerPx(0.1, 500, 55);
    const K = intrinsicsFromHfov(Math.round(r.requiredSidePx), Math.round(r.requiredSidePx * 0.75), 55);
    near(K.fx, r.requiredFxPx, r.requiredFxPx * 1e-3);
  });
  it("the 0.1 mm/px table has nine rows (250/350/500 mm x the app's two fields and 69.4 degrees) and grows with distance", () => {
    expect(RESOLUTION_TABLE_0_1_MM).toHaveLength(9);
    const d350 = RESOLUTION_TABLE_0_1_MM.filter((r) => r.distanceMm === 350).map((r) => r.requiredSidePx);
    const d500 = RESOLUTION_TABLE_0_1_MM.filter((r) => r.distanceMm === 500).map((r) => r.requiredSidePx);
    d350.forEach((v, i) => expect(d500[i]).toBeGreaterThan(v));
    near(RESOLUTION_TABLE_0_1_MM.find((r) => r.distanceMm === 250 && r.fovDeg === 55)!.requiredFxPx, 2500, 1e-9);
    expect(buildResolutionTable(0.1, [350], [70])).toHaveLength(1);
  });
  it("every row needs a sensor beyond what the app's 1280 px video offers", () => {
    for (const r of RESOLUTION_TABLE_0_1_MM) expect(r.requiredSidePx).toBeGreaterThan(2500);
  });
  it("rejects nonsense", () => {
    expect(() => requiredResolutionForMmPerPx(0, 350, 70)).toThrow();
    expect(() => requiredResolutionForMmPerPx(0.1, 350, 180)).toThrow();
  });
});

describe("what the app's own video gives (phones: 1280 px long side, assumed field of view 55-80 degrees)", () => {
  const rows = appVideoScale(quarter, "mobile");
  const at = (d: number, f: number) => rows.find((r) => r.distanceMm === d && r.fovDeg === f)!;

  it("at 350 mm: about 0.28 to 0.46 mm per pixel, the quarter 53 to 85 pixels across", () => {
    near(at(350, 55).mmPerPx, (2 * 350 * Math.tan((55 * Math.PI) / 360)) / 1280, 1e-12);
    near(at(350, 55).mmPerPx, 0.2847, 1e-3);
    near(at(350, 80).mmPerPx, 0.4589, 1e-3);
    near(at(350, 55).coinPx, 85.2, 0.1);
    near(at(350, 80).coinPx, 52.9, 0.1);
  });
  it("0.2 mm per pixel only happens when the camera is as near as 250 mm with the narrower assumed field of view", () => {
    near(at(250, 55).mmPerPx, 0.2033, 1e-3);
    expect(at(350, 55).mmPerPx).toBeGreaterThan(0.25);
  });
  it("the coin and the hand share the scale: the coin is not sharper than the hand (same plane)", () => {
    // 190 mm hand length in pixels at 350 mm, 55 degrees: 190 / 0.2847 = 667 px; the quarter is 85 px
    near(190 / at(350, 55).mmPerPx, 667, 1);
  });
  it("the Indian 2-rupee coin (23.00 mm) is a few pixels smaller than the quarter at the same scale", () => {
    const r = appVideoScale(inr2, "mobile").find((x) => x.distanceMm === 350 && x.fovDeg === 55)!;
    near(r.coinPx, 23 / at(350, 55).mmPerPx, 1e-9);
    expect(r.coinPx).toBeLessThan(at(350, 55).coinPx);
  });
  it("the desktop's 1920 px video is finer by 1920 / 1280 at the same field of view", () => {
    const d = appVideoScale(quarter, "desktop").find((x) => x.distanceMm === 350 && x.fovDeg === 55)!;
    near(at(350, 55).mmPerPx / d.mmPerPx, 1920 / 1280, 1e-9);
  });
  it("uses the config's assumed field-of-view range", () => {
    const fovs = [...new Set(rows.map((r) => r.fovDeg))];
    expect(fovs).toEqual([...ASSUMED_HFOV_DEG]);
  });
});

describe("pixel resolution is not measurement accuracy", () => {
  it("lists the errors that do not shrink with pixel size", () => {
    const t = NOT_PIXEL_LIMITED.join(" ");
    expect(t).toMatch(/Boundary/);
    expect(t).toMatch(/Plane offset/);
    expect(t).toMatch(/Tilt/);
    expect(t).toMatch(/diameter tolerance/);
    expect(t).toMatch(/distortion/);
    expect(t).toMatch(/soft/);
  });
});
