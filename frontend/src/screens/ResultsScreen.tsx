import type { Measurement, Recommendation, ScanResponse } from "../api/types";
import { Badge } from "../ui/components";
import { CONFIDENCE } from "../ui/format";
import { MeasureList, type MeasureItem } from "../ui/measureList";
import { ButtonIcon, stagger } from "../ui/motion";

interface Props {
  recommendation: Recommendation;
  result: ScanResponse;
  extraMeasurements: Measurement[];
  onRescan: () => void;
  onBack: () => void;
  onStartOver: () => void;
}

const HAND_KEYS: Omit<MeasureItem, "m">[] = [
  { key: "hand_length_mm", label: "Hand length", note: "Wrist crease to middle fingertip. Used for sizing" },
  { key: "palm_length_mm", label: "Palm length", note: "Wrist crease to middle knuckle" },
  { key: "mcp_span_mm", label: "Palm width", note: "Index to little knuckle joint centres" },
  { key: "palm_breadth_mm", label: "Palm breadth", note: "Skin edge to skin edge across the knuckles" },
  { key: "hand_circumference_mm", label: "Hand circumference", note: "Around the knuckles, soft tape measure" },
];

const FINGER_KEYS: Omit<MeasureItem, "m">[] = [
  { key: "thumb_length_mm", label: "Thumb" },
  { key: "index_length_mm", label: "Index finger" },
  { key: "middle_length_mm", label: "Middle finger" },
  { key: "ring_length_mm", label: "Ring finger" },
  { key: "little_length_mm", label: "Little finger" },
];

const SPLNTD_CIRCUMFERENCES = [
  { finger: "Thumb", base: "75 mm", tip: "65 mm" },
  { finger: "Index", base: "70 mm", tip: "55 mm" },
  { finger: "Middle", base: "75 mm", tip: "55 mm" },
  { finger: "Ring", base: "70 mm", tip: "50 mm" },
  { finger: "Pinky", base: "65 mm", tip: "45 mm" },
];

export function ResultsScreen({ recommendation: rec, result, extraMeasurements, onRescan, onBack, onStartOver }: Props) {
  const level = rec.confidence_level;
  // With no single size supported, say which size the camera reading itself falls in: a fact about
  // the reading, not a recommendation (the uncertainty still covers the sizes listed).
  const closest = rec.size === null ? rec.closest_size ?? null : null;
  const alsoPossible = rec.plausible_sizes.filter((s) => s !== closest);
  const product = [rec.manufacturer, rec.product_model].filter(Boolean).join(", ");
  const byKey = new Map<string, Measurement>();
  for (const m of [...result.measurements, ...extraMeasurements]) byKey.set(m.key, m);
  const items = (defs: Omit<MeasureItem, "m">[]) => defs.map((d) => ({ ...d, m: byKey.get(d.key) }));

  return (
    <main className="page stack stack-lg">
      <header className="page-head">
        <span className="eyebrow">Your size</span>
        <h1 className="page-title">Your glove size results</h1>
        <p className="lead">Based on {result.frames_accepted} camera frames that passed every quality check.</p>
      </header>

      {rec.is_demo_chart && (
        <div className="notice notice-demo small" role="note">
          <Badge tone="demo">Demo chart</Badge> {rec.disclaimer}
        </div>
      )}

      <section className="card stack result-hero" aria-labelledby="size-heading">
        {rec.size ? (
          <div className="size-hero">
            <div className="size-tile">
              <div className="size-caption" id="size-heading">
                {rec.status === "needs_more_data" ? "Most likely size" : "Recommended size"}
              </div>
              <div className="size">{rec.size}</div>
            </div>
            <div className="stack size-facts">
              {product && <div className="muted">{product}</div>}
              {rec.alternative_size && (
                <p>
                  <strong>Also consider size {rec.alternative_size}.</strong>{" "}
                  <span className="muted">Your measurement is close to the boundary between the two sizes.</span>
                </p>
              )}
              {level && (
                <div className="confidence">
                  <div className="confidence-head">
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
          <div className={closest ? "size-hero" : "stack"}>
            {closest && (
              <div className="size-plate" aria-labelledby="plate-caption">
                <div className="size-caption" id="plate-caption">
                  Most likely size
                </div>
                <div className="size">{closest}</div>
                {rec.closest_alternative && <div className="size-plate-or">or {rec.closest_alternative}</div>}
              </div>
            )}
            <div className="stack size-facts">
              <h2 id="size-heading">More information needed</h2>
              <p>
                A reliable glove size recommendation cannot yet be determined from the available camera data.
                {closest && (
                  <>
                    {" "}
                    Your camera reading falls in size <strong>{closest}</strong>
                    {alsoPossible.length > 0 && <>, but could also be {alsoPossible.join(", ")}</>}. A tape measurement would settle it.
                  </>
                )}
              </p>
              {rec.plausible_sizes.length > 0 && (
                <div className="row" aria-label="Sizes that are still possible">
                  <span className="small muted">Plausible sizes:</span>
                  {rec.plausible_sizes.map((s) => (
                    <Badge key={s} tone={s === closest ? "good" : "neutral"}>
                      {s}
                      {s === closest && <span className="visually-hidden"> (closest to your reading)</span>}
                    </Badge>
                  ))}
                </div>
              )}
              <div>
                <button className="btn btn-primary" onClick={onBack}>
                  Add a tape measurement
                </button>
              </div>
            </div>
          </div>
        )}

        <ul className="bullets why">
          {rec.explanation.map((e, i) => (
            <li key={i} className="stagger-in" style={stagger(i + 2)}>
              {e}
            </li>
          ))}
        </ul>

        {result.uncertainty_basis !== "validated" && (
          <p className="small muted fine">
            The confidence shown reflects estimated measurement uncertainty only. It is not yet based on validated
            accuracy data, and it is not the probability that a glove will fit.
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="measures-heading" data-reveal>
        <div className="section-head">
          <h2 id="measures-heading">Your measurements</h2>
          <p className="small muted">Straight-line distances, scaled by the coin.</p>
        </div>
        <div className="mgroups">
          <div className="mgroup">
            <h3>Hand and palm</h3>
            <MeasureList items={items(HAND_KEYS)} />
          </div>
          <div className="mgroup">
            <h3>Fingers, knuckle to tip</h3>
            <MeasureList items={items(FINGER_KEYS)} />
          </div>
        </div>
      </section>

      <div className="panels">
        <details className="panel">
          <summary>
            <span>
              Finger circumferences
              <span className="panel-sub">Not measured by the camera</span>
            </span>
          </summary>
          <div className="panel-body">
            <p className="small muted">
              A single 2D camera view cannot measure 3D circumferences without an established, validated 3D method.
              Circumferences require a flexible tape measure. Below are the reference benchmark specifications for
              context:
            </p>
            <table className="measure-table">
              <thead>
                <tr>
                  <th scope="col">Finger</th>
                  <th scope="col">Your hand</th>
                  <th scope="col">SPLNTD benchmark base</th>
                  <th scope="col">SPLNTD benchmark tip</th>
                </tr>
              </thead>
              <tbody>
                {SPLNTD_CIRCUMFERENCES.map((c) => (
                  <tr key={c.finger}>
                    <td>{c.finger}</td>
                    <td className="muted">Not measured</td>
                    <td className="num">{c.base}</td>
                    <td className="num">{c.tip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              SPLNTD benchmarks are standard product specifications, not your measurements. Your circumferences are
              never filled in from these values.
            </p>
          </div>
        </details>

        <details className="panel">
          <summary>
            <span>
              Scan evidence
              <span className="panel-sub">
                {result.frames_accepted} of {result.frames_received} frames passed all checks
              </span>
            </span>
          </summary>
          <div className="panel-body">
            <dl className="kv">
              <dt>Frames used</dt>
              <dd>
                {result.frames_accepted} of {result.frames_received}
              </dd>
              {result.calibration && (
                <>
                  <dt>Scale reference</dt>
                  <dd>
                    {result.calibration.reference_label} ({result.calibration.reference_diameter_mm.toFixed(2)} mm)
                  </dd>
                  <dt>Camera scale</dt>
                  <dd>
                    {result.calibration.px_per_mm.toFixed(2)} px/mm (±
                    {(result.calibration.px_per_mm_rel_uncertainty * 100).toFixed(1)}%)
                  </dd>
                  <dt>Palm tilt</dt>
                  <dd>
                    {result.calibration.coin_tilt_deg.toFixed(1)}°{result.calibration.tilt_corrected ? " (corrected)" : ""}
                  </dd>
                  <dt>Camera distance</dt>
                  <dd>
                    {result.calibration.estimated_camera_distance_mm[0]} to {result.calibration.estimated_camera_distance_mm[1]} mm
                  </dd>
                </>
              )}
            </dl>
          </div>
        </details>

        <details className="panel">
          <summary>
            <span>
              Limitations and fit notice
              <span className="panel-sub">A camera estimate cannot guarantee fit</span>
            </span>
          </summary>
          <div className="panel-body">
            <ul className="bullets small muted">
              {result.limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </div>
        </details>
      </div>

      <div className="actions">
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
