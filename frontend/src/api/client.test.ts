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

  it("sends only a JSON body (no image payloads)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({}, 200));
    vi.stubGlobal("fetch", fetchMock);
    await submitScan({ frames: [], reference: { object_id: "us_quarter" } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["content-type"]).toBe("application/json");
    expect(typeof init.body).toBe("string");
  });
});
