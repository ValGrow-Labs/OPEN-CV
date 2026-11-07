// What depth can this phone give a WEB page? A typed, honest report, with injectable globals so it unit-tests anywhere.
//
// The smartphone RGB camera is the baseline and the fallback is ALWAYS available: nothing in the app may require depth.
// What a web page can and cannot reach:
//   * Android + Chrome: WebXR `immersive-ar` sessions may offer the `depth-sensing` feature on ARCore-supported phones
//     (the depth is estimated by ARCore, from motion and, on some phones, a ToF sensor). Whether a given phone offers it can
//     only be found out by REQUESTING a session, which needs a user gesture and takes over the camera: `probeDepthSensing`.
//   * iOS / Safari: no WebXR AR session. ARKit scene depth and the LiDAR depth map exist only inside a NATIVE app. They
//     are not reachable from a web page, whatever the phone has.
//   * MediaPipe world landmarks (what the app already has): metres with an origin near the hand's centre, but the depth
//     axis is a model's RELATIVE estimate, not calibrated physical depth. Never treat it as measured geometry.
//   * A learned monocular depth network gives relative depth too (up to an unknown scale and shift per image): not metric.
// Nothing here starts a camera or a session by itself.

export type Platform = "android" | "ios" | "desktop" | "other";

export interface XrSessionLike {
  depthUsage?: string;
  depthDataFormat?: string;
  end(): Promise<void>;
}

export interface XrLike {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession?(mode: string, init?: unknown): Promise<XrSessionLike>;
}

/** The parts of the browser this module reads (so tests can supply any phone). */
export interface DepthEnv {
  userAgent: string;
  maxTouchPoints?: number;
  isSecureContext: boolean;
  xr?: XrLike | null;
}

export function browserEnv(): DepthEnv {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { xr?: XrLike }) : undefined;
  return {
    userAgent: nav?.userAgent ?? "",
    maxTouchPoints: nav?.maxTouchPoints,
    isSecureContext: typeof window !== "undefined" ? window.isSecureContext : false,
    xr: nav?.xr ?? null,
  };
}

export function detectPlatform(env: Pick<DepthEnv, "userAgent" | "maxTouchPoints">): Platform {
  const ua = env.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Macintosh/i.test(ua) && (env.maxTouchPoints ?? 0) > 1) return "ios"; // iPadOS reports a Mac
  if (/Windows|Macintosh|X11|Linux|CrOS/i.test(ua)) return "desktop";
  return "other";
}

export type DepthPath = "rgb_only" | "webxr_depth_candidate";

export interface DepthCapabilityReport {
  platform: Platform;
  secureContext: boolean;
  /** `navigator.xr` exists. */
  webxr: boolean;
  /** `immersive-ar` sessions are supported (null: not asked, because WebXR is missing or the context is insecure). */
  immersiveAr: boolean | null;
  depthSensing: {
    /** A page cannot know without requesting a session (which needs a user gesture). */
    status: "unknown_until_user_gesture" | "not_available";
    reason: string;
  };
  nativeOnly: {
    arkitSceneDepth: { reachableFromWeb: false; note: string };
    lidar: { reachableFromWeb: false; note: string };
    arcoreNative: { reachableFromWeb: false; note: string };
  };
  mediapipeWorld: { available: true; kind: "relative_depth_metres"; calibrated: false; note: string };
  monocularNetworks: { kind: "relative_depth"; metric: false; note: string };
  /** What to try: "webxr_depth_candidate" only when a probe is worth offering; the RGB path is always available. */
  recommendedPath: DepthPath;
  fallbackAlwaysAvailable: true;
  notes: string[];
}

const NATIVE_NOTE = "Only reachable from a native app, never from a web page.";

export async function detectDepthCapabilities(env: DepthEnv = browserEnv()): Promise<DepthCapabilityReport> {
  const platform = detectPlatform(env);
  const notes: string[] = ["The smartphone RGB camera is the baseline; every depth source below is optional and the RGB path is always available."];
  const webxr = !!env.xr;
  let immersiveAr: boolean | null = null;
  if (webxr && env.isSecureContext) {
    try {
      immersiveAr = await env.xr!.isSessionSupported("immersive-ar");
    } catch {
      immersiveAr = false;
    }
  }
  let depthStatus: DepthCapabilityReport["depthSensing"];
  if (!env.isSecureContext) {
    depthStatus = { status: "not_available", reason: "WebXR needs a secure (HTTPS) context." };
  } else if (!webxr) {
    depthStatus = { status: "not_available", reason: platform === "ios" ? "Safari on iPhone and iPad has no WebXR AR session, so no depth from the web." : "This browser has no WebXR." };
  } else if (immersiveAr === false) {
    depthStatus = { status: "not_available", reason: "WebXR is present but immersive AR sessions are not supported here, so there is no AR depth." };
  } else {
    depthStatus = { status: "unknown_until_user_gesture", reason: "Immersive AR is supported; whether the `depth-sensing` feature is offered can only be found by requesting a session from a user action (probeDepthSensing)." };
  }
  if (platform === "ios") notes.push("iPhone and iPad: ARKit scene depth and LiDAR need a native app.");
  if (depthStatus.status === "unknown_until_user_gesture") notes.push("An AR depth session takes over the camera: it is a different capture mode from the scan screen, not something that runs alongside it.");
  return {
    platform,
    secureContext: env.isSecureContext,
    webxr,
    immersiveAr,
    depthSensing: depthStatus,
    nativeOnly: {
      arkitSceneDepth: { reachableFromWeb: false, note: NATIVE_NOTE },
      lidar: { reachableFromWeb: false, note: NATIVE_NOTE },
      arcoreNative: { reachableFromWeb: false, note: "A native Android app can use the ARCore Depth API directly; a web page only gets what WebXR exposes." },
    },
    mediapipeWorld: { available: true, kind: "relative_depth_metres", calibrated: false, note: "MediaPipe world landmarks have a model-estimated depth axis. Useful for visualisation and pose; not verified physical depth." },
    monocularNetworks: { kind: "relative_depth", metric: false, note: "Learned monocular depth is relative (unknown scale and shift per image). It is never millimetres until it is anchored to a physical reference and validated." },
    recommendedPath: depthStatus.status === "unknown_until_user_gesture" ? "webxr_depth_candidate" : "rgb_only",
    fallbackAlwaysAvailable: true,
    notes,
  };
}

export interface DepthProbeResult {
  status: "available" | "not_available" | "needs_user_gesture" | "unsupported";
  usage?: string;
  dataFormat?: string;
  error?: string;
}

/** Try to open a short WebXR session that REQUIRES the depth-sensing feature, then close it at once. Call it only from a
 *  user action (pass the event): a session cannot be started without one, and this function refuses to guess. */
export async function probeDepthSensing(env: DepthEnv, gesture: { isTrusted: boolean }): Promise<DepthProbeResult> {
  if (!gesture.isTrusted) return { status: "needs_user_gesture", error: "A depth probe must be started from a tap or click." };
  if (!env.isSecureContext || !env.xr?.requestSession) return { status: "unsupported", error: "No WebXR session can be requested here." };
  let session: XrSessionLike | undefined;
  try {
    session = await env.xr.requestSession("immersive-ar", {
      requiredFeatures: ["depth-sensing"],
      depthSensing: { usagePreference: ["cpu-optimized", "gpu-optimized"], dataFormatPreference: ["luminance-alpha", "float32"] },
    });
    return { status: "available", usage: session.depthUsage, dataFormat: session.depthDataFormat };
  } catch (err) {
    return { status: "not_available", error: String((err as Error)?.message ?? err) };
  } finally {
    try {
      await session?.end();
    } catch {
      /* already closed */
    }
  }
}
