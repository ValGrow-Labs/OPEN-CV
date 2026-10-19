import { useState } from "react";
import type { ChartSummary, Measurement, PublicConfig, ScanResponse } from "../api/types";
import { Badge, HandDiagram } from "../ui/components";
import { ButtonIcon, CountUp, stagger } from "../ui/motion";
import { COMPONENTS, fmtIn, MM_PER_INCH, REASONS, SOURCE, STATUS } from "../ui/format";

interface Props {
  config: PublicConfig;
  chart: ChartSummary;
  result: ScanResponse;
  mirrored: boolean;
  onRescan: () => void;
  onContinue: (manualCircumferenceMm: number | null) => void;
  busy: boolean;
  error: string | null;
}

export function MeasurementsScreen({ config, chart, result, mirrored, onRescan, onContinue, busy, error }: Props) {
  if (result.status === "rejected") return <Rejected result={result} onRescan={onRescan} />;

  const needsCircumference = chart.measurements.includes("hand_circumference_mm");
  const camera = result.measurements.filter((m) => m.source === "camera_landmarks" || m.source === "camera_model_estimate");
  const other = result.measurements.filter((m) => m.source !== "camera_landmarks" && m.source !== "camera_model_estimate");
  const warnings = result.issues.filter((i) => i.severity !== "error");

  return (
    <main className="page stack" style={{ gap: 24 }}>
      <header className="stack" style={{ gap: 8 }}>
        <h1 style={{ fontSize: "clamp(1.8rem, 4vw, 2.4rem)" }}>Your hand measurements</h1>
        <p className="lead">
          These values are <strong>estimated</strong> from camera landmarks and the coin's size. Each shows its
          estimated uncertainty.
        </p>
      </header>

      {result.uncertainty_basis === "prior_assumptions" && (
        <div className="notice notice-info small" role="note">
          Uncertainty values are model-based estimates. This system has not yet been validated against tape-measured
          hands, so treat them as approximate.
        </div>
      )}

      <div className="grid-2">
        <div className="stack">
          <div className="card stack" data-reveal>
            <h2>Detected hand</h2>
            {result.landmarks_px_median && (
              <HandDiagram landmarks={result.landmarks_px_median} coin={result.coin_median} mirrored={mirrored} />
            )}
            <p className="small muted">
              Dots mark the 21 joint positions found by the hand model (joint centres, not skin edges). The blue outline
              is the coin used for scale.
            </p>
          </div>
          {result.calibration && (
            <div className="card" data-reveal style={stagger(1)}>
              <h2>Scale calibration</h2>
              <dl className="kv">
                <dt>Reference</dt>
                <dd>
                  {result.calibration.reference_label} ({result.calibration.reference_diameter_mm.toFixed(2)} mm)
                </dd>
                <dt>Coin in image</dt>
                <dd>{result.calibration.coin_diameter_px.toFixed(1)} px</dd>
                <dt>Scale at hand</dt>
                <dd>
                  {result.calibration.px_per_mm.toFixed(2)} px/mm (±{(result.calibration.px_per_mm_rel_uncertainty * 100).toFixed(1)}%)
                </dd>
                <dt>Palm tilt</dt>
                <dd>
                  {result.calibration.coin_tilt_deg.toFixed(0)}°{result.calibration.tilt_corrected ? " (corrected)" : ""}
                </dd>
                <dt>Camera distance</dt>
                <dd>
                  about {result.calibration.estimated_camera_distance_mm[0]} to {result.calibration.estimated_camera_distance_mm[1]} mm
                </dd>
                <dt>Frames used</dt>
                <dd>
                  {result.frames_accepted} of {result.frames_received}
                </dd>
              </dl>
            </div>
          )}
        </div>

        <div className="stack">
          <div className="card" data-reveal style={stagger(1)}>
            <h2>Camera measurements</h2>
            <MeasurementTable rows={camera} />
          </div>
          <div className="card" data-reveal style={stagger(2)}>
            <h2>Not measurable by camera</h2>
            <MeasurementTable rows={other} />
          </div>
          {Object.keys(result.proportions).length > 0 && (
            <div className="card" data-reveal style={stagger(3)}>
              <h2>Hand proportions</h2>
              <dl className="kv">
                {Object.entries(result.proportions).map(([k, v]) => (
                  <PropRow key={k} name={k} value={v} />
                ))}
              </dl>
              <p className="small muted" style={{ marginTop: 10 }}>
                Ratios of landmark distances. They do not depend on the coin scale.
              </p>
            </div>
          )}
          {warnings.length > 0 && (
            <ul className="bullets small muted">
              {warnings.map((w) => (
                <li key={w.code}>{w.message}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ContinuePanel
        needsCircumference={needsCircumference}
        manualSd={config.manual_measurement_sd_mm}
        onRescan={onRescan}
        onContinue={onContinue}
        busy={busy}
        error={error}
      />
    </main>
  );
}

const PROPORTION_LABELS: Record<string, string> = {
  palm_length_to_hand_length: "Palm length ÷ hand length",
  palm_width_to_palm_length: "Palm width ÷ palm length",
  middle_finger_to_hand_length: "Middle finger ÷ hand length",
  index_to_ring_finger: "Index ÷ ring finger",
};

function PropRow({ name, value }: { name: string; value: number }) {
  return (
    <>
      <dt>{PROPORTION_LABELS[name] ?? name}</dt>
      <dd>{value.toFixed(3)}</dd>
    </>
  );
}

export function MeasurementTable({ rows }: { rows: Measurement[] }) {
  return (
    <table className="measure-table">
      <thead>
        <tr>
          <th scope="col">Measurement</th>
          <th scope="col">Value</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m, i) => (
          <tr key={m.key} className="stagger-in" style={stagger(i)}>
            <td>
              <div>{m.label}</div>
              <details className="disclosure">
                <summary>How it's measured</summary>
                <p className="small muted">{m.definition}</p>
                <p className="small muted">{SOURCE[m.source]}.</p>
                {Object.keys(m.uncertainty_components_mm).length > 0 && (
                  <dl className="kv small" style={{ marginTop: 8 }}>
                    {Object.entries(m.uncertainty_components_mm).map(([k, v]) => (
                      <UncRow key={k} name={k} value={v} />
                    ))}
                  </dl>
                )}
              </details>
            </td>
            <td>
              {m.value_mm !== null ? (
                <>
                  <div className="measure-value">
                    <CountUp value={m.value_mm} suffix=" mm" />
                  </div>
                  <div className="measure-sub num">
                    {fmtIn(m.value_mm)}
                    {m.uncertainty_mm !== null && <div>±{m.uncertainty_mm.toFixed(1)} mm</div>}
                  </div>
                </>
              ) : (
                <span className="muted">n/a</span>
              )}
            </td>
            <td>
              <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>
              {m.reasons.map((r) => (
                <div key={r} className="measure-sub" style={{ marginTop: 4 }}>
                  {REASONS[r] ?? r}
                </div>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UncRow({ name, value }: { name: string; value: number }) {
  return (
    <>
      <dt>{COMPONENTS[name] ?? name}</dt>
      <dd>±{value.toFixed(1)} mm</dd>
    </>
  );
}

function ContinuePanel({
  needsCircumference,
  manualSd,
  onRescan,
  onContinue,
  busy,
  error,
}: {
  needsCircumference: boolean;
  manualSd: number;
  onRescan: () => void;
  onContinue: (c: number | null) => void;
  busy: boolean;
  error: string | null;
}) {
  const [unit, setUnit] = useState<"in" | "mm">("in");
  const [text, setText] = useState("");
  const value = parseFloat(text);
  const mm = Number.isFinite(value) ? (unit === "in" ? value * MM_PER_INCH : value) : NaN;
  const valid = Number.isFinite(mm) && mm >= 100 && mm <= 400;

  return (
    <div className="card stack" data-reveal>
      {needsCircumference && (
        <div className="stack">
          <h2>Hand circumference</h2>
          <p className="small muted">
            Wrap a soft tape measure around your palm at the knuckles, excluding the thumb, and enter the value. A
            camera cannot measure circumference. Entered values are assumed accurate to about ±{manualSd.toFixed(0)} mm.
          </p>
          <div className="input-group">
            <label htmlFor="circ" className="visually-hidden">
              Hand circumference
            </label>
            <input
              id="circ"
              className="input num"
              inputMode="decimal"
              placeholder={unit === "in" ? "e.g. 8.5" : "e.g. 216"}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={text !== "" && !valid}
              style={{ maxWidth: 160 }}
            />
            <select className="select" value={unit} onChange={(e) => setUnit(e.target.value as "in" | "mm")} aria-label="Unit">
              <option value="in">inches</option>
              <option value="mm">mm</option>
            </select>
          </div>
          {text !== "" && !valid && <p className="small" style={{ color: "var(--bad)" }}>Enter a value between 4 and 15.7 in (100-400 mm).</p>}
        </div>
      )}
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      <div className="row">
        <button className="btn btn-primary btn-lg btn-island" disabled={busy || (needsCircumference && text !== "" && !valid)} onClick={() => onContinue(valid ? mm : null)}>
          {busy ? "Calculating…" : "See my size"}
          <ButtonIcon />
        </button>
        <button className="btn" onClick={onRescan}>
          Rescan
        </button>
      </div>
    </div>
  );
}

function Rejected({ result, onRescan }: { result: ScanResponse; onRescan: () => void }) {
  const errors = result.issues.filter((i) => i.severity === "error");
  const unique = errors.filter((e, i) => errors.findIndex((x) => x.message === e.message) === i);
  return (
    <main className="page stack" style={{ gap: 24, maxWidth: 720 }}>
      <header className="stack" style={{ gap: 8 }}>
        <span className="eyebrow">Scan not accepted</span>
        <h1 style={{ fontSize: "clamp(1.8rem, 4vw, 2.4rem)" }}>We couldn't measure your hand reliably</h1>
        <p className="lead">
          To avoid giving you a wrong size, we only accept scans that pass our quality checks. Here's what to adjust:
        </p>
      </header>
      <div className="card stack">
        <ul className="bullets">
          {unique.map((e) => (
            <li key={e.code}>
              {e.message}
              {e.frames_affected ? <span className="muted small"> ({e.frames_affected} frames)</span> : null}
            </li>
          ))}
        </ul>
        <p className="small muted">
          {result.frames_accepted} of {result.frames_received} frames passed all checks.
        </p>
      </div>
      <div className="row">
        <button className="btn btn-primary btn-lg" onClick={onRescan}>
          Scan again
        </button>
      </div>
    </main>
  );
}
