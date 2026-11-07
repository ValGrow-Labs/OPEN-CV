// The state and actions of the EXPERIMENTAL capture page: config, live camera, guided views, captured views (memory only),
// per-view analysis, pose consistency, depth capability and export. The page components only render this.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicConfig, ReferenceObject } from "../../api/types";
import { fetchConfig } from "../../api/client";
import { customerCoins } from "../../ui/settings";
import { detectDepthCapabilities, type DepthCapabilityReport } from "../depth";
import { poseConsistency, type PoseConsistencyResult } from "../geometry";
import type { SegmentationResult } from "../segmentation/segmentHand";
import { buildScale, summariseSegmentation, type ScaleContext } from "./analysis";
import { buildBundle, type BuiltBundle } from "./bundle";
import { LiveCapture, type CapturedFrame, type LiveStatus } from "./live";
import { drawLiveOverlay, maskToPng, pixelsToPng } from "./render";
import { SegmentClient } from "./segmentClient";
import type { CapturedView, ViewAnalysis } from "./types";
import { viewsFor, type ViewDef, type ViewId } from "./views";

export type AnalysisState =
  | { state: "running" }
  | { state: "error"; message: string }
  | { state: "done"; result: SegmentationResult; where: "worker" | "page"; wallMs: number };

export interface ExportInfo {
  names: string[];
  bytes: number;
  filename: string;
}

export function useCapture() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<LiveCapture | null>(null);
  const segRef = useRef<SegmentClient | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [refId, setRefId] = useState("");
  const [includeObliques, setIncludeObliques] = useState(false);
  const [autoCapture, setAutoCaptureState] = useState(true);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [captured, setCaptured] = useState<Partial<Record<ViewId, CapturedView>>>({});
  const [skipped, setSkipped] = useState<ViewId[]>([]);
  const [analysis, setAnalysis] = useState<Partial<Record<ViewId, AnalysisState>>>({});
  const [announce, setAnnounce] = useState("");
  const [depth, setDepth] = useState<DepthCapabilityReport | null>(null);
  const [exportInfo, setExportInfo] = useState<ExportInfo | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const views = useMemo(() => viewsFor({ includeObliques }), [includeObliques]);
  const current: ViewDef | null = useMemo(() => views.find((v) => !captured[v.id] && !skipped.includes(v.id)) ?? null, [views, captured, skipped]);

  // Latest values for callbacks that outlive a render.
  const capturedRef = useRef(captured);
  capturedRef.current = captured;
  const currentRef = useRef(current);
  currentRef.current = current;
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const configRef = useRef(config);
  configRef.current = config;
  const refIdRef = useRef(refId);
  refIdRef.current = refId;
  const autoCaptureRef = useRef(autoCapture);
  autoCaptureRef.current = autoCapture;

  // The public settings, once: the only API request this page ever makes.
  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        setRefId(c.reference_objects.default);
      })
      .catch((e) => alive && setConfigError(String(e instanceof Error ? e.message : e)));
    detectDepthCapabilities()
      .then((d) => alive && setDepth(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const reference: ReferenceObject | null = useMemo(() => {
    if (!config) return null;
    return customerCoins(config).find((o) => o.id === refId) ?? config.reference_objects.objects.find((o) => o.id === refId) ?? null;
  }, [config, refId]);

  const turnOf = useCallback((id: ViewId) => capturedRef.current[id]?.quality.turn ?? null, []);

  // Arm the live checks for the current view (and re-arm when the auto-capture switch changes).
  useEffect(() => {
    liveRef.current?.armView(current, turnOf, autoCapture);
  }, [current, autoCapture, turnOf]);

  const runAnalysis = useCallback(async (view: CapturedView) => {
    const id = view.def.id;
    const cfg = configRef.current;
    const ref = cfg?.reference_objects.objects.find((o) => o.id === refIdRef.current);
    setAnalysis((p) => ({ ...p, [id]: { state: "running" } }));
    try {
      const seg = (segRef.current ??= new SegmentClient());
      const out = await seg.segment(view.still.pixels, view.landmarks);
      const maskPng = out.result.mask ? await maskToPng(out.result.mask) : null;
      const ctx: ScaleContext | null = cfg && ref ? { referenceDiameterMm: ref.diameter_mm, referenceDiameterUncertaintyMm: ref.diameter_uncertainty_mm, assumedHfovDeg: cfg.assumed_hfov_deg } : null;
      const scale = ctx ? buildScale(view.coin, view.landmarks, { width: view.still.width, height: view.still.height }, out.result, ctx) : null;
      const summary: ViewAnalysis = { segmentation: summariseSegmentation(out.result), scale, totalMs: out.wallMs };
      setCaptured((p) => (p[id]?.capturedAt === view.capturedAt ? { ...p, [id]: { ...p[id]!, analysis: summary, maskPng } } : p));
      setAnalysis((p) => ({ ...p, [id]: { state: "done", result: out.result, where: out.where, wallMs: out.wallMs } }));
    } catch (e) {
      setAnalysis((p) => ({ ...p, [id]: { state: "error", message: String(e instanceof Error ? e.message : e) } }));
    }
  }, []);

  const analyse = useCallback(
    (view: CapturedView) => {
      queueRef.current = queueRef.current.then(() => runAnalysis(view)).catch(() => undefined);
    },
    [runAnalysis],
  );

  const onCaptured = useCallback(
    async (frame: CapturedFrame) => {
      const def = currentRef.current;
      console.info(`[capture] received a frame for ${def?.id ?? "no armed view"}`);
      if (!def) return;
      const blob = await pixelsToPng(frame.pixels);
      const order = viewsRef.current.findIndex((v) => v.id === def.id) + 1;
      const view: CapturedView = {
        def,
        order,
        capturedAt: frame.capturedAt,
        quality: { passed: frame.reasons.length === 0, reasons: frame.reasons, trigger: frame.trigger, sharpness: frame.sharpness, jitter: frame.jitter, turn: frame.turn },
        still: { blob, width: frame.width, height: frame.height, pixels: frame.pixels },
        highRes: null,
        landmarks: frame.landmarks,
        world: frame.world,
        handedness: frame.handedness,
        handednessScore: frame.handednessScore,
        coin: frame.coin,
        stream: frame.stream,
        analysis: null,
        maskPng: null,
      };
      setCaptured((p) => ({ ...p, [def.id]: view }));
      setAnnounce(`${def.title} captured${view.quality.passed ? ", all checks passed" : ", but not every check passed"}.`);
      analyse(view);
      void liveRef.current?.takeHighRes().then((h) => {
        if (h) setCaptured((p) => (p[def.id]?.capturedAt === view.capturedAt ? { ...p, [def.id]: { ...p[def.id]!, highRes: h } } : p));
      });
    },
    [analyse],
  );

  const startCamera = useCallback(async () => {
    const video = videoRef.current;
    const cfg = configRef.current;
    if (!video || !cfg) return;
    liveRef.current?.dispose();
    const lc = new LiveCapture(video, { config: cfg });
    lc.onStatus(setLive);
    lc.onOverlay((o) => overlayRef.current && drawLiveOverlay(overlayRef.current, o.landmarks, o.coin, o.width, o.height));
    lc.onCaptured((f) => {
      // A failed capture is said out loud (never swallowed), and the view is re-armed so it can be tried again.
      onCaptured(f).catch((e) => {
        console.error("capture failed", e);
        setAnnounce(`The capture failed: ${String(e instanceof Error ? e.message : e)}. Try again.`);
        lc.armView(currentRef.current, turnOf, autoCaptureRef.current);
      });
    });
    liveRef.current = lc;
    lc.armView(currentRef.current, turnOf, autoCapture);
    await lc.start();
  }, [autoCapture, onCaptured, turnOf]);

  const stopCamera = useCallback(() => {
    liveRef.current?.stop();
  }, []);

  useEffect(
    () => () => {
      liveRef.current?.dispose();
      segRef.current?.dispose();
    },
    [],
  );

  const captureNow = useCallback(() => liveRef.current?.requestCapture(), []);

  const skip = useCallback((id: ViewId) => setSkipped((p) => (p.includes(id) ? p : [...p, id])), []);

  const retake = useCallback((id: ViewId) => {
    setCaptured((p) => {
      const { [id]: _gone, ...rest } = p;
      return rest;
    });
    setAnalysis((p) => {
      const { [id]: _gone, ...rest } = p;
      return rest;
    });
    setSkipped((p) => p.filter((x) => x !== id));
    setAnnounce("Retaking this view.");
  }, []);

  const clearAll = useCallback(() => {
    setCaptured({});
    setAnalysis({});
    setSkipped([]);
    setExportInfo(null);
    setAnnounce("All captures cleared from memory.");
  }, []);

  const capturedList = useMemo(() => Object.values(captured).filter((v): v is CapturedView => !!v).sort((a, b) => a.order - b.order), [captured]);

  const pose: PoseConsistencyResult | null = useMemo(() => {
    const withWorld = capturedList.filter((v) => v.world && v.world.length === 21);
    if (withWorld.length < 2) return null;
    try {
      return poseConsistency(withWorld.map((v) => ({ id: v.def.id, kind: "world" as const, points: v.world! })));
    } catch {
      return null;
    }
  }, [capturedList]);

  const exportBundle = useCallback(async () => {
    const cfg = configRef.current;
    const ref = cfg?.reference_objects.objects.find((o) => o.id === refIdRef.current);
    setExportError(null);
    if (!cfg || !ref || capturedList.length === 0) {
      setExportError("Nothing to export yet: capture at least one view.");
      return null;
    }
    try {
      const built: BuiltBundle = await buildBundle(capturedList, {
        createdAt: new Date(),
        device: { userAgent: navigator.userAgent, screenWidth: screen.width, screenHeight: screen.height, devicePixelRatio: window.devicePixelRatio },
        config: {
          referenceObjectId: ref.id,
          referenceLabel: ref.label,
          referenceDiameterMm: ref.diameter_mm,
          referenceDiameterUncertaintyMm: ref.diameter_uncertainty_mm,
          assumedHfovDeg: cfg.assumed_hfov_deg,
          calibrationStatus: cfg.calibration_status,
          calibrationValidated: cfg.calibration_validated,
        },
        poseConsistency: pose,
        depth,
      });
      const url = URL.createObjectURL(built.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = built.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setExportInfo({ names: built.names, bytes: built.bytes.length, filename: built.filename });
      return built;
    } catch (e) {
      setExportError(String(e instanceof Error ? e.message : e));
      return null;
    }
  }, [capturedList, depth, pose]);

  const reanalyse = useCallback(
    (id: ViewId) => {
      const v = capturedRef.current[id];
      if (v) analyse(v);
    },
    [analyse],
  );

  return {
    videoRef,
    overlayRef,
    config,
    configError,
    reference,
    refId,
    setRefId,
    includeObliques,
    setIncludeObliques,
    autoCapture,
    setAutoCapture: (on: boolean) => {
      setAutoCaptureState(on);
      liveRef.current?.setAutoCapture(on);
    },
    views,
    current,
    skipped,
    captured,
    capturedList,
    analysis,
    live,
    announce,
    pose,
    depth,
    exportInfo,
    exportError,
    startCamera,
    stopCamera,
    captureNow,
    skip,
    retake,
    clearAll,
    exportBundle,
    reanalyse,
  };
}

export type CaptureApi = ReturnType<typeof useCapture>;
