// Steps 4-6 of the MILLIMESH flow: the capture screen (Palm, Side, Back). The camera, the hand tracking, the coin engine, the
// live checks and the submission are exactly the existing scan pipeline (scan/scanController.ts); this screen only changes
// how it looks and adds a REAL coverage figure per view (millimesh/coverage.ts, computed from accepted frames and the
// variety of angles the phone has seen the hand from). The particles are a visual effect.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, submitScan, warmupService } from "../api/client";
import type { CaptureView, FrameObservation, PublicConfig, ReferenceSelection, ScanResponse } from "../api/types";
import { isMobileDevice, type Facing } from "../camera/camera";
import type { Landmark } from "../hand3d/handModel";
import { webglAvailable } from "../hand3d/HandStage";
import { preloadScanTools, ScanController, type ScanStatus, type ScanTimingBreakdown, type ScanTimingInfo } from "../scan/scanController";
import { nextView, tagFrames, withViewFrames } from "../scan/views";
import { ScanDebug } from "../screens/ScanDebug";
import { referenceLabel } from "../ui/settings";
import { ArrowRight, CloseIcon, PhoneIcon, Ring, SwitchIcon, Wordmark } from "./Brand";
import { angleHint, computeCoverage, palmZSignOf, type Coverage, type PhaseId } from "./coverage";
import { guidanceText, isPhase, PHASE_ORDER, PHASES } from "./phases";
import { ParticleField } from "./ParticleField";

/** Most accepted frames one view collects while it waits for the phone to have seen the hand from enough angles. Three
 *  views stay well inside the server's 240-frame request limit. */
export const MAX_FRAMES_PER_VIEW = 60;

export interface CaptureResult {
  response: ScanResponse;
  mirrored: boolean;
  timing: ScanTimingBreakdown;
  /** The frames each view collected (untagged), for the fitted model. */
  frames: Record<PhaseId, FrameObservation[]>;
  /** The coverage each view ended with (0..100). */
  coverage: Record<PhaseId, number>;
}

interface Props {
  config: PublicConfig;
  chartId: string;
  reference: ReferenceSelection;
  views: CaptureView[];
  /** The close button. */
  onCancel: () => void;
  /** The camera could not start and the customer goes back to the camera step. */
  onBack: () => void;
  onDone: (r: CaptureResult) => void;
}

const phaseOf = (v: CaptureView | undefined): PhaseId => (v && isPhase(v.id) ? v.id : "palm");
const emptyFrames = (): Record<PhaseId, FrameObservation[]> => ({ palm: [], side: [], back: [] });
const emptyCoverage = (): Record<PhaseId, number> => ({ palm: 0, side: 0, back: 0 });

export function CaptureStep({ config, chartId, reference, views, onCancel, onBack, onDone }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<ScanController | null>(null);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const statusRef = useRef<ScanStatus | null>(null);
  statusRef.current = status;
  const ref = referenceLabel(config, reference);
  // The latest props, read when a scan is sent, so a parent that re-renders never restarts the camera.
  const latest = useRef({ reference, chartId, onDone });
  latest.current = { reference, chartId, onDone };

  const [viewIdx, setViewIdx] = useState(0);
  const viewIdxRef = useRef(0);
  const view = views[viewIdx];
  const phase = phaseOf(view);

  // What the 3D-free particle layer and the coverage need, without re-rendering every frame.
  const poseRef = useRef<readonly Landmark[] | null>(null);
  const frameRef = useRef<{ width: number; height: number } | null>(null);
  const coverageRef = useRef(0);
  const acceptedRef = useRef<FrameObservation[]>([]);
  const readyRef = useRef(false);
  const phaseFramesRef = useRef<Record<PhaseId, FrameObservation[]>>(emptyFrames());
  const doneCoverageRef = useRef<Record<PhaseId, number>>(emptyCoverage());
  const capturedRef = useRef<FrameObservation[]>([]);
  const palmSignRef = useRef<1 | -1 | null>(null);
  const mirroredRef = useRef(false);
  mirroredRef.current = status?.mirrored ?? false;
  const startClickRef = useRef(0);
  const timingRef = useRef<ScanTimingInfo | undefined>(undefined);

  const [cov, setCov] = useState<Coverage | null>(null);
  const [between, setBetween] = useState<{ done: PhaseId; next: CaptureView; donePercent: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingFrames, setPendingFrames] = useState<FrameObservation[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [degraded, setDegraded] = useState(false);
  const debug = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");

  useEffect(() => {
    preloadScanTools("scan");
    warmupService();
  }, []);

  /** Coverage of the view being scanned, from the frames the live checks accepted. */
  const coverageNow = useCallback(
    (pipelineReady: boolean): Coverage => {
      const v = views[viewIdxRef.current];
      const p = phaseOf(v);
      return computeCoverage({
        phase: p,
        frames: acceptedRef.current,
        framesTarget: statusRef.current?.target ?? config.live_scan.mobile_frames_target,
        pipelineReady,
        palmZSign: p === "palm" ? undefined : palmSignRef.current,
      });
    },
    [views, config.live_scan.mobile_frames_target],
  );

  const send = useCallback(
    async (frames: FrameObservation[], timingInfo?: ScanTimingInfo) => {
      setSubmitting(true);
      setSubmitError(null);
      const t0 = performance.now();
      try {
        const res = await submitScan({
          frames,
          reference: { ...latest.current.reference, confirmed: true },
          chart_id: latest.current.chartId,
          capture: { device_class: isMobileDevice() ? "mobile" : "desktop", camera_facing: mirroredRef.current ? "user" : "environment" },
        });
        const t1 = performance.now();
        controllerRef.current?.stop();
        const timing: ScanTimingBreakdown = {
          cameraStartupMs: timingInfo?.cameraStartupMs ?? 0,
          modelLoadMs: timingInfo?.modelLoadMs ?? 0,
          firstLockMs: timingInfo?.firstLockMs ?? 0,
          collectionMs: timingInfo?.collectionMs ?? 0,
          handMs: timingInfo?.avgHandMs ?? 0,
          coinMs: timingInfo?.avgCoinMs ?? 0,
          apiMs: t1 - t0,
          totalSec: (t1 - (startClickRef.current || t0)) / 1000,
          framesAccepted: res.frames_accepted ?? frames.length,
          framesReceived: res.frames_received ?? frames.length,
        };
        (window as unknown as { __LAST_SCAN_TIMINGS__?: ScanTimingBreakdown }).__LAST_SCAN_TIMINGS__ = timing;
        latest.current.onDone({ response: res, mirrored: mirroredRef.current, timing, frames: phaseFramesRef.current, coverage: doneCoverageRef.current });
      } catch (err) {
        setSubmitError(err instanceof ApiError ? err.message : "The scan could not be processed.");
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const start = useCallback(() => {
    controllerRef.current?.stop();
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    setPendingFrames(null);
    setSubmitError(null);
    setBetween(null);
    startClickRef.current = performance.now();
    viewIdxRef.current = 0;
    setViewIdx(0);
    capturedRef.current = [];
    phaseFramesRef.current = emptyFrames();
    doneCoverageRef.current = emptyCoverage();
    palmSignRef.current = null;
    acceptedRef.current = [];
    readyRef.current = false;
    const facing: Facing = isMobileDevice() ? "environment" : "user";
    const c = new ScanController(video, canvas, config, {
      mode: "scan",
      facing,
      referenceDiameterMm: ref.diameter,
      view: views[0],
      onStatus: setStatus,
      // The particle layer draws the hand; the controller's own 2D canvas stays empty (no outline, no coin ring).
      overlay3d: true,
      simpleOverlay: true,
      onPose: (landmarks, frame) => {
        poseRef.current = landmarks;
        frameRef.current = frame;
      },
      onFrameAccepted: (f) => {
        const list = acceptedRef.current;
        list.push(f);
        if (list.length > 200) list.shift();
      },
      onCollectionReset: () => {
        acceptedRef.current = [];
        readyRef.current = false;
      },
      // Keep the view open a little longer while the phone has not yet seen the hand from enough angles. It only asks for
      // MORE accepted frames (never fewer, never a frame that failed a check); the usual timeout still ends the view.
      holdCompletion: (frames) => {
        readyRef.current = true;
        if (frames.length >= MAX_FRAMES_PER_VIEW) return false;
        return !coverageNow(true).complete;
      },
      onComplete: (frames, timing) => {
        const idx = viewIdxRef.current;
        const current = views[idx];
        const p = phaseOf(current);
        timingRef.current = timing;
        phaseFramesRef.current = { ...phaseFramesRef.current, [p]: frames };
        const final = coverageNow(true);
        doneCoverageRef.current = { ...doneCoverageRef.current, [p]: final.percent };
        coverageRef.current = final.percent;
        setCov(final);
        if (p === "palm") palmSignRef.current = palmZSignOf(frames.filter((f) => f.coin?.accepted));
        capturedRef.current = withViewFrames(capturedRef.current, current.id, tagFrames(frames, current.id));
        const next = nextView(views, idx);
        if (next) {
          setBetween({ done: p, next, donePercent: final.percent });
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
  }, [config, send, ref.diameter, views, coverageNow]);

  useEffect(() => {
    start();
    return () => controllerRef.current?.stop();
  }, [start]);

  /** Begin the next phase with the camera still open. */
  const startNext = () => {
    if (!between) return;
    viewIdxRef.current += 1;
    setViewIdx(viewIdxRef.current);
    setBetween(null);
    coverageRef.current = 0;
    setCov(null);
    controllerRef.current?.startView(between.next);
  };

  const restartView = () => {
    controllerRef.current?.resetCollection();
    coverageRef.current = 0;
    setCov(null);
  };

  // Coverage, recomputed a few times a second from the accepted frames (not from time).
  useEffect(() => {
    if (status?.phase !== "running") return;
    const id = setInterval(() => {
      const c = coverageNow(readyRef.current);
      coverageRef.current = c.percent;
      setCov((prev) => (prev && prev.percent === c.percent && prev.frames === c.frames && prev.nextCell === c.nextCell && prev.phase === c.phase ? prev : c));
    }, 250);
    return () => clearInterval(id);
  }, [status?.phase, coverageNow]);

  const phaseRunning = status?.phase ?? "starting";
  const live = status?.live ?? null;
  const code = live?.codes?.[0];
  const guidance = (() => {
    if (!live) return "";
    if (!live.ok) return guidanceText(code, phase, live.message);
    if (cov?.complete) return "Coverage complete";
    return (cov && cov.frames >= 3 ? angleHint(phase, cov.nextCell) : null) ?? "Slowly move your phone around your hand";
  })();
  useEffect(() => {
    if (phaseRunning === "running" && guidance) setAnnouncement(guidance);
  }, [guidance, phaseRunning]);

  const percent = between ? between.donePercent : (cov?.percent ?? 0);
  const text = PHASES[phase];
  const nextText = between ? PHASES[phaseOf(between.next)] : null;
  const switchCamera = () => void controllerRef.current?.switchCamera();
  const startAgain = () => start();

  return (
    <main className="mm-screen mm-capture" aria-label="Hand scan" data-phase={phase} data-coverage={percent} data-frames={cov?.frames ?? 0}>
      <header className="mm-top mm-top--bar">
        <span className="mm-top-slot" />
        <Wordmark size="sm" />
        <span className="mm-top-slot mm-top-actions">
          <button className="mm-icon-btn" onClick={switchCamera} aria-label="Switch camera" disabled={phaseRunning !== "running"}>
            <SwitchIcon />
          </button>
          <button className="mm-icon-btn" onClick={onCancel} aria-label="Cancel scan">
            <CloseIcon />
          </button>
        </span>
      </header>
      <h1 className="visually-hidden">Hand scan: {text.title}</h1>

      <ol className="mm-tabs" aria-label="Scan views">
        {PHASE_ORDER.filter((id) => views.some((v) => phaseOf(v) === id)).map((id) => (
          <li key={id} className={id === phase ? "is-active" : ""} aria-current={id === phase ? "step" : undefined}>
            {PHASES[id].tab}
          </li>
        ))}
      </ol>

      <div className="mm-cam">
        <video ref={videoRef} className={status?.mirrored ? "mirrored" : ""} playsInline muted aria-hidden="true" />
        <canvas ref={canvasRef} className="mm-cam-draw" aria-hidden="true" />
        {!degraded && phaseRunning === "running" && !submitting && (
          <ParticleField poseRef={poseRef} frameRef={frameRef} coverageRef={coverageRef} mirror={status?.mirrored ?? false} onDegrade={() => setDegraded(true)} />
        )}
        <i className="mm-corner mm-corner--tl" aria-hidden="true" />
        <i className="mm-corner mm-corner--tr" aria-hidden="true" />
        <i className="mm-corner mm-corner--bl" aria-hidden="true" />
        <i className="mm-corner mm-corner--br" aria-hidden="true" />

        {phaseRunning === "running" && guidance && !between && !submitting && !submitError && (
          <div className={`mm-pill ${live?.ok ? "is-ok" : ""}`} aria-hidden="true">
            <span key={guidance}>{guidance}</span>
          </div>
        )}
        <div className="visually-hidden" aria-live="polite">
          {announcement}
        </div>

        {(phaseRunning === "starting" || phaseRunning === "loading") && (
          <div className="mm-cam-msg">
            <div className="mm-spinner" />
            <p>{phaseRunning === "starting" ? "Starting camera…" : "Loading measuring tools…"}</p>
          </div>
        )}

        {phaseRunning === "error" && status?.error && (
          <div className="mm-cam-msg">
            <div className="mm-sheet-card" role="alert">
              <h2>{status.error.title}</h2>
              <p>{status.error.message}</p>
              <div className="mm-actions mm-actions--row">
                {status.error.canRetry && (
                  <button className="mm-btn" onClick={startAgain}>
                    Try again
                  </button>
                )}
                <button className="mm-btn mm-btn--quiet" onClick={onBack}>
                  Back
                </button>
              </div>
            </div>
          </div>
        )}

        {(submitting || submitError) && (
          <div className="mm-cam-msg mm-cam-msg--veil">
            {submitting ? (
              <>
                <div className="mm-spinner" />
                <p>Calculating your measurements…</p>
                <p className="mm-fine">Fitting your estimated 3D model from your three views.</p>
              </>
            ) : (
              <div className="mm-sheet-card" role="alert">
                <h2>Couldn't reach the sizing service</h2>
                <p>{submitError}</p>
                <div className="mm-actions mm-actions--row">
                  {pendingFrames && (
                    <button className="mm-btn" onClick={() => void send(pendingFrames, timingRef.current)} disabled={submitting}>
                      Retry
                    </button>
                  )}
                  <button className="mm-btn mm-btn--quiet" onClick={startAgain} disabled={submitting}>
                    Rescan
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {degraded && (
        <p className="mm-note" role="note">
          The particle effect was switched off to keep the scan fast. Measuring is not affected.
        </p>
      )}

      {debug && (
        <ScanDebug
          status={status}
          video={videoRef.current}
          overlay={{ configured: true, webgl: webglAvailable(), on: false, note: "the MILLIMESH scan draws particles, not the 3D hand layer" }}
          viewerNote={null}
          reference={{ label: ref.label, diameterMm: ref.diameter }}
          plausibleHandMm={config.hand_length_plausible_mm}
        />
      )}

      {between && nextText && !submitting && !submitError ? (
        <section className="mm-card mm-card--between" role="group" aria-label={`Next: ${nextText.title}`}>
          <p className="mm-between-done" aria-live="polite">
            {PHASES[between.done].title.replace(" Scan", "")} captured · {between.donePercent}% coverage
          </p>
          <h2 className="mm-card-title">{nextText.title}</h2>
          <p className="mm-card-text">{nextText.intro}</p>
          <button className="mm-btn" onClick={startNext}>
            Start {nextText.tab.toLowerCase()} scan
            <ArrowRight />
          </button>
        </section>
      ) : (
        <section className="mm-card" aria-label="Scan status">
          <span className="mm-card-icon" aria-hidden="true">
            <PhoneIcon />
          </span>
          <div className="mm-card-body">
            <h2 className="mm-card-title">{text.title}</h2>
            <p className="mm-card-text">{text.instruction}</p>
            {cov && cov.frames > 0 && !submitting && (
              <button className="mm-link" onClick={restartView}>
                Restart this view
              </button>
            )}
          </div>
          <Ring percent={percent} label={`${text.title} coverage`} />
        </section>
      )}
    </main>
  );
}
