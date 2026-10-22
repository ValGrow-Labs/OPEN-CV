import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchConfig, submitScan } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

describe("api client", () => {
  it("returns JSON on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ok: 1 }, 200)));
    await expect(fetchConfig()).resolves.toEqual({ ok: 1 });
  });

  it("surfaces string error details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ detail: "unknown chart_id" }, 404)));
    await expect(submitScan({ frames: [], reference: { object_id: "us_quarter" } })).rejects.toMatchObject({
      status: 404,
      message: "unknown chart_id",
    });
  });

  it("maps structured validation errors to a generic message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ detail: [{ loc: ["body"] }] }, 422)));
    await expect(fetchConfig()).rejects.toMatchObject({ status: 422, message: "Request failed (422)." });
  });

  it("maps network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const e = await fetchConfig().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBeNull();
  });

  it("maps timeout to a clear explanation", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
    const e = await submitScan({ frames: [], reference: { object_id: "us_quarter" } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).message).toMatch(/The server took too long to respond/i);
  });

  it("maps 504 gateway timeout to starting up message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Gateway Timeout", { status: 504 })));
    const e = await submitScan({ frames: [], reference: { object_id: "us_quarter" } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(504);
    expect((e as ApiError).message).toMatch(/taking longer than usual/i);
  });
});
