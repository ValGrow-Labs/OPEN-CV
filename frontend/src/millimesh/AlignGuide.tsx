// The alignment guide drawn over the camera: a solid box with a boxed arrow at each corner. A corner lights green when the
// hand's corner reaches it; all four green means the hand is lined up. Feedback only: it reads the tracked hand, changes
// no threshold and rejects no frame (see alignment.ts).
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import type { Landmark } from "../hand3d/handModel";
import type { PhaseId } from "./coverage";
import { type AlignResult, type Corner, CORNERS, NO_HAND, evaluateAlignment, guideBox, handBoxInView, sameAlignment, tiltDeg } from "./alignment";
import type { Box } from "./swarm";

interface Props {
  poseRef: MutableRefObject<readonly Landmark[] | null>;
  frameRef: MutableRefObject<{ width: number; height: number } | null>;
  mirror: boolean;
  phase: PhaseId;
  /** Said whenever the verdict changes (a corner lit or unlit, lined up or not, a new hint). */
  onChange?: (r: AlignResult) => void;
}

/** The arrow points out of the box, towards the corner the hand should reach. */
const ROTATE: Record<Corner, number> = { tr: 0, br: 90, bl: 180, tl: 270 };
const TAG = 30;
const STEP_MS = 100;
const HAND_GONE_MS = 450;

export function AlignGuide({ poseRef, frameRef, mirror, phase, onChange }: Props) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [result, setResult] = useState<AlignResult>(NO_HAND);
  const latest = useRef({ mirror, phase, onChange });
  latest.current = { mirror, phase, onChange };

  useEffect(() => {
    const el = ref.current;
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
  }, []);

  useEffect(() => {
    if (size.w <= 0 || size.h <= 0) return;
    let smooth: Box | null = null;
    let lastSeen = 0;
    let prev: AlignResult | null = null;
    const step = () => {
      const { mirror: mir, phase: ph, onChange: cb } = latest.current;
      const pose = poseRef.current;
      const fr = frameRef.current;
      const now = performance.now();
      let next: AlignResult;
      const view = { width: size.w, height: size.h };
      const raw = pose && fr ? handBoxInView(pose, fr, view, mir) : null;
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
        cb?.(next);
      }
    };
    step();
    const id = window.setInterval(step, STEP_MS);
    return () => window.clearInterval(id);
  }, [size.w, size.h, poseRef, frameRef]);

  const t = size.w > 0 ? guideBox(size.w, size.h) : null;
  const corner = (c: Corner) => (c === "tl" ? { x: t!.x0, y: t!.y0 } : c === "tr" ? { x: t!.x1, y: t!.y0 } : c === "bl" ? { x: t!.x0, y: t!.y1 } : { x: t!.x1, y: t!.y1 });

  return (
    <svg
      ref={ref}
      className={`mm-align ${result.aligned ? "is-aligned" : ""}`}
      viewBox={size.w > 0 ? `0 0 ${size.w} ${size.h}` : undefined}
      aria-hidden="true"
      data-aligned={result.aligned ? "true" : "false"}
      data-corners={CORNERS.filter((c) => result.corners[c]).join(" ")}
    >
      {t && (
        <>
          <rect className="mm-align-under" x={t.x0} y={t.y0} width={t.x1 - t.x0} height={t.y1 - t.y0} rx={14} />
          <rect className="mm-align-box" x={t.x0} y={t.y0} width={t.x1 - t.x0} height={t.y1 - t.y0} rx={14} />
          {CORNERS.map((c) => {
            const p = corner(c);
            return (
              <g key={c} className={`mm-align-tag ${result.corners[c] ? "is-on" : ""}`} transform={`translate(${p.x} ${p.y})`} data-corner={c}>
                <rect x={-TAG / 2} y={-TAG / 2} width={TAG} height={TAG} rx={8} />
                <path d="M-5 5 L5 -5 M-4.5 -5 H5 V4.5" transform={`rotate(${ROTATE[c]})`} />
              </g>
            );
          })}
        </>
      )}
    </svg>
  );
}
