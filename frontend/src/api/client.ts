import type {
  ManualMeasurements,
  PilotEnrolRequest,
  PilotInvite,
  PilotScanResult,
  PilotSession,
  TrialCondition,
  PublicConfig,
  Recommendation,
  ScanRequest,
  ScanResponse,
  ValidationRecord,
  ValidationScanRequest,
  ValidationSummary,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** `fieldErrors`: show the server's field-level validation messages (operator screens only;
 *  customers get a generic message). */
async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 25000, fieldErrors = false): Promise<T> {
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
    throw new ApiError(
      aborted
        ? "The server took too long to respond. The sizing service may be starting up—please retry."
        : "Could not reach the sizing service. Please check your network connection.",
      null,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = `Request failed (${res.status}).`;
    if (res.status === 504 || res.status === 502) {
      detail = "The sizing service is taking longer than usual to start up. Please retry in a few seconds.";
    }
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (fieldErrors && Array.isArray(body?.detail))
        detail = body.detail.map((d: { msg?: string }) => (d.msg ?? "").replace(/^Value error, /, "")).join("; ");
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

/** Pre-warm the backend (e.g. Render spin-up) in the background while the user reads guides or positions their hand. */
export function warmupService(): void {
  try {
    void fetch("/api/health", { method: "GET" }).catch(() => {});
  } catch {
    /* ignore pre-warm errors */
  }
}

// The free-tier server sleeps when idle and takes about 30-40 s to wake, so the first request of a
// visit is allowed to take that long (the page says it is waking the service).
export const fetchConfig = () => request<PublicConfig>("/api/config", {}, 75000);

export const submitScan = (body: ScanRequest) =>
  request<ScanResponse>("/api/scan", { method: "POST", body: JSON.stringify(body) }, 60000);

export const fetchRecommendation = (
  chartId: string,
  measurements: { key: string; value_mm: number; uncertainty_mm: number; status: string }[],
) => request<Recommendation>("/api/recommend", { method: "POST", body: JSON.stringify({ chart_id: chartId, measurements }) });

export type { ManualMeasurements };

// Developer validation mode (enabled only when the server allows it). Operator endpoints need
// the X-Glovesize-Operator header (CSRF guard) and, when the server is in token mode, a bearer
// token. The token is kept in memory only, never in storage.
let operatorToken: string | null = null;
export const setOperatorToken = (token: string | null) => {
  operatorToken = token?.trim() || null;
};
const operatorHeaders = (): Record<string, string> => ({
  "X-Glovesize-Operator": "1",
  ...(operatorToken ? { Authorization: `Bearer ${operatorToken}` } : {}),
});

export const fetchValidationRecords = () =>
  request<{ records: ValidationRecord[]; summary: ValidationSummary }>("/api/validation/records", { headers: operatorHeaders() });

export const submitValidationScan = (body: ValidationScanRequest) =>
  request<{ record: ValidationRecord; scan: ScanResponse }>(
    "/api/validation/scans",
    { method: "POST", body: JSON.stringify(body), headers: operatorHeaders() },
    30000,
    true,
  );

export const deleteValidationRecord = (id: string) =>
  request<{ deleted: string }>(`/api/validation/records/${encodeURIComponent(id)}`, { method: "DELETE", headers: operatorHeaders() });

/** The CSV export as text (fetched, so the operator headers can be sent). */
export async function fetchValidationCsv(): Promise<string> {
  const res = await fetch("/api/validation/records.csv", { headers: operatorHeaders() });
  if (!res.ok) throw new ApiError(`CSV export failed (${res.status}).`, res.status);
  return res.text();
}

// Remote pilot: operator invite management (operator headers) and the volunteer's own session,
// authenticated by the invite token from the link (sent as a header, never in a URL).
export const createPilotInvite = (purpose: "pilot" | "test") =>
  request<{ invite: PilotInvite; token: string }>(
    "/api/pilot/invites",
    { method: "POST", body: JSON.stringify({ purpose }), headers: operatorHeaders() },
    20000,
    true,
  );

export const fetchPilotInvites = () =>
  request<{ invites: PilotInvite[]; consent_reviewed: boolean }>("/api/pilot/invites", { headers: operatorHeaders() });

export const revokePilotInvite = (id: string) =>
  request<{ revoked: string }>(`/api/pilot/invites/${encodeURIComponent(id)}/revoke`, { method: "POST", headers: operatorHeaders() });

const pilotHeaders = (token: string) => ({ "X-Pilot-Token": token });

export const fetchPilotSession = (token: string) => request<PilotSession>("/api/pilot/me", { headers: pilotHeaders(token) }, 20000, true);

export const enrolPilot = (token: string, body: PilotEnrolRequest) =>
  request<{ enrolled: true }>("/api/pilot/me/enrol", { method: "POST", body: JSON.stringify(body), headers: pilotHeaders(token) }, 20000, true);

export const submitPilotScan = (
  token: string,
  body: { condition: TrialCondition; lighting: string; distance_cm?: number; scan: ScanRequest },
) =>
  request<PilotScanResult>("/api/pilot/me/scans", { method: "POST", body: JSON.stringify(body), headers: pilotHeaders(token) }, 30000, true);

export const withdrawPilot = (token: string) =>
  request<{ deleted_records: number }>("/api/pilot/me", { method: "DELETE", headers: pilotHeaders(token) }, 20000, true);
