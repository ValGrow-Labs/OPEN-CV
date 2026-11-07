// Depth capability detection and metric-depth surfaces. Injected fake browsers; analytic (SYNTHETIC) depth maps.
import { describe, expect, it, vi } from "vitest";
import { intrinsicsFor } from "../reconstruction/linalg";
import { sphereDepth, visibleCapArea } from "../reconstruction/testSupport";
import { detectDepthCapabilities, detectPlatform, probeDepthSensing, type DepthEnv, type XrLike, type XrSessionLike } from "./capabilities";
import { surfaceFromDepth, type MetricDepth } from "./surfaceFromDepth";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

const xr = (supported: boolean, session?: Partial<XrSessionLike> & { fail?: string }): XrLike => ({
  isSessionSupported: vi.fn(async () => supported),
  requestSession: vi.fn(async () => {
    if (session?.fail) throw new Error(session.fail);
    return { depthUsage: "cpu-optimized", depthDataFormat: "luminance-alpha", end: vi.fn(async () => undefined), ...session };
  }),
});

describe("platform detection", () => {
  it("tells Android, iPhone, iPadOS (which poses as a Mac), desktop and other apart", () => {
    expect(detectPlatform({ userAgent: ANDROID })).toBe("android");
    expect(detectPlatform({ userAgent: IPHONE })).toBe("ios");
    expect(detectPlatform({ userAgent: IPAD_AS_MAC, maxTouchPoints: 5 })).toBe("ios");
    expect(detectPlatform({ userAgent: IPAD_AS_MAC, maxTouchPoints: 0 })).toBe("desktop");
    expect(detectPlatform({ userAgent: WINDOWS })).toBe("desktop");
    expect(detectPlatform({ userAgent: "curl/8" })).toBe("other");
  });
});

describe("the capability report", () => {
  it("an Android phone with WebXR AR is a depth CANDIDATE, but depth sensing is unknown until a user action, and RGB stays the fallback", async () => {
    const env: DepthEnv = { userAgent: ANDROID, isSecureContext: true, xr: xr(true) };
    const r = await detectDepthCapabilities(env);
    expect(r.platform).toBe("android");
    expect(r.webxr).toBe(true);
    expect(r.immersiveAr).toBe(true);
    expect(r.depthSensing.status).toBe("unknown_until_user_gesture");
    expect(r.recommendedPath).toBe("webxr_depth_candidate");
    expect(r.fallbackAlwaysAvailable).toBe(true);
    expect(env.xr!.requestSession).not.toHaveBeenCalled(); // never starts a session by itself
    expect(r.notes.join(" ")).toMatch(/takes over the camera/);
  });

  it("an iPhone has no web depth: ARKit and LiDAR are native-only, and the RGB path is recommended", async () => {
    const r = await detectDepthCapabilities({ userAgent: IPHONE, isSecureContext: true, xr: null });
    expect(r.platform).toBe("ios");
    expect(r.webxr).toBe(false);
    expect(r.depthSensing.status).toBe("not_available");
    expect(r.depthSensing.reason).toMatch(/Safari/);
    expect(r.nativeOnly.arkitSceneDepth.reachableFromWeb).toBe(false);
    expect(r.nativeOnly.lidar.reachableFromWeb).toBe(false);
    expect(r.recommendedPath).toBe("rgb_only");
    expect(r.notes.join(" ")).toMatch(/native app/);
  });

  it("an insecure page cannot use WebXR at all, and is not even asked", async () => {
    const x = xr(true);
    const r = await detectDepthCapabilities({ userAgent: ANDROID, isSecureContext: false, xr: x });
    expect(r.immersiveAr).toBeNull();
    expect(r.depthSensing.status).toBe("not_available");
    expect(r.depthSensing.reason).toMatch(/HTTPS/);
    expect(x.isSessionSupported).not.toHaveBeenCalled();
    expect(r.recommendedPath).toBe("rgb_only");
  });

  it("WebXR without immersive AR is no depth", async () => {
    const r = await detectDepthCapabilities({ userAgent: ANDROID, isSecureContext: true, xr: xr(false) });
    expect(r.immersiveAr).toBe(false);
    expect(r.depthSensing.status).toBe("not_available");
    expect(r.recommendedPath).toBe("rgb_only");
  });

  it("survives isSessionSupported throwing", async () => {
    const bad: XrLike = { isSessionSupported: async () => { throw new Error("blocked"); } };
    const r = await detectDepthCapabilities({ userAgent: ANDROID, isSecureContext: true, xr: bad });
    expect(r.immersiveAr).toBe(false);
  });

  it("always says that MediaPipe's depth and monocular depth are relative, not physical", async () => {
    const r = await detectDepthCapabilities({ userAgent: WINDOWS, isSecureContext: true, xr: null });
    expect(r.mediapipeWorld.calibrated).toBe(false);
    expect(r.mediapipeWorld.kind).toBe("relative_depth_metres");
    expect(r.monocularNetworks.metric).toBe(false);
    expect(r.fallbackAlwaysAvailable).toBe(true);
  });
});

describe("probing for depth sensing (needs a user action)", () => {
  const env = (x: XrLike | null): DepthEnv => ({ userAgent: ANDROID, isSecureContext: true, xr: x });

  it("refuses to start from anything but a trusted user action", async () => {
    const x = xr(true);
    const r = await probeDepthSensing(env(x), { isTrusted: false });
    expect(r.status).toBe("needs_user_gesture");
    expect(x.requestSession).not.toHaveBeenCalled();
  });

  it("asks for a session that REQUIRES depth-sensing, reports the format, and closes the session at once", async () => {
    const end = vi.fn(async () => undefined);
    const x = xr(true, { end });
    const r = await probeDepthSensing(env(x), { isTrusted: true });
    expect(r).toEqual({ status: "available", usage: "cpu-optimized", dataFormat: "luminance-alpha" });
    const args = (x.requestSession as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args[0]).toBe("immersive-ar");
    expect((args[1] as { requiredFeatures: string[] }).requiredFeatures).toContain("depth-sensing");
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("reports 'not available' with the browser's reason when the session is refused", async () => {
    const r = await probeDepthSensing(env(xr(true, { fail: "NotSupportedError: depth-sensing" })), { isTrusted: true });
    expect(r.status).toBe("not_available");
    expect(r.error).toMatch(/NotSupportedError/);
  });

  it("is 'unsupported' without WebXR or without a secure context", async () => {
    expect((await probeDepthSensing(env(null), { isTrusted: true })).status).toBe("unsupported");
    expect((await probeDepthSensing({ userAgent: ANDROID, isSecureContext: false, xr: xr(true) }, { isTrusted: true })).status).toBe("unsupported");
  });
});

describe("a surface only from real metric depth (SYNTHETIC test depth)", () => {
  const K = intrinsicsFor(220, 220, 24);
  const { depth, mask } = sphereDepth(K, 40, 300);
  const metric = (over: Partial<MetricDepth> = {}): MetricDepth => ({ map: depth, source: "synthetic_test", metric: true, ...over });

  it("with no depth map it returns null with the reason, and invents nothing", () => {
    for (const none of [null, undefined]) {
      const r = surfaceFromDepth(none, mask, K);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/no metric depth/);
    }
  });

  it("refuses relative depth, however it is labelled", () => {
    for (const bad of [metric({ metric: false }), metric({ source: "monocular_relative" }), metric({ source: "mediapipe_world" })]) {
      const r = surfaceFromDepth(bad, mask, K);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/relative/);
    }
  });

  it("builds the visible surface of a sphere with an area under the analytic cap and a note that it is one viewpoint only", () => {
    const r = surfaceFromDepth(metric(), mask, K, { maxEdgeMm: 80 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const analytic = visibleCapArea(40, 300);
    expect(r.visibleAreaMm2.value!).toBeGreaterThan(analytic * 0.8);
    expect(r.visibleAreaMm2.value!).toBeLessThan(analytic * 1.02);
    expect(r.visibleAreaMm2.basis).toBe("direct");
    expect(r.visibleAreaMm2.note).toMatch(/ONE viewpoint/);
    expect(r.validFraction).toBeGreaterThan(0.99);
    expect(r.notes.join(" ")).toMatch(/SYNTHETIC/);
  });

  it("refuses a depth map that is mostly holes (missing depth is never filled in)", () => {
    const holes = new Float32Array(depth.data);
    for (let i = 0; i < holes.length; i++) if (i % 3 !== 0) holes[i] = 0;
    const r = surfaceFromDepth({ map: { ...depth, data: holes }, source: "webxr_depth", metric: true }, mask, K);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/valid depth/);
  });

  it("refuses an empty mask and a malformed map", () => {
    expect(surfaceFromDepth(metric(), { ...mask, data: new Uint8Array(mask.data.length) }, K).ok).toBe(false);
    expect(surfaceFromDepth({ map: { width: 1, height: 1, data: new Float32Array(1) }, source: "webxr_depth", metric: true }, mask, K).ok).toBe(false);
  });
});
