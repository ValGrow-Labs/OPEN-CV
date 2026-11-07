// A compact panel: the current hand pose in words, and the five fingers with their bend. Display only; no decoration.
import { useEffect, useRef, useState } from "react";
import { ANNOUNCE_MIN_INTERVAL_MS, FINGER_TITLE } from "./constants";
import "./handPosePanel.css";
import type { FingerState, HandPoseReading } from "./types";

const STATE_WORD: Record<FingerState, string> = { extended: "extended", half_bent: "half bent", bent: "bent" };

/** Bend that fills a finger's bar (a finger's total flexion tops out near 270; the thumb's near 100). */
const BAR_FULL_DEG = { finger: 270, thumb: 100 };

/** The pose text (also the aria-live line): follows the pose, but changes at most about four times a second. */
function useThrottledText(text: string): string {
  const [shown, setShown] = useState(text);
  const last = useRef(Date.now()); // the text shown at the start counts as a change
  useEffect(() => {
    if (text === shown) return;
    const wait = Math.max(0, last.current + ANNOUNCE_MIN_INTERVAL_MS - Date.now());
    const id = setTimeout(() => {
      last.current = Date.now();
      setShown(text);
    }, wait);
    return () => clearTimeout(id);
  }, [text, shown]);
  return shown;
}

export function HandPosePanel({ reading, className = "" }: { reading: HandPoseReading | null; className?: string }) {
  const clear = !!reading && reading.label !== "unknown";
  const poseText = !reading ? "Show your hand" : reading.text;
  const shown = useThrottledText(poseText);

  return (
    <section className={`hpp ${className}`} aria-label="Hand pose">
      <p className="hpp-pose" aria-live="polite">
        {shown}
      </p>
      {clear && (
        <ul className="hpp-fingers">
          {reading!.fingers.map((f) => {
            const full = f.name === "thumb" ? BAR_FULL_DEG.thumb : BAR_FULL_DEG.finger;
            const pct = Math.round(Math.max(0, Math.min(1, f.bendDeg / full)) * 100);
            return (
              <li key={f.name} className={`hpp-finger is-${f.state}`}>
                <span className="hpp-name">{FINGER_TITLE[f.name]}</span>
                <span className="hpp-bar" role="img" aria-label={`${FINGER_TITLE[f.name]} bend ${pct} percent`}>
                  <span style={{ width: `${pct}%` }} />
                </span>
                <span className="hpp-state">{STATE_WORD[f.state]}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
