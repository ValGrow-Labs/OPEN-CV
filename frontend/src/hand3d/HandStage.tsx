// A dark stage with a glowing particle-and-wireframe 3D hand over a sonar-wave grid. This is the light
// wrapper: it decides whether WebGL can be used, loads the scene lazily (three.js is a separate chunk)
// and shows a static fallback otherwise (no WebGL, tests, reduced motion before it loads).
import { Component, lazy, Suspense, useEffect, type MutableRefObject, type ReactNode } from "react";
import type { Landmark } from "./handModel";
import type { Budget } from "./perfGuard";
import "./handStage.css";

export interface HandStageTag {
  /** Landmark index the label is attached to (e.g. a fingertip). */
  joint: number;
  /** Or: attach the label to the midpoint between two landmarks (the hand-length label sits halfway up the hand). */
  between?: readonly [number, number];
  label: string;
  /** Drawn larger and brighter (the hand length). */
  emphasis?: boolean;
}

export interface HandStageProps {
  /** "scan": generic hand, slow rotation and a sonar sweep. "static": the hand of ``landmarks``.
   *  "live": follows ``poseRef`` every frame (read without React re-renders).
   *  "overlay": the camera view itself: a transparent, full-size layer drawn exactly over the real hand
   *  (``poseRef`` holds landmarks in video pixels, ``frameRef`` the video's pixel size); no grid floor, no
   *  rotation: a glowing 3D mesh, measuring rails along the fingers and a scanning sweep. */
  mode: "scan" | "static" | "live" | "overlay";
  /** Overlay mode: whether the pose is right ("ok": cool cyan-green), needs fixing ("warn": a paler blue) or there is
   *  nothing to judge yet ("idle": neutral cyan). Colours ease between tones; default "idle". */
  tone?: "ok" | "warn" | "idle";
  /** Overlay mode: the camera picture behind is blacked out around the hand, so the layer may glow additively
   *  (a hologram on black) instead of using the dark-rimmed look that keeps it legible on a bright picture. */
  onBlack?: boolean;
  /** The camera frame size in pixels (overlay mode), to map landmarks onto a ``object-fit: contain`` picture. */
  frameRef?: MutableRefObject<{ width: number; height: number } | null>;
  landmarks?: readonly Landmark[] | null;
  poseRef?: MutableRefObject<readonly Landmark[] | null>;
  /** The hand is shown mirrored (a front camera). */
  mirror?: boolean;
  tags?: readonly HandStageTag[];
  className?: string;
  /** Accessible description of the picture. */
  label?: string;
  /** Overlay mode: called once when the layer has switched itself off (no WebGL, it could not start, the
   *  context was lost, or it was too heavy for this phone). It then draws nothing: use the 2D drawing. */
  onDegrade?: (reason: "disabled") => void;
  /** Overlay mode: what the layer may cost before it steps itself down (perfGuard.ts). */
  budget?: Budget;
  /** "dark" (default): the glowing hand on a dark stage. "light": a blue hologram on a transparent background
   *  (the page supplies a pale stage): normal blending, orbit rings, a fine mesh, navy labels and a bracket for
   *  the hand length. Only the stage modes ("static", "scan") use it; "live" and "overlay" ignore it. */
  theme?: "dark" | "light";
}

const Scene = lazy(() => import("./HandStageGL"));

let webgl: boolean | null = null;

/** True when a WebGL context can be created here (false in jsdom and on some old phones). Asked once: a context
 *  is not something to create on every render. */
export function webglAvailable(): boolean {
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
export function resetWebglCheck(): void {
  webgl = null;
}

/** The scene is a lazily loaded chunk and a GPU program: if either fails the page carries on without it. */
class SceneBoundary extends Component<{ fallback: ReactNode; onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function HandStage(props: HandStageProps) {
  const { className = "", label = "A glowing 3D model of a hand", onDegrade } = props;
  const available = webglAvailable();
  const overlay = props.mode === "overlay";

  // An overlay that cannot run tells the screen once, so it keeps its 2D drawing.
  useEffect(() => {
    if (overlay && !available) onDegrade?.("disabled");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, available]);

  if (overlay) {
    // Decorative and inert: it takes no input and carries no information the 2D drawing and labels lack.
    if (!available) return null;
    return (
      <div className={`hand-stage hand-stage-overlay ${className}`} aria-hidden="true">
        <SceneBoundary fallback={null} onError={() => onDegrade?.("disabled")}>
          <Suspense fallback={null}>
            <Scene {...props} />
          </Suspense>
        </SceneBoundary>
      </div>
    );
  }

  const light = props.theme === "light" && props.mode !== "live";
  const fallback = <div className="hand-stage-fallback" aria-hidden="true" />;
  return (
    <div className={`hand-stage ${light ? "hand-stage--light " : ""}${className}`} role="img" aria-label={label}>
      {available ? (
        <SceneBoundary fallback={fallback} onError={() => undefined}>
          <Suspense fallback={fallback}>
            <Scene {...props} />
          </Suspense>
        </SceneBoundary>
      ) : (
        fallback
      )}
    </div>
  );
}
