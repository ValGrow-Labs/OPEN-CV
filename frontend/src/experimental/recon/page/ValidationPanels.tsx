// The validation-mode panels of the EXPERIMENTAL board-capture page: the board print check (ruler readings and the sheet
// checklist), the test-run details, the board flatness (live while capturing and after the build), the validity of the
// capture, and the device performance log (debug). Words only; the logic is in boardCheck.ts, runDetails.ts,
// boardFlatness.ts, validity.ts and deviceLog.ts.
import type { BoardFlatness } from "../boardFlatness";
import { FLATNESS_TITLES } from "../boardFlatness";
import { CHECKLIST, RULER_TOLERANCE, type Checklist, type RulerCheck } from "./boardCheck";
import type { DeviceJson } from "./deviceLog";
import { ms } from "./format";
import { CONDITION_WORDS, CONDITIONS, NOTES_MAX, toggleCondition, type RunDetails } from "./runDetails";

export type RulerText = { squareX: string; squareY: string; longSpan: string; shortSpan: string };

const VERDICT_WORDS: Record<RulerCheck["verdict"], string> = { pass: "Pass: printed at actual size", reprint: "Reprint at 100 % / actual size", not_entered: "Not entered yet" };

export function BoardPrintCheck(p: {
  required: boolean;
  text: RulerText;
  onText: (t: RulerText) => void;
  ruler: RulerCheck;
  checklist: Checklist;
  onChecklist: (c: Checklist) => void;
  conditions: readonly string[];
}) {
  const e = p.ruler.expected;
  const field = (key: keyof RulerText, label: string, expected: number, testId: string) => (
    <label className="rc-field">
      <span className="rc-field-label">{label}</span>
      <span className="rc-field-row">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder={expected.toFixed(1)}
          value={p.text[key]}
          onChange={(ev) => p.onText({ ...p.text, [key]: ev.target.value })}
          data-testid={testId}
          aria-describedby="rc-ruler-help"
        />
        <span className="rc-unit">mm</span>
      </span>
      <span className="rc-field-expect">expected {expected.toFixed(1)}</span>
    </label>
  );
  return (
    <section className="rc-sub rc-printcheck" aria-label="Board print check" data-testid="board-check">
      <h2 className="rc-h3">Board print check {p.required ? <span className="rc-req">required</span> : <span className="rc-opt">optional</span>}</h2>
      <p className="rc-small" id="rc-ruler-help">
        Measure the printed sheet with a ruler before the capture. The expected lengths come from the board's layout. Provisional tolerance: square ± {RULER_TOLERANCE.squareMm} mm,
        spans ± {(RULER_TOLERANCE.spanFraction * 100).toFixed(1)} %, and the across and down scales within {(RULER_TOLERANCE.anisotropyFraction * 100).toFixed(1)} % of each other.
      </p>
      <div className="rc-fields">
        {field("squareX", "One marker's black square: width", e.square_mm, "ruler-square-x")}
        {field("squareY", "The same square: height", e.square_mm, "ruler-square-y")}
        {field("longSpan", "Top row: left edge of the first marker to right edge of the last", e.long_span_mm, "ruler-long-span")}
        {field("shortSpan", "Right column: top edge of the upper marker to bottom edge of the lower", e.short_span_mm, "ruler-short-span")}
      </div>
      <div className={`rc-verdict-line rc-v-${p.ruler.verdict}`} role="status" data-testid="ruler-verdict" data-verdict={p.ruler.verdict}>
        <strong>{VERDICT_WORDS[p.ruler.verdict]}</strong>
        {p.ruler.verdict !== "not_entered" && (
          <ul className="rc-reasons">
            {p.ruler.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
      <fieldset className="rc-fieldset">
        <legend>How the sheet lies</legend>
        {CHECKLIST.map((c) => {
          const waived = !!c.waivedBy && p.conditions.includes(c.waivedBy);
          return (
            <label className="rc-check" key={c.key}>
              <input type="checkbox" checked={p.checklist[c.key]} onChange={(ev) => p.onChecklist({ ...p.checklist, [c.key]: ev.target.checked })} data-testid={`check-${c.key}`} />
              <span>
                {c.words}
                {waived && !p.checklist[c.key] && <span className="rc-small"> (not required: this run tests "{c.waivedBy!.replace("_", " ")}" on purpose)</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
    </section>
  );
}

export function RunDetailsPanel(p: { run: RunDetails; onRun: (r: RunDetails) => void; problems: string[] }) {
  const { run } = p;
  const text = (key: "phantomId" | "sessionId" | "operatorCode", label: string, placeholder: string, testId: string, hint?: string) => (
    <label className="rc-field">
      <span className="rc-field-label">{label}</span>
      <input type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder={placeholder} value={run[key]} onChange={(e) => p.onRun({ ...run, [key]: e.target.value })} data-testid={testId} />
      {hint && <span className="rc-field-expect">{hint}</span>}
    </label>
  );
  return (
    <section className="rc-sub rc-run" aria-label="Test run" data-testid="run-details">
      <h2 className="rc-h3">
        Test run <span className="rc-req">required</span>
      </h2>
      <p className="rc-small">Kept in this tab's memory only and written into the export. Use codes, never names.</p>
      <div className="rc-fields">
        {text("phantomId", "Phantom id", "PH01", "run-phantom")}
        {text("sessionId", "Session id", "S01", "run-session")}
        <label className="rc-field">
          <span className="rc-field-label">Capture index</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={run.captureIndex}
            onChange={(e) => p.onRun({ ...run, captureIndex: Math.floor(Number(e.target.value)) || 0 })}
            data-testid="run-index"
          />
          <span className="rc-field-expect">goes up by one after each export</span>
        </label>
        {text("operatorCode", "Operator code", "OP01", "run-operator", "a code with a digit, never a name")}
      </div>
      <fieldset className="rc-fieldset">
        <legend>Conditions</legend>
        <div className="rc-tags">
          {CONDITIONS.map((c) => (
            <label key={c} className="rc-tag">
              <input type="checkbox" checked={run.conditions.includes(c)} onChange={(e) => p.onRun({ ...run, conditions: toggleCondition(run.conditions, c, e.target.checked) })} data-testid={`cond-${c}`} />
              <span>{CONDITION_WORDS[c]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="rc-field rc-field-wide">
        <span className="rc-field-label">Notes</span>
        <textarea rows={2} maxLength={NOTES_MAX} value={run.notes} onChange={(e) => p.onRun({ ...run, notes: e.target.value })} data-testid="run-notes" />
      </label>
      {p.problems.length > 0 && (
        <ul className="rc-small rc-problems" data-testid="run-problems">
          {p.problems.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function FlatnessSummary(p: { flatness: BoardFlatness | null; live?: boolean; testId: string }) {
  const f = p.flatness;
  if (!f) return null;
  const bad = f.verdict === "fail" || f.verdict === "not_checked";
  return (
    <div className={`rc-flat rc-flat-${f.verdict}`} role={bad ? "alert" : "status"} data-testid={p.testId} data-verdict={f.verdict}>
      <strong>
        {p.live ? "Sheet flatness so far: " : ""}
        {FLATNESS_TITLES[f.verdict]}
      </strong>
      <ul className="rc-reasons">
        {f.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

export function BoardCheckResult(p: { validationMode: boolean; ruler: RulerCheck | null; flatness: BoardFlatness | null; valid: { valid: boolean; reasons: string[] } | null }) {
  const f = p.flatness;
  return (
    <section className="rc-card" aria-label="Board check" data-testid="board-check-result">
      <h3>Board check</h3>
      {p.validationMode && p.valid && (
        <div className={`rc-validity ${p.valid.valid ? "is-valid" : "is-invalid"}`} role={p.valid.valid ? "status" : "alert"} data-testid="validity" data-valid={p.valid.valid ? "1" : "0"}>
          <strong>{p.valid.valid ? "Valid for validation (conditions met; not a claim of accuracy)" : "Not valid for validation"}</strong>
          {!p.valid.valid && (
            <ul className="rc-reasons">
              {p.valid.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <dl className="rc-dl">
        <dt>Ruler check</dt>
        <dd data-testid="result-ruler">{p.ruler ? `${VERDICT_WORDS[p.ruler.verdict]}${p.ruler.scaleX !== null ? ` (across ${(p.ruler.scaleX * 100).toFixed(2)} %, down ${(p.ruler.scaleY! * 100).toFixed(2)} %)` : ""}` : "not entered"}</dd>
        {!f && (
          <>
            <dt>Flatness</dt>
            <dd>not checked</dd>
          </>
        )}
        {f && f.medianMarkerRmsPx !== null && (
          <>
            <dt>Marker residuals</dt>
            <dd>
              median {f.medianMarkerRmsPx.toFixed(2)} px, worst {f.worstMarkerRmsPx!.toFixed(2)} px over {f.viewsUsed} pictures
              {f.edgeVsCentreRatio !== null && `; corner / middle ${f.edgeVsCentreRatio.toFixed(2)}`}
            </dd>
          </>
        )}
      </dl>
      <FlatnessSummary flatness={f} testId="flatness" />
    </section>
  );
}

export function DeviceLogPanel(p: { log: DeviceJson | null }) {
  const d = p.log;
  if (!d) return null;
  const mb = (v: number | null) => (v === null ? "not available in this browser" : `${v} MB`);
  return (
    <div className="rc-devlog" data-testid="device-log">
      <h2 className="rc-h3">Device log (goes into device.json)</h2>
      <dl className="rc-dl">
        <dt>Device</dt>
        <dd>
          {d.hardware_concurrency ?? "?"} cores, memory class {d.device_memory_gb !== null ? `${d.device_memory_gb} GB` : "not reported"}; screen{" "}
          {d.screen ? `${d.screen.width} × ${d.screen.height} at ${d.screen.device_pixel_ratio}×` : "unknown"}
        </dd>
        <dt>Camera</dt>
        <dd>
          {d.camera.width ? `${d.camera.width} × ${d.camera.height}` : "not started"}
          {d.camera.settings && typeof d.camera.settings.frameRate === "number" ? `, ${Number(d.camera.settings.frameRate).toFixed(0)} fps` : ""}
        </dd>
        <dt>Capture / build / export</dt>
        <dd>
          {ms(d.capture_ms)} / {ms(d.build_ms)} / {ms(d.export_ms)}
          {d.export_ok !== null && (d.export_ok ? " (export ok)" : " (export failed)")}
        </dd>
        <dt>JS heap</dt>
        <dd>
          {d.heap_samples_mb ? `${d.heap_samples_mb[d.heap_samples_mb.length - 1]} MB now, peak ${mb(d.peak_heap_mb)} (${d.heap_samples_mb.length} samples)` : "not available in this browser"}
        </dd>
        <dt>WebGL context lost</dt>
        <dd>{d.webgl_context_lost}</dd>
        <dt>Errors</dt>
        <dd>{d.errors.length ? d.errors.join(" · ") : "none"}</dd>
      </dl>
    </div>
  );
}
