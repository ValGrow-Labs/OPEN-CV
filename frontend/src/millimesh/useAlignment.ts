// Whether the hand is lined up for the shot, worked out about ten times a second from the tracked hand (see alignment.ts).
// The result drives the four corner arrows of the scan frame around the hand (ParticleField) and the hint under the camera.
// Feedback only: it changes no threshold, rejects no frame and feeds no measurement.
import { type MutableRefObject, type RefObject, useEffect, useRef, useState } from "react";
import type { Landmark } from "../hand3d/handModel";
import type { PhaseId } from "./coverage";
import { type AlignResult, NO_HAND, evaluateAlignment, handBoxInView, sameAlignment, tiltDeg } from "./alignment";
import type { Box } from "./swarm";

const STEP_MS = 100;
const HAND_GONE_MS = 450;

interface Options {
  poseRef: MutableRefObject<readonly Landmark[] | null>;
  frameRef: MutableRefObject<{ width: number; height: number } | null>;
  /** The element the picture fills (its size is the view the box and the hand are measured in). */
  viewRef: RefObject<HTMLElement | null>;
  mirror: boolean;
  phase: PhaseId;
}

export function useAlignment({ poseRef, frameRef, viewRef, mirror, phase }: Options): AlignResult {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [result, setResult] = useState<AlignResult>(NO_HAND);
  const latest = useRef({ mirror, phase });
  latest.current = { mirror, phase };

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [viewRef]);

  useEffect(() => {
    if (size.w <= 0 || size.h <= 0) return;
    const view = { width: size.w, height: size.h };
    let smooth: Box | null = null;
    let lastSeen = 0;
    let prev: AlignResult | null = null;
    const step = () => {
      const { mirror: mir, phase: ph } = latest.current;
      const pose = poseRef.current;
      const fr = frameRef.current;
      const now = performance.now();
      const raw = pose && fr ? handBoxInView(pose, fr, view, mir) : null;
      let next: AlignResult;
      if (raw && pose && fr) {
        lastSeen = now;
        // a little smoothing, so the arrows follow the hand rather than its jitter
        smooth = smooth
          ? { x0: smooth.x0 + (raw.x0 - smooth.x0) * 0.5, y0: smooth.y0 + (raw.y0 - smooth.y0) * 0.5, x1: smooth.x1 + (raw.x1 - smooth.x1) * 0.5, y1: smooth.y1 + (raw.y1 - smooth.y1) * 0.5 }
          : raw;
        next = evaluateAlignment({ hand: smooth, tilt: tiltDeg(pose, fr, view, mir), view, phase: ph, wasAligned: prev?.aligned ?? false });
      } else {
        if (now - lastSeen > HAND_GONE_MS) smooth = null;
        next = smooth ? (prev ?? NO_HAND) : NO_HAND;
      }
      if (!sameAlignment(prev, next)) {
        prev = next;
        setResult(next);
      }
    };
    step();
    const id = window.setInterval(step, STEP_MS);
    return () => window.clearInterval(id);
  }, [size.w, size.h, poseRef, frameRef]);

  return result;
}
