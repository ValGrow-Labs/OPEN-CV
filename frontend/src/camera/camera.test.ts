import { describe, expect, it, vi } from "vitest";
import { describeCameraError, openCamera } from "./camera";

const err = (name: string) => Object.assign(new Error(name), { name });

describe("camera errors", () => {
  it.each([
    ["NotAllowedError", "permission_denied", true],
    ["PermissionDeniedError", "permission_denied", true],
    ["NotFoundError", "no_camera", true],
    ["NotReadableError", "camera_in_use", true],
    ["SecurityError", "insecure_context", false],
    ["UnsupportedError", "unsupported", false],
    ["SomethingElse", "unknown", true],
  ])("%s -> %s", (name, kind, retry) => {
    const info = describeCameraError(err(name));
    expect(info.kind).toBe(kind);
    expect(info.canRetry).toBe(retry);
    expect(info.message.length).toBeGreaterThan(20);
  });

  it("handles non-error values", () => {
    expect(describeCameraError(undefined).kind).toBe("unknown");
  });
});

describe("openCamera", () => {
  it("reports missing getUserMedia as unsupported", async () => {
    await expect(openCamera("user", undefined)).rejects.toMatchObject({ name: "UnsupportedError" });
  });

  it("propagates permission denial", async () => {
    const md = { getUserMedia: vi.fn().mockRejectedValue(err("NotAllowedError")) } as unknown as MediaDevices;
    await expect(openCamera("environment", md)).rejects.toMatchObject({ name: "NotAllowedError" });
  });

  it("retries with relaxed constraints when over-constrained", async () => {
    const stream = {} as MediaStream;
    const getUserMedia = vi.fn().mockRejectedValueOnce(err("OverconstrainedError")).mockResolvedValueOnce(stream);
    const md = { getUserMedia } as unknown as MediaDevices;
    await expect(openCamera("environment", md)).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1][0]).toEqual({ audio: false, video: true });
  });

  it("requests the chosen camera without audio", async () => {
    const getUserMedia = vi.fn().mockResolvedValue({} as MediaStream);
    await openCamera("user", { getUserMedia } as unknown as MediaDevices);
    const c = getUserMedia.mock.calls[0][0];
    expect(c.audio).toBe(false);
    expect(c.video.facingMode).toEqual({ ideal: "user" });
  });
});
