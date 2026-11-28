// Whether the hand is lined up for the shot, worked out about ten times a second from the tracked hand (see alignment.ts).
// The result drives the fixed corner arrows on the screen, the four arrows on the scan frame around the hand (ParticleField),
// the phone-tilt indicator and the hint under the camera. Feedback only: it changes no threshold, rejects no frame and feeds
// no measurement.
import { type MutableRefObject, type RefObject, useEffect, useRef, useState } from "react";
import type { Landmark } from "../hand3d/handModel";
import type { Point } from "../api/types";
import type { PhaseId } from "./coverage";
import { type AlignResult, type PhoneTilt, NO_HAND, evaluateAlignment, handBoxInView, isLevel, phoneTilt, sameAlignment, tiltDeg } from "./alignment";
import type { Box } from "./swarm";

const STEP_MS = 100;
const HAND_GONE_MS = 450;

interface Options {
  poseRef: MutableRefObject<readonly Landmark[] | null>;
  frameRef: MutableRefObject<{ width: number; height: number } | null>;
  /** MediaPipe's world landmarks of the tracked hand, for the tilt of the palm against the phone. */
  worldRef: MutableRefObject<Point[] | null>;
  /** The element the picture fills (its size is the view the box and the hand are measured in). */
  viewRef: RefObject<HTMLElement | null>;
  mirror: boolean;
  phase: PhaseId;
}

export interface Alignment {
  align: AlignResult;
  /** The view's size in pixels (0 until it is measured). */
  view: { w: number; h: number };
  /** The smoothed tilt of the palm against the phone, read by the tilt indicator without re-rendering; null when unknown. */
  tiltRef: MutableRefObject<PhoneTilt | null>;
}

export function useAlignment({ poseRef, frameRef, worldRef, viewRef, mirror, phase }: Options): Alignment {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [result, setResult] = useState<AlignResult>(NO_HAND);
  const tiltRef = useRef<PhoneTilt | null>(null);
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
        const t = phoneTilt(worldRef.current, mir);
        const old = tiltRef.current;
        tiltRef.current = t && old ? { rollDeg: old.rollDeg + (t.rollDeg - old.rollDeg) * 0.4, pitchDeg: old.pitchDeg + (t.pitchDeg - old.pitchDeg) * 0.4, totalDeg: old.totalDeg + (t.totalDeg - old.totalDeg) * 0.4 } : t;
        // the phone should be parallel to the palm in the palm and back views; in the side view the hand is turned on its edge
        const level = ph === "side" || isLevel(tiltRef.current, prev?.level ?? true);
        const pos = evaluateAlignment({ hand: smooth, tilt: tiltDeg(pose, fr, view, mir), view, phase: ph, wasAligned: prev?.aligned ?? false });
        // lined up in place but the phone is tilted: say so, and keep the corners as they are
        next = pos.aligned && !level ? { ...pos, hint: "level", level } : { ...pos, level };
      } else {
        if (now - lastSeen > HAND_GONE_MS) {
          smooth = null;
          tiltRef.current = null;
        }
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
  }, [size.w, size.h, poseRef, frameRef, worldRef]);

  return { align: result, view: size, tiltRef };
}
