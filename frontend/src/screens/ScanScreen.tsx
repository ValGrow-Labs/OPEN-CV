import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, submitScan } from "../api/client";
import type { FrameObservation, PublicConfig, ReferenceSelection, ScanRequest, ScanResponse } from "../api/types";
import { isMobileDevice, type Facing } from "../camera/camera";
import { preloadScanTools, ScanController, type ScanStatus } from "../scan/scanController";
import { Icon } from "../ui/components";
import { CoachIcon, coachKind, GUIDE_STEPS, liveStage } from "../ui/guide";
import { coinConfirmed, introSeen, markCoinConfirmed, markIntroSeen, referenceLabel } from "../ui/settings";
import { CoinConfirm } from "./CoinConfirm";
import { ScanGuide } from "./ScanGuide";

interface Props<R> {
  config: PublicConfig;
  chartId: string;
  reference: ReferenceSelection;
  onCancel: () => void;
  onResult: (r: R, mirrored: boolean) => void;
  /** Show the quick guide before starting the camera (defaults to "first visit only"). */
  showIntro?: boolean;
  /** Ask which coin is used before the camera starts (defaults to "once per session"). */
  requireCoinConfirm?: boolean;
  onReferenceConfirm?: (sel: ReferenceSelection) => void;
  /** Override how the scan is submitted (the developer validation mode uses its own endpoint). */
  submit?: (req: ScanRequest) => Promise<R>;
}

export function ScanScreen<R = ScanResponse>({
  config,
  chartId,
  reference,
  onCancel,
  onResult,
  showIntro,
  requireCoinConfirm,
  onReferenceConfirm,
  submit,
}: Props<R>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Load the measuring tools now, while the coin question and the guide are on screen.
  useEffect(() => preloadScanTools("scan"), []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<ScanController | null>(null);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingFrames, setPendingFrames] = useState<FrameObservation[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const ref = referenceLabel(config, reference);
  const [guide, setGuide] = useState<"intro" | "help" | null>(() => ((showIntro ?? !introSeen()) ? "intro" : null));
  const [confirming, setConfirming] = useState(() => requireCoinConfirm ?? !coinConfirmed(reference));
  const [cameraAllowed, setCameraAllowed] = useState(guide !== "intro" && !confirming);
  const mirroredRef = useRef(false);
  mirroredRef.current = status?.mirrored ?? false;

  const send = useCallback(
    async (frames: FrameObservation[]) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        const res = await (submit ?? (submitScan as unknown as (req: ScanRequest) => Promise<R>))({
          frames,
          reference: { ...reference, confirmed: true },
          chart_id: chartId,
          capture: { device_class: isMobileDevice() ? "mobile" : "desktop", camera_facing: mirroredRef.current ? "user" : "environment" },
        });
        controllerRef.current?.stop();
        onResult(res, mirroredRef.current);
      } catch (err) {
        setSubmitError(err instanceof ApiError ? err.message : "The scan could not be processed.");
      } finally {
        setSubmitting(false);
      }
    },
    [chartId, reference, onResult, submit],
  );

  const start = useCallback(() => {
    controllerRef.current?.stop();
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    setPendingFrames(null);
    setSubmitError(null);
    const facing: Facing = isMobileDevice() ? "environment" : "user";
    const c = new ScanController(video, canvas, config, {
      mode: "scan",
      facing,
      referenceDiameterMm: ref.diameter,
      onStatus: setStatus,
      onComplete: (frames) => {
        setPendingFrames(frames);
        void send(frames);
      },
    });
    controllerRef.current = c;
    void c.start();
  }, [config, send, ref.diameter]);

  // The camera (and its permission prompt) starts only after the quick guide.
  useEffect(() => {
    if (!cameraAllowed) return;
    start();
    return () => controllerRef.current?.stop();
  }, [start, cameraAllowed]);

  const confirmCoin = (sel: ReferenceSelection) => {
    onReferenceConfirm?.(sel);
    markCoinConfirmed(sel);
    setConfirming(false);
    if (guide !== "intro") setCameraAllowed(true);
  };

  const closeGuide = () => {
    if (guide === "intro") {
      markIntroSeen();
      setCameraAllowed(true);
    } else {
      controllerRef.current?.resetCollection();
    }
    setGuide(null);
  };

  // Announce instruction changes to screen readers (only when the text changes).
  const message = status?.live?.message ?? "";
  useEffect(() => {
    if (status?.phase === "running" && message) setAnnouncement(message);
  }, [message, status?.phase]);

  const phase = status?.phase ?? "starting";
  // ?debug=1 shows what the scanner sees, for diagnosing a scan on a real phone.
  const debug = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");
  const progress = status ? Math.min(1, status.collected / status.target) : 0;
  const [runningSec, setRunningSec] = useState(0);
  useEffect(() => {
    if (phase !== "running") {
      setRunningSec(0);
      return;
    }
    const timer = setInterval(() => setRunningSec((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const liveCodes = status?.live?.codes ?? [];
  const handSeen = status?.live ? !liveCodes.includes("no_hand") : false;
  const stage = phase === "complete" ? 3 : liveStage(liveCodes);

  return (
    <div className="scan" role="dialog" aria-modal="true" aria-label="Hand scan">
      <div className="scan-bar">
        <button className="icon-btn" onClick={onCancel} aria-label="Cancel scan">
          {Icon.close}
        </button>
        <span className="scan-ref small">
          {ref.label} · {ref.diameter.toFixed(2)} mm
        </span>
        <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <button className="icon-btn" onClick={() => setGuide("help")} aria-label="Show scan tips" disabled={guide !== null}>
            {Icon.help}
          </button>
          <button
            className="icon-btn"
            onClick={() => void controllerRef.current?.switchCamera()}
            aria-label="Switch camera"
            disabled={phase !== "running"}
          >
            {Icon.switchCamera}
          </button>
        </div>
      </div>

      <div className="stage">
        {debug && status && (
          <pre className="scan-debug" aria-hidden="true">
            {[
              `video ${videoRef.current?.videoWidth ?? 0}x${videoRef.current?.videoHeight ?? 0}  fps ${status.fps.toFixed(1)}`,
              `hand ${Math.round(status.timing.handMs)} ms  coin ${Math.round(status.timing.coinMs)} ms`,
              `coin ${status.coin?.found ? `${status.coin.method} d=${status.coin.major_axis_px.toFixed(1)}px conf=${status.coin.confidence.toFixed(2)} ${status.coin.accepted ? "ok" : (status.coin.reasons ?? []).join(",")}` : "not found"}`,
              `checks ${status.live?.codes.join(",") || "ok"}`,
            ].join("\n")}
          </pre>
        )}
        <video ref={videoRef} className={status?.mirrored ? "mirrored" : ""} playsInline muted aria-hidden="true" />
        <canvas ref={canvasRef} className={status?.mirrored ? "mirrored" : ""} aria-hidden="true" />
        {phase === "running" && !handSeen && <Guide />}
        {phase === "running" && status?.live && (
          <div className={`live-pill ${status.live.ok ? "ok" : ""}`} aria-hidden="true">
            <span key={status.live.message} className="live-text">
              <CoachIcon kind={coachKind(status.live.codes[0])} />
              {status.live.message}
            </span>
          </div>
        )}
        <div className="visually-hidden" aria-live="polite">
          {announcement}
        </div>

        {cameraAllowed && (phase === "starting" || phase === "loading") && (
          <div className="stage-message">
            <div className="stack" style={{ alignItems: "center" }}>
              <div className="spinner" />
              <p>{phase === "starting" ? "Starting camera…" : "Loading measuring tools…"}</p>
            </div>
          </div>
        )}

        {phase === "error" && status?.error && (
          <div className="stage-message">
            <div className="stage-card" role="alert">
              <h2>{status.error.title}</h2>
              <p style={{ opacity: 0.85 }}>{status.error.message}</p>
              <div className="row" style={{ justifyContent: "center" }}>
                {status.error.canRetry && (
                  <button className="btn btn-primary" onClick={start}>
                    Try again
                  </button>
                )}
                <button className="btn" onClick={onCancel}>
                  Back
                </button>
              </div>
            </div>
          </div>
        )}

        {(submitting || submitError) && (
          <div className="stage-message" style={{ background: "rgba(14,16,19,0.7)" }}>
            {submitting ? (
              <div className="stack" style={{ alignItems: "center" }}>
                <div className="spinner" />
                <p>Calculating your measurements…</p>
              </div>
            ) : (
              <div className="stage-card" role="alert">
                <h2>Couldn't reach the sizing service</h2>
                <p style={{ opacity: 0.85 }}>{submitError}</p>
                <div className="row" style={{ justifyContent: "center" }}>
                  {pendingFrames && (
                    <button className="btn btn-primary" onClick={() => void send(pendingFrames)}>
                      Retry
                    </button>
                  )}
                  <button className="btn" onClick={start}>
                    Rescan
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="scan-panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>{phase === "complete" ? "Captured" : "Measuring"}</strong>
          <span className="num small" style={{ opacity: 0.8 }}>
            {status?.collected ?? 0} / {status?.target ?? config.capture.frames_target} frames
          </span>
        </div>
        <div
          className="progress"
          data-fps={status ? Math.round(status.fps) : undefined}
          data-hand-ms={status ? Math.round(status.timing.handMs) : undefined}
          data-coin-ms={status ? Math.round(status.timing.coinMs) : undefined}
          role="progressbar"
          aria-label="Scan progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
        <ol className="scan-steps" aria-label="Scan steps">
          {GUIDE_STEPS.map((st, i) => {
            const state = i < stage ? "done" : i === stage && phase === "running" ? "current" : "todo";
            return (
              <li key={st.short} className={`scan-step is-${state}`} aria-current={state === "current" ? "step" : undefined}>
                <span className="scan-step-num">{state === "done" ? "✓" : i + 1}</span>
                <span className="scan-step-label">{st.short}</span>
                <span className="visually-hidden">{state === "done" ? " done" : state === "current" ? " in progress" : ""}</span>
              </li>
            );
          })}
        </ol>
        {runningSec >= 15 && phase === "running" && (status?.collected ?? 0) < 6 && (
          <div className="row" style={{ justifyContent: "center", alignItems: "center", marginTop: 8, gap: 10 }}>
            <span className="small muted">
              Tip: Hold your palm steady and flat ~30 cm away in bright light.
            </span>
            <button
              className="btn btn-quiet"
              style={{ padding: "3px 10px", fontSize: "0.75rem" }}
              onClick={() => controllerRef.current?.resetCollection()}
            >
              Reset
            </button>
          </div>
        )}
      </div>

      {confirming && <CoinConfirm config={config} reference={reference} onConfirm={confirmCoin} onCancel={onCancel} />}
      {!confirming && guide && <ScanGuide mode={guide} referenceLabel={`${ref.label}, ${ref.diameter.toFixed(2)} mm`} onDone={closeGuide} />}
    </div>
  );
}

function Guide() {
  return (
    <div className="guide" aria-hidden="true">
      <svg viewBox="0 0 240 300" style={{ height: "78%", maxWidth: "88%" }} fill="none">
        <path
          d="M78 268c-12-22-28-58-34-82-4-14 10-22 18-10l14 22V86c0-10 14-10 14 0v66V62c0-10 15-10 15 0v88V70c0-10 15-10 15 0v82V88c0-10 14-10 14 0v104c0 34-14 60-40 76z"
          stroke="rgba(255,255,255,0.55)"
          strokeWidth="2.5"
          strokeDasharray="7 6"
          strokeLinejoin="round"
        />
        <circle cx="118" cy="186" r="15" stroke="rgba(240,138,75,0.9)" strokeWidth="2.5" strokeDasharray="4 4" />
      </svg>
    </div>
  );
}
