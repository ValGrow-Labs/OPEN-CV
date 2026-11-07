// A dedicated card with an ESTIMATED 3D view of the tracked hand: the 21 MediaPipe world landmarks as joints and
// bones, coloured by finger, over a reference grid, that the customer can rotate, zoom and reset. This is the
// light wrapper: it decides whether WebGL can be used, loads the scene lazily (three.js is its own chunk) and
// owns everything that is not the canvas (loading, empty and error states, buttons, the honesty caption).
//
// Display only. It reads landmarks the scan already has and never feeds anything back.
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { CAPTION, CAPTION_2D, handLabel, type WorldPoint } from "./viewerMath";
import "./landmarkViewer.css";

export type { WorldPoint };

/** MediaPipe HandLandmarker WORLD landmarks of the tracked hand (metres, origin near the hand's centre, y down), or
 *  null when no hand is tracked. ``handedness`` is the ACTUAL hand ("Left" | "Right"), or null when unknown. */
export interface WorldHand {
  points: readonly WorldPoint[];
  handedness: string | null;
}

export interface LandmarkViewerProps {
  /** Read every frame by the scene (no React re-render). */
  worldRef: MutableRefObject<WorldHand | null>;
  /** Front camera: the picture the customer sees is mirrored, so the 3D hand is too. */
  mirrored?: boolean;
  className?: string;
  /** Called once if 3D cannot run, with a human-readable reason. */
  onUnavailable?: (message: string) => void;
}

/** What the scene tells the card (only on change, so React does not re-render per frame). */
export interface SceneHandState {
  present: boolean;
  depth: boolean;
  handedness: string | null;
}

/** What the card asks of the scene. */
export interface SceneControls {
  reset(): void;
  topView(): void;
}

export interface SceneProps {
  worldRef: MutableRefObject<WorldHand | null>;
  mirrored: boolean;
  controlsRef: MutableRefObject<SceneControls | null>;
  onReady: () => void;
  onFail: (message: string) => void;
  onHand: (state: SceneHandState) => void;
}

const Scene = lazy(() => import("./LandmarkViewerGL"));

let webgl: boolean | null = null;

/** True when a WebGL context can be created here (false in jsdom and on some old phones). Asked once. */
function webglAvailable(): boolean {
  if (webgl) return true;
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension?.("WEBGL_lose_context")?.loseContext(); // the probe gives its context back
    webgl = true;
    return true;
  } catch {
    return false;
  }
}

/** Forget the answer (tests). */
export function resetViewerWebglCheck(): void {
  webgl = null;
}

export const UNAVAILABLE_NO_WEBGL = "3D view unavailable: this browser or device cannot draw WebGL graphics. The scan itself still works.";
export const UNAVAILABLE_FAILED = "3D view unavailable: it could not start on this device. The scan itself still works.";
export const UNAVAILABLE_LOST = "3D view stopped: the browser reset the graphics. Reload the page to see it again. The scan itself still works.";

/** The scene is a lazily loaded chunk and a GPU program: if either fails the card says so and the page carries on. */
class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type Phase = "loading" | "ready" | "error";

export function LandmarkViewer({ worldRef, mirrored = false, className = "", onUnavailable }: LandmarkViewerProps) {
  const available = webglAvailable();
  const [phase, setPhase] = useState<Phase>(available ? "loading" : "error");
  const [message, setMessage] = useState<string>(available ? "" : UNAVAILABLE_NO_WEBGL);
  const [hand, setHand] = useState<SceneHandState>({ present: false, depth: true, handedness: null });
  const controlsRef = useRef<SceneControls | null>(null);
  const told = useRef(false);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  const fail = useCallback((text: string) => {
    setPhase("error");
    setMessage(text);
    if (!told.current) {
      told.current = true;
      onUnavailableRef.current?.(text);
    }
  }, []);

  // No WebGL at all: say so once, straight away.
  useEffect(() => {
    if (!available) fail(UNAVAILABLE_NO_WEBGL);
  }, [available, fail]);

  const onReady = useCallback(() => setPhase((p) => (p === "error" ? p : "ready")), []);
  const onHand = useCallback((s: SceneHandState) => setHand((cur) => (cur.present === s.present && cur.depth === s.depth && cur.handedness === s.handedness ? cur : s)), []);

  const showScene = available && phase !== "error";
  return (
    <div className={`lv ${className}`} role="group" aria-label="Estimated 3D landmark view of your hand">
      <div className="lv-stage">
        {showScene && (
          <SceneBoundary onError={() => fail(UNAVAILABLE_FAILED)}>
            <Suspense fallback={null}>
              <Scene worldRef={worldRef} mirrored={mirrored} controlsRef={controlsRef} onReady={onReady} onFail={fail} onHand={onHand} />
            </Suspense>
          </SceneBoundary>
        )}

        {phase === "loading" && (
          <div className="lv-note lv-loading" role="status">
            <span className="lv-spinner" aria-hidden="true" />
            Loading 3D view…
          </div>
        )}
        {phase === "ready" && !hand.present && (
          <div className="lv-note lv-empty" role="status">
            Show your hand to see it in 3D
          </div>
        )}
        {phase === "error" && (
          <div className="lv-note lv-error" role="status">
            {message}
          </div>
        )}

        {phase === "ready" && hand.present && <span className="lv-chip lv-hand">{handLabel(hand.handedness)}</span>}
        <span className="lv-chip lv-axes" title="Red: left to right. Green: up. Blue: toward the camera." aria-hidden="true">
          <i className="lv-ax lv-ax-x">x</i>
          <i className="lv-ax lv-ax-y">y</i>
          <i className="lv-ax lv-ax-z">z</i>
        </span>

        {phase !== "error" && (
          <div className="lv-controls">
            <button type="button" className="lv-btn" onClick={() => controlsRef.current?.topView()} disabled={phase !== "ready"}>
              Top view
            </button>
            <button type="button" className="lv-btn" onClick={() => controlsRef.current?.reset()} disabled={phase !== "ready"}>
              Reset view
            </button>
          </div>
        )}
        {phase === "ready" && (
          <span className="lv-help" aria-hidden="true">
            Drag sideways to turn · pinch or scroll to zoom
          </span>
        )}
      </div>
      <p className="lv-caption">
        {phase === "ready" && hand.present && !hand.depth && <strong className="lv-2d">{CAPTION_2D}. </strong>}
        {CAPTION}
      </p>
    </div>
  );
}
