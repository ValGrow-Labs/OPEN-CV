// @vitest-environment jsdom
// The device performance log: timings, heap samples (or null), the device's figures, errors as messages only (no paths
// or URLs from this machine), WebGL context losses, camera settings without identifiers, and device.json's exact fields.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cameraSettings, DeviceLog, readHeapMb, sanitizeMessage, type DeviceEnv } from "./deviceLog";

const ENV: DeviceEnv = { userAgent: "UA test", screen: { width: 412, height: 915, devicePixelRatio: 2.625 }, deviceMemory: 4, hardwareConcurrency: 8 };
const KEYS = ["user_agent", "screen", "device_memory_gb", "hardware_concurrency", "camera", "capture_ms", "build_ms", "export_ms", "heap_samples_mb", "peak_heap_mb", "errors", "webgl_context_lost", "export_ok", "started_at", "finished_at"];

afterEach(() => vi.useRealTimers());

describe("device log", () => {
  it("strips file paths, URLs and stack lines from messages", () => {
    expect(sanitizeMessage(new Error("boom at C:\\Users\\pc\\Downloads\\OPEN-CV\\x.ts:3:4\n    at foo (http://127.0.0.1:5231/src/a.ts:1:2)"))).toBe("boom at <path>");
    expect(sanitizeMessage("failed http://localhost:5173/src/x.ts:10 and /home/me/proj/file.js")).toBe("failed <url> and <path>");
    expect(sanitizeMessage({ code: 3 })).toBe('{"code":3}');
    expect(sanitizeMessage("x".repeat(400))).toHaveLength(300);
  });

  it("keeps the camera's settings without its device and group ids", () => {
    expect(cameraSettings({ width: 1280, height: 720, frameRate: 30, facingMode: "environment", deviceId: "abc", groupId: "def" })).toEqual({ width: 1280, height: 720, frameRate: 30, facingMode: "environment" });
    expect(cameraSettings(null)).toBeNull();
  });

  it("times capture, build and export, and writes device.json with exactly the agreed fields", () => {
    let t = 1000;
    const log = new DeviceLog(() => t, () => null, "2026-11-08T10:00:00.000Z");
    log.cameraStarted({ getSettings: () => ({ width: 1280, height: 720, frameRate: 30, deviceId: "secret" }) as MediaTrackSettings }, { width: 1280, height: 720 });
    t = 61_000;
    log.cameraStarted(null, { width: 1280, height: 720 }); // back to the camera: the capture clock keeps its first start
    t = 91_000;
    log.buildPressed();
    log.buildFinished(12_345.6);
    log.exportFinished(812.2, true);
    const j = log.toJson(ENV, "2026-11-08T10:02:00.000Z");
    expect(Object.keys(j)).toEqual(KEYS);
    expect(j).toMatchObject({
      user_agent: "UA test",
      screen: { width: 412, height: 915, device_pixel_ratio: 2.625 },
      device_memory_gb: 4,
      hardware_concurrency: 8,
      capture_ms: 90_000,
      build_ms: 12_346,
      export_ms: 812,
      export_ok: true,
      heap_samples_mb: null,
      peak_heap_mb: null,
      errors: [],
      webgl_context_lost: 0,
      started_at: "2026-11-08T10:00:00.000Z",
      finished_at: "2026-11-08T10:02:00.000Z",
    });
    expect(j.camera).toEqual({ width: 1280, height: 720, settings: null }); // the second start had no track
    expect(log.toJson(ENV, null, { export_ms: 5, export_ok: false })).toMatchObject({ export_ms: 5, export_ok: false });
    log.resetCapture();
    expect(log.toJson(ENV, null)).toMatchObject({ capture_ms: null, build_ms: null, export_ms: null, export_ok: null });
  });

  it("samples the heap every 2 s where the browser has performance.memory, and reports the peak", () => {
    vi.useFakeTimers();
    const values = [50, 80.5, 120, 90];
    let i = 0;
    const log = new DeviceLog(() => 0, () => values[Math.min(i++, values.length - 1)]);
    log.startHeap();
    vi.advanceTimersByTime(6000);
    log.stopHeap();
    expect(log.toJson(ENV, null)).toMatchObject({ heap_samples_mb: [50, 80.5, 120, 90], peak_heap_mb: 120 });
    expect(readHeapMb({ memory: { usedJSHeapSize: 52_428_800 } })).toBe(50);
    expect(readHeapMb({})).toBeNull();
  });

  it("records uncaught errors, unhandled rejections and WebGL context losses from window listeners, and detaches", () => {
    const log = new DeviceLog(() => 0, () => null);
    const detach = log.attach(window);
    window.dispatchEvent(new ErrorEvent("error", { message: "Uncaught TypeError: x is undefined", error: new Error("x is undefined at C:\\Users\\pc\\a.ts") }));
    const rej = new Event("unhandledrejection") as Event & { reason?: unknown };
    rej.reason = new Error("worker died");
    window.dispatchEvent(rej);
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    canvas.dispatchEvent(new Event("webglcontextlost")); // does not bubble: caught in the capture phase
    log.workerFailed("reconstruction", "out of memory");
    log.workerFailed("reconstruction", "out of memory"); // the same message once
    const j = log.toJson(ENV, null);
    expect(j.errors).toEqual(["x is undefined at <path>", "unhandled rejection: worker died", "worker (reconstruction): out of memory"]);
    expect(j.webgl_context_lost).toBe(1);
    detach();
    canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(log.toJson(ENV, null).webgl_context_lost).toBe(1);
  });
});
