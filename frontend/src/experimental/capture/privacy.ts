// The privacy rule of the EXPERIMENTAL capture prototype, as a checkable function.
//
// Images are personal data. The prototype sends nothing anywhere: the only network requests allowed are static assets of
// this site (GET) and `GET /api/config` (the same public settings the app reads). A test records every request the page makes
// and runs this check; it must find no violation.

export interface RecordedRequest {
  method: string;
  url: string;
  /** Size of the request body in bytes (0 when there is none). */
  postDataBytes: number;
}

/** Paths under /api/ that the page may GET. Anything else under /api/ is a violation. */
export const ALLOWED_API_GETS: readonly string[] = ["/api/config"];

/** A URL longer than this could carry data in the query string. */
export const MAX_URL_LENGTH = 2000;

/** The ways a recorded request breaks the rule (empty = clean). `origin` is the page's origin, e.g. http://127.0.0.1:5199. */
export function findUploadViolations(requests: readonly RecordedRequest[], origin: string): string[] {
  const out: string[] = [];
  for (const r of requests) {
    if (r.url.startsWith("data:") || r.url.startsWith("blob:")) continue; // never leaves the browser
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      out.push(`${r.method} ${r.url.slice(0, 80)}: not a URL`);
      continue;
    }
    const label = `${r.method} ${u.pathname}`;
    if (u.origin !== origin) out.push(`${label}: goes to another origin (${u.origin})`);
    if (r.method !== "GET" && r.method !== "HEAD") out.push(`${label}: not a GET`);
    if (r.postDataBytes > 0) out.push(`${label}: carries a ${r.postDataBytes} byte body`);
    if (r.url.length > MAX_URL_LENGTH) out.push(`${label}: URL is ${r.url.length} characters (could carry data)`);
    if (u.pathname.startsWith("/api/") && !ALLOWED_API_GETS.includes(u.pathname)) out.push(`${label}: an API call other than GET /api/config`);
  }
  return out;
}
