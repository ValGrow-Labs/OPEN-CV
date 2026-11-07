// An interactive viewer for an EXPERIMENTAL reconstruction: a triangle mesh and/or a point cloud that can be rotated,
// zoomed and reset, drawn plain or wireframe, and coloured by how well each part was observed. This is the light wrapper:
// it decides whether WebGL can be used, loads the scene lazily (three.js is its own chunk) and owns everything that is
// not the canvas (loading, empty and error states, buttons, the honesty caption).
//
// Display only. It shows geometry it is given; it measures nothing and feeds nothing back. UNTESTED VISUALLY: the
// states and controls are unit-tested in jsdom with the scene stubbed, but the scene itself has not been looked at in a
// browser (no browser was available when it was written).
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Mesh } from "../common";
import "./meshViewer.css";

export interface MeshViewerProps {
  mesh?: Mesh | null;
  /** x, y, z triples (millimetres), drawn as points. */
  points?: Float32Array | null;
  /** Per-vertex observation confidence in 0..1 (same length as the mesh vertices), for the colour mode. */
  confidence?: Float32Array | null;
  /** The honesty label under the view. Say what the data is (synthetic, unvalidated, ...). */
  label?: string;
  className?: string;
  /** Called once if 3D cannot run, with a human-readable reason. */
  onUnavailable?: (message: string) => void;
}

export const DEFAULT_LABEL = "Experimental, not a validated measurement";

export interface MeshSceneControls {
  reset(): void;
}

export interface MeshSceneProps {
  mesh: Mesh | null;
  points: Float32Array | null;
  confidence: Float32Array | null;
  wireframe: boolean;
  colorByConfidence: boolean;
  controlsRef: { current: MeshSceneControls | null };
  onReady: () => void;
  onFail: (message: string) => void;
}

const Scene = lazy(() => import("./MeshViewerGL"));

let webgl: boolean | null = null;

/** True when a WebGL context can be created here (false in jsdom and on some old phones). Asked once. */
function webglAvailable(): boolean {
  if (webgl) return true;
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension?.("WEBGL_lose_context")?.loseContext();
    webgl = true;
    return true;
  } catch {
    return false;
  }
}

/** Forget the answer (tests). */
export function resetMeshViewerWebglCheck(): void {
  webgl = null;
}

export const MV_NO_WEBGL = "3D view unavailable: this browser or device cannot draw WebGL graphics.";
export const MV_FAILED = "3D view unavailable: it could not start on this device.";
export const MV_LOST = "3D view stopped: the browser reset the graphics. Reload the page to see it again.";

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

export function MeshViewer({ mesh = null, points = null, confidence = null, label = DEFAULT_LABEL, className = "", onUnavailable }: MeshViewerProps) {
  const available = webglAvailable();
  const [phase, setPhase] = useState<Phase>(available ? "loading" : "error");
  const [message, setMessage] = useState<string>(available ? "" : MV_NO_WEBGL);
  const [wireframe, setWireframe] = useState(false);
  const [byConfidence, setByConfidence] = useState(false);
  const controlsRef = useRef<MeshSceneControls | null>(null);
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

  useEffect(() => {
    if (!available) fail(MV_NO_WEBGL);
  }, [available, fail]);

  const onReady = useCallback(() => setPhase((p) => (p === "error" ? p : "ready")), []);
  const hasGeometry = !!(mesh && mesh.indices.length > 0) || !!(points && points.length > 0);
  const canColour = !!confidence && !!mesh && confidence.length === mesh.vertices.length / 3;
  const showScene = available && phase !== "error" && hasGeometry;

  return (
    <div className={`mv ${className}`} role="group" aria-label="Experimental 3D reconstruction viewer">
      <div className="mv-stage">
        {showScene && (
          <SceneBoundary onError={() => fail(MV_FAILED)}>
            <Suspense fallback={null}>
              <Scene
                mesh={mesh}
                points={points}
                confidence={canColour ? confidence : null}
                wireframe={wireframe}
                colorByConfidence={byConfidence && canColour}
                controlsRef={controlsRef}
                onReady={onReady}
                onFail={fail}
              />
            </Suspense>
          </SceneBoundary>
        )}
        {phase === "loading" && hasGeometry && (
          <div className="mv-note mv-loading" role="status">
            <span className="mv-spinner" aria-hidden="true" />
            Loading 3D view…
          </div>
        )}
        {phase !== "error" && !hasGeometry && (
          <div className="mv-note mv-empty" role="status">
            No reconstruction to show
          </div>
        )}
        {phase === "error" && (
          <div className="mv-note mv-error" role="status">
            {message}
          </div>
        )}
        {phase !== "error" && hasGeometry && (
          <div className="mv-controls">
            <button type="button" className="mv-btn" aria-pressed={wireframe} onClick={() => setWireframe((w) => !w)} disabled={phase !== "ready"}>
              Wireframe
            </button>
            <button type="button" className="mv-btn" aria-pressed={byConfidence} onClick={() => setByConfidence((c) => !c)} disabled={phase !== "ready" || !canColour} title={canColour ? undefined : "No observation confidence was supplied"}>
              Colour by observation
            </button>
            <button type="button" className="mv-btn" onClick={() => controlsRef.current?.reset()} disabled={phase !== "ready"}>
              Reset view
            </button>
          </div>
        )}
        {phase === "ready" && byConfidence && canColour && (
          <span className="mv-legend" aria-hidden="true">
            <i className="mv-legend-low" /> weakly observed <i className="mv-legend-high" /> directly observed
          </span>
        )}
      </div>
      <p className="mv-caption">{label}</p>
    </div>
  );
}
