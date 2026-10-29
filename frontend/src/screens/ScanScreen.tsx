import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, submitScan, warmupService } from "../api/client";
import type { CaptureView, FrameObservation, PublicConfig, ReferenceSelection, ScanRequest, ScanResponse } from "../api/types";
import { isMobileDevice, type Facing } from "../camera/camera";
import { preloadScanTools, ScanController, type ScanStatus, type ScanTimingBreakdown, type ScanTimingInfo } from "../scan/scanController";
import {
  canSkipRemaining,
  nextView,
  orientationChanged,
  SAME_WAY_UP_HINT,
  tagFrames,
  viewsForScan,
  viewStepLabel,
  viewStepOf,
  withViewFrames,
} from "../scan/views";
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
  onResult: (r: R, mirrored: boolean, timing?: ScanTimingBreakdown) => void;
  /** Show the quick guide before starting the camera (defaults to "first visit only"). */
  showIntro?: boolean;
  /** Ask which coin is used before the camera starts (defaults to "once per session"). */
  requireCoinConfirm?: boolean;
  onReferenceConfirm?: (sel: ReferenceSelection) => void;
  /** Override how the scan is submitted (the developer validation mode uses its own endpoint). */
  submit?: (req: ScanRequest) => Promise<R>;
  /** Angles to scan, primary first (the customer flow passes config.capture.views). Without it only the
   *  primary view is scanned and the frames are sent untagged, exactly as before (validation, pilot). */
  views?: CaptureView[];
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
  views,
}: Props<R>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Load the measuring tools now, while the coin question and the guide are on screen.
  // Also pre-warm the sizing service in the background so cold cloud instances boot up early.
  useEffect(() => {
    preloadScanTools("scan");
    warmupService();
  }, []);
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
  const startClickTimeRef = useRef<number>(0);

  // Guided angles. With more than one, a view that completes is kept (tagged) and the customer chooses
  // between scanning the next angle and seeing the size; everything goes to the server in one request.
  const viewList = viewsForScan(config, views);
  const multiView = viewList.length > 1;
  const [viewIdx, setViewIdx] = useState(0);
  const viewIdxRef = useRef(0);
  const capturedRef = useRef<FrameObservation[]>([]);
  const timingRef = useRef<ScanTimingInfo | undefined>(undefined);
  const [between, setBetween] = useState<{ done: CaptureView; next: CaptureView; frames: number; size: { width: number; height: number } | null } | null>(null);
  const [turned, setTurned] = useState(false);
  const view = viewList[viewIdx];

  const send = useCallback(
    async (frames: FrameObservation[], timingInfo?: ScanTimingInfo) => {
      setSubmitting(true);
      setSubmitError(null);
      const tApiStart = performance.now();
      try {
        const res = await (submit ?? (submitScan as unknown as (req: ScanRequest) => Promise<R>))({
          frames,
          reference: { ...reference, confirmed: true },
          chart_id: chartId,
          capture: { device_class: isMobileDevice() ? "mobile" : "desktop", camera_facing: mirroredRef.current ? "user" : "environment" },
        });
        const tApiEnd = performance.now();
        controllerRef.current?.stop();
        const breakdown: ScanTimingBreakdown = {
          cameraStartupMs: timingInfo?.cameraStartupMs ?? 0,
          modelLoadMs: timingInfo?.modelLoadMs ?? 0,
          firstLockMs: timingInfo?.firstLockMs ?? 0,
          collectionMs: timingInfo?.collectionMs ?? 0,
          handMs: timingInfo?.avgHandMs ?? 0,
          coinMs: timingInfo?.avgCoinMs ?? 0,
          apiMs: tApiEnd - tApiStart,
          totalSec: (tApiEnd - (startClickTimeRef.current || tApiStart)) / 1000,
          framesAccepted: (res as any).frames_accepted ?? frames.length,
          framesReceived: (res as any).frames_received ?? frames.length,
        };
        (window as any).__LAST_SCAN_TIMINGS__ = breakdown;
        onResult(res, mirroredRef.current, breakdown);
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
    startClickTimeRef.current = performance.now();
    const facing: Facing = isMobileDevice() ? "environment" : "user";
    setBetween(null);
    const c = new ScanController(video, canvas, config, {
      mode: "scan",
      facing,
      referenceDiameterMm: ref.diameter,
      view: viewList[viewIdxRef.current],
      onStatus: setStatus,
      onComplete: (frames, timing) => {
        const current = viewList[viewIdxRef.current];
        const next = nextView(viewList, viewIdxRef.current);
        timingRef.current = timing;
        if (!multiView) {
          setPendingFrames(frames);
          void send(frames, timing);
          return;
        }
        capturedRef.current = withViewFrames(capturedRef.current, current.id, tagFrames(frames, current.id));
        if (next) {
          const f0 = frames[0];
          setBetween({ done: current, next, frames: frames.length, size: f0 ? { width: f0.image_width, height: f0.image_height } : null });
        } else {
          controllerRef.current?.releaseWakeLock();
          setPendingFrames(capturedRef.current);
          void send(capturedRef.current, timing);
        }
      },
    });
    controllerRef.current = c;
    void c.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, send, ref.diameter, multiView, viewList.map((v) => v.id).join(",")]);

  /** Scan the next angle with the camera still open. */
  const scanNextView = () => {
    if (!between) return;
    viewIdxRef.current += 1;
    setViewIdx(viewIdxRef.current);
    setBetween(null);
    controllerRef.current?.startView(between.next);
  };

  /** Send what has been captured (the views that were skipped are simply absent). Never when a view
   *  that is still to come is required. */
  const finishWithCaptured = () => {
    if (!canSkipRemaining(viewList, viewIdxRef.current + (between ? 1 : 0))) return;
    controllerRef.current?.releaseWakeLock();
    setBetween(null);
    setPendingFrames(capturedRef.current);
    void send(capturedRef.current, timingRef.current);
  };

  /** Start over from the primary view (everything captured so far is dropped). */
  const restartAll = () => {
    viewIdxRef.current = 0;
    setViewIdx(0);
    capturedRef.current = [];
    start();
  };

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
  const progress = phase === "complete" ? 1 : status ? Math.min(1, status.collected / status.target) : 0;
  const [runningSec, setRunningSec] = useState(0);
  useEffect(() => {
    if (phase !== "running") {
      setRunningSec(0);
      return;
    }
    const timer = setInterval(() => setRunningSec((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const [submittingSec, setSubmittingSec] = useState(0);
  useEffect(() => {
    if (!submitting) {
      setSubmittingSec(0);
      return;
    }
    const timer = setInterval(() => setSubmittingSec((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [submitting]);

  // Has the phone been turned since the view just captured? (The frames of each view carry their own
  // size, so nothing is mixed up; this only tells the customer to hold the phone the same way.)
  useEffect(() => {
    if (!between) {
      setTurned(false);
      return;
    }
    const check = () => {
      const v = videoRef.current;
      setTurned(orientationChanged(between.size, v ? { width: v.videoWidth, height: v.videoHeight } : null));
    };
    check();
    const v = videoRef.current;
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    v?.addEventListener("resize", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
      v?.removeEventListener("resize", check);
    };
  }, [between]);

  const showHint =
    runningSec >= config.live_scan.hint_after_s &&
    (status?.collected ?? 0) < config.live_scan.mobile_frames_min &&
    status?.topIssue != null;
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
              `main ${status.topIssue ? `${status.topIssue.code} ${Math.round(status.topIssue.share * 100)}%` : "-"}`,
              `tilt ${status.tilt.rawDeg?.toFixed(1) ?? "-"} -> ${status.tilt.smoothedDeg?.toFixed(1) ?? "-"} deg  glare ${status.coin?.found ? `${Math.round(status.coin.glare_fraction * 100)}%` : "-"}  ev ${status.exposureEv ?? "n/a"}`,
              `coin ${ref.diameter.toFixed(1)} mm selected, hand ${status.liveMm ? `${Math.round(status.liveMm.handMm)} mm` : "-"} (accepted ${config.hand_length_plausible_mm[0]}-${config.hand_length_plausible_mm[1]})`,
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
                {multiView && capturedRef.current.length > 0 && canSkipRemaining(viewList, viewIdxRef.current) && (
                  <button className="btn" onClick={finishWithCaptured}>
                    Skip, see my size
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
              <div className="stack" style={{ alignItems: "center", maxWidth: 320, textAlign: "center" }}>
                <div className="spinner" />
                <p>
                  {submittingSec > 15
                    ? "Processing hand measurements… almost ready"
                    : submittingSec > 5
                    ? "Connecting to sizing service (waking server if idle)…"
                    : "Calculating your measurements…"}
                </p>
                {submittingSec > 8 && (
                  <span className="small muted" style={{ opacity: 0.75 }}>
                    Elapsed: {submittingSec}s
                  </span>
                )}
              </div>
            ) : (
              <div className="stage-card" role="alert">
                <h2>Couldn't reach the sizing service</h2>
                <p style={{ opacity: 0.85 }}>{submitError}</p>
                <div className="row" style={{ justifyContent: "center" }}>
                  {pendingFrames && (
                    <button className="btn btn-primary" onClick={() => void send(pendingFrames)} disabled={submitting}>
                      Retry
                    </button>
                  )}
                  <button className="btn" onClick={multiView ? restartAll : start} disabled={submitting}>
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
          <strong>
            {multiView && view ? `${view.label} · ` : ""}
            {phase === "complete" ? "Captured" : "Measuring"}
          </strong>
          <span className="num small" style={{ opacity: 0.8 }}>
            {status?.collected ?? 0} / {phase === "complete" ? (status?.collected ?? status?.target ?? config.capture.frames_target) : (status?.target ?? config.capture.frames_target)} frames
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
                <span className="scan-step-label">{viewStepLabel(view, viewList[0], i, st.short)}</span>
                <span className="visually-hidden">{state === "done" ? " done" : state === "current" ? " in progress" : ""}</span>
              </li>
            );
          })}
        </ol>
        {/* Both rows keep their space whether or not they have anything to say, so the camera
            picture above never changes size while the scan runs. */}
        {phase !== "error" && (
          <>
            <div className={`live-meter ${status?.liveMm ? "" : "is-idle"}`} aria-live="off" aria-hidden={!status?.liveMm}>
              <span className="live-meter-label">Hand length, live</span>
              <span className="live-meter-value num">{status?.liveMm ? Math.round(status.liveMm.handMm) : 0} mm</span>
              <span className="live-meter-sub num">
                {((status?.liveMm?.handMm ?? 0) / 25.4).toFixed(2)} in · final value after the scan
              </span>
            </div>
            <div className={`scan-hint ${showHint ? "" : "is-idle"}`} role="status" aria-hidden={!showHint}>
              <span className="small">
                Main problem: <strong>{status?.topIssue?.message ?? ""}</strong>
              </span>
              <button
                className="btn btn-quiet scan-hint-btn"
                tabIndex={showHint ? 0 : -1}
                onClick={() => {
                  controllerRef.current?.resetCollection();
                  setRunningSec(0);
                }}
              >
                Reset
              </button>
            </div>
          </>
        )}
      </div>

      {between && !submitting && !submitError && (
        <div className="view-sheet" role="group" aria-label={`Next angle: ${between.next.title}`}>
          <p className="view-sheet-done" aria-live="polite">
            ✓ {between.done.title} captured ({between.frames} frames)
          </p>
          <div className="view-sheet-body">
            {between.next.required && <p className="view-sheet-step">{viewStepOf(viewList, viewIdx + 1)}</p>}
            <h2>{between.next.title}</h2>
            <p className="view-sheet-text">{between.next.instruction}</p>
            {between.next.note && <p className="view-sheet-note">{between.next.note}</p>}
            <p className={`view-sheet-turned ${turned ? "" : "is-idle"}`} role="status" aria-hidden={!turned}>
              {SAME_WAY_UP_HINT}
            </p>
          </div>
          <div className="view-sheet-actions">
            <button className="btn btn-primary btn-lg" onClick={scanNextView}>
              Scan {between.next.label.toLowerCase()}
            </button>
            {canSkipRemaining(viewList, viewIdx + 1) && (
              <button className="btn btn-ghost" onClick={finishWithCaptured}>
                Skip, see my size
              </button>
            )}
          </div>
        </div>
      )}

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
