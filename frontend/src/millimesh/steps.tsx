// Steps 1-3 of the MILLIMESH flow: Start, Select a Reference Coin, Allow Camera Access.
import { useEffect, useRef, useState } from "react";
import type { PublicConfig, ReferenceSelection } from "../api/types";
import { ArrowRight, CameraIcon, CoinDisc, Wordmark } from "./Brand";
import { initialCoinId, pickerCoins, selectionFor } from "./coins";
import { ParticleWave } from "./ParticleWave";

/** Move focus to the screen's heading when it appears, so keyboard and screen-reader users follow along. */
function useHeadingFocus() {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}

const BASIS_NAMES: Record<string, string> = {
  hand_length_mm: "hand length",
  hand_circumference_mm: "hand circumference",
  palm_breadth_mm: "palm breadth",
};
const sizingBasis = (keys: string[]) => keys.map((k) => BASIS_NAMES[k] ?? k).join(" and ");

// ---------------------------------------------------------------------------------------------------- 1. Start

export interface StartProps {
  config: PublicConfig;
  chartId: string;
  onChartChange: (id: string) => void;
  onStart: () => void;
}

export function StartStep({ config, chartId, onChartChange, onStart }: StartProps) {
  const h1 = useHeadingFocus();
  const chart = config.charts.find((c) => c.chart_id === chartId) ?? config.charts[0];
  return (
    <main className="mm-screen mm-start">
      <header className="mm-top">
        <Wordmark />
      </header>
      <ParticleWave className="mm-start-wave" />
      <div className="mm-start-body">
        <h1 ref={h1} tabIndex={-1} className="mm-h1">
          <span className="mm-h1-line">Surface</span> <span className="mm-h1-line">Swarm</span>
        </h1>
        <p className="mm-lead">Capture your hand in 3 views using a reference coin.</p>

        {config.charts.length > 1 && (
          <div className="mm-field">
            <label htmlFor="mm-chart">Your product</label>
            <select id="mm-chart" className="mm-select" value={chart.chart_id} onChange={(e) => onChartChange(e.target.value)}>
              {config.charts.map((c) => (
                <option key={c.chart_id} value={c.chart_id}>
                  {c.product_model ?? c.chart_id}
                  {c.manufacturer ? `, ${c.manufacturer}` : ""} (sized by {sizingBasis(c.measurements)})
                </option>
              ))}
            </select>
          </div>
        )}
        {chart.is_demo && (
          <p className="mm-fine" role="note">
            <strong>Demo size chart.</strong> The size boundaries are placeholders for testing, not a real product chart.
          </p>
        )}
        {chart.measurements.includes("hand_circumference_mm") && (
          <p className="mm-fine">You'll be asked for a tape measurement of your hand circumference after the scan.</p>
        )}

        <button className="mm-btn" onClick={onStart}>
          Start Scan
          <ArrowRight />
        </button>
        <p className="mm-fine mm-start-foot">
          {config.calibration_validated ? "Camera-based estimate" : "Unvalidated prototype · camera-based estimate"} · not a guarantee of
          fit
          <span className="mm-start-links">
            <a href="#/calibration">Operator calibration</a>
            {config.validation_mode_enabled && <a href="#/validation">Validation</a>}
          </span>
        </p>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------------------------------- 2. Coin

export interface CoinProps {
  config: PublicConfig;
  /** What this device chose before, or null (then the 2-rupee coin is chosen). */
  previous: ReferenceSelection | null;
  onContinue: (sel: ReferenceSelection) => void;
  onBack: () => void;
}

export function CoinStep({ config, previous, onContinue, onBack }: CoinProps) {
  const h1 = useHeadingFocus();
  const coins = pickerCoins(config);
  const [choice, setChoice] = useState<string | null>(() => initialCoinId(config, previous));
  const [sizeChecked, setSizeChecked] = useState(false);
  const chosen = coins.find((c) => c.id === choice && c.selectable);
  const needsCheck = Boolean(chosen?.object.size_check);

  return (
    <main className="mm-screen mm-coin">
      <header className="mm-top">
        <Wordmark />
      </header>
      <h1 ref={h1} tabIndex={-1} className="mm-h2">
        Select a Reference Coin
      </h1>
      <p className="mm-sub">Choose the coin you will place on your hand for the entire scan.</p>

      <div className="mm-coins" role="radiogroup" aria-label="Reference coin">
        {coins.map((c) => {
          const on = c.id === choice && c.selectable;
          return (
            <label key={c.id} className={`mm-coin-card ${on ? "is-on" : ""} ${c.selectable ? "" : "is-off"}`}>
              <input
                type="radio"
                name="mm-coin"
                className="visually-hidden"
                value={c.id}
                checked={on}
                disabled={!c.selectable}
                onChange={() => {
                  setChoice(c.id);
                  setSizeChecked(false);
                }}
              />
              <CoinDisc mark={c.face.mark} tone={c.face.tone} size={56} />
              <span className="mm-coin-name">{c.face.name}</span>
              <span className="mm-coin-mm">{c.diameterText}</span>
              {c.unavailableReason && <span className="mm-coin-why">{c.unavailableReason}</span>}
            </label>
          );
        })}
      </div>

      {chosen?.object.customer_hint && <p className="mm-fine">{chosen.object.customer_hint}</p>}
      {needsCheck && chosen && (
        <label className="mm-check">
          <input type="checkbox" checked={sizeChecked} onChange={(e) => setSizeChecked(e.target.checked)} />
          <span>I checked: my coin is {chosen.object.diameter_mm} mm across (for example against a ruler).</span>
        </label>
      )}
      <p className="mm-fine">The coin is the ruler for the scan. A different coin gives wrong sizes, so pick the one you will use.</p>

      <div className="mm-actions">
        <button className="mm-btn" disabled={!chosen || (needsCheck && !sizeChecked)} onClick={() => chosen && onContinue(selectionFor(chosen.object, sizeChecked))}>
          Continue
          <ArrowRight />
        </button>
        <button className="mm-btn mm-btn--quiet" onClick={onBack}>
          Back
        </button>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------------------------------- 3. Camera

export function CameraStep({ onAllow, onNotNow }: { onAllow: () => void; onNotNow: () => void }) {
  const h1 = useHeadingFocus();
  return (
    <main className="mm-screen mm-camera">
      <header className="mm-top">
        <Wordmark />
      </header>
      <div className="mm-camera-body">
        <span className="mm-camera-icon" aria-hidden="true">
          <CameraIcon />
        </span>
        <h1 ref={h1} tabIndex={-1} className="mm-h2">
          Allow Camera Access
        </h1>
        <p className="mm-sub">MilliMesh needs to use your camera to capture your hand and build your 3D model.</p>
        <p className="mm-fine">Your video stays on this device. Only numbers are sent: the positions of 21 hand points, the coin's outline and image-quality scores. Nothing is stored.</p>
      </div>
      <div className="mm-actions">
        <button className="mm-btn" onClick={onAllow}>
          Allow Camera
        </button>
        <button className="mm-btn mm-btn--ghost" onClick={onNotNow}>
          Not Now
        </button>
      </div>
    </main>
  );
}
