// Drives the camera -> landmarks -> coin detection -> live checks -> frame collection loop.
// All image processing happens in the browser; only numeric FrameObservations leave it.
import type { FrameObservation, Point, PublicConfig } from "../api/types";
import { describeCameraError, openCamera, stopStream, type CameraErrorInfo, type Facing } from "../camera/camera";
import { detectCoin, type CoinDetection, type RgbaImage } from "../vision/coinDetector";
import { clear, COLORS, drawCoin, drawHandOutline, drawRoi, drawSkeleton } from "../vision/draw";
import { buildObservation, coinSearchWindow, meanBrightness } from "../vision/frameAnalysis";
import { dist, insideFrame, MIDDLE_TIP, WRIST } from "../vision/geometry";
import { actualHandedness, getHandTracker, type DrawnFrame, type HandTracker } from "../vision/handTracker";
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
}

const MIN_FRAME_INTERVAL_MS = 50; // spread collected frames over time (~20 fps max)
// Between full coin searches the coin is tracked from its last position (much faster). A full
// search still runs at least every FULL_COIN_SEARCH_EVERY frames, and whenever tracking fails,
// so a second coin-like object is still noticed.
const FULL_COIN_SEARCH_EVERY = 5;
// A tracked coin is only reused while it still looks like a coin; a weak fit (a tracker that has
// drifted off the coin) falls back to a full search in the same frame.
const MIN_TRACK_CONFIDENCE = 0.5;

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
    this.tStartInit = performance.now();
    this.emit({ phase: "starting", error: null }, true);
    if (!(await this.startCamera())) return;
    this.tCameraReady = performance.now();
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
    this.startScanMs = performance.now();
    this.tFirstLock = 0;
    this.tFirstFrameCollected = 0;
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

  private grab(roi: { x: number; y: number; w: number; h: number }, frame: DrawnFrame | null): RgbaImage {
    const c = this.roiCanvas;
    if (c.width !== roi.w || c.height !== roi.h) {
      c.width = roi.w;
      c.height = roi.h;
    }
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    if (frame) ctx.drawImage(frame.canvas, frame.ox + roi.x * frame.k, frame.oy + roi.y * frame.k, roi.w * frame.k, roi.h * frame.k, 0, 0, roi.w, roi.h);
    else ctx.drawImage(this.video, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
    const img = ctx.getImageData(0, 0, roi.w, roi.h);
    return { data: img.data, width: roi.w, height: roi.h };
  }

  private trackFps(now: number): number {
    this.frameTimes.push(now);
    while (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.frameTimes.length < 2) return 0;
    return (1000 * (this.frameTimes.length - 1)) / (now - this.frameTimes[0]);
  }

  private detectInRoi(
    roi: { x: number; y: number; w: number; h: number },
    range: [number, number] | null,
    frame: DrawnFrame | null = null,
  ) {
    if (roi.w < 16 || roi.h < 16 || !this.cv) return { coin: null, brightness: null };
    const image = this.grab(roi, frame);
    const p = this.config.coin_detection;
    let coin: CoinDetection | null = null;
    const seed = this.opts.mode === "scan" ? this.trackedCoin : null;
    if (seed && this.framesSinceFullSearch < FULL_COIN_SEARCH_EVERY) {
      const local = { ...seed, center_x: seed.center_x - roi.x, center_y: seed.center_y - roi.y };
      const tracked = detectCoin(this.cv, image, p, null, range, local);
      if (tracked.accepted || (tracked.found && tracked.confidence >= MIN_TRACK_CONFIDENCE)) {
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
    this.trackedCoin = coin.found && (coin.accepted || coin.confidence >= MIN_TRACK_CONFIDENCE) ? coin : null;
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
    let smoothed: Point[] | null = null;
    if (hand) {
      smoothed = this.smoother.smooth(hand.landmarks, now);
      const inFrame = insideFrame(hand.landmarks, w, h, this.config.capture.edge_margin_fraction);
      const minSize = dist(hand.landmarks[WRIST], hand.landmarks[MIDDLE_TIP]) >= this.config.capture.min_hand_length_fraction * Math.min(w, h);

      let brightness: number | null = null;
      if (inFrame && minSize) {
        const win = coinSearchWindow(hand.landmarks, w, h, this.config.coin_detection);
        roi = win.roi;
        const r = this.detectInRoi(win.roi, win.diameterRange, this.tracker.lastFrame());
        this.timing.coinMs = 0.8 * this.timing.coinMs + 0.2 * (performance.now() - tHand);
        coin = r.coin;
        brightness = r.brightness;
      }
      frame = buildObservation({
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
    this.timing.handMs = 0.8 * this.timing.handMs + 0.2 * (tHand - now);
    const live = evaluateFrame(frame, this.lastLandmarks, this.config.capture, this.config.calibration, {
      referenceDiameterMm: this.opts.referenceDiameterMm ?? NaN,
      assumedHfovDeg: this.config.assumed_hfov_deg,
    });
    this.lastLandmarks = smoothed;

    if (live.ok && this.tFirstLock === 0) {
      this.tFirstLock = now;
    }

    if (frame && live.ok && now - this.lastAcceptMs >= MIN_FRAME_INTERVAL_MS) {
      if (this.frames.length === 0) {
        this.tFirstFrameCollected = now;
      }
      this.frames.push(frame);
      this.lastAcceptMs = now;
    }

    clear(ctx);
    if (hand && smoothed) {
      if (roi) drawRoi(ctx, roi, scale);
      const color = live.ok ? COLORS.good : COLORS.neutral;
      drawHandOutline(ctx, smoothed, color, scale, live.ok ? 1.0 : 0.6);
      drawSkeleton(ctx, smoothed, color, scale);
    } else {
      this.smoother.reset();
      this.trackedCoin = null;
    }
    if (coin?.found) drawCoin(ctx, coin, scale);

    const target = this.config.capture.frames_target;
    const minAccepted = this.config.capture.frames_min_accepted;
    const n = this.frames.length;
    const elapsedSec = (now - this.startScanMs) / 1000;
    const isStable =
      (n >= Math.min(14, target) && this.checkSampleStability(0.018)) ||
      (n >= minAccepted && elapsedSec >= 10 && this.checkSampleStability(this.config.capture.max_frame_rel_sd));
    const done = n >= target || isStable;
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
      const tDone = performance.now();
      const timingInfo: ScanTimingInfo = {
        cameraStartupMs: this.tCameraReady > 0 ? this.tCameraReady - this.tStartInit : 0,
        modelLoadMs: this.tModelsReady > 0 && this.tCameraReady > 0 ? this.tModelsReady - this.tCameraReady : 0,
        firstLockMs: this.tFirstLock > 0 ? this.tFirstLock - this.startScanMs : 0,
        collectionMs: this.tFirstFrameCollected > 0 ? tDone - this.tFirstFrameCollected : tDone - this.startScanMs,
        avgHandMs: this.timing.handMs,
        avgCoinMs: this.timing.coinMs,
        totalScanMs: tDone - this.startScanMs,
      };
      this.opts.onComplete?.(this.frames.slice(0, this.config.capture.max_frames_per_request), timingInfo);
    }
  }

  private checkSampleStability(maxRelSd: number): boolean {
    const minFrames = this.config.capture.frames_min_accepted;
    if (this.frames.length < minFrames) return false;
    const lengths: number[] = [];
    const refDiam = this.opts.referenceDiameterMm || 24.26;
    for (const f of this.frames) {
      if (!f.coin || f.coin.major_axis_px <= 0) continue;
      const dPx = dist(f.landmarks[WRIST], f.landmarks[MIDDLE_TIP]);
      const pxPerMm = f.coin.major_axis_px / refDiam;
      lengths.push(dPx / pxPerMm);
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
