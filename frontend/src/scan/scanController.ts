// Drives the camera -> landmarks -> coin detection -> live checks -> frame collection loop.
// All image processing happens in the browser; only numeric FrameObservations leave it.
import type { CaptureView, FrameObservation, Point, PublicConfig } from "../api/types";
import { describeCameraError, isMobileDevice, openCamera, stopStream, type CameraErrorInfo, type Facing } from "../camera/camera";
import { ExposureController } from "../camera/exposure";
import { ScreenWakeLock } from "../camera/wakeLock";
import { getCoinEngine, type CoinEngine } from "../vision/coinEngine";
import { detectCoin, type CoinDetection, type RgbaImage } from "../vision/coinDetector";
import type { CoinJobResult } from "../vision/coinJob";
import { clear, COLORS, drawCoin, drawHandOutline, drawRoi, drawSkeleton, drawTag } from "../vision/draw";
import { buildObservation, coinSearchWindow, meanBrightness, type SearchWindow } from "../vision/frameAnalysis";
import { dist, handTurn, insideFrame, medianHandTurn, medianOf, MIDDLE_TIP, PALM_POLYGON, WRIST } from "../vision/geometry";
import { actualHandedness, getHandTracker, type HandFrame, type HandTracker } from "../vision/handTracker";
import { coinTiltDeg, smoothedTiltDeg } from "../vision/coinTilt";
import { evaluateBasicFrame, evaluateFrame, liveMessage, notSideOnTurn, sameSideTurn, withWrongSide, type LiveCode, type LiveResult } from "../vision/liveChecks";
import { FINGER_TIPS, labelAnchor, liveLengths, type FingerName, type LiveLengths } from "../vision/liveLengths";
import { loadOpenCV, type CV } from "../vision/opencv";
import { LandmarkSmoother } from "../vision/smoothing";
import { dominantIssue, GuidanceDebouncer, type IssueSample } from "./guidance";
import { viewFrameTarget } from "./views";
import { visibilityAction } from "./visibility";

export type ScanMode = "scan" | "calibration";
export type Phase = "starting" | "loading" | "running" | "complete" | "error";

export interface ScanStatus {
  phase: Phase;
  live: LiveResult | null;
  collected: number;
  target: number;
  handedness: "left" | "right" | null;
  coin: CoinDetection | null;
  mirrored: boolean;
  fps: number;
  /** Rolling average processing time per frame (ms): hand landmarks, coin detection. */
  timing: { handMs: number; coinMs: number };
  error: CameraErrorInfo | null;
  /** The problem shown most often over the last live_scan.issue_window_s seconds. */
  topIssue: TopIssue | null;
  /** The coin's tilt: this frame's own reading and the average over recent frames (diagnostics). */
  tilt: { rawDeg: number | null; smoothedDeg: number | null };
  /** Camera exposure compensation in EV, null when the browser does not allow it. */
  exposureEv: number | null;
  /** Rough lengths from the current frame (live_scan.show_live_measurements), once the coin is found. */
  liveMm: LiveLengths | null;
}

export interface TopIssue {
  code: LiveCode;
  message: string;
  /** Share of recent camera frames that showed it (0-1). */
  share: number;
}

export interface ScanTimingInfo {
  cameraStartupMs: number;
  modelLoadMs: number;
  firstLockMs: number;
  collectionMs: number;
  avgHandMs: number;
  avgCoinMs: number;
  totalScanMs: number;
}

export interface ScanTimingBreakdown {
  cameraStartupMs: number;
  modelLoadMs: number;
  firstLockMs: number;
  collectionMs: number;
  handMs: number;
  coinMs: number;
  apiMs: number;
  totalSec: number;
  framesAccepted: number;
  framesReceived: number;
}

export interface ScanControllerOptions {
  mode: ScanMode;
  facing: Facing;
  onStatus: (s: ScanStatus) => void;
  onComplete?: (frames: FrameObservation[], timing: ScanTimingInfo) => void;
  /** Diameter of the confirmed reference coin, for the live camera-distance check. */
  referenceDiameterMm?: number;
  /** The capture view being scanned (its own guidance wording); the primary (palm) view by default. */
  view?: CaptureView;
}

// Loop settings come from config/measurement.json "live_scan":
// * min_frame_interval_ms spreads the collected frames over time.
// * Between full coin searches the coin is tracked from its last position (much faster). A full
//   search still runs at least every full_coin_search_every frames, and whenever tracking fails,
//   so a second coin-like object is still noticed. A tracked coin is only reused while its
//   confidence is at least track_min_confidence (a weak fit means the tracker drifted).
// * Phones collect fewer frames (mobile_frames_target / _min) so a scan finishes sooner.
// * After timeout_s the scan completes with what it has, or reports why it could not.
//
// Real time: the coin search (OpenCV, the slow part) runs in a Web Worker, one search at a time,
// while every camera frame still gets hand tracking, the drawn outline and live guidance. Each
// coin result is paired with the hand landmarks of the very frame its pixels were cut from, and
// only such pairs are collected.

const IS_DEBUG = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");

/** Start loading the measuring tools before the camera is opened (e.g. while the person reads
 *  the coin question and the guide). Failures are ignored here; start() reports them. */
export function preloadScanTools(mode: ScanMode = "scan"): void {
  if (mode === "scan") {
    getHandTracker().catch(() => undefined);
    getCoinEngine().catch(() => undefined);
  } else {
    loadOpenCV().catch(() => undefined);
  }
}
const CALIBRATION_INTERVAL_MS = 150;
const STATUS_INTERVAL_MS = 100;

export class ScanController {
  private stream: MediaStream | null = null;
  private tracker: HandTracker | null = null;
  private cv: CV | null = null; // calibration mode only
  private engine: CoinEngine | null = null; // scan mode
  private coinBusy = false;
  private generation = 0; // bumped by reset/stop so late coin results are dropped
  private lastCoin: CoinDetection | null = null;
  private lastBrightness: number | null = null;
  // Recent coin ellipses, to judge tilt on their average (vision/coinTilt.ts).
  private recentCoins: CoinDetection[] = [];
  private tiltDeg: number | null = null;
  private guidance: GuidanceDebouncer;
  private exposure: ExposureController | null = null;
  // Why camera frames could not be used: recent ones for live guidance, totals for the timeout.
  private issueLog: IssueSample[] = [];
  private issueTotals = new Map<LiveCode, number>();
  private framesSeen = 0;
  private running = false;
  private disposed = false;
  private frames: FrameObservation[] = [];
  private lastLandmarks: Point[] | null = null;
  // The side of the hand each finished view showed (vision/geometry.ts handTurn), by view id: the back
  // view is refused while it still shows the same side as the palm did.
  private sideTurns = new Map<string, number>();
  private recentTurns: number[] = []; // the turn of the last few frames: one landmark frame is too noisy
  private lastAcceptMs = 0;
  private lastCoinMs = 0;
  private lastStatusMs = 0;
  private startScanMs = 0;
  private tStartInit = 0;
  private tCameraReady = 0;
  private tModelsReady = 0;
  private tFirstLock = 0;
  private tFirstFrameCollected = 0;
  private frameTimes: number[] = [];
  private timing = { handMs: 0, coinMs: 0 };
  private trackedCoin: CoinDetection | null = null;
  private framesSinceFullSearch = 0;
  private smoother = new LandmarkSmoother();
  private roiCanvas: HTMLCanvasElement;
  private facing: Facing;
  private status: ScanStatus;

  private mobile: boolean;
  private view: CaptureView | null;
  private wakeLock = new ScreenWakeLock();
  private pausedByHide = false;
  private effectiveTarget: number;
  private effectiveMin: number;
  private scanTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private video: HTMLVideoElement,
    private overlay: HTMLCanvasElement,
    private config: PublicConfig,
    private opts: ScanControllerOptions,
  ) {
    this.facing = opts.facing;
    this.roiCanvas = document.createElement("canvas");
    this.mobile = isMobileDevice();
    this.view = opts.view ?? null;
    this.guidance = new GuidanceDebouncer(config.live_scan);
    const ls = config.live_scan;
    this.effectiveMin = this.mobile ? Math.min(ls.mobile_frames_min, config.capture.frames_min_accepted) : config.capture.frames_min_accepted;
    this.effectiveTarget = this.targetFor(this.view);
    this.status = {
      phase: "starting",
      live: null,
      collected: 0,
      target: this.effectiveTarget,
      handedness: null,
      coin: null,
      mirrored: false,
      fps: 0,
      timing: { handMs: 0, coinMs: 0 },
      error: null,
      topIssue: null,
      tilt: { rawDeg: null, smoothedDeg: null },
      exposureEv: null,
      liveMm: null,
    };
  }

  private emit(patch: Partial<ScanStatus>, force = false): void {
    this.status = { ...this.status, ...patch };
    const now = performance.now();
    if (force || now - this.lastStatusMs >= STATUS_INTERVAL_MS) {
      this.lastStatusMs = now;
      this.opts.onStatus(this.status);
    }
  }

  async start(): Promise<void> {
    this.tStartInit = performance.now();
    this.emit({ phase: "starting", error: null }, true);
    if (!(await this.startCamera())) return;
    this.tCameraReady = performance.now();
    this.emit({ phase: "loading" }, true);
    try {
      const scan = this.opts.mode === "scan";
      const [tracker, engine, cv] = await Promise.all([
        scan ? getHandTracker() : Promise.resolve(null),
        scan ? getCoinEngine() : Promise.resolve(null),
        scan ? Promise.resolve(null) : loadOpenCV(),
      ]);
      this.tracker = tracker;
      this.engine = engine;
      this.cv = cv;
    } catch (err) {
      if (this.disposed) return;
      console.error("model loading failed", err);
      this.stop();
      this.emit(
        {
          phase: "error",
          error: {
            kind: "unknown",
            title: "The measuring tools could not load",
            message: "Check your internet connection and try again.",
            canRetry: true,
          },
        },
        true,
      );
      return;
    }
    this.tModelsReady = performance.now();
    if (this.disposed || !this.stream) {
      // stopped while the models were loading (the shared tracker stays loaded for next time)
      this.tracker = null;
      return;
    }
    this.running = true;
    this.startScanMs = performance.now();
    this.tFirstLock = 0;
    this.tFirstFrameCollected = 0;
    this.emit({ phase: "running" }, true);
    this.schedule();
    // Scan timeout — auto-complete with whatever we have (or error if nothing).
    this.scanTimeoutId = setTimeout(() => this.handleTimeout(), this.config.live_scan.timeout_s * 1000);
  }

  private async startCamera(): Promise<boolean> {
    let stream: MediaStream;
    try {
      stream = await openCamera(this.facing);
    } catch (err) {
      if (!this.disposed) this.emit({ phase: "error", error: describeCameraError(err) }, true);
      return false;
    }
    if (this.disposed) {
      // stop() was called while the permission prompt was open.
      stopStream(stream);
      return false;
    }
    this.stream = stream;
    // Keep the screen on while scanning, and look after the scan when the page is hidden and shown.
    void this.wakeLock.acquire();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    const track = this.stream.getVideoTracks()[0];
    this.exposure = new ExposureController(this.config.live_scan, track ?? null);
    const facingMode = track?.getSettings().facingMode;
    // Selfie cameras (and laptop webcams, which report no facing mode) are shown mirrored.
    const mirrored = facingMode ? facingMode === "user" : this.facing === "user";
    track?.addEventListener("ended", () => {
      if (this.running) {
        this.stop();
        this.emit({ phase: "error", error: describeCameraError({ name: "NotReadableError" }) }, true);
      }
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      await this.video.play();
    } catch (err) {
      this.emit({ phase: "error", error: describeCameraError(err) }, true);
      return false;
    }
    this.emit({ mirrored }, true);
    return true;
  }

  async switchCamera(): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    stopStream(this.stream);
    this.stream = null;
    this.facing = this.facing === "user" ? "environment" : "user";
    this.resetCollection();
    if (await this.startCamera()) {
      this.running = wasRunning || this.status.phase === "running";
      if (this.running) this.schedule();
    }
  }

  resetCollection(): void {
    this.generation++;
    this.frames = [];
    this.recentTurns = [];
    this.trackedCoin = null;
    this.framesSinceFullSearch = 0;
    this.lastCoin = null;
    this.recentCoins = [];
    this.tiltDeg = null;
    this.guidance.reset();
    this.issueLog = [];
    this.issueTotals.clear();
    this.framesSeen = 0;
    this.lastLandmarks = null;
    this.smoother.reset();
    this.startScanMs = performance.now();
    this.tFirstLock = 0;
    this.tFirstFrameCollected = 0;
    this.emit({ collected: 0 }, true);
  }

  /** The page went to the background or came back (see scan/visibility.ts). */
  private onVisibility = (): void => {
    const action = visibilityAction({
      visible: document.visibilityState === "visible",
      running: this.running,
      pausedByHide: this.pausedByHide,
    });
    if (action === "pause") {
      this.pausedByHide = true;
      this.running = false;
      if (this.scanTimeoutId) {
        clearTimeout(this.scanTimeoutId);
        this.scanTimeoutId = null;
      }
    } else if (action === "resume") {
      this.pausedByHide = false;
      if (this.disposed || !this.stream) return;
      const track = this.stream.getVideoTracks()[0];
      if (!track || track.readyState === "ended") {
        // the phone took the camera while the page was hidden
        this.stop();
        this.emit({ phase: "error", error: describeCameraError({ name: "NotReadableError" }) }, true);
        return;
      }
      // Start this view's collection over; the views already captured are kept by the screen.
      this.resetCollection();
      this.running = true;
      this.emit({ phase: "running" }, true);
      this.schedule();
      this.scanTimeoutId = setTimeout(() => this.handleTimeout(), this.config.live_scan.timeout_s * 1000);
    }
  };

  /** Let the screen sleep again (the scan is over, or only being submitted). */
  releaseWakeLock(): void {
    void this.wakeLock.release();
  }

  /** Frames to collect in a view: on a phone the view's own target (never below the minimum the
   *  server needs), otherwise the usual one. */
  private targetFor(view: CaptureView | null): number {
    return viewFrameTarget(view, this.mobile, this.config.live_scan.mobile_frames_target, this.config.capture.frames_target, this.effectiveMin);
  }

  /** Scan another view with the camera still open (after the previous view completed): clears what
   *  the last view collected, switches the guidance wording and starts the loop again. */
  startView(view: CaptureView): void {
    if (this.disposed || !this.stream || !this.tracker || !this.engine) return;
    this.view = view;
    this.effectiveTarget = this.targetFor(view);
    if (this.scanTimeoutId) {
      clearTimeout(this.scanTimeoutId);
      this.scanTimeoutId = null;
    }
    this.resetCollection();
    this.running = true;
    this.emit({ phase: "running", live: null, coin: null, liveMm: null, topIssue: null }, true);
    this.schedule();
    this.scanTimeoutId = setTimeout(() => this.handleTimeout(), this.config.live_scan.timeout_s * 1000);
  }

  stop(): void {
    this.disposed = true;
    this.running = false;
    this.pausedByHide = false;
    void this.wakeLock.release();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    this.generation++;
    if (this.scanTimeoutId) {
      clearTimeout(this.scanTimeoutId);
      this.scanTimeoutId = null;
    }
    stopStream(this.stream);
    this.stream = null;
    this.video.srcObject = null;
    this.tracker = null; // shared and reused by the next scan; not closed
  }

  private handleTimeout(): void {
    if (!this.running) return;
    this.scanTimeoutId = null;
    const n = this.frames.length;
    if (IS_DEBUG) console.warn(`[scan] timeout after ${this.config.live_scan.timeout_s}s, collected ${n} frames`);
    if (n >= this.effectiveMin) {
      // Auto-complete with what we have.
      this.running = false;
      const tDone = performance.now();
      this.emit({ phase: "complete", collected: n, target: n }, true);
      const timingInfo: ScanTimingInfo = {
        cameraStartupMs: this.tCameraReady > 0 ? this.tCameraReady - this.tStartInit : 0,
        modelLoadMs: this.tModelsReady > 0 && this.tCameraReady > 0 ? this.tModelsReady - this.tCameraReady : 0,
        firstLockMs: this.tFirstLock > 0 ? this.tFirstLock - this.startScanMs : 0,
        collectionMs: this.tFirstFrameCollected > 0 ? tDone - this.tFirstFrameCollected : tDone - this.startScanMs,
        avgHandMs: this.timing.handMs,
        avgCoinMs: this.timing.coinMs,
        totalScanMs: tDone - this.startScanMs,
      };
      this.rememberSide();
      this.opts.onComplete?.(this.frames.slice(0, this.config.capture.max_frames_per_request), timingInfo);
    } else {
      // Not enough frames — show an error.
      this.stop();
      this.emit(
        {
          phase: "error",
          error: {
            kind: "unknown",
            title: "Scan timed out",
            message: (n > 0
              ? `Only ${n} stable frames captured in ${this.config.live_scan.timeout_s}s.`
              : "No usable frames were captured.") + this.mainProblemText(),
            canRetry: true,
          },
        },
        true,
      );
    }
  }

  private recordIssue(now: number, code: LiveCode | null): void {
    this.framesSeen++;
    if (code) this.issueTotals.set(code, (this.issueTotals.get(code) ?? 0) + 1);
    this.issueLog.push({ t: now, code });
    const since = now - this.config.live_scan.issue_window_s * 1000;
    while (this.issueLog.length && this.issueLog[0].t < since) this.issueLog.shift();
  }

  private topIssue(): TopIssue | null {
    const top = dominantIssue(this.issueLog, -Infinity);
    return top ? { ...top, message: liveMessage(top.code, this.view) } : null;
  }

  /** For the timeout message: what the scan screen said most often, and how often. */
  private mainProblemText(): string {
    let best: LiveCode | null = null;
    for (const [code, n] of this.issueTotals) if (best === null || n > this.issueTotals.get(best)!) best = code;
    if (!best || this.framesSeen === 0) return " Make sure your whole hand and the coin are visible and hold still.";
    const pct = Math.round((100 * this.issueTotals.get(best)!) / this.framesSeen);
    return ` Most of the time (${pct}% of camera frames) the problem was: “${liveMessage(best, this.view)}”.`;
  }

  private schedule(): void {
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (typeof v.requestVideoFrameCallback === "function") v.requestVideoFrameCallback(() => this.tick());
    else requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    if (!this.running) return;
    try {
      if (this.opts.mode === "scan") this.processScanFrame();
      else this.processCalibrationFrame();
    } catch (err) {
      console.error("frame processing failed", err);
    }
    if (this.running) this.schedule();
  }

  private prepareCanvas(): { ctx: CanvasRenderingContext2D; w: number; h: number; scale: number } | null {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) return null;
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return null;
    return { ctx, w, h, scale: Math.max(1, Math.min(w, h) / 540) };
  }

  private grab(roi: { x: number; y: number; w: number; h: number }): RgbaImage {
    const c = this.roiCanvas;
    if (c.width !== roi.w || c.height !== roi.h) {
      c.width = roi.w;
      c.height = roi.h;
    }
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    // Always read from the live video element — NOT the intermediate square canvas used by
    // the hand tracker. The square canvas has been rescaled via drawImage(), which applies
    // bilinear interpolation and softens edges. This extra blur raises edge_width_px above
    // the coin acceptance threshold on mobile phones (causing permanent "image is blurry").
    ctx.drawImage(this.video, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
    const img = ctx.getImageData(0, 0, roi.w, roi.h);
    return { data: img.data, width: roi.w, height: roi.h };
  }

  private trackFps(now: number): number {
    this.frameTimes.push(now);
    while (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.frameTimes.length < 2) return 0;
    return (1000 * (this.frameTimes.length - 1)) / (now - this.frameTimes[0]);
  }

  /** Cut the search window from the current camera frame and search it for the coin in the
   *  background. The result is matched with this frame's hand landmarks (onCoin). */
  private requestCoin(hand: HandFrame, win: SearchWindow, now: number, w: number, h: number): void {
    const engine = this.engine;
    const { roi } = win;
    if (!engine || roi.w < 16 || roi.h < 16) return;
    const image = this.grab(roi);
    const brightness = meanBrightness(image.data); // of the whole window, before masking
    const ls = this.config.live_scan;
    const seed = this.trackedCoin && this.framesSinceFullSearch < ls.full_coin_search_every ? this.trackedCoin : null;
    const local = (p: { x: number; y: number }) => ({ x: p.x - roi.x, y: p.y - roi.y, z: 0 });
    const prevLandmarks = this.lastLandmarks; // the jitter reference, as for the live guidance
    const generation = this.generation;
    const t0 = performance.now();
    this.coinBusy = true;
    engine
      .run({
        image,
        params: this.config.coin_detection,
        diameterRange: win.diameterRange,
        // The palm outline means nothing for a view of the edge of the hand: nothing is masked there.
        palm: ls.palm_mask_grow === null || this.captureOnly ? null : PALM_POLYGON.map((i) => local(hand.landmarks[i])),
        palmGrow: ls.palm_mask_grow,
        seed: seed ? { ...seed, center_x: seed.center_x - roi.x, center_y: seed.center_y - roi.y } : null,
        trackMinConfidence: ls.track_min_confidence,
      })
      .then((res) => {
        if (generation !== this.generation || !this.running) return;
        this.timing.coinMs = 0.8 * this.timing.coinMs + 0.2 * (performance.now() - t0);
        this.onCoin(res, roi, { hand, now, w, h, brightness, prevLandmarks });
      })
      .catch((err) => console.error("coin search failed", err))
      .finally(() => {
        this.coinBusy = false;
      });
  }

  private onCoin(
    res: CoinJobResult,
    roi: { x: number; y: number },
    snap: { hand: HandFrame; now: number; w: number; h: number; brightness: number; prevLandmarks: Point[] | null },
  ): void {
    const coin = res.coin;
    if (coin.found) {
      coin.center_x += roi.x;
      coin.center_y += roi.y;
    }
    const ls = this.config.live_scan;
    this.framesSinceFullSearch = res.tracked ? this.framesSinceFullSearch + 1 : 0;
    this.trackedCoin = coin.found && (coin.accepted || coin.confidence >= ls.track_min_confidence) ? coin : null;
    this.lastCoin = coin;
    this.lastBrightness = snap.brightness;
    if (coin.found && (coin.accepted || coin.confidence >= ls.track_min_confidence)) {
      this.recentCoins.push(coin);
      while (this.recentCoins.length > this.config.calibration.tilt_window_frames) this.recentCoins.shift();
    } else if (!coin.found) {
      this.recentCoins = [];
    }
    this.tiltDeg = smoothedTiltDeg(this.recentCoins);
    if (IS_DEBUG && coin.found && !coin.accepted) {
      console.debug(`[coin] rejected: reasons=${coin.reasons.join(",")} edge_w=${coin.edge_width_px.toFixed(2)} conf=${coin.confidence.toFixed(3)} contrast=${coin.contrast.toFixed(3)}`);
    }
    const frame = this.observe(snap.hand, snap.now, snap.w, snap.h, coin, snap.brightness);
    const live = this.evaluate(frame, snap.prevLandmarks, this.tiltDeg);
    if (live.ok && this.tFirstLock === 0) this.tFirstLock = snap.now;
    if (live.ok && snap.now - this.lastAcceptMs >= ls.min_frame_interval_ms) {
      if (this.frames.length === 0) this.tFirstFrameCollected = snap.now;
      this.frames.push(frame);
      this.lastAcceptMs = snap.now;
    }
    this.finishIfDone(snap.now);
  }

  private observe(hand: HandFrame, now: number, w: number, h: number, coin: CoinDetection | null, brightness: number | null) {
    return buildObservation({
      timestampMs: now,
      width: w,
      height: h,
      landmarks: hand.landmarks,
      world: hand.world,
      handedness: hand.handedness,
      handednessScore: hand.handednessScore,
      coin,
      brightness,
    });
  }

  /** A view that is only captured (not used for size) is held to the basic checks, and gets no live lengths. */
  private get captureOnly(): boolean {
    return this.view?.used_for_size === false;
  }

  private evaluate(frame: FrameObservation | null, prevLandmarks: Point[] | null, tiltDeg: number | null = null): LiveResult {
    const live = this.evaluateView(frame, prevLandmarks, tiltDeg);
    if (!frame) {
      this.recentTurns = [];
      return live;
    }
    this.recentTurns.push(handTurn(frame.landmarks));
    while (this.recentTurns.length > this.config.capture.hand_turn_window_frames) this.recentTurns.shift();
    const turn = medianOf(this.recentTurns);
    const of = this.view?.opposite_of;
    if (of && sameSideTurn(turn, this.sideTurns.get(of), this.config.capture.hand_turn_min_abs)) return withWrongSide(live, this.view);
    if (notSideOnTurn(turn, this.view?.max_hand_turn_abs)) return withWrongSide(live, this.view);
    return live;
  }

  private evaluateView(frame: FrameObservation | null, prevLandmarks: Point[] | null, tiltDeg: number | null): LiveResult {
    if (this.captureOnly) return evaluateBasicFrame(frame, this.config.capture, this.view);
    // The view's own coin-tilt limit (the domed back of the hand tilts a coin whatever the phone does).
    const limit = this.view?.max_coin_tilt_deg;
    const calibration = limit == null ? this.config.calibration : { ...this.config.calibration, max_tilt_deg: limit };
    // ... and its own flatness limit (the depth estimate of a flat back of hand reads 28-43 degrees).
    const flat = this.view?.max_palm_tilt_deg_model;
    const capture = flat == null ? this.config.capture : { ...this.config.capture, max_palm_tilt_deg_model: flat };
    return evaluateFrame(
      frame,
      prevLandmarks,
      capture,
      calibration,
      {
        referenceDiameterMm: this.opts.referenceDiameterMm ?? NaN,
        assumedHfovDeg: this.config.assumed_hfov_deg,
        plausibleHandMm: this.config.hand_length_plausible_mm,
      },
      tiltDeg,
    );
  }

  /** What the customer is told: the per-frame result with its message settled by the guidance
   *  debouncer (frames are still collected only when the per-frame result is ok). */
  private shown(live: LiveResult, now: number): LiveResult {
    const code = this.guidance.update(now, live.codes);
    if (code === null) return { ok: true, codes: [], message: "Hold still while we measure" };
    return { ok: false, codes: [code, ...live.codes.filter((c) => c !== code)], message: liveMessage(code, this.view) };
  }

  /** Every camera frame: track the hand, start a coin search when none is running, draw the
   *  outline and update the live guidance (using the latest coin result). */
  private processScanFrame(): void {
    const canvas = this.prepareCanvas();
    if (!canvas || !this.tracker) return;
    const { ctx, w, h, scale } = canvas;
    const now = performance.now();
    const fps = this.trackFps(now);
    const hand = this.tracker.detect(this.video, now);
    this.timing.handMs = 0.8 * this.timing.handMs + 0.2 * (performance.now() - now);

    let smoothed: Point[] | null = null;
    let roi = null;
    if (hand) {
      smoothed = this.smoother.smooth(hand.landmarks, now);
      const inFrame = insideFrame(hand.landmarks, w, h, this.config.capture.edge_margin_fraction);
      const minSize = dist(hand.landmarks[WRIST], hand.landmarks[MIDDLE_TIP]) >= this.config.capture.min_hand_length_fraction * Math.min(w, h);
      if (inFrame && minSize) {
        const win = coinSearchWindow(hand.landmarks, w, h, this.config.coin_detection);
        roi = win.roi;
        if (!this.coinBusy) this.requestCoin(hand, win, now, w, h);
      }
    } else {
      this.smoother.reset();
      this.trackedCoin = null;
      this.lastCoin = null;
      this.recentCoins = [];
      this.tiltDeg = null;
      this.generation++; // a coin search still running belongs to a hand that is gone
    }

    const coin = hand ? this.lastCoin : null;
    const frameLive = this.evaluate(hand ? this.observe(hand, now, w, h, coin, this.lastBrightness) : null, this.lastLandmarks, this.tiltDeg);
    const live = this.shown(frameLive, now);
    this.lastLandmarks = smoothed;
    this.recordIssue(now, frameLive.ok ? null : frameLive.codes[0]);
    const ref = this.opts.referenceDiameterMm ?? NaN;
    const liveMm =
      this.config.live_scan.show_live_measurements && !this.captureOnly && smoothed && coin?.found && coin.accepted
        ? liveLengths(smoothed, coin.major_axis_px, ref)
        : null;

    clear(ctx);
    if (hand && smoothed) {
      if (roi) drawRoi(ctx, roi, scale);
      const color = live.ok ? COLORS.good : COLORS.neutral;
      drawHandOutline(ctx, smoothed, color, scale, live.ok ? 1.0 : 0.6);
      drawSkeleton(ctx, smoothed, color, scale);
    }
    if (coin?.found) drawCoin(ctx, coin, scale);
    if (liveMm && smoothed) {
      for (const f of Object.keys(FINGER_TIPS) as FingerName[]) {
        drawTag(ctx, labelAnchor(smoothed, f, 22 * scale), `${Math.round(liveMm.fingersMm[f])} mm`, scale, this.status.mirrored);
      }
    }

    if (!this.running) return; // finished by a coin result
    const top = this.topIssue();
    if (this.exposure?.ev != null) {
      const recent = dominantIssue(this.issueLog, Math.max(now - this.config.live_scan.issue_window_s * 1000, this.exposure.lastStepMs));
      this.exposure.consider(now, recent?.code ?? null, recent?.share ?? 0);
    }
    this.emit({
      live,
      fps,
      timing: { ...this.timing },
      coin,
      collected: this.frames.length,
      target: this.effectiveTarget,
      handedness: hand ? actualHandedness(hand.handedness) : this.status.handedness,
      topIssue: top,
      tilt: { rawDeg: coin?.found ? coinTiltDeg(coin) : null, smoothedDeg: this.tiltDeg },
      exposureEv: this.exposure?.ev ?? null,
      liveMm,
    });
  }

  private finishIfDone(now: number): void {
    const target = this.effectiveTarget;
    const minAccepted = this.effectiveMin;
    const n = this.frames.length;
    const elapsedSec = (now - this.startScanMs) / 1000;
    // Early stop once the collected frames agree closely (live_scan.early_stop_*).
    const ls = this.config.live_scan;
    const earlyN = Math.min(this.mobile ? ls.early_stop_frames_mobile : ls.early_stop_frames_desktop, target);
    const isStable =
      (n >= earlyN && this.checkSampleStability(ls.early_stop_rel_sd)) ||
      (n >= minAccepted && elapsedSec >= ls.early_stop_after_s && this.checkSampleStability(this.config.capture.max_frame_rel_sd));
    if (n < target && !isStable) {
      this.emit({ collected: n });
      return;
    }
    this.running = false;
    if (this.scanTimeoutId) {
      clearTimeout(this.scanTimeoutId);
      this.scanTimeoutId = null;
    }
    this.emit({ collected: n, target, coin: this.lastCoin, phase: "complete" }, true);
    const tDone = performance.now();
    if (IS_DEBUG) {
      console.log(`[scan] complete: ${n} frames in ${((tDone - this.startScanMs) / 1000).toFixed(1)}s, hand=${this.timing.handMs.toFixed(0)}ms coin=${this.timing.coinMs.toFixed(0)}ms`);
    }
    const timingInfo: ScanTimingInfo = {
      cameraStartupMs: this.tCameraReady > 0 ? this.tCameraReady - this.tStartInit : 0,
      modelLoadMs: this.tModelsReady > 0 && this.tCameraReady > 0 ? this.tModelsReady - this.tCameraReady : 0,
      firstLockMs: this.tFirstLock > 0 ? this.tFirstLock - this.startScanMs : 0,
      collectionMs: this.tFirstFrameCollected > 0 ? tDone - this.tFirstFrameCollected : tDone - this.startScanMs,
      avgHandMs: this.timing.handMs,
      avgCoinMs: this.timing.coinMs,
      totalScanMs: tDone - this.startScanMs,
    };
    this.rememberSide();
    this.opts.onComplete?.(this.frames.slice(0, this.config.capture.max_frames_per_request), timingInfo);
  }

  /** Note which side of the hand the view that just finished showed. */
  private rememberSide(): void {
    if (this.view) this.sideTurns.set(this.view.id, medianHandTurn(this.frames));
  }

  /** Relative spread of the hand length over the collected frames. The coin's real size cancels
   *  out of a relative spread, so hand length in coin diameters is enough. */
  private checkSampleStability(maxRelSd: number): boolean {
    const minFrames = this.effectiveMin;
    if (this.frames.length < minFrames) return false;
    const lengths: number[] = [];
    for (const f of this.frames) {
      if (!f.coin || f.coin.major_axis_px <= 0) continue;
      lengths.push(dist(f.landmarks[WRIST], f.landmarks[MIDDLE_TIP]) / f.coin.major_axis_px);
    }
    if (lengths.length < minFrames) return false;
    let sum = 0;
    for (const l of lengths) sum += l;
    const mean = sum / lengths.length;
    if (mean <= 0) return false;
    let varSum = 0;
    for (const l of lengths) varSum += (l - mean) ** 2;
    const sd = Math.sqrt(varSum / (lengths.length - 1));
    return sd / mean <= maxRelSd;
  }

  private processCalibrationFrame(): void {
    const canvas = this.prepareCanvas();
    if (!canvas || !this.cv) return;
    const { ctx, w, h, scale } = canvas;
    const now = performance.now();
    if (now - this.lastCoinMs < CALIBRATION_INTERVAL_MS) return;
    this.lastCoinMs = now;
    const fps = this.trackFps(now);
    // Central search window: the operator places the coin (on a palm or a flat surface) in the middle.
    const side = Math.round(Math.min(w, h) * 0.7);
    const roi = { x: Math.round((w - side) / 2), y: Math.round((h - side) / 2), w: side, h: side };
    const coin = detectCoin(this.cv, this.grab(roi), this.config.coin_detection, null, null);
    if (coin.found) {
      coin.center_x += roi.x;
      coin.center_y += roi.y;
    }
    clear(ctx);
    drawRoi(ctx, roi, scale);
    if (coin.found) drawCoin(ctx, coin, scale);
    this.emit({ coin, fps, live: null });
  }
}
