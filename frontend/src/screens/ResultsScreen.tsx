import type { Measurement, Recommendation, ScanResponse } from "../api/types";
import { Badge } from "../ui/components";
import { ButtonIcon, stagger } from "../ui/motion";
import { CONFIDENCE, fmtIn, fmtMm, REASONS, STATUS } from "../ui/format";

interface Props {
  recommendation: Recommendation;
  result: ScanResponse;
  extraMeasurements: Measurement[];
  onRescan: () => void;
  onBack: () => void;
  onStartOver: () => void;
}

interface FingerDef {
  key: string;
  label: string;
  note: string;
}

const FINGER_KEYS: FingerDef[] = [
  { key: "thumb_length_mm", label: "Thumb length", note: "MCP knuckle to tip" },
  { key: "index_length_mm", label: "Index finger length", note: "MCP knuckle to tip" },
  { key: "middle_length_mm", label: "Middle finger length", note: "MCP knuckle to tip" },
  { key: "ring_length_mm", label: "Ring finger length", note: "MCP knuckle to tip" },
  { key: "little_length_mm", label: "Pinky (Little) finger length", note: "MCP knuckle to tip" },
];

const PALM_KEYS: FingerDef[] = [
  { key: "hand_length_mm", label: "Hand length (wrist crease to middle tip)", note: "Primary sizing measurement" },
  { key: "palm_length_mm", label: "Palm length", note: "Wrist crease to middle MCP knuckle" },
  { key: "mcp_span_mm", label: "Palm width (knuckle joint centres)", note: "Index MCP to little MCP span" },
  { key: "palm_breadth_mm", label: "Palm breadth (skin edge to skin edge)", note: "Anthropometric breadth across knuckles" },
  { key: "hand_circumference_mm", label: "Hand circumference (around knuckles)", note: "Soft tape measure around metacarpal heads" },
];

const SPLNTD_CIRCUMFERENCES = [
  { finger: "Thumb", base: "75 mm", knuckle: "70 mm", tip: "65 mm" },
  { finger: "Index", base: "70 mm", knuckle: "—", tip: "55 mm" },
  { finger: "Middle", base: "75 mm", knuckle: "—", tip: "55 mm" },
  { finger: "Ring", base: "70 mm", knuckle: "—", tip: "50 mm" },
  { finger: "Pinky", base: "65 mm", knuckle: "—", tip: "45 mm" },
];

export function ResultsScreen({ recommendation: rec, result, extraMeasurements, onRescan, onBack, onStartOver }: Props) {
  const level = rec.confidence_level;
  const product = [rec.manufacturer, rec.product_model].filter(Boolean).join(", ");
  const allMeasurements = [...result.measurements, ...extraMeasurements];
  const measMap = new Map<string, Measurement>();
  for (const m of allMeasurements) {
    measMap.set(m.key, m);
  }

  return (
    <main className="page stack" style={{ gap: 24 }}>
      <header className="stack" style={{ gap: 8 }}>
        <span className="eyebrow">Scan Completed</span>
        <h1 style={{ fontSize: "clamp(1.8rem, 4vw, 2.4rem)" }}>Your glove size results</h1>
        <p className="lead">
          Transparent glove sizing and hand dimensions based on {result.frames_accepted} verified camera frames.
        </p>
      </header>

      {rec.is_demo_chart && (
        <div className="notice notice-demo small" role="note">
          <Badge tone="demo">Demo chart</Badge> {rec.disclaimer}
        </div>
      )}

      {/* Hero: Glove Size Recommendation */}
      <section className="card stack" aria-labelledby="size-heading">
        {rec.size ? (
          <div className="size-hero">
            <div className="size-tile">
              <div className="small" style={{ opacity: 0.85 }} id="size-heading">
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
          <div className="stack" style={{ gap: 12 }}>
            <h2 id="size-heading">More information needed</h2>
            <p>A reliable glove size recommendation cannot yet be determined from the available camera data.</p>
            {rec.plausible_sizes.length > 0 && (
              <div className="row" style={{ gap: 8, alignItems: "center" }} aria-label="Sizes that are still possible">
                <span className="small muted">Plausible sizes:</span>
                {rec.plausible_sizes.map((s) => (
                  <Badge key={s} tone="neutral">
                    {s}
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
        )}

        <ul className="bullets" style={{ marginTop: 8 }}>
          {rec.explanation.map((e, i) => (
            <li key={i} className="stagger-in" style={stagger(i + 2)}>
              {e}
            </li>
          ))}
        </ul>

        {result.uncertainty_basis !== "validated" && (
          <p className="small muted">
            The confidence shown reflects estimated measurement uncertainty only. It is not yet based on validated
            accuracy data, and it is not the probability that a glove will fit.
          </p>
        )}
      </section>

      {/* Grid: Measured Finger Lengths & Palm Dimensions */}
      <div className="grid-2">
        {/* Measured Finger Lengths */}
        <section className="card stack" data-reveal>
          <div className="stack" style={{ gap: 4 }}>
            <h2>Finger lengths</h2>
            <p className="small muted">Calibrated straight-line distance from MCP knuckle joint to fingertip.</p>
          </div>
          <table className="measure-table">
            <thead>
              <tr>
                <th scope="col">Finger</th>
                <th scope="col">Length</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {FINGER_KEYS.map((f, i) => {
                const m = measMap.get(f.key);
                return <MeasurementRow key={f.key} def={f} m={m} index={i} />;
              })}
            </tbody>
          </table>
        </section>

        {/* Palm & Hand Dimensions */}
        <section className="card stack" data-reveal style={stagger(1)}>
          <div className="stack" style={{ gap: 4 }}>
            <h2>Palm & hand dimensions</h2>
            <p className="small muted">Key dimensions used for glove sizing charts.</p>
          </div>
          <table className="measure-table">
            <thead>
              <tr>
                <th scope="col">Dimension</th>
                <th scope="col">Measurement</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {PALM_KEYS.map((p, i) => {
                const m = measMap.get(p.key);
                return <MeasurementRow key={p.key} def={p} m={m} index={i} />;
              })}
            </tbody>
          </table>
        </section>
      </div>

      {/* Finger Circumferences & Reference Benchmarks */}
      <section className="card stack" data-reveal style={stagger(2)}>
        <div className="stack" style={{ gap: 4 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <h2>Finger circumferences (3D)</h2>
            <Badge tone="neutral">Not measured by camera</Badge>
          </div>
          <p className="small muted">
            A single 2D camera view cannot measure 3D circumferences without an established, validated 3D method.
            Circumferences require a flexible tape measure. Below are the reference benchmark specifications for context:
          </p>
        </div>

        <table className="measure-table">
          <thead>
            <tr>
              <th scope="col">Finger</th>
              <th scope="col">Live Camera</th>
              <th scope="col">SPLNTD Benchmark Base</th>
              <th scope="col">SPLNTD Benchmark Tip</th>
            </tr>
          </thead>
          <tbody>
            {SPLNTD_CIRCUMFERENCES.map((c, i) => (
              <tr key={c.finger} className="stagger-in" style={stagger(i)}>
                <td>
                  <strong>{c.finger}</strong>
                </td>
                <td>
                  <span className="muted small">Not measured</span>
                </td>
                <td className="num">{c.base}</td>
                <td className="num">{c.tip}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted" style={{ marginTop: 4 }}>
          * SPLNTD benchmarks represent standard product specifications. Live user circumferences are never fabricated from these reference values.
        </p>
      </section>

      {/* Measurement Evidence & Limitations */}
      <div className="grid-2">
        <section className="card stack" data-reveal style={stagger(3)}>
          <h2>Scan evidence</h2>
          <dl className="kv">
            <dt>Frames used</dt>
            <dd>
              <strong>{result.frames_accepted}</strong> of {result.frames_received} frames passed all checks
            </dd>
            {result.calibration && (
              <>
                <dt>Scale reference</dt>
                <dd>
                  {result.calibration.reference_label} ({result.calibration.reference_diameter_mm.toFixed(2)} mm)
                </dd>
                <dt>Camera scale</dt>
                <dd>
                  {result.calibration.px_per_mm.toFixed(2)} px/mm (±{(result.calibration.px_per_mm_rel_uncertainty * 100).toFixed(1)}%)
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
        </section>

        <section className="card stack" data-reveal style={stagger(4)}>
          <h2>Limitations & fit notice</h2>
          <ul className="bullets small muted">
            {result.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      </div>

      {/* Actions */}
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
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

function MeasurementRow({ def, m, index }: { def: FingerDef; m: Measurement | undefined; index: number }) {
  const hasValue = m && m.value_mm !== null && m.status !== "invalid" && m.status !== "not_measured";
  const statusInfo = m ? STATUS[m.status] : STATUS.not_measured;

  return (
    <tr className="stagger-in" style={stagger(index)}>
      <td>
        <div>{m?.label ?? def.label}</div>
        <div className="small muted">{def.note}</div>
        {m && m.reasons && m.reasons.length > 0 && (
          <div className="small" style={{ color: "var(--muted)", marginTop: 2 }}>
            {m.reasons.map((r) => REASONS[r] ?? r).join("; ")}
          </div>
        )}
      </td>
      <td>
        {hasValue ? (
          <div>
            <span className="measure-value" style={{ fontSize: "1.1rem", fontWeight: 700 }}>
              {fmtMm(m.value_mm!)}
            </span>
            <div className="measure-sub num" style={{ fontSize: "0.85rem" }}>
              {fmtIn(m.value_mm!)}
              {m.uncertainty_mm !== null && <span> (±{m.uncertainty_mm.toFixed(1)} mm)</span>}
            </div>
            {/* Where the number came from: the customer's own tape or the camera. */}
            <div className="small muted">{m.status === "user_entered" ? "entered by you" : "camera estimate"}</div>
          </div>
        ) : (
          <span className="muted" style={{ fontStyle: "italic" }}>
            Not measured
          </span>
        )}
      </td>
      <td>
        <Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>
      </td>
    </tr>
  );
}
