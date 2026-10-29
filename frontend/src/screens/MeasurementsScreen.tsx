import { useState } from "react";
import type { ChartSummary, Measurement, PublicConfig, ScanResponse } from "../api/types";
import type { ScanTimingBreakdown } from "../scan/scanController";
import { Badge, HandDiagram } from "../ui/components";
import { fingerBendDetail, MM_PER_INCH } from "../ui/format";
import { MeasureList } from "../ui/measureList";
import { ButtonIcon, stagger } from "../ui/motion";
import { hasViews, ViewsNotice, ViewsTable } from "../ui/viewsBlock";

interface Props {
  config: PublicConfig;
  chart: ChartSummary;
  result: ScanResponse;
  mirrored: boolean;
  scanTiming?: ScanTimingBreakdown | null;
  onRescan: () => void;
  /** Go back to the coin choice (offered when the hand came out the wrong size for the selected coin). */
  onChangeCoin?: () => void;
  onContinue: (manual: ManualEntries) => void;
  busy: boolean;
  error: string | null;
}

export function MeasurementsScreen({ config, chart, result, mirrored, scanTiming, onRescan, onChangeCoin, onContinue, busy, error }: Props) {
  if (result.status === "rejected") {
    // Tape-measure fields for this product: whatever its chart is sized by.
    const tapeFields = (["hand_length_mm", "hand_circumference_mm", "palm_breadth_mm"] as const).filter((k) => chart.measurements.includes(k));
    return (
      <Rejected
        result={result}
        minFrames={config.capture.frames_min_accepted}
        onRescan={onRescan}
        onChangeCoin={onChangeCoin}
        tape={{ fields: tapeFields, ranges: config.manual_entry_range_mm, manualSd: config.manual_measurement_sd_mm, onContinue, busy, error }}
      />
    );
  }

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

  const rec = result.recommendation;
  const asItems = (rows: Measurement[]) =>
    rows.map((m) => ({ key: m.key, label: m.label, m, detail: fingerBendDetail(result.finger_bends, m.key, m.reasons) }));

  return (
    <main className="page stack stack-lg">
      <header className="page-head">
        <span className="eyebrow">Scan complete</span>
        <h1 className="page-title">Your hand measurements</h1>
        <p className="lead">
          These values are <strong>estimated</strong> from camera landmarks and the coin's size. Each shows its
          estimated uncertainty.
        </p>
      </header>

      {rec?.size && (
        <div className="size-banner">
          <div className="size-banner-copy">
            <span className="size-banner-label">Estimated glove size</span>
            <div className="size-banner-line">
              <span className="size-banner-size">{rec.size}</span>
              {rec.confidence_level && (
                <Badge tone={rec.confidence_level === "clear" ? "good" : "warn"}>{rec.confidence_level}</Badge>
              )}
              {rec.alternative_size && <span className="small muted">or consider {rec.alternative_size}</span>}
            </div>
          </div>
          <button className="btn btn-primary btn-island" onClick={() => onContinue({})}>
            See size details
            <ButtonIcon />
          </button>
        </div>
      )}

      {result.uncertainty_basis !== "validated" && (
        <div className="notice notice-info small" role="note">
          Uncertainty values are model-based estimates. This system has not yet been validated against tape-measured
          hands, so treat them as approximate.
        </div>
      )}

      <ViewsNotice result={result} />

      <div className="grid-2">
        <section className="card stack" data-reveal aria-labelledby="hand-heading">
          <h2 id="hand-heading">Detected hand</h2>
          {result.landmarks_px_median && (
            <HandDiagram landmarks={result.landmarks_px_median} coin={result.coin_median} mirrored={mirrored} />
          )}
          <p className="small muted">
            Dots mark the 21 joint positions found by the hand model (joint centres, not skin edges). The blue outline
            is the coin used for scale.
          </p>
        </section>

        <section className="card" data-reveal style={stagger(1)} aria-labelledby="camera-heading">
          <div className="section-head">
            <h2 id="camera-heading">Camera measurements</h2>
            <p className="small muted">Tap "How it's measured" for the definition and uncertainty.</p>
          </div>
          <MeasureList items={asItems(camera)} showHow countUp />
          {warnings.length > 0 && (
            <ul className="bullets small muted warnings">
              {warnings.map((w) => (
                <li key={w.code}>{w.message}</li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ContinuePanel
        fields={manualFields}
        ranges={config.manual_entry_range_mm}
        plausibleSizes={rec?.plausible_sizes ?? []}
        closestSize={rec?.size ? null : rec?.closest_size ?? null}
        manualSd={config.manual_measurement_sd_mm}
        onRescan={onRescan}
        onContinue={onContinue}
        busy={busy}
        error={error}
      />

      <div className="panels">
        {other.length > 0 && (
          <details className="panel">
            <summary>
              <span>
                Not measurable by camera
                <span className="panel-sub">Needs a tape measure</span>
              </span>
            </summary>
            <div className="panel-body">
              <MeasureList items={asItems(other)} showHow />
            </div>
          </details>
        )}
        {hasViews(result) && (
          <details className="panel">
            <summary>
              <span>
                Scan views
                <span className="panel-sub">
                  {(result.views ?? []).filter((v) => v.used).length} of {(result.views ?? []).length} views used
                </span>
              </span>
            </summary>
            <div className="panel-body">
              <ViewsTable result={result} />
            </div>
          </details>
        )}
        {result.calibration && (
          <details className="panel">
            <summary>
              <span>
                Scale calibration
                <span className="panel-sub">
                  {result.calibration.reference_label}, {result.frames_accepted} of {result.frames_received} frames used
                </span>
              </span>
            </summary>
            <div className="panel-body">
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
                    <dd>{scanTiming.totalSec.toFixed(2)} s</dd>
                  </>
                )}
              </dl>
              {scanTiming && (
                <details className="disclosure">
                  <summary>Scan performance timings</summary>
                  <dl className="kv small">
                    <dt>Camera startup</dt>
                    <dd>{scanTiming.cameraStartupMs.toFixed(0)} ms</dd>
                    <dt>Model loading</dt>
                    <dd>{scanTiming.modelLoadMs.toFixed(0)} ms</dd>
                    <dt>Time to first lock</dt>
                    <dd>{scanTiming.firstLockMs > 0 ? `${scanTiming.firstLockMs.toFixed(0)} ms` : "n/a"}</dd>
                    <dt>Frame collection</dt>
                    <dd>
                      {scanTiming.collectionMs.toFixed(0)} ms ({result.frames_accepted} frames)
                    </dd>
                    <dt>Inference / frame</dt>
                    <dd>
                      Hand: {scanTiming.handMs.toFixed(1)} ms · Coin: {scanTiming.coinMs.toFixed(1)} ms
                    </dd>
                    <dt>Server processing & API</dt>
                    <dd>{scanTiming.apiMs.toFixed(0)} ms</dd>
                    <dt>Total elapsed time</dt>
                    <dd>{scanTiming.totalSec.toFixed(2)} s</dd>
                  </dl>
                </details>
              )}
            </div>
          </details>
        )}
        {Object.keys(result.proportions).length > 0 && (
          <details className="panel">
            <summary>
              <span>
                Hand proportions
                <span className="panel-sub">Ratios that do not depend on the coin</span>
              </span>
            </summary>
            <div className="panel-body">
              <dl className="kv">
                {Object.entries(result.proportions).map(([k, v]) => (
                  <PropRow key={k} name={k} value={v} />
                ))}
              </dl>
              <p className="small muted">Ratios of landmark distances. They do not depend on the coin scale.</p>
            </div>
          </details>
        )}
      </div>
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

export type ManualEntries = { hand_circumference_mm?: number; hand_length_mm?: number; palm_breadth_mm?: number };

const MANUAL_FIELDS = {
  hand_length_mm: {
    label: "Hand length",
    how: "Measure from the crease where your wrist meets your palm to the tip of your middle finger, with your hand flat.",
    placeholder: { in: "e.g. 7.3", mm: "e.g. 185" },
  },
  hand_circumference_mm: {
    label: "Hand circumference",
    how: "Wrap a soft tape measure around your palm at the knuckles, excluding the thumb. A camera cannot measure circumference.",
    placeholder: { in: "e.g. 8.5", mm: "e.g. 216" },
  },
  palm_breadth_mm: {
    label: "Palm breadth (skin edge to skin edge)",
    how: "Measure across your palm from the outer edge of your index knuckle to the outer edge of your little-finger knuckle using a ruler or tape measure.",
    placeholder: { in: "e.g. 3.3", mm: "e.g. 84" },
  },
};

function ContinuePanel({
  fields,
  ranges,
  plausibleSizes,
  closestSize,
  manualSd,
  onRescan,
  onContinue,
  busy,
  error,
  heading,
  intro,
  showRescan = true,
}: {
  fields: (keyof typeof MANUAL_FIELDS)[];
  ranges: PublicConfig["manual_entry_range_mm"];
  plausibleSizes: string[];
  closestSize: string | null;
  manualSd: number;
  onRescan: () => void;
  onContinue: (manual: ManualEntries) => void;
  busy: boolean;
  error: string | null;
  /** Replace the usual heading/introduction (used when the camera could not measure the hand). */
  heading?: string;
  intro?: string;
  showRescan?: boolean;
}) {
  const [unit, setUnit] = useState<"in" | "mm">("in");
  const [text, setText] = useState<Record<string, string>>({});
  const optionalFields = (["palm_breadth_mm", "hand_circumference_mm"] as const).filter((k) => !fields.includes(k));
  const activeFields: (keyof typeof MANUAL_FIELDS)[] = Array.from(new Set([...fields, ...optionalFields]));
  const parsed = Object.fromEntries(
    activeFields.map((k) => {
      const v = parseFloat(text[k] ?? "");
      const mm = Number.isFinite(v) ? (unit === "in" ? v * MM_PER_INCH : v) : NaN;
      const [lo, hi] = ranges[k];
      return [k, { mm, entered: (text[k] ?? "") !== "", valid: Number.isFinite(mm) && mm >= lo && mm <= hi }];
    }),
  ) as Record<string, { mm: number; entered: boolean; valid: boolean }>;
  const anyInvalid = activeFields.some((k) => parsed[k].entered && !parsed[k].valid);
  const manual: ManualEntries = Object.fromEntries(activeFields.filter((k) => parsed[k].valid).map((k) => [k, parsed[k].mm]));

  return (
    <section className="card stack continue" data-reveal aria-label="Get your size">
      <div className="stack">
        {fields.length > 0 && (
          <>
            <h2>{heading ?? (fields.includes("hand_length_mm") ? "Add a tape measurement" : "Hand circumference")}</h2>
            {intro && <p className="small">{intro}</p>}
            {fields.includes("hand_length_mm") && plausibleSizes.length > 1 && (
              <p className="small">
                From the camera alone, sizes {plausibleSizes.join(", ")} are all possible, so we won't pick one for you.
                {closestSize && <> Your reading is closest to size {closestSize}.</>} A ruler or tape measurement gives a reliable size.
              </p>
            )}
          </>
        )}
        <div className="row unit-row">
          <span className="small muted">Units</span>
          <select className="select" value={unit} onChange={(e) => setUnit(e.target.value as "in" | "mm")} aria-label="Unit">
            <option value="in">inches</option>
            <option value="mm">mm</option>
          </select>
        </div>
        {fields.map((k) => {
          const f = MANUAL_FIELDS[k];
          const [lo, hi] = ranges[k];
          return (
            <div key={k} className="field">
              <label htmlFor={`manual-${k}`}>{f.label}</label>
              <p className="small muted">{f.how}</p>
              <input
                id={`manual-${k}`}
                className="input input-short num"
                inputMode="decimal"
                placeholder={f.placeholder[unit]}
                value={text[k] ?? ""}
                onChange={(e) => setText({ ...text, [k]: e.target.value })}
                aria-invalid={parsed[k].entered && !parsed[k].valid}
              />
              {parsed[k].entered && !parsed[k].valid && (
                <p className="small field-error">
                  Enter a value between {(lo / MM_PER_INCH).toFixed(1)} and {(hi / MM_PER_INCH).toFixed(1)} in ({lo}-{hi} mm).
                </p>
              )}
            </div>
          );
        })}
        {optionalFields.length > 0 && (
          <details className="disclosure">
            <summary>Add optional tape measurements (palm breadth, circumference)</summary>
            <div className="stack disclosure-body">
              {optionalFields.map((k) => {
                const f = MANUAL_FIELDS[k];
                const [lo, hi] = ranges[k];
                return (
                  <div key={k} className="field">
                    <label htmlFor={`manual-${k}`}>{f.label}</label>
                    <p className="small muted">{f.how}</p>
                    <input
                      id={`manual-${k}`}
                      className="input input-short num"
                      inputMode="decimal"
                      placeholder={f.placeholder[unit]}
                      value={text[k] ?? ""}
                      onChange={(e) => setText({ ...text, [k]: e.target.value })}
                      aria-invalid={parsed[k].entered && !parsed[k].valid}
                          />
                    {parsed[k].entered && !parsed[k].valid && (
                      <p className="small field-error">
                        Enter a value between {(lo / MM_PER_INCH).toFixed(1)} and {(hi / MM_PER_INCH).toFixed(1)} in ({lo}-{hi} mm).
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        )}
        <details className="disclosure">
          <summary>SPLNTD benchmark reference specifications</summary>
          <div className="stack small muted disclosure-body">
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
      <div className="actions">
        <button className="btn btn-primary btn-lg btn-island" disabled={busy || anyInvalid} onClick={() => onContinue(manual)}>
          {busy ? "Calculating…" : "See my size"}
          <ButtonIcon />
        </button>
        {showRescan && (
          <button className="btn" onClick={onRescan}>
            Rescan
          </button>
        )}
      </div>
    </section>
  );
}

interface TapeFallback {
  fields: (keyof typeof MANUAL_FIELDS)[];
  ranges: PublicConfig["manual_entry_range_mm"];
  manualSd: number;
  onContinue: (manual: ManualEntries) => void;
  busy: boolean;
  error: string | null;
}

function Rejected({
  result,
  minFrames,
  onRescan,
  onChangeCoin,
  tape,
}: {
  result: ScanResponse;
  minFrames: number;
  onRescan: () => void;
  onChangeCoin?: () => void;
  tape?: TapeFallback;
}) {
  const errors = result.issues.filter((i) => i.severity === "error");
  const wrongCoin = errors.some((e) => e.code === "implausible_scale");
  // A specific cause comes first, and the generic "not enough frames" line only when nothing explains it.
  const specific = errors.filter((e) => e.code !== "insufficient_frames" || !errors.some((x) => x.code !== "insufficient_frames"));
  const unique = specific.filter((e, i) => specific.findIndex((x) => x.message === e.message) === i);
  const allReceivedPassed = result.frames_received > 0 && result.frames_accepted === result.frames_received;
  return (
    <main className="page page-narrow stack stack-lg">
      <header className="page-head">
        <span className="eyebrow">Scan not accepted</span>
        <h1 className="page-title">We couldn't measure your hand reliably</h1>
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
                  All {result.frames_accepted} captured frames passed quality checks, but a minimum of {minFrames} stable frames is required to calculate accurate measurements. Please hold your hand steady a moment longer while scanning.
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
          {result.frames_accepted} of {result.frames_received} frames passed all checks{allReceivedPassed ? ` (minimum ${minFrames} required)` : ""}.
        </p>
      </div>
      <div className="actions">
        {wrongCoin && onChangeCoin ? (
          <>
            <button className="btn btn-primary btn-lg" onClick={onChangeCoin}>
              Choose my coin again
            </button>
            <button className="btn" onClick={onRescan}>
              Scan again
            </button>
          </>
        ) : (
          <button className="btn btn-primary btn-lg" onClick={onRescan}>
            Scan again
          </button>
        )}
      </div>
      {tape && tape.fields.length > 0 && (
        <ContinuePanel
          fields={tape.fields}
          ranges={tape.ranges}
          plausibleSizes={[]}
          closestSize={null}
          manualSd={tape.manualSd}
          onRescan={onRescan}
          onContinue={tape.onContinue}
          busy={tape.busy}
          error={tape.error}
          heading="Or measure with a tape instead"
          intro="Some hands are hard for a camera to measure: a finger that cannot be straightened, a bandage, a very small or very large hand. You can still get a size by measuring with a ruler or tape."
          showRescan={false}
        />
      )}
    </main>
  );
}
