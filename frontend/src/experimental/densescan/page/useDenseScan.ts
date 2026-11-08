// State and actions of the EXPERIMENTAL dense-scan page. The camera, hand tracker, coin engine, quality checks and the
// GrabCut segmentation are the existing ones (read-only imports from src/camera, src/vision and experimental/capture);
// the dots, their checks, regions, depth labels, point cloud, mesh, measurements and export are the densescan core.
// This file only wires them together and animates. Every number it publishes comes from the real arrays.
//
// Nothing is uploaded: the only request is GET /api/config. The export is a download on this device. Nothing is stored
// in the browser (no localStorage, sessionStorage, IndexedDB, Cache Storage or service worker).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicConfig, ReferenceObject } from "../../../api/types";
import { fetchConfig } from "../../../api/client";
import { isMobileDevice, type Facing } from "../../../camera/camera";
import type { BinaryMask, ImageScale, Mesh, Pt, Quantity } from "../../common";
import { buildScale, summariseSegmentation } from "../../capture/analysis";
import { LiveCapture, type CapturedFrame, type LiveStatus, type OverlayFrame } from "../../capture/live";
import { AUTO_CAPTURE_FRAMES } from "../../capture/metrics";
import { pixelsToPng } from "../../capture/render";
import { SegmentClient } from "../../capture/segmentClient";
import type { ScaleSummary, SegmentationSummary } from "../../capture/types";
import { viewDef } from "../../capture/views";
import { makeZip, type ZipEntry } from "../../capture/zip";
import type { SegmentationResult } from "../../segmentation/segmentHand";
import {
  exportPointSet,
  initialScanState,
  scanReducer,
  type PointSet,
  type ScanContext,
  type ScanEvent,
  type ScanPhase,
  type ScanState,
} from "../core";
import { clearCanvas, DotLayer, drawLineLayer, drawLiveLandmarks, drawStill, type DotDisplay, type View } from "./drawScan";
import { containScale, gapProbes, maskRowsSource, meshToViewerSpace, pointsOutsideMask, revealedCounts, toViewerSpace, type GapProbe, type Revealed } from "./helpers";
import { coinRecord, resolveCoin, selectableCoins, type CoinChoice } from "./coin";
import { DenseClient } from "./denseClient";
import { GROUP_TITLES, liveGate, segmentationGroup, type GateInput, type GateResult } from "./gate";
import { heapMb, LongTaskLog, sampleFrames } from "./perfProbe";
import { summarise, type StageTimings } from "./staged";

export interface DenseSettings {
  spacingPx: number;
  /** Optional target step in mm (needs the coin). Empty = use spacingPx. */
  targetMm: number | null;
  jitter: number;
  edgeMarginPx: number;
  sweepMs: number;
  seed: number;
}

export const DEFAULT_SETTINGS: DenseSettings = { spacingPx: 4, targetMm: null, jitter: 0, edgeMarginPx: 2, sweepMs: 1800, seed: 1 };

/** Working size (long side, px) of the GrabCut segmentation. */
const WORKING_SIZE = 512;
/** How long the rejected dots stay visible after the line has passed the hand, before only the accepted ones remain. */
const SHOW_REJECTED_MS = 450;
/** React is told about the scan at most this often during the sweep (the canvases are drawn every animation frame). */
const PUBLISH_MS = 100;

export interface Processed {
  cloud: { positions: Float32Array; zUnit: "mm" | "relative" | null; count: number };
  viewerPoints: Float32Array;
  mesh: { viewer: Mesh | null; completeness: number; components: number; triangles: number; note: string; measured: boolean };
  measurements: Record<string, Quantity>;
  regions: Record<string, number>;
}

type LongTaskSummary = { count: number; totalMs: number; maxMs: number };
type FrameSummary = ReturnType<typeof summarise>;

export interface Perf {
  segmentationMs: number | null;
  segmentationWhere: "worker" | "page" | null;
  segmentationStages: Record<string, number> | null;
  stages: StageTimings | null;
  /** Where the dots and the processing ran ("worker": the page kept drawing) and their wall time including the transfer. */
  pointsWhere: "worker" | "page" | null;
  pointsWallMs: number | null;
  processing: { cloudMs: number; meshMs: number; measureMs: number } | null;
  processWhere: "worker" | "page" | null;
  processWallMs: number | null;
  render: FrameSummary;
  frameInterval: FrameSummary;
  longFrames: number;
  points: number;
  /** Main-thread long tasks (>= 50 ms) per part of the scan; null where the browser does not report them. */
  longTasks: { supported: boolean; segmentation: LongTaskSummary; points: LongTaskSummary; sweep: LongTaskSummary; processing: LongTaskSummary } | null;
  /** Animation-frame intervals while the live camera runs (tracking) and after the scan (idle). */
  idleLive: FrameSummary | null;
  idleAfter: FrameSummary | null;
  /** The live loop's camera-processing rate when the frame was taken. */
  cameraFps: number | null;
  /** JS heap (performance.memory, Chrome only) in MB, or null where unavailable. */
  memory: { source: string; atCaptureMb: number | null; afterPointsMb: number | null; afterProcessingMb: number | null } | null;
}

const EMPTY_PERF: Perf = {
  segmentationMs: null,
  segmentationWhere: null,
  segmentationStages: null,
  stages: null,
  pointsWhere: null,
  pointsWallMs: null,
  processing: null,
  processWhere: null,
  processWallMs: null,
  render: summarise([]),
  frameInterval: summarise([]),
  longFrames: 0,
  points: 0,
  longTasks: null,
  idleLive: null,
  idleAfter: null,
  cameraFps: null,
  memory: null,
};

export interface FrozenFrame {
  frame: CapturedFrame;
  seg: SegmentationResult | null;
  segSummary: SegmentationSummary | null;
  scale: ScaleSummary | null;
  imageScale: ImageScale | null;
  /** The coin selected when the frame was taken (the served config entry) and whether its size was confirmed. */
  coin: ReferenceObject;
  sizeConfirmed: boolean;
  /** The hand length (mm) the coin's scale implied on that frame (production liveHandLengthMm). */
  impliedHandMm: number | null;
}

/** The latest processed camera frame: the hand's landmarks and the coin engine's result, in frame pixels. */
export type LiveFrame = OverlayFrame;

/** Can this page use the camera at all? (A phone on http://<PC address> is not a secure context: no camera.) */
export interface CameraReadiness {
  secure: boolean;
  hasCamera: boolean;
  permission: PermissionState | "unknown";
}

declare global {
  interface Window {
    __DENSE_SCAN__?: Record<string, unknown>;
  }
}

const words = (e: unknown) => String(e instanceof Error ? e.message : e);

export function useDenseScan() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const stillRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<HTMLCanvasElement>(null);
  const lineRef = useRef<HTMLCanvasElement>(null);

  const captureRef = useRef<LiveCapture | null>(null);
  const segRef = useRef<SegmentClient | null>(null);
  const denseRef = useRef<DenseClient | null>(null);
  const layerRef = useRef<DotLayer | null>(null);
  const outlineRef = useRef<{ contour: readonly Pt[] | null; xRange: [number, number] } | null>(null);
  const longRef = useRef<LongTaskLog | null>(null);
  const marksRef = useRef<Record<string, number>>({});

  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [refId, setRefIdState] = useState("");
  const [coinNote, setCoinNote] = useState<string | null>(null);
  const [coinVia, setCoinVia] = useState<CoinChoice["via"] | null>(null);
  /** The size confirmation for a coin with size_check (memory only; reset when the coin changes). */
  const [sizeConfirmed, setSizeConfirmedState] = useState(false);
  const [live, setLive] = useState<LiveStatus | null>(null);
  /** The latest processed camera frame's hand and coin (from the live loop's overlay), copied to React with the status. */
  const [liveFrame, setLiveFrame] = useState<LiveFrame | null>(null);
  /** Why the last captured frame was not used (it failed a prerequisite on that frame). */
  const [discarded, setDiscarded] = useState<string | null>(null);
  const [autoStart, setAutoStartState] = useState(true);
  const [facing, setFacingState] = useState<Facing>(() => (isMobileDevice() ? "environment" : "user"));
  const [settings, setSettings] = useState<DenseSettings>(DEFAULT_SETTINGS);
  const [readiness, setReadiness] = useState<CameraReadiness>(() => ({
    secure: typeof window === "undefined" ? true : window.isSecureContext !== false,
    hasCamera: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
    permission: "unknown",
  }));

  const [scan, setScan] = useState<ScanState>(initialScanState);
  const [counts, setCounts] = useState<Revealed>({ generated: 0, accepted: 0, rejected: 0 });
  const [frozen, setFrozen] = useState<FrozenFrame | null>(null);
  const [pointSet, setPointSet] = useState<PointSet | null>(null);
  const [processed, setProcessed] = useState<Processed | null>(null);
  const [perf, setPerf] = useState<Perf>(EMPTY_PERF);
  const [display, setDisplay] = useState<DotDisplay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportInfo, setExportInfo] = useState<{ filename: string; names: string[]; bytes: number } | null>(null);

  // The scan state lives in a ref (the animation reads and writes it every frame); React gets a throttled copy.
  const stateRef = useRef<ScanState>(initialScanState());
  const ctxRef = useRef<ScanContext>({ points: null, frameHeight: 0, sweepMs: DEFAULT_SETTINGS.sweepMs });
  const phasesRef = useRef<ScanPhase[]>(["waiting_hand"]);
  const lastPublish = useRef(0);
  const rafRef = useRef<number | null>(null);
  const runRef = useRef(0); // the scan generation: a reset makes every pending step of an older scan a no-op
  const perfRef = useRef<Perf>(EMPTY_PERF);
  const frozenRef = useRef<FrozenFrame | null>(null);
  const setRef = useRef<PointSet | null>(null);
  const liveStatusRef = useRef<LiveStatus | null>(null);
  const idleLiveSampled = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const configRef = useRef(config);
  configRef.current = config;
  const refIdRef = useRef(refId);
  refIdRef.current = refId;
  const sizeRef = useRef(sizeConfirmed);
  sizeRef.current = sizeConfirmed;
  const autoRef = useRef(autoStart);
  autoRef.current = autoStart;
  const liveFrameRef = useRef<LiveFrame | null>(null);
  /** Consecutive live frames on which the page's own prerequisites (beyond the live loop's checks) pass. */
  const extraRunRef = useRef(0);
  /** A capture has been asked for and not yet received. */
  const pendingCaptureRef = useRef(false);
  const facingRef = useRef(facing);
  facingRef.current = facing;

  const palm = useMemo(() => viewDef("palm"), []);

  const updatePerf = useCallback((patch: Partial<Perf>) => {
    perfRef.current = { ...perfRef.current, ...patch };
    setPerf(perfRef.current);
  }, []);

  const publish = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastPublish.current < PUBLISH_MS) return;
    lastPublish.current = now;
    const s = stateRef.current;
    setScan(s);
    const pts = ctxRef.current.points;
    const sweeping = s.phase === "segmenting" || s.phase === "sweeping";
    setCounts(revealedCounts(pts, sweeping ? s.sweepY : Infinity));
  }, []);

  const dispatch = useCallback(
    (e: ScanEvent) => {
      const before = stateRef.current.phase;
      stateRef.current = scanReducer(stateRef.current, e, ctxRef.current);
      const after = stateRef.current.phase;
      if (after !== before) {
        phasesRef.current.push(after);
        marksRef.current[after] = performance.now();
        publish(true);
      } else publish(false);
    },
    [publish],
  );

  // GET /api/config: the page's only API request. The long-task log and the camera permission state, once.
  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        const choice = resolveCoin(c, new URLSearchParams(location.search).get("coin"));
        setRefIdState(choice.id);
        setCoinVia(choice.via);
        setCoinNote(choice.note);
      })
      .catch((e) => alive && setConfigError(words(e)));
    longRef.current = new LongTaskLog();
    const perms = navigator.permissions;
    if (perms?.query) {
      perms
        .query({ name: "camera" as PermissionName })
        .then((st) => {
          if (!alive) return;
          setReadiness((r) => ({ ...r, permission: st.state }));
          st.onchange = () => setReadiness((r) => ({ ...r, permission: st.state }));
        })
        .catch(() => undefined); // some browsers do not know the "camera" permission name
    }
    return () => {
      alive = false;
      longRef.current?.dispose();
    };
  }, []);

  /** The selected coin: the served config's entry for that id, the only source of its label and diameter. */
  const reference: ReferenceObject | null = useMemo(() => (config ? (selectableCoins(config).find((o) => o.id === refId) ?? null) : null), [config, refId]);
  const referenceRef = useRef(reference);
  referenceRef.current = reference;

  const setRefId = useCallback((id: string) => {
    setRefIdState(id);
    setSizeConfirmedState(false); // a confirmation is for one coin
    setCoinNote(null);
  }, []);
  const setSizeConfirmed = useCallback((on: boolean) => setSizeConfirmedState(on), []);

  // The live loop never starts a capture by itself: the page decides (all prerequisites, see gate.ts) and asks for it.
  const arm = useCallback(() => captureRef.current?.armView(palm, () => null, false), [palm]);

  /** The prerequisites of the segmentation on a given frame (hand, coin, calibration). */
  const gateFor = useCallback(
    (f: LiveFrame | null, chips: LiveStatus["chips"], camera: GateInput["camera"]): GateResult | null => {
      const cfg = configRef.current;
      if (!cfg) return null;
      return liveGate({
        camera,
        landmarks: f?.landmarks ?? null,
        frameW: f?.width ?? 0,
        frameH: f?.height ?? 0,
        chips,
        coin: f?.coin ?? null,
        ref: referenceRef.current,
        sizeConfirmed: sizeRef.current,
        capture: cfg.capture,
        plausibleHandMm: cfg.hand_length_plausible_mm,
        assumedHfovDeg: cfg.assumed_hfov_deg,
      });
    },
    [],
  );

  // ---- how the frame is shown ----------------------------------------------------------------------------------

  const currentView = useCallback((): View => {
    const fz = frozenRef.current;
    const box = stageRef.current?.getBoundingClientRect();
    const scale = fz && box ? containScale(fz.frame.width, fz.frame.height, box.width, box.height) : 1;
    return { scale, dpr: Math.min(3, window.devicePixelRatio || 1) };
  }, []);

  const drawOutline = useCallback(
    (line: { y: number; x0: number; x1: number } | null) => {
      const fz = frozenRef.current;
      const o = outlineRef.current;
      if (!fz || !o || !lineRef.current) return;
      drawLineLayer(lineRef.current, fz.frame.width, fz.frame.height, o.contour, line, currentView());
    },
    [currentView],
  );

  // A rotation or resize lays the dot and outline layers out again (the arrays are untouched).
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const layer = layerRef.current;
      if (layer) setDisplay({ ...layer.setView(currentView()) });
      if (stateRef.current.phase !== "sweeping") drawOutline(null);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [currentView, drawOutline]);

  // ---- the scan, step by step -------------------------------------------------------------------------------------

  const stopAnimation = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  const finishPerf = useCallback(
    async (run: number) => {
      const m = marksRef.current;
      await new Promise((r) => setTimeout(r, 120)); // long-task entries arrive just after the task
      if (run !== runRef.current) return;
      const log = longRef.current;
      const end = performance.now();
      const longTasks = log
        ? {
            supported: log.supported,
            segmentation: log.between(m.segmenting ?? end, m.segmented ?? end),
            points: log.between(m.segmented ?? end, m.sweeping ?? end),
            sweep: log.between(m.sweeping ?? end, m.captured ?? end),
            processing: log.between(m.processing ?? end, m.done ?? end),
          }
        : null;
      updatePerf({ longTasks });
      const idleAfter = await sampleFrames(1000);
      if (run !== runRef.current) return;
      updatePerf({ idleAfter });
    },
    [updatePerf],
  );

  const process = useCallback(
    async (run: number) => {
      const set = setRef.current;
      const fz = frozenRef.current;
      if (!set || !fz || run !== runRef.current) return;
      dispatch({ type: "process_start" });
      const dense = (denseRef.current ??= new DenseClient());
      const out = await dense.process(set, fz.frame.landmarks, fz.imageScale);
      if (run !== runRef.current) return;
      const { cloud, mesh, measurements, timings } = out.result;
      const mm = set.mmPerPx;
      // Viewer space: x and y in mm when the coin gives a scale (else px); relative z scaled like x (MediaPipe's z is
      // roughly in x's units), so the shape is not distorted. Labelled "estimated", never "measured".
      const k = mm ?? 1;
      const viewerPoints = toViewerSpace(cloud.positions, k, cloud.units.z === null ? 0 : k);
      const measured = !!mesh.mesh && mesh.note.startsWith("z is measured");
      const regions: Record<string, number> = {};
      for (const p of set.points) if (p.accepted) regions[p.region] = (regions[p.region] ?? 0) + 1;
      const mem = perfRef.current.memory;
      updatePerf({
        processing: timings,
        processWhere: out.where,
        processWallMs: out.wallMs,
        memory: mem ? { ...mem, afterProcessingMb: heapMb() } : null,
      });
      setProcessed({
        cloud: { positions: cloud.positions, zUnit: cloud.units.z, count: cloud.count },
        viewerPoints,
        mesh: { viewer: mesh.mesh ? meshToViewerSpace(mesh.mesh) : null, completeness: mesh.completeness, components: mesh.components, triangles: mesh.triangles, note: mesh.note, measured },
        measurements,
        regions,
      });
      dispatch({ type: "processed" });
      void finishPerf(run);
    },
    [dispatch, finishPerf, updatePerf],
  );

  const animate = useCallback(
    (run: number, dots: DotLayer) => {
      const draws: number[] = [];
      const intervals: number[] = [];
      let last = performance.now();
      const step = (now: number) => {
        if (run !== runRef.current) return;
        const dt = now - last;
        last = now;
        intervals.push(dt);
        dispatch({ type: "tick", dtMs: dt });
        const s = stateRef.current;
        const xr = outlineRef.current?.xRange ?? [0, 0];
        const t0 = performance.now();
        dots.revealTo(s.sweepY);
        drawOutline(s.phase === "sweeping" ? { y: s.sweepY, x0: xr[0], x1: xr[1] } : null);
        draws.push(performance.now() - t0);
        if (s.phase === "sweeping") {
          rafRef.current = requestAnimationFrame(step);
          return;
        }
        rafRef.current = null;
        intervals.shift(); // the first interval measures the wait before the first frame, not a frame
        updatePerf({ render: summarise(draws), frameInterval: summarise(intervals), longFrames: intervals.filter((v) => v > 50).length });
        // validating: the rejected dots stay a moment, then only the accepted remain and the result is judged
        setTimeout(() => {
          if (run !== runRef.current) return;
          dots.finish();
          setDisplay({ ...dots.info });
          const accepted = setRef.current?.counts.accepted ?? 0;
          dispatch({ type: "validated", accepted });
          if (stateRef.current.phase === "captured") void process(run);
        }, SHOW_REJECTED_MS);
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [dispatch, drawOutline, process, updatePerf],
  );

  const onCaptured = useCallback(
    async (frame: CapturedFrame) => {
      if (stateRef.current.phase !== "waiting_hand") return;
      pendingCaptureRef.current = false;
      // The prerequisites are checked again on THIS frame (its own hand, coin and checks): a frame that fails any of
      // them is not used, and the live loop is armed for another.
      const coinRef = referenceRef.current;
      const confirmed = sizeRef.current;
      const g = gateFor({ landmarks: frame.landmarks, coin: frame.coin, width: frame.width, height: frame.height }, frame.chips, "running");
      if (!g?.allowed || !coinRef) {
        const b = g?.blocking;
        setDiscarded(`That frame was not used: ${b ? `${GROUP_TITLES[b.group]}: ${b.words}` : "the settings are not loaded"}. Fix it and try again.`);
        extraRunRef.current = 0;
        arm();
        return;
      }
      setDiscarded(null);
      const run = ++runRef.current;
      const st = settingsRef.current;
      ctxRef.current = { points: null, frameHeight: frame.height, sweepMs: st.sweepMs };
      dispatch({ type: "hand_found" }); // the captured frame has a hand by construction
      const fz: FrozenFrame = { frame, seg: null, segSummary: null, scale: null, imageScale: null, coin: coinRef, sizeConfirmed: confirmed, impliedHandMm: g.impliedHandMm };
      frozenRef.current = fz;
      setFrozen(fz);
      setProcessed(null);
      setPointSet(null);
      setDisplay(null);
      setRef.current = null;
      layerRef.current = null;
      outlineRef.current = null;
      setExportInfo(null);
      marksRef.current = {};
      const heap = heapMb();
      perfRef.current = {
        ...EMPTY_PERF,
        idleLive: perfRef.current.idleLive,
        cameraFps: liveStatusRef.current?.fps ?? null,
        memory: heap === null ? null : { source: "performance.memory (Chrome only)", atCaptureMb: heap, afterPointsMb: null, afterProcessingMb: null },
      };
      setPerf(perfRef.current);
      dispatch({ type: "frame_frozen" });
      // Stop the live loop and the camera while the frozen frame is scanned: hand tracking and the coin search run on the
      // page and would keep it busy (each live frame is a long task); stopped, the page is free for the animation, and a
      // phone's camera is off while nothing needs it. "Scan again" starts the camera again.
      captureRef.current?.stop();
      if (stillRef.current) drawStill(stillRef.current, frame.pixels);
      for (const c of [liveRef, dotsRef, lineRef]) clearCanvas(c.current);

      let seg: SegmentationResult;
      try {
        const client = (segRef.current ??= new SegmentClient());
        const out = await client.segment(frame.pixels, frame.landmarks, WORKING_SIZE);
        marksRef.current.segmented = performance.now();
        if (run !== runRef.current) return;
        seg = out.result;
        updatePerf({ segmentationMs: out.wallMs, segmentationWhere: out.where, segmentationStages: seg.timingMs });
      } catch (e) {
        if (run !== runRef.current) return;
        dispatch({ type: "mask_failed", reason: `The segmentation failed: ${words(e)}` });
        return;
      }
      const cfg = configRef.current;
      const ref = fz.coin; // the coin selected when the frame was taken (served config entry)
      const scale =
        cfg && ref
          ? buildScale(frame.coin, frame.landmarks, { width: frame.width, height: frame.height }, seg, {
              referenceDiameterMm: ref.diameter_mm,
              referenceDiameterUncertaintyMm: ref.diameter_uncertainty_mm,
              assumedHfovDeg: cfg.assumed_hfov_deg,
            })
          : null;
      const imageScale: ImageScale | null =
        scale?.available && scale.mmPerPx
          ? {
              mmPerPx: scale.mmPerPx,
              relUncertainty:
                scale.handLengthUncertaintyMm && scale.handLengthLandmarkMm ? scale.handLengthUncertaintyMm / scale.handLengthLandmarkMm : ref ? ref.diameter_uncertainty_mm / ref.diameter_mm : 0,
              source: "coin",
            }
          : null;
      const fz2: FrozenFrame = { ...fz, seg, segSummary: summariseSegmentation(seg), scale, imageScale };
      frozenRef.current = fz2;
      setFrozen(fz2);
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const p of seg.contour) {
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
      }
      if (!Number.isFinite(x0)) [x0, x1] = [0, frame.width];
      outlineRef.current = { contour: seg.contour, xRange: [x0, x1] };
      if (!seg.ok || !seg.mask) {
        const why = seg.reasons.length ? seg.reasons.map((r) => r.replace(/_/g, " ")).join(", ") : (seg.error ?? "no mask");
        drawOutline(null);
        dispatch({ type: "mask_failed", reason: `The hand outline was not accepted (${why}).` });
        return;
      }

      // The outline first (so it shows while the dots are made), then the dots: generated in the real mask and checked
      // against the frozen frame (all in the core), in a worker so the page keeps drawing.
      drawOutline(null);
      const dense = (denseRef.current ??= new DenseClient());
      const pts = await dense.points({
        mask: seg.mask as BinaryMask,
        scaleToSource: seg.scaleToSource,
        frameWidth: frame.width,
        frameHeight: frame.height,
        image: { width: frame.width, height: frame.height, data: frame.pixels.data },
        landmarks: frame.landmarks,
        landmarks3d: frame.landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        scale: imageScale,
        config: { spacingPx: st.spacingPx, targetSpacingMm: st.targetMm, jitter: st.jitter, edgeMarginPx: st.edgeMarginPx, seed: st.seed },
      });
      if (run !== runRef.current) return;
      const { set, timings } = pts.result;
      updatePerf({ pointsWhere: pts.where, pointsWallMs: pts.wallMs });
      setRef.current = set;
      setPointSet(set);
      ctxRef.current = { points: set.points, frameHeight: frame.height, sweepMs: st.sweepMs };
      const mem = perfRef.current.memory;
      updatePerf({ stages: timings, points: set.points.length, memory: mem ? { ...mem, afterPointsMb: heapMb() } : null });

      const rows = maskRowsSource(seg.mask, seg.scaleToSource) ?? { top: 0, bottom: frame.height };
      const dots = new DotLayer(dotsRef.current!, set.points, frame.width, frame.height, set.spacing.px, currentView());
      layerRef.current = dots;
      setDisplay({ ...dots.info });
      dispatch({ type: "mask_ready", top: rows.top, bottom: rows.bottom });
      animate(run, dots);
    },
    [animate, arm, currentView, dispatch, drawOutline, gateFor, updatePerf],
  );

  // ---- camera ---------------------------------------------------------------------------------------------------

  /** Ask the live loop for a capture (the captured frame is checked again before it is used). */
  const requestCapture = useCallback(() => {
    if (pendingCaptureRef.current || stateRef.current.phase !== "waiting_hand") return;
    pendingCaptureRef.current = true;
    captureRef.current?.requestCapture();
  }, []);

  const startCamera = useCallback(async () => {
    const video = videoRef.current;
    const cfg = configRef.current;
    if (!video || !cfg) return;
    setError(null);
    captureRef.current?.dispose();
    const lc = new LiveCapture(video, { config: cfg, facing: facingRef.current });
    lc.onStatus((s) => {
      liveStatusRef.current = s;
      setLive(s);
      setLiveFrame(s.phase === "running" ? liveFrameRef.current : null);
      if (s.phase === "error" && s.error?.kind === "permission_denied") setReadiness((r) => ({ ...r, permission: "denied" }));
      // hand_found / hand_lost only while waiting: during a scan the frame is frozen, so the live hand does not matter.
      if (stateRef.current.phase !== "waiting_hand" || s.phase !== "running") return;
      const seen = !!s.chips?.handFound;
      if (seen !== stateRef.current.handSeen) dispatch({ type: seen ? "hand_found" : "hand_lost" });
      if (seen && !idleLiveSampled.current) {
        idleLiveSampled.current = true;
        void sampleFrames(1000).then((idleLive) => updatePerf({ idleLive }));
      }
    });
    lc.onOverlay((o) => {
      liveFrameRef.current = o;
      const c = liveRef.current;
      if (stateRef.current.phase !== "waiting_hand") return;
      if (c) drawLiveLandmarks(c, o.landmarks, o.coin, o.width, o.height);
      // Auto-start: the existing run of 8 good frames of the live loop's checks (hand in the picture, coin accepted,
      // posture, steady, sharp) AND 8 consecutive frames on which every prerequisite of the page passes (also hand size,
      // the coin's plausibility and the size confirmation). The frame then taken is checked once more.
      const g = gateFor(o, liveStatusRef.current?.chips ?? null, "running");
      extraRunRef.current = g?.allowed ? extraRunRef.current + 1 : 0;
      const run = liveStatusRef.current?.goodRun ?? 0;
      if (autoRef.current && extraRunRef.current >= AUTO_CAPTURE_FRAMES && run >= AUTO_CAPTURE_FRAMES) requestCapture();
    });
    lc.onCaptured((f) => {
      onCaptured(f).catch((e) => {
        console.error("dense scan failed", e);
        setError(`The scan failed: ${words(e)}`);
      });
    });
    captureRef.current = lc;
    pendingCaptureRef.current = false;
    extraRunRef.current = 0;
    lc.armView(palm, () => null, false);
    await lc.start();
  }, [dispatch, gateFor, onCaptured, palm, requestCapture, updatePerf]);

  const stopCamera = useCallback(() => captureRef.current?.stop(), []);

  useEffect(
    () => () => {
      runRef.current++;
      stopAnimation();
      captureRef.current?.dispose();
      segRef.current?.dispose();
      denseRef.current?.dispose();
    },
    [],
  );

  /** The Scan button: only when every prerequisite passes on the current frame (the button is disabled otherwise). */
  const scanNow = useCallback(() => {
    const s = liveStatusRef.current;
    const g = gateFor(liveFrameRef.current, s?.chips ?? null, s?.phase === "running" ? "running" : "off");
    if (!g?.allowed) return;
    requestCapture();
  }, [gateFor, requestCapture]);

  const reset = useCallback(() => {
    runRef.current++;
    stopAnimation();
    stateRef.current = initialScanState();
    phasesRef.current = ["waiting_hand"];
    ctxRef.current = { points: null, frameHeight: 0, sweepMs: settingsRef.current.sweepMs };
    frozenRef.current = null;
    setRef.current = null;
    layerRef.current = null;
    outlineRef.current = null;
    setFrozen(null);
    setPointSet(null);
    setProcessed(null);
    setDisplay(null);
    setExportInfo(null);
    setError(null);
    for (const c of [stillRef, dotsRef, lineRef]) clearCanvas(c.current);
    publish(true);
    pendingCaptureRef.current = false;
    extraRunRef.current = 0;
    setDiscarded(null);
    arm(); // lifts the one-capture-per-view cooldown of the live loop (when it is running)
  }, [arm, publish]);

  /** Clear the result and start the camera again (it was stopped when the frame was frozen). */
  const scanAgain = useCallback(() => {
    reset();
    if (liveStatusRef.current?.phase !== "running") void startCamera();
  }, [reset, startCamera]);

  /** The page's own auto-start (the live loop's automatic capture stays off: see onOverlay). */
  const setAutoStart = useCallback((on: boolean) => {
    setAutoStartState(on);
    extraRunRef.current = 0;
  }, []);

  /** Front or back camera; restarts the camera when it is running. */
  const setFacing = useCallback(
    (f: Facing) => {
      setFacingState(f);
      facingRef.current = f;
      const camOn = liveStatusRef.current?.phase === "running" || liveStatusRef.current?.phase === "loading";
      const scanned = stateRef.current.phase !== "waiting_hand";
      if (scanned) reset();
      if (camOn || scanned) void startCamera();
    },
    [reset, startCamera],
  );

  // ---- export (a download on this device) ----------------------------------------------------------------------

  const exportZip = useCallback(async (includePhoto: boolean) => {
    const set = setRef.current;
    const fz = frozenRef.current;
    const cfg = configRef.current;
    if (!set || !fz) return null;
    const ref = fz.coin; // the coin used for THIS frame, from the served config
    const meta = {
      createdAt: new Date().toISOString(),
      page: "experiment/dense (EXPERIMENTAL, not the customer app)",
      capturedAt: fz.frame.capturedAt,
      trigger: fz.frame.trigger,
      frame: { width: fz.frame.width, height: fz.frame.height, orientation: fz.frame.height > fz.frame.width ? "portrait" : "landscape" },
      stream: fz.frame.stream,
      coin: fz.frame.coin,
      calibration: {
        referenceObjectId: ref.id,
        referenceLabel: ref.label,
        referenceDiameterMm: ref.diameter_mm,
        referenceDiameterUncertaintyMm: ref.diameter_uncertainty_mm,
        coin: coinRecord(ref, fz.sizeConfirmed),
        configSource: "GET /api/config (reference_objects, served from config/reference_objects.json)",
        impliedHandLengthMmAtCapture: fz.impliedHandMm,
        plausibleHandMm: cfg?.hand_length_plausible_mm ?? null,
        assumedHfovDeg: cfg?.assumed_hfov_deg ?? null,
        calibrationStatus: cfg?.calibration_status ?? null,
        calibrationValidated: cfg?.calibration_validated ?? null,
        scale: fz.scale,
      },
      settings: settingsRef.current,
      segmentation: fz.segSummary,
      photoIncluded: includePhoto,
    };
    const { json, csv } = exportPointSet(set, meta);
    const enc = new TextEncoder();
    const date = new Date();
    const entries: ZipEntry[] = [
      { name: "points.json", data: enc.encode(json), date },
      { name: "points.csv", data: enc.encode(csv), date },
      {
        name: "README.txt",
        data: enc.encode(
          [
            "EXPERIMENTAL dense surface-point scan (not the customer app).",
            "points.json / points.csv: every generated point, accepted or rejected (with the reason), in source-frame pixels.",
            "z is MediaPipe's estimated relative depth (depth = estimated) or empty (depth = none); it is not a measurement.",
            "mm values use the coin-plane scale (a model). No accuracy is claimed: nothing has been compared with physical measurements.",
            includePhoto ? "photo.png: the frozen frame, included because the export box was ticked." : "No image is included (the photo box was not ticked).",
            "Made on this device; nothing was uploaded.",
          ].join("\n") + "\n",
        ),
        date,
      },
    ];
    if (includePhoto) entries.push({ name: "photo.png", data: new Uint8Array(await (await pixelsToPng(fz.frame.pixels)).arrayBuffer()), date });
    const bytes = makeZip(entries);
    const filename = `dense-scan-${date.toISOString().replace(/[:.]/g, "-")}.zip`;
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    const info = { filename, names: entries.map((e) => e.name), bytes: bytes.length };
    setExportInfo(info);
    return info;
  }, []);

  // ---- the live prerequisites, for the page ------------------------------------------------------------------------

  const gate = useMemo(
    () => (scan.phase === "waiting_hand" ? gateFor(liveFrame, live?.chips ?? null, live?.phase === "running" ? "running" : live?.phase === "error" ? "error" : live?.phase === "starting" || live?.phase === "loading" ? "starting" : "off") : null),
    // reference and sizeConfirmed are read through refs inside gateFor; listed so the panel updates when they change
    [gateFor, liveFrame, live, scan.phase, reference, sizeConfirmed, config],
  );
  const segGroup = useMemo(() => segmentationGroup(scan.phase, frozen?.seg ? { ok: frozen.seg.ok, reasons: frozen.seg.reasons, error: frozen.seg.error } : null), [scan.phase, frozen]);
  const coins = useMemo(() => (config ? selectableCoins(config) : []), [config]);

  // ---- the debug hook (dev-only page) ---------------------------------------------------------------------------

  const outsideMask = useMemo(() => (pointSet ? pointsOutsideMask(pointSet) : 0), [pointSet]);
  const gaps: GapProbe[] = useMemo(() => (pointSet && frozen ? gapProbes(pointSet, frozen.frame.landmarks) : []), [pointSet, frozen]);
  useEffect(() => {
    let maxX = -Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let minY = Infinity;
    for (const p of pointSet?.points ?? []) {
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
    }
    window.__DENSE_SCAN__ = {
      phase: scan.phase,
      phases: [...phasesRef.current],
      reasons: scan.reasons,
      counts: pointSet?.counts ?? null,
      revealed: counts,
      spacing: pointSet?.spacing ?? null,
      pointSet,
      outsideMask,
      gapProbes: gaps,
      segmentation: frozen?.segSummary ?? null,
      frame: frozen ? { width: frozen.frame.width, height: frozen.frame.height } : null,
      video: live?.video ?? null,
      mask: frozen?.seg?.mask ? { width: frozen.seg.mask.width, height: frozen.seg.mask.height, scaleToSource: frozen.seg.scaleToSource } : null,
      pointBounds: pointSet ? { minX, minY, maxX, maxY } : null,
      regions: processed?.regions ?? null,
      display,
      zUnit: processed?.cloud.zUnit ?? null,
      mesh: processed ? { triangles: processed.mesh.triangles, completeness: processed.mesh.completeness, components: processed.mesh.components, measured: processed.mesh.measured } : null,
      perf,
      exportInfo,
      readiness,
      mirrored: live?.mirrored ?? null,
      live: live ? { phase: live.phase, reasons: live.reasons, chips: live.chips, goodRun: live.goodRun, fps: live.fps } : null,
      // raw timeline for diagnosis: phase marks and the last long tasks (performance.now() times)
      marks: { ...marksRef.current },
      longTaskLog: longRef.current ? longRef.current.entries.slice(-120) : null,
      // the coin: selected now (served config entry), how it was chosen, and the one used for the frozen frame
      coin: reference ? coinRecord(reference, sizeConfirmed) : null,
      coinVia,
      coinNote,
      coinAtCapture: frozen ? coinRecord(frozen.coin, frozen.sizeConfirmed) : null,
      scaleAtCapture: frozen?.scale ? { mmPerPx: frozen.scale.mmPerPx, coinMajorPx: frozen.frame.coin?.major_axis_px ?? null, impliedHandMm: frozen.impliedHandMm } : null,
      liveCoin: liveFrame?.coin
        ? { found: liveFrame.coin.found, accepted: liveFrame.coin.accepted, reasons: liveFrame.coin.reasons, x: liveFrame.coin.center_x, y: liveFrame.coin.center_y, majorPx: liveFrame.coin.major_axis_px }
        : null,
      gate: gate ? { allowed: gate.allowed, blocking: gate.blocking, groups: gate.groups, waitingForCoinOnly: gate.waitingForCoinOnly, impliedHandMm: gate.impliedHandMm } : null,
      segGroup,
      discarded,
    };
  }, [scan, counts, pointSet, outsideMask, gaps, frozen, processed, perf, exportInfo, display, live, readiness, reference, sizeConfirmed, coinVia, coinNote, liveFrame, gate, segGroup, discarded]);

  return {
    videoRef,
    stageRef,
    stillRef,
    liveRef,
    dotsRef,
    lineRef,
    config,
    configError,
    reference,
    refId,
    setRefId,
    coins,
    coinNote,
    coinVia,
    sizeConfirmed,
    setSizeConfirmed,
    gate,
    segGroup,
    discarded,
    live,
    autoStart,
    setAutoStart,
    facing,
    setFacing,
    readiness,
    settings,
    setSettings,
    scan,
    counts,
    frozen,
    pointSet,
    processed,
    perf,
    display,
    error,
    exportInfo,
    outsideMask,
    startCamera,
    stopCamera,
    scanNow,
    reset,
    scanAgain,
    exportZip,
  };
}

export type DenseApi = ReturnType<typeof useDenseScan>;
