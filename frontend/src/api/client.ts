import type { ManualMeasurements, PublicConfig, Recommendation, ScanRequest, ScanResponse } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (err) {
    const aborted = (err as { name?: string }).name === "AbortError";
    throw new ApiError(aborted ? "The server took too long to respond." : "Could not reach the sizing service.", null);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = `Request failed (${res.status}).`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

export const fetchConfig = () => request<PublicConfig>("/api/config");

export const submitScan = (body: ScanRequest) =>
  request<ScanResponse>("/api/scan", { method: "POST", body: JSON.stringify(body) }, 30000);

export const fetchRecommendation = (
  chartId: string,
  measurements: { key: string; value_mm: number; uncertainty_mm: number; status: string }[],
) => request<Recommendation>("/api/recommend", { method: "POST", body: JSON.stringify({ chart_id: chartId, measurements }) });

export type { ManualMeasurements };
