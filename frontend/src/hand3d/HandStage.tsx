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
  /** Overlay mode: the name shown with the value ("Index"), so a label in the margin says what it measures. */
  name?: string;
  /** Overlay mode: the column this label prefers on the picture as it is drawn when not mirrored; the layout
   *  swaps it for a mirrored picture and moves a label to the nearer margin when its point is on the far half
   *  of the hand (see layoutLabels in overlayMath.ts). Without it the nearer margin is used. */
  side?: "left" | "right";
  /** Overlay mode: lower is kept first when there is no room for every label. */
  priority?: number;
}

/** Why the camera-view overlay switched itself off (it then draws nothing and the screen goes back to its 2D
 *  drawing): "disabled" (config or an explicit switch-off), "no_webgl" (no usable WebGL here), "context_lost" (the
 *  GPU took the context away), "too_slow" (the layer's OWN cost stayed over budget even at its cheapest visible
 *  level; a page that is merely busy never switches it off, perfGuard.ts) or "error" (the scene could not start). */
export type OverlayDegradeReason = "disabled" | "no_webgl" | "context_lost" | "too_slow" | "error";

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
   *  context was lost, or its own cost was too heavy for this phone), with the reason and, for an error, its text.
   *  It then draws nothing: use the 2D drawing. */
  onDegrade?: (reason: OverlayDegradeReason, detail?: string) => void;
  /** Overlay mode: what the layer may cost before it steps itself down (perfGuard.ts). */
  budget?: Budget;
  /** "dark" (default): the glowing hand on a dark stage. "light": a blue hologram on a transparent background
   *  (the page supplies a pale stage): normal blending, orbit rings, a fine mesh, navy labels and a bracket for
   *  the hand length. Only the stage modes ("static", "scan") use it; "live" and "overlay" ignore it. */
  theme?: "dark" | "light";
  /** Overlay mode only. "glow" (default): the glowing hologram (sampled-point mesh, rings, sweep, rails) that the
   *  result and calculating screens and the older live view use. "clean": ONLY the live 3D landmark skeleton: joints,
   *  finger-coloured tapered bones, a translucent palm and a short wrist stub, with no rings, sparkles, halo, sweep,
   *  mesh, grid or rails. It is a skeleton of the tracked landmarks, not a reconstructed surface; z only shades it. */
  look?: "glow" | "clean";
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
class SceneBoundary extends Component<{ fallback: ReactNode; onError: (err: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    this.props.onError(err);
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
    if (overlay && !available) onDegrade?.("no_webgl");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, available]);

  if (overlay) {
    // Decorative and inert: it takes no input and carries no information the 2D drawing and labels lack.
    if (!available) return null;
    return (
      <div className={`hand-stage hand-stage-overlay ${className}`} aria-hidden="true">
        <SceneBoundary fallback={null} onError={(err) => onDegrade?.("error", err instanceof Error ? err.message : String(err))}>
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
