// A dark stage with a glowing particle-and-wireframe 3D hand over a sonar-wave grid. This is the light
// wrapper: it decides whether WebGL can be used, loads the scene lazily (three.js is a separate chunk)
// and shows a static fallback otherwise (no WebGL, tests, reduced motion before it loads).
import { lazy, Suspense, type MutableRefObject } from "react";
import type { Landmark } from "./handModel";
import "./handStage.css";

export interface HandStageTag {
  /** Landmark index the label is attached to (e.g. a fingertip). */
  joint: number;
  label: string;
}

export interface HandStageProps {
  /** "scan": generic hand, slow rotation and a sonar sweep. "static": the hand of ``landmarks``.
   *  "live": follows ``poseRef`` every frame (read without React re-renders). */
  mode: "scan" | "static" | "live";
  landmarks?: readonly Landmark[] | null;
  poseRef?: MutableRefObject<readonly Landmark[] | null>;
  /** The hand is shown mirrored (a front camera). */
  mirror?: boolean;
  tags?: readonly HandStageTag[];
  className?: string;
  /** Accessible description of the picture. */
  label?: string;
}

const Scene = lazy(() => import("./HandStageGL"));

/** True when a WebGL context can be created here (false in jsdom and on some old phones). */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function HandStage(props: HandStageProps) {
  const { className = "", label = "A glowing 3D model of a hand" } = props;
  const fallback = <div className="hand-stage-fallback" aria-hidden="true" />;
  return (
    <div className={`hand-stage ${className}`} role="img" aria-label={label}>
      {webglAvailable() ? (
        <Suspense fallback={fallback}>
          <Scene {...props} />
        </Suspense>
      ) : (
        fallback
      )}
    </div>
  );
}
