import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  deleteValidationRecord,
  fetchValidationCsv,
  fetchValidationRecords,
  setOperatorToken,
  submitValidationScan,
} from "../api/client";
import type {
  CaptureConditions,
  DataOrigin,
  DistanceBreakdown,
  ErrorStats,
  LengthUnit,
  PublicConfig,
  ReferenceSelection,
  ScanRequest,
  Trial,
  TrialCondition,
  ValidationRecord,
  ValidationReference,
  ValidationSummary,
} from "../api/types";
import { Badge } from "../ui/components";
import { HAND_LENGTH_RANGE_MM, newParticipantCode, referenceCheck, toMm } from "../ui/pilot";
import { PilotInvites } from "./PilotInvites";
import { ScanScreen } from "./ScanScreen";

interface Props {
  config: PublicConfig;
  chartId: string;
  reference: ReferenceSelection;
  onClose: () => void;
}

const CONDITIONS: { value: TrialCondition; label: string }[] = [
  { value: "standard", label: "Standard (protocol position)" },
  { value: "distance_near", label: "Closer (about 25-30 cm)" },
  { value: "distance_far", label: "Further (about 50-60 cm)" },
  { value: "coin_off_centre", label: "Coin off-centre on the palm" },
  { value: "lighting_changed", label: "Different lighting" },
  { value: "hand_rotated", label: "Hand rotated slightly" },
  { value: "fingers_slightly_bent", label: "Fingers slightly bent" },
];
const CONDITION_LABEL = Object.fromEntries(CONDITIONS.map((c) => [c.value, c.label])) as Record<TrialCondition, string>;
const LIGHTING: CaptureConditions["lighting"][] = ["daylight", "indoor_bright", "indoor_dim", "mixed", "other"];
const TOOLS: ValidationReference["tool"][] = ["ruler", "tape", "calipers", "anthropometer", "other"];
const RELIABILITY_LABEL = { agreed: "agreed", single_reading: "single reading", discrepant: "readings disagree" };

const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : v.toFixed(d));
const signed = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`);

const BLIND_KEY = "glovesize.validationBlind.v1";

function readBlind(): boolean {
  try {
    return window.sessionStorage.getItem(BLIND_KEY) === "1";
  } catch {
    return false;
  }
}

function saveBlind(on: boolean) {
  try {
    window.sessionStorage.setItem(BLIND_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable: the switch simply resets on reload */
  }
}

const parseReadings = (f: { r1: string; r2: string; r3: string }) =>
  [f.r1, f.r2, f.r3].map(num).filter((v): v is number => v !== undefined && Number.isFinite(v));

const EMPTY_PARTICIPANT = {
  participant: "",
  hand: "" as "" | Trial["hand"],
  consent: false,
  r1: "",
  r2: "",
  r3: "",
  palmBreadth: "",
  circumference: "",
  notes: "",
  condition: "standard" as TrialCondition,
};

/**
 * Developer-only validation and pilot data collection: real camera scans compared with physical
 * ruler/tape readings taken by docs/PILOT_PROTOCOL.md. The server converts units, decides whether
 * the readings agree, runs the measurement pipeline and computes every error and statistic;
 * nothing on this screen can enter or edit a camera estimate.
 */
export function ValidationScreen({ config, chartId, reference, onClose }: Props) {
  const [records, setRecords] = useState<ValidationRecord[]>([]);
  const [summary, setSummary] = useState<ValidationSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [last, setLast] = useState<ValidationRecord | null>(null);
  // Blinded session (comparison study): the scan operator must not see estimates or errors, so
  // retakes can only follow the app's own rejections (docs/COMPARISON_STUDY_PROTOCOL.md).
  const [blind, setBlind] = useState(readBlind);
  const [token, setToken] = useState("");
  const [form, setForm] = useState({
    ...EMPTY_PARTICIPANT,
    origin: "" as "" | DataOrigin,
    unit: "mm" as LengthUnit,
    tool: "calipers" as ValidationReference["tool"],
    measuredBy: "operator" as ValidationReference["measured_by"],
    operatorCode: "",
    device: "",
    lighting: "indoor_bright" as CaptureConditions["lighting"],
    distance: "",
  });
  const needsToken = config.operator_access === "token";

  const reload = useCallback(() => {
    fetchValidationRecords()
      .then((d) => {
        setRecords(d.records);
        setSummary(d.summary);
        setLoadError(null);
      })
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : "Could not load validation records."));
  }, []);

  useEffect(() => {
    if (config.validation_mode_enabled && !needsToken) reload();
  }, [config.validation_mode_enabled, needsToken, reload]);

  const readings = parseReadings(form);
  const readingsMm = readings.map((v) => toMm(v, form.unit));
  const inRange = readingsMm.every((v) => v >= HAND_LENGTH_RANGE_MM[0] && v <= HAND_LENGTH_RANGE_MM[1]);
  const check = referenceCheck(readingsMm, config.validation_reference_tolerance_mm);
  const real = form.origin === "real_participant";
  const participantOk = /^[A-Za-z0-9_-]{6,40}$/.test(form.participant);
  const blockers = [
    !form.origin && "choose the record type",
    !participantOk && "a participant code",
    !form.hand && "which hand is scanned",
    real && !form.consent && "the participant's consent",
    readings.length === 0 && "the hand-length readings",
    readings.length > 0 && !inRange && "readings in a plausible range (check the unit)",
    real && check && check.reliability !== "agreed" && "agreeing repeated readings",
    !form.device.trim() && "the device",
  ].filter(Boolean) as string[];

  const submit = useCallback(
    async (scan: ScanRequest) => {
      const optionalReading = (v: string) => (num(v) !== undefined ? { value: num(v)!, unit: form.unit } : undefined);
      setSubmitError(null);
      try {
        const res = await submitValidationScan({
          data_origin: form.origin as DataOrigin,
          consent_confirmed: form.consent,
          participant_code: form.participant,
          reference: {
            protocol: "HL-1",
            hand_length: parseReadings(form).map((value) => ({ value, unit: form.unit })),
            palm_breadth: optionalReading(form.palmBreadth),
            hand_circumference: optionalReading(form.circumference),
            tool: form.tool,
            measured_by: form.measuredBy,
            operator_code: form.operatorCode.trim() || undefined,
          },
          trial: { hand: form.hand as Trial["hand"], condition: form.condition },
          conditions: {
            device: form.device.trim(),
            lighting: form.lighting,
            distance_cm: num(form.distance),
            notes: form.notes.trim() || undefined,
          },
          scan,
        });
        setLast(res.record);
        return res.scan;
      } catch (e) {
        setSubmitError(e instanceof ApiError ? e.message : "Could not record the test.");
        throw e;
      }
    },
    [form],
  );

  const downloadCsv = async () => {
    try {
      const text = await fetchValidationCsv();
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: "validation_records.csv" });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : "CSV export failed.");
    }
  };

  if (!config.validation_mode_enabled) {
    return (
      <main className="page stack" style={{ maxWidth: 640 }}>
        <h1 style={{ fontSize: "1.8rem" }}>Validation mode is off</h1>
        <p className="muted">
          Start the server with <code>GLOVESIZE_VALIDATION_ENABLED=true</code> on this computer to record validation tests.
        </p>
        <div>
          <button className="btn" onClick={onClose}>
            Back
          </button>
        </div>
      </main>
    );
  }

  if (scanning) {
    return (
      <ScanScreen
        config={config}
        chartId={chartId}
        reference={reference}
        showIntro={false}
        submit={submit}
        onCancel={() => setScanning(false)}
        onResult={() => {
          setScanning(false);
          reload();
        }}
      />
    );
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <main className="page stack" style={{ gap: 24 }}>
      <header className="row" style={{ justifyContent: "space-between" }}>
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">Developer · pilot study</span>
          <h1 style={{ fontSize: "clamp(1.6rem, 4vw, 2.2rem)" }}>Measurement validation</h1>
        </div>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </header>

      <label className="radio-row">
        <input
          type="checkbox"
          checked={blind}
          onChange={(e) => {
            setBlind(e.target.checked);
            saveBlind(e.target.checked);
          }}
        />
        <span>
          <strong>Blinded session:</strong> hide camera estimates, errors and results on this screen (comparison study).
        </span>
      </label>

      <div className="notice notice-info small" role="note">
        <strong>Real-world camera tests only.</strong> Each record compares a real scan with physical ruler or tape
        readings taken by protocol HL-1 (docs/PILOT_PROTOCOL.md), and the server computes every error. Records marked as
        software tests are listed but never counted. Synthetic software tests and simulated camera experiments are
        reported separately (<code>python -m scripts.validation_report</code>). Calibration:{" "}
        <strong>
          {config.calibration_status}, {config.calibration_validated ? "validated" : "not validated"}
        </strong>
        .
      </div>

      {needsToken && (
        <section className="card stack" aria-labelledby="token-title">
          <h2 id="token-title">Operator sign-in</h2>
          <div className="field">
            <label htmlFor="v-token">Operator token</label>
            <input
              id="v-token"
              className="input"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div>
            <button
              className="btn"
              onClick={() => {
                setOperatorToken(token);
                reload();
              }}
            >
              Use token
            </button>
          </div>
        </section>
      )}

      <div className="grid-2">
        <section className="card stack" aria-labelledby="new-test">
          <h2 id="new-test">New test</h2>

          <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ fontWeight: 600, marginBottom: 8 }}>
              Record type
            </legend>
            <label className="radio-row">
              <input type="radio" name="v-origin" checked={form.origin === "real_participant"} onChange={() => setForm({ ...form, origin: "real_participant" })} />
              <span>
                Real participant <span className="small muted">(physical measurement just taken; counts towards the results)</span>
              </span>
            </label>
            <label className="radio-row">
              <input type="radio" name="v-origin" checked={form.origin === "software_test"} onChange={() => setForm({ ...form, origin: "software_test" })} />
              <span>
                Software test <span className="small muted">(demo, fake camera or practice; never counted)</span>
              </span>
            </label>
          </fieldset>

          <div className="field">
            <label htmlFor="v-participant">Participant code</label>
            <div className="input-group">
              <input id="v-participant" className="input" style={{ flex: 1 }} value={form.participant} onChange={set("participant")} placeholder="e.g. P-7KX2QM" />
              <button type="button" className="btn" onClick={() => setForm({ ...form, participant: newParticipantCode() })}>
                Generate
              </button>
            </div>
            <span className="small muted">Random code only. Never a name, initials, email or phone number.</span>
          </div>

          <fieldset className="row" style={{ gap: 16, border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ fontWeight: 600, marginBottom: 8 }}>
              Hand scanned
            </legend>
            {(["right", "left"] as const).map((h) => (
              <label key={h} className="radio-row" style={{ gridTemplateColumns: "20px auto" }}>
                <input type="radio" name="v-hand" checked={form.hand === h} onChange={() => setForm({ ...form, hand: h })} />
                <span>{h === "right" ? "Right" : "Left"}</span>
              </label>
            ))}
          </fieldset>

          {real && (
            <label className="radio-row">
              <input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} />
              <span>Participant consented to this pilot (signed form kept separately, not in this app)</span>
            </label>
          )}

          <div className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
              <span className="label" style={{ fontWeight: 600 }}>
                Hand length, wrist crease to middle fingertip
              </span>
              <select aria-label="Unit" className="select" value={form.unit} onChange={set("unit")} style={{ minHeight: 36 }}>
                <option value="mm">mm</option>
                <option value="cm">cm</option>
                <option value="in">in</option>
              </select>
            </div>
            <div className="row" style={{ gap: 8 }}>
              {(["r1", "r2", "r3"] as const).map((k, i) => (
                <input
                  key={k}
                  aria-label={`Reading ${i + 1}`}
                  placeholder={i === 2 ? "3rd if needed" : `Reading ${i + 1}`}
                  className="input num"
                  inputMode="decimal"
                  style={{ flex: 1, minWidth: 0 }}
                  value={form[k]}
                  onChange={set(k)}
                />
              ))}
            </div>
            <ReferenceHint
              check={check}
              inRange={inRange}
              unit={form.unit}
              tolerance={config.validation_reference_tolerance_mm}
            />
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="v-pb">Palm breadth ({form.unit}, optional)</label>
              <input id="v-pb" className="input num" inputMode="decimal" value={form.palmBreadth} onChange={set("palmBreadth")} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="v-circ">Circumference ({form.unit}, optional)</label>
              <input id="v-circ" className="input num" inputMode="decimal" value={form.circumference} onChange={set("circumference")} />
            </div>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="v-tool">Tool</label>
              <select id="v-tool" className="select" value={form.tool} onChange={set("tool")}>
                {TOOLS.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="v-by">Measured by</label>
              <select id="v-by" className="select" value={form.measuredBy} onChange={set("measuredBy")}>
                <option value="operator">operator</option>
                <option value="participant">participant</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="v-op">Operator code</label>
              <input id="v-op" className="input" value={form.operatorCode} onChange={set("operatorCode")} placeholder="e.g. OP1" maxLength={16} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="v-cond">Condition</label>
            <select id="v-cond" className="select" value={form.condition} onChange={set("condition")}>
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="v-device">Device and camera</label>
            <input id="v-device" className="input" value={form.device} onChange={set("device")} placeholder="e.g. Pixel 8, rear camera" />
          </div>
          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="v-light">Lighting</label>
              <select id="v-light" className="select" value={form.lighting} onChange={set("lighting")}>
                {LIGHTING.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="v-dist">Camera distance (cm, optional)</label>
              <input id="v-dist" className="input num" inputMode="decimal" value={form.distance} onChange={set("distance")} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="v-notes">Notes (optional)</label>
            <input id="v-notes" className="input" value={form.notes} onChange={set("notes")} maxLength={280} />
            <span className="small muted">No names or other personal details.</span>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <button className="btn btn-primary" disabled={blockers.length > 0} onClick={() => setScanning(true)}>
              Scan and record
            </button>
            {last && (
              <button className="btn" onClick={() => setForm({ ...form, ...EMPTY_PARTICIPANT })}>
                Next participant
              </button>
            )}
          </div>
          {blockers.length > 0 && <p className="small muted">Still needed: {blockers.join(", ")}.</p>}
          {submitError && (
            <div className="notice notice-error small" role="alert">
              {submitError}
            </div>
          )}
          {last && <LastResult record={last} blind={blind} summary={summary} />}
        </section>

        <section className="card stack" aria-labelledby="summary-title">
          <h2 id="summary-title">Real-participant results</h2>
          {loadError && (
            <div className="notice notice-error" role="alert">
              {loadError}
            </div>
          )}
          {blind ? <p className="muted">Hidden during a blinded session.</p> : summary && <SummaryView summary={summary} />}
        </section>
      </div>

      <PilotInvites config={config} />

      <section className="card stack" aria-labelledby="records-title">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="records-title">Tests ({records.length})</h2>
          {records.length > 0 && !blind && (
            <button className="btn" onClick={() => void downloadCsv()}>
              Download CSV
            </button>
          )}
        </div>
        {blind ? (
          <p className="muted">Hidden during a blinded session.</p>
        ) : records.length === 0 ? (
          <p className="muted">No tests recorded yet.</p>
        ) : (
          <RecordsTable records={records} flags={summary?.record_flags ?? {}} onDelete={(id) => void deleteValidationRecord(id).then(reload)} />
        )}
      </section>
    </main>
  );
}

function ReferenceHint({
  check,
  inRange,
  unit,
  tolerance,
}: {
  check: ReturnType<typeof referenceCheck>;
  inRange: boolean;
  unit: LengthUnit;
  tolerance: number;
}) {
  if (!check) return <span className="small muted">Take two readings, repositioning the hand in between.</span>;
  if (!inRange)
    return (
      <span className="small" role="status" style={{ color: "var(--bad)" }}>
        A reading is outside {HAND_LENGTH_RANGE_MM[0]}-{HAND_LENGTH_RANGE_MM[1]} mm. Check the value and the unit ({unit}).
      </span>
    );
  const text = {
    single_reading: `One reading (${fmt(check.valueMm)} mm). Take a second reading before scanning.`,
    agreed: `Readings agree (spread ${fmt(check.spreadMm)} mm). Reference ${fmt(check.valueMm)} mm.`,
    discrepant: `Readings differ by ${fmt(check.spreadMm)} mm (more than ${tolerance} mm). Re-measure and enter a third reading.`,
  }[check.reliability];
  return (
    <span className="small" role="status" style={check.reliability === "agreed" ? undefined : { color: "var(--warn)" }}>
      {text}
    </span>
  );
}

function LastResult({ record, blind, summary }: { record: ValidationRecord; blind: boolean; summary: ValidationSummary | null }) {
  const hl = record.comparisons.find((c) => c.key === "hand_length_mm");
  const kind = record.data_origin === "software_test" ? " (software test, not counted)" : "";
  if (blind) {
    return (
      <div className={`notice ${record.quality_passed ? "notice-info" : "notice-error"} small`} role="status">
        {record.quality_passed
          ? `Recorded${kind}: scan accepted.`
          : `Recorded${kind}: scan rejected by the app (${record.scan_rejection_reasons.join(", ") || "no estimate"}). Retake this slot.`}
      </div>
    );
  }
  return (
    <div className={`notice ${record.quality_passed ? "notice-info" : "notice-error"} small`} role="status">
      {record.quality_passed && hl?.estimate_mm != null ? (
        <>
          Recorded{kind}. Camera {fmt(hl.estimate_mm)} mm vs reference {fmt(hl.reference_mm)} mm: error{" "}
          {signed(hl.signed_error_mm)} mm ({signed(hl.pct_error, 2)}%). To repeat, keep the readings, pick a condition and
          scan again.
        </>
      ) : (
        <>
          Recorded{kind} as a rejected scan ({record.scan_rejection_reasons.join(", ") || "no estimate"}). It counts
          towards the rejection rate only.
        </>
      )}
      {record.integrity_flags.length > 0 && <> Flagged: {record.integrity_flags.join(", ")}; excluded from results.</>}
      {summary && <RunningAccuracy summary={summary} />}
    </div>
  );
}

/** Running totals next to the latest result, so they are visible on a phone without scrolling. */
function RunningAccuracy({ summary }: { summary: ValidationSummary }) {
  const rw = summary.real_world;
  const acc = rw.accuracy.by_scan;
  return (
    <div className="stack" style={{ gap: 2, marginTop: 8 }} aria-label="Running accuracy">
      <strong>So far (real participants, standard scans with agreed readings)</strong>
      {acc.n > 0 ? (
        <span>
          {acc.n} scan{acc.n === 1 ? "" : "s"} from {rw.accuracy.n_hands} hand{rw.accuracy.n_hands === 1 ? "" : "s"}: average error
          (MAE) {fmt(acc.mae_mm, 1)} mm, bias {signed(acc.mean_signed_error_mm, 1)} mm, largest {fmt(acc.max_abs_error_mm, 1)} mm.
          Rejected scans: {rw.scans.rejected} of {rw.scans.total}.
        </span>
      ) : (
        <span>No scored scans yet.</span>
      )}
      <span className="muted">{rw.accuracy.sample_note}</span>
    </div>
  );
}

function StatsRow({ label, d }: { label: string; d: ErrorStats }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{d.n}</td>
      <td>{signed(d.mean_signed_error_mm, 2)}</td>
      <td>{fmt(d.mae_mm, 2)}</td>
      <td>{fmt(d.rmse_mm, 2)}</td>
      <td>{fmt(d.median_abs_error_mm, 2)}</td>
      <td>{fmt(d.max_abs_error_mm, 2)}</td>
    </tr>
  );
}

function SummaryView({ summary }: { summary: ValidationSummary }) {
  const rw = summary.real_world;
  const acc = rw.accuracy;
  const rep = rw.repeatability;
  const excluded = Object.entries(summary.excluded).filter(([, n]) => n > 0);
  const hist = acc.by_scan.histogram;
  const maxCount = hist ? Math.max(1, ...hist.counts, hist.below, hist.above) : 1;
  return (
    <div className="stack">
      <p className="small" role="note">
        <strong>{acc.sample_note}</strong>
      </p>
      <dl className="kv">
        <dt>Participants / hands</dt>
        <dd>
          {rw.participants} / {rw.hands}
        </dd>
        <dt>Scans</dt>
        <dd>
          {rw.scans.total} ({rw.scans.accepted} passed, {rw.scans.rejected} rejected
          {rw.scans.rejected_pct !== null && `, ${rw.scans.rejected_pct.toFixed(0)}%`})
        </dd>
        <dt>Rejection reasons</dt>
        <dd>
          {Object.entries(rw.scans.rejection_reasons)
            .map(([k, n]) => `${k} (${n})`)
            .join(", ") || "none"}
        </dd>
        <dt>Physical references</dt>
        <dd>
          {Object.entries(rw.references)
            .map(([k, n]) => `${RELIABILITY_LABEL[k as keyof typeof RELIABILITY_LABEL]} ${n}`)
            .join(", ") || "none"}
        </dd>
        <dt>Not counted</dt>
        <dd>{excluded.map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(", ") || "none"}</dd>
      </dl>

      {acc.by_scan.n > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <strong>Hand length: camera minus physical reference (mm)</strong>
          <span className="small muted">Scope: {acc.scope}.</span>
          <div style={{ overflowX: "auto" }}>
            <table className="diag-table validation-table" style={{ minWidth: 520 }} aria-label="Hand length errors">
              <thead>
                <tr>
                  <th>Per</th>
                  <th>n</th>
                  <th>Bias</th>
                  <th>MAE</th>
                  <th>RMSE</th>
                  <th>Median |e|</th>
                  <th>Max |e|</th>
                </tr>
              </thead>
              <tbody>
                <StatsRow label="Scan" d={acc.by_scan} />
                <StatsRow label="Hand" d={acc.by_hand} />
              </tbody>
            </table>
          </div>
          <span className="small muted">
            Within the camera's reported 95% interval: {acc.within_reported_95_interval.count} of {acc.within_reported_95_interval.of}{" "}
            scans.
          </span>
          {hist && (
            <div className="stack" style={{ gap: 2 }} aria-label="Error distribution">
              {[
                ...(hist.below ? [["< -20", hist.below] as const] : []),
                ...hist.counts.map((n, i) => [`${signed(hist.bin_edges_mm[i], 0)} to ${signed(hist.bin_edges_mm[i + 1], 0)}`, n] as const),
                ...(hist.above ? [["≥ +20", hist.above] as const] : []),
              ]
                .filter(([, n]) => n > 0)
                .map(([label, n]) => (
                  <div key={label} className="row small" style={{ gap: 8 }}>
                    <span style={{ width: 92 }} className="num">
                      {label}
                    </span>
                    <span style={{ height: 10, width: `${(100 * n) / maxCount}%`, maxWidth: 160, background: "var(--accent)", borderRadius: 3 }} />
                    <span className="num">{n}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {rw.by_participant.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <strong>Per participant (one row per hand)</strong>
          <span className="small muted">Standard-condition scans with agreed physical readings.</span>
          <div style={{ overflowX: "auto" }}>
            <table className="diag-table validation-table" style={{ minWidth: 560 }} aria-label="Errors per participant">
              <thead>
                <tr>
                  <th>Participant</th>
                  <th>Hand</th>
                  <th>Scans</th>
                  <th>Rejected</th>
                  <th>Scored</th>
                  <th>Mean error</th>
                  <th>MAE</th>
                  <th>Range</th>
                </tr>
              </thead>
              <tbody>
                {rw.by_participant.map((p) => (
                  <tr key={p.participant_code + p.hand}>
                    <td>{p.participant_code}</td>
                    <td>{p.hand}</td>
                    <td>{p.scans}</td>
                    <td>{p.rejected}</td>
                    <td>{p.standard_scored}</td>
                    <td>{signed(p.standard_mean_signed_error_mm, 2)}</td>
                    <td>{fmt(p.standard_mae_mm, 2)}</td>
                    <td>
                      {p.standard_error_range_mm
                        ? `${signed(p.standard_error_range_mm[0])} to ${signed(p.standard_error_range_mm[1])}`
                        : "n/a"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rw.scans.total > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <strong>By camera distance</strong>
          <span className="small muted">
            Each hand counts once per band. Bands with fewer than {rw.by_distance.min_hands_per_band} hands are not
            interpreted.
          </span>
          <DistanceTable title="Operator-measured" part={rw.by_distance.operator_measured} />
          <DistanceTable title="Coin-implied (estimate)" part={rw.by_distance.coin_implied} />
        </div>
      )}

      <div className="stack" style={{ gap: 8 }}>
        <strong>Repeatability</strong>
        <span className="small muted">{rep.note}</span>
        <dl className="kv">
          <dt>Hands with repeated standard scans</dt>
          <dd>{rep.hands_with_repeats}</dd>
          <dt>Within-hand SD</dt>
          <dd>{rep.within_hand_sd_mm === null ? "n/a" : `${fmt(rep.within_hand_sd_mm, 2)} mm`}</dd>
          <dt>Repeatability coefficient</dt>
          <dd>{rep.repeatability_coefficient_mm === null ? "n/a" : `${fmt(rep.repeatability_coefficient_mm, 2)} mm`}</dd>
        </dl>
        {Object.keys(rep.condition_shifts).length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="diag-table validation-table" style={{ minWidth: 480 }} aria-label="Condition shifts">
              <thead>
                <tr>
                  <th>Condition vs standard</th>
                  <th>Hands</th>
                  <th>Mean shift</th>
                  <th>Largest</th>
                  <th>Beyond repeatability</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(rep.condition_shifts).map(([cond, d]) => (
                  <tr key={cond}>
                    <td>{CONDITION_LABEL[cond as TrialCondition] ?? cond}</td>
                    <td>{d!.n_hands}</td>
                    <td>{signed(d!.mean_shift_mm, 2)} mm</td>
                    <td>{fmt(d!.max_abs_shift_mm, 2)} mm</td>
                    <td>{d!.exceeds_repeatability === null ? "n/a" : d!.exceeds_repeatability ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function DistanceTable({ title, part }: { title: string; part: DistanceBreakdown }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="diag-table validation-table" style={{ minWidth: 520 }} aria-label={`${title} distance`}>
        <caption className="small muted" style={{ textAlign: "left", captionSide: "top", paddingBottom: 4 }}>
          {title} distance. {part.note} Without a distance: {part.without_distance}.
        </caption>
        <thead>
          <tr>
            <th>Band</th>
            <th>Scans</th>
            <th>Rejected</th>
            <th>Hands</th>
            <th>Mean error</th>
            <th>MAE</th>
          </tr>
        </thead>
        <tbody>
          {part.rows.map((b) => (
            <tr key={b.band} className={b.sufficient ? undefined : "muted"}>
              <td>{b.band}</td>
              <td>{b.scans}</td>
              <td>{b.rejected}</td>
              <td>{b.hands_scored}</td>
              <td>{b.sufficient ? signed(b.mean_signed_error_mm, 2) : b.hands_scored ? "too few hands" : "n/a"}</td>
              <td>{b.sufficient ? fmt(b.mae_mm, 2) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordsTable({
  records,
  flags,
  onDelete,
}: {
  records: ValidationRecord[];
  flags: Record<string, string[]>;
  onDelete: (id: string) => void;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="diag-table validation-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Type</th>
            <th>Participant</th>
            <th>Hand</th>
            <th>Condition</th>
            <th>Reference</th>
            <th>Camera</th>
            <th>Error</th>
            <th>Scan</th>
            <th>Flags</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {[...records].reverse().map((r) => {
            const hl = r.comparisons.find((c) => c.key === "hand_length_mm");
            const rs = r.reference_summary;
            return (
              <tr key={r.id}>
                <td>{r.created_at.replace("T", " ").slice(0, 16)}</td>
                <td>{r.data_origin === "real_participant" ? <Badge tone="info">real</Badge> : <Badge tone="neutral">software test</Badge>}</td>
                <td>{r.participant_code}</td>
                <td>{r.trial.hand}</td>
                <td className="small">{CONDITION_LABEL[r.trial.condition]}</td>
                <td title={rs.readings_mm.map((v) => v.toFixed(1)).join(", ") + " mm"}>
                  {fmt(rs.hand_length_mm)} mm <span className="small muted">({RELIABILITY_LABEL[rs.reliability]})</span>
                </td>
                <td>{hl?.estimate_mm != null ? `${fmt(hl.estimate_mm)} ±${fmt(hl.uncertainty_mm)} mm` : "n/a"}</td>
                <td>{hl?.signed_error_mm != null ? `${signed(hl.signed_error_mm)} mm (${signed(hl.pct_error, 2)}%)` : "n/a"}</td>
                <td>
                  {r.quality_passed ? (
                    <Badge tone="good">passed</Badge>
                  ) : (
                    <span title={r.scan_rejection_reasons.join(", ")}>
                      <Badge tone="bad">rejected</Badge>
                    </span>
                  )}
                </td>
                <td className="small">{(flags[r.id] ?? r.integrity_flags).join(", ")}</td>
                <td>
                  <button
                    className="link small"
                    onClick={() => {
                      if (window.confirm("Delete this test record?")) onDelete(r.id);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
