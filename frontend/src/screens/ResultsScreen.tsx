import type { Measurement, Recommendation, ScanResponse } from "../api/types";
import { Badge } from "../ui/components";
import { ButtonIcon, stagger } from "../ui/motion";
import { CONFIDENCE, fmtIn, fmtMm, MEASUREMENT_NAMES } from "../ui/format";

interface Props {
  recommendation: Recommendation;
  result: ScanResponse;
  extraMeasurements: Measurement[];
  onRescan: () => void;
  onBack: () => void;
  onStartOver: () => void;
}

export function ResultsScreen({ recommendation: rec, result, extraMeasurements, onRescan, onBack, onStartOver }: Props) {
  const level = rec.confidence_level;
  const product = [rec.manufacturer, rec.product_model].filter(Boolean).join(", ");
  const keyMeasurements = [...result.measurements, ...extraMeasurements].filter(
    (m) => rec.by_measurement.some((b) => b.key === m.key) && m.value_mm !== null,
  );

  return (
    <main className="page stack" style={{ gap: 24 }}>
      <header className="stack" style={{ gap: 8 }}>
        <h1 style={{ fontSize: "clamp(1.8rem, 4vw, 2.4rem)" }}>Your glove size</h1>
      </header>

      {rec.is_demo_chart && (
        <div className="notice notice-demo small" role="note">
          <Badge tone="demo">Demo chart</Badge> {rec.disclaimer}
        </div>
      )}

      <section className="card stack" aria-labelledby="size-heading">
        {rec.size ? (
          <div className="size-hero">
            <div className="size-tile">
              <div className="small" style={{ opacity: 0.75 }} id="size-heading">
                {rec.status === "needs_more_data" ? "Most likely size" : "Recommended size"}
              </div>
              <div className="size">{rec.size}</div>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              {product && <div className="muted">{product}</div>}
              {rec.alternative_size && (
                <p>
                  <strong>Also consider size {rec.alternative_size}.</strong>{" "}
                  <span className="muted">Your measurement is close to the boundary between the two sizes.</span>
                </p>
              )}
              {level && (
                <div className="stack" style={{ gap: 6, maxWidth: 360 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="small">Measurement confidence</span>
                    <strong className="small">{CONFIDENCE[level].label}</strong>
                  </div>
                  <div className={`meter level-${level}`} aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <p className="small muted">{CONFIDENCE[level].text}</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="stack">
            <h2 id="size-heading">More information needed</h2>
            <p>We can't recommend a size for this product from the scan alone.</p>
          </div>
        )}
        <ul className="bullets">
          {rec.explanation.map((e, i) => (
            <li key={i} className="stagger-in" style={stagger(i + 6)}>
              {e}
            </li>
          ))}
        </ul>
        {result.uncertainty_basis === "prior_assumptions" && (
          <p className="small muted">
            The confidence shown reflects estimated measurement uncertainty only. It is not yet based on validated
            accuracy data, and it is not the probability that a glove will fit.
          </p>
        )}
      </section>

      <div className="grid-2">
        <section className="card" data-reveal>
          <h2>Measurements used</h2>
          {keyMeasurements.length ? (
            <dl className="kv">
              {keyMeasurements.map((m) => (
                <KeyRow key={m.key} m={m} />
              ))}
            </dl>
          ) : (
            <p className="muted">{rec.needed_measurements.map((k) => MEASUREMENT_NAMES[k] ?? k).join(", ")} required.</p>
          )}
        </section>
        <section className="card" data-reveal style={stagger(1)}>
          <h2>Limitations</h2>
          <ul className="bullets small muted">
            {result.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      </div>

      <div className="row">
        <button className="btn btn-primary btn-lg btn-island" onClick={onRescan}>
          Rescan
          <ButtonIcon />
        </button>
        <button className="btn" onClick={onBack}>
          Back to measurements
        </button>
        <button className="btn btn-ghost" onClick={onStartOver}>
          Start over
        </button>
      </div>
    </main>
  );
}

function KeyRow({ m }: { m: Measurement }) {
  return (
    <>
      <dt>{m.label}</dt>
      <dd>
        {fmtMm(m.value_mm!)} ({fmtIn(m.value_mm!)}){m.uncertainty_mm !== null ? ` ±${m.uncertainty_mm.toFixed(1)} mm` : ""}
        {m.status === "user_entered" ? " · entered by you" : " · camera estimate"}
      </dd>
    </>
  );
}
