import { useEffect, useRef, useState } from "react";
import type { PublicConfig, ReferenceSelection } from "../api/types";
import { ScanController, type ScanStatus } from "../scan/scanController";
import { Badge } from "../ui/components";
import { stagger } from "../ui/motion";
import { referenceLabel } from "../ui/settings";

interface Props {
  config: PublicConfig;
  reference: ReferenceSelection;
  onSave: (sel: ReferenceSelection) => void;
  onClose: () => void;
}

const REASON_TEXT: Record<string, string> = {
  coin_not_found: "No circular object found in the centre box.",
  coin_too_small: "Coin too small in the image. Move closer.",
  coin_occluded: "Part of the coin's edge is hidden or missing.",
  coin_blurry: "Edge is blurred (focus or motion).",
  coin_glare: "Specular glare covers part of the coin.",
  coin_low_contrast: "Coin barely differs from the background.",
  coin_irregular_boundary: "Outline is not a clean ellipse.",
  coin_low_confidence: "Overall detection quality too low.",
};

/** Operator mode: confirm the reference object and inspect coin-detection quality live. */
export function CalibrationScreen({ config, reference, onSave, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [mode, setMode] = useState<"preset" | "custom">(reference.custom_diameter_mm !== undefined ? "custom" : "preset");
  const [objectId, setObjectId] = useState(reference.object_id ?? config.reference_objects.default);
  const [customMm, setCustomMm] = useState(reference.custom_diameter_mm?.toString() ?? "");
  const [customLabel, setCustomLabel] = useState(reference.custom_label ?? "");
  const [verified, setVerified] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const c = new ScanController(videoRef.current!, canvasRef.current!, config, { mode: "calibration", facing: "user", onStatus: setStatus });
    void c.start();
    return () => c.stop();
  }, [config]);

  const custom = parseFloat(customMm);
  const customValid = Number.isFinite(custom) && custom >= 10 && custom <= 60;
  const selection: ReferenceSelection =
    mode === "preset" ? { object_id: objectId } : { custom_diameter_mm: custom, custom_label: customLabel || undefined };
  const diameter = mode === "preset" ? referenceLabel(config, selection).diameter : custom;
  const canSave = mode === "preset" || (customValid && verified);
  const coin = status?.coin;
  const tilt = coin?.found ? (Math.acos(Math.min(1, coin.minor_axis_px / coin.major_axis_px)) * 180) / Math.PI : null;
  const acc = config.coin_detection.accept;

  return (
    <main className="page stack" style={{ gap: 24 }}>
      <header className="row" style={{ justifyContent: "space-between" }}>
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">Operator</span>
          <h1 style={{ fontSize: "clamp(1.6rem, 4vw, 2.2rem)" }}>Reference calibration</h1>
        </div>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </header>

      <div className="grid-2">
        <section className="card stack" data-reveal>
          <h2>Reference object</h2>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="visually-hidden">Reference object</legend>
            {config.reference_objects.objects.map((o) => (
              <label key={o.id} className="radio-row" style={{ opacity: o.enabled ? 1 : 0.55 }}>
                <input
                  type="radio"
                  name="ref"
                  disabled={!o.enabled}
                  checked={mode === "preset" && objectId === o.id}
                  onChange={() => {
                    setMode("preset");
                    setObjectId(o.id);
                    setSaved(false);
                  }}
                />
                <span>
                  {o.label}, {o.diameter_mm.toFixed(2)} mm {!o.enabled && <Badge tone="neutral">not yet verified</Badge>}
                  <span className="measure-sub" style={{ display: "block" }}>
                    {o.source}
                  </span>
                </span>
              </label>
            ))}
            <label className="radio-row">
              <input type="radio" name="ref" checked={mode === "custom"} onChange={() => (setMode("custom"), setSaved(false))} />
              <span>Custom circular reference</span>
            </label>
          </fieldset>
          {mode === "custom" && (
            <div className="stack" style={{ gap: 10 }}>
              <div className="field">
                <label htmlFor="cdia">Diameter (mm)</label>
                <input id="cdia" className="input num" inputMode="decimal" value={customMm} onChange={(e) => setCustomMm(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="clabel">Label (optional)</label>
                <input id="clabel" className="input" value={customLabel} onChange={(e) => setCustomLabel(e.target.value)} maxLength={80} />
              </div>
              <label className="row small" style={{ gap: 8 }}>
                <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />I measured
                this diameter with calipers and confirm it is correct.
              </label>
              {!customValid && customMm !== "" && <p className="small" style={{ color: "var(--bad)" }}>Enter 10-60 mm.</p>}
            </div>
          )}
          <div className="notice small">
            Only silver-coloured circular objects are supported: the detector relies on the coin being less saturated
            than skin.
          </div>
          <div className="row">
            <button
              className="btn btn-primary"
              disabled={!canSave}
              onClick={() => {
                onSave(selection);
                setSaved(true);
              }}
            >
              Use this reference
            </button>
            {saved && <span className="small" role="status">Saved on this device.</span>}
          </div>
        </section>

        <section className="card stack" data-reveal style={stagger(1)}>
          <h2>Live coin detection</h2>
          <div className="calib-stage">
            <video ref={videoRef} className={status?.mirrored ? "mirrored" : ""} playsInline muted aria-hidden="true" />
            <canvas ref={canvasRef} className={status?.mirrored ? "mirrored" : ""} aria-hidden="true" />
          </div>
          {status?.phase === "error" && status.error && (
            <div className="notice notice-error" role="alert">
              <strong>{status.error.title}.</strong> {status.error.message}
            </div>
          )}
          <p className="small muted">
            Place the coin flat inside the centre box, facing the camera. Calibration is accepted only when every check
            passes.
          </p>
          <div aria-live="polite">
            {coin?.found ? (
              <Badge tone={coin.accepted ? "good" : "warn"}>{coin.accepted ? "Calibration acceptable" : "Not acceptable"}</Badge>
            ) : (
              <Badge tone="neutral">No coin detected</Badge>
            )}
          </div>
          {coin && coin.reasons.length > 0 && (
            <ul className="bullets small">
              {coin.reasons.map((r) => (
                <li key={r}>{REASON_TEXT[r] ?? r}</li>
              ))}
            </ul>
          )}
          {coin?.found && (
            <table className="diag-table">
              <tbody>
                <Diag k="Diameter (major axis)" v={`${coin.major_axis_px.toFixed(2)} px`} />
                <Diag k="Scale at coin" v={Number.isFinite(diameter) ? `${(coin.major_axis_px / diameter).toFixed(3)} px/mm` : "n/a"} />
                <Diag k="Axis ratio / tilt" v={`${(coin.minor_axis_px / coin.major_axis_px).toFixed(3)} / ${tilt!.toFixed(1)}°`} ok={tilt! <= config.calibration.max_tilt_deg} />
                <Diag k="Edge support" v={`${(coin.edge_support * 100).toFixed(0)}%`} ok={coin.edge_support >= acc.min_edge_support} />
                <Diag k="Largest edge gap" v={`${coin.max_angular_gap_deg.toFixed(0)}°`} ok={coin.max_angular_gap_deg <= acc.max_angular_gap_deg} />
                <Diag k="Fit residual" v={`${coin.fit_residual_px.toFixed(2)} px`} />
                <Diag k="Edge width (blur)" v={`${coin.edge_width_px.toFixed(2)} px`} ok={coin.edge_width_px <= acc.max_edge_width_px} />
                <Diag k="Glare" v={`${(coin.glare_fraction * 100).toFixed(1)}%`} ok={coin.glare_fraction <= acc.max_glare_fraction} />
                <Diag k="Contrast" v={coin.contrast.toFixed(3)} ok={coin.contrast >= acc.min_contrast} />
                <Diag k="Detection quality score" v={coin.confidence.toFixed(2)} ok={coin.confidence >= acc.min_confidence} />
                <Diag k="Found by" v={coin.method} />
              </tbody>
            </table>
          )}
          {coin?.found && coin.candidates.length > 0 && (
            <details className="disclosure">
              <summary>Method comparison ({coin.candidates.length} candidates)</summary>
              <table className="diag-table">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Diameter</th>
                    <th>Ratio</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {coin.candidates.map((c, i) => (
                    <tr key={i}>
                      <td>{c.method}</td>
                      <td>{c.diameter_px.toFixed(2)} px</td>
                      <td>{c.axis_ratio.toFixed(3)}</td>
                      <td>
                        {c.confidence.toFixed(2)} {c.accepted ? "✓" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          <p className="small muted">The detection quality score is a heuristic of edge quality, not a probability.</p>
        </section>
      </div>
    </main>
  );
}

function Diag({ k, v, ok }: { k: string; v: string; ok?: boolean }) {
  return (
    <tr>
      <td className="muted">{k}</td>
      <td>
        {v} {ok === undefined ? null : ok ? <Badge tone="good">ok</Badge> : <Badge tone="bad">fail</Badge>}
      </td>
    </tr>
  );
}
