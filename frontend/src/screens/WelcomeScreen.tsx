import { CheckCircle, ShieldCheck, Warning } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { PublicConfig, ReferenceSelection } from "../api/types";
import { GUIDE_STEPS, HandScene, type GuideStage } from "../ui/guide";
import { ButtonIcon, prefersReducedMotion, SplitWords, stagger } from "../ui/motion";

interface Props {
  config: PublicConfig;
  chartId: string;
  reference: ReferenceSelection;
  onChartChange: (id: string) => void;
  onReferenceChange: (sel: ReferenceSelection) => void;
  onStart: () => void;
}

const STEP_MS = 3800;

const BASIS_NAMES: Record<string, string> = {
  hand_length_mm: "hand length",
  hand_circumference_mm: "hand circumference",
  palm_breadth_mm: "palm breadth",
};

const sizingBasis = (keys: string[]) => keys.map((k) => BASIS_NAMES[k] ?? k).join(" and ");

export function WelcomeScreen({ config, chartId, reference, onChartChange, onReferenceChange, onStart }: Props) {
  const chart = config.charts.find((c) => c.chart_id === chartId)!;
  const refs = config.reference_objects.objects.filter((o) => o.enabled);
  const [stage, setStage] = useState<GuideStage>(0);
  const [autoplay, setAutoplay] = useState(() => !prefersReducedMotion());

  // The walkthrough plays on its own until the visitor picks a step.
  useEffect(() => {
    if (!autoplay) return;
    const t = setTimeout(() => setStage((s) => ((s + 1) % 3) as GuideStage), STEP_MS);
    return () => clearTimeout(t);
  }, [stage, autoplay]);

  const pick = (i: number) => {
    setAutoplay(false);
    setStage(i as GuideStage);
  };

  return (
    <main className="welcome">
      <section className="hero-split" aria-labelledby="welcome-title">
        <div className="hero-copy">
          <h1 id="welcome-title">
            <SplitWords text="Find your glove size" delay={100} />
          </h1>
          <p className="hero-sub stagger-in" style={stagger(4)}>
            Rest a US quarter flat on your palm. Your camera measures your hand in about a minute.
          </p>
          <div className="hero-actions stagger-in" style={stagger(6)}>
            <button className="btn btn-primary btn-lg btn-island" onClick={onStart}>
              Start Scan
              <ButtonIcon />
            </button>
            <a className="btn btn-quiet btn-lg" href="#how-it-works">
              How it works
            </a>
          </div>
        </div>

        <figure className="hero-preview stagger-in" style={stagger(3)}>
          <div className="preview-frame">
            <HandScene stage={stage} />
          </div>
          <figcaption key={stage} className="preview-caption" aria-live="polite">
            {GUIDE_STEPS[stage].caption}
          </figcaption>
        </figure>
      </section>

      <section id="how-it-works" className="timeline-section" aria-labelledby="how-title">
        <div className="timeline-head">
          <h2 id="how-title">How it works</h2>
          <button className="link small" onClick={() => setAutoplay((a) => !a)} aria-pressed={!autoplay}>
            {autoplay ? "Pause demo" : "Play demo"}
          </button>
        </div>
        <ol className="timeline">
          {GUIDE_STEPS.map((s, i) => {
            const state = i < stage ? "is-past" : i === stage ? "is-active" : "";
            return (
              <li key={s.title}>
                <button className={`tl-step ${state}`} aria-current={stage === i ? "step" : undefined} onClick={() => pick(i)}>
                  <span className="tl-track" aria-hidden="true">
                    <span
                      key={`${stage}-${autoplay}`}
                      className={`tl-fill ${stage === i && autoplay ? "is-timing" : ""}`}
                      style={stage === i && autoplay ? { animationDuration: `${STEP_MS}ms` } : undefined}
                    />
                  </span>
                  <span className="tl-num">{i + 1}</span>
                  <strong>{s.title}</strong>
                  <span className="tl-text">{s.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="info-split">
        <div className="privacy-block" data-reveal>
          <ShieldCheck size={32} weight="regular" className="privacy-icon" aria-hidden="true" />
          <h2>Your video never leaves this device.</h2>
          <p>
            The camera is used only while you scan. To calculate your size, only numbers are sent: the positions of 21
            hand points, the coin's outline and image-quality scores. Nothing is stored.
          </p>
          <p className="muted small">
            Your result is an estimate. A single camera has limits, and a recommended size cannot guarantee fit.
          </p>
        </div>

        <div className="card stack product-panel" data-reveal style={stagger(1)}>
          <h2 id="product-title">Your product</h2>
          <div className="product-options" role="radiogroup" aria-labelledby="product-title">
            {config.charts.map((c) => {
              const selected = c.chart_id === chart.chart_id;
              return (
                <label key={c.chart_id} className={`product-option ${selected ? "is-selected" : ""}`}>
                  <input
                    type="radio"
                    name="chart"
                    className="visually-hidden"
                    value={c.chart_id}
                    checked={selected}
                    onChange={() => onChartChange(c.chart_id)}
                  />
                  <span className="po-text">
                    <strong>{c.product_model ?? c.chart_id}</strong>
                    {c.manufacturer && <span className="po-maker">{c.manufacturer}</span>}
                    <span className="po-basis">Sized by {sizingBasis(c.measurements)}</span>
                  </span>
                  <CheckCircle className="po-check" size={22} weight="fill" aria-hidden="true" />
                </label>
              );
            })}
          </div>
          {chart.measurements.includes("hand_circumference_mm") && (
            <p className="small muted">You'll be asked for a tape measurement of your hand circumference after the scan.</p>
          )}
          {refs.length > 1 && (
            <div className="field">
              <label htmlFor="ref">Coin you are using</label>
              <select
                id="ref"
                className="select"
                value={reference.object_id ?? ""}
                onChange={(e) => onReferenceChange({ object_id: e.target.value })}
              >
                {refs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}, {o.diameter_mm.toFixed(2)} mm
                  </option>
                ))}
              </select>
            </div>
          )}
          {chart.is_demo && (
            <div className="demo-note" role="note">
              <Warning className="demo-note-icon" size={18} weight="regular" aria-hidden="true" />
              <div className="demo-note-body">
                <strong>Demo size chart</strong>
                <span>The size boundaries are placeholders for testing, not a real product chart.</span>
                {chart.disclaimer && (
                  <details>
                    <summary>Details</summary>
                    <p>{chart.disclaimer}</p>
                  </details>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
