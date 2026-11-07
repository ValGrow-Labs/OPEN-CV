// The ?debug panel of the scan screen: what the scanner and the page see, in plain text, for diagnosing a scan on a
// real phone (read it on the phone, or through chrome://inspect). Display only: it reads, it changes nothing.
import { useEffect, useState } from "react";
import type { ScanStatus } from "../scan/scanController";

export interface ScanDebugProps {
  status: ScanStatus | null;
  /** The camera element (for the stream's real size and settings). */
  video: HTMLVideoElement | null;
  overlay: {
    /** Config allows the 3D layer over the camera picture (live_scan.overlay_3d.enabled). */
    configured: boolean;
    /** The browser can create a WebGL context at all. */
    webgl: boolean;
    /** The 3D layer is on the picture right now. */
    on: boolean;
    /** The reason it is off, as shown to the customer, or null. */
    note: string | null;
  };
  /** Why the 3D landmark card could not start, or null. */
  viewerNote: string | null;
  reference: { label: string; diameterMm: number };
  plausibleHandMm: readonly [number, number];
}

type ApiState = { ok: boolean; text: string };

/** The state of the connection to the sizing API from THIS page: a request to /api/health on the page's own origin
 *  (the same path every other request uses), every few seconds. */
function useApiStatus(): ApiState {
  const [state, setState] = useState<ApiState>({ ok: false, text: "checking…" });
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const t0 = performance.now();
      try {
        const res = await fetch("/api/health", { cache: "no-store", signal: controller.signal });
        const ms = Math.round(performance.now() - t0);
        let version = "";
        try {
          version = ` · v${(await res.json()).version ?? "?"}`;
        } catch {
          /* not JSON: the address is not the sizing API */
        }
        if (alive) setState({ ok: res.ok, text: `${res.ok ? "OK" : "ERROR"} HTTP ${res.status} · ${ms} ms${version}` });
      } catch (err) {
        const aborted = (err as { name?: string }).name === "AbortError";
        if (alive) setState({ ok: false, text: aborted ? "FAILED: no answer in 6 s" : `FAILED: ${String(err)}` });
      } finally {
        clearTimeout(timer);
      }
    };
    void check();
    const id = setInterval(() => void check(), 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return state;
}

/** WebGL events and errors seen by the page (a lost context, a context that could not be created, a shader or
 *  three.js error), newest last. Listening from the start of the screen so nothing is missed. */
function useWebglErrors(): string[] {
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    const add = (msg: string) => setErrors((e) => [...e.slice(-5), `${new Date().toLocaleTimeString()} ${msg}`]);
    const lost = () => add("webglcontextlost");
    const restored = () => add("webglcontextrestored");
    const failed = (e: Event) => add(`webglcontextcreationerror ${(e as Event & { statusMessage?: string }).statusMessage ?? ""}`.trim());
    const onError = (e: ErrorEvent) => {
      if (/webgl|three|shader|GL_|gl\./i.test(`${e.message} ${e.filename}`)) add(`error: ${e.message}`);
    };
    // These events do not bubble: listen in the capture phase on the window.
    window.addEventListener("webglcontextlost", lost, true);
    window.addEventListener("webglcontextrestored", restored, true);
    window.addEventListener("webglcontextcreationerror", failed, true);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("webglcontextlost", lost, true);
      window.removeEventListener("webglcontextrestored", restored, true);
      window.removeEventListener("webglcontextcreationerror", failed, true);
      window.removeEventListener("error", onError);
    };
  }, []);
  return errors;
}

function cameraLines(video: HTMLVideoElement | null, status: ScanStatus | null): string[] {
  const stream = video?.srcObject as MediaStream | null | undefined;
  const track = stream?.getVideoTracks?.()[0];
  const s = track?.getSettings?.() ?? {};
  return [
    `camera   ${status?.phase ?? "not started"}${status?.error ? ` · ${status.error.title}` : ""}`,
    `stream   ${video?.videoWidth ?? 0}x${video?.videoHeight ?? 0}${s.frameRate ? ` @ ${Math.round(s.frameRate)} fps` : ""}${s.facingMode ? ` · ${s.facingMode}` : ""}${track ? ` · ${track.readyState}` : ""}${status ? ` · ${status.mirrored ? "mirrored (front)" : "not mirrored"}` : ""}`,
  ];
}

export function ScanDebug({ status, video, overlay, viewerNote, reference, plausibleHandMm }: ScanDebugProps) {
  const api = useApiStatus();
  const glErrors = useWebglErrors();
  const live = status?.live ?? null;
  const codes = live?.codes ?? [];
  const handFound = live ? !codes.includes("no_hand") : false;
  const coin = status?.coin ?? null;
  const stats = (window as unknown as { __OVERLAY_STATS__?: { level?: number; costMs?: number; pageFps?: number; reason?: string | null } }).__OVERLAY_STATS__;

  const lines = [
    `page     ${window.location.origin} · ${window.isSecureContext ? "secure context" : "NOT a secure context (no camera)"}`,
    `device   dpr ${window.devicePixelRatio} · ${window.innerWidth}x${window.innerHeight} · ${navigator.userAgent.replace(/^Mozilla\/5.0 /, "").slice(0, 90)}`,
    `api      ${api.text}`,
    ...cameraLines(video, status),
    `hand     ${handFound ? "found" : "not found"}${status?.handedness ? ` · ${status.handedness}` : ""} · ${status ? `${status.fps.toFixed(1)} fps, ${Math.round(status.timing.handMs)} ms/frame` : "-"}`,
    `coin     ${coin?.found ? `${coin.accepted ? "accepted" : `found, not accepted (${(coin.reasons ?? []).join(",") || "?"})`} · ${coin.method} d=${coin.major_axis_px.toFixed(1)}px conf=${coin.confidence.toFixed(2)}` : "not found"} · ${status ? `${Math.round(status.timing.coinMs)} ms` : "-"}`,
    `frames   accepted ${status?.collected ?? 0} / ${status?.target ?? "-"}`,
    `checks   ${codes.join(", ") || (live ? "all pass" : "-")}`,
    `problem  ${status?.topIssue ? `${status.topIssue.code} ${Math.round(status.topIssue.share * 100)}%` : "-"}`,
    `scale    ${reference.label} ${reference.diameterMm.toFixed(2)} mm · hand ${status?.liveMm ? `${Math.round(status.liveMm.handMm)} mm` : "-"} (accepted ${plausibleHandMm[0]}-${plausibleHandMm[1]})`,
    `tilt     ${status?.tilt.rawDeg?.toFixed(1) ?? "-"} -> ${status?.tilt.smoothedDeg?.toFixed(1) ?? "-"} deg · glare ${coin?.found ? `${Math.round(coin.glare_fraction * 100)}%` : "-"} · ev ${status?.exposureEv ?? "n/a"}`,
    `3d layer ${!overlay.configured ? "switched off by config" : !overlay.webgl ? "no WebGL in this browser" : overlay.on ? "on" : `off${overlay.note ? ` · ${overlay.note}` : ""}`}${stats ? ` · level ${stats.level ?? "?"} · cost ${stats.costMs?.toFixed?.(1) ?? "?"} ms · page ${Math.round(stats.pageFps ?? 0)} fps${stats.reason ? ` · ${stats.reason}` : ""}` : ""}`,
    `3d card  ${overlay.webgl ? (viewerNote ?? "ok") : "no WebGL in this browser"}`,
    `webgl    ${glErrors.length ? "" : "no errors seen"}`,
    ...glErrors.map((e) => `  ${e}`),
  ];

  return (
    <div className="scan-debug-panel" role="region" aria-label="Diagnostics">
      <strong>Diagnostics (?debug)</strong>
      <pre>{lines.join("\n")}</pre>
    </div>
  );
}
