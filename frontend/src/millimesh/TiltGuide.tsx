// The phone-tilt indicator: a phone-shaped rectangle with a smaller rectangle inside it (the same glass look as the coin
// ring). The inner rectangle is the palm as the phone sees it: flat and centred when the phone is parallel to the palm,
// leaning and off to a side as the two tilt apart. It turns green when they are parallel. The reading comes from the hand
// tracker's world landmarks (no phone sensors, no permission), is shown only while a hand is tracked, and is guidance only.
import { type MutableRefObject, useEffect, useRef } from "react";
import type { PhoneTilt } from "./alignment";

interface Props {
  tiltRef: MutableRefObject<PhoneTilt | null>;
  /** The phone is parallel enough to the palm. */
  level: boolean;
  /** The palm view and the back view only: the side view has the hand on its edge. */
  enabled: boolean;
}

const MAX_DEG = 50;
const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));

/** The CSS for the inner rectangle: how the palm looks from the phone. A palm whose right side is farther away (negative roll
 *  about the vertical axis) is drawn with its right side receding, one whose top is farther with its top receding. */
export function innerTransform(t: PhoneTilt): string {
  const ry = clamp(-t.rollDeg, MAX_DEG);
  const rx = clamp(t.pitchDeg, MAX_DEG);
  const dx = clamp(-t.rollDeg / MAX_DEG, 1) * 5;
  const dy = clamp(t.pitchDeg / MAX_DEG, 1) * 7;
  return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) perspective(80px) rotateX(${rx.toFixed(1)}deg) rotateY(${ry.toFixed(1)}deg)`;
}

export function TiltGuide({ tiltRef, level, enabled }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      const t = tiltRef.current;
      const root = rootRef.current;
      const inner = innerRef.current;
      if (!root || !inner) return;
      root.dataset.on = t ? "true" : "false";
      if (t) {
        inner.style.transform = innerTransform(t);
        root.dataset.tilt = String(Math.round(t.totalDeg));
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [enabled, tiltRef]);

  if (!enabled) return null;
  return (
    <div ref={rootRef} className={`mm-tilt ${level ? "is-level" : ""}`} data-on="false" aria-hidden="true">
      <span className="mm-tilt-inner" ref={innerRef} />
    </div>
  );
}
