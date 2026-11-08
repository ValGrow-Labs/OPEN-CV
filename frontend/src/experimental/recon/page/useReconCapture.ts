// State and live loop of the EXPERIMENTAL board-capture page: the served settings (GET /api/config, the page's only
// request), the rear camera, live marker analysis in a worker at a few frames per second, the coverage guide and the
// capture gate, captures (the exact analysed frame + MediaPipe's landmarks on it), the reconstruction in a second worker,
// and the local export. The camera, MediaPipe and the coin choice are the existing pieces, imported read-only.
// Validation mode (`?validation`): the board print check (ruler readings, sheet checklist) and the test-run details are
// required before the camera starts; the live flatness check warns while capturing; a device performance log (shown
// under `?debug`) goes into the export as device.json. Everything stays in memory: nothing is stored in the browser.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicConfig, ReferenceObject } from "../../../api/types";
import { fetchConfig } from "../../../api/client";
import { describeCameraError, openCamera, stopStream, type CameraErrorInfo } from "../../../camera/camera";
import { getHandTracker, type HandTracker } from "../../../vision/handTracker";
import { assumedIntrinsics } from "../../board/calibrate";
import { boardSvg } from "../../board/svg";
import { pixelsToPng } from "../../capture/render";
import { coinRecord, resolveCoin, selectableCoins, type CoinChoice } from "../../densescan/page/coin";
import { flatnessOfCameras, type BoardFlatness } from "../boardFlatness";
import type { ChainProgress, MarkerCornersOnly } from "../chain";
import { checklistMissing, EMPTY_CHECKLIST, parseMm, rulerCheck, type Checklist } from "./boardCheck";
import { DeviceLog, readEnv, type DeviceJson } from "./deviceLog";
import { LIVE_FLATNESS_MIN_VIEWS } from "./flatnessWorker";
import { EMPTY_RUN, runProblems, type RunDetails } from "./runDetails";
import { validity } from "./validity";
import { coinView } from "./format";
import { binShort, captureGate, guidance, missingRequired, missingWords, STEADY_FRAMES, type BinId, type Gate, type LiveAnalysis, type ThumbSide } from "./coverage";
import { buildExportZip } from "./exportZip";
import { poseChange, thumbSideOnBoard } from "./frameMetrics";
import type { LiveReply } from "./liveWorker";
import type { Capture, ReconOutcome } from "./types";
import { LiveAnalyser, runFlatnessWorker, runReconWorker } from "./workers";

export type Phase = "guide" | "starting" | "live" | "building" | "result";

/** Analyse at most this often (ms): a few frames per second is enough for guidance and keeps a phone cool. */
const MIN_ANALYSIS_INTERVAL_MS = 150;
const THUMB_WIDTH = 192;
export const VOXEL_MM = 1.5;

export interface DebugStats {
  analysedFps: number;
  cameraFps: number;
  detectMs: number | null;
  detectMedianMs: number | null;
  totalMs: number | null;
  poseRmsPx: number | null;
  inconsistent: number;
  rejectedLast: Record<string, number>;
  rejectedTotal: Record<string, number>;
  frames: number;
  heapMb: number | null;
}

export interface LiveView {
  analysis: LiveAnalysis;
  gate: Gate;
  guidance: string;
  markers: { id: number; corners: { x: number; y: number }[] }[];
  size: { width: number; height: number };
}

export function progressWords(p: ChainProgress | { stage: "coin" } | null): string {
  if (!p) return "Starting…";
  switch (p.stage) {
    case "detect":
      return `Finding the printed markers in photo ${(p as ChainProgress).done! + 1} of ${(p as ChainProgress).total}…`;
    case "calibrate":
      return "Measuring the camera (focal length and lens) from the markers in every photo…";
    case "pose":
      return "Placing each photo's camera on the board…";
    case "reconstruct":
      return "Carving the 3D hand from the outlines in every photo (the longest step, often 10 to 60 s on a phone)…";
    case "coin":
      return "Checking the print scale with the coin…";
  }
}

/** Used JS heap in MB (performance.memory: Chrome only, coarse), or null where the browser does not expose it. */
export function heapMb(): number | null {
  const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return m && Number.isFinite(m.usedJSHeapSize) ? Math.round((m.usedJSHeapSize / 1048576) * 10) / 10 : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function makeThumb(pixels: Uint8ClampedArray, w: number, h: number): ImageData | null {
  try {
    const src = document.createElement("canvas");
    src.width = w;
    src.height = h;
    src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
    const tw = THUMB_WIDTH, th = Math.max(1, Math.round((h / w) * THUMB_WIDTH));
    const c = document.createElement("canvas");
    c.width = tw;
    c.height = th;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(src, 0, 0, tw, th);
    return ctx.getImageData(0, 0, tw, th);
  } catch {
    return null;
  }
}

/** MediaPipe's 21 landmarks on one still, in pixels of that still (not mirrored). */
function landmarksOn(tracker: HandTracker, pixels: Uint8ClampedArray, w: number, h: number): { landmarks: { x: number; y: number }[] | null; handedness: "Left" | "Right" | null } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
  // HandTracker.detect reads a video element's size and draws it; a canvas draws the same way.
  Object.defineProperty(c, "videoWidth", { value: w });
  Object.defineProperty(c, "videoHeight", { value: h });
  const r = tracker.detect(c as unknown as HTMLVideoElement, performance.now());
  if (!r) return { landmarks: null, handedness: null };
  return { landmarks: r.landmarks.map((p) => ({ x: p.x, y: p.y })), handedness: r.handedness };
}

export function useReconCapture() {
  const params = useMemo(() => new URLSearchParams(typeof location !== "undefined" ? location.search : ""), []);
  const debug = params.has("debug");
  const validationMode = params.has("validation");
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [coinChoice, setCoinChoice] = useState<CoinChoice | null>(null);
  const [coinConfirmed, setCoinConfirmed] = useState(false);
  const [phase, setPhase] = useState<Phase>("guide");
  const [cameraError, setCameraError] = useState<CameraErrorInfo | null>(null);
  const [trackerNote, setTrackerNote] = useState<string | null>(null);
  const [live, setLive] = useState<LiveView | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [autoCapture, setAutoCapture] = useState(true);
  const [manualArmed, setManualArmed] = useState(false);
  const [debugStats, setDebugStats] = useState<DebugStats | null>(null);
  const [progress, setProgress] = useState<ChainProgress | { stage: "coin" } | null>(null);
  const [outcome, setOutcome] = useState<ReconOutcome | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildWallMs, setBuildWallMs] = useState<number | null>(null);
  const [buildHeap, setBuildHeap] = useState<{ before: number | null; after: number | null } | null>(null);
  const [includePhotos, setIncludePhotos] = useState(false);
  const [exportInfo, setExportInfo] = useState<{ bytes: number; files: number; photos: boolean } | null>(null);
  const [photosLost, setPhotosLost] = useState(false);
  // the board print check and the test-run details (validation mode; the ruler check is optional otherwise)
  const [rulerText, setRulerText] = useState({ squareX: "", squareY: "", longSpan: "", shortSpan: "" });
  const [checklist, setChecklist] = useState<Checklist>(EMPTY_CHECKLIST);
  const [run, setRun] = useState<RunDetails>(EMPTY_RUN);
  const [liveFlatness, setLiveFlatness] = useState<BoardFlatness | null>(null);
  const [deviceSnapshot, setDeviceSnapshot] = useState<DeviceJson | null>(null);
  const deviceRef = useRef<DeviceLog | null>(null);
  if (!deviceRef.current) deviceRef.current = new DeviceLog();
  const device = deviceRef.current;
  const flatJobRef = useRef<{ cancel: () => void; key: string } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<LiveAnalyser | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const runningRef = useRef(false);
  const grabRef = useRef<HTMLCanvasElement | null>(null);
  const lastSentRef = useRef(0);
  const historyRef = useRef<{ t: number; pose: LiveReply["pose"] }[]>([]);
  const capturesRef = useRef<Capture[]>([]);
  const filledRef = useRef<Set<BinId>>(new Set());
  const capturingRef = useRef(false);
  const autoRef = useRef(true);
  const manualRef = useRef(false);
  const thumbSideRef = useRef<ThumbSide>(null);
  const seqRef = useRef(1);
  const statsRef = useRef({ analysed: [] as number[], camera: [] as number[], detect: [] as number[], rejectedTotal: {} as Record<string, number>, frames: 0 });
  const cancelRef = useRef<(() => void) | null>(null);
  const topPoseRef = useRef(new Map<string, { R: number[]; t: number[] }>());

  capturesRef.current = captures;
  autoRef.current = autoCapture;
  manualRef.current = manualArmed;

  const filled = useMemo(() => new Set(captures.map((c) => c.bin)), [captures]);
  filledRef.current = filled;
  // Which board edge the thumb points to, from the top view's landmarks and its live pose (names the sides in words).
  const thumbSide = useMemo<ThumbSide>(() => {
    const top = captures.find((c) => c.bin === "top" && c.landmarks);
    const pose = top ? topPoseRef.current.get(top.id) : undefined;
    if (!top || !pose) return null;
    return thumbSideOnBoard(assumedIntrinsics(top.width, top.height).intrinsics, pose, top.landmarks);
  }, [captures]);
  thumbSideRef.current = thumbSide;

  // ---------------------------------------------------------------------------------------------- config (the only request)
  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        setCoinChoice(resolveCoin(c, params.get("coin")));
      })
      .catch((e) => alive && setConfigError(String(e instanceof Error ? e.message : e)));
    return () => {
      alive = false;
    };
  }, [params]);

  const coin: ReferenceObject | null = useMemo(() => (config && coinChoice ? (selectableCoins(config).find((o) => o.id === coinChoice.id) ?? null) : null), [config, coinChoice]);

  // ---------------------------------------------------------------------------------------------- device log (in memory)
  useEffect(() => {
    const detach = device.attach(window);
    device.startHeap();
    if (debug) {
      device.onChange = () => setDeviceSnapshot(device.toJson(readEnv(), null));
      setDeviceSnapshot(device.toJson(readEnv(), null));
    }
    return () => {
      device.onChange = null;
      detach();
    };
  }, [debug, device]);

  // ---------------------------------------------------------------------------------------------- board print check
  const ruler = useMemo(
    () => rulerCheck({ squareXmm: parseMm(rulerText.squareX), squareYmm: parseMm(rulerText.squareY), longSpanMm: parseMm(rulerText.longSpan), shortSpanMm: parseMm(rulerText.shortSpan) }),
    [rulerText],
  );
  const rulerEntered = Object.values(rulerText).some((t) => t.trim() !== "");
  const checklistLeft = useMemo(() => checklistMissing(checklist, run.conditions), [checklist, run.conditions]);
  const runLeft = useMemo(() => runProblems(run), [run]);
  /** What still blocks "Start camera" in validation mode, in words (empty = ready; always empty otherwise). */
  const startBlockers = useMemo(() => {
    if (!validationMode) return [] as string[];
    const out: string[] = [];
    if (ruler.verdict === "not_entered") out.push("Enter the four ruler readings of the printed board.");
    else if (ruler.verdict === "reprint") out.push("The ruler check failed: reprint the board at 100 % / actual size and measure again.");
    if (checklistLeft.length) out.push("Tick every line of the sheet checklist (or tag the condition you are testing on purpose).");
    if (runLeft.length) out.push(`Complete the test-run details (${runLeft.length} item${runLeft.length === 1 ? "" : "s"} listed under them).`);
    return out;
  }, [validationMode, ruler.verdict, checklistLeft, runLeft]);

  // ---------------------------------------------------------------------------------------------- camera and the live loop
  const stopCamera = useCallback(() => {
    runningRef.current = false;
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(
    () => () => {
      stopCamera();
      analyserRef.current?.dispose();
      cancelRef.current?.();
    },
    [stopCamera],
  );

  const drawOverlay = useCallback((reply: LiveReply) => {
    const c = overlayRef.current;
    if (!c) return;
    if (c.width !== reply.width || c.height !== reply.height) {
      c.width = reply.width;
      c.height = reply.height;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const lw = Math.max(2, reply.width / 400);
    ctx.lineWidth = lw;
    ctx.font = `${Math.round(reply.width / 60)}px system-ui, sans-serif`;
    for (const m of reply.markers) {
      ctx.strokeStyle = "#1f5eea";
      ctx.fillStyle = "rgba(31, 94, 234, 0.18)";
      ctx.beginPath();
      m.corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const cx = m.corners.reduce((s, p) => s + p.x, 0) / 4, cy = m.corners.reduce((s, p) => s + p.y, 0) / 4;
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#0b1f4a";
      ctx.lineWidth = lw * 1.5;
      ctx.strokeText(String(m.id), cx - lw * 3, cy + lw * 3);
      ctx.fillText(String(m.id), cx - lw * 3, cy + lw * 3);
      ctx.lineWidth = lw;
    }
  }, []);

  const doCapture = useCallback(
    async (reply: LiveReply, analysis: LiveAnalysis, bin: BinId, trigger: "auto" | "button") => {
      capturingRef.current = true;
      filledRef.current = new Set([...filledRef.current, bin]); // no second capture of this bin meanwhile
      try {
        const pixels = new Uint8ClampedArray(reply.buffer);
        let landmarks: { x: number; y: number }[] | null = null;
        let handedness: "Left" | "Right" | null = null;
        if (trackerRef.current) {
          try {
            ({ landmarks, handedness } = landmarksOn(trackerRef.current, pixels, reply.width, reply.height));
          } catch (err) {
            console.warn("[recon] MediaPipe failed on a capture", err);
          }
        }
        const id = `v${String(seqRef.current++).padStart(2, "0")}-${bin}`;
        if (bin === "top" && reply.pose) topPoseRef.current.set(id, { R: [...reply.pose.pose.R], t: [...reply.pose.pose.t] });
        const cap: Capture = {
          id,
          bin,
          width: reply.width,
          height: reply.height,
          pixels,
          landmarks,
          handedness,
          markerCorners: reply.markers.map((m) => ({ id: m.id, corners: m.corners.map((c) => ({ x: c.x, y: c.y })) })),
          markers: analysis.markers,
          elevationDeg: analysis.elevationDeg ?? NaN,
          azimuthDeg: analysis.azimuthDeg ?? NaN,
          sharpness: analysis.sharpness,
          trigger,
          capturedAt: new Date().toISOString(),
          thumb: makeThumb(pixels, reply.width, reply.height),
        };
        console.info(`[recon] ${trigger} capture ${id}: ${analysis.markers} markers, elevation ${analysis.elevationDeg?.toFixed(1)}, azimuth ${analysis.azimuthDeg?.toFixed(1)}, landmarks ${landmarks ? landmarks.length : "none"}`);
        setCaptures((cs) => [...cs, cap]);
        if (trigger === "button") setManualArmed(false);
      } finally {
        capturingRef.current = false;
      }
    },
    [],
  );

  const onReply = useCallback(
    (reply: LiveReply) => {
      const st = statsRef.current;
      const now = performance.now();
      st.analysed.push(now);
      while (st.analysed.length > 20) st.analysed.shift();
      st.detect.push(reply.timingsMs.detect);
      while (st.detect.length > 30) st.detect.shift();
      st.frames++;
      for (const [k, v] of Object.entries(reply.rejectedCounts)) st.rejectedTotal[k] = (st.rejectedTotal[k] ?? 0) + v;
      if (reply.error) {
        console.warn("[recon] live analysis failed:", reply.error);
        deviceRef.current?.workerFailed("live analysis", reply.error);
      }

      // all captures must share one size: a change (rotation, another camera) restarts the capture
      const first = capturesRef.current[0];
      if (first && (first.width !== reply.width || first.height !== reply.height)) {
        setCaptures([]);
        topPoseRef.current.clear();
        filledRef.current = new Set();
        setNotice(
          `The camera picture changed size (from ${first.width} × ${first.height} to ${reply.width} × ${reply.height}: the phone was turned, or the camera switched). Every view must have the same size and zoom, so the earlier views were removed: please start again and keep the phone the same way round.`,
        );
      }

      const h = historyRef.current;
      h.push({ t: now, pose: reply.pose });
      while (h.length > STEADY_FRAMES) h.shift();
      let steady: LiveAnalysis["steady"] = null;
      if (h.length === STEADY_FRAMES && h.every((x) => x.pose) && now - h[0].t < 2500) {
        let rot = 0, move = 0;
        for (let i = 1; i < h.length; i++) {
          const d = poseChange(h[i - 1].pose!.pose, h[i].pose!.pose);
          rot = Math.max(rot, d.rotDeg);
          move = Math.max(move, d.moveMm);
        }
        steady = { rotDeg: rot, moveMm: move };
      }
      const analysis: LiveAnalysis = {
        markers: reply.markers.length,
        elevationDeg: reply.pose ? reply.pose.elevationDeg : null,
        azimuthDeg: reply.pose ? reply.pose.azimuthDeg : null,
        sharpness: reply.sharpness,
        steady,
      };
      const filledNow = filledRef.current;
      const gate = captureGate(analysis, filledNow, thumbSideRef.current);
      setLive({ analysis, gate, guidance: guidance(analysis, filledNow, thumbSideRef.current), markers: reply.markers, size: { width: reply.width, height: reply.height } });
      drawOverlay(reply);
      if (debug) {
        const fps = (ts: number[]) => (ts.length < 2 ? 0 : (1000 * (ts.length - 1)) / (ts[ts.length - 1] - ts[0]));
        setDebugStats({
          analysedFps: fps(st.analysed),
          cameraFps: fps(st.camera),
          detectMs: reply.timingsMs.detect,
          detectMedianMs: median(st.detect),
          totalMs: reply.timingsMs.total,
          poseRmsPx: reply.pose?.rmsPx ?? null,
          inconsistent: reply.inconsistent,
          rejectedLast: reply.rejectedCounts,
          rejectedTotal: { ...st.rejectedTotal },
          frames: st.frames,
          heapMb: heapMb(),
        });
      }
      const want = (autoRef.current || manualRef.current) && gate.ok && gate.bin && !capturingRef.current;
      if (want) void doCapture(reply, analysis, gate.bin!, manualRef.current ? "button" : "auto");
    },
    [debug, doCapture, drawOverlay],
  );

  const loop = useCallback(() => {
    const video = videoRef.current as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }) | null;
    if (!runningRef.current || !video) return;
    const next = () => {
      if (!runningRef.current) return;
      if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    const tick = () => {
      if (!runningRef.current) return;
      const now = performance.now();
      const st = statsRef.current;
      st.camera.push(now);
      while (st.camera.length > 30) st.camera.shift();
      const an = analyserRef.current;
      const w = video.videoWidth, h = video.videoHeight;
      if (an && !an.busy && w && h && now - lastSentRef.current >= MIN_ANALYSIS_INTERVAL_MS) {
        lastSentRef.current = now;
        const c = grabRef.current ?? (grabRef.current = document.createElement("canvas"));
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          an.analyse(w, h, img.data.buffer as ArrayBuffer)
            .then((r) => runningRef.current && onReply(r))
            .catch((err) => {
              if (String(err?.message) !== "disposed") {
                console.warn("[recon] live analysis:", err);
                deviceRef.current?.workerFailed("live analysis", err);
              }
            });
        }
      }
      next();
    };
    next();
  }, [onReply]);

  const startCamera = useCallback(async () => {
    if (startBlockers.length) return;
    setCameraError(null);
    setNotice(null);
    setPhase("starting");
    let stream: MediaStream;
    try {
      // the rear camera; openCamera asks for 1280 x 720 on a phone
      stream = await openCamera("environment");
    } catch (err) {
      setCameraError(describeCameraError(err));
      setPhase("guide");
      return;
    }
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      stopStream(stream);
      setPhase("guide");
      return;
    }
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    try {
      await video.play();
    } catch (err) {
      stopStream(stream);
      setCameraError(describeCameraError(err));
      setPhase("guide");
      return;
    }
    device.cameraStarted(stream.getVideoTracks?.()[0] ?? null, video.videoWidth && video.videoHeight ? { width: video.videoWidth, height: video.videoHeight } : null);
    if (!analyserRef.current) analyserRef.current = new LiveAnalyser();
    if (!trackerRef.current)
      getHandTracker()
        .then((t) => {
          trackerRef.current = t;
          setTrackerNote(null);
        })
        .catch((err) => setTrackerNote(`MediaPipe hand tracking did not load (${String(err?.message ?? err)}): views are captured without landmarks, so no hand frame and no measurements.`));
    historyRef.current = [];
    runningRef.current = true;
    setPhase("live");
    loop();
  }, [loop, startBlockers, device]);

  const takeView = useCallback(() => setManualArmed(true), []);

  const removeCapture = useCallback((id: string) => {
    topPoseRef.current.delete(id);
    setCaptures((cs) => cs.filter((c) => c.id !== id));
  }, []);

  // ---------------------------------------------------------------------------------------------- reconstruction
  const missing = useMemo(() => missingRequired(filled), [filled]);
  const missingText = useMemo(() => missingWords(filled), [filled]);

  // ---------------------------------------------------------------------------------------------- live flatness warning
  // After each capture (from the third on), the views' markers are self-calibrated and posed in a worker, exactly as the
  // chain will do it, and the per-marker residuals judged (boardFlatness.ts). One check in flight; a newer set of views
  // replaces an older check.
  useEffect(() => {
    if (phase !== "live" && phase !== "starting") return;
    const cs = captures.filter((c) => c.markerCorners.length > 0);
    if (cs.length < LIVE_FLATNESS_MIN_VIEWS) {
      setLiveFlatness(null);
      return;
    }
    const key = cs.map((c) => c.id).join(",");
    if (flatJobRef.current?.key === key) return;
    flatJobRef.current?.cancel();
    const job = runFlatnessWorker({ width: cs[0].width, height: cs[0].height, views: cs.map((c) => ({ id: c.id, markers: c.markerCorners as unknown as MarkerCornersOnly[] })) });
    flatJobRef.current = { cancel: job.cancel, key };
    void job.promise.then((r) => {
      if (flatJobRef.current?.key !== key) return;
      flatJobRef.current = null;
      if (r.type === "done") setLiveFlatness(r.flatness);
      else if (r.message !== "cancelled") deviceRef.current?.workerFailed("flatness", r.message);
    });
  }, [captures, phase]);
  useEffect(() => () => flatJobRef.current?.cancel(), []);

  const build = useCallback(async () => {
    const cs = capturesRef.current;
    if (missingRequired(new Set(cs.map((c) => c.bin))).length) return;
    device.buildPressed();
    flatJobRef.current?.cancel();
    flatJobRef.current = null;
    stopCamera();
    setPhase("building");
    setProgress(null);
    setOutcome(null);
    setBuildError(null);
    setExportInfo(null);
    const heapBefore = heapMb();
    const t0 = performance.now();
    const top = cs.find((c) => c.bin === "top") ?? null;
    const job = runReconWorker(
      {
        views: cs.map((c) => ({ id: c.id, width: c.width, height: c.height, buffer: c.pixels.buffer as ArrayBuffer, landmarks: c.landmarks })),
        topViewId: top?.id ?? null,
        coin: coin ? { referenceDiameterMm: coin.diameter_mm, thicknessMm: coin.thickness_mm } : null,
        voxelMm: VOXEL_MM,
      },
      setProgress,
    );
    cancelRef.current = job.cancel;
    const r = await job.promise;
    cancelRef.current = null;
    const wall = performance.now() - t0;
    setBuildWallMs(wall);
    device.buildFinished(wall);
    setBuildHeap({ before: heapBefore, after: heapMb() });
    // the pictures come back from the worker (they were transferred, not copied)
    if (r.buffers.length === cs.length) setCaptures(cs.map((c, i) => ({ ...c, pixels: new Uint8ClampedArray(r.buffers[i]) })));
    else setPhotosLost(true);
    if (r.type === "done") setOutcome(r.outcome);
    else {
      setBuildError(r.message);
      if (r.message !== "cancelled") device.workerFailed("reconstruction", r.message);
    }
    setPhase("result");
  }, [coin, stopCamera, device]);

  const backToCapture = useCallback(() => {
    setOutcome(null);
    setBuildError(null);
    setExportInfo(null);
    if (photosLost) {
      setCaptures([]);
      setPhotosLost(false);
    }
    void startCamera();
  }, [photosLost, startCamera]);

  const startOver = useCallback(() => {
    device.resetCapture();
    setLiveFlatness(null);
    setCaptures([]);
    topPoseRef.current.clear();
    setOutcome(null);
    setBuildError(null);
    setExportInfo(null);
    setPhotosLost(false);
    void startCamera();
  }, [startCamera, device]);

  // ---------------------------------------------------------------------------------------------- flatness and validity
  const flatness = useMemo<BoardFlatness | null>(() => (outcome ? flatnessOfCameras(outcome.chain.cameras) : null), [outcome]);
  const valid = useMemo(
    () =>
      outcome
        ? validity({
            validationMode,
            run: validationMode ? run : null,
            ruler: rulerEntered || validationMode ? ruler : null,
            checklist,
            flatness,
            coin: coinView(outcome.coin, coin?.label ?? "coin"),
            refused: !!outcome.chain.refused,
            hasMeasurements: !!outcome.chain.reconstruction?.measurements,
          })
        : null,
    [outcome, validationMode, run, ruler, rulerEntered, checklist, flatness, coin],
  );

  // ---------------------------------------------------------------------------------------------- export, board download
  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const downloadBoard = useCallback(() => downloadBlob(new Blob([boardSvg()], { type: "image/svg+xml" }), "glovesize-board-A4-print-at-100-percent.svg"), []);

  const exportZip = useCallback(async () => {
    if (!outcome) return;
    const cs = capturesRef.current;
    const photos = includePhotos && !photosLost;
    const t0 = performance.now();
    let bytes: Uint8Array;
    try {
      bytes = await buildExportZip({
      outcome,
      captures: cs,
      includePhotos: photos,
      coin: coin ? coinRecord(coin, coinConfirmed) : null,
      coinLabel: coin?.label ?? "coin",
      createdAt: new Date().toISOString(),
      environment: { userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null, heapMb: heapMb(), page: "experiment/recon" },
      encodePhoto: async (c) => new Uint8Array(await (await pixelsToPng(new ImageData(new Uint8ClampedArray(c.pixels), c.width, c.height))).arrayBuffer()),
      validationMode,
      run: validationMode ? run : null,
      ruler: rulerEntered || validationMode ? ruler : null,
      checklist,
      flatness,
      // export_ms: the time to prepare every other file of the export (device.json is written last, then zipped)
      device: (prepareMs) => device.toJson(readEnv(), new Date().toISOString(), { export_ms: Math.round(prepareMs), export_ok: true }),
      });
    } catch (err) {
      device.exportFinished(performance.now() - t0, false);
      device.error(`export failed: ${String(err instanceof Error ? err.message : err)}`);
      setExportInfo(null);
      return;
    }
    device.exportFinished(performance.now() - t0, true);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" }), `recon-experimental-${stamp}.zip`);
    setExportInfo({ bytes: bytes.length, files: photos ? cs.length + 5 : 5, photos });
    // the next capture of this session gets the next index (in memory only)
    if (validationMode) setRun((r) => ({ ...r, captureIndex: r.captureIndex + 1 }));
  }, [coin, coinConfirmed, includePhotos, outcome, photosLost, validationMode, run, ruler, rulerEntered, checklist, flatness, device]);

  return {
    debug,
    validationMode,
    rulerText,
    setRulerText,
    ruler,
    rulerEntered,
    checklist,
    setChecklist,
    checklistLeft,
    run,
    setRun,
    runLeft,
    startBlockers,
    liveFlatness,
    flatness,
    valid,
    deviceSnapshot,
    config,
    configError,
    coin,
    coinChoice,
    coinConfirmed,
    setCoinConfirmed,
    phase,
    cameraError,
    trackerNote,
    live,
    captures,
    filled,
    thumbSide,
    missing,
    missingText,
    notice,
    autoCapture,
    setAutoCapture,
    manualArmed,
    takeView,
    removeCapture,
    debugStats,
    progress,
    progressText: progressWords(progress),
    outcome,
    buildError,
    buildWallMs,
    buildHeap,
    includePhotos,
    setIncludePhotos,
    exportInfo,
    photosLost,
    videoRef,
    overlayRef,
    startCamera,
    stopCamera,
    build,
    backToCapture,
    startOver,
    downloadBoard,
    exportZip,
    binText: (c: Capture) => binShort(c.bin),
  };
}
