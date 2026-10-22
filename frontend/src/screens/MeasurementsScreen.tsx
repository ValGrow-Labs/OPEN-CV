import { useState } from "react";
import type { ChartSummary, Measurement, PublicConfig, ScanResponse } from "../api/types";
import type { ScanTimingBreakdown } from "../scan/scanController";
import { Badge, HandDiagram } from "../ui/components";
import { ButtonIcon, CountUp, stagger } from "../ui/motion";
import { COMPONENTS, fmtIn, MM_PER_INCH, REASONS, SOURCE, STATUS } from "../ui/format";

interface Props {
  config: PublicConfig;
  chart: ChartSummary;
  result: ScanResponse;
  mirrored: boolean;
  scanTiming?: ScanTimingBreakdown | null;
  onRescan: () => void;
  onContinue: (manual: ManualEntries) => void;
  busy: boolean;
  error: string | null;
}

export function MeasurementsScreen({ config, chart, result, mirrored, scanTiming, onRescan, onContinue, busy, error }: Props) {
  if (result.status === "rejected") return <Rejected result={result} onRescan={onRescan} />;

  // Tape measurements the customer can add: circumference whenever the product needs it (a
  // camera cannot measure it), hand length when the camera estimate cannot single out a size.
  const needed = result.recommendation?.needed_measurements ?? [];
  const manualFields = (["hand_length_mm", "hand_circumference_mm", "palm_breadth_mm"] as const).filter(
    (k) =>
      (k === "hand_circumference_mm" && chart.measurements.includes(k)) ||
      (k === "palm_breadth_mm" && chart.measurements.includes(k)) ||
      (k === "hand_length_mm" && needed.includes(k)),
  );
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

      {result.recommendation?.size && (
        <div
          className="card row"
          style={{
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 16,
            background: "linear-gradient(135deg, rgba(59, 130, 246, 0.08), rgba(249, 115, 22, 0.08))",
            border: "1px solid var(--accent, #ea580c)",
            padding: "16px 20px",
          }}
        >
          <div className="stack" style={{ gap: 4 }}>
            <span className="eyebrow" style={{ color: "var(--accent)" }}>Estimated Glove Size</span>
            <div className="row" style={{ alignItems: "baseline", gap: 12 }}>
              <span style={{ fontSize: "2.4rem", fontWeight: 800, color: "var(--ink)" }}>{result.recommendation.size}</span>
              {result.recommendation.confidence_level && (
                <Badge tone={result.recommendation.confidence_level === "clear" ? "good" : "warn"}>
                  {result.recommendation.confidence_level.toUpperCase()}
                </Badge>
              )}
              {result.recommendation.alternative_size && (
                <span className="small muted">or consider {result.recommendation.alternative_size}</span>
              )}
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => onContinue({})}>
            View Glove Size Details →
          </button>
        </div>
      )}

      {result.uncertainty_basis !== "validated" && (
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
                {scanTiming && (
                  <>
                    <dt>Total elapsed</dt>
                    <dd><strong>{scanTiming.totalSec.toFixed(2)} s</strong></dd>
                  </>
                )}
              </dl>
              {scanTiming && (
                <details className="disclosure" style={{ marginTop: 12 }}>
                  <summary>Scan performance timings</summary>
                  <dl className="kv small" style={{ marginTop: 8 }}>
                    <dt>Camera startup</dt>
                    <dd>{scanTiming.cameraStartupMs.toFixed(0)} ms</dd>
                    <dt>Model loading</dt>
                    <dd>{scanTiming.modelLoadMs.toFixed(0)} ms</dd>
                    <dt>Time to first lock</dt>
                    <dd>{scanTiming.firstLockMs > 0 ? `${scanTiming.firstLockMs.toFixed(0)} ms` : "n/a"}</dd>
                    <dt>Frame collection</dt>
                    <dd>{scanTiming.collectionMs.toFixed(0)} ms ({result.frames_accepted} frames)</dd>
                    <dt>Inference / frame</dt>
                    <dd>Hand: {scanTiming.handMs.toFixed(1)} ms · Coin: {scanTiming.coinMs.toFixed(1)} ms</dd>
                    <dt>Server processing & API</dt>
                    <dd>{scanTiming.apiMs.toFixed(0)} ms</dd>
                    <dt>Total elapsed time</dt>
                    <dd><strong>{scanTiming.totalSec.toFixed(2)} s</strong></dd>
                  </dl>
                </details>
              )}
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
        fields={manualFields}
        plausibleSizes={result.recommendation?.plausible_sizes ?? []}
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

export type ManualEntries = { hand_circumference_mm?: number; hand_length_mm?: number; palm_breadth_mm?: number };

const MANUAL_FIELDS = {
  hand_length_mm: {
    label: "Hand length",
    how: "Measure from the crease where your wrist meets your palm to the tip of your middle finger, with your hand flat.",
    range: [100, 260] as [number, number],
    placeholder: { in: "e.g. 7.3", mm: "e.g. 185" },
  },
  hand_circumference_mm: {
    label: "Hand circumference",
    how: "Wrap a soft tape measure around your palm at the knuckles, excluding the thumb. A camera cannot measure circumference.",
    range: [100, 400] as [number, number],
    placeholder: { in: "e.g. 8.5", mm: "e.g. 216" },
  },
  palm_breadth_mm: {
    label: "Palm breadth (skin edge to skin edge)",
    how: "Measure across your palm from the outer edge of your index knuckle to the outer edge of your little-finger knuckle using a ruler or tape measure.",
    range: [50, 150] as [number, number],
    placeholder: { in: "e.g. 3.3", mm: "e.g. 84" },
  },
};

function ContinuePanel({
  fields,
  plausibleSizes,
  manualSd,
  onRescan,
  onContinue,
  busy,
  error,
}: {
  fields: (keyof typeof MANUAL_FIELDS)[];
  plausibleSizes: string[];
  manualSd: number;
  onRescan: () => void;
  onContinue: (manual: ManualEntries) => void;
  busy: boolean;
  error: string | null;
}) {
  const [unit, setUnit] = useState<"in" | "mm">("in");
  const [text, setText] = useState<Record<string, string>>({});
  const optionalFields = (["palm_breadth_mm", "hand_circumference_mm"] as const).filter((k) => !fields.includes(k));
  const activeFields: (keyof typeof MANUAL_FIELDS)[] = Array.from(new Set([...fields, ...optionalFields]));
  const parsed = Object.fromEntries(
    activeFields.map((k) => {
      const v = parseFloat(text[k] ?? "");
      const mm = Number.isFinite(v) ? (unit === "in" ? v * MM_PER_INCH : v) : NaN;
      const [lo, hi] = MANUAL_FIELDS[k].range;
      return [k, { mm, entered: (text[k] ?? "") !== "", valid: Number.isFinite(mm) && mm >= lo && mm <= hi }];
    }),
  ) as Record<string, { mm: number; entered: boolean; valid: boolean }>;
  const anyInvalid = activeFields.some((k) => parsed[k].entered && !parsed[k].valid);
  const manual: ManualEntries = Object.fromEntries(activeFields.filter((k) => parsed[k].valid).map((k) => [k, parsed[k].mm]));

  return (
    <div className="card stack" data-reveal>
      <div className="stack">
        {fields.length > 0 && (
          <>
            <h2>{fields.includes("hand_length_mm") ? "Add a tape measurement" : "Hand circumference"}</h2>
            {fields.includes("hand_length_mm") && plausibleSizes.length > 1 && (
              <p className="small">
                From the camera alone, sizes {plausibleSizes.join(", ")} are all possible, so we won't pick one for you.
                A ruler or tape measurement gives a reliable size.
              </p>
            )}
          </>
        )}
        <div className="row" style={{ gap: 8 }}>
          <span className="small muted">Units</span>
          <select className="select" value={unit} onChange={(e) => setUnit(e.target.value as "in" | "mm")} aria-label="Unit">
            <option value="in">inches</option>
            <option value="mm">mm</option>
          </select>
        </div>
        {fields.map((k) => {
          const f = MANUAL_FIELDS[k];
          const [lo, hi] = f.range;
          return (
            <div key={k} className="field">
              <label htmlFor={`manual-${k}`}>{f.label}</label>
              <p className="small muted">{f.how}</p>
              <input
                id={`manual-${k}`}
                className="input num"
                inputMode="decimal"
                placeholder={f.placeholder[unit]}
                value={text[k] ?? ""}
                onChange={(e) => setText({ ...text, [k]: e.target.value })}
                aria-invalid={parsed[k].entered && !parsed[k].valid}
                style={{ maxWidth: 180 }}
              />
              {parsed[k].entered && !parsed[k].valid && (
                <p className="small" style={{ color: "var(--bad)" }}>
                  Enter a value between {(lo / MM_PER_INCH).toFixed(1)} and {(hi / MM_PER_INCH).toFixed(1)} in ({lo}-{hi} mm).
                </p>
              )}
            </div>
          );
        })}
        {optionalFields.length > 0 && (
          <details className="disclosure" style={{ marginTop: fields.length > 0 ? 12 : 0, marginBottom: 8 }}>
            <summary>Add optional tape measurements (palm breadth, circumference)</summary>
            <div className="stack" style={{ gap: 12, marginTop: 8 }}>
              {optionalFields.map((k) => {
                const f = MANUAL_FIELDS[k];
                const [lo, hi] = f.range;
                return (
                  <div key={k} className="field">
                    <label htmlFor={`manual-${k}`}>{f.label}</label>
                    <p className="small muted">{f.how}</p>
                    <input
                      id={`manual-${k}`}
                      className="input num"
                      inputMode="decimal"
                      placeholder={f.placeholder[unit]}
                      value={text[k] ?? ""}
                      onChange={(e) => setText({ ...text, [k]: e.target.value })}
                      aria-invalid={parsed[k].entered && !parsed[k].valid}
                      style={{ maxWidth: 180 }}
                    />
                    {parsed[k].entered && !parsed[k].valid && (
                      <p className="small" style={{ color: "var(--bad)" }}>
                        Enter a value between {(lo / MM_PER_INCH).toFixed(1)} and {(hi / MM_PER_INCH).toFixed(1)} in ({lo}-{hi} mm).
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        )}
        <details className="disclosure" style={{ marginTop: 8, marginBottom: 8 }}>
          <summary>SPLNTD benchmark reference specifications</summary>
          <div className="stack small muted" style={{ gap: 6, marginTop: 8 }}>
            <p>
              Reference benchmarks (SPLNTD standard specifications in mm). 3D circumferences require a flexible tape measure:
            </p>
            <ul className="bullets">
              <li><strong>Index:</strong> 75 mm length · 70 mm base circ · 55 mm tip circ</li>
              <li><strong>Middle:</strong> 90 mm length · 75 mm base circ · 55 mm tip circ</li>
              <li><strong>Ring:</strong> 75 mm length · 70 mm base circ · 50 mm tip circ</li>
              <li><strong>Pinky:</strong> 60 mm length · 65 mm base circ · 45 mm tip circ</li>
              <li><strong>Thumb:</strong> 60 mm length · 75 mm base circ · 70 mm knuckle circ · 65 mm tip circ</li>
            </ul>
          </div>
        </details>
        <p className="small muted">Entered values are assumed accurate to about ±{manualSd.toFixed(0)} mm.</p>
      </div>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      <div className="row">
        <button className="btn btn-primary btn-lg btn-island" disabled={busy || anyInvalid} onClick={() => onContinue(manual)}>
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
  const allReceivedPassed = result.frames_received > 0 && result.frames_accepted === result.frames_received;
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
          {unique.map((e) => {
            if (e.code === "insufficient_frames" && allReceivedPassed) {
              return (
                <li key={e.code}>
                  All {result.frames_accepted} captured frames passed quality checks, but a minimum of 8 stable frames is required to calculate accurate measurements. Please hold your hand steady a moment longer while scanning.
                </li>
              );
            }
            return (
              <li key={e.code}>
                {e.message}
                {e.frames_affected ? <span className="muted small"> ({e.frames_affected} frames)</span> : null}
              </li>
            );
          })}
        </ul>
        <p className="small muted">
          {result.frames_accepted} of {result.frames_received} frames passed all checks{allReceivedPassed ? " (minimum 8 required)" : ""}.
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
