// Drives the camera -> landmarks -> coin detection -> live checks -> frame collection loop.
// All image processing happens in the browser; only numeric FrameObservations leave it.
import type { FrameObservation, Point, PublicConfig } from "../api/types";
import { describeCameraError, openCamera, stopStream, type CameraErrorInfo, type Facing } from "../camera/camera";
import { detectCoin, type CoinDetection, type RgbaImage } from "../vision/coinDetector";
import { clear, COLORS, drawCoin, drawRoi, drawSkeleton } from "../vision/draw";
import { buildObservation, coinSearchWindow, meanBrightness } from "../vision/frameAnalysis";
import { actualHandedness, getHandTracker, type HandTracker } from "../vision/handTracker";
import { evaluateFrame, type LiveResult } from "../vision/liveChecks";
import { loadOpenCV, type CV } from "../vision/opencv";
import { LandmarkSmoother } from "../vision/smoothing";

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
}

export interface ScanControllerOptions {
  mode: ScanMode;
  facing: Facing;
  onStatus: (s: ScanStatus) => void;
  onComplete?: (frames: FrameObservation[]) => void;
  /** Diameter of the confirmed reference coin, for the live camera-distance check. */
  referenceDiameterMm?: number;
}

const MIN_FRAME_INTERVAL_MS = 60; // spread collected frames over time (~16 fps max)
// Between full coin searches the coin is tracked from its last position (much faster). A full
// search still runs at least every FULL_COIN_SEARCH_EVERY frames, and whenever tracking fails,
// so a second coin-like object is still noticed.
const FULL_COIN_SEARCH_EVERY = 5;

/** Start loading the measuring tools before the camera is opened (e.g. while the person reads
 *  the coin question and the guide). Failures are ignored here; start() reports them. */
export function preloadScanTools(mode: ScanMode = "scan"): void {
  loadOpenCV().catch(() => undefined);
  if (mode === "scan") getHandTracker().catch(() => undefined);
}
const CALIBRATION_INTERVAL_MS = 150;
const STATUS_INTERVAL_MS = 100;

export class ScanController {
  private stream: MediaStream | null = null;
  private tracker: HandTracker | null = null;
  private cv: CV | null = null;
  private running = false;
  private disposed = false;
  private frames: FrameObservation[] = [];
  private lastLandmarks: Point[] | null = null;
  private lastAcceptMs = 0;
  private lastCoinMs = 0;
  private lastStatusMs = 0;
  private frameTimes: number[] = [];
  private timing = { handMs: 0, coinMs: 0 };
  private trackedCoin: CoinDetection | null = null;
  private framesSinceFullSearch = 0;
  private smoother = new LandmarkSmoother();
  private roiCanvas: HTMLCanvasElement;
  private facing: Facing;
  private status: ScanStatus;

  constructor(
    private video: HTMLVideoElement,
    private overlay: HTMLCanvasElement,
    private config: PublicConfig,
    private opts: ScanControllerOptions,
  ) {
    this.facing = opts.facing;
    this.roiCanvas = document.createElement("canvas");
    this.status = {
      phase: "starting",
      live: null,
      collected: 0,
      target: config.capture.frames_target,
      handedness: null,
      coin: null,
      mirrored: false,
      fps: 0,
      timing: { handMs: 0, coinMs: 0 },
      error: null,
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
    this.emit({ phase: "starting", error: null }, true);
    if (!(await this.startCamera())) return;
    this.emit({ phase: "loading" }, true);
    try {
      const [tracker, cv] = await Promise.all([
        this.opts.mode === "scan" ? getHandTracker() : Promise.resolve(null),
        loadOpenCV(),
      ]);
      this.tracker = tracker;
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
    if (this.disposed || !this.stream) {
      // stopped while the models were loading (the shared tracker stays loaded for next time)
      this.tracker = null;
      return;
    }
    this.running = true;
    this.emit({ phase: "running" }, true);
    this.schedule();
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
    const track = this.stream.getVideoTracks()[0];
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
    this.frames = [];
    this.trackedCoin = null;
    this.lastLandmarks = null;
    this.smoother.reset();
    this.emit({ collected: 0 }, true);
  }

  stop(): void {
    this.disposed = true;
    this.running = false;
    stopStream(this.stream);
    this.stream = null;
    this.video.srcObject = null;
    this.tracker = null; // shared and reused by the next scan; not closed
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

  private detectInRoi(roi: { x: number; y: number; w: number; h: number }, range: [number, number] | null) {
    if (roi.w < 16 || roi.h < 16 || !this.cv) return { coin: null, brightness: null };
    const image = this.grab(roi);
    const p = this.config.coin_detection;
    let coin: CoinDetection | null = null;
    const seed = this.opts.mode === "scan" ? this.trackedCoin : null;
    if (seed && this.framesSinceFullSearch < FULL_COIN_SEARCH_EVERY) {
      const local = { ...seed, center_x: seed.center_x - roi.x, center_y: seed.center_y - roi.y };
      const tracked = detectCoin(this.cv, image, p, null, range, local);
      if (tracked.accepted) {
        coin = tracked;
        this.framesSinceFullSearch++;
      }
    }
    if (!coin) {
      coin = detectCoin(this.cv, image, p, null, range);
      this.framesSinceFullSearch = 0;
    }
    if (coin.found) {
      coin.center_x += roi.x;
      coin.center_y += roi.y;
    }
    this.trackedCoin = coin.accepted ? coin : null;
    return { coin, brightness: meanBrightness(image.data) };
  }

  private processScanFrame(): void {
    const canvas = this.prepareCanvas();
    if (!canvas || !this.tracker) return;
    const { ctx, w, h, scale } = canvas;
    const now = performance.now();
    const fps = this.trackFps(now);
    const hand = this.tracker.detect(this.video, now);
    const tHand = performance.now();

    let frame: FrameObservation | null = null;
    let coin: CoinDetection | null = null;
    let roi = null;
    if (hand) {
      const win = coinSearchWindow(hand.landmarks, w, h, this.config.coin_detection);
      roi = win.roi;
      const r = this.detectInRoi(win.roi, win.diameterRange);
      this.timing.coinMs = 0.8 * this.timing.coinMs + 0.2 * (performance.now() - tHand);
      coin = r.coin;
      frame = buildObservation({
        timestampMs: now,
        width: w,
        height: h,
        landmarks: hand.landmarks,
        world: hand.world,
        handedness: hand.handedness,
        handednessScore: hand.handednessScore,
        coin,
        brightness: r.brightness,
      });
    }
    this.timing.handMs = 0.8 * this.timing.handMs + 0.2 * (tHand - now);
    const live = evaluateFrame(frame, this.lastLandmarks, this.config.capture, this.config.calibration, {
      referenceDiameterMm: this.opts.referenceDiameterMm ?? NaN,
      assumedHfovDeg: this.config.assumed_hfov_deg,
    });
    this.lastLandmarks = hand ? hand.landmarks : null;

    if (frame && live.ok && now - this.lastAcceptMs >= MIN_FRAME_INTERVAL_MS) {
      this.frames.push(frame);
      this.lastAcceptMs = now;
    }

    clear(ctx);
    if (hand) {
      if (roi) drawRoi(ctx, roi, scale);
      drawSkeleton(ctx, this.smoother.smooth(hand.landmarks, now), live.ok ? COLORS.good : COLORS.neutral, scale);
    } else {
      this.smoother.reset();
      this.trackedCoin = null;
    }
    if (coin?.found) drawCoin(ctx, coin, scale);

    const done = this.frames.length >= this.config.capture.frames_target;
    this.emit(
      {
        live,
        fps,
        timing: { ...this.timing },
        coin,
        collected: this.frames.length,
        handedness: hand ? actualHandedness(hand.handedness) : this.status.handedness,
        phase: done ? "complete" : "running",
      },
      done,
    );
    if (done) {
      this.running = false;
      this.opts.onComplete?.(this.frames.slice(0, this.config.capture.max_frames_per_request));
    }
  }

  private processCalibrationFrame(): void {
    const canvas = this.prepareCanvas();
    if (!canvas) return;
    const { ctx, w, h, scale } = canvas;
    const now = performance.now();
    if (now - this.lastCoinMs < CALIBRATION_INTERVAL_MS) return;
    this.lastCoinMs = now;
    const fps = this.trackFps(now);
    // Central search window: the operator places the coin (on a palm or a flat surface) in the middle.
    const side = Math.round(Math.min(w, h) * 0.7);
    const roi = { x: Math.round((w - side) / 2), y: Math.round((h - side) / 2), w: side, h: side };
    const { coin } = this.detectInRoi(roi, null);
    clear(ctx);
    drawRoi(ctx, roi, scale);
    if (coin?.found) drawCoin(ctx, coin, scale);
    this.emit({ coin, fps, live: null });
  }
}
