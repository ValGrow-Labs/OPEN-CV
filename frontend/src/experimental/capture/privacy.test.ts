import { describe, expect, it } from "vitest";
import { ALLOWED_API_GETS, findUploadViolations, MAX_URL_LENGTH, type RecordedRequest } from "./privacy";

const ORIGIN = "http://127.0.0.1:5199";
const get = (path: string, extra: Partial<RecordedRequest> = {}): RecordedRequest => ({ method: "GET", url: ORIGIN + path, postDataBytes: 0, ...extra });

describe("the no-upload rule", () => {
  it("allows static assets and GET /api/config", () => {
    const requests = [
      get("/experiment/"),
      get("/src/experimental/capture/main.tsx"),
      get("/models/hand_landmarker.task"),
      get("/mediapipe/wasm/vision_wasm_internal.wasm"),
      get("/opencv/opencv.js"),
      get("/api/config"),
      { method: "GET", url: "blob:http://127.0.0.1:5199/abc", postDataBytes: 0 },
      { method: "GET", url: "data:image/png;base64,AAAA", postDataBytes: 0 },
    ];
    expect(findUploadViolations(requests, ORIGIN)).toEqual([]);
    expect([...ALLOWED_API_GETS]).toEqual(["/api/config"]);
  });

  it("flags every POST, PUT, PATCH or DELETE", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(findUploadViolations([{ method, url: ORIGIN + "/api/config", postDataBytes: 0 }], ORIGIN).join(" ")).toMatch(/not a GET/);
    }
  });

  it("flags a body on any request, however it is sent", () => {
    const v = findUploadViolations([get("/api/config", { postDataBytes: 12 })], ORIGIN);
    expect(v.join(" ")).toMatch(/12 byte body/);
  });

  it("flags any other API call, including the scan endpoint and the validation, pilot and research routes", () => {
    for (const p of ["/api/scan", "/api/recommend", "/api/validation/scans", "/api/pilot/me/scans", "/api/research/records"]) {
      expect(findUploadViolations([get(p)], ORIGIN).join(" ")).toMatch(/other than GET \/api\/config/);
    }
  });

  it("flags a request to another origin and a URL that could carry data", () => {
    expect(findUploadViolations([{ method: "GET", url: "https://example.com/x", postDataBytes: 0 }], ORIGIN).join(" ")).toMatch(/another origin/);
    expect(findUploadViolations([get("/x?d=" + "A".repeat(MAX_URL_LENGTH))], ORIGIN).join(" ")).toMatch(/could carry data/);
  });

  it("reports an unparseable URL instead of ignoring it", () => {
    expect(findUploadViolations([{ method: "GET", url: "::::", postDataBytes: 0 }], ORIGIN)[0]).toMatch(/not a URL/);
  });
});
