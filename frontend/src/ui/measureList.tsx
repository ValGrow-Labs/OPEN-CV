// Measurements as a list that reads well on a phone: the name and the value on one line, then how
// sure we are and where the number came from (the customer's tape or the camera).
import type { Measurement } from "../api/types";
import { COMPONENTS, fmtIn, fmtMm, REASONS, SOURCE, STATUS, type Tone } from "./format";
import { CountUp, stagger } from "./motion";

export interface MeasureItem {
  key: string;
  label: string;
  note?: string;
  m?: Measurement;
}

export function Status({ tone, children }: { tone: Tone; children: string }) {
  return <span className={`status status-${tone}`}>{children}</span>;
}

export function MeasureList({ items, showHow = false, countUp = false }: { items: MeasureItem[]; showHow?: boolean; countUp?: boolean }) {
  return (
    <ul className="mlist">
      {items.map((it, i) => (
        <MeasureRow key={it.key} item={it} index={i} showHow={showHow} countUp={countUp} />
      ))}
    </ul>
  );
}

function MeasureRow({ item, index, showHow, countUp }: { item: MeasureItem; index: number; showHow: boolean; countUp: boolean }) {
  const { m } = item;
  const value = m && m.value_mm !== null && m.status !== "invalid" && m.status !== "not_measured" ? m.value_mm : null;
  const entered = m?.status === "user_entered";
  // "You entered" would repeat the provenance line, and "Not measured" the value column.
  const status = m && !entered && value !== null ? STATUS[m.status] : m?.status === "invalid" ? STATUS.invalid : null;
  return (
    <li className="mrow stagger-in" style={stagger(index)} data-measure={item.key}>
      <div className="mrow-head">
        <div className="mrow-name">
          <span className="mrow-label">{item.label}</span>
          {item.note && <span className="mrow-note">{item.note}</span>}
        </div>
        <div className="mrow-value">
          {value !== null ? (
            <>
              <span className="mrow-mm">
                {countUp ? (
                  <CountUp value={value} suffix=" mm" />
                ) : (
                  <span className="num" data-value={value.toFixed(0)}>
                    {fmtMm(value)}
                  </span>
                )}
              </span>
              <span className="mrow-sub num">
                {fmtIn(value)}
                {m?.uncertainty_mm != null && ` · ±${m.uncertainty_mm.toFixed(1)} mm`}
              </span>
            </>
          ) : (
            <span className="mrow-none">Not measured</span>
          )}
        </div>
      </div>
      {(status || value !== null) && (
        <div className="mrow-meta">
          {status && <Status tone={status.tone}>{status.label}</Status>}
          {value !== null && <span>{entered ? "entered by you" : "camera estimate"}</span>}
        </div>
      )}
      {m && m.reasons.length > 0 && <p className="mrow-reason">{m.reasons.map((r) => REASONS[r] ?? r).join(" ")}</p>}
      {showHow && m && (
        <details className="disclosure">
          <summary>How it's measured</summary>
          <p className="small muted">{m.definition}</p>
          <p className="small muted">{SOURCE[m.source]}.</p>
          {Object.keys(m.uncertainty_components_mm).length > 0 && (
            <dl className="kv small">
              {Object.entries(m.uncertainty_components_mm).map(([k, v]) => (
                <UncRow key={k} name={k} value={v} />
              ))}
            </dl>
          )}
        </details>
      )}
    </li>
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
