// Step 7, "3D Reconstruction": the fitted hand (an estimate), its three capture markers and the Solid / Wireframe / Point
// Cloud control. Honest about what it is: fitted to the three views and scaled by the coin, not a measured scan, and the
// markers show where each view looked from, not measured points.
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { webglAvailable } from "../hand3d/HandStage";
import { BONES } from "../hand3d/handModel";
import { ArrowRight, Wordmark } from "./Brand";
import type { PhaseId } from "./coverage";
import { ESTIMATE_LABEL, type FittedHand } from "./fitHand";
import type { ReconMode } from "./ReconScene";

const Scene = lazy(() => import("./ReconScene"));

const MODES: { id: ReconMode; label: string }[] = [
  { id: "solid", label: "Solid" },
  { id: "wireframe", label: "Wireframe" },
  { id: "points", label: "Point Cloud" },
];

const LEGEND: { id: PhaseId; label: string }[] = [
  { id: "palm", label: "Palm Capture" },
  { id: "side", label: "Side Capture" },
  { id: "back", label: "Back Capture" },
];

/** A flat drawing of the same fitted pose, for a browser without WebGL (and while the 3D chunk loads). */
export function FlatHand({ fit, mode }: { fit: FittedHand; mode: ReconMode }) {
  const p = fit.pose;
  const X = (i: number) => 50 + p[i].x * 62;
  const Y = (i: number) => 92 - p[i].y * 80;
  const palm = [0, 1, 2, 5, 9, 13, 17].map((i) => `${X(i)},${Y(i)}`).join(" ");
  return (
    <svg className="mm-flat" viewBox="0 0 100 100" role="img" aria-label="A flat drawing of the estimated hand">
      {mode === "solid" && <polygon points={palm} fill="rgba(60,120,255,0.55)" stroke="rgba(150,200,255,0.8)" strokeWidth="0.6" />}
      {BONES.map(([a, b], i) => (
        <line key={i} x1={X(a)} y1={Y(a)} x2={X(b)} y2={Y(b)} stroke="#74bcff" strokeLinecap="round" strokeWidth={mode === "solid" ? 4.6 : mode === "wireframe" ? 0.7 : 0.4} strokeOpacity={mode === "points" ? 0.35 : 0.9} />
      ))}
      {p.map((_, i) => (
        <circle key={i} cx={X(i)} cy={Y(i)} r={mode === "points" ? 1.3 : 1.7} fill="#d6ecff" />
      ))}
    </svg>
  );
}

export interface ReconStepProps {
  fit: FittedHand;
  onContinue: () => void;
  onRescan: () => void;
  /** Where the Continue button leads, in words ("See my measurements"). */
  continueLabel?: string;
}

export function ReconStep({ fit, onContinue, onRescan, continueLabel = "See my measurements" }: ReconStepProps) {
  const [mode, setMode] = useState<ReconMode>("solid");
  const [resetKey, setResetKey] = useState(0);
  const [gl, setGl] = useState(() => webglAvailable());
  const h1 = useRef<HTMLHeadingElement>(null);
  const onUnavailable = useCallback(() => setGl(false), []);
  useEffect(() => h1.current?.focus({ preventScroll: true }), []);

  const have = new Set(fit.markers.map((m) => m.phase));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = MODES.findIndex((m) => m.id === mode);
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const m = MODES[(next + MODES.length) % MODES.length];
    setMode(m.id);
    (e.currentTarget.querySelector(`[data-mode="${m.id}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <main className="mm-screen mm-recon">
      <header className="mm-top">
        <Wordmark />
      </header>
      <h1 ref={h1} tabIndex={-1} className="mm-h2">
        3D Reconstruction
      </h1>
      <p className="mm-estimate" role="note">
        {ESTIMATE_LABEL}
      </p>

      <div className="mm-recon-stage">
        {gl ? (
          <Suspense fallback={<FlatHand fit={fit} mode={mode} />}>
            <Scene fit={fit} mode={mode} resetKey={resetKey} onUnavailable={onUnavailable} />
          </Suspense>
        ) : (
          <>
            <FlatHand fit={fit} mode={mode} />
            <p className="mm-flat-note small">This browser cannot draw in 3D, so this is a flat drawing of the same fitted hand.</p>
          </>
        )}
        <ul className="mm-legend" aria-label="Where each view was captured from">
          {LEGEND.map((l) => (
            <li key={l.id} className={have.has(l.id) ? "" : "is-missing"}>
              <i className={`mm-dot mm-dot--${l.id}`} aria-hidden="true" />
              {l.label}
              {!have.has(l.id) && <span className="visually-hidden"> (not captured)</span>}
            </li>
          ))}
        </ul>
        {gl && (
          <button className="mm-link mm-reset" onClick={() => setResetKey((k) => k + 1)}>
            Reset view
          </button>
        )}
      </div>

      <div className="mm-seg" role="radiogroup" aria-label="How to draw the model" onKeyDown={onKey}>
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={mode === m.id} data-mode={m.id} tabIndex={mode === m.id ? 0 : -1} className={mode === m.id ? "is-on" : ""} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      <p className="mm-fine">
        Scaled by your coin and fitted to the 21 hand points of your three views. The markers show where each view looked from,
        roughly; views from nearly the same direction get neighbouring markers. They are not measured points.
        {fit.agreementMm !== null && ` The views agree to within about ${Math.max(1, Math.round(fit.agreementMm))} mm.`}
      </p>

      <div className="mm-actions">
        <button className="mm-btn" onClick={onContinue}>
          {continueLabel}
          <ArrowRight />
        </button>
        <button className="mm-btn mm-btn--quiet" onClick={onRescan}>
          Scan again
        </button>
      </div>
    </main>
  );
}
