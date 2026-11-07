// The live loop of the EXPERIMENTAL capture prototype: camera, hand tracking, coin search, per-view quality checks and the
// capture of a still. It REUSES the existing, working pieces read-only (src/camera, src/vision) and does not change them;
// it is deliberately a small loop of its own (compare src/scan/scanController.ts, which it follows for the wiring).
//
// Nothing is sent anywhere. A capture is a copy of the current video frame in memory plus the detections made on THAT frame.
import type { Point, PublicConfig } from "../../api/types";
import { describeCameraError, isMobileDevice, openCamera, stopStream, type CameraErrorInfo, type Facing } from "../../camera/camera";
import type { CoinDetection } from "../../vision/coinDetector";
import { getCoinEngine, type CoinEngine } from "../../vision/coinEngine";
import { coinSearchWindow } from "../../vision/frameAnalysis";
import { getHandTracker, type HandFrame, type HandTracker } from "../../vision/handTracker";
import { handTurn, insideFrame, PALM_POLYGON } from "../../vision/geometry";
import {
  AUTO_CAPTURE_FRAMES,
  FALLBACK_MAX_EDGE_TURN_ABS,
  FALLBACK_MAX_JITTER,
  FALLBACK_MIN_TURN_ABS,
  failedChecks,
  GoodRun,
  MIN_SHARPNESS,
  postureCheck,
  regionSharpness,
  smoothedTurn,
  steadiness,
  type QualityChips,
} from "./metrics";
import type { CoinSnapshot, StreamInfo } from "./types";
import type { ViewDef, ViewId } from "./views";

export type LivePhase = "idle" | "starting" | "loading" | "running" | "error";

export interface LiveStatus {
  phase: LivePhase;
  error: CameraErrorInfo | null;
  video: { width: number; height: number } | null;
  facing: Facing;
  /** The picture is shown mirrored (a front camera or a laptop webcam). */
  mirrored: boolean;
  fps: number;
  /** The checks of the armed view, or null while no view is armed. */
  chips: QualityChips | null;
  /** Plain-language reasons the current frame is not good. Empty while good. */
  reasons: string[];
  goodRun: number;
  /** The smoothed hand turn (see vision/geometry.ts handTurn), or null. */
  turn: number | null;
  /** What was loaded: the tracker's delegate and the coin engine's kind. */
  engines: { tracker: string; coin: string } | null;
}

export interface OverlayFrame {
  landmarks: Point[] | null;
  coin: CoinSnapshot | null;
  width: number;
  height: number;
}

/** What a capture hands back: the frame's pixels and every detection made on that same frame. */
export interface CapturedFrame {
  pixels: ImageData;
  width: number;
  height: number;
  landmarks: Point[];
  world: Point[] | null;
  handedness: "Left" | "Right" | null;
  handednessScore: number | null;
  coin: CoinSnapshot | null;
  chips: QualityChips;
  reasons: string[];
  turn: number | null;
  sharpness: number | null;
  jitter: number | null;
  trigger: "auto" | "button";
  stream: StreamInfo;
  capturedAt: string;
}

export interface LiveOptions {
  config: PublicConfig;
  /** Prefer this camera; default: the rear camera on a phone, the front camera elsewhere (as the product does). */
  facing?: Facing;
}

const STATUS_INTERVAL_MS = 100;
/** A capture that has not been followed by the next view being armed after this long is treated as lost and may fire again
 *  (the page re-arms within milliseconds when a capture succeeds, so this only ever triggers after a silent failure). */
const CAPTURE_RETRY_MS = 4000;
const HISTORY = 10;

function snapshotCoin(d: CoinDetection | null, offset: { x: number; y: number } = { x: 0, y: 0 }): CoinSnapshot | null {
  if (!d) return null;
  const { candidates: _c, ...rest } = d;
  return { ...rest, center_x: d.found ? d.center_x + offset.x : d.center_x, center_y: d.found ? d.center_y + offset.y : d.center_y };
}

export class LiveCapture {
  private video: HTMLVideoElement;
  private config: PublicConfig;
  private facing: Facing;
  private stream: MediaStream | null = null;
  private tracker: HandTracker | null = null;
  private engine: CoinEngine | null = null;
  private running = false;
  private disposed = false;
  private mirrored = false;

  private def: ViewDef | null = null;
  private turnOf: (view: ViewId) => number | null = () => null;
  private autoCapture = true;
  private goodRun = new GoodRun();
  private cooldownUntilArm = false;
  private cooldownSince = 0;
  private wantCapture: "auto" | "button" | null = null;

  private history: Point[][] = [];
  private turns: number[] = [];
  private lastSharpness: number | null = null;
  private lastCoin: CoinDetection | null = null;
  private trackedCoin: CoinDetection | null = null;
  private framesSinceFullSearch = 0;
  private coinBusy = false;
  private coinGeneration = 0;
  private roiCanvas = document.createElement("canvas");
  private sharpCanvas = document.createElement("canvas");
  private stillCanvas = document.createElement("canvas");
  private frameTimes: number[] = [];
  private lastStatusAt = 0;

  private status: LiveStatus;
  private statusListener: (s: LiveStatus) => void = () => undefined;
  private overlayListener: (o: OverlayFrame) => void = () => undefined;
  private captureListener: (c: CapturedFrame) => void = () => undefined;

  constructor(video: HTMLVideoElement, options: LiveOptions) {
    this.video = video;
    this.config = options.config;
    this.facing = options.facing ?? (isMobileDevice() ? "environment" : "user");
    this.status = {
      phase: "idle",
      error: null,
      video: null,
      facing: this.facing,
      mirrored: false,
      fps: 0,
      chips: null,
      reasons: [],
      goodRun: 0,
      turn: null,
      engines: null,
    };
  }

  onStatus(cb: (s: LiveStatus) => void): void {
    this.statusListener = cb;
  }
  onOverlay(cb: (o: OverlayFrame) => void): void {
    this.overlayListener = cb;
  }
  onCaptured(cb: (c: CapturedFrame) => void): void {
    this.captureListener = cb;
  }

  private publish(patch: Partial<LiveStatus> = {}, force = false): void {
    this.status = { ...this.status, ...patch };
    const now = performance.now();
    if (!force && now - this.lastStatusAt < STATUS_INTERVAL_MS) return;
    this.lastStatusAt = now;
    this.statusListener(this.status);
  }

  /** Arm a view: from now on the chips and the automatic capture judge this view. The turn of earlier views is read through `turnOf`. */
  armView(def: ViewDef | null, turnOf: (view: ViewId) => number | null, autoCapture: boolean): void {
    this.def = def;
    this.turnOf = turnOf;
    this.autoCapture = autoCapture;
    this.goodRun.reset();
    this.cooldownUntilArm = false;
    this.cooldownSince = 0;
    this.wantCapture = null;
    this.coinGeneration++;
    this.lastCoin = null;
    this.trackedCoin = null;
    this.publish({ chips: null, reasons: [], goodRun: 0 }, true);
  }

  setAutoCapture(on: boolean): void {
    this.autoCapture = on;
  }

  /** Capture on the next processed frame that shows a hand. */
  requestCapture(): void {
    this.wantCapture = "button";
  }

  async start(): Promise<void> {
    if (this.running || this.disposed) return;
    this.publish({ phase: "starting", error: null }, true);
    let stream: MediaStream;
    try {
      stream = await openCamera(this.facing);
    } catch (err) {
      this.publish({ phase: "error", error: describeCameraError(err) }, true);
      return;
    }
    if (this.disposed) {
      stopStream(stream);
      return;
    }
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    const facingMode = track?.getSettings().facingMode;
    this.mirrored = facingMode ? facingMode === "user" : this.facing === "user";
    track?.addEventListener("ended", () => {
      if (this.running) {
        this.stop();
        this.publish({ phase: "error", error: describeCameraError({ name: "NotReadableError" }) }, true);
      }
    });
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      await this.video.play();
    } catch (err) {
      this.publish({ phase: "error", error: describeCameraError(err) }, true);
      return;
    }
    this.publish({ phase: "loading", mirrored: this.mirrored, facing: this.facing }, true);
    try {
      const [tracker, engine] = await Promise.all([getHandTracker(), getCoinEngine()]);
      if (this.disposed) return;
      this.tracker = tracker;
      this.engine = engine;
    } catch (err) {
      this.publish({ phase: "error", error: { kind: "unknown", title: "The measuring tools did not load", message: String(err instanceof Error ? err.message : err), canRetry: true } }, true);
      return;
    }
    this.running = true;
    this.publish({ phase: "running", engines: { tracker: this.tracker.delegate, coin: this.engine.kind } }, true);
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.coinGeneration++;
    stopStream(this.stream);
    this.stream = null;
    this.video.srcObject = null;
    this.publish({ phase: "idle", chips: null, reasons: [], goodRun: 0 }, true);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private schedule(): void {
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (typeof v.requestVideoFrameCallback === "function") v.requestVideoFrameCallback(() => this.tick());
    else requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    if (!this.running) return;
    try {
      this.processFrame();
    } catch (err) {
      console.error("capture frame failed", err);
    }
    if (this.running) this.schedule();
  }

  private trackFps(now: number): number {
    this.frameTimes.push(now);
    while (this.frameTimes.length > 30) this.frameTimes.shift();
    return this.frameTimes.length < 2 ? 0 : (1000 * (this.frameTimes.length - 1)) / (now - this.frameTimes[0]);
  }

  private streamInfo(): StreamInfo {
    const track = this.stream?.getVideoTracks()[0];
    const safe = (o: unknown) => (o ? (JSON.parse(JSON.stringify(o)) as Record<string, unknown>) : null);
    return {
      settings: safe(track?.getSettings?.()) ?? {},
      capabilities: safe(track?.getCapabilities?.()),
      label: track?.label ?? "",
      facing: this.facing,
    };
  }

  private sharpnessOf(landmarks: Point[], w: number, h: number): number | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of landmarks) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    const pad = 0.1 * Math.max(x1 - x0, y1 - y0);
    const bx = Math.max(0, Math.floor(x0 - pad));
    const by = Math.max(0, Math.floor(y0 - pad));
    const bw = Math.min(w, Math.ceil(x1 + pad)) - bx;
    const bh = Math.min(h, Math.ceil(y1 + pad)) - by;
    if (bw < 16 || bh < 16) return null;
    const k = Math.min(1, 256 / Math.max(bw, bh));
    const tw = Math.max(8, Math.round(bw * k));
    const th = Math.max(8, Math.round(bh * k));
    const c = this.sharpCanvas;
    if (c.width !== tw || c.height !== th) {
      c.width = tw;
      c.height = th;
    }
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(this.video, bx, by, bw, bh, 0, 0, tw, th);
    const img = ctx.getImageData(0, 0, tw, th);
    return regionSharpness(img.data, tw, th);
  }

  private requestCoin(hand: HandFrame, w: number, h: number): void {
    const engine = this.engine;
    if (!engine || !this.def) return;
    const win = coinSearchWindow(hand.landmarks, w, h, this.config.coin_detection);
    const { roi } = win;
    if (roi.w < 16 || roi.h < 16) return;
    const c = this.roiCanvas;
    if (c.width !== roi.w || c.height !== roi.h) {
      c.width = roi.w;
      c.height = roi.h;
    }
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    // Read from the live video element, as the production scan does (a rescaled intermediate canvas would soften the coin's edge).
    ctx.drawImage(this.video, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
    const img = ctx.getImageData(0, 0, roi.w, roi.h);
    const ls = this.config.live_scan;
    const seed = this.trackedCoin && this.framesSinceFullSearch < ls.full_coin_search_every ? this.trackedCoin : null;
    const local = (p: { x: number; y: number }) => ({ x: p.x - roi.x, y: p.y - roi.y, z: 0 });
    const generation = this.coinGeneration;
    this.coinBusy = true;
    engine
      .run({
        image: { data: img.data, width: roi.w, height: roi.h },
        params: this.config.coin_detection,
        diameterRange: win.diameterRange,
        // The coin lies on the skin of the palm or back: everything outside the palm outline is masked, as in the product.
        palm: ls.palm_mask_grow === null ? null : PALM_POLYGON.map((i) => local(hand.landmarks[i])),
        palmGrow: ls.palm_mask_grow,
        seed: seed ? { ...seed, center_x: seed.center_x - roi.x, center_y: seed.center_y - roi.y } : null,
        trackMinConfidence: ls.track_min_confidence,
      })
      .then((res) => {
        if (generation !== this.coinGeneration || !this.running) return;
        const coin = res.coin;
        if (coin.found) {
          coin.center_x += roi.x;
          coin.center_y += roi.y;
        }
        this.framesSinceFullSearch = res.tracked ? this.framesSinceFullSearch + 1 : 0;
        this.trackedCoin = coin.found && (coin.accepted || coin.confidence >= ls.track_min_confidence) ? coin : null;
        this.lastCoin = coin;
      })
      .catch((err) => console.error("coin search failed", err))
      .finally(() => {
        this.coinBusy = false;
      });
  }

  private processFrame(): void {
    if (!this.tracker) return;
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) return;
    const now = performance.now();
    const fps = this.trackFps(now);
    const hand = this.tracker.detect(this.video, now);
    if (!hand) {
      this.history = [];
      this.turns = [];
      this.trackedCoin = null;
      this.lastCoin = null;
      this.lastSharpness = null;
      this.goodRun.reset();
      this.coinGeneration++;
      this.overlayListener({ landmarks: null, coin: null, width: w, height: h });
      this.publish({ video: { width: w, height: h }, fps, chips: null, reasons: this.def ? ["No hand found."] : [], goodRun: 0, turn: null });
      return;
    }
    const lm = hand.landmarks;
    this.history.push(lm);
    this.turns.push(handTurn(lm));
    while (this.history.length > HISTORY) this.history.shift();
    while (this.turns.length > HISTORY) this.turns.shift();

    const def = this.def;
    const cap = this.config.capture;
    const inFrame = insideFrame(lm, w, h, cap.edge_margin_fraction);
    const sideLimit = cap.views.find((v) => v.id === "side")?.max_hand_turn_abs ?? FALLBACK_MAX_EDGE_TURN_ABS;
    const turn = smoothedTurn(this.turns);

    if (def?.requiresCoin && inFrame && !this.coinBusy) this.requestCoin(hand, w, h);
    if (def && !def.requiresCoin) {
      this.lastCoin = null;
      this.trackedCoin = null;
    }
    this.lastSharpness = this.sharpnessOf(lm, w, h);
    const steady = steadiness(this.history, cap.max_landmark_jitter_fraction ?? FALLBACK_MAX_JITTER);
    const coin = this.lastCoin;
    this.overlayListener({ landmarks: lm, coin: snapshotCoin(coin), width: w, height: h });

    if (!def) {
      this.publish({ video: { width: w, height: h }, fps, chips: null, reasons: [], goodRun: 0, turn });
      return;
    }
    const chips: QualityChips = {
      handFound: true,
      inFrame,
      coin: { required: def.requiresCoin, found: !!coin?.found, accepted: !!coin?.accepted, reasons: coin?.reasons ?? [] },
      posture: postureCheck(def.posture, turn, { minTurnAbs: cap.hand_turn_min_abs ?? FALLBACK_MIN_TURN_ABS, maxEdgeTurnAbs: sideLimit, turnOf: this.turnOf }),
      steady,
      sharpness: { value: this.lastSharpness, sharp: this.lastSharpness !== null && this.lastSharpness >= MIN_SHARPNESS },
    };
    const reasons = failedChecks(def, chips);
    const run = this.goodRun.push(reasons.length === 0);
    this.publish({ video: { width: w, height: h }, fps, chips, reasons, goodRun: run, turn });

    const lost = this.cooldownUntilArm && now - this.cooldownSince > CAPTURE_RETRY_MS;
    if (lost) console.warn(`[capture] no new view was armed ${CAPTURE_RETRY_MS} ms after the last capture of ${def.id}: allowing a retry`);
    const auto = this.autoCapture && (!this.cooldownUntilArm || lost) && run >= AUTO_CAPTURE_FRAMES;
    if (this.wantCapture || auto) {
      const trigger = this.wantCapture ?? "auto";
      this.wantCapture = null;
      this.cooldownUntilArm = true; // one capture per armed view; armView() (the next view, or a retake) lifts it
      this.cooldownSince = now;
      console.info(`[capture] ${trigger} capture of ${def.id} (good frames ${run}, turn ${turn?.toFixed(2)})`);
      try {
        this.captureNow(hand, chips, reasons, turn, steady.jitter, trigger);
      } catch (err) {
        // A capture that failed must not leave the view stuck: allow another try.
        this.cooldownUntilArm = false;
        console.error("capture failed", err);
        throw err;
      }
    }
  }

  private captureNow(hand: HandFrame, chips: QualityChips, reasons: string[], turn: number | null, jitter: number | null, trigger: "auto" | "button"): void {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    const c = this.stillCanvas;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(this.video, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h);
    this.captureListener({
      pixels,
      width: w,
      height: h,
      landmarks: hand.landmarks.map((p) => ({ ...p })),
      world: hand.world ? hand.world.map((p) => ({ ...p })) : null,
      handedness: hand.handedness,
      handednessScore: hand.handednessScore,
      coin: snapshotCoin(this.lastCoin),
      chips,
      reasons,
      turn,
      sharpness: chips.sharpness.value,
      jitter,
      trigger,
      stream: this.streamInfo(),
      capturedAt: new Date().toISOString(),
    });
  }

  /** Try the browser's photo API for a full-resolution still (optional; many browsers do not have it). Never throws. */
  async takeHighRes(): Promise<{ blob: Blob; width: number; height: number; mime: string } | null> {
    const track = this.stream?.getVideoTracks()[0];
    const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
    if (!track || !IC) return null;
    try {
      const blob = await Promise.race([new IC(track).takePhoto(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("takePhoto timed out")), 4000))]);
      const bmp = await createImageBitmap(blob);
      const out = { blob, width: bmp.width, height: bmp.height, mime: blob.type || "image/jpeg" };
      bmp.close();
      return out;
    } catch {
      return null;
    }
  }
}
