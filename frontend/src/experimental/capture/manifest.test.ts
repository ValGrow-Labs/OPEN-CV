import { describe, expect, it } from "vitest";
import { BUNDLE_README, buildManifest, jsonSafe, MANIFEST_SCHEMA, type ManifestInput } from "./manifest";
import type { CapturedView } from "./types";
import { viewDef } from "./views";

const lm = (n = 21) => Array.from({ length: n }, (_, i) => ({ x: i, y: i * 2, z: 0.5 }));

function view(id: "palm" | "thumb", order: number, over: Partial<CapturedView> = {}): CapturedView {
  return {
    def: viewDef(id),
    order,
    capturedAt: "2026-11-07T10:00:00.000Z",
    quality: { passed: id === "palm", reasons: id === "palm" ? [] : ["Turn the hand further onto its edge."], trigger: id === "palm" ? "auto" : "button", sharpness: 0.01, jitter: 0.004, turn: 0.6 },
    still: { blob: new Blob([new Uint8Array(10)]), width: 1280, height: 720, pixels: {} as ImageData },
    highRes: null,
    landmarks: lm(),
    world: lm(),
    handedness: "Right",
    handednessScore: 0.98,
    coin: { found: true, accepted: true, center_x: 1, center_y: 2, major_axis_px: 120, minor_axis_px: 118, angle_deg: 10, edge_support: 1, max_angular_gap_deg: 0, fit_residual_px: Infinity, edge_width_px: Infinity, glare_fraction: 0, contrast: 0.3, n_edge_points: 100, confidence: 0.9, method: "hough", reasons: [] },
    stream: { settings: { width: 1280, height: 720, frameRate: 30 }, capabilities: { focusMode: ["continuous"] }, label: "Fake camera", facing: "user" },
    analysis: null,
    maskPng: null,
    ...over,
  };
}

const input = (views: CapturedView[]): ManifestInput => ({
  views,
  createdAt: new Date("2026-11-07T10:05:00.000Z"),
  device: { userAgent: "UA", screenWidth: 390, screenHeight: 844, devicePixelRatio: 3 },
  config: { referenceObjectId: "us_quarter", referenceLabel: "US quarter (25c)", referenceDiameterMm: 24.26, referenceDiameterUncertaintyMm: 0.05, assumedHfovDeg: [55, 80], calibrationStatus: "uncalibrated", calibrationValidated: false },
  poseConsistency: null,
  depth: null,
  files: { palm: { still: "views/01-palm.png", mask: null, highRes: null }, thumb: { still: "views/02-thumb.png", mask: "masks/02-thumb.png", highRes: null } },
});

describe("the capture manifest", () => {
  const m = buildManifest(input([view("palm", 1), view("thumb", 2)]));

  it("is versioned and says it is experimental and unvalidated", () => {
    expect(m.schema).toBe(MANIFEST_SCHEMA);
    expect(m.schema).toMatch(/\/1$/);
    expect(m.experimental).toBe(true);
    expect(m.notice).toMatch(/EXPERIMENTAL/);
    expect(m.notice).toMatch(/Not validated/);
  });

  it("states that no marker pose exists and fabricates none", () => {
    expect(m.marker.implemented).toBe(false);
    expect(m.marker.note).toMatch(/not implemented/);
    expect(JSON.stringify(m)).not.toMatch(/"pose"|"rotation"|"extrinsic/i);
  });

  it("lists every view in order with its files, quality and landmarks", () => {
    expect(m.views.map((v) => v.id)).toEqual(["palm", "thumb"]);
    expect(m.views.map((v) => v.order)).toEqual([1, 2]);
    expect(m.views[0].files).toEqual({ still: "views/01-palm.png", mask: null, highRes: null });
    expect(m.views[1].files.mask).toBe("masks/02-thumb.png");
    expect(m.views[1].quality).toMatchObject({ passed: false, trigger: "button" });
    expect(m.views[1].quality.reasons[0]).toMatch(/edge/);
    expect(m.views[0].landmarksImagePx).toHaveLength(21);
    expect(m.views[0].landmarksWorldMetres).toHaveLength(21);
    expect(m.views[0].stream.settings).toMatchObject({ frameRate: 30 });
    expect(m.views[0].still).toEqual({ width: 1280, height: 720 });
  });

  it("records the device and the config values it used, read from the public config", () => {
    expect(m.device).toMatchObject({ devicePixelRatio: 3, screenWidth: 390 });
    expect(m.config).toMatchObject({ referenceObjectId: "us_quarter", referenceDiameterMm: 24.26, assumedHfovDeg: [55, 80], calibrationValidated: false });
    expect(m.config.source).toMatch(/read only/);
  });

  it("contains no pixels: no image data, base64 or typed arrays", () => {
    const text = JSON.stringify(m);
    expect(text).not.toMatch(/data:image|base64|iVBOR/);
    expect(text.length).toBeLessThan(20_000);
  });

  it("turns Infinity and NaN into null so the file is valid JSON", () => {
    const text = JSON.stringify(m);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(m.views[0].coin?.fit_residual_px).toBeNull();
    expect(jsonSafe({ a: Infinity, b: NaN, c: undefined, d: 1 })).toEqual({ a: null, b: null, d: 1 });
  });

  it("has an empty list of views for no captures, without throwing", () => {
    expect(buildManifest({ ...input([]), files: {} }).views).toEqual([]);
  });

  it("ships a README that calls the images personal data and says nothing was uploaded", () => {
    expect(BUNDLE_README).toMatch(/PERSONAL DATA/);
    expect(BUNDLE_README).toMatch(/Nothing in this bundle was uploaded/);
    expect(BUNDLE_README).toMatch(/cannot be reconstructed in 3D yet/);
  });
});
